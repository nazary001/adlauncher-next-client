# Fanpage fill from the hs-tools registry + slot reporting (2026-08-20)

## Что меняется

Источник цифр «сколько мест занято на фанке» для ВСЕХ пикеров (лаунчер MO/HS/AIF, оба
клонера/дубликатора) — теперь **hs-tools pages registry** (Django на Hetzner,
`hs.gctracking.xyz`), а не собственные Graph ads_volume-свипы и не LION-тэлли. И в обратную
сторону: **каждый создающий роут репортит занятые места** в реестр сразу после того, как
объявления легли на FB (`POST /fb/api/v1/pages/used`, оптимистичный счётчик — ближайший
FB-свип бокса перезаписывает фактом).

Реестр per-partner: HS = дефолтные таблицы (`/fb/...`), MO = `/mo/fb/...`, AIF = `/aif/fb/...`
(AIF-скоуп пуст, пока бокс не синкает AIF-фанки — эндпоинты и репорты уже смотрят туда и
оживут сами).

## Архитектура

- `lib/hs-pages.ts` — серверный клиент: `hsToolsPageStats(partner)` (кэш 60с + inflight),
  `reportPagesUsed(partner, items)` (fire-safe: никогда не кидает, таймаут 15с, инвалидирует
  кэш), kill switch `HS_PAGES_API_KEY` (env; не задан → всё легаси).
- Volume-роуты отдают `{ok, mode: "registry"|"legacy", counts, limits}`:
  - `/api/fanpages/volume` (MO) — registry `in`; keyless → старый Graph-свип (mode legacy).
  - `/api/hs/page-volume` (HS) — registry `br`; keyless → LION-тэлли + ads_volume (legacy).
  - `/api/aif/fanpages/volume` (НОВЫЙ) — registry `us`; keyless → ok:false (бейджей нет, как и было).
- Клиенты (`use-fanpages`, `use-hs`): бейдж `N/<реальный limit>`; **registry-контракт: фанка,
  которой нет в counts — НЕИЗВЕСТНА** (без бейджа, выбираема), не «0/250» — у бокса по ней
  просто нет цифр (has_data:false). Legacy-контракт прежний (absent = 0). HS по-прежнему
  блокирует переполненные (disabled при ratio ≥ 1), теперь по реальному лимиту.
- Списки фанок НЕ меняли источник: MO/AIF — advertisable-страницы токена (Graph), HS — бинды
  LION-профиля. Это ограничения запускаемости (гранты токена / решение owner про LION-каталог),
  реестр их не заменяет — он даёт цифры и ведёт леджер.

## Точки репортинга (все — после факта создания, fire-safe)

| Роут | delta | page |
|---|---|---|
| `/api/launch` (MO) | 1 | binds.pageId |
| `/api/aif/launch` | 1 | binds.pageId |
| `/api/hs/token-launch` | adIds.length (в finally — частичные деревья тоже) | binds.pageId |
| `/api/hs/launch` (LION create) | creatives.length (оптимистично на сабмите) | c.page |
| `/api/hs/duplicate` (оба пути) | ads источника (`lionCampaignAds`, кэш; ≥1) × копии | binds.page |
| `/api/hs/token-duplicate` | adIds.length за клон | binds.page |
| `/api/clone/run` (MO+AIF) | 1 за клон | editBinds.pageId |

## Прод

Локально-только: ключ лежит в `.env.local`; на Vercel env не задан → на проде всё работает
по-старому до явного включения (добавить `HS_PAGES_API_URL/KEY` + redeploy).

## Известные хвосты

- Бокс не читает `is_published`/`promotion_eligible` — UNPUBLISHED-фанки выглядят свободными
  (250 free) и сортируются первыми в API (доработка на стороне hs-tools).
- AIF-синк фанок на боксе не существует — скоуп пуст, репорты логируют "page not found".
