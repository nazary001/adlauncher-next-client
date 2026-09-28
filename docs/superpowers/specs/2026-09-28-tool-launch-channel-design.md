# TOOL launch channel — design (2026-09-28)

Owner ask 28.09: «в adlauncher переключать запуски не только на LION и наш FB-токен, а ещё и на HS tools
(tool.gctracking.xyz) и делать запуски через неё — под каждого партнёра». Decisions taken with the owner
the same day: launches **and** clones in v1 (HS JURO on TOOL = next step), TOOL available to **every
buyer**, campaign names carry the marker **`GCL TOOL - `** (GC Launcher · TOOL) on every partner.

TOOL = the HS team's Ads Manager sessions service. API v1 read from `/api/openapi.json` +
`/capabilities` on 28.09 (digest: scratchpad TOOL_LIVE_NOTES; console spec
`2026-09-25-tool-sessions-console-design.md`). The server picks session + proxy from the account id;
we never pick a session.

## 1. UX

- A **channel switch** in the Launch bay for every FB partner:
  HS `LION API | FB Token | TOOL`, MO `FB Token | TOOL`, AIF `FB Token | TOOL`.
  Persisted per partner in localStorage (`adlauncher.hs.channel` keeps working and gains `"tool"`;
  MO `adlauncher.mo.channel2`, AIF `adlauncher.aif.channel` — NOT the retired `adlauncher.mo.channel`).
- The same switch on the clone boards: MO/AIF clone board `FB Token | TOOL`; HS clone board Cloner
  `LION API | FB Token | TOOL` (JURO: TOOL disabled, tooltip "JURO via TOOL — next step").
- TOOL is **ready** only when the server says so (`GET /api/tool/ready`): key configured, key scopes
  include `jobs:write` + `media:write` + `accounts:read`, and ≥1 account that a LIVE TOOL session sees
  is also in this partner's catalog and assigned to this buyer. Not ready → the TOOL segment renders
  disabled with the server's reason as tooltip (e.g. "No live TOOL session sees MO's accounts — an
  owner refreshes/adds one on Ads Manager sessions"). A stale "tool" pick with the rail not ready falls
  back to the partner's default channel at fire time (same rule as HS token today).
- With TOOL picked the **account pickers offer only TOOL-visible accounts** (the partner catalog ∩
  ready.accounts), with the same self-heal that clears a no-longer-offered account/pixel.
  Pages / pixels / locales keep coming from the partner's own catalog (MO/AIF token, LION profile) —
  TOOL has no page/pixel list endpoint.
- **Name marker** `GCL TOOL - ` (constant `TOOL_MARK`):
  - HS: in the TOKEN slot — `[28/09] (ACR) API - (HIGH ADX) - [BR] - GCL TOOL - tail`
    (`hsNamePrefix(..., "tool")`), never together with `TOKEN - `.
  - MO / AIF: right after the partner prefix — `[28/09] (MO) - GCL TOOL - tail`; no `SOC - ` on TOOL
    (SOC marks our social token as signer, which TOOL is not).
  - Clones: after the clone prefix the same way (`[DD/MM] (CLONE) - (tier) - GCL TOOL - …` for MO/AIF;
    HS grammar slot for HS).
  - The server re-ensures the marker (`toolEnsureMark`) — the client's name is never trusted.

## 2. Units and contracts

### 2.1 `lib/tool-launch.ts` — PURE, dependency-free (type-only imports), `node --test`-able

- `TOOL_MARK = "GCL TOOL - "`, `toolEnsureMark(name)` (idempotent; HS grammar → insert after the fixed
  prefix and drop a `TOKEN - ` marker; partner prefix `[DD/MM] (X) - ` (+ optional `(CLONE) - (tier) - `)
  → insert after it and drop `SOC - `; otherwise prepend), `stripToolMark(tail)`.
- TOOL wire types (CampaignRequest, CampaignSpec, AdSetSpec, AdSpec, CreativeSpec, MediaRef,
  TargetingSpec, ConversionSpec, BidSpec, DuplicateRequest, DuplicateTarget, DryRunResult,
  ValidationProblem, MediaOut).
