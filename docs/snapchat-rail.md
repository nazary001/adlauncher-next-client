# Snapchat-рельса adlauncher («Snapchat-клонер»): как она устроена

Документ для разработчика, который впервые открывает Snapchat-часть Ad Launcher'а
(`adlauncher.gcamazingtool.xyz`). Здесь описан весь путь: от карточки на экране до живой кампании
в Snapchat, а дальше реестр ключей, таск-менеджер, отчёт о доходе, конфигурация, тесты,
эксплуатация и известные ловушки.

- Описано по `main` на 01.10.2026: рельса плюс клонер `/snap/clone` (§1), сделанный в этот день.
- Все имена функций, констант и файлов в тексте есть в коде (проверено скриптом). Номера строк
  почти не указываются, потому что быстро устаревают. Ищи по имени.
- Где комментарии в коде или старые доки расходятся с поведением, прав код. Такие места собраны в
  разделе [«Ловушки и техдолг»](#20-ловушки-и-техдолг).

---

## Содержание

0. [Коротко](#0-коротко)
1. [Клонер: копия живой кампании (`/snap/clone`)](#1-клонер-копия-живой-кампании-snapclone)
2. [Бизнес-схема: кто что даёт](#2-бизнес-схема-кто-что-даёт)
3. [Архитектура одним рисунком](#3-архитектура-одним-рисунком)
4. [Карта файлов](#4-карта-файлов)
5. [Путь одного запуска, шаг за шагом](#5-путь-одного-запуска-шаг-за-шагом)
6. [Что именно создаётся в Snapchat (тела запросов)](#6-что-именно-создаётся-в-snapchat-тела-запросов)
7. [Карточка: поля, дефолты, словари, лимиты](#7-карточка-поля-дефолты-словари-лимиты)
8. [Лендинг, ключ и имя кампании](#8-лендинг-ключ-и-имя-кампании)
9. [Валидация: один валидатор на клиент и сервер](#9-валидация-один-валидатор-на-клиент-и-сервер)
10. [Pump: как сервер строит кампании](#10-pump-как-сервер-строит-кампании)
11. [Реестр партнёрских ключей](#11-реестр-партнёрских-ключей)
12. [Таск-менеджер (Snap tasks)](#12-таск-менеджер-snap-tasks)
13. [Страница Keys · report: доход LION и расход Snapchat](#13-страница-keys--report-доход-lion-и-расход-snapchat)
14. [Клиент Snapchat Marketing API](#14-клиент-snapchat-marketing-api)
15. [Доступ и флаг включения](#15-доступ-и-флаг-включения)
16. [Переменные окружения](#16-переменные-окружения)
17. [Первичная настройка и ротация refresh-токена](#17-первичная-настройка-и-ротация-refresh-токена)
18. [Тесты и локальная проверка](#18-тесты-и-локальная-проверка)
19. [Эксплуатация: частые ситуации](#19-эксплуатация-частые-ситуации)
20. [Ловушки и техдолг](#20-ловушки-и-техдолг)
21. [История решений](#21-история-решений)
22. [Как вносить изменения](#22-как-вносить-изменения)
23. [Глоссарий](#23-глоссарий)

---

## 0. Коротко

- Рельса **создаёт новые** веб-кампании на **нашем собственном** Snapchat-аккаунте через
  Snapchat Marketing API. Существующие кампании Snapchat она не клонирует (см. §1).
- Партнёр **`stone`** даёт лендинги, пул из **500 ключей** `glo-snp_001…500` и дневной отчёт о
  доходе (через LION). **Одна кампания = один ключ.** Ключ уходит в ссылку как
  `?utm_source=stone&utm_campaign=<ключ>`, и так доход атрибутируется конкретной кампании.
- UI: `/snap` (доска карточек + Launch bay) и `/snap/keys` (реестр ключей + P/L).
  Snapchat — **платформенная вкладка**, а не партнёр в переключателе.
- Браузер только **заливает креативы в Vercel Blob** и отправляет **один** `POST /api/snap/launch`
  на всю волну. Кампании строит сервер в `after()` («pump»), так что вкладку можно закрыть.
- Цепочка в Snapchat: **campaign (PAUSED) → ad squad → (creative → ad) × каждый файл → activate**.
  Кампания рождается на паузе и включается последней, поэтому недостроенная цепочка не тратит деньги.
- Правила запуска проверяет **один чистый валидатор** `snapLaunchWire` (`lib/snap-launch.ts`). Его
  вхолостую гоняет карточка и по-настоящему гоняет сервер, поэтому их отказы не расходятся.
- Пишущие запросы в Snapchat **никогда не повторяются** (`attempts=1`). Неоднозначный исход (5xx или
  сеть) даёт статус `interrupted`, а повторная отправка могла бы создать вторую кампанию.
- Состояние хранится в общем Strapi: строки задач в `launch-task` (`partner="sn"`), реестр ключей
  и защита от повтора волны в `app-cache`.
- Включается build-time флагом `NEXT_PUBLIC_SNAP_ENABLED=1`, поэтому после смены флага нужен
  **редеплой**. На проде рельса включена с **17.09.2026**.
- **Клонер** (`/snap/clone?ids=<campaign id>` или `?keys=glo-snp_NNN`, с 01.10) читает живую
  кампанию из Snapchat и запускает её копии той же волной: каждая копия — новая кампания на **новом**
  ключе. На аккаунте источника медиа переиспользуются по id; на другом аккаунте файл заливается
  заново по ссылке Snapchat. Ссылку для внешних инструментов описывает
  `docs/snap-clone-link-contract.md`.

---

## 1. Клонер: копия живой кампании (`/snap/clone`)

До 01.10 «клонером» в команде звали саму рельсу. Настоящего копирования живых кампаний не было,
только **Duplicate this card** и **Copies** на доске запуска. С 01.10 есть клонер по образцу
Google/TikTok: ссылка с ID открывает доску источников, байер настраивает копии и жмёт **Clone**.

| Что | Где | Что делает |
|---|---|---|
| **Клонер** | `/snap/clone` → `components/snap-clone-board.tsx` | Копирует **живую** кампанию Snapchat: читает её через API, собирает черновик и запускает копии волной лаунчера. Копия = новая кампания на **новом** ключе. |
| **Duplicate this card** | `cloneSnapCard` в `components/snap-launch-card.tsx` | Копия **карточки** в UI доски запуска, со всеми полями и файлами (`id`, `collapsed`, `state`, `msg`, `progress` сбрасываются). |
| **Copies** (1…20) | `snapCardCopies`, `SNAP_MAX_COPIES = 20` | Одна карточка или источник даёт N **отдельных** кампаний, каждая со своим ключом. |
| Клон в Snapchat Ads Manager (руками) | вне кода | Лаунчер об этом не знает. Смотри предупреждение ниже. |

> ⚠️ **Клон в Ads Manager.** Во-первых, он наследует URL креатива, а в нём тот же
> `utm_campaign=<ключ>`. Доход двух кампаний сольётся на одном ключе, а реестр о клоне не узнает.
> Во-вторых, под **Awareness & Engagement** Ads Manager не даёт клону цели Purchase и Landing page
> view. Клонировать надо **через `/snap/clone`**: новый ключ, тот же лендинг.

### 1.1 Ссылка и входы

- `/snap/clone?ids=<UUID>,…&keys=glo-snp_NNN,…`: оба параметра принимают оба вида, в любом
  регистре и с любым разделителем; параметры можно повторять; дубли и мусор отбрасываются; берутся
  первые 30 (`snapCloneRefs`, `SNAP_CLONE_MAX_SOURCES`). `mode` и `partner` игнорируются. Контракт
  для внешнего разработчика: `docs/snap-clone-link-contract.md`.
- **Ключ** означает кампанию, которая держит его **сейчас**: `binding.campaign_id` в реестре
  (`snapCloneResolve`).
- Кнопки **Clone**: в дровере «Snap tasks» у каждой собранной (`done`) строки с `campaign_id` →
  `?ids=`; на `/snap/keys` у каждого ключа с кампанией → `?keys=`. Плюс поле «Add» на самой доске.

### 1.2 Чтение источника (`POST /api/snap/sources` → `lib/snap-clone-read.ts`)

1. Ключи переводятся в кампании по реестру (`listSnapKeys`; читается, только если в ссылке есть ключи).
2. По каждой кампании, 2 одновременно: `GET /campaigns/{id}`, затем параллельно
   `GET /campaigns/{id}/adsquads` и `GET /campaigns/{id}/ads`.
3. Креативы и медиа берутся из **библиотеки аккаунта**: `GET /adaccounts/{id}/creatives?limit=1000`
   и `…/media?limit=1000`, одна выборка на аккаунт, кэш 2 мин. На 01.10 у аккаунта было около 300 тех
   и других, это одна страница. Чего в выборке нет (кампания родилась минуту назад), читается по id:
   `GET /creatives/{id}`, `GET /media/{id}`.
4. `buildSnapCloneSource` (`lib/snap-source.ts`, чистый) складывает всё в **источник**: ad squad
   с наибольшим числом объявлений, объявления в порядке `#N` из имени, у каждого креатив, медиа
   (`download_link`, размер, кадр, `media_status`) и вердикт модерации.
5. Ошибки — построчно, на понятном языке (`snapSourceErrorText`): удалённая кампания (Snap отвечает
   400 «not available») → «gone from Snapchat»; несуществующий id (404 или 400 «cannot be correctly
   processed») → «No such campaign»; свободный ключ → «is free». Одна плохая строка не роняет остальные.

Факт, проверенный живьём 01.10: у медиа есть `download_link`, это **публичная** ссылка Google
Storage на оригинал файла. Она отдаёт 200 без авторизации, `Content-Length` = `file_size_in_bytes`,
но `Content-Type: multipart/form-data`. Поэтому pump при перезаливке ставит тип по расширению
(`snapUploadMime`).

### 1.3 Черновик (`snapCloneDraft`, `lib/snap-launch.ts` Part 3)

- **Копируется 1:1:** аккаунт (по умолчанию свой), пиксель, Public Profile, objective
  (AWARENESS_AND_ENGAGEMENT / SALES), цель (PIXEL_PURCHASE / LANDING_PAGE_VIEW), ставка
  (Auto / Max bid / Target cost + `bid_micro`), дневной бюджет, страны, минимальный возраст,
  устройства, заголовок, бренд, CTA, лендинг (`snapLandingBase`: query отрезан, ключ будет новый),
  хвост имени (`snapParseCampaignName` — обратная функция `snapCampaignName`).
- **На дефолт лаунчера с заметкой** (`notes`, жёлтый блок на панели): objective вне словаря →
  A&E; цель вне словаря (SWIPES и т.п.) → Pixel purchase; MIN_ROAS или ставка без суммы → Auto;
  lifetime-бюджет → дневной `10,00`; бюджет вне 5…10 000 → обрезается; CTA вне десяти → More;
  min age → ближайший из 18/21/25, который **не расширяет** аудиторию; регионы/метро, max age, пол,
  языки, интересы, сегменты, детали устройств не переносятся (заметка называет каждое); при
  нескольких ad squad'ах копируется тот, где больше объявлений.
- **Креативы:** по одному на объявление источника, в порядке `#N`. По умолчанию едут только
  клонируемые (`issue` пустой: WEB_VIEW, медиа есть, видео/картинка, `READY`), **не** `REJECTED`
  и не на паузе в источнике. Повтор отклонённого креатива — страйк всей организации. Тексты, лендинг
  и профиль берутся у первого выбранного; если остальные отличаются, об этом есть заметка.

### 1.4 Запуск копий

- Доска строит обычные `SnapLaunchShotIn` (`buildSnapShot` с `card.remote` вместо `files`) и шлёт их
  в **тот же** `POST /api/snap/launch`. Своего wave-роута у клонера нет: валидатор, приём волны,
  pump и реестр общие с запуском.
- У креатива клона: `url` = `download_link`, `snapMediaId` + `snapAccountId` = медиа источника
  (`SnapShotMedia`). Pump (`ensureMedia`): если аккаунт назначения совпадает → **reuse по id**, без
  скачивания, загрузки и ожидания READY. Если не совпадает → перезаливка с `url`: один раз на файл за
  волну, лимит 32 МБ. Без ссылки → креатив пропускается с фразой «can only be cloned on its own ad
  account». Медиа с другого аккаунта Snap не принимает (медиа принадлежит аккаунту); есть
  `POST /adaccounts/{id}/media_copy`, но в клонере он не используется: перезаливка проверена и
  покрывает все файлы лаунчера (они ≤32 МБ).
- Шот клона несёт `cloneOf` (id источника) и `cloneKey` (его ключ). Строки задач получают префикс
  `snc-…`, тег `clone · …` (в конце «N ads», чтобы уложиться в 40 символов), имя заканчивается на
  ` - CLONE_FROM=<ключ источника | первые 8 символов id>` (маркер не обрезается, первым режется хвост),
  в реестре ключа пишется `clone_of`.
- Доска: строка после `ok` **не готова**, пока её не изменили, поэтому повторное нажатие не
  создаёт дублей (на доске запуска это осталось техдолгом №1). «Изменили» = правка самой строки
  **или** настройки волны, на которой строка едет (Settings: Destination — для строк без своего
  аккаунта, Copies per source — для строк без своих копий, Start paused — для всех): клон в один
  аккаунт → выбран другой → строка снова готова, без перезагрузки. Правка, сделанная пока волна
  ещё принимается сервером, тоже считается: после ответа строка остаётся черновиком (на экране уже
  не то, что ушло). Правила — `components/snap-clone-core.ts`, тест `tests/snap-clone-core.test.ts`.
  Ключи раздаются по порядку строк из
  свободных; пока идут сборки, реестр перечитывается каждые 10 с.

---

## 2. Бизнес-схема: кто что даёт

- **Мы**: организация «GlobeCoders OÜ» в Snapchat Business, 10 USD-аккаунтов
  `GC-HS-snapchat-LA-1…10` (часовой пояс всех — `America/Los_Angeles`), один пиксель и Public Profile.
  Авто-аккаунт «<org> Self Service» скрыт и не принимается как цель
  (`SNAP_HIDDEN_AD_ACCOUNT_IDS`, `isSnapLaunchAccount`).
- **Партнёр `stone`** (`SNAP_UTM_SOURCE = "stone"`) даёт три вещи:
  1. **Лендинги.** Во-первых, его quiz/captcha-страницы на доменах вида fast-flow, которые байер
     **вставляет** в карточку. Там работает «browser killer»: переход из in-app браузера Snapchat в
     браузер телефона. Во-вторых, **две прямые статьи** брифа 16.09, которые выбираются в один клик
     (`SNAP_DIRECT_LANDINGS`):
     - `dmi`, «Digital marketing»: `https://azmvhs.com/v/dmi-online-marketing-course/`
     - `cars`, «Cars»: `https://azmvhs.com/v/auto-financing-by-ford/`
  2. **Пул ключей** `glo-snp_001…glo-snp_500` (до 23.09 их было 100). Одна кампания держит один ключ.
  3. **Дневной отчёт о доходе по ключам** через LION:
     `GET {LION_BASE}/api/high-adx-cluster-utms/snapchat-report/?date=YYYY-MM-DD` (Bearer `LION_TOKEN`).
     Партнёр просил не чаще одного запроса на день, поэтому ответы кэшируются (§13).
- **Конверсии.** Партнёр шлёт Purchase-события на **наш** пиксель через Snap CAPI. Мы отдали ему
  pixel id и CAPI-токен; в коде лаунчера CAPI не используется. Value в этих событиях составляет около 8%
  реального дохода, поэтому ROAS в Ads Manager занижен примерно в 12 раз.
  **P/L считаем только по LION** (страница `/snap/keys`).
- **Часовые пояса.** День партнёра и LION идёт по **São Paulo** (UTC−3). По нему же ставится дата в
  имени кампании. Аккаунты Snapchat живут по Лос-Анджелесу (см. §13, почему это важно для статистики).

---

## 3. Архитектура одним рисунком

```
 БРАУЗЕР                                   СЕРВЕР (Next.js, Vercel)                      ВНЕШНЕЕ
 ───────                                   ───────────────────────                      ───────
 /snap  SnapLaunchBoard ──GET──▶ /api/snap/accounts ──▶ lib/snap-api ────────────▶ Snapchat Ads API
        (карточки + bay)                                   (аккаунты, пиксели)         adsapi.snapchat.com/v1
        │ useSnapCatalog                                   (Public Profiles) ───────▶ Business API
        │ useSnapKeys ──GET──▶ /api/snap/keys ─────▶ lib/snap-keys ───────────────▶ Strapi app-cache
        │                                                                              (snap-key:<ключ>)
        │ креативы ──upload──▶ /api/blob-upload (общий) ─────────────────────────▶ Vercel Blob
        │
        └─POST {waveId, shots}─▶ /api/snap/launch
                                   └ lib/snap-wave.handleSnapLaunch
                                       валидация всех shots (snapLaunchWire, dry-run)
                                       строки задач ─────────────────────────────▶ Strapi launch-task
                                       захват волны ─────────────────────────────▶ Strapi app-cache
                                                                                      (snap-wave:<id>)
                                       after(): lib/snap-pump → snap-pump-core
                                         claimSnapKey ───────────────────────────▶ Strapi app-cache
                                         Blob → media upload → campaign → squad
                                         → creative → ad → activate ────────────▶ Snapchat Ads API
                                         строки задач (taskWriter) ──────────────▶ Strapi launch-task

 Шапка: SnapTaskManager ──GET/POST──▶ /api/snap-tasks ──▶ lib/task-store ────────▶ Strapi launch-task

 /snap/keys SnapKeysBoard ─GET─▶ /api/snap/report ─▶ lib/lion-snap + snap-report ─▶ LION snapchat-report
                          └─GET─▶ /api/snap/stats  ─▶ lib/snap-api + snap-stats ──▶ Snapchat stats/campaigns/ads
```

Чистые модули **без импортов** (`lib/snap-launch.ts`, `lib/snap-pump-core.ts`, `lib/snap-report.ts`,
`lib/snap-stats.ts`) запускаются под `node --test` прямо из исходников, без сборки. Побочные эффекты
им передаёт обёртка (`lib/snap-pump.ts`) или роут.

---

## 4. Карта файлов

### Страницы и компоненты (браузер)

| Файл | Роль |
|---|---|
| `app/(app)/snap/page.tsx` | Серверная страница `/snap`: нет сессии → `/login`; `!SNAP_ENABLED` → `redirect("/")`; рендерит `SnapLaunchBoard`. |
| `app/(app)/snap/keys/page.tsx` | Страница `/snap/keys`: те же гейты; диапазон дат читает из URL (`?range=` / `?from&to`). |
| `components/snap-launch-board.tsx` | Доска: колонка карточек + липкий **Launch bay**, раздача ключей, итоги, `fireWave` (аплоад + один POST). |
| `components/snap-launch-card.tsx` | Карточка кампании: тип `SnapCard`, `freshSnapCard`, `cloneSnapCard`, `snapCardRefusal` (dry-run), `snapCardSignature`, `buildSnapShot`, весь UI карточки. |
| `components/use-snap.ts` | Хуки `useSnapCatalog()` (`GET /api/snap/accounts`) и `useSnapKeys()` (`GET /api/snap/keys`) поверх `useOneShot`. |
| `components/snap-nav.tsx` | Под-навигация: **Launch** (`/snap`), **Clone** (`/snap/clone`) и **Keys · report** (`/snap/keys`). |
| `app/(app)/snap/clone/page.tsx` | Страница клонера: гейты как у `/snap`, `ids` / `keys` из URL → `snapCloneRefs` → `SnapCloneBoard`. |
| `components/snap-clone-board.tsx` | Доска клонера (§1): Settings (destination, copies, start paused, итоги, Preview → Clone) + панели источников (факты, заметки, поля клона, креативы-плитки с вердиктом модерации, одно превью-видео на доску). |
| `components/snap-task-manager.tsx` | Провайдер, кнопка «Snap tasks» в шапке и дровер задач. Показывает строки `partner="sn"` из Strapi. |
| `components/snap-keys-board.tsx` | Таблица ключей: реестр + доход LION + расход Snapchat, выбор дат, Release (только owner). |
| `components/header.tsx`, `app/(app)/layout.tsx` | Вкладка Snapchat (жёлтая), заблокированный переключатель партнёра; `SnapTaskManagerProvider` смонтирован один раз в общем shell. |
| `components/blob-uploader.ts`, `components/upload-guard.tsx`, `components/dropzone.tsx` | Общие для всех рельс: заливка в Blob с ретраями, защита от закрытия вкладки, галерея файлов (для Snap — портретная 9:16). |

### API-роуты

| Роут | Роль |
|---|---|
| `app/api/snap/launch/route.ts` | `POST`, `maxDuration = 800`. Тонкая обёртка над `handleSnapLaunch`. |
| `app/api/snap/accounts/route.ts` | `GET`: каталог для пикеров (аккаунты + пиксели + Public Profiles + дефолты из env). |
| `app/api/snap/keys/route.ts` | `GET` реестр (`poolMax/used/free/next`); `DELETE ?key=` освобождает ключ (только owner). |
| `app/api/snap/report/route.ts` | `GET ?date=` / `?from&to`: доход LION по ключам, соединённый с реестром. |
| `app/api/snap/stats/route.ts` | `GET`: сторона Snapchat (spend / impressions / swipes / доставка / модерация) за то же окно. |
| `app/api/snap/sources/route.ts` | `POST {refs}` (или `{ids, keys}`): источники клонера, только чтение (§1.2). |
| `app/api/snap/oauth/start`, `.../callback` | Разовый помощник owner'а: получить `SNAP_REFRESH_TOKEN`. |
| `app/api/snap-tasks/route.ts` | Таск-менеджер: `GET` (команда, 7 дней), `POST` (upsert ≤25), `DELETE` (свои строки). |

### Библиотеки (сервер и чистые)

| Файл | Роль |
|---|---|
| `lib/snap-launch.ts` | **Чистые решения, без runtime-импортов**: ключи, лендинги, имя, словари, лимиты, деньги, гео, типы тел запросов, **`snapLaunchWire`**; Part 3 — клонер (`snapCloneRefs`, `snapCloneResolve`, `snapParseCampaignName`, `snapCloneDraft`, `snapRemoteMediaIssue`, `snapSourceErrorText`). |
| `lib/snap-source.ts` | Чистый разбор ответов Snapchat по одной кампании в источник клонера (`buildSnapCloneSource`, `parseSnapSourceMedia`, `snapEnvelopeEntities`). |
| `lib/snap-clone-read.ts` | Сервер: ссылки клонера → кампании → чтение цепочки и библиотек аккаунтов (§1.2). |
| `lib/snap-wave.ts` | `handleSnapLaunch` / `acceptSnapWave`: гейты → проверка каждого shot → строки задач → захват волны → `after(pump)`. |
| `lib/snap-pump.ts` | Связывает реальные побочные эффекты (Snap API, реестр, запись задач, скачивание из Blob) с чистым pump. `SNAP_PARTNER = "sn"`. |
| `lib/snap-pump-core.ts` | **Чистый алгоритм pump**: этапы, бюджет времени, переиспользование медиа, исходы при сбоях. |
| `lib/snap-api.ts` | Клиент Marketing API: OAuth-refresh, `snapFetch` (ретраи и ошибки), кэши чтений, создание сущностей, скачивание креатива. |
| `lib/snap-oauth.ts` | Подпись и проверка `state` для OAuth-помощника. |
| `lib/snap-keys.ts` | Реестр ключей поверх Strapi `app-cache`: атомарный `claimSnapKey`, `backfillSnapKey`, `releaseSnapKey*`. |
| `lib/lion-snap.ts`, `lib/snap-report.ts` | Чтение, кэш и разбор отчёта LION; даты São Paulo; склейка диапазонов. |
| `lib/snap-stats.ts` | Разбор статистики и статусов Snapchat, `joinSnapLive`, `snapDeliveryNote`, `snapMoney`. |
| `lib/task-store.ts`, `lib/app-cache.ts` | Общие для рельс: строки `launch-task`, ключ-значение поверх `app-cache` (здесь для защиты от повторной волны). |
| `lib/partners.ts` | `SNAP_ENABLED` (build-time флаг). |

### Тесты, скрипты, доки

- `tests/snap-*.test.ts`: юнит-тесты чистых модулей (`node --test`); клонер — `snap-source`, `snap-clone`.
- `_e2e/`: мок Snapchat, smoke, UI-проверки, операционные скрипты.
  ⚠️ Папка лежит в `.git/info/exclude`, **в git её нет**. Она существует только локально у owner'а.
- `docs/superpowers/specs/2026-09-16-snapchat-rail-design.md`: исходный дизайн. Основная часть
  устарела; с кодом совпадает только addendum от 24.09 («Fourth pass»).
- `docs/superpowers/plans/2026-09-16-snapchat-rail.md`: план реализации (исторический).
- `docs/snap-clone-link-contract.md`: ссылка клонера для внешних инструментов (hs-tools, отчёты по LION).

---

## 5. Путь одного запуска, шаг за шагом

### 5.1 Браузер: карточки → волна

1. **Каталог.** `useSnapCatalog()` один раз читает `GET /api/snap/accounts` и получает
   `{accounts[+pixels], profiles, profilesError?, defaults}`. Дефолты из env (`SNAP_AD_ACCOUNT_ID`,
   `SNAP_PIXEL_ID`, `SNAP_PROFILE_ID`, `SNAP_BRAND_NAME`) один раз заполняют **нетронутые** поля карточек.
2. **Ключи.** `useSnapKeys()` читает `GET /api/snap/keys` и получает `{poolMax, used, free, next}`.
   Bay раздаёт свободные ключи **только готовым** карточкам, в порядке доски: `keyCursor` двигается
   на число копий. Пока идут билды, ключи перечитываются каждые `KEYS_POLL_MS = 10 с`.
   Показанные ключи — **ожидание**: сервер забирает ключи сам и, если желаемый уже занят, берёт следующий.
3. **Готовность карточки** (`ready`): выбран аккаунт, найден пиксель (если цель его требует),
   `snapCardRefusal(card) === null`. Этот отказ получается dry-run'ом того же `snapLaunchWire` с
   заглушками: `key "glo-snp_001"`, `mediaIds "pending"`, `name "preview"` (§9).
4. **Кнопка Launch** заблокирована (`fireBlocked`), если: волна уже летит; нет готовых карточек;
   каталог грузится или упал; копий больше `SNAP_MAX_SHOTS = 45`; свободных ключей меньше, чем копий;
   ключи ещё не загружены. Сама кнопка **Launch N** появляется только после **Generate preview**,
   а любая правка карточки прячет её снова.
5. **`fireWave`**:
   - защита от двойного клика (`makeGate`), `waveId`: если подпись готовых карточек
     (`snapCardSignature`, в неё входят id файлов) не изменилась, остаётся **прежний** `waveId`, иначе
     `crypto.randomUUID()`. Ретрай того же содержимого сервер распознает как повтор (§5.2).
   - для каждой готовой карточки её файлы заливаются в Vercel Blob (`uploadCardCreatives`,
     3 параллельно, путь `snap/<user>/<waveId>/<cardId>-<n>-<name>`). Заливка карточки **атомарна**:
     если упал хоть один файл, карточка выпадает из волны (остальные едут). Пока идёт заливка,
     `useUnloadGuard` не даёт закрыть вкладку.
   - на каждую копию `buildSnapShot(card, {mediaUrls, desiredKey, currency, accountName})` собирает
     один **shot** = одна будущая кампания.
   - **Один** `POST /api/snap/launch {waveId, shots}`.
   - `ok` → карточки получают state `ok` («queued — safe to close the tab»), открывается дровер задач.
     Если ответ — ошибка вида `shot N: …`, она подсвечивает виноватую карточку.

### 5.2 Сервер: приём волны (`lib/snap-wave.ts`)

Все отказы срабатывают **до** того, как появилась хоть одна строка задачи:

1. `t0 = now()` фиксируется **в самом начале**, до чтения каталога: `maxDuration` отсчитывается от
   начала запроса, а чтения могут съесть минуты таймаутов.
2. Нет сессии → **401** `unauthorized`; флаг выключен → **404** `snap_rail_disabled`; нет
   `SNAP_CLIENT_ID/SECRET/REFRESH_TOKEN` → **500** `snap_not_configured`; кривой JSON → **400** `bad_json`;
   0 shots → **400** `no_shots`; больше 45 → **400** `too_many_shots (max 45)`.
3. `waveId`, не совпадающий с `SNAP_WAVE_ID_RE = /^[a-zA-Z0-9-]{8,64}$/`, заменяется новым UUID.
   Запуск пройдёт, но защита от повтора на ретраях клиента пропадёт.
4. `snapAdAccounts()` пропускается через `isSnapLaunchAccount`: скрытые аккаунты не просто не
   показываются, их **нельзя** выбрать целью. Ошибка Snap → **502** (`snap_auth_failed` при 401,
   иначе `snap_unavailable`).
5. Каждый shot нормализуется (`cleanShot`: trim, `minAge` по умолчанию "18",
   `deviceOs` через `snapDeviceOs`, переводы строк в хвосте имени → пробелы), затем проверяются:
   - аккаунт: пустой или чужой → 400; при пустом берётся `SNAP_AD_ACCOUNT_ID`;
   - пиксель (`resolvePixel`): выбранный не с этого аккаунта → ошибка; цель требует пиксель, а на
     аккаунте их 0 → ошибка; ровно 1 → берётся автоматически; несколько и не выбран → «pick one» +
     `availablePixels`;
   - Public Profile: из shot, иначе `SNAP_PROFILE_ID`, иначе 400;
   - brand name: пустой → `SNAP_BRAND_NAME`;
   - креатив с URL `https://pending.local/…` → 400 `creative upload did not finish`: заливка на клиенте
     не завершилась, а pump не должен ради такого занимать ключ;
   - на проде (`NODE_ENV=production`) не-https креатив → 400, если не задан `SNAP_ALLOW_LOOPBACK_MEDIA=1`
     (только для локального `next start`);
   - **dry-run `snapLaunchWire`** с заглушками → любой отказ = 400 с точной фразой, как её исправить.
   - Вычисляются предварительное имя, тег для монитора (`"auto · Android · 5 creatives"`) и
     `taskId = snapShotTaskId(waveId, i)` = `snl-<wave>-NN`.
6. **`acceptSnapWave`** (защита от повтора в два слоя, ключ `snap-wave:<waveId>`):
   - в памяти инстанса `claimedWaves` (до 500 записей) → повтор → `{ok, alreadyAccepted:true}`;
   - `readAppCache("snap-wave:<id>")` уже содержит запись → `alreadyAccepted` (между инстансами);
   - хранилище задач не настроено → **503** (fail closed: ретрай мог бы прогнать pump дважды);
   - **сначала** все строки задач пишутся (`upsertTaskRow`: `partner:"sn"`, `status:"running"`,
     `stage:"key"`), и команда видит их, даже если браузер тут же умрёт;
   - затем `writeAppCache("snap-wave:<id>")`. Если вернулся `null`, перечитываем: запись победителя
     есть → `alreadyAccepted` (волна крутится на другом инстансе); записи нет → хранилище лежит, все
     строки помечаются `error/failed` («wave not fired — task store unavailable») и ответ **503**;
   - успех → `after(() => pumpSnapWave(user, shots, t0 + SNAP_PUMP_BUDGET_MS))` и ответ
     `{ok:true, queued:N, rows:[{taskId}]}`.

### 5.3 Сервер: pump (кратко, подробно в §10)

```
по shot'ам ПО ОЧЕРЕДИ (пауза 1–3 с между ними):
  admission: успеет ли копия до дедлайна? нет → строка error/failed «time budget ran out»
  [key]      claimSnapKey(desired) ─ POST app-cache "snap-key:<ключ>" (unique = атомарно)
  [media]    Blob → POST /adaccounts/{id}/media → POST /media/{id}/upload → GET /media/{id} до READY
  [campaign] POST /adaccounts/{id}/campaigns        status: PAUSED
  [adsquad]  POST /campaigns/{id}/adsquads          status: ACTIVE
  [creative → ad] × каждый файл: POST /adaccounts/{id}/creatives → POST /adsquads/{id}/ads
  [activate] GET /campaigns/{id} → PUT /adaccounts/{id}/campaigns (status: ACTIVE), если не startPaused
  [done]     backfillSnapKey(active + ids) · строка done / live (или paused)
finally: flush() всех записей задач
```

### 5.4 После запуска

- Дровер «Snap tasks» (в шапке любой страницы) показывает строки всей команды за 7 дней и копирует
  id кампании, ad squad, ad и финальную ссылку.
- `/snap/keys` показывает, кто держит какой ключ, сколько кампания потратила в Snapchat и сколько
  заработала по LION.

---

## 6. Что именно создаётся в Snapchat (тела запросов)

Пример построен на тестовых данных `tests/snap-launch.test.ts` (happy path). Входной shot:
аккаунт `acct-a`, пиксель `px-1`, `PIXEL_PURCHASE`, `AUTO_BID`, бюджет `"10,00"`, headline
«Drive it home today», brand «GC Cars», CTA `MORE`, 1 видео, `geo:["US"]`, `minAge:"18"`, лендинг
`https://fast-flow.org/ht/captcha-1/cars/en/`; objective и deviceOs не заданы. Ключ `glo-snp_003`.

**Campaign** → `POST /adaccounts/{ad_account_id}/campaigns` с телом `{campaigns:[…]}`:
```json
{ "name": "[16.09] (SNP) Cars - US - glo-snp_003 - nazar - GC-Launcher",
  "ad_account_id": "acct-a", "status": "PAUSED", "start_time": "<now + 60 s>" }
```
`objective_v2_properties` здесь **нет**: для дефолтного Awareness & Engagement поле не
отправляется, и Snap ставит свой `AWARENESS_AND_ENGAGEMENT` (`is_auto_generated: true`). Для Sales
добавляется `"objective_v2_properties": {"objective_v2_type": "SALES"}`.

**Ad squad** → `POST /campaigns/{campaign_id}/adsquads` с телом `{adsquads:[…]}` (+ `campaign_id`):
```json
{ "name": "<то же имя>", "type": "SNAP_ADS", "billing_event": "IMPRESSION",
  "delivery_constraint": "DAILY_BUDGET", "daily_budget_micro": 10000000,
  "bid_strategy": "AUTO_BID", "optimization_goal": "PIXEL_PURCHASE",
  "placement_v2": { "config": "AUTOMATIC" },
  "targeting": { "geos": [{ "country_code": "us" }],
                 "demographics": [{ "min_age": "18" }],
                 "devices": [{ "os_type": "ANDROID" }] },
  "pixel_id": "px-1", "status": "ACTIVE", "start_time": "<now + 60 s>" }
```
- `bid_micro` отправляется только при Max bid / Target cost. При `AUTO_BID` его отправка даёт 400.
- `devices` не отправляется при «All devices»; `pixel_id` не отправляется, если пикселя нет
  (цель Landing page view).

**Creative** (на каждый файл) → `POST /adaccounts/{id}/creatives`:
```json
{ "ad_account_id": "acct-a", "name": "<имя>", "type": "WEB_VIEW", "ad_product": "SNAP_AD",
  "headline": "Drive it home today", "brand_name": "GC Cars", "call_to_action": "MORE",
  "top_snap_media_id": "<media id>", "shareable": true,
  "web_view_properties": { "url": "https://fast-flow.org/ht/captcha-1/cars/en/?utm_source=stone&utm_campaign=glo-snp_003",
                           "block_preload": false, "allow_snap_javascript_sdk": false, "use_immersive_mode": false },
  "profile_properties": { "profile_id": "<Public Profile>" } }
```

**Ad** (на каждый файл) → `POST /adsquads/{ad_squad_id}/ads`:
```json
{ "name": "<имя>", "type": "REMOTE_WEBPAGE", "status": "ACTIVE",
  "ad_squad_id": "<id>", "creative_id": "<id>" }
```

**Мульти-креатив.** 3 файла дают **одну** кампанию, **один** ad squad, **один** ключ и 3 пары
creative+ad с именами `<имя> #1`, `#2`, `#3` (номер = позиция файла в карточке). Если файл не
загрузился или Snap его отклонил, он пропускается, а остальные сохраняют свои номера (`#1`, `#3`).
С одним файлом имя остаётся без номера (`snapAdUnitName`).

**Активация**: `snapSetCampaignStatus`. У Snap PUT заменяет **весь объект**, и пропущенные поля
сбрасываются. Поэтому сначала `GET /campaigns/{id}`, затем берутся разрешённые поля
(`CAMPAIGN_PUT_FIELDS`), меняется `status` и выполняется `PUT /adaccounts/{ad_account_id}/campaigns`.

---

## 7. Карточка: поля, дефолты, словари, лимиты

Все словари и лимиты лежат в `lib/snap-launch.ts`. Дефолты новой карточки задаёт `freshSnapCard`.

| Секция / поле | Значения | По умолчанию | Примечание |
|---|---|---|---|
| **Ad account** | аккаунты из каталога | `SNAP_AD_ACCOUNT_ID` | Скрытые и «… Self Service» не показываются. При смене аккаунта пиксель сбрасывается. |
| **Pixel** | пиксели аккаунта | единственный пиксель или `SNAP_PIXEL_ID` | Нужен только для `PIXEL_PURCHASE`. |
| **Public Profile** | профили организации | `SNAP_PROFILE_ID` | Обязателен на каждом ad (правило Snap с 26.02.2024). Если Business API не отдаёт список (403), подставляется `SNAP_PROFILE_ID` (+ `SNAP_PROFILE_NAME`). |
| **Name tail** | текст ≤80 | пусто | Хвост имени кампании. |
| **Objective** (`SNAP_OBJECTIVES`) | `AWARENESS_AND_ENGAGEMENT` · `SALES` | Awareness & Engagement | Доставкой не управляет, влияет только на то, что предлагает Ads Manager на кампании и её клоне. Awareness **не отправляется** (`wire:null`). |
| **Optimization goal** (`SNAP_OPTIMIZATION_GOALS`) | `PIXEL_PURCHASE` (нужен пиксель) · `LANDING_PAGE_VIEW` | `PIXEL_PURCHASE` | Любая другая цель (SWIPES, PIXEL_PAGE_VIEW, IMPRESSIONS) отклоняется по имени. Обе цели работают под обоими objective. |
| **Bidding** (`SNAP_BID_STRATEGIES`) | `AUTO_BID` (без ставки) · `LOWEST_COST_WITH_MAX_BID` «Max bid» · `TARGET_COST` | `AUTO_BID` | `MIN_ROAS` нет: Snap убрал его 10.02.2025. |
| **Bid** | 0,01…500 | пусто | Только для Max bid / Target cost. |
| **Daily budget** | 5…10 000 | `"10,00"` (`SNAP_DEFAULT_BUDGET`) | Минимум Snap — $5/день. Деньги хранятся строкой с запятой. |
| **Start paused** | чекбокс | выкл. | Цепочка строится целиком, кампания остаётся PAUSED, строка `done/paused`. |
| **Creatives** | видео / изображения, 9:16 | — | Лимита на число файлов в UI нет (на сервере до 200 как защита от злоупотреблений). Каждый файл ≤32 МБ. Для не-9:16 и <1080×1920 показывается мягкое предупреждение. |
| **Headline** | ≤34 символа | пусто | Обязателен. |
| **Brand name** | ≤32 символа | `SNAP_BRAND_NAME` | Обязателен. |
| **Call to action** (`SNAP_CTAS`) | MORE, SHOP_NOW, SIGN_UP, APPLY_NOW, VIEW, READ, GET_NOW, TRY, SHOW, WATCH | `MORE` | |
| **Minimum age** (`SNAP_MIN_AGES`) | 18 / 21 / 25 | 18 | |
| **Countries** | ISO-2, пресеты `SNAP_GEO_PRESETS` | `["US"]` | Пресеты: US · Anglo (US CA GB AU NZ IE) · LATAM (17) · Franco (FR BE CH LU MC CA) · EU (27). **Worldwide у Snap нет**, `WW` отклоняется. |
| **Devices** (`SNAP_DEVICE_OPTIONS`) | Android only · iOS only · All devices | **Android only** | Просьба партнёра (21.09): «browser killer» работает на Android, и отчисления считаются по этому трафику. «All» = поле `devices` вообще не отправляется. Значение пишется именно `"iOS"`. |
| **Landing** | вставленный https-URL или кнопка **Direct** | пусто | См. §8. |
| **Copies** | 1…20 (`SNAP_MAX_COPIES`) | 1 | N кампаний = N ключей. |

Другие лимиты: `SNAP_NAME_MAX = 375` (потолок Snap на имена), `SNAP_MAX_SHOTS = 45` (копий на волну,
на доске `MAX_CARDS = 45`), `SNAP_MAX_CREATIVES = 200` (на shot), `SNAP_MEDIA_MAX_BYTES = 32 МБ`
(загрузка одним куском; chunked upload не реализован).

**Деньги.** `parseDecimal` понимает запятую как десятичный разделитель (`"10,00"` → 10;
`"1,234.56"` → 1234.56). `snapMicro` переводит в micro как центы × 10 000 и возвращает `null` вне диапазона.
Это копия `parseDecimal` из `lib/google-bid.ts` байт в байт (не `parseMoney`), и две копии нужно
держать одинаковыми.

---

## 8. Лендинг, ключ и имя кампании

### Лендинг → финальная ссылка

1. `snapLandingBase(raw)` принимает только `https://`, хост с точкой (`localhost` не пройдёт) и
   **отбрасывает весь вставленный query и hash**. Причины: чужой `utm_source` перебил бы `stone`,
   а в примерах партнёра встречается `utm_campaign=glo-snp_001`, тогда как ключ у кампании
   **свой**, а не вставленный.
2. `snapLandingUrl(base, key)` = **`<base>?utm_source=stone&utm_campaign=<key>`**, без макросов.
3. Snap сам дописывает `&ScCid=<click id>` при каждом свайпе, отправлять его не нужно.
   ⚠️ В Ads Manager **нельзя** включать «auto URL parameters»: они перепишут наши utm.
4. В карточке `snapLandingSegments` раскрашивает превью (база / utm / ключ / `ScCid`), кнопка
   **Copy** копирует ссылку.
5. Кнопки **Direct** (`SNAP_DIRECT_LANDINGS`) просто подставляют URL статьи в поле. Дальше ссылка
   собирается так же, как для вставленной.

### Ниша (для имени)

`snapNicheFromLanding`:
1. прямая статья → её ниша («Digital marketing» / «Cars»);
2. иначе первый сегмент пути, который не служебный (`LANDING_GATE_SEG`: `ht`, `htai`, `v`, `r`,
   языковые коды `en`/`pt-br`, числа, `captcha-*`, `age-gate`, `quiz-*`, `gate-*`). Дефисы
   становятся пробелами, первая буква заглавная, длина ≤40 (`SNAP_NICHE_MAX`);
3. иначе слово домена (`fast-flow.org` → «Fast flow»); если ниша пустая совсем → «Custom».

Примеры: `/ht/age-gate/digital-marketing/en/` → «Digital marketing»; `/ht/captcha-1/cars/en/` → «Cars»;
`/ht/quiz-2/pt-br/` → «Fast flow».

### Имя кампании

`snapCampaignName` → **`[DD.MM] (SNP) <ниша> - <GEO> - <ключ> - <юзер> - GC-Launcher[ - <хвост>]`**

- `DD.MM` — сегодняшняя дата **по São Paulo** (`todaySaoPauloDotDDMM`); `GEO` — коды через `+` (`US+CA`).
- `GC-Launcher` (`SNAP_NAME_MARK`) — обязательная метка всех кампаний из консоли (правило 14.09).
- Ключ стоит **внутри** имени, чтобы отчёт LION по ключу можно было сопоставить с Ads Manager.
- `|` в хвосте заменяется на `/`, чтобы хвост не подделал сегмент. Если имя длиннее 375, первым
  обрезается хвост. Пустые поля: ниша «Snap», гео «??», юзер «buyer».
- Одно и то же имя получают campaign, ad squad, creative и ad (с `#N` при нескольких файлах).
- Пример: `[16.09] (SNP) Cars - US - glo-snp_012 - nazar - GC-Launcher`.

Предварительное имя (с желаемым ключом) считается при приёме волны. **Настоящее** имя pump собирает
после захвата ключа, потому что ключ мог смениться.

---

## 9. Валидация: один валидатор на клиент и сервер

`snapLaunchWire(shot, resolved)` в `lib/snap-launch.ts` — чистая и детерминированная функция.
Она возвращает либо `{wire:{campaign, adsquad, ads[], landingUrl}, label, geoLabel, landingBase, niche,
deviceOs, bidMicro?}`, либо `{refusal: "<фраза, как исправить>"}`.

Кто её вызывает:
- **карточка** (`snapCardRefusal`) — с заглушками, для точки готовности и текста под карточкой;
- **приём волны** (`snap-wave.ts`) — с заглушками, чтобы отказ пришёл до появления строк;
- **pump** — с настоящими ключом, id медиа, именем и `start_time`.

Порядок проверок: бюджет → стратегия/ставка → цель (+пиксель) → objective → headline → brand →
CTA → креативы (каждый) → гео → возраст → устройства → лендинг → Public Profile → ключ → id медиа →
имя → аккаунт. Примеры отказов:

| Проверка | Текст отказа |
|---|---|
| бюджет | `Daily budget must be between 5 and 10000 in the account currency` |
| ставка нужна | `Target cost needs a bid in the account currency (e.g. 0,50)` |
| ставка лишняя | `Auto bid takes no bid — clear the bid` |
| цель | `Unknown optimization goal "SWIPES" — only Pixel purchase or Landing page view` |
| пиксель | `Pixel purchase needs a conversion pixel — pick one or choose Landing page view` |
| objective | `Unknown campaign objective "TRAFFIC" — only Awareness & Engagement / Sales` |
| headline | `Headline is required` / `Headline is over 34 characters (35)` |
| креативы | `At least one creative (a vertical video or image) is required`, `Creative 2 must be a public https:// file` |
| гео | `Pick at least one country — Snapchat has no worldwide targeting`, `Unknown country code(s): USA` |
| устройства | `Devices must be one of Android only / iOS only / All devices` |
| лендинг | `Landing must be a pasted https:// address (the partner's quiz page) or one of the direct articles` |
| профиль | `A Public Profile is required on every Snapchat ad — set SNAP_PROFILE_ID or pick one` |
| ключ | `Key "…" is not one of the partner keys glo-snp_001…500` |

Помимо валидатора есть клиентские гейты карточки (`snapMediaIssue`: ≥1 файл, только видео или
изображение, ≤32 МБ) и серверные гейты приёма (аккаунт, пиксель, профиль, `pending.local`, https на
проде, §5.2).

> **Правило:** чтобы поменять правило запуска, правь **только** `lib/snap-launch.ts`. UI и сервер
> подхватят изменение сами. Если карточка «готова», а сервер отказывает, это баг.

---

## 10. Pump: как сервер строит кампании

`runSnapPump` в `lib/snap-pump-core.ts` — чистый алгоритм, все побочные эффекты передаются ему
через deps (`lib/snap-pump.ts`).

### 10.1 Этапы

`SNAP_PUMP_STAGES = ["key","media","campaign","adsquad","creative","ad","activate","live","paused","failed"]`

Shot'ы идут **по одному**, между ними пауза 1–3 с (`jitter`). Для каждого:

1. **key**: `claimSnapKey(desiredKey, meta)`. Если ключ не удалось взять → строка `error` на этапе `key`.
2. **media** (`ensureMedia`): скачать из Blob (`snapFetchBytes`, лимит 32 МБ, чтение потоком со счётчиком
   байт) → `createMedia` → `uploadMedia` (multipart, поле `file`) → опрос `mediaReady` каждые 5 с,
   до 120 с. Параллельно 3 файла (`MEDIA_CONCURRENCY`).
   - Один файл заливается **один раз на пару (аккаунт, URL) за волну** (`mediaByKey`): копии карточки
     используют тот же media id; `mediaInFlight` склеивает одновременные заливки одного файла.
   - Отказ 4xx (включая >32 МБ и «так и не READY») запоминается на всю волну (`mediaRefused`), а
     сетевой сбой не запоминается, и следующая копия может успеть.
   - Если не загрузилось **ни одного** файла → ключ **освобождается**, строка `error`.
3. Настоящий `buildWire` (`snapLaunchWire` с реальным ключом, media id, именем и
   `start_time = now + 60 с`: так медленная заливка не сдвинет старт в прошлое, а прошедший
   `start_time` Snap не принимает). Отказ → ключ освобождается, `error`.
4. **campaign**: `status: "PAUSED"`.
5. **adsquad**: `status: "ACTIVE"`, но кампания стоит на паузе, и показов нет.
6. **creative → ad** для каждого загруженного файла. Отказ Snap по одному файлу (4xx) —
   пропустить и указать в строке. Цикл **останавливается**, если:
   - пришёл отказ уровня аккаунта или токена: **401 / 403 / 429** (`isAccountLevel`);
   - подряд 5 отказов, а не построено ещё ничего (`MAX_LEADING_REFUSALS`): общая причина вроде
     headline, профиля или аккаунта, долбить 200 раз в ту же стену незачем;
   - исход неоднозначный (5xx или сеть): такой запрос не повторяется;
   - до дедлайна осталось меньше запаса (проверяется перед каждым креативом после первого).
   Stage в строку пишется только для **первого** креатива, поэтому число записей не растёт с длиной
   списка (≤14 записей на 50 креативов).
7. **activate** (если не `startPaused`): `snapSetCampaignStatus(id, "ACTIVE")`. Сбой активации
   **не считается** провалом запуска: цепочка вся есть, строка `done/paused` с пометкой, байер
   включит кампанию в Ads Manager.
8. **done**: `backfillSnapKey(key, {status:"active", campaign_id, adsquad_id, ad_id, ad_count, name})`,
   строка `done`, stage `live` (или `paused`), `link`, `gcm = ключ`, заметки в `error`.
9. `finally: flush()` дожидается хвоста записей, чтобы Vercel не заморозил функцию посреди записи.

### 10.2 Бюджет времени

- Роут: `maxDuration = 800 с`. Бюджет pump: `SNAP_PUMP_BUDGET_MS = 770 000` (30 с запаса),
  `deadline = t0 + 770 с`, где `t0` — начало **запроса** (§5.2).
- `DEADLINE_MARGIN_MS = 120 с` — столько ещё может понадобиться уже допущенной копии (5 созданий
  + GET/PUT активации, каждый ≤60 с). Если Vercel убьёт функцию, строка на 3 часа останется
  `running`, а ключ `active` без id. Поэтому в последние 2 минуты копии не допускаются.
- **Допуск копии**: если все её медиа уже решены в этой волне, резерв = 120 с; если нужна свежая
  заливка, резерв = 120 + 120 = 240 с. Не помещается → строка `error/failed`: «Not built — the wave's
  time budget ran out before this copy; fire it again». Ключ при этом не берётся, в Snap ничего не шлётся.

### 10.3 Исходы при сбоях

| Где упало | Причина | Ключ | Строка (`status` / `stage`) |
|---|---|---|---|
| до любых сущностей Snap | `claimKey` бросил | — | `error` / `key` |
| | ни один файл не загрузился, отказ `buildWire` | **освобождается** | `error` / `media` или `failed` |
| создание campaign | 4xx | **освобождается** | `error` / `campaign` |
| | 5xx / сеть (кампания могла создаться) | **retired** + заметка | `interrupted` / `campaign` |
| campaign есть, 0 ads | отказ adsquad / creative / ad (4xx) | **retired** (+ id) | `error` / этап |
| | 5xx / сеть | **retired** | `interrupted` / этап |
| построен ≥1 ad | дальше отказ уровня аккаунта / неоднозначный исход | **active** | `done` / `live`/`paused` + срочная заметка |
| активация | `setCampaignStatus` упал | **active** | `done` / `paused` |
| всё успешно | — | **active** (+ id, `ad_count`, name) | `done` / `live` (или `paused`) |

Смысл: **4xx до появления кампании** освобождает ключ (это ёмкость пула, а не история). **После
появления кампании** ключ становится retired, чтобы доход оставался атрибутируемым, а кампания
остаётся PAUSED-оболочкой без показов. Неоднозначный исход **никогда** не отправляется повторно.
Ошибки самого реестра (release или backfill) не прерывают волну: они дописываются в текст строки
(`· registry: …`), и строка всегда получает финальный статус. Зависшая строка провоцирует повторный
запуск, а он создаст вторую кампанию.

Заметки в строке: до 3 пропущенных креативов расписаны полностью (остальные «+N more»), каждая
≤140 символов. Срочные заметки (неоднозначный исход, список обрезан) идут **первыми**, чтобы не
потеряться при обрезке поля `error` до 1000 символов.

---

## 11. Реестр партнёрских ключей

`lib/snap-keys.ts`, только сервер, без импортов, свой клиент Strapi с таймаутом 8 с (реестр должен
отказывать быстро и никогда не вешать запуск).

- **Хранилище**: коллекция Strapi `app-cache` (`/api/app-caches`), **одна строка = один занятый ключ**:
  `ckey = "snap-key:<ключ>"` (`SNAP_KEY_CKEY_PREFIX`), `cvalue = SnapKeyBinding`.
  Свободный ключ = для него нет строки. Общий `lib/app-cache.ts` здесь **не** используется: запросы
  идут в тот же эндпоинт, но через отдельный клиент.
- **`SnapKeyBinding`**: `key`, `status` (`active` | `retired`), `user`, `claimed_at`, `campaign_id?`,
  `adsquad_id?`, `ad_id?` (первый ad), `ad_count?`, `ad_account?`, `niche?`, `landing?`, `name?`,
  `notes?`, `task_id?`, `clone_of?` (id кампании-источника у клона).
  - `active`: кампания работает на этом ключе;
  - `retired`: кампания создана, но запуск упал после неё; ключ держится ради атрибуции, освобождает
    его owner вручную.
- **Пул**: `POOL_MAX = 500` в `snap-keys.ts` и **его близнец** `SNAP_KEY_POOL_MAX = 500` в
  `snap-launch.ts`. Кодек ключа (`keyCode`/`keyIndex` ↔ `snapKeyCode`/`snapKeyIndex`) тоже
  продублирован. Причина: модули без импортов, чтобы работал `node --test`. **Менять оба сразу.**
- **Чтение**: `listSnapKeys()` читает страницы по 100 (у Strapi Cloud это максимум), всего
  `LIST_PAGES = ceil(500/100) + 1 = 6` страниц. Ошибка страницы → исключение: частичный реестр не
  должен выдавать себя за полный. (Раньше лимит был 2 страницы, и ключи с 201-го не были видны.)
- **`claimSnapKey(desired, meta)`**:
  1. `listSnapKeys()`; если чтение упало, считаем `used = []`: настоящая защита — уникальность `ckey`.
  2. Кандидаты: `desired` (если это ключ пула), затем по порядку дальше **с переходом через конец**
     (`glo-snp_500` → `glo-snp_001`). Кандидатов нет → «snap key pool exhausted — no free key glo-snp_001…500».
  3. Для каждого `POST`: `ok` → `wonClaim` перечитывает строки этого ckey от старых к новым, и наша
     должна быть **самой старой** (у Strapi есть окно TOCTOU на уникальность). Проиграли гонку →
     удаляем свой дубль и идём дальше. `400` = ключ занят → следующий. Любой другой статус → исключение.
- **`backfillSnapKey(key, patch, claim?)`**: `PUT` склеенного `cvalue` **без `ckey`** (повторная
  отправка уникального поля ломает проверку Strapi). С 01.10 pump передаёт **сам захват**:
  `claimSnapKey` возвращает `{key, documentId, binding}`, и строка пишется по `documentId` поверх
  записанного `binding`, без поиска по ключу. Поиск сразу после захвата мог не увидеть свежую строку
  из-за задержки чтения Strapi (22.09, `glo-snp_099`). Без захвата — как раньше: `findSnapKey` →
  `PUT`. Нет строки или PUT не прошёл → исключение.
- **`releaseSnapKey(documentId)`** / **`releaseSnapKeyByKey(key)`** — `DELETE` строки.
- **Ни одна ошибка не глотается**: pump пишет её в строку задачи, роут отвечает 502.
  «Unknown» никогда не выдаётся за «free».

`GET /api/snap/keys` → `{ok, poolMax, used:[строки + documentId], free:[…], next}`. Работает **без**
Snap-кредов, потому что реестр наш. `DELETE /api/snap/keys?key=glo-snp_NNN` доступен **только owner'у**
(`isOwnerSession`), удаляет **только строку реестра** и Snapchat не трогает.

---

## 12. Таск-менеджер (Snap tasks)

- Строки лежат в общей коллекции Strapi **`launch-task`** с `partner = "sn"`. MO-читатель
  `/api/launch-tasks` исключает `sn`, а `/api/snap-tasks` берёт только `sn`.
- Snap-данные лежат в **переиспользованных колонках** (`TASK_FIELDS` в `lib/task-store.ts`):

  | Колонка | Что в ней |
  |---|---|
  | `gcm` | ключ партнёра `glo-snp_NNN` |
  | `campaign_id` | id кампании |
  | `adset_id` | id **ad squad** |
  | `ad_id` | id **первого** ad |
  | `link` | финальная ссылка с utm |
  | `bid` | тег для монитора, например `auto · Android · 5 creatives` (≤40) |
  | `error` | заметки (≤1000) |
  | `name`, `geo`, `budget`, `status`, `stage`, `queued_at`, `started_at`, `finished_at` | как у всех рельс |
  | `owner` | ставит **сервер** из сессии, никогда не берётся из тела запроса |

  > Новый атрибут в Strapi нужно **сначала** объявить колонкой, иначе каждое сохранение задачи
  > получит 400. Так уже случалось с `ad_id`.
- **`status`**: `queued | running | done | error | interrupted`. **`stage`**: значения из `SNAP_PUMP_STAGES`.
- **Id строки**: `snl-<wave>-NN` у запуска, `snc-<wave>-NN` у клона (`snapShotTaskId(…, "clone")`).
  Тег клона начинается с `clone · `.
- **`GET /api/snap-tasks`**: вся команда, последние **7 дней**, фильтр
  `partner=sn & owner notNull & queued_at >= cutoff`, `pageSize 100`, до 3 страниц. На инстансе ответ
  кэшируется на 4 с, и при сбое Strapi отдаётся последний удачный список (кэшируется только
  **полное** чтение).
- **`POST`**: upsert 1…25 задач, пачками по 8; `partner` принудительно `sn`. **Защита от зомби**:
  запись ошибки для строки, которую удалил админ, пропускается; `done` финален. Pump пишет строки
  **напрямую** (`taskWriter` → `upsertTaskRow`), а `POST` использует браузер для своих сохранений.
- **`DELETE ?taskIds=`**: только свои строки. Дровер сам ничего не удаляет, ошибки остаются записью
  для команды.
- **UI** (`components/snap-task-manager.tsx`): опрос каждые 6 с при открытом дровере и 20 с при
  закрытом; перечитывает на focus и visibility; опрашивает только видимую вкладку. Свои строки в
  `running` старше **3 ч** помечает `interrupted` («Still not finished after 3 h — check Ads Manager
  and the key registry»). Статусы: Active / Done / Failed, фильтр «Mine». В строке: ключ,
  geo · budget · тег, стадия по-человечески («Claiming a partner key…», «Creating the campaign (paused)…»,
  «Live on Snapchat · glo-snp_012», «Check Ads Manager»), кнопки копирования id campaign / squad / ad
  и ссылки. **Прямых ссылок в Ads Manager нет.** Повторного запуска из дровера тоже нет: запуск
  exactly-once, новый делается с доски. У собранной строки с `campaign_id` есть кнопка **Clone** →
  `/snap/clone?ids=<campaign_id>`.

---

## 13. Страница Keys · report: доход LION и расход Snapchat

`/snap/keys` (`components/snap-keys-board.tsx`) делает три **независимых** загрузки: реестр
(`useSnapKeys`), отчёт (`/api/snap/report`) и Snap-сторону (`/api/snap/stats`). Если одна упала,
остальные остаются на экране.

### Доход (LION)

- `lionSnapReport(date)` → `GET /api/high-adx-cluster-utms/snapchat-report/?date=…` через `lionGet`
  (`lib/lion.ts`, 60 с, один ретрай на 5xx). Гейт — `lionTokenConfigured()` (нужен только
  `LION_TOKEN`, `LION_ACR` не нужен).
- Ответ: `{date, affiliate, utm_prefix:"glo-snp_", totals:{…}, campaigns:[{utm_campaign, revenue,
  forecasted_revenue, impressions, ecpm, triggered, fired, visitors, conversions}]}`.
  `parseSnapReport` никогда не бросает: мусор превращается в нули.
- **Дни по São Paulo**: `today` неполный (с прогнозом), день становится окончательным на следующее утро.
  До 06:00 São Paulo страница открывается на «yesterday» (`snapDefaultReportDay`).
  `SNAP_REPORT_FIRST_DAY = "2026-09-16"` (раньше рельса не работала), диапазон ≤ `SNAP_REPORT_MAX_DAYS = 31`.
- **Кэш** (`lib/lion-snap.ts`, в памяти инстанса): закрытый день с данными — 6 ч; today и yesterday — 10 мин;
  нулевой ответ за незакрытый день — 60 с (чтобы сбой LION с нулями не спрятал доход). Диапазон
  читается по 4 дня параллельно, по 20 с на день, новые дни не стартуют после 35 с; каждый день best-effort.
- **Склейка** (`mergeSnapReports`): один день отдаётся как прислал LION; несколько дней суммируются, а
  eCPM **пересчитывается** из сумм. Непрочитанный день идёт в `missingDays` и **никогда не считается нулём**.
- `GET /api/snap/report` отдаёт **строку на каждый из 500 ключей** (занятый или свободный) с
  `metrics`, `binding` и `revenueBeforeClaim`. Реестр здесь best-effort: если он упал, деньги всё равно
  показываются, а в ответе будет `registryError`.

### Расход (Snapchat)

- `GET /adaccounts/{id}/stats?granularity=TOTAL&breakdown=campaign&start_time&end_time&fields=impressions,swipes,spend`.
  **`spend` приходит в micro** (÷1 000 000).
- **Почему TOTAL, а не DAY**: для DAY Snap требует полночь самого аккаунта (Лос-Анджелес), иначе E1008.
  Наш день идёт по São Paulo, поэтому окно `[полночь SP, следующая полночь SP)` запрашивается как TOTAL
  (`snapRangeWindow`), и обе половины таблицы покрывают одни и те же 24 часа. По этой же причине
  **нет полосы расхода по дням**: разбить расход по дням São Paulo честно нельзя.
- Статусы кампаний (`/campaigns`) и модерация ad (`/ads` → `review_status`) превращаются в фразу
  `snapDeliveryNote`: «2/8 ads live, 6 rejected», «in review: 3 pending», «campaign not found on Snapchat»,
  «learning».
- `GET /api/snap/stats`: читает до 3 аккаунтов одновременно (`ACCOUNT_CONCURRENCY`), новые не
  стартуют после 20 с; чтения live-данных — одна попытка, 12 с, кэш 5 мин, потому что они делят лимит
  токена (~10 rps) с pump. Здесь реестр **не** best-effort: без привязок нечего соединять, поэтому
  при его сбое 502.

### Таблица и P/L

- Колонки: Key · Status · Campaign · Buyer | **Snapchat**: Spend · Impr. · Swipes | **Partner · LION**:
  Revenue · P/L · Ad impr. · eCPM · Visitors · Trig/Fired · Conv. | Release.
- **P/L = revenue − revenueBeforeClaim − spend**. Считается по **подтверждённому** доходу, прогноз
  показывается рядом и в прибыль не входит. Если ключ освободили и снова заняли внутри диапазона, доход
  прежнего держателя вычитается (`snapRevenueBefore`, сноска `*`).
- Расход соединяется с доходом **только** при совпадающем окне (`from/to`), чтобы не смешать расход
  одного дня с доходом другого.
- Выбор дат: пресеты из `lib/date-range.ts`, выбор хранится в URL (`?range=last7` / `?from&to`),
  горячие клавиши `[` `]` `D` `T` `Y` (читаются по `event.code`, так что работают на русской и
  украинской раскладке).
- Фильтры all / free / active / retired, кнопка «Copy free keys». **Release** доступен только owner'у,
  перед удалением `confirm` напоминает, что удаляется лишь строка реестра. У каждого ключа с
  кампанией есть кнопка **Clone** → `/snap/clone?keys=<ключ>` (для всех, не только owner).

---

## 14. Клиент Snapchat Marketing API

`lib/snap-api.ts`, только сервер. Runtime-импортов нет, только `import type`, поэтому тесты подменяют
`globalThis.fetch`.

- **Хосты** (переопределяются env, например для мока): ads `https://adsapi.snapchat.com/v1`,
  OAuth `https://accounts.snapchat.com`, Business (Public Profiles) `https://businessapi.snapchat.com/v1`.
- **Токен**: `snapAccessToken()` — `POST {AUTH_BASE}/login/oauth2/access_token` с grant
  `refresh_token` (`SNAP_CLIENT_ID/SECRET/REFRESH_TOKEN`, scope `snapchat-marketing-api`). Токен
  кэшируется до `expires_in − 60 с`, одновременные запросы ждут один промис. Три разных вида отказа:
  сеть → **502** («OAuth unreachable»); 400/401/`invalid_grant`/`invalid_client` → **401** («refresh token
  rejected», нужен повторный consent); остальное → свой статус.
- **`snapFetch(url, init, attempts=2, timeout=60 с)`**:
  - чтения: 1 ретрай на 5xx или сеть через 1,5 с;
  - **создание и изменение: `attempts=1`, всегда.** Неоднозначный исход не повторяется;
  - 4xx отдаётся как есть: в теле фраза Snap, что делать;
  - **HTTP 2xx с `request_status:"ERROR"` — тоже ошибка** (400);
  - 401 от ads- или business-хоста сбрасывает кэш токена, и следующий запрос получит новый.
- **Batch-обёртка**: каждая запись оборачивается как `{campaigns:[…]}` → ответ
  `{request_status, campaigns:[{sub_request_status, campaign}]}`. `snapBatchItem` достаёт единственный
  элемент; `sub_request_status ≠ SUCCESS` → 400 с фразой Snap. `snapErrorMessage` берёт
  `display_message`, затем `debug_message`, затем **`sub_request_error_reason`** элемента (иначе отказ
  ad squad читался бы как голое «HTTP 400»).
- **Эндпоинты**:

  | Функция | Запрос |
  |---|---|
  | `snapAdAccounts` | `GET /me/organizations?with_ad_accounts=true` |
  | `snapPixels` | `GET /adaccounts/{id}/pixels` |
  | `snapProfiles` | `GET {BUSINESS}/organizations/{org}/public_profiles` |
  | `snapCreateMedia` / `snapUploadMedia` / `snapMediaReady` | `POST /adaccounts/{id}/media` · `POST /media/{id}/upload` (multipart `file`) · `GET /media/{id}` (`media_status == READY`) |
  | `snapCreateCampaign` | `POST /adaccounts/{id}/campaigns` |
  | `snapCreateAdSquad` | `POST /campaigns/{id}/adsquads` |
  | `snapCreateCreative` | `POST /adaccounts/{id}/creatives` |
  | `snapCreateAd` | `POST /adsquads/{id}/ads` |
  | `snapSetCampaignStatus` | `GET /campaigns/{id}` → `PUT /adaccounts/{ad_account_id}/campaigns` (весь объект) |
  | `snapAccountStatsRaw` / `…CampaignsRaw` / `…AdsRaw` | stats (TOTAL) / campaigns / ads для `/snap/keys`, по `paging.next_link`, ≤5 страниц |

- **Кэши** (обычные `Map` в памяти инстанса, **не** общие между serverless-инстансами): каталог 10 мин,
  **пустой** список 60 с; live-чтения 5 мин.
- **`snapFetchBytes`** скачивает креатив из публичного Blob: при `Content-Length` > лимита отказывает
  сразу, иначе читает поток со счётчиком и обрывает соединение, как только лимит превышен. Без этого
  нехватка памяти убила бы всю функцию `after()` и подвесила остаток волны.

---

## 15. Доступ и флаг включения

### Флаг

- `SNAP_ENABLED = process.env.NEXT_PUBLIC_SNAP_ENABLED === "1"` (`lib/partners.ts`) вшивается **при
  сборке**; на сервере то же env читает `snapRailEnabled()` (`lib/snap-api.ts`).
- Флаг выключен: в шапке серая «Snapchat — in development», `/snap` и `/snap/keys` уходят на `/`,
  **все** `/api/snap/*` и `/api/snap-tasks` отвечают `404 snap_rail_disabled`, таск-менеджер ничего не
  запрашивает.
- **Включить или выключить на проде** = env на Vercel + **редеплой**. Env без редеплоя включает
  серверные роуты, а UI остаётся спящим. Такая рассинхронизация уже приводила к живому запуску по
  ошибке на Google-рельсе.

### Кто что может

| Точка | Нужна сессия | Только owner | Дополнительно |
|---|---|---|---|
| страницы `/snap`, `/snap/keys` | да (иначе `/login`) | нет | — |
| `GET /api/snap/accounts` | да | нет | Snap-креды, иначе 500 |
| `POST /api/snap/launch` | да | нет | Snap-креды + хранилище задач |
| `GET /api/snap/keys` | да | нет | Snap-креды не нужны |
| `DELETE /api/snap/keys?key=` | да | **да** (403 `owner_only`) | — |
| `GET /api/snap/report` | да | нет | `LION_TOKEN` |
| `GET /api/snap/stats` | да | нет | Snap-креды |
| `GET /api/snap/oauth/start`, `/callback` | да | **да** | `SNAP_CLIENT_ID/SECRET` |
| `/api/snap-tasks` | да | нет (`DELETE` — только свои строки) | — |

Owner определяет `isOwnerSession` (`lib/roles.ts`): роль из `ADL_OWNER_ROLES` (по умолчанию
`owner,admin`) или имя из `ADL_OWNER_USERS`. Сессия — HMAC-cookie `adl_session` на `AUTH_SECRET`
(≥32 символов, иначе сессии выключены).

---

## 16. Переменные окружения

Здесь только имена. Значения лежат в `.env.local` и на Vercel.

| Переменная | Обязательна | Назначение |
|---|---|---|
| `NEXT_PUBLIC_SNAP_ENABLED` | да (`1`) | Флаг рельсы, вшивается при сборке. |
| `SNAP_CLIENT_ID`, `SNAP_CLIENT_SECRET` | да | OAuth-приложение Marketing API. |
| `SNAP_REFRESH_TOKEN` | да | Получается через `/api/snap/oauth/*` (§17). |
| `SNAP_PROFILE_ID` | фактически да | Public Profile по умолчанию; без него и без выбора запуск невозможен. |
| `SNAP_PROFILE_NAME` | нет | Подпись подставленного профиля, если Business API не отдал список. |
| `SNAP_AD_ACCOUNT_ID`, `SNAP_PIXEL_ID`, `SNAP_BRAND_NAME` | нет | Дефолты карточки. `SNAP_BRAND_NAME` подставляется и на сервере при пустом brand. |
| `SNAP_ORGANIZATION_ID` | нет | Организация для списка профилей (иначе берётся организация первого аккаунта). |
| `SNAP_API_BASE`, `SNAP_AUTH_BASE`, `SNAP_BUSINESS_API_BASE` | нет | Переопределение хостов (мок). На проде **не задавать**. |
| `SNAP_OAUTH_REDIRECT_URI` | нет | Явный callback, если origin функции на проде отличается. |
| `SNAP_ALLOW_LOOPBACK_MEDIA` | нет | `1` только для локального `next start` с моком. **Никогда на Vercel.** |
| `STRAPI_API_URL`, `STRAPI_TOKEN` | да | Задачи и реестр. Токену нужен DELETE на `app-cache` (Release). |
| `LION_TOKEN` (+ `LION_BASE`, необязателен) | для отчёта | Доход по ключам. |
| `AUTH_SECRET`, `ADL_OWNER_ROLES`, `ADL_OWNER_USERS` | общие | Сессии, подпись OAuth-state, owner. |

Токен CAPI (для партнёра) в коде лаунчера не используется, он нужен только скриптам в `_e2e/`.

---

## 17. Первичная настройка и ротация refresh-токена

Уже сделано 17.09. Порядок нужен, если придётся повторить (подробно в `_e2e/README-snap.md` §1):

1. Snapchat Business + USD-аккаунт в организации.
2. **Public Profile** организации → `SNAP_PROFILE_ID`.
3. **Snap Pixel** на аккаунте → `SNAP_PIXEL_ID`.
4. **OAuth-приложение** Marketing API (Business Details → OAuth Apps). Redirect URI:
   `http://localhost:3124/api/snap/oauth/callback` локально и
   `https://adlauncher.gcamazingtool.xyz/api/snap/oauth/callback` на проде → `SNAP_CLIENT_ID/SECRET`.
5. **Refresh-токен**: owner'ом (при включённом флаге) открыть `/api/snap/oauth/start` → consent в
   Snapchat → callback **один раз** показывает `SNAP_REFRESH_TOKEN=…`. Сохранить в env и
   перезапустить или передеплоить. Токен нигде не сохраняется, хранилища токенов у этой рельсы нет:
   аккаунт один. Это же **единственный способ ротации**.
   - `start` ставит подписанную cookie `snap_oauth_state` (HMAC на `AUTH_SECRET`, 10 мин);
     `callback` сверяет её за постоянное время и после любого ответа удаляет.
6. Партнёру: CAPI-токен (Business Details → OAuth Apps → Conversions API Tokens) + pixel id.
   Токен работает только как query-параметр `?access_token=`, в виде `Bearer` он даёт 401.
7. В Ads Manager **не включать** авто-URL-параметры.

---

## 18. Тесты и локальная проверка

### Юнит-тесты (чистые модули, без сети)

```
node --test tests/snap-partner.test.ts
node --test tests/snap-launch.test.ts
node --test tests/snap-report.test.ts
node --test tests/snap-pump-core.test.ts
node --test tests/snap-api.test.ts
node --test tests/snap-keys.test.ts
node --test tests/snap-stats.test.ts
node --test tests/snap-source.test.ts
node --test tests/snap-clone.test.ts
```
Нужен Node 24: он выполняет `.ts` через встроенное удаление типов. Этот режим работает, только если
в модулях нет импортов. Отсюда правило «без импортов» и константы-близнецы. `npm test` в
`package.json` нет, тесты запускаются так. Перед коммитом также `npx tsc --noEmit` и `npx eslint`.

### Smoke роутов (приложение + мок Snapchat; Strapi и LION настоящие)

```
node _e2e/_snap_mock.mjs                                   # мок Snapchat на :3198
SNAP_ORGANIZATION_ID=org-mock-1 npx next dev -p 3124       # env мока: SNAP_*_BASE → 127.0.0.1:3198
node _e2e/_adl_snap_smoke.mts
```
- Мок (`_snap_mock.mjs`) изображает OAuth, ads- и business-хосты: batch-обёртки, медиа
  PENDING→READY, PUT всего объекта. Сбои вызываются маркерами в имени или headline: `FAIL-ADSQUAD` (400),
  `FAIL-NET` (обрыв сокета = неоднозначный исход), `FAIL-CREATIVE` (400). Служебные ручки:
  `GET /__mock/state`, `POST /__mock/reset`.
- Smoke проверяет каталог, реестр, весь набор отказов, счастливую волну (2 копии → одна заливка,
  2 кампании PAUSED→ACTIVE, 2 разных ключа), повтор (`alreadyAccepted`), start paused + Sales + LPV,
  4xx после кампании (ключ retired), обрыв сети (interrupted), мульти-креатив и частичный отказ.
- ⚠️ Smoke **берёт настоящие ключи** из общего реестра и в конце их освобождает. Если он упал на
  полпути, `_e2e/_snap_smoke_last.json` перечисляет, что убрать руками
  (`DELETE /api/snap/keys?key=`, `DELETE /api/snap-tasks?taskIds=`).
- `SNAP_ORGANIZATION_ID=org-mock-1` нужен, потому что в `.env.local` с 17.09 записана настоящая
  организация, и мок иначе ответит «organization not found».
- Вариант с прод-сборкой: `npx next build && npx next start -p 3124` плюс `SNAP_ALLOW_LOOPBACK_MEDIA=1`.
- **Клонер:** `node _e2e/_adl_snap_clone_smoke.mts` (тот же мок и dev-сервер). Запускает источник на
  моке, читает его по id и по ключу, клонирует на тот же аккаунт (ни одной загрузки) и на другой
  (по одной перезаливке на файл, тип `video/mp4`), проверяет `snc-`, тег, `CLONE_FROM`, `clone_of`,
  ответ на удалённый источник. В конце освобождает **свои** ключи по task_id. Мок с 01.10 отдаёт
  чтения клонера, создаёт все сущности с UUID-id и отдаёт `download_link` с
  `Content-Type: multipart/form-data`, как хранилище Snap.
- Для ручной проверки доски на моке: `node _e2e/_snap_clone_ui_seed.mts seed` (источник),
  `/snap/clone?keys=<ключ>` через `_adl_session_proxy.mts`, затем `… cleanup`.

### UI-проверки (headless Chrome через глобальный playwright)

```
node _e2e/_adl_session_proxy.mts        # :3125 → :3124 с e2e-сессией owner'а
node _e2e/_adl_snap_ui_multi.mjs        # 5 креативов на одной карточке → 1 кампания, 5 ads
node _e2e/_adl_snap_objective_ui.mjs    # селект Objective / Goal
node _e2e/_adl_snap_ui_dates.mjs        # выбор дат на /snap/keys
```

### Первая живая проверка без создания кампаний

Убрать `SNAP_*_BASE`, открыть `/snap`: пикеры должны показать настоящие аккаунты, пиксели и профиль.
Открыть `/snap/keys`: 500 ключей и отчёт LION.

---

## 19. Эксплуатация: частые ситуации

| Ситуация | Что происходит | Что делать |
|---|---|---|
| «snap key pool exhausted» / Launch заблокирован из-за ключей | Байеры удаляют кампании в Ads Manager, а строки реестра остаются. | `node _e2e/_snap_keys_reconcile.mjs` (только чтение: вердикты LIVE / DELETED / UNKNOWN / NO_CAMPAIGN_ID) → `node _e2e/_snap_keys_release.mjs --dry` → без `--dry`. Освобождаются **только** DELETED; снимок сверки должен быть младше 6 ч, перед удалением каждая строка перечитывается. 22.09 так освободили 46 ключей. |
| Строка `interrupted` | 5xx или сеть на запросе, который что-то создаёт. Сущность **могла** создаться. | Проверить в Ads Manager по имени и ключу. Кнопку Launch повторно **не** нажимать вслепую. Ключ уже retired. |
| Строка `error` на `adsquad` / `creative` / `ad` | Snap отказал после создания кампании, осталась PAUSED-оболочка. | Прочитать фразу Snap в строке, исправить карточку, запустить заново (возьмётся новый ключ). Оболочку удалить в Ads Manager, затем owner нажимает Release старого ключа. |
| `done` / `paused` с «activation failed» | Цепочка есть, активация не прошла. | Включить кампанию в Ads Manager. |
| `done` / `live`, но показов нет | Модерация Snap идёт **после** создания: ads могут быть в review или rejected. | Смотреть фразу доставки на `/snap/keys` («6 rejected»). Массовые отказы по креативам — риск бана всей организации (все 10 аккаунтов и пиксель в одной). |
| E3017 на `PIXEL_PURCHASE` | Свежий пиксель без Purchase-событий Snap не допускает к цели. | С 17.09 события идут. Если пиксель новый, запускать на Landing page view. |
| Строка висит `running` | Функцию убили или хранилище недоступно. Через 3 ч дровер сам пометит её `interrupted`. | Сверить с Ads Manager и реестром. |
| Нужно удалить кампании с неправильной целью | — | `_e2e/_snap_goal_purge.mjs --dry` → живой прогон: удаляет кампании, у которых цель ad squad не PIXEL_PURCHASE / LPV. |
| Нужен полный снимок живых аккаунтов | — | `_e2e/_snap_live_status.mjs` (только чтение, игнорирует `SNAP_*_BASE`). |

Прочие скрипты в `_e2e/`: `_snap_capi_validate.mjs` (одно событие в CAPI VALIDATE, ничего не
записывается), `_snap_os_probe.mjs` (словарь `os_type`), `_snap_purchase_value_probe.mjs` (есть ли
value в Purchase), `_snap_range_probe.mjs` (многодневное окно TOTAL = сумма дней).

Семантика GET удалённой кампании у Snap (важна для сверки): удалена → 400 «not available» (или 404);
никогда не существовала → 404 «cannot be found»; кривой запрос → 400 «cannot be correctly processed».
DELETED ставится только на 404 или 400-not-available, всё остальное UNKNOWN и не освобождается.

---

## 20. Ловушки и техдолг

1. **Повторный Launch после успеха создаёт дубли.** После `ok` карточки остаются «ready», а
   `waveRef` обнулён. Если нажать Generate preview → Launch ещё раз, уйдёт **новая** волна с новыми
   ключами и новыми кампаниями. Owner решил оставить как есть. Возможная правка: не считать карточку
   в state `ok` готовой, пока её не изменили.
2. ~~`backfillSnapKey` ищет строку по ключу~~ — исправлено 01.10: pump передаёт захват, строка
   пишется по `documentId` (§11).
3. ~~Устаревшие тексты про «100 ключей»~~ — исправлено 01.10 (`snap-nav.tsx`, `use-snap.ts`).
4. **Устаревшие комментарии «dormant, только .env.local»** в `lib/partners.ts` и
   `_e2e/README-snap.md`. На проде рельса включена с 17.09.
5. **Дизайн-спека** (`docs/superpowers/specs/2026-09-16-snapchat-rail-design.md`) в основной части
   описывает v1 (SWIPES, один креатив, пресеты ниш). С кодом совпадает только addendum от 24.09.
6. **Objective Sales на настоящем Snap ни разу не проверен живым запуском.** Он проверен на моке;
   путь «ничего не отправлять» (Awareness) проверен на 74 из 74 живых кампаний. 74 кампании до 23.09
   так и показывают «Awareness».
7. **Кэши в памяти инстанса** (токен, каталог, live-статистика, отчёт LION) не общие между
   serverless-инстансами. Два инстанса могут показывать немного разные данные в пределах TTL.
8. **Близнецы**: `SNAP_KEY_POOL_MAX` ↔ `POOL_MAX`, `snapKeyCode`/`snapKeyIndex` ↔ `keyCode`/`keyIndex`,
   `parseDecimal` ↔ `lib/google-bid.ts`. При изменении правится пара. Если пул снова вырастет, нужно
   проверить `LIST_PAGES` и жёсткий цикл на 6 страниц в скриптах `_e2e`.
9. **`_e2e/` нет в git.** Мок, smoke и операционные скрипты есть только в локальной папке owner'а.
10. **Клонер переносит одну структуру лаунчера**: один ad squad, WEB_VIEW-креативы, страны / min age /
    устройства. Всё остальное заменяется дефолтом с заметкой (§1.3). На другой аккаунт креатив едет
    перезаливкой (≤32 МБ); `media_copy` у Snap есть, но не используется.
11. **Превью видео на доске клонера** грузит файл прямо из хранилища Snap. Во вкладке, которая не
    видна (фон, автоматизация), браузер откладывает загрузку медиа, и это не ошибка.

---

## 21. История решений

| Дата | Решение | Почему |
|---|---|---|
| 16.09 | Рельса собрана «спящей» по докам и моку: v1 = один креатив, ниши-пресеты. | Аккаунта Snapchat ещё не было. |
| 17.09 | Аккаунт, OAuth, refresh-токен, Public Profile заведены; **включено на проде**. Первые запуски. Self Service скрыт. | E3017 на свежем пикселе → цель временно SWIPES. CAPI-токен заработал в тот же день. |
| 18.09 | **Мульти-креатив**: любое число файлов → одна кампания / один ad squad / N ads; плохой файл пропускается. Зона креативов — 9:16. | Просьба owner'а. |
| 19–20.09 | На `/snap/keys` добавлены сторона Snapchat (`/api/snap/stats`) и свой выбор дат (диапазоны). | Видеть расход рядом с доходом. |
| 21.09 | **Android only** по умолчанию (переключатель Devices). | Просьба партнёра: «browser killer» работает на Android. |
| 22.09 | Лендинг — **вставленный URL**, как на FB (пресеты azmvhs убраны, ниша из пути). Расписание по Киеву **сделано и в тот же день убрано**. | Расписание Snap требует lifetime-бюджет и работает по часам зрителя; owner попросил обычный 24/7 daily. |
| 23.09 | Цели — **только Pixel purchase / Landing page view** (6 SWIPES-кампаний удалены). Пул **100 → 500**. Objective на проводе: несколько подходов за день. | Байер клонировал в Ads Manager и под «Awareness» не нашёл Purchase/LPV. |
| 24.09 | **Селект Objective**: Awareness & Engagement (по умолчанию, ничего не отправляется) / Sales (отправляется). Текущее состояние. | Owner: «как раньше», но с выбором. |
| 29.09 | Вернули **2 прямые статьи** партнёра кнопками Direct рядом с полем вставки (`211f4f1`). | Просьба owner'а: запуски «по директу». |
| 01.10 | **Клонер `/snap/clone`** по образцу Google/TikTok: ссылка `ids` / `keys`, чтение источника из Snapchat, черновик с заметками, reuse медиа на своём аккаунте и перезаливка на чужом, `CLONE_FROM`, `clone_of`, кнопки Clone в дровере и на Keys. Попутно: backfill реестра по захвату, тексты «500 ключей». | Owner: «реализуй клонер полноценно по снепчату так как у нас клонеры сделаны другие». |

Сведения о расписании Snap (на случай, если его вернут): поле называется `hour_of_day` (E1001 на
`hours_of_day`), нужен lifetime-бюджет (E2764), существующий daily ad squad нельзя перевести в lifetime
(E2759), минимум кампании с расписанием $20/день.

---

## 22. Как вносить изменения

- **Правило запуска** (новое поле, лимит, словарь, отказ) правится только в `lib/snap-launch.ts`
  (+ `tests/snap-launch.test.ts`). Карточка и сервер подхватят его сами. Новое поле shot'а нужно
  провести через `SnapLaunchShotIn` → `buildSnapShot` (карточка) → `cleanShot` (`snap-wave.ts`) →
  `snapLaunchWire`.
- **Модули без импортов** (`snap-launch`, `snap-pump-core`, `snap-report`, `snap-stats`, `snap-api`,
  `snap-keys`) должны остаться без runtime-импортов, иначе `node --test` перестанет их загружать.
  Разрешён только `import type`.
- **Любой пишущий запрос в Snap** выполняется с `attempts=1`. Неоднозначный исход означает
  `interrupted` и retired-ключ, а не ретрай.
- **Порядок «кампания PAUSED → всё остальное → activate»** не менять: он гарантирует, что
  недостроенная цепочка не тратит деньги.
- **Новая колонка задачи**: сначала атрибут в Strapi `launch-task` и в `TASK_FIELDS`, потом запись.
- **Не делать тонкую async-обёртку** над `findTaskRow` и подобными функциями
  (`return impl(...)`): Turbopack в Next 16 однажды свернул такое на этапе сборки, и все создания задач
  на 16 часов превратились в PUT.
- **Включение на проде** — только по слову owner'а и всегда с редеплоем.
- Перед пушем: все `node --test tests/snap-*.test.ts`, `npx tsc --noEmit`, `npx eslint`, по
  возможности smoke на моке. Деплой — push в `main`, Vercel собирает автоматически.

---

## 23. Глоссарий

- **Рельса (rail)**: канал запуска в Ad Launcher'е (FB, TikTok, Google, Snapchat…).
- **Карточка (card)**: одна настройка кампании на доске `/snap`. Из неё получается N shot'ов (Copies).
- **Shot**: одна будущая кампания в теле `POST /api/snap/launch` (`SnapLaunchShotIn`).
  Один shot = одна кампания = один ключ.
- **Волна (wave)**: все shot'ы одного нажатия Launch (`waveId`, ≤45 shot'ов).
- **Pump**: серверная функция в `after()`, которая строит кампании волны.
- **Ключ (key)**: партнёрская метка `glo-snp_NNN` в `utm_campaign`; по ней LION считает доход.
- **Реестр (registry)**: строки `snap-key:<ключ>` в Strapi `app-cache`: кто держит ключ и под какой
  кампанией.
- **active / retired**: ключ под работающей кампанией / под упавшим запуском, где кампания уже создана.
- **Launch bay**: правая панель доски (готовность, ключи, суммы, Preview, Launch).
- **LION**: наш источник отчётов; для Snap — endpoint `high-adx-cluster-utms/snapchat-report`.
- **ScCid**: click id, который Snapchat сам дописывает к URL лендинга.
- **Public Profile**: профиль бренда в Snapchat, обязателен на каждом ad.
- **E3017 / E1008**: коды Snap: «ad squad ineligible for goal» / неверное окно статистики.
