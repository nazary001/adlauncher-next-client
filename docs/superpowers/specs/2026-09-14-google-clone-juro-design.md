# Google Ads rail — launch, clone + JURO through LION's google-weapon API

**Date:** 2026-09-14 · **Status:** built locally + LIVE-VERIFIED (clone 24250092416, JURO 24255719644, launch 24244540707 — all born, then PAUSED), NOT deployed (owner call: prod push on command)

The first non-Facebook platform in the console. The header's "Google" platform tab becomes a real
navigation target (`/google`) opening a Google clone board that launches **clones** and **JURO
copies** of existing Google Ads (Demand Gen) campaigns through the partner's
`https://google-weapon.highstakes.tech/api/external/*` API — the same bearer as LION
(`LION_TOKEN`), plus **fresh launches** (Demand Gen from scratch, `/campaign/launch/`) — the third
mode, added the same day after the owner asked why the launcher was missing.

## Partner contract (probed live 2026-09-14)

- Host `google-weapon.highstakes.tech`, `Authorization: Bearer <LION_TOKEN>`, **every path ends
  with `/`** (a POST without it is a plain 404 `{"error":"not found (note: all paths end with a
  trailing slash)"}`). Errors are `{ "error": "<sentence>", …extras }`; 401 `invalid api key`.
- `GET /customers/` → 39 accounts for our user: MCC 2678500976 = 10× `GLO-HS-00N` (BRL, 3 pixels
  each) + 10× `GC-HS-Lion-BR-N` (USD, **0 pixels**); MCC 4904785717 = `Ads N` / `GC-Vis-N` /
  `GC - AMZN - 1` (USD/EUR, 1–2 pixels). `customer_id` == LION metrics `account_id`.
- `POST /dataset/fetch/ {campaign_id}` → `200 {cached:true, fetched_at}` | `202 {status:"fetching"}`
  | `404 {"error":"campaign not found"}` (LION never saw it) | `400` (MCC without credentials).
  Probed: a not-cached source went 202 → `ready:true` within 10 s. Cache is per campaign.
- `GET /dataset/status/?campaign_id=` → `{ready:false}` for ANY unknown id (200) — never an error.
- `POST /clone/launch/` / `POST /juro/launch/` → `201 {ok:true,status:"pending",taskId}`. Validation
  order: `source_campaign_id` required → dataset presence (`404 {"error":"source not in dataset",
  campaign_id, hint}`) → field checks (`400`, message names the field; pixel errors carry
  `available_pixels`) → `403 Access denied for customer(s)`.
- `GET /tasks/{id}/` → `{taskId,type:"clone"|"juro",status:pending|running|completed|failed,
  campaign_id,campaign_name,error}`; `400 invalid taskId`, `404 task not found`.
- **Units**: `budget` = decimal STRING in the target account currency (`"30.00"`); `bid_value` =
  NUMBER — CPA strategies in account currency (`3.95`), ROAS strategies = percent 1–200 (`90`).
  Never inherited on clone (target currency may differ); JURO inherits when omitted.
- **Source facts** come from LION, not google-weapon: `GET lion.highstakes.tech/api/google/
  campaigns/metrics/?date=YYYY-MM-DD` (São Paulo dates) → rows `{campaign_id, campaign_name,
  campaign_status ENABLED|PAUSED, account_id, account_name, account_status, campaign_budget
  (major), campaign_bid (major, no strategy field), metrics}`. LION has NO Google `details/` or
  `targeting/` (404) — geo is read from the name segment (`… - BE+CA - …`).
- **Naming (LIVE-VERIFIED with three real shots, 14.09)**: LION builds `{HS-xxxx} <ACCOUNT> -
  (GLO-01) #ADX [HIGH] - DEMANDA (YTB) - <GEO> - <OFFER> DIRETO` and appends ` | <name_suffix>`
  and, for clone/JURO, ` | CLONE_FROM=<source>` / ` | JURO_FROM=<source>` **itself** — the team's
  live names are LION's separators around a BARE suffix (`11.09 Taras`). Our `name_suffix` is
  therefore `DD.MM <username> GC-Launcher[ <tail>]` with no pipes and no marker (the first version
  sent them and LION doubled them); **`GC-Launcher` is a hardcoded marker in every console-born
  name (owner rule 14.09)**; `googleNamePreview` reproduces the final name for previews/rows.