- `ToolBuildInput` — NORMALIZED input (callers do parseMoney / normalizeRoasGoal / bidKind / locale
  resolution / link building): name, objective, budgetUsd (daily, campaign-level = CBO like our Graph
  rails), bidStrategy, bid (`none` | `cap` usd | `roas` coefficient), optimization
  (`conversions`|`clicks`), conversionEvent, pixelId, pageId, countries (ISO-2 or `["WW"]`),
  localeIds, category, placement, ageMin, userOs, adsetStartTime?, creatives[] {name, media MediaRef,
  thumbnail?, primaryText, headline, description?, url, cta}, status (`ACTIVE` launch / `PAUSED` clone),
  accountCurrency.
- `buildToolCampaign(input)` → `{ok:true, body: CampaignRequest, inferred: string[]}` | `{ok:false, error}`.
  Semantics MIRROR `lib/fb-launch.ts` (targeting(), optimizationGoal(), campaignPayload/adsetPayload):
  - CBO: `campaign.budget_type:"CAMPAIGN"`, `daily_budget` USD (NOT cents), `bid_strategy` on the
    campaign; `adsets[0].bid` = `{roas: coefficient}` (NOT ×10000) or `{amount: usd}` (NOT cents).
  - goal: roas → `VALUE`; conversions → `OFFSITE_CONVERSIONS`; clicks → `LINK_CLICKS`.
  - conversion `{destination_type:"WEBSITE", pixel_id, event}` for conversions/roas; event mapped to
    TOOL's enum (`CONTENT_VIEW`→`VIEW_CONTENT`, …); unknown event → refusal by name.
  - targeting: special category → age 18, no genders; gender from placement suffix (HOMEM 1 / MULHER 2);
    COMPLIANCE → `publisher_platforms [facebook, instagram]`, `facebook_positions [feed]`,
    `instagram_positions [stream]`; android → `user_os ["Android"]`; locales → `locales` (INFERRED);
    narrowed (gender or age>18) → `advantage_audience:false`.
  - **WW** → `countries:["US"]` + `raw:{geo_locations:{country_groups:["worldwide"], location_types:["home","recent"]}, excluded_geo_locations:{countries:["TW","SG"]}}` (INFERRED "WW"); explicit lists as-is.
  - bid cap / cost cap → INFERRED; `options.allow_inferred = inferred.length > 0`.
  - status: `campaign.status`, every adset/ad `status` = input.status; `options.activate = status==="ACTIVE"`.
  - refusals (never sent): objective not in {OUTCOME_SALES, OUTCOME_LEADS, OUTCOME_TRAFFIC}; cta not in
    TOOL's enum; account currency ≠ USD; empty creatives; budget < 1; roas ∉ (0, 100]; cap ≤ 0.
- `buildToolDuplicate({sourceCampaignId, accountId, pageId, pixelId, name, budgetUsd, bid?, bidStrategy?, status, startTime?})`
  → DuplicateRequest with ONE target (`copies: 1`, `status`/`ad_status` = status).
