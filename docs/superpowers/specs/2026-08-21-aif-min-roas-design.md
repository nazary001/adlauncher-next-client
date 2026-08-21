# AIF partner: MIN_ROAS (ROAS goal) launches — design

2026-08-21. Owner ask: extend the MO min-ROAS support (2026-08-11 design) to the AIF rail.
LOCAL ONLY for now — not deployed.

## Why the ban existed, why it lifts

AIF conversions are postback→CAPI Purchases; at rail-build time (08-18) they carried value 0,
so VALUE optimization had nothing to optimize and min-ROAS was rejected everywhere (route,
cloner, UI, partner locks). The wiring is now enabled; the floors only *bite* once the CAPI
forwarder sends real purchase values — that side lives on the HS server (pb_capi), not here.

## Design — reuse the MO recipe wholesale

The Meta contract is already implemented in `fb-launch.ts` (shared by both rails): strategy
`LOWEST_COST_WITH_MIN_ROAS` on the CBO campaign, ad set `optimization_goal: VALUE` +
`bid_constraints.roas_average_floor = normalizeRoasGoal(goal) × 10000` + `promoted_object`
pinned to PURCHASE, no `bid_amount`. Zero payload changes needed — only the bans lift:

1. **`/api/aif/launch`** — drop the rail-local `AIF_BID_STRATEGIES` allowlist for the shared
   `SUPPORTED_BID_STRATEGIES`; derive `conversions = optimization === "conversions" || roas`
   (min-ROAS always optimizes purchase value → the postback pixel binds + the pixel-on-account
   check runs, whatever a stale draft said); add the MO route's goal guards (>100 →
   `roas_goal_invalid`, ambiguous 10–20 band → `roas_goal_ambiguous`) before any claim/write.
2. **`/api/clone/run`** — delete the AIF roas ban; a roas source clones like any conversion
   source (derived pixel → AIF postback pixel). New belts, both rails: the ambiguous-band
   check moved up next to the >100 guard (used to surface only as the adsetPayload throw —
   AFTER the campaign existed → orphan + burnt marker), and an AIF roas source with no
   promoted pixel refuses cleanly (`roas_pixel_missing`).
3. **`lib/partners.ts`** — `applyPartnerLocks` stops snapping roas back to lowest-cost;
   instead a roas card pins optimization → conversions and the pixel derives to `AIF_PIXEL`
   (idempotent, covers restored/copied drafts). `launchReadyOpts.roasPixel` = `AIF_PIXEL.id`
   for AIF (readiness belt: a roas card is ready only on the postback pixel) — MO keeps
   `ROAS_PIXEL`, HS keeps "".
4. **campaign-card** — min-ROAS offered on AIF (unified `BID_STRATEGIES` list); picking it
   pins event PURCHASE + optimization conversions + pixel `AIF_PIXEL` (MO keeps its
   `ROAS_PIXEL` pin); leaving it never refills an AIF pixel (stays derived). ROAS-goal field
   behavior (cash-register entry, clamp 100, normalize echo, ambiguous error) was already
   partner-agnostic.

## Pixel policy

AIF has exactly one ROAS-able pixel — the postback CAPI pixel (2130695154991928), the same one
every conversion launch pins. No new owner rule needed: the rail's derived-pixel invariant IS
the ROAS pin. It is shared to all three AIF cabinets (verified live 08-21).

## Not in scope

Per-account VALUE-optimization eligibility pre-flight (same call as MO: the first wave
surfaces an ineligible cabinet honestly as an ad-set-stage failure → retired brand, the
handled class); any change to the CAPI forwarder's value side.

## Testing (2026-08-21, local dev server)

- 8/8 route guard tests through the real `/api/aif/launch` (minted session): roas accepted to
  the geo tripwire (proves allowlist + goal guards pass pre-write), stale `clicks` draft
  derives conversions, ambiguous/over-100/empty goals reject, unknown strategy rejects,
  lowest-cost regression. All pre-stream — no FB writes, no brand/slot claims.
- 17/17 unit checks (temporary dev route, deleted): adset/campaign wire shape for an AIF roas
  card (VALUE, floor 3000 for 0,30 and percent-form 30, PURCHASE + AIF pixel, no bid_amount),
  applyPartnerLocks convergence + regressions, launchReadyOpts/isReady belts per partner.
- Browser UI pass on the live board: strategy offered, all pins render, cash-register entry
  ("120" → 1,20), clamp 100, normalize echo, ambiguous-band error; MO card regression (still
  pins VD-C1-HS-1).
- LIVE probe (owner-approved, same day): a real min-ROAS launch on LA-644 + the postback pixel.
  Campaign created (MIN_ROAS accepted), then Meta rejected the AD SET with **sub 2446368
  "pixel doesn't meet value-optimization requirements"** — the AIF pixel has no purchase-VALUE
  history (CAPI Purchases carry value 0), so VO is locked at Meta's eligibility gate, exactly
  the failure class the pipeline handles (orphan traceable by brand, brand retired with Meta's
  own text, task row shows the error). Everything cleaned after: campaign DELETED (readback),
  brand test06 row dropped, blob auto-deleted by the route, task row removed.
  **Verdict: the launcher side is DONE and correct; ROAS launches will pass the day pb_capi
  sends real purchase values long enough to clear Meta's VO eligibility (the MO playbook:
  value injection → VO probe → flip).**
