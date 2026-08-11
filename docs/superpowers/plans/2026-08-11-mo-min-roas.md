# MO MIN_ROAS Launches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MO (Indians, direct Graph API) can launch AND clone `LOWEST_COST_WITH_MIN_ROAS` campaigns, matching the live-probed Meta contract.

**Architecture:** One shared bid-strategy model: `bidKind()` in lib/types.ts replaces HS-only `hsBidKind`; fb-launch payload builders emit the probed contract (campaign passes strategy through; ad set = `optimization_goal:"VALUE"` + `bid_constraints:{roas_average_floor:ROAS×10000}` + forced PURCHASE, no bid_amount); the cloner reads a source's floor into the ROAS column and rebuilds through the same builders.

**Tech Stack:** Next.js 16 App Router, TS, Graph API v21.0 (fbGet/fbPost in lib/fb-graph), tsx for unit scripts.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-11-mo-min-roas-design.md` (probed contract lives there).
- Client is never trusted: VALUE/PURCHASE/constraints are forced server-side from `bidStrategy`.
- ROAS goal range: > 0 and ≤ 100 (mirror HS `roas_goal_invalid`); floor = `Math.round(parseMoney(bidCap) * 10000)`.
- HS (LION) behavior must not change: same strategy value stays in its dropdown, hs payloads untouched.
- Live tests: PAUSED only, single-digit call counts, delete probes, release claimed gcm codes.
- Commits on local `main` (deploy later via branch-from-origin/main + cherry-pick; no new Vercel env).

---

### Task 1: Shared bid model + server payloads

**Files:**
- Modify: `lib/types.ts` (add `bidKind` next to `bidAmountMissing`, ~line 130)
- Modify: `lib/hs-launch.ts:13-19` (drop `hsBidKind`, re-export semantics via import), `:76`, `:98`
- Modify: `lib/catalog.ts:57-67` (single `BID_STRATEGIES`, delete `HS_BID_STRATEGIES`)
- Modify: `lib/fb-launch.ts:16-40` (`optimizationGoal`, `bidAmountCents`, `SUPPORTED_BID_STRATEGIES`), `:113-156` (`adsetPayload`)
- Test: `_test_roas_units.mts` (repo root, ephemeral — deleted in Task 5)

**Interfaces:**
- Produces: `bidKind(strategy: string): "none" | "cap" | "roas"` exported from `@/lib/types`.
- Produces: `adsetPayload` emitting for roas: `optimization_goal:"VALUE"`, `bid_constraints`, `promoted_object.custom_event_type:"PURCHASE"`, and NO `bid_amount`.
- `BID_STRATEGIES` (catalog) now contains 4 options; `HS_BID_STRATEGIES` no longer exists.

- [ ] **Step 1: Write the failing unit script** `_test_roas_units.mts`:

```ts
import { bidKind } from "./lib/types";
import { adsetPayload, bidAmountCents, campaignPayload, optimizationGoal, SUPPORTED_BID_STRATEGIES } from "./lib/fb-launch";
import { makeCampaign } from "./lib/types";

const binds = { accountId: "1", pageId: "2", pageName: "Fanka", pixelId: "333" };
const roas = makeCampaign("t1", "", "x");
roas.bidStrategy = "LOWEST_COST_WITH_MIN_ROAS";
roas.bidCap = "1,20";
roas.budget = "10";
roas.countries = ["US"];
roas.conversionEvent = "CONTENT_VIEW"; // must be overridden to PURCHASE
roas.optimization = "clicks"; // must be ignored → VALUE

const cap = makeCampaign("t2", "", "y");
cap.bidStrategy = "COST_CAP";
cap.bidCap = "0,50";

let fail = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) { fail++; console.log("FAIL", label, "got", JSON.stringify(got), "want", JSON.stringify(want)); }
};

