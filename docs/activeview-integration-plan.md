# ActiveView (AV) — рекомендованный план интеграции в adlauncher

> ℹ️ **Уточнения по онбординг-звонку 23.09 (см. `activeview-onboarding-2026-09-23.md`):** (1) статьи на thecadrion.com создаём МЫ САМИ в CMS AV «Godi Studio» — значит URL лендингов известны заранее и каталог/allowlist можно вести по своим статьям; (2) DNS для redirect./chat. субдоменов делает сама AV (домен на их хосте), ключи уже отправлены Julia в Slack — от нас только «validate DNS»; (3) после подключения Meta-аккаунта в Campaign Analysis AV даёт «manage conversions» (события/триггеры) — допущение «пикселя на странице нет и ROAS невозможен» надо перепроверить после подключения аккаунта; (4) каждый URL перед запуском согласуется с AdOps (Julia) через Slack-тикет; (5) не более 1–2 ниш на домен, новые домены AV выделяет после результатов; (6) Redirect: смена/добавление целевых URL без перезапуска объявления + dynamic distribution по RPS (~7 дней).

> ⚠️ **Поправка владельца (25.09):** LION и его weapons (google-weapon, tiktok-weapon, URL-карта доменов) относятся ТОЛЬКО к партнёру HS и к AV отношения не имеют. Все упоминания LION ниже (раздел C: строки про google-weapon/tiktok-weapon; п.5 раздела A; Phase 3) считать устаревшими: Google/TikTok-запуски на thecadrion.com надо проектировать отдельным путём (свои аккаунты/API), а не через LION.

Синтез трёх дизайнов (mvp / attribution / ops) и шести проверок. Всё сверено с исходным кодом (READ-ONLY, ничего не менял). Ссылки на файлы/строки — из дерева на 2026-09-25.

Коротко о главных решениях синтеза (и где я перекрываю дизайн/проверяющего):
- **Objective для FB — БЕЗ `OUTCOME_TRAFFIC` и БЕЗ правки `catalog.ts`.** MVP-дизайн хотел ввести `OUTCOME_TRAFFIC` (проверяющий верно заметил, что его нет в `catalog.ts:54-57` — только `OUTCOME_SALES`/`OUTCOME_LEADS`). Но правильный фикс не добавлять его, а переиспользовать связку `OUTCOME_SALES` + `optimization=clicks`, как это уже делают click-карточки AIF: при пустом пикселе `adsetPayload` не ставит `promoted_object` (`fb-launch.ts:161`), а комментарий `fb-launch.ts:157-160` прямо говорит, что «LINK_CLICKS без promoted_object» — валидная комбинация. `optimizationGoal` при `optimization=clicks` без roas возвращает `LINK_CLICKS` (`fb-launch.ts:18-21`). Значит рельса запускается на трафик без единой правки каталога objectives.
- **Пул-ключ `avNNN` в `utm_campaign` как ПЕРВИЧНАЯ атрибуция** (mvp/ops), а не `{{campaign.id}}`+коннектор (attribution). Обе AV-contract проверки пометили «коннектор Meta авто-регистрирует id в GAM KVP» как НЕподтверждённую инференцию (findings L77 в скобках, L121; наблюдаемое состояние — $0, ничего не зарегистрировано). `{{campaign.id}}`+коннектор — это апгрейд «если подтвердится» (см. E).
- **Пул на существующей коллекции `app-cache` (шаблон `snap-keys.ts`), а НЕ новая коллекция `aif-maps`.** Сверено: `snap-keys.ts` пишет строки `app-caches` с уникальным `ckey "snap-key:<key>"` (`snap-keys.ts:16,171`). Это убирает предварительный шаг «создать коллекцию в Strapi перед деплоем», который был у mvp/ops с `av-maps`.
- **`lib/types.ts` НЕ трогаем.** MVP и attribution дизайны включали правку `withPartnerMark` — перекрываю: функция уже generic и штампует любой `label` (rails-map §1; ops-проверка это подтвердила). Префикс «(AV)» получаем через `nameTier:"av"`.
- **Явный серверный twin `avRailEnabled()` первой строкой в `/api/av/launch`** (идея ops-дизайна). У AIF-роута такого гейта нет (`aif/launch` полагается на отсутствие токена). AV с первого дня несёт токен, поэтому отсутствие токена — не безопасный гейт дормантности; нужен 404 `av_rail_disabled` как у google/tiktok/snap (`google-wave.ts:92`).

