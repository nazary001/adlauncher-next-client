# HS partner — campaign launches through the LION API

2026-08-10 · status: approved by owner brief (build locally first, no deploy)

## Goal

Enable the **HS** partner (Brazilians / High Stakes) in adlauncher. Launches go through the
**LION REST API** (`https://lion.highstakes.tech`) — *not* a Facebook token. The flow mirrors the
partner's own `/weapon/` launcher form (profile → account → page → pixel, title/copy/CTA/link,
redirect type, geo/locales/category/placement/age/OS) but lives in adlauncher's cockpit UI with its
wave features (duplicate-all, copy-to-all, apply-creative-to-all).

Key differences from the MO (Indians) flow:

- **No gcm codes, no landing catalog** — HS runs its own landings/redirects; the buyer types the
  destination link, LION appends its own tracking (`url_tags` auto-built server-side from
  `redirect_type`).
- **No Graph API calls** — one POST to LION creates a *launch task*; their weapon tasker builds
  campaign → adset → ads on their side.
- **Independent Task Manager** — HS submissions get their own queue/drawer. A task uploads the
  creatives (Vercel Blob → public URLs), submits to LION, then **polls LION's creation-status**
  until the campaign exists (or fails). It never touches the MO task manager or its Strapi rows.

## LION contract (from the partner's docs + verified memory)

- Auth: `Authorization: Bearer <LION_TOKEN>` (same token as the audit pipelines; ACR-bound).
- `GET /api/facebook/profiles/list/` → `{profiles:[{slug,name}]}` (names double-encoded cyrillic —
  we display slugs only).
- `GET /api/facebook/profile/data/?profile_slug=` → `{data:{accounts:[{id:"act_…",name,currency,
  status}], pages:[{id,name}], locales:[{id,name}]}}` (status = FB account_status, 1=active).
- `GET /api/facebook/profile/account/pixels/?profile_slug=&account_id=act_…` → pixels.
- `POST /api/facebook/campaigns/create/` → body `{profile_slug, account_id, page_id, pixel_id,
  campaigns:[{campaign_name, creatives:[url…], title, copy, cta, link, daily_budget(cents), bid,
  bid_strategy, objective, conversion_event, age_min, position, country_codes, locales:[{name,id}],
  category, redirect_type, url_tags:"", user_os, start_time:null}]}` →
  `{creation_results:[{result:"success", task_id} | {result:"error", reason}]}`.
- `POST /api/facebook/campaigns/creation-status/` → `{tasks:[{task_id, campaign_id, adset_id,
  ad_ids, campaign_name, status, error}]}`; status: `PENDING → CREATING_CAMPAIGN → CREATING_ADSET →
  CREATING_ADS → COMPLETED`, terminal negatives `NO_COUNTRIES_LEFT`, `NOT_FOUND`. A non-null
  `error` beside an in-progress status = last retryable failure (their tasker retries).
- **Campaign name is validated server-side**: `[DD/MM] (ACR) API - (REDIR_LABEL) - [CODES] - <text>`;
  ACR must match the token's user; CODES must equal the body's `country_codes` (order-insensitive).
  Redirect labels: `HIGH ADX → #ADX [HIGH]`, `META ADX → #ADX [META]`, `#ADX → #ADX`.
