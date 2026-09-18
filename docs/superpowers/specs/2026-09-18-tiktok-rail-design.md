# TikTok rail — launch, clone and JURO through LION's tiktok-weapon

**Date:** 2026-09-18 · **Status:** built + verified locally (unit 65, route smoke 75/75 on the production bundle, browser run incl. the queued-row guard, dormancy 28/28, live-launch guard 7/7; code review done — 1 critical / 4 important / 8 minor: all fixed except two deliberate leftovers — a JURO of a Min-ROAS source still tags its value as a bid (cosmetic; the clone board hints to pick Min ROAS explicitly), and the same wave-claim shape in the DEPLOYED lib/google-wave.ts was left untouched for a separate, owner-approved change) — NOT deployed, no live launch made · design approved by the owner (scope, accounts, row outcome, assets) · **Branch:** `feat/tiktok-rail` — local only, never pushed (a push to `main` auto-deploys on Vercel).

## 1. Goal

The header's TikTok tab has been a disabled "in development" pill since the console was born. This rail makes it real: a buyer launches fresh TikTok campaigns (classic and Smart+), clones an existing campaign onto any launchable advertiser, or JUROs it on its own advertiser — all through the HS partner's `tiktok-weapon` external API, the sibling of the `google-weapon` API the Google rail already drives. The rail is the Google rail's twin in architecture, conventions and safety rules; it differs only where the partner contract differs.

## 2. Partner contract (docs + read-only live probes, 2026-09-18)

Host `https://tiktok-weapon.highstakes.tech`, bearer = `LION_TOKEN` (also accepted as `x-api-key`). Every path ends with `/`.

| Call | Notes |
|---|---|
| `GET /api/external/advertisers/` | **Live: 235 advertisers, 169 `launch_eligible`, all USD**, 5 Business Centers. Fields: `advertiser_id, name, status, currency, country, timezone, role, owner_bc_id, launch_eligible`. ~0.3 s. |
| `GET /api/external/advertisers/{id}/config/` | `pixels[{pixel_id, pixel_code, supported_modes[]}]`, `locales.countries[{country_code, region_id, region_name}]` (82), `locales.languages[{code, name}]` (42). Live: one pixel `CGUJ36RC77U0HA6062A0` with all four modes on both probed accounts. 403 when the advertiser is not allowed / not eligible. |
| `POST /api/external/campaign/launch/` | Fresh launch → `201 {ok, status:"pending", taskId, client_reference?, postback_secret?}`. Budget min `20.00`; `targeting` is refused; landing must be on LION's allowed domains (the 400 lists them). |
| `POST /api/external/dataset/fetch/` | `{campaign_id}` → `202 {ok, runId}`; 404 = LION never saw the campaign. **There is no dataset status endpoint** (Google has one). Completes in 30–120 s. |
| `POST /api/external/clone/launch/` | `source_campaign_id, budget, pixel_code, name_suffix` required; `advertiser_id`, `mode` (adds `WARM_UP`) optional; `conversion_bid_price` when the final mode is `NORMAL_WITH_BID`, `roas_bid` when `VO_MIN_ROAS`. 404 = source not fetched. A Smart+ source clones as Smart+. |
| `POST /api/external/juro/launch/` | `source_campaign_id, budget` required; `conversion_bid_price` when the source mode is `NORMAL_WITH_BID` **or** `VO_MIN_ROAS` (one field for both); `name_suffix` optional. Always the source's advertiser. Smart+ sources are not supported. |
| `GET /api/external/tasks/{id}/` | `kind: launch|clone|juro`, `status: pending → running → completed|failed`, `campaign_name, campaign_id, adgroup_id, ad_ids[], error_message, error_step, created_at, updated_at`. A launch takes 1–3 min. |
| Asset uploads (`assets/videos/upload/`, `assets/identity-image/upload/`) | **Not used** — owner decision: files ride Vercel Blob and the wire carries their public HTTPS URLs (the contract allows it). |

