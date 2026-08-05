# Ad Launcher — design decisions (phase 1: UI only)

Internal console for the GlobeCoders media-buying team. One job: assemble N Facebook
campaign configs fast and fire them. Reference: the legacy mytrafficplus launch form —
same information architecture, rebuilt cleaner.

## Direction

- **Dark-only "mission control" cockpit.** Deep blue-black base (`#07080b`), zinc-family
  surfaces, aurora glow + fading grid horizon behind the header. Matches the team's
  existing dark tools; a light theme would go unused.
- **Type:** Geist Sans for UI, Geist Mono for every piece of data (budgets, counts, ids,
  geo codes, tabular-nums). Identity comes from cockpit-style micro-labels — 10px
  uppercase, wide tracking — on every field and section.
- **Color:** accent blue `#3d7fff` → violet `#7c5cff` gradient for brand/actions;
  emerald reserved exclusively for Launch; amber = draft/warning; red = destructive.
- **Signature element:** the right-hand **Launch bay** — sticky console with per-campaign
  rows, mono total-per-day, Preview → Launch reveal. The Launch button is the single
  loudest thing on the page by design.

## Layout

```
Header (sticky): logo + wordmark | partner switcher (Brazilians·Indians·Americans, circular flags, default br) | platform tabs (FB active; TT/Google disabled + tooltip)
Board: [ campaign cards column                    | Launch bay 330px sticky ]
Card:  01 · name · status dot · collapsed summary · duplicate/remove/collapse
       SETUP      name / profile / account / page / pixel   (search combobox)
       DELIVERY   objective / bid strategy / event / budget / bid cap
       CREATIVE   title / copy / cta / redirect / link / headline | dropzone
       TARGETING  geo multi (presets World·LATAM·EU·Africa·T1) / languages / cat / placement / age / os
```

## Behavior shipped in this phase (UI-level, no backend)

- Add / duplicate / remove / collapse cards; duplicate is the primary workflow (clone waves).
- Search comboboxes with keyboard nav; account/page/pixel lists are placeholder data
  derived from the picked profile (`lib/catalog.ts`) until LION wiring.
- Geo multiselect: code chips, presets, `WW` is exclusive (Worldwide replaces the list).
- Bid cap disabled unless the bid strategy uses a cap; `#ADX` reveals Param mode;
  `HIGH ADX` reveals High offer config.
- Dropzone: drag & drop, image thumbs, video tiles. Object URLs are not revoked on
  remove — session-lived by design, duplicated cards share the same blobs.
- Ready state = name + profile + ≥1 geo → green dot; drafts amber. Launch bay mirrors it.
- Preview → Launch reveal mimics the reference flow; any edit re-arms (hides Launch).
- Default budget **$10,00/day** — team standing rule for LION FB launches.
- Motion: 150–300ms, ease-out; card enter/exit, grid-rows collapse, dropdown pop,
  rail row stagger, tooltip rise, logo rocket lift. `prefers-reduced-motion` kills all.

## Partner-aware flow (Indians / MK Learn)

Partner switcher drives per-partner behavior (`lib/partners.ts`). Default partner = Indians.

- **Indians** (MagicAds/MagicBid, `usesGcm: true`):
  - **Landing** selector — the 8 real MK Learn guides (`app/guides/<slug>` in the MKLearn repo), EN/ES tagged. Picking one builds the read-only **Destination link** `https://finance.magicoffers.shop/guides/<slug>?gcm=<NN>`.
  - **gcm** field — auto-claimed lowest-free code 01..100 (`assignGcmCodes`); one code per ad, so **duplicating a card claims a fresh code** (BR-12 launch → gcm 01, its copy → gcm 02). Editable.
  - **Page → Fanpage (фанка):** real VD-C1 `client_pages` (Nigel4, Jeff5, Barbara1…) pulled live from the launch token, not profile-derived placeholders. Ready = name + profile + geo + landing.
  - **gcm registry (Strapi):** codes are claimed from the shared Strapi `gcm-maps` collection
    (unique `gcm` field). `app/api/gcm` GET returns used codes + next free; the board assigns the
    lowest free code above what's already taken (currently 01–32 used → next 33). POST claims a
    code atomically at launch (unique constraint = no two campaigns ever share a code). Codes
    01–32 backfilled 2026-08-04.
  - **Destination link:** the old "URL params" field is gone; the link field shows the full,
    ready URL, rebuilt live from landing + gcm + optimization:
    `{base}/{slug}?gcm=NN&utm_source=facebook&utm_medium={tier}&utm_campaign={{campaign.id}}&utm_term={{adset.id}}&utm_content={{ad.id}}[&fire=click]`
    — FB `{{macros}}` stay literal (built by hand, not URLSearchParams). Copy button included.
  - **Optimization** (Delivery): conversions | clicks. Conversions appends `&fire=click`
    (Purchase fires on the banner click); clicks omits it. Default conversions.
  - **Fixed account:** Indians launch directly via the FB Graph API (no LION), pinned to ONE
    account `GC-Magicoffers-BR-1500` (`act_1297336295903991`, BM VD-C1). Account, Pixel
    (`HS-Pixel-FARM-1`) and Fanpage (`Marisel8`, the account's only promotable page) render
    **locked** (read-only). **No Profile field** — profiles are a LION concept (Brazilians only).
- **Brazilians / Americans:** original fields incl. **Profile** (LION anti-detect browsers) +
  free Destination link, no gcm/landing/lock. These flows are not built out yet. `usesProfile`
  gates the Profile field; `usesGcm` gates landing/gcm; `lockedAccount`/`lockedPixel` gate locking.

⚠️ Domain: funnel base is `finance.magicoffers.shop` (where MagicAds ads.js monetizes gcm traffic), NOT the SEO host `mklearn.pro` in the site's `.env.local` — confirm this is the залив target before wiring launches. Fanpage list is a 12-of-~70 live subset; full list comes from LION in phase 2.

## Phase 2 hooks (logic)

- `Campaign` in `lib/types.ts` maps 1:1 to the intended LION payload; budgets stay
  strings ("10,00") until submit-time cents conversion (LION writes CENTS).
- Replace `accountsFor/pagesFor/pixelsFor` placeholders with LION lookups.
- Field ids are wired (useId) for future validation/error placement below fields.