---

## A. Что такое ActiveView и как это работает (для владельца)

ActiveView — **партнёр по монетизации через Google Ad Manager (модель MCM child-publisher)**. Наш контент-сайт **thecadrion.com** (child network code **2550370616**) хостится самим AV (**ActiveHost = Yes**), то есть свой HTML лендинга мы туда залить не можем — страницы берутся из их CMS (статьи ниши «government surplus / liquidation auctions», URL с волатильным случайным суффиксом вида `-twjmh`). На странице работает их скрипт (ActiveView script), который **читает `utm_*` прямо из query-строки лендинга и передаёт их в GAM как key-values**; `utm_campaign` — это ключ атрибуции выручки на кампанию (`activeview-findings.md:43-64`).

Отсюда: **AV — это партнёр на Facebook, как MO/AIF** (PartnerId в реестре партнёров, прямой запуск через Graph API на выделенном FB-токене), а **не** вкладка-платформа. Схема запуска: байер выбирает рекламный кабинет + фанпейдж из каталога AV-токена, вставляет URL статьи thecadrion.com, роут атомарно берёт из пула ключ `avNNN`, кладёт его в `utm_campaign`, строит дерево campaign→adset→creative→ad на AV-токене и пишет задачу `partner="av"`.

Ключевые ограничения, диктующие дизайн:
1. **Нет FB-пикселя на странице.** Мы не контролируем HTML thecadrion.com, а скрипт AV шлёт данные в GAM/свой CDP, не в FB-пиксель. Значит оптимизировать на Purchase/ROAS нельзя — FB-кампании идут на **трафик (link clicks)**, а прибыльность считаем оффлайн по API AV. (Открытый вопрос к AV: могут ли поставить наш пиксель/CAPI — тогда позже добавим конверсии.)
2. **Регистрация значений `utm_campaign`.** GAM KVP-отчёт показывает выручку **только по зарегистрированным** значениям, и **API для регистрации НЕТ** — только разовая загрузка файла в UI (Settings → UTM Campaign Values). Поэтому пул `avNNN` регистрируется один раз пакетом.
3. **Ревшара MCM 10%.** Net = gross − 10% (**+ налоги/иные расходы, если заданы** — `findings L14`), поэтому ×0.9 — это «после ревшары, до налогов», а не финальный net.
4. **Выручка в микро-долларах** в `/report/kvp` и `/report/gam/custom` (÷1 000 000); в `/report/:nc/:domain` — обычная валюта (делить НЕ надо). Данные почасовые, трактуем как D+1.
5. **Google/TikTok заблокированы** (см. C и D): LION-weapon не пропускает thecadrion.com (URL-карта → 400 «Failed to create task», память 22-23.09), а хвост `utm_campaign`, который дописывает LION, несовместим с атрибуцией AV.

---

## B. Что можно сделать ПРЯМО СЕЙЧАС (feasible now)

**Только Facebook direct-Graph рельса.** Всё остальное (Google, TikTok, Redirect A/B, Pricing Rules) заблокировано на стороне AV/LION (см. C).

FB-рельса — это клон рельсы AIF (`app/api/aif/launch/route.ts`) с тремя осознанными отличиями:
1. первой строкой — гейт `avRailEnabled()` → 404;
2. лендинг не из статического каталога, а **вставленный URL** с проверкой по allowlist хостов (`thecadrion.com`) и срезанием query (прецедент `snap-launch.ts` `snapLandingBase:51`);
3. **выброшен весь блок пиксель-политики и ROAS-пина** (`aif/launch:191-226`) — objective остаётся выбором байера (`OUTCOME_SALES`/`OUTCOME_LEADS`), оптимизация = clicks, пиксель не требуется и не пинуется.

Атрибуция: `utm_campaign = avNNN` (пул, как Snap `glo-snp_NNN`), значения зарегистрированы в AV один раз, выручка тянется из `/report/kvp?key=utm_campaign` (Phase 2). Всё это можно писать и тестировать локально уже сейчас; на прод уходит дормантным за `NEXT_PUBLIC_AV_ENABLED`.