- Job reading: `toolJobOutcome(job)` → `pending` | `done {campaignId, adsetIds, adIds, activated}` |
  `failed {error, created?}` (partial/error/unknown/canceled = failed with whatever `result.created`
  holds); `toolStageOf(job, events)` → our NDJSON stage key (see 2.4); `toolFailureText(failure)` →
  one human sentence from ErrorOut/problems (`missing_context` → "No live TOOL session sees account
  <id> — an owner refreshes it on Ads Manager sessions").

### 2.2 `lib/tool-sessions.ts` — transport additions

`createCampaign(accountId, body, {idempotencyKey})`, `createDuplicates(accountId, body, {idempotencyKey})`,
`mediaFromUrl(accountId, "image"|"video", {url, filename?}, {idempotencyKey?})`, `getMedia(mediaId)`.
All through `toolFetch` (timeouts 60 s), header `Idempotency-Key` when given.

### 2.3 `lib/tool-run.ts` — server orchestration (server-only)

- `toolLaunchReady()` → `{ok:true, accounts: ToolAccount[]}` (key + scopes + GET /accounts, status 1
  only, cached 60 s per instance) | `{ok:false, reason, message}`.
- `toolAccountVisible(accountId)` — fire-time check against the same data (force-refresh once on miss).
- `toolRegisterMedia(accountId, items, {deadlineAt, onStage})` → MediaRef (+ thumbnail) per creative:
  `media/{images|videos}/from-url` with our PUBLIC Blob URL (or a source CDN url for clones), then poll
  `GET /media/{id}` until `ready` (or error / deadline). Video custom cover → image from-url →
  `thumbnail`.
- `toolPublish(accountId, body, {idempotencyKey, deadlineAt, onStage})` → POST create (4xx → refusal
  with `toolFailureText`, nothing created), then poll `GET /jobs/{id}` (+events) every ~2.5 s until
  terminal or deadline → `{ok:true, jobId, campaignId, adsetId, adIds}` |
  `{ok:false, error, jobId?, created?, pending?}` (pending = deadline hit while TOOL still works).
- `toolDuplicateOne(accountId, body, {idempotencyKey, deadlineAt, onStage})` → same result shape for the
  single child job of a one-target batch.

### 2.4 NDJSON stages (reuse the existing keys so task managers render unchanged)

`gcm` (our claims) → `video` (TOOL media registered) → `processing` (waiting media ready) → `campaign`
(submitted / queued / draft) → `adset` (fragments) → `creative` (publish accepted) → `ad` (published /
activate). Final `{ok:true, stage:"done", via:"tool", tool_job_id, campaign_id, adset_id, ad_id, ad_ids, …}`
or `{ok:false, stage:"error", error, created, tool_job_id?, pending?}`.

### 2.5 Routes

- `GET /api/tool/ready?partner=br|in|us[&rail=launch|clone]` (any session): `{ok, ready, reason?, message?, accounts: string[]}`.
  MO/AIF: TOOL accounts ∩ the rail signer's token accounts ∩ `filterAccountsFor(session)`; HS: TOOL
  accounts ∩ `filterAccountsFor(session)` (per-profile intersection happens in the card/board).
- MO `/api/launch` and AIF `/api/aif/launch`: body field **`via: "tool"`** (the `channel` field is the
  retired soc switch — do not reuse). Same auth / validation / acct-slot / gcm|brand / link / fanka
  gate / task row as today; the account must additionally be TOOL-visible; the Graph build
  (upload + tree) is replaced by `toolRegisterMedia` + `toolPublish` (status ACTIVE). Name:
  `withPartnerMark` → `toolEnsureMark`, no SOC mark. acct-limit channel `"tool"` / `"aif-tool"`.
  Failure: nothing to pause on Graph (TOOL creates PAUSED and activates last; `pause_on_partial`);
  gcm/brand freed when nothing was created, retired with the TOOL job id otherwise; **pending**
  (deadline) keeps gcm/brand + slot with note `pending tool job #N`.
- MO/AIF `/api/clone/run`: body `via: "tool"`: same per-edit flow up to the link rewrite; media =
  same-account `video_id`/`image_hash` MediaRef, cross-account = `toolRegisterMedia` from the source's
  CDN url; build with `buildToolCampaign(status PAUSED)`; `toolPublish`. acct-limit `"tool-clone"` /
  `"aif-tool-clone"`.
- HS `POST /api/hs/tool-launch` (NEW, NDJSON, modeled on `/api/hs/token-launch` minus the token pool):
  LION catalog validation (profile/account/page/pixel), `hsPageRefusal`, `accountAllowedFor`,
  TOOL-visible account, acct-limit `"hs-tool"`, `hsFinalLink`, adset start +30 min
  (`hsTokenStartTime`), status ACTIVE, task row `gcm:"tool"`.
- HS `POST /api/hs/tool-duplicate` (NEW, modeled on `/api/hs/duplicate` batch envelope + `after()`
  pump): per shot one `POST /accounts/{target}/duplicates` with one target (status ACTIVE, start +30 min),
  `Idempotency-Key` = shot task id; rows run to done/error by the pump. Geo/locale override rows →
  refused by name before anything ("TOOL cannot change geo on a duplicate — use LION or FB Token").

### 2.6 Client

- `components/use-tool-ready.ts` (per partner + rail; refresh 5 min + focus).
- `launch-rail.tsx`: 3-way HS switch, new 2-way switch for MO/AIF (graphRail branch keeps the signer
  badge for FB Token; TOOL shows "Launches through TOOL · N accounts").
- `launcher-board.tsx`: per-partner channel state + persistence; enqueue carries `via`.
- `campaign-card.tsx`: TOOL account filter + name-preview marker.
- `task-manager.tsx`: `LaunchInput.via` / `CloneInput.via` forwarded in the POST body (both launch and
  clone runners); STREAM timeout unchanged.
- `hs-task-manager.tsx`: `HsLaunchChannel` += `"tool"`, kind `"tool"`, NDJSON branch to
  `/api/hs/tool-launch` (same as token), labels.
- `clone-board.tsx` (MO/AIF) + `hs-clone-board.tsx` (Cloner): the switch, TOOL account filter, the
  endpoint for TOOL.
- `auto-launch-modal.tsx`: unchanged (FB token).

## 3. Invariants

- Money to TOOL is USD, ROAS a coefficient. Never reuse `money()` / `hsWireBid` / `roas_average_floor`.
- Every TOOL write carries `Idempotency-Key` = our task id (shot id for HS waves).
- Our registries stay authoritative and wrap every TOOL call exactly as they wrap Graph calls
  (acct-limit 5/30 min spans every channel; gcm / brand; fanka gate + ledger; `/accounts` assignments).
- Launch routes are session-gated (buyers), never `ownerGate`. The key never leaves the server.
- Task rows use the existing columns only (Strapi 400s undeclared attributes).
- No thin `return impl(...)` async wrappers around nullable results (Turbopack const-fold gotcha).

## 4. Known gaps / risks (verify on the first live launch after glo-01 is refreshed)

- The only TOOL session (glo-01) is expired since 26.09 → every call answers `missing_context`
  (probed 28.09: even `dry_run`). TOOL sees only HS accounts (302 GC-HS-VD-C1-BR/LA): MO/AIF stay
  not-ready until a session that sees their cabinets is added on /sessions.
- INFERRED on TOOL: locales, bid cap / cost cap, WW via `raw`. Sent with `allow_inferred`; a refusal
  comes back as TOOL's own words and nothing is created.
- DSA beneficiary/payor (EU / WW reach) has no TOOL field — unknown whether TOOL fills it.
- Duplicate jobs never ran live on TOOL — the child-job result shape is read defensively.
- Prod needs `TOOL_SESSIONS_API_KEY` in the Vercel env (not set) — until then `ready:false` everywhere.

## 5. Addendum 28.09 — as built (implementation + seven-lens review)

- **Outcome rule (core, `runToolPublish` / `runToolDuplicate`).** A 4xx on SUBMIT (or a 2xx with
  `problems` and no job id — the `missing_context` shape) = clean refusal, nothing created. After TOOL
  accepted the submit every failed status read (429 with backoff up to 10 s, 404, 401/403, 5xx,
  network) keeps polling; the deadline → `pending`. Terminal `error` / `canceled` without ids =
  definite failure (routes free the acct slot + gcm/brand). `partial` / `unknown` without ids and
  `done` without a campaign id = `pending` (routes keep slot + marker with a `pending tool job #N`
  note). `onSubmitted(jobId)` fires once on accept.
- **Disconnect safety.** On the TOOL path the NDJSON `send` swallows enqueue errors (a closed tab
  never unwinds into the cleanup catch); the Graph path still throws as before. A throw after the
  submit with no campaign id known is settled as pending by the shared catch (belt), never a freed
  marker. Pending rows are terminal (`error` + note) on every rail; the clients read `pending:true`
  and offer no Retry.
- **Stages.** MO/AIF/clone emit the existing stage keys (gcm → video → processing → campaign → adset →
  creative → ad); HS tool-launch emits token-launch's keys (submit / campaign / adset / ads).
- **HS tool-duplicate.** Body identical to token-duplicate; rows stamped like token-duplicate
  (`kind duplicate`, `lionTaskId ""`); cap 20 shots per wave (client + server); acct-limit precheck
  after the wave-idempotency short-circuits; non-USD target refused; `status`/`ad_status` ACTIVE with
  start +30 min, and a child job that fails while reporting a campaign is paused through LION
  (`lionSetCampaignStatus`), the row says whether the pause landed. Path account = the TARGET
  account (to confirm on the first live wave).
- **MO/AIF clone board on TOOL** offers only concrete TOOL-visible accounts (no "From each source":
  the client cannot prove the source account is TOOL-visible); the server's `toolAccountVisible`
  stays the final gate.
- **HS TOOL launch** accepts paste-URL images (TOOL pulls the URL itself); the token rail keeps its
  own-Blob fence.
- **Media** carries no Idempotency-Key on launches (TOOL content-addresses media); clone media uses
  `<taskId>:media`; every campaign create / duplicate carries the task / shot id.
