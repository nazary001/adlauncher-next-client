# MO partner: MIN_ROAS (ROAS goal) launches — design

2026-08-11. Approach A approved by owner: full support — launcher AND cloner.

## Goal

Let MO (Indians, direct Graph API via the gcformo system-user token) launch and clone
campaigns with Meta's `LOWEST_COST_WITH_MIN_ROAS` bid strategy, exactly like the HS partner
already offers through LION.

## Live-probed Meta contract (2026-08-11, BR-1500 + FARM-1, probe deleted)

- Campaign (CBO, our standard): `bid_strategy: "LOWEST_COST_WITH_MIN_ROAS"` — accepted as-is.
- Ad set: **`optimization_goal: "VALUE"`** (OFFSITE_CONVERSIONS is rejected, sub 2490487, the
  error text itself names the recipe) + **`bid_constraints: { roas_average_floor: ROAS × 10000 }`**
  (1,20 → 12000) + `promoted_object` with `custom_event_type: "PURCHASE"`, and **no `bid_amount`**.
- Floor units: ROAS × 10000; Meta's accepted range ≈ 0,01..1000.
- Value optimization IS available on BR-1500 + FARM-1 (the big eligibility risk — cleared).
  Other accounts unprobed: an ineligible one fails at the ad-set stage with Meta's own text →
  orphan campaign + retired gcm, the failure class the pipeline already handles.

## Design

One shared bid-strategy model across partners; MIN_ROAS stops being HS-only.

1. **catalog.ts** — fold `LOWEST_COST_WITH_MIN_ROAS` into `BID_STRATEGIES`; delete
   `HS_BID_STRATEGIES` (campaign-card and copy-modal use the single list).
2. **bid kind helper** — generalize `hsBidKind` → `bidKind(strategy): "none" | "cap" | "roas"`
   in `lib/types.ts`; hs-launch and all callers migrate (no behavior change for HS).
3. **campaign-card** — the existing `hsMode && hsKind === "roas"` branches drop the `hsMode`
   guard: for ANY partner, MIN_ROAS pins Optimization → conversions and Conversion event →
   PURCHASE (both selects disabled), relabels the bid field "ROAS goal *" (placeholder "1,20",
   hint "1,20 = 120% ROAS · type 120", cash-register entry clamp 100 — already shipped).
4. **fb-launch.ts** (server truth, client never trusted):
   - `optimizationGoal()` → `"VALUE"` when strategy is MIN_ROAS;
   - `bidAmountCents()` → `undefined` for MIN_ROAS (bid_amount + constraints not probed — avoid);
   - `adsetPayload()` → emit `bid_constraints: { roas_average_floor: round(parseMoney(bidCap) × 10000) }`
     and force `custom_event_type: "PURCHASE"` for MIN_ROAS;
   - `SUPPORTED_BID_STRATEGIES` += MIN_ROAS (unblocks the cloner).
5. **Server guards** — `bidAmountMissing` already demands a positive value for MIN_ROAS (any
   non-lowest strategy). Add the HS-mirroring range guard (ROAS > 100 → 400 `roas_goal_invalid`)
   in `/api/launch` and `/api/clone/run` before any FB write.
6. **Cloner reads ROAS sources** — `clone/sources` route + `clone-run.ts` source fields add
   `bid_constraints` on campaign AND adset (adset-first, campaign fallback); `originalRoas`
   column for MIN_ROAS sources = floor / 10000 rendered "1,20" (today it's blank). Rebuild path
   needs nothing new: `c.bidCap = edit.roasGoal` already flows into the new `adsetPayload`.
7. **Copy-to-all** — already copies bidStrategy + bidCap; only the preview label lookup moves to
   the unified list. Polish: drop the `$` prefix in the bidCap preview when the strategy is roas.

## Not in scope

- No auto-activation changes, no HS changes (LION path untouched), no per-account eligibility
  pre-flight (first wave surfaces it honestly; revisit only if it actually bites).

## Testing

- tsx unit: `adsetPayload`/`campaignPayload`/`bidKind` for MIN_ROAS (VALUE, constraints, no
  bid_amount, PURCHASE forced; cap/lowest regressions).
- Live PAUSED E2E through real `/api/launch` on BR-1500 (minted session), verify via GET
  readback, then delete + free the gcm — the established pattern.
- Clone E2E: probe MIN_ROAS source → `/api/clone/sources` shows ROAS "1,20" → `/api/clone/run`
  builds a correct clone → readback → delete everything.
- Quota-gentle: single-digit call counts, PAUSED only.

## Rollout

Local first (main carries undeployed HS commits); deploy via the branch-from-origin/main +
cherry-pick flow. Vercel needs no new env.