---

## C. Что требует действий на стороне AV/LION ПЕРВЫМ

| Блокер | Владелец | Что нужно | Разблокирует |
|---|---|---|---|
| FB system-user токен для AV-кабинета | Владелец | выдать токен → `FB_AV_LAUNCH_TOKEN` (или пометить существующий vault-токен партнёром `av`) | запуск FB-рельсы |
| Регистрация пула `utm_campaign` | AV UI (AdOps) | Settings → UTM Campaign Values, Website=thecadrion.com, Method=Upload file → залить весь пул `av001..avNNN` | выручку в `/report/kvp` по нашим кампаниям |
| Список живых статей thecadrion.com | AV / sitemap | выгрузка/подтверждение реальных `request_uri` (CMS волатильна) | защиту от запуска на мёртвый URL |
| API-ключ + сеть | AV UI | Settings → APIs (формат `<64hex>:<20hex>`), проверить `/healthcheck/` + `/me` (сеть 2550370616, домен thecadrion.com) | Phase 2 (чтение выручки) |
| LION google-weapon URL-карта | HS/LION | добавить thecadrion.com в внутреннюю URL-карту google-weapon | Google-запуски (иначе 400) |
| LION google-хвост `utm_campaign` | HS/LION | сейчас LION дописывает `utm_campaign=<acr>_{campaignid}_NN` (`google-bid.ts:410`), а Google-коннектор AV ждёт голый `{campaignid}` (`findings L76`) → не матчится и не регистрируется | Google-выручку (а не только сессии) |
| LION tiktok-weapon allowlist доменов | HS/LION | добавить thecadrion.com (allowed-domains видны только внутри 400, `tiktok-weapon.ts:72`); live-запуск требует прод/флаг (`tiktok-weapon.ts:48-56`) | TikTok-запуски |
| Redirect DNS | AV / Cloudflare | завершить верификацию `redirect.thecadrion.com` (застряло на шаге 2/3, domain id `cmue7hk5p000ts60oo7x9557n`) | A/B-сплит лендингов |
| Pricing Rules | AV | разблокируется при среднем ≥ $350/7д (сейчас $0), затем «Request access» | автоматизацию флор-цен |
| Meta-коннектор в Campaign Analysis (опция) | AV UI | подключить Meta Ads OAuth — чтобы проверить, регистрирует ли он `{{campaign.id}}` в GAM KVP | возможный отказ от пула (см. E) |

⚠️ **TikTok структурно не атрибутируется по деньгам** через AV: в Campaign Analysis есть только коннекторы Meta и Google (`findings L76`), а LION пишет `utm_campaign=__CAMPAIGN_ID__` (динамика, нерегистрируемо). TikTok = только сессии (`/report/session/kvp`), выручки нет, пока AV не добавит TikTok-коннектор.

---

## D. Поэтапная реализация (усилия по фазам)

### Phase 0 — предпосылки AV + приём кредов (0.5 дня, кода нет)
Go/no-go: ключ на руках и `GET /healthcheck/`=200 + `GET /me`=200 с thecadrion.com/2550370616; получен список живых статей; пул `avNNN` зарегистрирован в UI; выбран FB-кабинет/токен.
- Серверный `curl` (sandbox-disabled) `/healthcheck/` и `/me` с Bearer — подтвердить кред/сеть/домен до написания клиента.
- Застолбить env для Phase 2: `AV_API_KEY`, `AV_NETWORK_CODE=2550370616`, `AV_DOMAIN=thecadrion.com`.

### Phase 1 — FB direct-Graph AV-рельса, дормантная на проде (FEASIBLE NOW, ~4.5 дня)
Go/no-go: `node --test` зелёный для av-link/av-keys/registry; локальный smoke-запуск на тест-аккаунт, ключ берётся и освобождается при форс-фейле; дормант-проверка — прод-билд с выключенным флагом показывает AV «in development» И `POST /api/av/launch` → 404 `av_rail_disabled`.

Файлы (что меняем и на какой прецедент опираемся):