eq("bidKind roas", bidKind("LOWEST_COST_WITH_MIN_ROAS"), "roas");
eq("bidKind cap", bidKind("COST_CAP"), "cap");
eq("bidKind cap2", bidKind("LOWEST_COST_WITH_BID_CAP"), "cap");
eq("bidKind none", bidKind("LOWEST_COST_WITHOUT_CAP"), "none");
eq("optGoal roas→VALUE", optimizationGoal(roas), "VALUE");
eq("bidAmount roas→undefined", bidAmountCents(roas), undefined);
eq("bidAmount cap→50", bidAmountCents(cap), 50);
eq("campaign strategy passthrough", campaignPayload(roas, "n").bid_strategy, "LOWEST_COST_WITH_MIN_ROAS");
const p = adsetPayload(roas, "n", "camp1", binds, []);
eq("adset optimization", p.optimization_goal, "VALUE");
eq("adset constraints", p.bid_constraints, { roas_average_floor: 12000 });
eq("adset no bid_amount", "bid_amount" in p, false);
eq("adset PURCHASE forced", (p.promoted_object as { custom_event_type: string }).custom_event_type, "PURCHASE");
eq("SUPPORTED has roas", SUPPORTED_BID_STRATEGIES.has("LOWEST_COST_WITH_MIN_ROAS"), true);
const pc = adsetPayload(cap, "n", "camp1", binds, []);
eq("cap adset bid_amount", pc.bid_amount, 50);
eq("cap adset no constraints", "bid_constraints" in pc, false);
console.log(fail === 0 ? "ALL PASS" : `${fail} FAILURES`);
```

- [ ] **Step 2: Run to verify it fails** — `npx tsx _test_roas_units.mts` → import error (`bidKind` not exported) is the expected failure.

- [ ] **Step 3: Implement.**

`lib/types.ts` — add ABOVE `bidAmountMissing` (and reuse it there):

```ts
/** Bid semantics per strategy: `cap` takes a money amount (cents at FB), `roas` takes a ROAS
 *  decimal (1,20 = 120%, event forced to PURCHASE, optimization VALUE), `none` bids automatically.
 *  Shared by MO (Graph API) and HS (LION) — the strategies mean the same thing on both rails. */