Money: decimal **strings** in USD (`"20.00"`, `"0.15"`); `roas_bid` is a multiplier string (`"1.20"`).

**Team facts read from LION's TikTok metrics** (`GET lion…/api/tiktok/campaigns/metrics/?date=`, 1612 rows/day, ~1.6 s): row = `campaign_id, campaign_name, campaign_status (ENABLE|DISABLE|DELETE), delivery, campaign_budget, campaign_bid, landing_page_url, account_id, account_name, account_currency`. Name grammar LION builds:

```
{HS-xxxx} (GLO-01) [<cl>|<GEO,GEO>|<LANG or ALL>] (<landing path>)[ (CLONE_FROM=<id>)| (JURO_FROM=<id>)][ | Smart+[ CBO]] | <name_suffix>
```

The team's suffix is `DD.MM - <Buyer> - <tail>`; budgets are $20 (97 %), bids $0.10–0.90; landing paths look like `ht/age-gate/digital-marketing/en/` on ~40 rotating LION domains.

## 3. Decisions

1. **Scope:** Launch (classic + Smart+) + Clone + JURO.
2. **Accounts:** every `launch_eligible` advertiser is offered and accepted; anything else is hidden and refused server-side by the same predicate (`isTiktokLaunchAccount`), which also carries an empty `TIKTOK_HIDDEN_LAUNCH_ACCOUNTS` set for future owner asks.
3. **Row outcome:** LION's 201 makes the row terminal at once — `done / sent` ("Sent to LION", Google/HS parity, nobody is left `running`). The pump then **settles**: it polls the partner task and upgrades the row to `done / created` with the real `campaign_id` + `campaign_name`, or flips it to `error / lion` with `error_step: error_message`. A task that outlives the settle window simply stays "Sent to LION"; the row owner's open task manager asks `/api/tiktok/status`, and the SERVER upgrades the row there (only the caller's own row still at stage `sent`; 3 h limit). There is no client upsert route — `/api/tiktok-tasks` is GET + DELETE only.
4. **Assets:** browser → Vercel Blob → public URLs. The identity avatar is centre-cropped to a 256×256 PNG in the browser before upload (what the partner's own upload endpoint would have produced).
5. **Dormant on prod:** `NEXT_PUBLIC_TIKTOK_ENABLED=1` lives in `.env.local` only. Without it the tab stays the disabled pill, `/tiktok*` redirects to `/`, every `/api/tiktok*` answers 404 `tiktok_rail_disabled`.
6. **Live-launch guard** (the 14.09 Google incident must not repeat) — an ALLOWLIST, so no spelling of the partner's host (a trailing dot, an IP, a staging alias, a proxy) slips past: a launch POST goes out freely only to a LOOPBACK base (the contract mock); any other base is live and is reached only with `VERCEL_ENV === "production"` or `TIKTOK_ALLOW_LIVE_LAUNCH=1`. Checked twice — the wave routes answer `403 tiktok_live_launch_blocked` before the body is read, and the client refuses with zero network calls; launch POSTs never follow a redirect. A local instance pointed at the live host can read everything and launch nothing.

## 4. Architecture

Pure, dependency-free modules (run straight under `node --test`) hold every decision; thin server modules bind I/O.

| File | Responsibility |
|---|---|
| `lib/tiktok-launch.ts` | Modes, money/ROAS parsing, `tiktokBidPlan`, naming (`tiktokNameSuffix`, head preview, full preview), landing base + tracking-tail preview, geo/language wire, CTA vocabulary, Smart+ rules, **the one validator `tiktokLaunchWire`**, clone/JURO wire builders, error wording, task ids, the account predicate, task→row disposition (`tiktokTaskOutcome`). |
| `lib/tiktok-source.ts` | LION metrics row mapping, name parsing (`[cl\|geo\|lang]`, landing path, source marker, Smart+ tag), landing suggestions ranking. |
| `lib/tiktok-pump-core.ts` | The wave algorithm with injected deps: submit exactly-once, launch-first dataset handling, settle. |
| `lib/tiktok-weapon.ts` | HTTP client: reads with one retry, launches ONE attempt, advertisers cache (10 min), per-advertiser config cache (10 min), dataset fetch, tasks, rail + live-launch gates. |
| `lib/lion-tiktok.ts` | LION TikTok metrics per São Paulo day (10-min cache), id lookup scanning D0…D-6. |
| `lib/tiktok-pump.ts` | Binds pump-core to the client + the task-store writer. |
| `lib/tiktok-wave.ts` | Route handlers' shared body: session → gates → validate every shot → stamp rows → claim the wave (`tiktok-wave:<id>`, fail closed) → `after(pump)` → answer. |
| `app/api/tiktok/{advertisers,config,sources,dataset,landings,launch,clone,juro,status}/route.ts`, `app/api/tiktok-tasks/route.ts` | Thin routes. Store partner code **`tt`**; `/api/launch-tasks` (MO scope) excludes it. |
| `app/(app)/tiktok/page.tsx`, `app/(app)/tiktok/clone/page.tsx` | Launcher and Clone·JURO pages (`?ids=&mode=` deep link like Google). |
| `components/tiktok-{nav,launch-board,launch-card,clone-board,task-manager}.tsx`, `components/use-tiktok.ts` | UI. `header.tsx` gains `platform="tiktok"` (partner switcher pinned to HS, TikTok queue button); the layout mounts `TiktokTaskManagerProvider`. |

Store columns reused like Google: `link` = partner task id, `gcm` = `t-launch|t-clone|t-juro`, `adset_id` = advertiser id, `ad_id` = currency, `bid` = tag (`bid 0,46` / `ROAS 1,2` / `auto` / `max value` / `warm-up` / `inherit`). Task ids `ttl-/ttc-/ttj-<wave>-NN`. `TIKTOK_MAX_SHOTS = 45`.

### 4.1 Wire rules (`tiktokLaunchWire`)

- `budget` 20…10000 → `"20.00"`. `mode` required; `conversion_bid_price` (0 < bid ≤ 100, and bid < budget) only with `NORMAL_WITH_BID`; `roas_bid` (0.01…1000, 2 places) only with `VO_MIN_ROAS`; a value typed under a no-bid mode is a refusal, never silently dropped. `VO_*` only when the pixel lists it.
- `landing_page_url`: https, query + hash stripped (LION appends its own tracking); `identity.name` 1–100 chars, `identity.image_url` https; `creative_data.title` 1–100; CTA from the TikTok vocabulary; `video_urls` 1–20 distinct https.
- `locales.countries`: codes from the advertiser's config or exactly `["WW"]`; `locales.language` from the config, required with `WW`, lower-cased.
- Smart+ (`campaign_kind: "smart_plus"`): `budget_level` campaign|adgroup, `ad_texts` 1–5 distinct ≤100 with `[0] === title`, `call_to_actions` 1–3 distinct with `[0] === call_to_action`; any of the three without Smart+ is a refusal.
- `name_suffix` = `DD.MM - <user> - GC-Launcher[ - <tail>]` (São Paulo date, pipes in the tail replaced, cap 80); `client_reference` = our task id. `targeting` and `postback_url` are never sent.
- Clone: `mode ""` = inherit → a typed bid rides as `conversion_bid_price` (the partner never inherits a bid); explicit mode follows the launch rules (+`WARM_UP`, no value). JURO: no mode, optional bid → `conversion_bid_price`.

### 4.2 Pump (`runTiktokPump`)

One shot at a time, 1–3 s jitter, inside `TIKTOK_PUMP_BUDGET_MS = 770 000` with a 100 s margin — the slowest chain a shot admitted at the margin may still need is its submit (60 s client timeout) plus a cold source's dataset fetch (30 s, one attempt inside the pump), and a function killed past `maxDuration = 800` would leave the outcome unrecorded. Task reads inside the pump are one 15 s attempt.

- **201** → row `done/sent` + partner task id.
- **404 on clone/JURO** = "source not fetched" (a clean refusal, nothing was created, so a retry is safe): `dataset/fetch` once per source per wave → wait 30 s → re-submit every 20 s, re-trigger the fetch once after 150 s, give up after 270 s (or at the deadline margin) with a sentence that names the wait. A 404 from the **fetch** itself ("LION never saw this campaign") fails every shot of that source. A source proven ready is not re-fetched for its remaining copies.
- **Other 4xx** → the partner's sentence on the row; identical copies of the same board row (same wire) skip with the same sentence.
- **5xx / network** → `interrupted`, "the task may exist", **never re-sent**.
- **Settle:** sent tasks are polled every 10 s (≤5 in flight) — while a cold source is waited out, and after the last submit for up to 6 min or until the deadline margin; `completed` → `done/created` + `campaign_id` + real name; `failed` → `error/lion` + `error_step: error_message`; unknown reads never downgrade a row.

### 4.3 UI

`/tiktok` — rebuilt 18.09 on the owner's word to mirror LION's own TikTok "Campaign Launcher" field-for-field (the move made for the Google launcher on 14.09). Board: header **Campaign Launcher · Autofill · + · −** (Autofill = N whole copies of card 01 with tickable fields, 1–20; + appends a copy of the last card; − deletes the last card), cards (duplicate / remove / collapse), sticky Launch bay (readiness rows, total/day, Preview → Launch). ONE card = ONE campaign — there is no per-card copies multiplier, and the card cap (45) is the server's wave cap. Copies keep their files' ids, so N copies upload the avatar and videos once (`hostedRef`). A card that was queued is NOT ready again until it is edited; it keeps its files.

Card, in LION's order: **row 1** Advertiser · Pixel · Budget (unit suffix; a **CBO** checkbox appears only under Smart+) · Mode (native select with the RAW mode names; a VO mode the pixel can't run reads `(not allowed)` and is disabled) with its bid / ROAS value in the same group → **row 2** Landing URL (datalist of the team's live landings + final-link preview + Copy) → **row 3** Campaign Name (view only: LION's head, read-only, + the custom tail) · MOSH (`false` / `true`) · Smart+ (checkbox) → **left column** Ad Text (one field; under Smart+ up to 5 texts separated by `|`, the first is the main one) · CTA (LION's own 21-value list in its order; under Smart+ a multi-pick of up to 3, the first is the main one) · Identity Name · Identity Image (read-only file name + **Upload** + **Generate** + round preview; remembered identities as chips) — **right column** the creatives zone (1–20 videos, portrait 9:16 tiles) with "N video(s) uploaded" → **bottom row** Countries (the advertiser's own list + Worldwide) · Language ("without language segmentation" default) · Flag · Gender · Age. LION's behaviours ride along: every field but Advertiser is `inert` until an advertiser is picked; every field has a ✓ that lights when it is filled; Smart+ hides Gender / Age. **Flag, Gender and Age are shown LOCKED** (`none`, `GENDER_UNLIMITED`, `AGE_18_100 (AUTOGEN)`): the external API fixes the audience and takes no special-industry flag — the structure is LION's, the card never promises what the wire can't carry. Removed against the first cut: geo presets, the copies stepper, the URL-mode toggles for the avatar / videos, the separate Smart+ panel, the mode hint lines.

Generate = `POST /api/tiktok/identity-image {name, hint?}` → Gemini 1:1 1K emblem (no text, no people) returned as base64; nothing is hosted — the image joins the card exactly like an uploaded file and is cropped to the 256² PNG and uploaded only at launch. `lib/gemini.geminiImage` took an optional `frame` for this (the Auto-launch creative keeps its 16:9 2K default). The readiness dot is `tiktokLaunchWire` itself run on placeholder URLs (`tiktokDraftShot` maps the card: classic = the Ad Text whole + the first CTA, Smart+ = piped texts / CTAs / `budget_level` from CBO), so the card can't disagree with the server. Files upload to Blob 3 at a time at launch; the unload guard is mounted only then.

`/tiktok/clone` — the Google clone board's shape: paste ids / `?ids=&mode=clone|juro`, source facts from LION metrics (name, status, account, budget, bid, geo/lang/landing from the name, Smart+ tag), dataset pre-warm on add + per-row re-fetch, wave-level destination (advertiser + pixel) with per-row override, mode override, bid prefill from the source (all accounts are USD), budget, copies, suffix tail, name preview, JURO pinned to the source's advertiser and refusing Smart+ sources.

Task manager — the Google drawer's twin, but it adds no standing load to the shared store (it polls only on a TikTok page, with the drawer open, or while a build it knows about is moving): shared team view, owner authority, stage labels `Sending → Sent to LION → Created · cmp <id>` / `Failed at <step>`, copy campaign id, client finisher for the owner's own sent rows.

### 4.4 Wave claim (what makes "exactly once" hold across requests)

`acceptTiktokWave`: an in-process in-flight set taken before the first await (a twin request gets `409 wave_in_progress` and can never stamp over rows a pump already advanced) → the claim row is read with a read that distinguishes "absent" from "store unavailable" (unavailable = `503`, nothing stamped) → a prior claim with the same shot count answers `alreadyAccepted`, with another count `409 wave_content_changed` → rows are stamped 8 at a time (no row written = nothing fired) → the claim is POSTed with a nonce and the shot count, then EVERY row under the key is read back oldest-first: the oldest row is the one winner (`tiktokClaimVerdict`). That read-back tells "my write landed after its timeout" (pump) from "a twin won" (alreadyAccepted) and closes Strapi's unique-key TOCTOU window; "unknown" (neither the POST nor the read got through) sends nothing and rewrites nothing.

Boards: the wave id is cut from the READY set and a wave goes out whole or not at all (a failed upload sends nothing; hosted files are cached for the retry), cards are locked while a wave uploads and fires, a queued card / clone row leaves the fireable set until it is edited, and a lost answer says "may have been accepted — check the Task Manager; firing again WITHOUT edits is safe".

## 5. Error handling

Every refusal is a sentence that names the fix and, in a wave, the shot (`shot 3: …`). Partner 4xx bodies are surfaced verbatim (`error`, `hint`, `allowed_domains`/`available_pixels` lists appended). Store unwritable → the wave is refused before anything fires (`503 …_wave_not_fired`). Catalog unreachable → 502 with the partner's sentence, the board offers Retry. LION metrics down → sources come back `known:false` and launching still works (the partner is the real gate).

## 6. Testing

- `tests/tiktok-launch.test.ts`, `tiktok-source.test.ts`, `tiktok-pump-core.test.ts`, `tiktok-partner.test.ts` (client parsing with a stub fetch + the live-launch guard) — `node --test`.
- `_e2e/_tiktok_mock.mjs` (:3197): the full contract with a fixture cut from the live advertisers list, dataset that becomes ready N seconds after a fetch, task lifecycle, knobs by `name_suffix` (`FAIL-400`, `FAIL-NET`, `FAIL-BUILD`, `SLOW`). `_e2e/_adl_tiktok_smoke.mts` drives every route against `next start` with `TIKTOK_WEAPON_BASE` on the mock.
- Browser run of both boards through the session proxy; `tsc`, `eslint`, `next build`; final code review.
- **No live launch.** Live traffic in this work is GET-only (advertisers, config, LION metrics).

## 7. Out of scope

Postback webhook (`postback_url`) — polling covers all three kinds uniformly; partner upload endpoints; per-advertiser launch pacing; editing live TikTok campaigns (status/budget/bid endpoints exist on LION and can become a follow-up).
