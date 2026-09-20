# Snapchat rail — launch on our own Snapchat Ads account, partner keys `glo-snp_001…100`, LION daily report

**Date:** 2026-09-16 · **Status:** built + verified locally on 2026-09-16 (six unit suites,
tsc/eslint/next build, mock smoke 41/41 with Strapi + LION live, dormancy proof); NOT merged, NOT
pushed, NOT deployed, prod flag unset — awaiting a real Snapchat account (see _e2e/README-snap.md
§1); ships dormant behind `NEXT_PUBLIC_SNAP_ENABLED`. No Snapchat account exists yet: the rail is
built against the public Marketing API docs and verified end to end on a local fake Snapchat API
(`_e2e/_snap_mock.mjs`). The first live read-only check runs once the owner has an account, an OAuth
app and a refresh token.

The third platform in the console (after Facebook and Google). A **Snapchat** platform tab opens a
launcher that creates Demand-style web campaigns on OUR Snapchat ad account through the Snapchat
Marketing API (campaign → ad squad → WEB_VIEW creative → REMOTE_WEBPAGE ad), each campaign carrying
one of the partner's 100 fixed revenue keys in its landing URL, plus a keys page that joins the key
registry with the partner's daily revenue report (served by LION).

## Partner brief (verbatim facts, 16.09)

