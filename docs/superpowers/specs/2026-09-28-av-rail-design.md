# AV (ActiveView) partner rail — design (2026-09-28)

Owner asks 25–28.09: «добавь этого партнера и полностью сделай систему под этого нового партнера» ·
«заходи смотри как работает app.activeview.io … сделай в лаунчере запуски чтобы под него работали,
как под других партнёров. Пока работаем локально только». Decisions taken with the owner 28.09:
**own new FB token** (no env seed), **AV keys like AIF's brand pool but AV's own — stubbed (no
launch possible) until the pool is known/registered**, **Redirect path picked in the card**, scope =
launcher board + **clone board** + **/accounts** assignment. LION is HS-only and has nothing to do
with AV (owner correction 25.09).

## 0. What AV is (live read 28.09, dashboard + external API)

- GAM MCM partner. Our publisher `f8458104-…`, ONE site: `thecadrion.com`, network code
  `2550370616` (parent `198073784`), `delegation_type: MANAGE_PARTNER` (`GET /me`).
- The site is AV-hosted (ActiveHost, Astro "active-press"); ~80 articles live in
  `https://thecadrion.com/sitemap.xml` → `sitemap-pages-1.xml` (niche: government surplus /
  liquidation auctions, paths `cow-long-rec-<slug>[-1-<rand5>]`). An unknown path answers **404**.
  Articles are created by us in Godi Studio (AV's CMS) — new ones appear in the sitemap.
- The page carries **no Meta pixel** — only `scr.actview.net/thecadrion.js`, which reads
  `utm_source / utm_medium / utm_campaign / utm_content / utm_term` (+ fbclid/gclid/ttclid) from
  the landing URL, stores them per session and sends them to GAM as key-values (+ combos
  `utm_campaign_medium`, `utm_campaign_term`, `utm_source_land_uri`) and to AV's CDP.
- **Revenue per campaign = GAM KVP report by `utm_campaign`**, which reports ONLY values
  registered in *UTM Campaign Values* (UI only — manual or file upload CSV/XLSX/TXT, ≤200 values
  per upload, ≤50 KB; no API). 28.09: **0 values registered**. Sessions per any utm key come from
  the CDP (`/report/session/kvp`) without registration.
- **Redirect**: domain `redirect.thecadrion.com` exists in the API (`id cmue7hk5p000ts60oo7x9557n`,
  0 paths), its CNAME points at `redir-ee49…actview.net` which does **not resolve** (NXDOMAIN) —
  the activation wizard sits at step 1 again. Redirect is **not live**. When live: final URL
  `redirect.<domain>/<path>?<our utm>` — AV merges the link's params into the chosen target URL,
  targets/weights change in AV without touching the ad (learning kept), dynamic distribution by RPS.
- Meta/Google accounts are NOT connected in Campaign Analysis. Reports are empty (no traffic yet).
- External API `https://external-api.activeview.app`, Bearer `<64hex>:<20hex>` (Settings → APIs),
  every body wrapped in `{response: …}` except `/healthcheck/`; redirect routes use their own
  top-level keys (`{redirectDomains:[…]}`); 429 honours `Retry-After`; KVP revenue in MICROS.

## 1. What the rail does

AV = a 4th FB partner in the switcher (`PartnerId "av"`, label **AV**), a direct-Graph rail on its
own token — same tree and pipeline as MO/AIF (campaign → ad set → one ad per creative, ≤5
creatives, NDJSON stages, own task manager), with AV's own pieces:

1. **Token**: slots `av.launch` / `av.clone` on /tokens, tokens tagged partner `av`. No env seed:
   an unassigned slot is a clean config error (`no_av_token — assign a token to "AV · Launches"
   on FB tokens`), never another partner's bearer.
2. **Destination** (the card's *Destination* field, stored in `Campaign.landing` as a bare URL):
   - an **article** of an AV site — picked from the live sitemap list (title derived from the
     slug) or pasted; OR
   - a **Redirect path** `https://redirect.<site>/<path>` — picked from AV's redirect list (shows
     its targets + weights); a **New path** form creates one through the API (path + target
     article → `POST …/path {path, fallback}` + `PUT …/mappings [{url, percentage:100}]`).
     A redirect path is offered/launchable only while its domain is LIVE (resolves + answers);
     today it is not, so the card says why and the article remains the way to launch.
   Server truth: the destination is re-resolved on every launch (host must be an AV site from
   `/me` or one of its redirect domains; article → live GET 200; redirect → path exists + domain
   live). Query/hash are stripped — tracking is ours.
3. **Link**: `<destination>?utm_source=facebook&utm_medium={{campaign.id}}&utm_campaign=<key>`
   `&utm_term={{adset.id}}&utm_content={{ad.id}}` — macros literal (FB fills them), key = the
   campaign's AV key. `utm_campaign` = revenue key (registered pool), `utm_medium={{campaign.id}}`
   ties CDP sessions (and `utm_campaign_medium` = `<key>_<campaign id>`) to the FB campaign with no
   registration; term/content = ad set / ad.
4. **AV key pool** (the AIF-brand twin): `av001 … av999` (lowercase — the AV script lowercases
   `utm_campaign`), one key per campaign, atomic claim over the Strapi `app-cache` collection
   (ckey `av-key:<key>`, unique → race-safe, the snap-keys contract: claim-then-verify, release
   when nothing reached FB, retire when a campaign exists). **Launchable range = keys registered in
   AV**: `AV_KEYS_REGISTERED=<N>` (server env) means `av001…avN` are uploaded to *UTM Campaign
   Values*. **Default 0 = the stub**: the card never becomes ready ("AV keys — none registered in
   ActiveView yet"), `/api/av/launch` and AV clones refuse `av_keys_not_registered` before any FB
   write. An owner page **AV keys** lists the registry, releases keys and downloads the upload
   files (`av001…av200.csv`, …) for AV's *Upload file* form.
5. **Delivery**: no pixel on the page → objective **Traffic** (`OUTCOME_TRAFFIC`), optimization
   **Link clicks** (`LINK_CLICKS`, no `promoted_object`), bid strategies lowest cost / bid cap /
   cost cap; min-ROAS and conversions are refused (no conversion signal). Pinned in the card
   (partner locks) and on the server.
6. **Dormant by flag**: `NEXT_PUBLIC_AV_ENABLED=1` (build-time) unlocks the switcher entry, the
   AV task manager and the AV keys page; every `/api/av/*` route answers **404
   `av_rail_disabled`** without it (server twin `avRailEnabled()`). Local only for now.
7. **Clone board**: the MO/AIF clone board serves AV (partner "av"): sources/targets read and
   built with the `av.clone` token, every copy claims a fresh AV key and swaps `utm_campaign` in
   the source link (everything else — destination, macros — kept), ROAS rows refused.
8. **/accounts**: AV rail listed (cabinets of the AV launch token), assignments shared with every
   rail (FB account ids are global).
9. **Fanka fill badges**: hs-tools has no AV scope → AV reports nothing and shows no fill badges
   (volume answers `ok:false, reason:"no_scope"`).

## 2. Units

| Unit | Kind | Purpose |
|---|---|---|
| `lib/av-link.ts` | pure | key codec (`avKeyCode`, `avKeyIndex`, `AV_KEY_RE`, `AV_KEY_POOL_MAX=999`), `avLinkSegments(base,key)`, `avLink`, `swapUtmCampaign(link,key)`, `avDestinationBase(raw)` (normalize/validate a pasted URL shape), `avArticleTitle(path)`, `avKeysUploadFiles(n)` |
| `lib/av-keys.ts` | server, import-free | registry over app-cache `av-key:` — `listAvKeys/findAvKey/claimAvKey/backfillAvKey/releaseAvKey/releaseAvKeyByKey`, pool arithmetic `avFreeKeys/avKeyCandidates/avNextKey(used, registered, desired)` |
| `lib/av-api.ts` | server | AV external API client (`AV_API_KEY`, optional `AV_API_BASE`), bounded fetch + 429/5xx retry, envelope unwrap, `AvApiError`; `avMe`, `avRedirects`, `avRedirectPath`, `avRedirectMappings`, `avCreateRedirectPath`, `avPutMappings` |
| `lib/av-destination.ts` | server | sites (from `/me`, cached), sitemap articles (cached), redirect catalog + domain liveness (DNS + HTTPS probe, cached), `resolveAvDestination(url)` → `{ok, kind:"article"\|"redirect", base, site, pathId?}` \| `{ok:false,error}` |
| `lib/av-launch.ts` | server | `avRail(rail)` bound helpers (AIF-rail twin on `slotOf("av", rail)`), `avRailEnabled()`, `avKeysRegistered()` |
| `app/api/av/launch` | route | the launch (AIF route twin with AV's destination/key/traffic rules) |
| `app/api/av/{adaccounts,fanpages,fanpages/volume,keys,destinations,redirect-paths}` | routes | catalogs, key preview/owner release, destination catalog, new redirect path |
| `app/(app)/av/keys` + board | page | owner AV keys registry + upload files |
| shared edits | — | partners (PartnerId, config, readiness, locks, link, markerPool), token registry (+slots), hs-pages (no AV scope), launch-tasks (scope av), task-manager (AV scope/provider/button), layout, header, launcher-board, campaign-card (AV destination picker + preview + traffic delivery), launch-rail, clone board/run/sources/clone-run, account-access-board, token-vault-board, icons (AV mark), user-menu (AV keys link) |

## 3. Error handling

- Every AV route: session → `avRailEnabled()` 404 → config (token slot / API key) 400/500 → input.
- Launch: all validation (account, page, destination, key registration, media, bid) BEFORE any
  claim; claim order acct-slot → key → FB tree; key released on pre-FB failure, retired (with the
  campaign id) after; task row `partner:"av"` mirrors every stage.
- AV API: 401 → `av_key_rejected`, 403 → `av_forbidden`, 429/5xx retried (≤2, Retry-After ≤10 s),
  timeouts 12 s; the destination catalog degrades per part (sitemap / redirects) with a reason
  instead of failing whole.

## 4. Testing

`node --test` (pure: av-link, av-keys arithmetic + stubbed-fetch claim, av-api envelope/retry with
stubbed fetch, destination resolution, partner readiness/locks/link, token-registry slots, clone
key swap); contract mock `_e2e/_av_mock.mjs` (external API + a fake AV site/sitemap) + route smoke
(`_e2e/_adl_av_smoke.mts`: dormant 404, config errors, key stub refusal, destinations, redirect
path create on the mock, launch refusal paths); headless-Chrome walk of the board / clone / keys /
tokens / accounts pages. No live FB launch (no AV token yet, keys not registered).

## Addendum 30.09 — Platforms pick ("which social the launch runs on")

- **Ask (owner 30.09):** "при заливе на AV выбирать соц, на который будет залив" — and check that the
  TOOL rail allows it. It does: TOOL `CampaignRequest.adsets[].targeting.publisher_platforms`
  (facebook / instagram / audience_network / messenger / threads) + `facebook_positions` /
  `instagram_positions`, status **CONFIRMED** on `/capabilities` (live read 30.09) — no
  `allow_inferred`. Picking the Ads Manager SESSION is not possible: `POST /accounts/{id}/campaigns`
  picks the session and proxy itself (no session field; `additionalProperties:false`).
- **Card (AV only):** Targeting → **Platforms** = Facebook · Instagram · Facebook + Instagram · All
  (auto) (`lib/publisher-platforms.ts`, stored on `Campaign.platforms`; also in Copy settings, AV
  only). **Default = Facebook only** (owner 30.09: «Только фейсбук мне пока что важен») — for a new
  card AND for a card with no pick (older drafts): the card shows the default the server applies. Threads / Messenger / Audience Network are left out — Meta runs them only
  alongside Instagram / Facebook.
- **Wire:** auto = no platforms (Advantage+, what AV launches ran on before the pick). A pick sets `publisher_platforms`; with
  placement FULL every position of the picked platforms runs, with COMPLIANCE only their feeds
  (`facebook_positions:["feed"]` / `instagram_positions:["stream"]`). Same rule on both AV channels —
  TOOL (`buildToolCampaign`, literal twin) and direct Graph (`fb-launch.targeting` via
  `placementPlatformFields`), pinned together by `tests/av-platforms.test.ts`. Only the AV route
  passes the pick (`ToolInputExtras.platforms` / `adsetPayload(…, platforms)`); HS / MO / AIF keep
  their placements untouched. An unknown word → 400 `platforms_invalid` before any write.
- **Not covered:** AV clones (Graph on the AV token) still rebuild placement from the source as
  FULL/COMPLIANCE — a source's platforms are not carried yet.