- Money on write = **integer cents** of the account currency. Bids are **Meta-native and passed
  to the Graph verbatim** (corrected 2026-08-12 after the 08-10 live failures): cap strategies =
  integer cents, `LOWEST_COST_WITH_MIN_ROAS` = ROAS floor **× 10000 as an integer** (0.34 →
  3400 — Meta's `bid_constraints.roas_average_floor`). ~~bid = ROAS decimal~~ was wrong: a
  decimal wedges the task at CREATING_ADSET ("roas_average_floor … not valid" retry loop);
  LION's own weapon UI scales the human decimal client-side. Conversion event still forced
  PURCHASE for MIN_ROAS (weapon parity). Reads stay major/decimal (details 2.45 == metrics 2.45).
- Dates in `America/Sao_Paulo` — the `[DD/MM]` prefix uses that timezone.

## Architecture

### Server

- **`lib/lion.ts`** — server-only client. Env: `LION_BASE` (default the prod host), `LION_TOKEN`,
  `LION_ACR` (e.g. `GLO-01`; the launch route refuses to run without both). `lionGet/lionPost` with
  small retry on network/5xx. Module-level TTL caches (10 min): profiles list, profile-data per
  slug, pixels per (slug, account). Cache also serves the launch route's bind validation.
- **`lib/hs-launch.ts`** — pure builders (unit-tested): São Paulo `DD/MM`, name prefix/full name,
  `WW → ["WORLD"]` mapping, create-payload builder (cents; bids via `hsWireBid` — Meta-native
  integers, see the contract note above; locales pairs, `url_tags:""`), campaign validation
  (`hsCampaignError`).
- **Routes** (all Node runtime, proxy-gated + inline session check):
  - `GET /api/hs/profiles` → `{ok, acr, profiles:[slug…]}`
  - `GET /api/hs/profile-data?slug=` → `{ok, accounts, pages, locales}`
  - `GET /api/hs/pixels?slug=&account=` → `{ok, pixels}`
  - `POST /api/hs/launch` `{campaign, creatives:[url…]}` → validates campaign + binds against
    cached LION data (account must exist on the profile **and be active**, page on the profile,
    pixel on the account), builds the name + payload server-side, POSTs one-campaign create,
    returns `{ok:true, lionTaskId, name}` or `{ok:false, error}`.
  - `POST /api/hs/status` `{taskIds}` → proxied creation-status, camelCase-mapped.

### Client

- **`lib/partners.ts`** — `br` partner enabled (`inDevelopment` removed), new `lionLaunch: true`
  flag. `launchReadyOpts` requires profile/account/page/pixel + link + ad text (title & copy) for
  lion partners; no landing/gcm.
- **`components/use-hs.ts`** — hook: profiles+ACR fetch (retry like `useAdAccounts`), per-slug
  profile-data map, per-(slug,account) pixel map, `ensureProfile/ensurePixels` idempotent loaders.
  Account options tag non-active accounts (`disabled`, danger) and sort active first.
- **`components/campaign-card.tsx`** — HS branch:
  - Setup: Profile/Account/Page/Pixel cascade from the hook (profile change resets account, page,
    pixel and locales).
  - Name: **dynamic locked prefix** `[DD/MM] (ACR) API - (label) - [codes] - ` computed from
    redirect type + geo (placeholders while empty); the user edits only the suffix. The server
    rebuilds the same name authoritatively.
  - Delivery: Optimization hidden (MO concept); bid strategies + `LOWEST_COST_WITH_MIN_ROAS`;
    the bid field relabels to "ROAS goal" for MIN_ROAS (reuses `bidCap`; `1,20` = 120%);
    MIN_ROAS pins the conversion event to Purchase.
  - Creative: Title/Copy/CTA/Link + redirect type; param-mode/headline/High-offer hidden;
    multi-creative dropzone (one ad per creative, LION-side) + **Add by URL** row (public
    creative URLs, e.g. renders from the creative studio, skip the Blob upload).
  - Targeting: Languages = the profile's own locale list (FB locale ids); geo/category/placement/
    age/OS unchanged.
- **`components/hs-task-manager.tsx`** — independent provider + drawer + header button (button
  rendered only while the HS partner is active; provider mounted in the `(app)` layout so the
  queue survives navigation).
  - Stages: `upload → submit → queued@LION → campaign → ad set → ads → done`.
  - Worker: single-flight, 2s gap. Upload blob-URL files to Vercel Blob (https URLs pass through),
    POST `/api/hs/launch`, then hand off to the poller.
  - Poller: one batched `/api/hs/status` call for all non-terminal LION tasks every 8s (drawer
    open) / 20s (closed); maps `COMPLETED → done` (campaign id + ad count),
    `NO_COUNTRIES_LEFT/NOT_FOUND → error`; a non-null error on an in-progress task shows as a
    warning note (their tasker retries). Safety net: after 60 min of polling a task is marked
    "unknown — check LION" (warn, non-retryable).
  - Persistence: `localStorage` per user. Submitted tasks survive reload (the LION task id is the
    durable handle — polling resumes). Not-yet-submitted tasks restore as interrupted (their blob
    inputs died with the session). No Strapi/team-shared view in v1 (deliberate — independent).
- **`components/launcher-board.tsx`** — `launch()` branches: HS partner → enqueue into the HS
  task manager (campaign snapshot + all media files); MO path untouched.
- **copy-settings-modal** — works as-is for HS via existing `when` guards; `optimization` and
  `headline` rows hidden for lion partners.

### Creative files

Blob uploads reuse `/api/blob-upload` (paths `creatives/hs-…`). Uploaded blobs are **kept** (unlike
MO): LION's tasker fetches the URL asynchronously and re-fetches on retries — deleting early would
break the launch. Housekeeping of the Blob store is a follow-up.

## Decisions / trade-offs

- **One LION create call per card** (not batched): per-card errors stay precise, and cards can
  carry different profile/account/page/pixel binds. No documented LION rate limit; 2s gap.
- **Server re-derives the campaign name** from the same builder the preview uses — the `(ACR)` and
  `[CODES]` segments can never drift from the body.
- **Non-active accounts are rejected server-side** (and tagged in the picker) — a launch task fired
  into a disabled account dies invisibly on the weapon side, better to refuse early.
- **No Strapi persistence for HS tasks in v1**: the owner asked for an independent, submit-and-show
  manager; the durable state (post-submit) lives in LION and is recoverable by task id from
  localStorage. Team-shared visibility can be layered on later like the MO manager.
- **ACR from env** (`LION_ACR`), verified against live data during testing (mine-only metrics all
  carry `(GLO-01)`). Wrong ACR → LION rejects with a clear per-campaign reason.

## Testing

1. Unit (tsx): name/prefix builder, payload builder (cents, Meta-native bids — ROAS ×10000 /
   cap cents, WW→WORLD, locales, category/user_os passthrough), validation matrix.
2. Mock-LION E2E: local mock server (scratchpad) + dev server with `LION_BASE=http://127.0.0.1:…`;
   minted `adl_session` cookie; full launch + every bind-validation branch + status polling.
3. Live read-only against real LION: profiles / profile-data / pixels through `/api/hs/*`
   (real token, no launch fired).
4. `tsc`, `eslint`, `next build`; Playwright UI smoke (switch to HS, cascade pickers, launch a
   card against the mock, drawer reaches done).