| Файл | Изменение | Прецедент / сверено |
|---|---|---|
| `lib/partners.ts` | `PartnerId += "av"` (стр. 9). В `PartnerConfig` добавить `avLaunch?:boolean` (рядом с `aifLaunch` стр. 72). Запись в `PARTNERS`: `{id:"av", label:"AV", Flag, nameTier:"av", usesGcm:false, usesProfile:false, accountsFromToken:true, fanpagesFromToken:true, landingBase:"https://thecadrion.com", landings:[], maxCreatives:5, avLaunch:true, inDevelopment: process.env.NEXT_PUBLIC_AV_ENABLED!=="1"}`. Экспорт `avRailEnabled = () => process.env.NEXT_PUBLIC_AV_ENABLED==="1"`. Ветка `avLaunch` в `landingUrlSegments` (стр. 459) → `avLinkSegments`. **`markerPool`** (543-545) — ветка `av → AV_POOL`. Экспорт `AV_POOL`/`AV_POOL_MAX`/`avKeyCode`. | запись `us`/AIF (336-360); `aifLaunch` (72); `markerPool` (543-545); `AIF_POOL` (540) |
| `lib/partners.ts` → `launchReadyOpts` (390-411) | **Четыре правки выражений** (не «добавить ветку» — сверено): `landing` (392) `|| Boolean(p.avLaunch)`; `gcm` (403) `|| Boolean(p.avLaunch)`; `pixel` (399) `&& !p.avLaunch`; `roasPixel` (409) вернуть `""` для `av`. Иначе для AV (`accountsFromToken=true`) получится: пиксель ТРЕБУЕТСЯ, лендинг/ключ НЕ требуются, а min-ROAS молча пинует `ROAS_PIXEL` (VD-C1-HS-11), который на странице AV никогда не сработает. | сверено построчно: `partners.ts:392,399,403,409` |
| `lib/av-link.ts` (NEW) | Чистый модуль (только type-import `LinkSegment` из partners — как `aif-link.ts`; `FB_MACROS` **не экспортируется** из partners, стр. 423, поэтому литералы макросов объявить локально). `AV_ALLOWED_HOSTS=["thecadrion.com"]`; `avLandingBase(raw)` = https + host в allowlist + срез query/hash + **отказ, если base уже несёт `utm_campaign`**; `avLinkSegments(base,key)` → `?utm_source=facebook&utm_campaign=<key>&utm_medium=facebook&utm_term={{adset.id}}&utm_content={{ad.id}}` (макросы литеральные, не через URLSearchParams); `avLink()` join. **Не** применять sanitize из `nice-advice gpt.ts` — он сожрёт литеральные `{{...}}`; `avNNN` и так ≤40 симв./`[a-z0-9_-]`. | `aif-link.ts`; `snap-launch.ts:51,92` |
| `lib/av-keys.ts` (NEW) | Атомарный пул `avNNN` на **существующей** `app-cache` (ckey `"av-key:<code>"`, unique → атом): `claimAvKey/releaseAvKey/backfillAvKey(retire)/listAvKeys/findAvKey`. Claim-then-verify oldest-wins; release при pre-FB фейле, retire (status=retired) при post-FB. Новой Strapi-коллекции НЕ создаём. | клон `snap-keys.ts` (сверено: app-cache, `ckey`, unique, `snap-keys.ts:16,171`) |
| `lib/av-launch.ts` (NEW) | `avRail(rail) = resolveSlot(slotOf("av",rail))` → bound `fbGet/fbPost/uploads/catalog`. | клон `aif-launch.ts` (swap `slotOf("aif")→slotOf("av")`) |
| `lib/fb-token-registry.ts` | `"av"` в `TokenPartner` (20), `TOKEN_PARTNERS` (24); `SlotId`+`SLOT_IDS` `"av.launch"/"av.clone"` (22,25); `PARTNER_LABEL` (27) `av:"AV"`; `PARTNER_TITLE` (28); `SLOT_META` (35, pool:false, по одному токену как MO/AIF); seed `env:FB_AV_LAUNCH_TOKEN` в `envSeeds` (partners:["av"]); **ветка `av` в `envDefaultIds`** — обязательна: без неё slotPartner "av" проваливается в HS-пул (317-322) и AV полетит на HS-bearer. `PARTNER_LABEL`/`PARTNER_TITLE`/`SLOT_META` — исчерпывающие `Record`, ключи обязательны или билд не соберётся. | все записи `aif` (20-42, 292-294, 316) |
| `lib/fb-tokens.ts` | `cacheKeyFor` (157): `if (seed.id==="env:FB_AV_LAUNCH_TOKEN") return "av"` — своя идентичность кэша каталога, чтобы данные MO/AIF не протекали. | строка `aif` (157) |
| `lib/hs-pages.ts` (**блокер билда, был пропущен в mvp/ops**) | `SCOPE: Record<PartnerId,string>` (27) += `av:""` (с комментарием «AV — не HS-pages партнёр, значение не используется»). Исчерпывающий `Record<PartnerId>` → без ключа TS2741. | сверено `hs-pages.ts:27` |
| `components/token-vault-board.tsx` (**блокер билда, был пропущен в mvp/ops**) | `PARTNER_OF_RAIL: Record<PartnerId,TokenPartner>` (98) += `av:"av"`; `RAIL_OF_PARTNER: Record<TokenPartner,PartnerId>` (99) += `av:"av"`; отрисовать секцию слотов `av.launch`/`av.clone`. | сверено `token-vault-board.tsx:98,99` |
| `app/api/av/launch/route.ts` (NEW) | Клон `aif/launch` с: (1) **первой строкой** `if(!avRailEnabled()) return 404 av_rail_disabled`; (2) валидация лендинга через `avLandingBase` (paste-URL + allowlist), **опц. live HEAD/GET-проверка** что URL жив; (3) **отклонять roas-bidStrategy** (нет конверсионного сигнала), пиксель-блок и ROAS-пин НЕ клонировать, objective=выбор байера, optimization=clicks → `LINK_CLICKS` без `promoted_object`; (4) `claimAvKey` вместо `claimBrand`, ссылка через `fullLandingUrl`/`avLinkSegments`; `taskWriter({partner:"av"})`, `reportPagesUsed("av",…)`; release(pre-FB)/retire(post-FB). Сохранить `claimAcctSlot`, NDJSON-стрим, мульти-креатив, чистку blob. | `aif/launch` целиком; 404-twin `google-wave.ts:92`; `fb-launch.ts:157-163` (no-pixel LINK_CLICKS валиден) |
| `app/api/av/keys/route.ts` (NEW) | GET `{used,next,poolMax}` для карточки + owner DELETE `?key=avNNN`. | `app/api/snap/keys`, `app/api/aif/brand` |
| `app/api/av/adaccounts/route.ts` + `app/api/av/fanpages/route.ts` (NEW) | Пикеры аккаунтов/страниц AV-токена. | аналоги aif |
| `app/api/launch-tasks/route.ts` | В MO-исключение дописать `&filters[$or][1][$and][5][partner][$ne]=av` (после индексов 0-4, стр. 86-88); ветка `scope==="av"` → `filters[partner][$eq]=av`; **расширить кэш-тернар** (96) `scope==="av" ? "launch:av" : (scope==="aif" ? "launch:aif" : "launch:mo")`, иначе AV читает из MO-бакета. | сверено `launch-tasks:82-88,96` |
| `components/*` | `task-manager.tsx` (632): 3-ходовой роутинг `avLaunch ? "/api/av/launch" : (aifLaunch ? … : "/api/launch")` + провайдер `AvTaskManagerProvider` (`?scope=av`), смонтировать в `app/(app)/layout.tsx` (23-32). `launcher-board.tsx changePartner` (565): закрывать AV-drawer. `campaign-card.tsx`: для AV — поле вставки URL (валидируется `avLandingBase`) вместо каталога-дропдауна + превью из `avLinkSegments`. `icons.tsx`: флаг/иконка AV. `partner-switcher.tsx` — БЕЗ правок (авто-дизейбл по `inDevelopment`, стр. 34). `app/(app)/av/page.tsx`: `redirect("/")` при выключенном флаге. | AIF-обвязка |

