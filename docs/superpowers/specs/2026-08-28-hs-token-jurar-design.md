# HS JURO — FB Token rail (`/api/hs/token-jurar`)

**Date:** 2026-08-28 · **Status:** shipped

The JURO mode's second channel: the same "new campaign from the source's page posts" launch
`/api/hs/jurar` performs through LION, built directly on the Graph with OUR partner-side token
pool (`lib/hs-token-launch`) — the board's previously-disabled "FB Token" chip in JURO mode.

## Shape

Wave route mirroring `/api/hs/token-duplicate` (fire-and-forget `after()` pump, wave-claim
idempotency, `hsTokenGate`, acct-limit 5/30min channel `hs-juro-token`, task rows `hsjt-*`) with
jurar semantics from `/api/hs/jurar`:

- **Binds** = profile + account + pixel, NO page (the post carries it). LION-catalog validation
  keeps the partner rule (accounts must sit under a weapon profile); `hsTokenAccountIds` gates
  the target to token-visible accounts.
- **Source read via Graph** (not LION): `ads.limit(25){creative{effective_object_story_id,…}}`
  → unique stories. `effective_object_story_id` covers spec-built ads too (superset of LION's
  `object_story_id`-only read).
- **Per shot**: slot → source tree (cached) → wire resolve → page-name pre-check → **creatives
  FIRST** → campaign → adset → ads → done + `reportPagesUsed` on the story pages.
- **Creatives-first** (probed live 08-27): a story creative is a delivery-less library object, so
  a dead/expired source post (subcode 2446289 — real class: buyers jurar old winners) refuses the
  shot with ZERO shells; orphan creatives are deleted in the failure path.
- **Targeting**: fresh jurar shape (`juroTokenTargeting`) — country-level geo (override wins; WW
  → worldwide minus TW/SG + universal-ads declarations, self-heal in `hsCreateAdset`), ages
  18–65, Advantage+ placements, **plus locales** (override else the source's — the field LION's
  `/jurar/` silently drops; verified riding correctly live).
- **Bid**: typed override → `hsWireBid(…, "graph")` (cap cents / ROAS floor ×10000); empty →
  inherit the source ad set's own `bid_amount`/`bid_constraints` (normalized). Cap/ROAS source
  with unreadable bid = refusal (an unbid MIN_ROAS ad set would orphan the campaign).
- **Delivery**: `optimization_goal` VALUE (roas) / OFFSITE_CONVERSIONS, `conversion_event` =
  jurar pairing (PURCHASE on min-ROAS else CONTENT_VIEW), bind pixel, `start_time` +30 min
  (partner rule), `dsa_beneficiary/payor` = the story page's name — our token CAN set those, so
  the token rail escapes the EU-DSA wall that blocks LION's jurar.
- **Names**: board builds `re-dated prefix + JURO + TOKEN + tail`; server truth =
  `hsEnsureTokenMark(juroEnsureMark(name))`. `splitHsGrammar` extended with the optional
  `- JURO` segment so both markers splice correctly (and JURO-born sources parse in the boards).
- **Walls**: `juroBlockingError` on direct Graph errors — account scope sweeps the wave, family
  scope kills the source's remaining copies; partial failures pause the born-ACTIVE tree
  (`launchFailureDisposition` contract).

## Verification (2026-08-27/28)

Units 20/20 (`tests/juro.test.ts`: marker splice/idempotency, geo/locale derivation, targeting
builder); guard matrix 14/14 on dev; live e2e through the route: rows/claims/idempotency,
source+page reads, creatives, campaign create, failure-path pause + orphan-creative cleanup all
verified against real Graph. Adset/ad steps byte-verified in the FARM segment (userforhs): the
exact payloads landed (geo MX + locales 23 + floor + start_time) and 2 ads were born from story
creatives, then deleted.

⚠️ Full happy-path in VD-C1 was blocked at probe time by a Meta wall **subcode 2446325
"business account not allowed to advertise"** on adset-create — it hits Gcforhs2 (all 4 apps)
AND gcformo across VD-C1 accounts (probed minimal payloads; userforhs/aleph passes), i.e. the
EXISTING token-launch/token-duplicate/MO rails are equally blocked until the restriction lifts.
Environment, not code: appeal/verification is an owner action.