- **Landing (launch mode)** mirrors the FB HS card: the buyer pastes the BARE landing, the card
  drops any pasted query/hash (`googleLandingBase` — LION strips the query and appends its own
  tracking parameters anyway) and previews the final link (`googleLandingSegments`: landing +
  LION's tail) with a Copy button; the wire carries the bare https landing.
- **Links — READ BACK LIVE (Google Ads API, GC-Vis-2)**: launch 24244650168, clone 24255820798 and
  the upload-test launch 24244673001 all carry LION's tail on the final URL:
  `?utm_source=google&utm_campaign=glo-01_{campaignid}_21&utm_medium=glo-01&mb=glo-01&pixel=<account
  pixel>&platform=google` — identical to the team's campaigns (LION stamps it; a clone's landing is
  rotated through LION's map, e.g. `corquieu.com/r/financiamiento-de-autos-de-usc-credit-union/`).
  The card previews exactly this tail (`googleTrackingTail`, ACR from `/api/google/customers`).
- **Assets — both paths verified live**: by URL (placehold.co 512×512 logo + samplelib mp4 →
  IMAGE 512×512 + YouTube video) and by upload (Vercel Blob PNG 256×256 + MP4 through
  `/api/blob-upload` → IMAGE 256×256 + YouTube video `2I3dz0fVTNM`). Rules enforced in the card:
  logo = PNG/JPG/GIF only, square, ≥128 px (dims read client-side; URL mode warns on a
  non-image path); videos = MP4/MOV/WebM only (Dropzone `accept` prop).
- **External API limits probed live 14.09**: `call_to_action` accepts ONLY `LEARN_MORE / SHOP_NOW /
  SIGN_UP` (LION's own launcher UI lists 12 — the extra ones are refused by the external API with
  `ads[0].call_to_action must be one of …`); `language` must be ONE code string (an array is
  refused). The launcher mirrors LION's UI everywhere else: Customer · Pixel · Budget · Bidding
  (5) / Countries with World·LATAM·Anglo·Franco presets · Language (52) · conditional bid / Landing
  URL / read-only name prefix `{HS-____} <ACCOUNT> - (ACR) #ADX [HIGH] - DEMANDA (YTB) - <GEO> -
  <OFFER> DIRETO` + custom tail + MOSH / repeatable AD GROUPS (pipe-separated Headlines ·
  Long headlines · Descriptions, CTA, YouTube URLs one-per-line or Upload + Channel id, Logo
  preview/URL/Upload; Duplicate · Clear URLs · Clear All · delete) / Bulk Ad Groups (≤50 videos →
  ad groups of 5) / Autofill (N copies of card 1 with chosen fields). One shot = one card.
- **Accounts under our own MCC 4904785717** are all SUSPENDED except GC-Vis-1/2 (EUR) — Google Ads
  API read 14.09; a launch into a suspended account fails cleanly with
  `ACTION_NOT_PERMITTED_FOR_SUSPENDED_ACCOUNT`.
- **Minimum budget**: Google/LION refuse less than **BRL 25,40/day** on the BRL accounts
  (`Budget below minimum: provided BRL 1.00/day; Google requires at least BRL 25.40/day.` — the
  task fails cleanly, nothing is created). Default budget on the Google boards = `30,00`.
- **LION's Google status write** (`POST /api/google/campaigns/{id}/status/`) answers `404
  Campaign not found` for ~4 min after birth (LION store sync lag), then 200 — the pause helper
  in `_e2e/_google_live_wave.mts` retries every 30 s.
- Clones/JURO of the team are born **ENABLED** (rows created 14.09 show ENABLED the same day) — no
  activation step; LION's Google write endpoints (`/api/google/campaigns/{id}/status/`) exist but
  are not used by this rail.

## Shape

### Navigation and gating
- `lib/partners.ts`: `GOOGLE_ENABLED = process.env.NEXT_PUBLIC_GOOGLE_ENABLED === "1"` (build-time,
  same dormant-on-prod pattern as HS/AIF; set in `.env.local`, NOT on Vercel yet).
- `components/header.tsx`: `Header` gains `platform?: "facebook" | "google"`. PlatformTabs are real
  links: Facebook → `/`, Google → `/google` (disabled "in development" while `!GOOGLE_ENABLED`),
  TikTok stays disabled. On `platform="google"` the header shows only the Google task-manager
  button (no FB token widget, no FB account-limit timer) and the partner switcher is pinned to HS
  (`lockedNote` prop on `PartnerSwitcher`: other partners render disabled with the tip
  "Google runs through LION (HS) only").
- Dormancy is enforced SERVER-side too: every `/api/google/*` route and the wave handler answer
  `404 google_rail_disabled` while `NEXT_PUBLIC_GOOGLE_ENABLED !== "1"` (`googleRailEnabled()`), so
  a crafted authenticated POST on a dormant deployment cannot create campaigns.
- `app/(app)/google/page.tsx`: session gate → `/login`; `!GOOGLE_ENABLED` → `redirect("/")`;
  `?ids=` (comma list) and `?mode=clone|juro` deep links like `/clone`; renders `GoogleCloneBoard`.
- `app/(app)/layout.tsx`: mounts `GoogleTaskManagerProvider` as the 4th provider.

### Server
- `lib/google-weapon.ts` — the google-weapon client (mirror of `lib/lion.ts`): `GoogleWeaponError
  {status, detail}`, bounded fetch (60 s), 4xx verbatim, one retry on 5xx/network for READS,
  **exactly-once** for `/clone/launch/` and `/juro/launch/` (attempts=1 — an ambiguous outcome is
  reported, never re-sent). `gwCustomers()` (10-min cache, never caches empty), `gwDatasetFetch`,
  `gwDatasetStatus`, `gwEnsureDataset` (fetch → poll ≤180 s → one re-trigger → ≤120 s more),
  `gwCloneLaunch`, `gwJuroLaunch`, `gwTask`, `gwTasks` (≤5 parallel, per-id failure isolated).
  Env: `GOOGLE_WEAPON_BASE` (default the partner host), `GOOGLE_WEAPON_TOKEN` (default `LION_TOKEN`).
- `lib/lion-google.ts` — LION Google metrics reader: `lionGoogleMetrics(date)` (10-min cache per
  date) and `lionGoogleFindCampaigns(ids, days=7)` scanning São Paulo D0…D-6 until every id is
  found (a campaign paused for a week is "unknown to LION metrics" but still launchable — the
  dataset fetch is the real gate).
- `lib/google-source.ts` — pure: `mapLionGoogleRow`, `saoPauloDate(offset)`, `googleGeoFromName`,
  `splitGoogleName`, `GoogleSourceInfo` type.
- `lib/google-bid.ts` — pure decisions (unit-tested): `GOOGLE_BID_STRATEGIES` (7, with kind
  none|cpa|roas), `googleBidKind`, `parseGoogleBid` (CPA decimal-comma > 0 ≤ 10000 · ROAS integer
  1–200), `googleBudgetWire` ("30,00" → "30.00", 1 ≤ x ≤ 100000), `googleBidPlan` (clone: inherit /
  explicit strategy with typed bid rules; JURO: strategy fixed, bid optional = inherit; refusals
  name the exact fix), `googleBidLabel` (monitor tag "CPA 3,95" / "ROAS 90%" / "auto" /
  "inherit"), `googleNameSuffix` (team pattern, whitespace squashed, tail trimmed to keep the
  marker under 80 chars), `googleTaskStage`, `googleWeaponErrorMessage` (adds `available_pixels`).
- `lib/google-pump.ts` — the after() wave pump: (1) ensure every distinct source's dataset
  (parallel ≤3), rows of an unfetchable source → error at stage `dataset`; (2) submit shots ONE
  AT A TIME with 1–3 s jitter (exactly-once): 201 → row `link`=taskId, stage `lion`, started_at;
  4xx → error with the partner's sentence, and the remaining copies of the SAME row skip with
  the same refusal (identical wire); 5xx/network → status `interrupted` "ambiguous — check LION
  before re-firing"; (3) poll `gwTasks` every 10 s until every task is terminal or the deadline
  (770 s budget, stop 20 s early): completed → `done` + `campaign_id` + real `campaign_name`,
  failed → `error`. Rows left running at the deadline are finished by the client poller.
- Routes (all `sessionFromCookieHeader`-gated, `runtime="nodejs"`):
  - `GET /api/google/customers` → `{ok, customers:[{customerId,name,mccId,currency,pixels}]}`.
  - `POST /api/google/sources {ids≤30}` → `{ok, sources: GoogleSourceInfo[]}` — LION metrics
    lookup + a non-force `dataset/fetch` per id (pre-warms the snapshot; `dataset.state` =
    ready|fetching|missing|error).
  - `POST /api/google/dataset {ids, force?}` → `{ok, datasets:{id:{state,fetchedAt,error?}}}` —
    status poll for fetching rows; `force:true` re-snapshots a changed source.
  - `POST /api/google/clone` and `POST /api/google/juro` — wave routes (`maxDuration=800`,
    ≤45 shots). Body `{waveId, customer?, pixel?, shots:[{campaignId, budget, bid, bidStrategy,
    suffix, customer?, pixel?, sourceName?, geo?, sourceAccount?, currency?}]}`. Validation:
    ids `/^\d{5,}$/`, budget via `googleBudgetWire`, bid via `googleBidPlan` (refusal → 400
    naming the row), clone target = row customer over wave customer and MUST be in
    `gwCustomers()`; pixel = row over wave: required + validated when the target has >1 pixels,
    auto when exactly 1, omitted when 0 (LION decides); JURO target = the source's own account
    (from metrics when known — then the pixel is validated against it), pixel otherwise passed
    through. Idempotency: `claimedWaves` + app-cache `google-wave:<waveId>` (re-POST →
    `alreadyAccepted`), fail CLOSED (503) when the claim store is down. Order: stamp rows →
    claim → `after(pump)` → `{ok:true, queued, rows:[{taskId}]}`. Task ids `ggc-<wave>-NN` /
    `ggj-<wave>-NN`.
  - `POST /api/google/status {taskIds≤100}` → `{ok, tasks: GwTask[]}` for the client poller.
  - `GET/POST /api/google-tasks` — the shared store scope for Google rows (`partner="gg"`,
    7-day window, done-is-terminal + interrupted/error zombie guards as in `/api/hs-tasks`).
  - `/api/launch-tasks` MO scope excludes `gg` too (otherwise Google rows leak into the MO drawer).
- Strapi `launch-task` columns reused (NO new columns): `link` = google-weapon taskId, `gcm` =
  kind `g-clone|g-juro`, `adset_id` = target customer id, `ad_id` = account currency, `stage` =
  dataset|submit|lion|done|failed, `bid` = `googleBidLabel`, `campaign_id`, `name` (source name +
  suffix until LION reports the real `campaign_name`), `geo` (from the source name).

### Client
- `components/google-clone-board.tsx` — the board (structure of `hs-clone-board.tsx`, no FB
  gates): mode segmented Cloner | JURO (localStorage `adlauncher.google.mode`, `?mode=` wins);
  Settings aside = target account (customers, currency meta, pixel count tag; JURO: locked
  "source's own account"), pixel (the target's pixels: auto when one, required when several,
  "no conversion pixel" note when none), copies (1–20), Preview → Fire. Rows on the shared
  `.clone-row` grid: source facts (name/status/account/budget/bid, dataset chip ready / fetching…
  / not in LION / re-fetch button), geo (read-only from the name), per-row Destination (clone:
  account + pixel `SearchSelect size="sm"`; JURO: pixel of the source account), Strategy
  (clone: Inherit + 7 Google strategies; JURO: locked "source's") + bid (CPA cash-register in
  the target currency / ROAS integer percent), budget (cash-register, prefilled from the
  source when the currencies match, else `10,00`), suffix tail (preview of the full team-pattern
  suffix), copies stepper, remove. Gates: dataset missing/error, bid missing for a value
  strategy, ROAS out of 1–200, pixel required, target unknown, more than 45 shots in one wave
  (the server cap, mirrored client-side). Prefill is MACHINE state (`autoBudget`/`autoBid`): it
  re-derives whenever the row's billing currency changes (wave account, row override, mode) and
  pins on the first manual keystroke. Cross-currency: bid is NOT prefilled and the hint says
  "target bills USD — retype". Fire = one POST per wave with a
  `waveId` (`crypto.randomUUID()` cached per content signature); success opens the Google task
  drawer and marks rows "queued — safe to close the tab" (server pump).
- `components/use-google.ts` — `useGoogleCustomers()` (one load, retry on failure).
- `components/google-task-manager.tsx` — `GoogleTaskManagerProvider`, `useGoogleTaskManager()`
  ({tasks, counts, me, open, setOpen}), `GoogleTaskManagerButton`, drawer (stats, All/Active/
  Done/Failed, Mine toggle, rows: name, CLONE/JURO chip, account · currency · geo · budget ·
  bid tag, owner chip, elapsed, LION task id + campaign id copy buttons, stage/status label).
  Shared poll `GET /api/google-tasks` (6 s open / 20 s closed, `mergeShared`-style merge with
  own rows authoritative); LION poll for MY running rows with a task id via `/api/google/status`
  (12 s / 30 s) → done/error + save; age-out running > 3 h → interrupted. No retry (exactly-once
  creates — re-fire from the board), no dismiss (errors are the team record).

### Fresh launches (mode "launch")
- Board: `/google` = the Google **launcher** (FB-launcher structure: campaign cards + sticky Launch
  bay); `/google/clone` = the clone/JURO board; `components/google-nav.tsx` links the two. Card =
  SETUP (name tail, target account, pixel) · DELIVERY (strategy REQUIRED, bid per kind, budget,
  mosh) · CREATIVE (one ad group: 1–5 headlines ≤40, 1–5 long headlines ≤90, 1–5 descriptions
  ≤90, CTA Learn more/Shop now/Sign up or automatic, logo = https URL or image file, videos =
  YouTube links OR uploaded files, exactly one source) · TARGETING (geo multi, WW exclusive;
  language) · LANDING (https URL on LION's allowed map — LION refuses others with a sentence).
- Assets never go through google-weapon's upload endpoint: files ride Vercel Blob (public URLs)
  exactly like the FB rails, and land in `video_urls` / `logo_url`. Client-side uploads → the
  do-not-close notice + unload guard while uploading; the wave itself is a server pump.
- Wire: `googleLaunchWire` (pure, tested) is the ONE validator — the board dry-runs it with
  placeholder asset URLs for readiness, the route runs it for real; name_suffix for launches =
  `| DD.MM <user>[ <tail>]` (no CLONE_FROM marker — LION generates the head). Task ids `ggl-…`,
  store kind `g-launch`, stages submit → queue/lion → done|failed (no dataset phase).
- Route `POST /api/google/launch {waveId, shots: GoogleLaunchShotIn[]}` → `handleGoogleLaunch`
  (lib/google-wave.ts) sharing `acceptGoogleWave` (idempotency, stamp, claim, pump) with clones.

## Decisions
- **Platform, not partner.** Google is a platform tab, pinned to the LION (HS) partner because
  the only rail is LION's API. Adding a fourth PartnerId would have put "Google" next to
  HS/MO/AIF in the partner switcher, which is the wrong axis.
- **Separate store scope `gg`** so the FB HS drawer and the Google drawer never mix; separate,
  compact task manager rather than a fork of the 1 800-line HS one (no uploads, no activation,
  no token channel).
- **Server pump with client finish** (HS parity): rows are stamped before the response, the
  pump lives in `after()`, the owner's browser finishes what the pump's budget did not.
- **Budget prefill = source budget when currencies match** (the team clones at the source's
  R$30), else the console default `10,00`. Bid prefill = source `campaign_bid` when currencies
  match (the team's Google book is ~95 % Target CPA), never across currencies.
- **Inherit strategy on clone is allowed** even though LION never inherits `bid_value`: the typed
  bid rides as `bid_value`; LION's explicit 400 ("bid_value is required for strategy target_cpa…"
  / "…no-value strategy") lands on the row verbatim — the buyer then picks an explicit strategy.
- **No activation / no pause** in v1 (born ENABLED per live evidence); the drawer links the ids.

## Verification
- Units: `node --test tests/google-bid.test.ts tests/google-source.test.ts tests/google-weapon.test.ts`
  (bid plans × kinds, budget/bid parsing, suffix builder + cap, geo/name splitting, stage map,
  error classifier, São Paulo dates, dataset ensure with a stubbed fetch/sleep).
- `npx tsc --noEmit`, `npx eslint`, `npx next build`.
- Route smoke on a local server with `GOOGLE_WEAPON_BASE` pointed at a mock google-weapon
  (`_e2e/_google_mock.mjs`): customers, sources (LIVE LION metrics), dataset polling, refusal
  matrix (400/403/404 shapes), clone + JURO waves end to end (rows → pump → done), idempotent
  re-POST, status poller.
- Live read-only against the real partner: customers, dataset fetch/status on real sources.
- ⚠️ A live clone shot creates a REAL, ENABLED Google campaign — fired only on the owner's word.