НЕ трогаем: `lib/types.ts` (`withPartnerMark` generic), `catalog.ts` (objectives), Strapi-схему (новой коллекции/колонки нет).

env/infra Phase 1: `NEXT_PUBLIC_AV_ENABLED=1` только в `.env.local` (инлайнится в билд; на проде — позже выставить Vercel-env + redeploy, без правки кода); `FB_AV_LAUNCH_TOKEN` в vault (это FB-bearer, проходит `looksLikeFbToken`); Strapi — без новой коллекции (av-keys в app-cache) и без новой колонки (partner="av", gcm=avKey, link=URL).

⚠️ **Go/no-go по Strapi-полю `partner`:** перед деплоем подтвердить, что атрибут `partner` в коллекции `launch-task` — свободная строка, а не enum. `TaskRowData = Record<string,unknown>` (`task-store.ts:111`) на TS-уровне не ограничивает, но если в Strapi это enumeration, значение `"av"` даст 400 и заклинит КАЖДУЮ запись задачи (тот же класс, что «ad_id gotcha», `task-store.ts:104-107`). Косвенный признак, что это строка: значения `br/us/gg/sn/tt` добавлялись инкрементально по мере рельс без упоминаний правок enum. Всё равно — проверить как «колонка должна существовать первой».

Тесты Phase 1: `node --test` для av-link (allowlist accept/reject, срез query, литеральность макросов), av-keys (арифметика пула + claim/release-гонка), реестра AV (матрица readiness: пиксель НЕ требуется, лендинг+ключ требуются); `_e2e/README-av.md` + smoke: дормант-off (404), дормант-on запуск на тест-аккаунт, claim+форс-фейл→release, строка задачи только в scope=av.