- Landings (the partner's domain): **Digital marketing** `https://azmvhs.com/v/dmi-online-marketing-course/`,
  **Cars** `https://azmvhs.com/v/auto-financing-by-ford/`.
- 100 fixed campaign keys `glo-snp_001` … `glo-snp_100`, **one per campaign**, always with
  `utm_source=stone`: `…/?utm_source=stone&utm_campaign=glo-snp_001`.
- Keep Snap Click ID enabled so `ScCid` is appended; never overwrite `utm_source` / `utm_campaign`
  with Snapchat macros.
- Daily report, one call per day: `GET https://lion.highstakes.tech/api/high-adx-cluster-utms/snapchat-report/?date=YYYY-MM-DD`,
  `Authorization: Bearer <token>` — revenue, impressions, eCPM, visitors, pixel events per key + totals.
  Today = partial + forecast; a day is final the next morning.
- The partner wants our **pixel ID + Conversions API token** to fire events on our pixel (manual
  hand-off, outside this rail).

### LION report — probed live 16.09 with our existing `LION_TOKEN` (200 for 15.09 and 16.09)

```
{ "date": "2026-09-15", "affiliate": "globecoders", "utm_prefix": "glo-snp_",
  "totals":    { "revenue": 0, "forecasted_revenue": 0, "impressions": 0, "ecpm": 0,
                 "triggered": 0, "fired": 0, "visitors": 1, "conversions": 0 },
  "campaigns": [ { "utm_campaign": "glo-snp_001", "revenue": 0, "forecasted_revenue": 0,
                   "impressions": 0, "ecpm": 0, "triggered": 0, "fired": 0, "visitors": 0,
                   "conversions": 0 }, … 100 rows … ] }
```

`triggered` / `fired` are the pixel-event counters; `visitors` counts landings. The same bearer as
LION (`LION_TOKEN`) works — no new credential for the report.

### Snapchat Marketing API — facts from the docs (developers.snap.com, read 16.09)

- Auth: OAuth2, scope `snapchat-marketing-api`. Refresh grant `POST https://accounts.snapchat.com/login/oauth2/access_token`
  (`grant_type=refresh_token`, `client_id`, `client_secret`, `refresh_token`) → `access_token`
  (`expires_in` 3600 s). Authorization code grant at `…/oauth2/authorize` (`response_type=code`,
  `client_id`, `redirect_uri`, `scope`, `state`).
- Base `https://adsapi.snapchat.com/v1`. Every write is a batch: `{ "campaigns": [ {…} ] }` →
  `{ request_status, request_id, campaigns: [ { sub_request_status, campaign: {id,…} } ] }`. Errors
  come as HTTP 4xx/5xx with `request_status: "ERROR"` and `debug_message` / `display_message`
  (per-item failures repeat the same fields under `sub_request_status: "ERROR"`).
- Reads: `GET /me/organizations?with_ad_accounts=true` → organizations with nested `ad_accounts[]`
  (`id, name, currency, timezone, status`); `GET /adaccounts/{id}/pixels` → `pixels[].pixel {id, name,
  status, effective_status}`; Public Profiles live on **another host**:
  `GET https://businessapi.snapchat.com/v1/organizations/{org}/public_profiles` →
  `public_profiles[].public_profile {id, display_name, profile_type, …}`.
- Media: `POST /adaccounts/{id}/media {media:[{name, type:"VIDEO"|"IMAGE", ad_account_id}]}` →
  `POST /media/{media_id}/upload` (multipart, field `file`, ≤32 MB single-part; chunked
  `multipart-upload-v2` beyond) → poll `GET /media/{media_id}` until `media_status === "READY"`.
  Video mp4/mov 1080×1920 (9:16), 3–180 s for Snap Ads; image PNG/JPG 1080×1920 ≤5 MB.
- Campaign: `POST /adaccounts/{id}/campaigns {name ≤375, ad_account_id, status ACTIVE|PAUSED, start_time
  (ISO, required), daily_budget_micro?, lifetime_spend_cap_micro?, buy_model? (AUCTION default)}`;
  `objective` is rejected since 2025 — `objective_v2_properties` is optional and **omitted**.
  Update = `PUT /adaccounts/{id}/campaigns` with the **whole object** (`id, name, ad_account_id,
  status, start_time, buy_model, objective_v2_properties` — omitted attributes reset to defaults), so a
  status flip is GET `/campaigns/{id}` → PUT the read object with `status` changed.
- Ad squad: `POST /campaigns/{id}/adsquads {adsquads:[{name, campaign_id, type:"SNAP_ADS",
  billing_event:"IMPRESSION", delivery_constraint:"DAILY_BUDGET", daily_budget_micro (≥5 000 000),
  bid_strategy AUTO_BID|LOWEST_COST_WITH_MAX_BID|TARGET_COST, bid_micro (required for the last two; USD
  10 000 … 500 000 000), optimization_goal (PIXEL_PURCHASE, PIXEL_PAGE_VIEW, LANDING_PAGE_VIEW, SWIPES,
  IMPRESSIONS, …), placement_v2:{config:"AUTOMATIC"}, targeting:{geos:[{country_code}],
  demographics:[{min_age:"18"}]} (ages are STRINGS), pixel_id?, status, start_time?}]}`.
  **`MIN_ROAS` is deprecated since 10.02.2025** — not offered.
- Creative: `POST /adaccounts/{id}/creatives {creatives:[{ad_account_id, name, type:"WEB_VIEW",
  headline ≤34, brand_name ≤32, call_to_action, top_snap_media_id, web_view_properties:{url (https,
  ≤2048), block_preload, allow_snap_javascript_sdk, use_immersive_mode}, profile_properties:{profile_id}
  (REQUIRED since 26.02.2024 — every ad needs a Public Profile), shareable, top_snap_crop_position}]}`.
  The url supports macros (`{{campaign.name}}`, `{{ad.id}}`, …) — we never use them; `ScCid` is appended
  by Snap automatically (no toggle to keep).
- Ad: `POST /adsquads/{id}/ads {ads:[{ad_squad_id, creative_id, name, type:"REMOTE_WEBPAGE",
  status}]}` → `review_status PENDING|APPROVED|REJECTED` + `review_status_reasons`.
- Conversions API token (for the partner): Ads Manager → Business Details → OAuth Apps → Conversions
  API Tokens → Generate (org admin; the token does not expire). Manual step, documented in the runbook.

## Shape

### Navigation and gating
- `lib/partners.ts`: `SNAP_ENABLED = process.env.NEXT_PUBLIC_SNAP_ENABLED === "1"` (build-time; set only
  in `.env.local` — the prod build keeps the tab disabled "in development"). Snapchat is a **platform**,
  not a `PartnerId` (same reasoning as Google: the only rail is our own account; a partner axis is wrong).
- `components/header.tsx`: `Platform = "facebook" | "google" | "snapchat"`; a real Snapchat tab
  (`components/icons.tsx` gains `SnapMark`, ghost mark in Snap yellow, mono when dormant) → `/snap`;
  on `platform="snapchat"` the partner switcher is locked (`lockedNote="Snapchat runs on our own ad
  account"`), FB widgets hide, the queue button is `SnapTaskManagerButton`.
- `app/(app)/layout.tsx` mounts `SnapTaskManagerProvider` as the innermost provider.
- Pages: `app/(app)/snap/page.tsx` (launcher) and `app/(app)/snap/keys/page.tsx` (keys + report), both
  session-gated → `/login`, `!SNAP_ENABLED → redirect("/")`. `components/snap-nav.tsx` = the sticky
  sub-nav (Launch / Keys · report) under the header, same texture as `google-nav`.
- Dormancy is server-side too: every `/api/snap/*` route and `/api/snap-tasks` answer
  `404 snap_rail_disabled` while `NEXT_PUBLIC_SNAP_ENABLED !== "1"` (`snapRailEnabled()` in
  `lib/snap-api.ts`) — an authenticated POST on a dormant deployment can create nothing.

### Partner constants — `lib/snap-partner.ts` (pure, `node --test`-able, no `@/` imports)
- `SNAP_UTM_SOURCE = "stone"`, `SNAP_KEY_PREFIX = "glo-snp_"`, `SNAP_KEY_POOL_MAX = 100`,
  `snapKeyCode(n) → "glo-snp_007"`, `snapKeyIndex(key) → 7 | null`, `SNAP_KEY_RE = /^glo-snp_(\d{3})$/`.
- `SNAP_LANDINGS: Array<{ id: "dmi" | "cars"; niche: string; url: string }>` = the two partner
  landings; the card offers them by niche plus a **custom https URL** (warned on the card: revenue is
  only reported for the partner's landings).
- `snapLandingBase(raw)` strips any pasted query/hash (Snap appends `ScCid` itself; our two params
  must be the only query) and refuses non-https. `snapLandingUrl(base, key)` →
  `${base}?utm_source=stone&utm_campaign=${key}`; `snapLandingSegments(base, key)` → role-tagged
  segments (`landing` / `utm` / `key` / `sccid-note`) for the coloured card preview, mirroring
  `landingUrlSegments` for FB.
- `snapCampaignName({ddmm, niche, geoLabel, key, user, tail})` → `[DD.MM] (SNP) <niche> - <GEO> - <key>
  - <user> - GC-Launcher[ - <tail>]`, whitespace squashed, pipes stripped, capped at 375 chars with the
  tail trimmed first. The **same name** goes on the campaign, the ad squad, the creative and the ad. The
  key inside the name makes LION's report readable straight from Ads Manager; `GC-Launcher` is the
  owner's console marker (rule 14.09).

### Key registry — `lib/snap-keys.ts` (server-only)
- Backing store = the existing Strapi **`app-cache`** collection (`ckey` unique, `cvalue` json), one row
  per claimed key: `ckey = "snap-key:glo-snp_NNN"`, `cvalue = SnapKeyBinding { key, status:
  "active"|"retired", user, claimed_at, campaign_id, adsquad_id, ad_id, ad_account, niche, landing, name,
  notes }`. No Strapi schema change is needed (the owner's constraint: local only). The module is the only
  reader/writer; moving to a dedicated `snap-map` collection later is a swap of this one file.
- `listSnapKeys()` → `SnapKeyBinding[]` — `filters[ckey][$startsWith]=snap-key:` paged ×100 (pool = 100,
  +1 page of slack), throws on a failed page (a partial registry must never show as whole).
- `claimSnapKey(desired, meta)` — same race-safe contract as `lib/aif-claim.ts`: walk from `desired`
  forward then wrap, `POST /api/app-caches` per candidate (a unique-`ckey` violation = taken → next), then
  `wonClaim` re-reads the key's rows oldest-first and deletes our row if an earlier one exists (Strapi's
  app-level uniqueness has the proven TOCTOU window). Returns `{ key, documentId }`; throws
  `snap key pool exhausted — no free key glo-snp_001…100` when none is left.
- `backfillSnapKey(documentId, patch)` (ids after the create, `status:"retired"` + notes on a kept
  row), `releaseSnapKey(documentId)` (DELETE — a key that never carried traffic is pool capacity).
- Owner release from the keys page: `DELETE /api/snap/keys?key=` deletes the row after a confirm; the
  campaign is NOT touched (pausing/deleting on Snapchat stays manual, like gcm today).

### Snapchat client — `lib/snap-api.ts` (mirror of `lib/google-weapon.ts`)
- Env: `SNAP_CLIENT_ID`, `SNAP_CLIENT_SECRET`, `SNAP_REFRESH_TOKEN` (the three that make
  `snapConfigured()` true), `SNAP_ORGANIZATION_ID` (optional — the first organization is used when
  unset), `SNAP_AD_ACCOUNT_ID` / `SNAP_PIXEL_ID` / `SNAP_PROFILE_ID` (board defaults), `SNAP_BRAND_NAME`
  (creative `brand_name` default), `SNAP_API_BASE` (default `https://adsapi.snapchat.com/v1`),
  `SNAP_AUTH_BASE` (default `https://accounts.snapchat.com`), `SNAP_BUSINESS_API_BASE` (default
  `https://businessapi.snapchat.com/v1`) — the last three point at the mock in e2e.
- `snapAccessToken()`: refresh grant, cached per instance until `expires_in − 60 s`, in-flight dedupe;
  a failed refresh throws `SnapApiError 401 "refresh token rejected"` (surfaced as
  `snap_auth_failed` by routes).
- `SnapApiError { status?, detail?, snapMessage? }`; `snapFetch(path, init, attempts)` — Bearer, JSON,
  `cache:"no-store"`, `AbortSignal.timeout(60 s)`, ONE retry on 5xx/network for reads, **`attempts=1`**
  for every create/update (never re-send an ambiguous write); 4xx thrown verbatim with the Snap
  `debug_message`/`display_message`; a 2xx whose `request_status !== "SUCCESS"` or whose item has
  `sub_request_status !== "SUCCESS"` is an error too. `snapErrorMessage(e)` = the sentence for rows.
- Reads (10-min per-instance cache, never caches empty): `snapAdAccounts()` →
  `SnapAdAccount { id, name, currency, timezone, status, organizationId }`; `snapPixels(adAccountId)`;
  `snapProfiles(orgId)` (business host). `snapMedia(mediaId)` (poll). `snapCampaign(id)` (for the
  status flip).
- Writes (exactly-once): `snapCreateMedia`, `snapUploadMedia(mediaId, bytes, filename, mime)`
  (Node `FormData` + `Blob`, field `file`), `snapCreateCampaign`, `snapCreateAdSquad`,
  `snapCreateCreative`, `snapCreateAd`, `snapSetCampaignStatus(id, status)` (GET → PUT whole object).
- `snapRailEnabled()`, `snapConfigured()`.
- Catalog route `GET /api/snap/accounts` (session-gated, `runtime="nodejs"`) → `{ ok, accounts:
  SnapAdAccount[] (each with `pixels: SnapPixel[]`), profiles: SnapProfile[], defaults: { adAccount,
  pixel, profile, brandName } }` — one call feeds every picker on the board (`use-snap.ts`
  `useSnapCatalog()`: one load, retry on failure). Pixels are read per account (≤5 in parallel, a
  per-account read failure yields `pixels: []` + `pixelsError` rather than sinking the call); profiles
  come from the business host for the organization of the first account (or `SNAP_ORGANIZATION_ID`).
  Failures: 404 `snap_rail_disabled`, 500 `snap_not_configured`, 502 `snap_auth_failed` /
  `snap_unavailable` with the Snap sentence.

### OAuth helper (owner-only, tiny) — `app/api/snap/oauth/start/route.ts`, `…/callback/route.ts`
- `start` → 302 to Snap's authorize URL (`scope=snapchat-marketing-api`, `state` = HMAC-signed nonce
  kept in a 10-min cookie, `redirect_uri` = `SNAP_OAUTH_REDIRECT_URI` or `<origin>/api/snap/oauth/callback`).
- `callback` verifies `state`, exchanges the code (`grant_type=authorization_code`) and renders a
  plain HTML page that **shows** the `refresh_token` with the one instruction "paste as
  `SNAP_REFRESH_TOKEN` in `.env.local`, restart". Nothing is stored or logged. Needed because minting a
  refresh token by hand is the one fiddly step of the setup; it is also how the token gets rotated.

### Validator — `lib/snap-launch.ts` (pure, tested)
- Vocabularies: `SNAP_BID_STRATEGIES` = `AUTO_BID` "Auto bid" (kind none, default) ·
  `LOWEST_COST_WITH_MAX_BID` "Max bid" (kind bid) · `TARGET_COST` "Target cost" (kind bid);
  `SNAP_OPTIMIZATION_GOALS` = `PIXEL_PURCHASE` (default) · `PIXEL_PAGE_VIEW` · `LANDING_PAGE_VIEW` ·
  `SWIPES` · `IMPRESSIONS`; `SNAP_CTAS` = `MORE` (default) · `SHOP_NOW` · `SIGN_UP` · `APPLY_NOW` · `VIEW`
  · `READ` · `GET_NOW` · `TRY` · `SHOW` · `WATCH`; `SNAP_GEO_PRESETS` = US · Anglo (US CA GB AU NZ IE) ·
  LATAM (17, the Google list) · Franco (6) · EU (27); `SNAP_MIN_AGES` = 18 (default) · 21 · 25.
- Money: `snapMicro("10,00") → 10_000_000` (decimal comma or point, 2 dp); budget
  `SNAP_BUDGET_MIN = 5` … `10 000` per day (Snap's own floor is USD 5), default `SNAP_DEFAULT_BUDGET =
  "10,00"`; bid `0,01 … 500` (Snap's USD bid_micro range). Refusals name the field and the fix.
- `snapShotTaskId(waveId, i) → "snl-<wave>-NN"`; `SNAP_WAVE_ID_RE` as Google's; `SNAP_MAX_SHOTS = 45`.
- `SnapLaunchShotIn { label?, adAccount, pixel?, profileId?, optimizationGoal, bidStrategy, bid, budget,
  startPaused, headline, brandName, cta, mediaUrl, mediaKind:"video"|"image", mediaName, geo: string[],
  minAge, landingId: "dmi"|"cars"|"custom", landingUrl, desiredKey?, suffix, currency? }`.
- `snapLaunchWire(shot, resolved: { adAccountId, pixelId?, profileId, nameParts }) → { wire:
  SnapLaunchWire, label } | { refusal }` where `SnapLaunchWire = { campaign:{…}, adsquad:{…},
  creative:{…}, ad:{…}, landing: {base, key placeholder} }` — the ONE validator: the board dry-runs it
  with a placeholder media id + the next free key for readiness; the pump runs it with the real media
  id and the claimed key (`snapWireWithKey(wire, key, mediaId)` fills the two late-bound values).
  Rules: headline 1–34, brand 1–32, CTA in vocabulary, https landing on the partner map or custom
  https, ≥1 geo (ISO-2, lower-cased on the wire; no "WW" — Snap has no worldwide token), min age in
  the list, goal `PIXEL_*` requires a pixel, bid required exactly when the strategy's kind is bid,
  media exactly one (video or image), suffix without pipes.
- `snapBidLabel` → monitor tag "auto" / "max $0,50" / "target $1,20" (currency from the account);
  `snapStageLabel`.

### Route + wave — `app/api/snap/launch/route.ts` → `lib/snap-wave.ts`
- `POST {waveId, shots: SnapLaunchShotIn[] (≤45)}` (`runtime="nodejs"`, `maxDuration=800`). Order:
  session (401) → `snapRailEnabled()` (404) → `snapConfigured()` (500 `snap_not_configured`) → parse →
  `snapAdAccounts()` (502 on failure) → per shot: account must be in the list, pixel resolved (row over
  wave; validated against `snapPixels(account)` when given, required for `PIXEL_*` goals), profile =
  row/env `SNAP_PROFILE_ID` (refused when neither), `snapLaunchWire` → `ResolvedShot { taskId, rowKey,
  wire, row }`.
- `acceptSnapWave` mirrors `acceptGoogleWave`: stamp one store row per shot BEFORE the response
  (`partner:"sn"`, `status:"running"`, `stage:"key"`, `gcm: desiredKey ?? ""`, `name` (provisional with
  the desired key), `geo`, `budget`, `bid` label, `adset_id: ""`, `ad_id: ""`, `campaign_id: ""`,
  `link: ""`), claim the wave in app-cache (`snap-wave:<waveId>`, in-memory `claimedWaves` first;
  re-POST → `{alreadyAccepted:true}`; claim store down → **503 fail closed**, nothing fired), then
  `after(() => pumpSnapWave(…))`. Response `{ok:true, queued, rows:[{taskId}]}`.
- `/api/launch-tasks` (MO scope) adds `partner $ne "sn"` so Snap rows never leak into the MO drawer.

### Pump — `lib/snap-pump-core.ts` (pure, deps injected, tested) + `lib/snap-pump.ts` (binds I/O)
- Shots run ONE AT A TIME with 1–3 s jitter, each through a `taskWriter(user, taskId, {partner:"sn"})`.
  Per shot, stages in order — every stage writes `stage` before it starts:
  1. `key` — `claimSnapKey(desiredKey)`; exhausted → row `error` "key pool exhausted — release keys".
  2. `media` — `ensureMedia(adAccount, mediaUrl)`: **one upload per (account, Blob URL) per wave**
     (copies of a card reuse the media id): fetch the Blob bytes (bounded, ≤32 MB else refusal
     "creative over 32 MB — trim it"), create media, upload, poll READY every 5 s ≤120 s. Any failure
     here → `releaseSnapKey` + row `error` (nothing with money exists yet).
  3. `campaign` — created **`PAUSED`**. 4xx → release key + `error`; 5xx/network → row `interrupted`
     ("ambiguous — check Ads Manager before re-firing"), key **retired** with note (a campaign may exist).
  4. `adsquad` → 5. `creative` → 6. `ad` (ad squad and ad are `ACTIVE`; the campaign shell is paused,
     so nothing delivers). 4xx → campaign stays PAUSED, key retired `{campaign_id, adsquad_id?, notes}`,
     row `error` with Snap's sentence; 5xx/network → `interrupted`, key retired.
  7. `activate` — unless `startPaused`: `snapSetCampaignStatus(id, "ACTIVE")`. A failure here is NOT a
     failed launch: the whole chain exists — row `done`, stage `paused`, `error` = "activation failed:
     … — activate in Ads Manager".
  8. `done` — `backfillSnapKey({campaign_id, adsquad_id, ad_id, status:"active"})`; row
     `{status:"done", stage: startPaused ? "paused" : "live", campaign_id, adset_id: adsquadId, ad_id,
     link: <final landing URL>, gcm: key, name: <final name>, finished_at}`.
- Budget 770 s (`after()` ceiling); rows still `running` at the deadline are left as they are (no client
  finisher in v1 — a stuck row is visible in the drawer with its last stage) and age out to
  `interrupted` after 3 h in the task manager.
- The pump never re-sends a create; identical-wire copies do NOT share a refusal (each copy has its own
  key, so the wires differ).

### Task store + drawer
- Rows: `partner="sn"`; `gcm` = key; `campaign_id` / `adset_id` (ad squad) / `ad_id`; `link` = final
  landing URL (with key); `bid` = label; `stage` ∈ key · media · campaign · adsquad · creative · ad ·
  activate · live · paused · failed. No new Strapi columns.
- `app/api/snap-tasks/route.ts` = clone of `google-tasks` scoped `partner=sn` (7-day window, batch ≤25,
  zombie guard, done-is-terminal, owner-only DELETE), `toClient` maps `gcm→key`, `adset_id→adsquadId`.
- `components/snap-task-manager.tsx` = the compact Google drawer: stats, All/Active/Done/Failed, Mine,
  rows with the key chip, stage/status label, account · currency · geo · budget · bid tag, owner chip,
  elapsed, copy buttons for campaign / ad squad / ad ids, an "Open in Ads Manager" link
  (`https://ads.snapchat.com/<adAccount>/campaigns/<campaignId>`, best-effort deep link) — deferred:
  the deep-link URL pattern is verified only with a real account; the drawer's copy button and the
  keys page show the campaign id until then. Shared poll
  6 s open / 20 s closed; no LION-style finisher; age-out 3 h → interrupted. No retry, no dismiss.

### Launcher — `components/snap-launch-board.tsx` + `snap-launch-card.tsx` + `use-snap.ts`
- Board = the Google launcher structure: campaign cards + sticky Launch bay (Preview → Fire), wave id
  cached per content signature, client Blob upload per card (`uploadCreativeFile("snap/<user>/<wave>/…")`,
  unload guard while uploading), one `POST /api/snap/launch` per wave, success opens the drawer and
  marks cards "queued — safe to close the tab". Fire gates: every card ready (validator dry-run), total
  copies ≤45, free keys ≥ total copies (from `GET /api/snap/keys`), accounts loaded.
- Card sections: **SETUP** (name tail, ad account picker with currency meta, pixel picker — auto when
  one, required when several for `PIXEL_*` goals, Public Profile picker with env default) ·
  **DELIVERY** (optimization goal, bid strategy, bid cash-register when the kind is bid, daily budget
  cash-register default `10,00`, "Start paused" toggle) · **CREATIVE** (Dropzone: ONE file, `accept`
  video mp4/mov or image png/jpg, ≤32 MB; client reads dimensions and warns when not 9:16 / not
  1080×1920; headline ≤34 with counter, brand name ≤32 default `SNAP_BRAND_NAME`, CTA) ·
  **TARGETING** (countries multi-select with presets, min age) · **LANDING** (niche picker Digital
  marketing / Cars / Custom URL; coloured preview of the final link with the NEXT free key highlighted +
  the note "Snap appends ScCid on click") · **COPIES** stepper 1–20 — N copies = N campaigns = N keys
  (the preview lists the keys the wave will take, in order; the pump claims desired-or-next).
- Card helpers are pure and tested: `freshSnapCard`, `buildSnapShots(card, copies, nextKeys)`,
  `snapCardRefusal` (dry-run of the server validator), `snapCardSignature`.

### Keys page — `components/snap-keys-board.tsx`
- Table of all 100 keys: key · status chip (free / active / retired) · campaign name + ids · buyer ·
  claimed at · landing niche · for the picked date: revenue (final) or revenue + forecast (today,
  labelled "partial") · impressions · eCPM · visitors · pixel triggered/fired · conversions. Totals row
  (LION `totals`). Date picker with Today / Yesterday shortcuts (São Paulo days, like LION's Google
  metrics), filters free/active/retired, "copy free keys". Owner-only **Release** button per bound key
  (confirm; deletes the registry row only).
- `GET /api/snap/keys` → `{ok, poolMax, used: SnapKeyBinding[], free: string[], next: string|null}`;
  `DELETE /api/snap/keys?key=` (owner) → `{ok}`.
- `GET /api/snap/report?date=YYYY-MM-DD|today|yesterday` → `{ok, date, partial, totals, rows:[{key,
  metrics, binding|null}]}` — `lib/lion-snap.ts` reads LION with a 10-min per-date cache (in-flight
  dedupe, an empty/zero day cached ~1 min), `partial = date ≥ today (São Paulo)`.

### Verification
- Units (`node --test tests/<file>.test.ts`): `snap-partner` (key codec, landing base/URL/segments,
  campaign name + cap), `snap-launch` (vocabularies, micro money, the full `snapLaunchWire` refusal
  matrix, task ids, bid labels), `snap-keys` (claim walk / unique-400 / lost-race delete / exhausted /
  list paging, with `globalThis.fetch` stubbed), `snap-pump-core` (deps-injected: happy path, media
  reuse across copies, 4xx before campaign → key released, 4xx after campaign → key retired + row error,
  5xx → interrupted, activation failure → done/paused), `lion-snap` (parse, partial flag).
- `npx tsc --noEmit`, `npx eslint`, `npx next build`.
- Mock + smoke: `_e2e/_snap_mock.mjs` (dependency-free `node:http` fake on :3198 serving the auth
  host, the ads host and the business host: token refresh, organizations+ad accounts (2 USD accounts:
  one with 1 pixel, one with 2), pixels, public profiles (1), media create/upload/poll (READY after
  `MEDIA_DELAY_MS`), campaigns, ad squads, creatives, ads, campaign GET/PUT; failure knobs by headline
  marker: `FAIL-ADSQUAD` → 400 at the ad squad step, `FAIL-NET` → connection reset at the creative
  step; `GET /__mock/state`, `POST /__mock/reset`) and `_e2e/_adl_snap_smoke.mts` (accounts, keys
  preview, refusal matrix on `/api/snap/launch`, happy wave 2 copies of one card → 2 keys, one media
  upload, campaigns PAUSED→ACTIVE, rows `done/live` with ids and names carrying the keys; fail path →
  campaign left PAUSED, key `retired`, row `error`; net path → `interrupted`; idempotent re-POST →
  `alreadyAccepted`; report join; cleanup: release the smoke's keys and delete its rows).
- Runbook `_e2e/README-snap.md`: the manual setup checklist (Business account + ad account (USD) +
  Public Profile + Snap Pixel; OAuth app in Business Details with the callback URL; `/api/snap/oauth/start`
  to mint the refresh token; Conversions API token → send pixel ID + token to the partner; env list),
  the mock/smoke recipe, and the first LIVE read-only check (`GET /api/snap/accounts`, `/pixels`,
  `/profiles`) — no live launch until the owner says so.

## Decisions
- **Platform tab, own account.** The partner supplies landings, keys and revenue; the campaigns are ours
  on our Snapchat ad account through the Marketing API (owner answer 16.09). No partner rail exists.
- **Registry in `app-cache` rows, not a new collection.** Atomic per-key claim comes free from the
  unique `ckey`; zero server-side schema work satisfies "local only". A dedicated `snap-map` collection
  is a one-module swap later if hs-tools ever needs to read the bindings directly.
- **Campaign born PAUSED, activated last.** Every partial chain is a paused shell — no spend can start
  before the ad exists. "Start paused" keeps it paused for review.
- **Key claimed at fire time by the pump**, previewed on the board (desired-or-next), released when
  nothing was created, retired (kept, with ids) when a campaign exists — the gcm/aif semantics.
- **Media reused across copies** of a card (one upload per account + file per wave).
- **Names carry the key.** Attribution readable from Ads Manager and from LION's report without opening
  the console.
- **No MIN_ROAS, no chunked upload, no Snap stats, no cron auto-mode, no clone/JURO in v1.** Snap
  deprecated MIN_ROAS; 32 MB covers vertical 15–60 s ads; spend/ROI joins come after the first live
  data; the auto-mode is a separate phase on top of this rail.
- **Refresh token lives in env** (`SNAP_REFRESH_TOKEN`), minted through the owner-only OAuth helper;
  no token vault for a single-account rail.

## Addendum 2026-09-18 — any number of creatives per card (owner ask)

The v1 card took ONE creative. A card now takes ANY number; the text above is kept as the record of
v1 and this section overrides it where they differ.

- **Shape on Snapchat:** one card copy is still one campaign on one partner key with ONE ad squad;
  every creative of the card becomes its own `WEB_VIEW` creative + `REMOTE_WEBPAGE` ad inside that ad
  squad, all on the campaign's one landing URL (`…utm_campaign=<key>`). Headline / brand / CTA are the
  card's and shared by all of them. Campaign and ad squad keep the console name; with several
  creatives the creative and ad names are `<name> #N` (N = the file's place on the card), verbatim
  name for a single creative.
- **Wire:** `SnapLaunchShotIn.media: { url, kind, name? }[]` replaces `mediaUrl/mediaKind/mediaName`
  (the route still reads the old single-creative shape as a one-item list). `SnapResolved.mediaIds`
  runs parallel to `shot.media` ("" = a creative the pump skipped); `SnapLaunchWire.ads:
  { index, creative, ad }[]`. No product cap: `SNAP_MAX_CREATIVES = 200` is an abuse guard — Snapchat
  documents no limit on ads per ad squad and the pump's time budget ends an overlong list gracefully.
- **Pump:** the `media` stage uploads the card's files 3 at a time (shared in-flight upload for a
  repeated URL, still once per (account, URL) per wave; a later batch starts only while a fresh
  upload's longest wait fits the budget). After the ad squad: `(creative → ad)` per uploaded file.
  **One bad creative never sinks the campaign:** a failed upload or a 4xx on a creative/ad is skipped
  and named on the row (`creative #2 (file) refused at the creative: …`); an ambiguous outcome is never
  re-sent and ends the loop; past the deadline margin no further unit starts. The campaign is
  activated when at least one ad exists (row `done`, the notes ride in `error` like an activation
  failure does). Zero ads → the v1 dispositions unchanged (nothing uploaded → key released, `error` at
  `media`; campaign exists → key retired, PAUSED shell, `error`/`interrupted`). The row and the key
  binding keep the FIRST ad id; the binding also carries `ad_count`; the row's bid tag reads
  `auto · 5 creatives`.
- **Board:** the creative zone is a wrapping strip of numbered 9:16 frames plus an "add" frame (shared
  `Dropzone` in `portrait` mode, no `maxFiles`); a file that is not 1080×1920 gets an amber frame and
  is listed in one soft note. At launch every file of a card rides to Vercel Blob once (3 at a time,
  progress `n/N`), reused by every copy; a card launches with ALL its files or not at all. The bay
  shows ads per card and the wave's total ads.
- **Review hardening (same day):** the ads loop checks the deadline margin before EVERY unit after
  the first, ads built or not (a list refused unit after unit must never run past `maxDuration`
  with the row still `running`); a refusal about the account or token (401 / 403 / 429) ends the
  loop instead of skipping a file, and so do 5 refusals in a row with nothing built; the stage is
  written for the first unit only (a constant number of store writes however long the list, so the
  terminal row is never queued behind the chain); a refused upload (4xx-class, incl. never READY)
  is remembered for the rest of the wave, a network failure is not; on the done row what the buyer
  must act on (ambiguous outcome, list cut short) rides before the skipped-file notes and Snap's
  sentences are clamped to 140 characters. Board: a failed card waits for its in-flight Blob
  uploads before the wave moves on; the size probe releases its media player and files are probed
  one at a time; the shared Dropzone merges a drop into the list as of NOW (a second drop during
  image recoding no longer overwrites the first). `snapShotMediaIn` (pure, unit-tested) reads the wire.

## Addendum 2026-09-20 — the keys page picks a day OR A RANGE (owner ask)

The keys report was one São Paulo day at a time, picked with two buttons and a native
`<input type="date">` whose calendar the browser draws in the OS language. It is now a date picker
of our own (`components/date-range-picker.tsx`, arithmetic in the pure `lib/date-range.ts`), English
by construction, and both sides of the table answer for a RANGE.

- **Picker:** ‹ › move the day / range by its own length; presets Today … Last month, each showing
  the days it means now, with an "Include today" switch (rolling ranges end today or on the last
  closed day); two months on a wide screen, one on a narrow one, a bottom sheet on a phone; click a
  start and an end (the ribbon previews the range), double-click = that one day; From / To take
  typed days (`2026-09-18`, `18.09`, `18/09/26`, `Sep 18`, `today`); the month title jumps across
  months and years; keyboard — arrows, PageUp/PageDown (Shift = a year), Home/End, Enter picks then
  confirms, Esc steps back, `T`/`Y` inside, `[` `]` `D` on the page. The picker reads no clock:
  "today" is handed in (São Paulo's), days after it and before the rail's first day
  (`SNAP_REPORT_FIRST_DAY` = 2026-09-16) cannot be picked, a range is at most
  `SNAP_REPORT_MAX_DAYS` = 31 days. It works on a draft — nothing is asked until Apply.
- **URL:** the pick lives in the query — a preset stays relative (`?range=last7[&today=0]`), a
  hand-picked range stays its days (`?from=…&to=…`); `page.tsx` reads it for the first paint.
- **Routes:** `/api/snap/report` and `/api/snap/stats` take `?from=&to=` next to the old `?date=`
  (unchanged; Today / Yesterday still go by NAME so the server's clock resolves them). `to` is CUT
  to today and `from` to the first day; junk, a range wholly outside, or one over the cap is a 400.
  Answers carry `from` / `to` (`date` only for a single day).
- **LION side:** a range is its days, read 4 at a time through the per-day cache, each best-effort
  (20 s inside a range, no day started after 35 s): a day LION did not answer for is named in
  `missingDays` and left out of every sum — never a day of zero revenue; only a range with no day
  read is a 502. `mergeSnapReports` (pure): a lone day is returned as LION sent it; several are
  summed, eCPM recomputed from the sums (LION's own definition, checked live), the forecast counted
  for the open day only. Settled days (before yesterday) are cached 6 h instead of 10 min, so ranges
  put LESS load on LION than re-opening single days did. `daily` feeds the board's revenue-by-day
  strip (a click opens the day, "Back to …" returns).
- **Snapchat side:** the range is ONE `granularity=TOTAL` window (first midnight → the midnight
  after the last day) — the same three reads per account as a day. Checked read-only on the real
  API 20.09: a 3-day window equals the sum of its days to the cent. The stats cache key now carries
  the window's END (a day and a range can start on the same midnight). Spend has no per-day strip:
  Snapchat cuts days at the ad account's midnight (Los Angeles), not São Paulo's.
- **Verification:** `tests/date-range.test.ts` (14) + range cases in `snap-report` / `snap-stats`
  tests; `_e2e/_adl_snap_ui_dates.mjs` — 38 browser checks under a RUSSIAN locale (English calendar,
  presets, ‹ ›, keys, typed input, drill-down and back, links, phone sheet, no hydration warnings);
  `_e2e/_snap_range_probe.mjs` — the read-only window probe.
- **Review hardening (same day, before the push):** over a range the row's P/L leaves out what the
  key earned BEFORE its holder claimed it (`revenueBeforeClaim`, pure `snapRevenueBefore`; marked `*`
  with the amount in the tooltip — a key released and claimed again mid-range carries an earlier
  campaign's revenue, while spend is only ever read for the campaign bound NOW; the Spend tile says
  "campaigns bound now" and the footnote spells it out); the report route reads the registry BESIDE
  the LION days, not after them (together they could outlive `maxDuration`); a lone day that is
  "tomorrow" for the server is today (a viewer's clock seconds ahead at São Paulo's midnight);
  letter keys are read by POSITION (`event.code`) — on a Russian / Ukrainian layout the same keys
  send х ъ в е н; Esc / T / Y answer from the document, so they work when focus has left the popover,
  and focus falls back to the dialog when there is no day to land on; ‹ › over the months carry the
  roving day along (the grid always has a Tab stop) and never pull focus off the pressed button; the
  typed-field hint line is always rendered at a fixed height (a line appearing on blur moved the
  grid under a click already on its way); an empty preset names no range and the picked preset is
  the one lit; the popover's edge correction is measured off the unanimated root; `today=0` rides
  with hand-picked days too; Space is left to the button's own click (Firefox). Probed read-only on
  the real API: a 31-day TOTAL window is accepted. Known and accepted: settled days are cached 6 h
  per instance, so a restated old day shows late and two instances can disagree until then.
