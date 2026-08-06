# Clone existing campaigns — design (2026-08-06)

Duplicate already-live campaigns from the stats tool into the launcher. Indians only for now;
architected multi-account-ready. Phase 1 (this doc's deliverable) is **UI only**.

## Flow

1. The stats tool's **Clone** button opens `/clone?partner=in&ids=<fbCampaignId>,...` — it passes
   **only campaign ids** (see `docs/clone-link-contract.md`).
2. `/clone` pulls each campaign's real values from Facebook by id (name, geo, budget, bid/ROAS,
   creatives, targeting) — phase 2. Phase 1 uses a mock loader with the same signature.
3. Buyer reviews/edits the rows (name, ROAS goal, budget, targeting, high offer) + global settings
   (target account, user OS, number of copies), hits **Generate Preview**, then **Duplicate**.
4. Duplicate creates N copies per campaign — reusing each source's `video_id` (no re-upload),
   fresh gcm per copy, PAUSED, through the existing launch pipeline — phase 2.

## Why "only ids"

The stats tool passes ids; the launcher fetches everything else from FB. Facebook stays the single
source of truth (nothing to keep in sync), the link stays tiny, and Indians are pinned to one
account so no account context is needed. Fetch uses the same Graph token as `/api/launch`
(`act_1297336295903991`).

## Data model — `lib/clone.ts`

- `CloneSource` — read-only campaign pulled from FB (the "original" side of a row).
- `CloneRow` — the editable clone layered on a source: `name`, `roasGoal`, `budget`, targeting
  (`countries/locales/category/placement/ageMin`), `redirectType`, `highOffer`.
- `CloneTarget` + `CLONE_TARGETS` — creation bind (account/page/pixel). **One Indians entry today;
  the array is the multi-account seam** — add entries and the Settings selector switches from a
  locked read-only bind to a dropdown automatically (`targets.length > 1`).
- `CloneSettings` — global: `targetId`, `userOs`, `copies`.
- `loadCloneSources(ids, partner)` — the single fetch seam. Phase 1 returns mock; phase 2 becomes
  `fetch('/api/clone/sources?partner=…&ids=…')` with no signature change.

## UI — launcher design system (`app/clone/page.tsx` → `CloneBoard`)

Reuses `Header`, `Field/Select`, `MultiSelect`, `TextInput`, icons, and the `copy-settings-modal`
styling. Two columns: `lg:grid-cols-[300px_minmax(0,1fr)]`.

- **Settings (left, sticky):** locked target bind (account/fanpage/pixel, read-only, lock icons) +
  future-account note; USER OS; Number of copies; **Generate Preview** (accent) and **Duplicate**
  (emerald — the "fire" action, hidden until preview). Emerald follows the DESIGN.md rule.
- **Selected Campaigns (right):** table `# · Name (textarea) · Countries (chips + Targeting modal) ·
  Orig. budget · Orig. ROAS · Creatives · ROAS goal · Budget · Config (High Offer / redirect chip) ·
  remove`. Source `campaignId` shown under each name. Empty state + local "Load sample" button.
- **Preview:** flat list of `rows × copies` clones (final name, geo, ROAS, $/day). Any edit re-arms
  (hides Duplicate), mirroring the board's Preview→Launch.
- **Modals:** `CloneTargetingModal` (geo+presets/langs/category/placement/age) and
  `CloneHighOfferModal` (phase-1 shell). Both mount-on-open (state seeded from the row at mount — no
  seeding effect, no cascading renders).

## Phasing

- **Phase 1 (done):** UI. `/clone?ids=…` fully interactive; **Duplicate** is a stub. Verified:
  `tsc` + `eslint` clean; renders (200) and drives (rows, edits, preview, modals) in the browser.
- **Phase 2a (done):** `GET /api/clone/sources` — real FB fetch via `lib/fb-graph.ts` (per-campaign
  field-expansion reads + rate-limit backoff; the multi-id `?ids=` batch param is deprecated in
  v26+, so we read one campaign at a time, sequentially). `loadCloneSources` now hits the API;
  `loadSampleSources` keeps the mock behind the "Load sample" button; the board has loading/error/
  retry states. Verified live against real Indians campaigns (geo/budget/bid/creatives mapped).
- **Phase 2b (done):** `POST /api/clone/run` — creates each clone as a faithful PAUSED duplicate:
  re-fetches the source server-side, reuses the video + copy/title/CTA (only the gcm in the link is
  swapped for a freshly-claimed code), rebuilds targeting/bid/budget from the buyer's edits via the
  launch payload builders. Streams NDJSON per-clone progress → the board's Duplicate-run panel.
  New: `lib/fb-graph.ts` (fbPost), `lib/gcm-claim.ts`, `lib/clone-run.ts`. Verified live — created a
  real PAUSED clone (campaign + ad set $7 / bid-cap $0.80 / geo FR / locked pixel + PURCHASE + ad,
  new gcm link, reused video).
- **Later:** preserve `ids` through `/login` via `?next=`; multi-account targets; finalize High
  Offer; optional Task Manager integration (run progress is inline in the board today).

## Decisions (locked with owner 2026-08-06)

- Pass **campaign ids only**, fetch from FB (owner: "передавать только айдишки").
- Indians only now, **one account/fanpage/pixel locked**, no Profile field; build multi-account-ready.
- New dedicated route `/clone`; reuse launcher header + design system.