### Phase 2 — чтение выручки AV по REST API (~2-3 дня)
Go/no-go: `/report/kvp` по известному `avNNN` возвращает выручку, совпадающую с запущенной кампанией; 429/5xx не вешают роут; показывается net (×фактор), D+1.

| Файл | Изменение | Прецедент |
|---|---|---|
| `lib/av-api.ts` (NEW) | Server-only клиент `external-api.activeview.app`: env `AV_API_KEY`/`AV_NETWORK_CODE`/`AV_DOMAIN`; bounded fetch (`AbortSignal.timeout`) + ретрай на 5xx **и 429** (honor `Retry-After`), 4xx verbatim; **распаковка конверта `{response:…}`**; **всегда `timezone=gmt_3`** (São Paulo, чтобы дни бились с FB-spend). Методы: `avMe()`, `avReportKvp({key:"utm_campaign",start,end})` (микро÷1e6, net = gross × фактор), `avSessionKvp()`, `avReport()` (per-uri, обычная валюта — НЕ делить). | `google-weapon.ts` gwFetch (12-70); micros как в magicbid |
| `app/api/av/report/route.ts` (NEW) | GET, session-gated, за окно (по умолч. 7д, D+1) отдаёт по `utm_campaign` выручку+сессии, **join с строками launch-task `partner="av"` по колонке `gcm` (= avKey)** → кампания. Короткий team-кэш как `readTeamTasks`. 404 `av_rail_disabled` когда выключено; 502 при отсутствии дня. | `app/api/snap/report`; join-by-marker как `hs-tools partner_stats.py` |

Важно про атрибуцию Phase 2:
- **Join идёт по `avKey` (колонка `gcm`), а не по `campaign_id`.** Мы шлём пул-ключ, а не `{{campaign.id}}`, поэтому строкой связи служит `gcm`=avKey (прецедент — `partner_stats.py`).
- `net = gross × фактор` — фактор **конфигурируемый** (`AV_REVSHARE_FACTOR`, дефолт 0.9), подпись «после ревшары, до налогов» (findings L14). Не выдавать за финальный net.
- `utm_term={{adset.id}}` / `utm_content={{ad.id}}` в KVP-отчёт **не попадут** (UI регистрирует только ключ `utm_campaign`; прочие — через AdOps). Они только для CDP/session-анализа — разбивки по adset/ad по деньгам не будет.
- **Native ROI/Dashboard AV останутся пустыми** для наших кампаний (Dashboard Facebook%/ROI ждут подключённый Meta-аккаунт и `{{campaign.id}}`, findings L68,76). При пул-схеме наш единственный источник денег — `/report/kvp`. Это осознанный размен.

env Phase 2: `AV_API_KEY` — **только env, server-only, НЕ в fb-token-vault**. Причина сверена: `looksLikeFbToken = /^[A-Za-z0-9_-]{40,1024}$/` (`fb-token-registry.ts:130`) отвергает двоеточие в формате `<64hex>:<20hex>`, а `TokenPartner` не знает про репортинг-креды; все не-FB креды в проекте env-only (rails-map §5). Это **сознательно перекрывает** указание findings L90 «хранить ключ в token vault» — vault физически не может держать этот ключ.

