# Google clone / JURO link — контракт для внешнего инструмента

Инструкция для разработчика внешнего инструмента (статистика / дашборд / LION): как кнопка
**Clone** (и **JURO**) должна передавать **Google Ads** кампании в наш Google-клонер
(Ad Launcher, борд `/google/clone`).

Коротко: **передаём только ID кампаний-источников**, всё остальное (имя, аккаунт, бюджет,
ставку, гео, снапшот креативов) клонер сам подтягивает из LION по этим ID. Байер на борде
выбирает целевой аккаунт, пиксель, бюджет, ставку и число копий и жмёт **Fire** — копии
строит LION (google-weapon API).

Это Google-аналог FB-контрактов `clone-link-contract.md` / `juro-link-contract.md`.
Формат тот же, отличия — в разделе «Чем отличается от FB-ссылки».

## Ссылка

Кнопка «Clone» открывает роут **`/google/clone`** с параметром `ids`:

```
https://adlauncher.gcamazingtool.xyz/google/clone?ids=<campaignId1>,<campaignId2>,...
```

Кнопка «JURO» — та же ссылка плюс `mode=juro`:

```
https://adlauncher.gcamazingtool.xyz/google/clone?mode=juro&ids=<campaignId1>,<campaignId2>,...
```

Локально (dev): `http://localhost:3000/google/clone?ids=...`
(в dev нужен `NEXT_PUBLIC_GOOGLE_ENABLED=1` в `.env.local`, иначе `/google/clone` уводит на `/`).

## Параметры

| Параметр | Обяз. | Что это |
|----------|-------|---------|
| `ids`    | да    | Google Ads **campaign ID** кампаний-источников — числовые ID кампаний (11 цифр, например `24250092416`; те же, что в Google Ads UI, в LION Google metrics `campaign_id` и в вашей статистике), через запятую. Порядок сохраняется, дубли и любой не-цифровой мусор отбрасываются молча. Максимум **30** источников на борде — лишние молча отсекаются, поэтому режьте на своей стороне с предупреждением (как на FB). |
| `mode`   | нет   | `clone` — борд открывается сразу в режиме **Cloner** (копия в один из наших Google-аккаунтов `GLO-HS-001…010`); `juro` — сразу в режиме **JURO** (перезапуск в аккаунте самого источника). Любое другое значение игнорируется. Если не передать — борд откроется в том режиме, который байер выбирал в прошлый раз (localStorage), по умолчанию Cloner. |
| `partner` | **не нужен** | Google живёт только через LION (HS), параметр партнёра **игнорируется**. Не передавайте `partner=br` — в отличие от FB-ссылки, здесь его нет. |

**Больше ничего передавать не нужно.** Никаких бюджетов, аккаунтов, гео, ставок или имён —
клонер получит всё сам по ID из LION.

`ids` можно и повторять (`?ids=a&ids=b`) — значения склеиваются, но проще одна строка через запятую.

## Как открывать

Обычный GET-переход. Рекомендуется новая вкладка, чтобы ваш инструмент не закрывался:

```html
<!-- один клик по строке кампании: Clone -->
<a href="https://adlauncher.gcamazingtool.xyz/google/clone?ids=24250092416"
   target="_blank" rel="noopener">Clone</a>

<!-- та же строка: JURO -->
<a href="https://adlauncher.gcamazingtool.xyz/google/clone?mode=juro&ids=24250092416"
   target="_blank" rel="noopener">JURO</a>
```

```js
// массовый Clone / JURO по выбранным строкам
const CAP = 30; // столько источников принимает борд за раз
const BASE = "https://adlauncher.gcamazingtool.xyz/google/clone";

function openGoogleCloner(campaignIds, mode /* "clone" | "juro" */) {
  const ids = [...new Set(campaignIds.map(String).map((s) => s.trim()).filter((s) => /^\d{5,}$/.test(s)))];
  if (!ids.length) { alert("No campaigns selected"); return; }
  let take = ids;
  if (ids.length > CAP) {
    if (!confirm(`Selected ${ids.length} campaigns, but the cloner takes ${CAP} at a time. Open the first ${CAP}?`)) return;
    take = ids.slice(0, CAP);
  }
  const url = `${BASE}?mode=${mode}&ids=${encodeURIComponent(take.join(","))}`;
  window.open(url, "_blank", "noopener");
}
```

## Примеры

```
# одна кампания, Cloner
/google/clone?ids=24250092416

# несколько, Cloner (режим явно)
/google/clone?mode=clone&ids=24250092416,24240012365,24244540707

# сразу в режиме JURO
/google/clone?mode=juro&ids=24250092416,24240012365
```

## Чем отличается от FB-ссылки `/clone`

| | FB (`/clone`) | Google (`/google/clone`) |
|---|---|---|
| Роут | `/clone` | `/google/clone` |
| `ids` | Facebook campaign ID | **Google Ads campaign ID** |
| `partner` | нужен (`in` = MO, `br` = HS) | **не нужен**, игнорируется |
| `mode` | только для `partner=br` | работает всегда: `clone` / `juro` |
| Кто строит копии | Graph API (MO/AIF) или LION duplicate (HS) | всегда LION (google-weapon API) |
| Целевые аккаунты | профиль/аккаунт байера | только `GLO-HS-001…010` (Cloner); аккаунт источника (JURO) |

Если у вас уже есть FB-кнопка Clone/JURO — Google-кнопка это **другой базовый URL и другой
набор ID**, логика сбора и открытия та же.

## Важные нюансы