export function bidKind(strategy: string): "none" | "cap" | "roas" {
  if (strategy === "LOWEST_COST_WITH_MIN_ROAS") return "roas";
  if (strategy === "LOWEST_COST_WITH_BID_CAP" || strategy === "COST_CAP") return "cap";
  return "none";
}
```

`lib/hs-launch.ts` — delete the `hsBidKind` definition (lines 13-19); `import { type Campaign, bidKind, parseMoney } from "./types";` and replace both internal `hsBidKind(` calls with `bidKind(`.

`lib/catalog.ts` — replace lines 57-67 with:

```ts
export const BID_STRATEGIES: Option[] = [
  { value: "LOWEST_COST_WITHOUT_CAP", label: "Lowest cost" },
  { value: "LOWEST_COST_WITH_BID_CAP", label: "Lowest cost + bid cap" },
  { value: "COST_CAP", label: "Cost cap" },
  // Min ROAS: bid = ROAS decimal, event pinned to Purchase. MO submits it straight to Meta
  // (VALUE optimization + roas_average_floor, live-probed 08-11); LION's weapon offers the same.
  { value: "LOWEST_COST_WITH_MIN_ROAS", label: "Lowest cost + min ROAS" },
];
```

`lib/fb-launch.ts`:

```ts
import { bidKind, parseMoney } from "./types"; // extend the existing import

/** conversions optimize for the pixel event; clicks for link clicks; a min-ROAS strategy
 *  REQUIRES the VALUE goal (probed live 08-11: OFFSITE_CONVERSIONS is rejected, sub 2490487). */
export function optimizationGoal(c: Campaign): string {
  if (bidKind(c.bidStrategy) === "roas") return "VALUE";
  return c.optimization === "conversions" ? "OFFSITE_CONVERSIONS" : "LINK_CLICKS";
}

/** Bid cap only carries a bid_amount; lowest-cost has none; min-ROAS bids via bid_constraints. */
export function bidAmountCents(c: Campaign): number | undefined {
  if (bidKind(c.bidStrategy) !== "cap") return undefined;
  const cents = money(c.bidCap);
  return cents > 0 ? cents : undefined;
}
```

`SUPPORTED_BID_STRATEGIES` — add `"LOWEST_COST_WITH_MIN_ROAS"` and rewrite the comment (it currently cites MIN_ROAS as the unsupported example):

```ts
/** Bid strategies the payload builder can faithfully rebuild. Anything else must be rejected
 *  BEFORE any FB write — cloning an arbitrary live source could import one, and Meta would
 *  reject the ad set after the campaign exists, orphaning it and burning a gcm code. */
export const SUPPORTED_BID_STRATEGIES = new Set([
  "LOWEST_COST_WITHOUT_CAP",
  "LOWEST_COST_WITH_BID_CAP",
  "COST_CAP",
  "LOWEST_COST_WITH_MIN_ROAS",
]);
```

`adsetPayload` — after the `bid` block, add (and force PURCHASE in promoted_object):

```ts
  const bid = bidAmountCents(c);
  if (bid !== undefined) p.bid_amount = bid;

  // Min ROAS bids through bid_constraints instead of bid_amount; the floor is ROAS × 10000
  // (1,20 → 12000). Probed live 08-11 on BR-1500: VALUE + floor + PURCHASE is the exact
  // combination Meta accepts.
  const roas = bidKind(c.bidStrategy) === "roas";
  if (roas) p.bid_constraints = { roas_average_floor: Math.round(parseMoney(c.bidCap) * 10000) };

  if (binds.pixelId) {
    p.promoted_object = { pixel_id: binds.pixelId, custom_event_type: roas ? "PURCHASE" : c.conversionEvent };
  }
```

- [ ] **Step 4: Run tests** — `npx tsx _test_roas_units.mts` → `ALL PASS`; `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit** — `git add lib/types.ts lib/hs-launch.ts lib/catalog.ts lib/fb-launch.ts && git commit -m "MO min-ROAS core: shared bidKind + VALUE/bid_constraints payloads"`.

### Task 2: UI generalization (card + copy modal)

**Files:**
- Modify: `components/campaign-card.tsx:8-29` (imports), `:237` (kind), `:583-612` (Optimization pin + strategy select), `:613-658` (event pin + ROAS field labels — mostly drop `hsMode &&`)
- Modify: `components/copy-settings-modal.tsx:63-66` (unified list + roas-aware bid preview)

**Interfaces:**
- Consumes: `bidKind` from `@/lib/types`, unified `BID_STRATEGIES` from `@/lib/catalog` (Task 1).

- [ ] **Step 1: campaign-card.** Imports: drop `hsBidKind` from the hs-launch import, add `bidKind` to the types import, drop `HS_BID_STRATEGIES` from the catalog import. Replace `const hsKind = hsBidKind(c.bidStrategy);` with `const kind = bidKind(c.bidStrategy);` and update every `hsMode && hsKind === "roas"` to `kind === "roas"` (event select value/disabled, bid field label/hint/clamp/placeholder). Strategy select: one `options={BID_STRATEGIES}`; onChange pins for every partner and keeps the MO tracking link truthful (`fire=click` follows `optimization`):

```tsx
                    onChange={(e) => {
                      const bidStrategy = e.target.value;
                      // Min-ROAS optimizes purchase value — event pins to Purchase and (MO) the
                      // optimization pins to conversions so the link keeps &fire=click.
                      if (bidKind(bidStrategy) === "roas") {
                        patch({ bidStrategy, conversionEvent: "PURCHASE", optimization: "conversions" });
                      } else {
                        patch({ bidStrategy });
                      }
                    }}
```

Optimization select (the `!hsMode` block): pin while roas —

```tsx
                    <Select
                      value={kind === "roas" ? "conversions" : c.optimization}
                      onChange={(e) =>
                        patch({ optimization: e.target.value as Campaign["optimization"] })
                      }
                      options={OPTIMIZATIONS}
                      disabled={kind === "roas"}
                    />
```

with `hint={kind === "roas" ? "pinned by min ROAS" : conversions ? "link gets &fire=click" : undefined}`.

- [ ] **Step 2: copy modal.** Swap `HS_BID_STRATEGIES` → `BID_STRATEGIES` (import + line 63) and make the bid preview roas-aware:

```ts
  { key: "bidCap", label: "Bid cap", group: "Delivery", preview: (c) => (c.bidCap ? (bidKind(c.bidStrategy) === "roas" ? `ROAS ${c.bidCap}` : `$${moneyLabel(c.bidCap)}`) : "—") },
```

(`import { bidKind, ... } from "@/lib/types";`)

- [ ] **Step 3: Verify** — `npx tsc --noEmit` + `npm run lint` clean; grep confirms `hsBidKind|HS_BID_STRATEGIES` have zero remaining references; dev-server HMR compiles.

- [ ] **Step 4: Commit** — `git add components/campaign-card.tsx components/copy-settings-modal.tsx && git commit -m "MO min-ROAS UI: shared strategy list, pinned optimization/event, ROAS goal field"`.

### Task 3: Server guards (launch + clone run)

**Files:**
- Modify: `app/api/launch/route.ts:~319` (after the `bidAmountMissing` guard)
- Modify: `app/api/clone/run/route.ts:~260` (same)

**Interfaces:**
- Consumes: `bidKind` from `@/lib/types`, `parseMoney` (both already imported or added).

- [ ] **Step 1:** In BOTH routes, right after the existing `bidAmountMissing` rejection, add (launch route shape shown; clone route mirrors its own error style):

```ts
  // Mirror the HS guard: a min-ROAS goal above 100 (10 000%) is a typo, not a bid.
  if (bidKind(campaign.bidStrategy) === "roas" && parseMoney(campaign.bidCap) > 100) {
    return NextResponse.json(
      { ok: false, stage: "config", error: "roas_goal_invalid" },
      { status: 400 },
    );
  }
```

(Read each route first; reuse its local response helper/error shape exactly — clone/run throws `FbError`-style task errors rather than returning NextResponse.)

- [ ] **Step 2: Verify** — `npx tsc --noEmit` clean. Behavior is proven live in Task 5.

- [ ] **Step 3: Commit** — `git add app/api/launch/route.ts app/api/clone/run/route.ts && git commit -m "MO min-ROAS guards: reject ROAS goals above 100 before any FB write"`.

### Task 4: Cloner reads ROAS sources

**Files:**
- Modify: `app/api/clone/sources/route.ts:11-21` (FIELDS), `:60-108` (mapCampaign)

**Interfaces:**
- Consumes: nothing new. `lib/clone-run.ts` needs NO change: `cloneToCampaign` already routes `edit.roasGoal` → `bidCap`, and Task 1's builders emit the constraints.

- [ ] **Step 1:** FIELDS — add `"bid_constraints"` (campaign level) and `bid_constraints` inside the adsets sub-list:

```ts
  "bid_constraints",
  "adsets.limit(5){name,daily_budget,bid_strategy,bid_amount,bid_constraints,billing_event,optimization_goal,promoted_object,targeting}",
```

- [ ] **Step 2:** `mapCampaign` — derive the ROAS column from the floor for min-ROAS sources (adset first, campaign fallback), keeping cap sources on bid_amount:

```ts
  const constraints = ((adset.bid_constraints ?? obj.bid_constraints ?? {}) as Json);
  const roasFloor = num(constraints.roas_average_floor);
  const originalRoas =
    roasFloor != null
      ? moneyLabel(roasFloor / 10000) // min-ROAS source: floor 12000 → "1,2"
      : bidCents != null
        ? moneyLabel(bidCents / 100)
        : "";
```

and use `originalRoas` in the returned object (replacing the inline expression at line 100).

- [ ] **Step 3: Verify** — `npx tsc --noEmit` clean; live proof lands in Task 5.

- [ ] **Step 4: Commit** — `git add app/api/clone/sources/route.ts && git commit -m "Clone sources: surface a min-ROAS source's floor as the ROAS column"`.

### Task 5: Live E2E (launch → clone), cleanup, memory

**Files:**
- Create: `_e2e_roas.mjs` (repo root, ephemeral) — minted local `adl_session` cookie (HMAC of local AUTH_SECRET, the established trick), calls the REAL running dev server.
- Delete at the end: `_e2e_roas.mjs`, `_test_roas_units.mts`.

**Interfaces:**
- Consumes: everything above, live BR-1500 + FARM-1, an existing ready `video_id` from the account's advideos (its `source` URL feeds `/api/launch` as `videoUrl` — no browser/Blob needed).

- [ ] **Step 1: Launch E2E.** POST `/api/launch` (JSON `{partnerId:"in", campaign, videoUrl}`) with `bidStrategy:"LOWEST_COST_WITH_MIN_ROAS"`, `bidCap:"1,20"`, budget `"10"`, geo `["US"]`, a landing+pixel-bearing MO campaign shape (fanpage = a real token page id). Read the NDJSON stream to `done`. Then GET the created campaign + adset back: expect campaign `bid_strategy=LOWEST_COST_WITH_MIN_ROAS` + `daily_budget=1000`; adset `optimization_goal=VALUE`, `bid_constraints.roas_average_floor=12000`, `promoted_object.custom_event_type=PURCHASE`, no `bid_amount`; everything `PAUSED`.
- [ ] **Step 2: Guard check.** Same POST with `bidCap:"150"` → expect 400 `roas_goal_invalid` BEFORE any resource exists (and with `bidCap:""` → the existing bid-required 400).
- [ ] **Step 3: Clone E2E.** GET `/api/clone/sources?partner=in&ids=<launched id>` → `originalRoas:"1,2"`, `bidStrategy` min-ROAS. POST `/api/clone/run` cloning it (fresh name, roasGoal `"1,30"`, same account) → readback of the clone: floor `13000`, VALUE, PURCHASE, PAUSED.
- [ ] **Step 4: Cleanup.** DELETE both campaigns (retry on transient code 2 — seen live today); DELETE the two claimed gcm rows via the registry API/Strapi (the launch + clone each claim one); verify both gone. Delete both ephemeral test scripts.
- [ ] **Step 5: Full checks + commit.** `npx tsc --noEmit`, `npm run lint`, rerun `_test_roas_units.mts` before deleting it. Update memory (adlauncher-project pt4 → implemented + E2E facts). Final commit if any stragglers.

## Self-review notes

- Spec §1-7 → Tasks: catalog/bidKind/hs migration (T1), card+copy modal (T2), guards (T3), builders/SUPPORTED (T1), clone sources (T4), tests (T1+T5). Rollout section = existing deploy flow, no task needed.
- Type check: `bidKind` name consistent across T1-T4; `kind` local in card; no `hsBidKind`/`HS_BID_STRATEGIES` survivors (grep step in T2).
- No placeholders; exact code given where files are already read; T3 instructs reading each route's local error shape before inserting (shapes differ by design).