### Phase 3 — Google/TikTok на thecadrion.com (ПЕРЕСМОТРЕТЬ: не через LION, см. поправку вверху)
Существующие платформенные рельсы Google (`app/api/google/*`, `lib/google-weapon.ts`) и TikTok (`lib/tiktok-weapon.ts`) уже шлют голый `landing_url`, а хвост дописывает LION. Кода в adlauncher почти нет — только разрешить/подсказать thecadrion.com как выбор лендинга (опц. `app/api/av/landings/route.ts` из живых `request_uri` через `/report`).
Блок: (1) LION добавляет thecadrion.com в URL-карты обоих weapon (иначе 400, память 22-23.09); (2) для Google — деньги атрибутируются, только если LION даст **голый** `utm_campaign={campaignid}` (сейчас `<acr>_{campaignid}_NN`, `google-bid.ts:410`) ИЛИ коннектор AV стерпит префикс; (3) TikTok — **только сессии** (нет TikTok-коннектора в AV), пока AV не добавит его. До этого Google/TikTok = session-only (`/report/session/kvp`).

### Phase 4 — Redirect A/B split (BLOCKED на DNS, ~1.5 дня)
`lib/av-redirect.ts` (NEW) поверх `av-api.ts`: `/v1/redirects`, `POST …/path {path,fallback}`, `GET/PUT …/mappings [{url,percentage}]` (до 3 назначений, веса; fallback как `&fllb=`). Кода не писать, пока `redirect.thecadrion.com` не пройдёт DNS (шаг 3/3).

### Phase 5 — Pricing Rules (BLOCKED на $350/7д, ~1.5 дня)
`lib/av-pricing.ts` (NEW): `/rules`, `/upsert` (ключ ad_unit+country+device+utm_source+request_uri, округление ВВЕРХ к `/buckets`), `DELETE /delete?dry_run=true`, `/v1/price-rules/rule-mode`. Ждём разблокировку доступа.

---

## Таблица endpoint'ов AV API, которые реально используем

| Фаза | Метод + путь | Назначение | Единицы / примечания |
|---|---|---|---|
| 0 | `GET /healthcheck/` | liveness | без конверта |
| 0 | `GET /me` | валидность токена, sites/network_code | 200 = ключ жив |
| 2 | `GET /report/kvp/2550370616/thecadrion.com?key=utm_campaign&start_date&end_date&timezone=gmt_3` | **выручка по кампании** (join по avKey) | `ad_exchange_line_item_level_revenue` в **micros ÷1e6**; net = gross×фактор; D+1 |
| 2 | `GET /report/session/kvp/2550370616/thecadrion.com?key=utm_campaign&start_date&end_date` | сессии по кампании из CDP | **регистрация НЕ нужна**; QA/fallback + единственный путь для Google/TikTok |
| 2 | `GET /report/2550370616/thecadrion.com?start_date&end_date` | экономика per `request_uri` | выручка в **обычной валюте** (НЕ делить); только URI-уровень, не per-campaign |
| 4 (blocked) | `GET/POST/PUT /v1/redirects*` | A/B-сплит | конверт со своими top-level ключами |
| 5 (blocked) | `GET /rules`, `POST /upsert`, `GET /buckets`, `GET /v1/price-rules/rule-mode` | флор-цены | upsert округляет вверх к buckets |

Auth: `Authorization: Bearer <AV_API_KEY>`. Все не-healthcheck ответы в конверте `{response:…}`. Регистрация значений `utm_campaign` — **только UI** (API нет).

---

## E. Открытые вопросы