- **Авторизация.** Клонер за логином (тот же аккаунт Amazon Tools, что и у FB-клонера). Байер
  должен быть **уже залогинен** в `adlauncher.gcamazingtool.xyz` (сессия живёт 7 дней). Если
  сессии нет — его отправит на `/login`, и параметры ссылки при этом **теряются** (после входа
  открывается главная, ссылку надо нажать ещё раз). Проверено на проде 16.09.2026:
  неавторизованный переход → `307 /login`. Сохранение через `?next=` пока не сделано.
- **ID — это кампания.** Передавайте именно `campaign_id` Google Ads: не ad group, не ad, не
  customer id (ID аккаунта). Чужой или несуществующий ID пройдёт валидацию формата, но на борде
  строка получит «LION never saw this campaign — it can't be cloned» и не поедет.
- **Источник должен быть известен LION.** Факты строки (имя, статус, аккаунт, бюджет, бид, гео)
  клонер читает из LION Google metrics за последние 7 дней (сутки по São Paulo). Кампания,
  которой в метриках за 7 дней нет (например, давно на паузе), показывается как «no row in LION's
  Google metrics over the last 7 days — still launchable»: настоящий гейт — dataset LION
  (снапшот кампании в google-weapon), он прогревается автоматически при открытии борда.
  Практически: передавайте кампании **нашей команды** из LION — они клонируются.
- **Лимиты.** До **30** источников на борде; **1–20** копий на источник; не больше **45** копий
  (shots) за одну волну — борд сам не даст нажать Fire при превышении.
- **Объём URL.** ID в URL компактны, 30 штук проходят спокойно. Понадобятся сотни за раз —
  скажите, переключимся на POST-передачу с токеном.

## Что происходит на нашей стороне (для понимания)

1. `/google/clone` читает `ids` (и `mode`), каждая кампания = строка-источник. По каждому ID
   клонер запрашивает LION: метрики (имя, статус ENABLED/PAUSED, аккаунт, бюджет, бид; гео
   читается из сегмента имени `… - BE+CA - …`) и прогревает **dataset** в google-weapon
   (снапшот источника: чип `dataset` / `fetching…` / `not found`).
2. Байер настраивает волну:
   - **Cloner**: целевой аккаунт (только `GLO-HS-001…010`, BRL), пиксель (авто, если на аккаунте
     один; обязателен, если несколько), стратегия (Inherit или одна из 7: Maximize conversions,
     Max conversions · CPA cap, Target CPA, Target ROAS, Maximize conversion value, Max conv.
     value · target ROAS, Manual CPC), ставка (CPA в валюте целевого аккаунта или ROAS 1–200 %),
     бюджет в валюте целевого аккаунта (дефолт `30,00`; Google не принимает меньше BRL 25,40/день),
     число копий, хвост имени.
   - **JURO**: целевой аккаунт = аккаунт источника и стратегия источника — залочены; ставка по
     желанию (иначе наследуется), бюджет, пиксель аккаунта источника, число копий.
3. **Preview → Fire**: одна волна = один запрос на наш сервер, дальше сервер сам отправляет
   каждую копию в LION (`clone/launch/` или `juro/launch/` google-weapon API) — вкладку можно
   закрывать. Ответ LION `201 {taskId}` = статус **«Sent to LION»** — для нас это финал строки;
   саму кампанию строит LION, она рождается **ENABLED** (активации/паузы на нашей стороне нет).
4. Имя копии собирает LION: `<голова LION> | DD.MM <user> GC-Launcher[ хвост] | CLONE_FROM=<id>`
   (для JURO — `| JURO_FROM=<id>`). Маркер `GC-Launcher` — во всех кампаниях, рождённых через
   консоль. Прогресс и ID задач LION — в **Google Task Manager** (кнопка в шапке на Google-страницах).

## Если кнопка живёт в hs-tools (`google_tool`, страница `/gg/reports`)

FB-кнопка `Clone Selected` уже есть в `fb_tools/templates/reports.html` (IIFE в конце шаблона,
контракт `clone-link-contract.md`) и берёт ID из `.campaign-id-btn[data-adset-id]`. На Google-
странице `google_tool/templates/google_tool/reports.html` разметка такая же: `.row-select` +
`.campaign-id-btn[data-adset-id]`, и **`adset_id` там = Google `campaign_id`** (загрузчик
`LoadData_google.py` кладёт в колонку `adset_id` именно `campaign_id`). Значит:

1. В `fb_tools/func/partners.py` у партнёра LION добавить рядом с `clone` запись без `param`:
   ```python
   'google_clone': {'url': 'https://adlauncher.gcamazingtool.xyz/google/clone'},
   ```
2. В Google-шаблон добавить в `.mass-actions-row` две кнопки — `data-action="gclone"` и
   `data-action="gjuro"` — и повторить FB-IIFE с этим URL: собрать `.row-select:checked` →
   `dataset.adsetId`, дедуп, кап 30 с confirm, `window.open(url + '?mode=' + mode + '&ids=' + encodeURIComponent(ids.join(',')), '_blank', 'noopener')`.
3. Per-row кнопки Clone / JURO — обычные `<a target="_blank" rel="noopener">` с одним ID.

Ничего на стороне Ad Launcher менять не нужно.

## Статус

Google-рельса (Cloner + JURO + Launch) **задеплоена на прод** 14–15.09.2026, борд `/google/clone`
живой, диплинк `?ids=…&mode=…` — часть релиза. Формат ссылки из этого документа — финальный и
не изменится.