### К поддержке AV
1. Можно ли поставить наш Meta-пиксель/CAPI на ActiveHost-страницах thecadrion.com — или весь сигнал только GAM/CDP (тогда FB-кампании навсегда только трафик)?
2. **Подключение Meta Ads в Campaign Analysis действительно регистрирует `{{campaign.id}}` как значения `utm_campaign`, видимые в `/report/kvp`** (ретроспективно и почасово)? Есть ли лимит на число зарегистрированных значений? (Это make-or-break для отказа от пула — см. ниже.)
3. Точно ли нет программного способа (даже file-upload endpoint) регистрировать значения `utm_campaign` — только UI? Формат/лимиты файла для пакетной загрузки пула?
4. Полный список живых URL статей (sitemap/CMS-экспорт) и можно ли заказывать новые статьи/ниши?
5. Когда AV добавит thecadrion.com в google-weapon и tiktok-weapon URL-карты LION, и какой именно хвост `utm_campaign` дописывать, чтобы Google-коннектор матчил?
6. Есть ли TikTok-коннектор в Campaign Analysis (сейчас только Meta+Google) — иначе TikTok навсегда session-only?
7. Какой timezone стандартизировать в отчётах (`gam|pacific|gmt_3|cet|eastern`) и дефолт, если не передавать?
8. Выручка в `/report/kvp` — это gross (до ревшары) или уже net? Заданы ли налоги/иные fixed-cost сверх 10%?
9. Сроки DNS-верификации `redirect.thecadrion.com` (шаг 3/3)?

### К владельцу
1. **Схема атрибуции:** статический пул `avNNN` (выручка через `/report/kvp` полностью под нашим контролем — РЕКОМЕНДУЮ для MVP) vs `utm_campaign={{campaign.id}}` + Meta-коннектор (нативный ROI AV, без пула, но зависит от неподтверждённой авто-регистрации и id известен только после создания)? Рекомендация: пул сейчас; `{{campaign.id}}` — апгрейд после эмпирической проверки вопроса A-2.
2. Какой FB-кабинет/фанпейджи/токен под AV — переиспользовать VD-C1 MO/AIF или выделенный? Отдельный `FB_AV_LAUNCH_TOKEN` или пометить существующий vault-токен партнёром `av` (мульти-партнёр поддержан)?
3. Дефолтный FB-бюджет и оптимизация для AV (link-clicks/traffic), раз нет конверсионного сигнала? Подтверждаем, что min-ROAS для AV запрещён?
4. Размер пула `AV_POOL_MAX` (= число регистраций в AV): под Snap-500 или меньше на старт? Сколько кампаний/день ожидаем?
5. Выручка AV — в отдельный `/api/av/report` reader (как Snap, рекомендую на старт) или сразу в hs-tools/ad-audit?
6. Подтверждаем AV как PartnerId в свитчере (как MO/AIF), дормантный на проде через `NEXT_PUBLIC_AV_ENABLED`, а не как вкладку-платформу?
7. Лендинги: чистый paste-URL байером, или засеять маленький каталог статей thecadrion.com?

---

## Риски и e2e-проверки (сводно)

- **Нет пикселя на странице** → трафик-objective, прибыль оффлайн по API. Никакого ожидания ROAS-запуска (в карточке и роуте явно).
- **Незарегистрированные значения `utm_campaign` невидимы в `/report/kvp`** → разовая пакетная регистрация пула; fallback `/report/session/kvp` (сессии без регистрации).
- **Волатильные CMS-пути** → paste-URL + allowlist + срез query + опц. live-проверка (защита от запуска на 404 с нулевой выручкой — MVP-критично, не откладывать в Phase 3).
- **LION URL-карта отвергает thecadrion.com** → Google/TikTok за гейтом, пробный shot до live.
- **429/5xx AV (Cloud Run)** → bounded fetch + ретрай с Retry-After + короткий team-кэш.
- **Путаница единиц** (KVP micros vs `/report` валюта) → нормализация в `av-api.ts`, юнит-тесты на оба пути.
- **Strapi enum `partner`** → подтвердить до деплоя (go/no-go), иначе 400 клинит все записи.
- **Turbopack const-fold тонких async-обёрток** → тела роута/claim держать inline (без `return impl(...)`), как в `task-store.ts`.
- **Утечка ключа** → `AV_API_KEY` server-only env, никогда в браузер, никогда в vault.

e2e: `node --test` (av-link/av-keys/av-report — micros÷1e6, net×фактор, распаковка `{response}`, timezone); контракт-мок `external-api.activeview.app`; smoke FB: один трафик-запуск → `utm_campaign=avKey` в ссылке → строка `partner="av"` только в scope=av → (после трафика D+1) `/report/kvp` по avKey джойнится на кампанию; дормант-проверка 404.
