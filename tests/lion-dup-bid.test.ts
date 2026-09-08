// Node's built-in runner: `node --test tests/lion-dup-bid.test.ts`.
// LION /duplicate/ v2 bid rules (partner docs re-read 09-09): per-row strategy switch, roas_goal,
// cross-currency inheritance refusal, the `bidding` read-back and the min-ROAS eligibility wall.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bidKind } from "../lib/types.ts";
import { dupBidPlan, dupBiddingMismatch, lionRoasWall } from "../lib/lion-dup-bid.ts";

const CAP = "LOWEST_COST_WITH_BID_CAP";
const COST = "COST_CAP";
const ROAS = "LOWEST_COST_WITH_MIN_ROAS";
const LOWEST = "LOWEST_COST_WITHOUT_CAP";

// ---- dupBidPlan: unswitched rows keep today's inherit-or-override wire ----------------------

test("no override, no bid → inherit everything (no strategy, no value, no event on the wire)", () => {
  assert.deepEqual(dupBidPlan({ sourceStrategy: CAP, override: "", typedBid: null, sourceCurrency: "USD", destCurrency: "USD" }), {
    strategy: CAP,
    switched: false,
    kind: "cap",
    human: null,
    wireStrategy: undefined,
    conversionEvent: undefined,
  });
});

test("no override, typed bid → the value rides alone (strategy and event stay the source's)", () => {
  assert.deepEqual(dupBidPlan({ sourceStrategy: ROAS, override: "", typedBid: 0.9, sourceCurrency: "USD", destCurrency: "BRL" }), {
    strategy: ROAS,
    switched: false,
    kind: "roas",
    human: 0.9,
    wireStrategy: undefined,
    conversionEvent: undefined,
  });
});

test("an override equal to the source's strategy is not a switch", () => {
  const plan = dupBidPlan({ sourceStrategy: CAP, override: CAP, typedBid: null, sourceCurrency: "USD", destCurrency: "USD" });
  assert.deepEqual(plan, { strategy: CAP, switched: false, kind: "cap", human: null, wireStrategy: undefined, conversionEvent: undefined });
});

test("lowest-cost source with a typed bid is refused (a bid on no-cap would be dropped silently)", () => {
  const refused = dupBidPlan({ sourceStrategy: LOWEST, override: "", typedBid: 0.5, sourceCurrency: "USD", destCurrency: "USD" });
  assert.match((refused as { refusal: string }).refusal, /source bids lowest-cost.*clear the Bid/);
});

// ---- cross-currency inheritance (LION v2 rejects an inherited monetary bid across currencies) --

test("cap source, no bid, different destination currency → refusal naming both currencies", () => {
  const refused = dupBidPlan({ sourceStrategy: COST, override: "", typedBid: null, sourceCurrency: "BRL", destCurrency: "USD" });
  assert.match((refused as { refusal: string }).refusal, /BRL.*USD.*type a Bid in USD/);
});

test("a PREFILLED source bid (typed == source's own) across currencies is refused like an inherit (audit 09-09: R$2,45 rode as $2.45)", () => {
  const refused = dupBidPlan({ sourceStrategy: CAP, override: "", typedBid: 2.45, sourceBid: 2.45, sourceCurrency: "BRL", destCurrency: "USD" });
  assert.match((refused as { refusal: string }).refusal, /BRL.*USD.*retype the Bid in USD/);
  // a genuinely different typed value is the buyer's own destination-currency cap → rides
  const typed = dupBidPlan({ sourceStrategy: CAP, override: "", typedBid: 0.5, sourceBid: 2.45, sourceCurrency: "BRL", destCurrency: "USD" });
  assert.equal("refusal" in typed, false);
  // same currency → the prefilled value is simply the source's cap, fine
  const same = dupBidPlan({ sourceStrategy: CAP, override: "", typedBid: 2.45, sourceBid: 2.45, sourceCurrency: "USD", destCurrency: "USD" });
  assert.equal("refusal" in same, false);
});

test("unreadable source strategy (LION lag) with a typed bid → names the lag, not 'lowest-cost'", () => {
  const refused = dupBidPlan({ sourceStrategy: "", override: "", typedBid: 0.5, sourceCurrency: "", destCurrency: "USD" });
  assert.match((refused as { refusal: string }).refusal, /source strategy unreadable/);
});

test("ROAS goals are multipliers — inheriting across currencies is fine; unknown currencies never block", () => {
  const roas = dupBidPlan({ sourceStrategy: ROAS, override: "", typedBid: null, sourceCurrency: "BRL", destCurrency: "USD" });
  assert.equal("refusal" in roas, false);
  const unknown = dupBidPlan({ sourceStrategy: CAP, override: "", typedBid: null, sourceCurrency: "", destCurrency: "USD" });
  assert.equal("refusal" in unknown, false);
});

// ---- switched rows: explicit strategy, typed value duties, event pairing -------------------

test("switched to cap/cost cap needs a typed bid; with one the wire carries strategy + value + CONTENT_VIEW", () => {
  const refused = dupBidPlan({ sourceStrategy: ROAS, override: CAP, typedBid: null, sourceCurrency: "USD", destCurrency: "USD" });
  assert.match((refused as { refusal: string }).refusal, /switched to LOWEST_COST_WITH_BID_CAP.*type a Bid/);
  assert.deepEqual(dupBidPlan({ sourceStrategy: ROAS, override: CAP, typedBid: 0.5, sourceCurrency: "USD", destCurrency: "USD" }), {
    strategy: CAP,
    switched: true,
    kind: "cap",
    human: 0.5,
    wireStrategy: CAP,
    conversionEvent: "CONTENT_VIEW",
  });
  // bid cap ↔ cost cap is a switch too (partner docs: "including switches between bid cap and cost cap")
  const capToCost = dupBidPlan({ sourceStrategy: CAP, override: COST, typedBid: null, sourceCurrency: "USD", destCurrency: "USD" });
  assert.match((capToCost as { refusal: string }).refusal, /switched to COST_CAP/);
});

test("switched to ROAS needs a typed goal; the wire pairs it with PURCHASE", () => {
  const refused = dupBidPlan({ sourceStrategy: CAP, override: ROAS, typedBid: null, sourceCurrency: "USD", destCurrency: "USD" });
  assert.match((refused as { refusal: string }).refusal, /switched to LOWEST_COST_WITH_MIN_ROAS.*type a Bid/);
  assert.deepEqual(dupBidPlan({ sourceStrategy: CAP, override: ROAS, typedBid: 0.3, sourceCurrency: "USD", destCurrency: "USD" }), {
    strategy: ROAS,
    switched: true,
    kind: "roas",
    human: 0.3,
    wireStrategy: ROAS,
    conversionEvent: "PURCHASE",
  });
});

test("a ROAS goal above 100 is refused whether switched or inherited", () => {
  assert.deepEqual(dupBidPlan({ sourceStrategy: CAP, override: ROAS, typedBid: 150, sourceCurrency: "USD", destCurrency: "USD" }), {
    refusal: "roas_goal_invalid",
  });
  assert.deepEqual(dupBidPlan({ sourceStrategy: ROAS, override: "", typedBid: 150, sourceCurrency: "USD", destCurrency: "USD" }), {
    refusal: "roas_goal_invalid",
  });
});

test("switched to lowest cost rides an explicit strategy + CONTENT_VIEW and refuses a typed bid", () => {
  assert.deepEqual(dupBidPlan({ sourceStrategy: ROAS, override: LOWEST, typedBid: null, sourceCurrency: "USD", destCurrency: "USD" }), {
    strategy: LOWEST,
    switched: true,
    kind: "none",
    human: null,
    wireStrategy: LOWEST,
    conversionEvent: "CONTENT_VIEW",
  });
  const refused = dupBidPlan({ sourceStrategy: ROAS, override: LOWEST, typedBid: 0.5, sourceCurrency: "USD", destCurrency: "USD" });
  assert.match((refused as { refusal: string }).refusal, /switched to lowest cost.*clear the Bid/);
});

test("the plan's bid kind agrees with lib/types bidKind for every strategy", () => {
  for (const s of [LOWEST, CAP, COST, ROAS, "", "SOME_EXOTIC_STRATEGY"]) {
    const plan = dupBidPlan({ sourceStrategy: s, override: "", typedBid: null, sourceCurrency: "USD", destCurrency: "USD" });
    assert.equal((plan as { kind: string }).kind, bidKind(s), s);
  }
});

// ---- dupBiddingMismatch: LION's resolved `bidding` vs what we asked for ----------------------

test("no bidding block (older LION) → nothing to verify", () => {
  assert.equal(dupBiddingMismatch({ strategy: ROAS, roasGoal: 0.9 }, undefined), null);
});

test("matching strategy + goal → null; a resolved goal off by ×100 is named", () => {
  assert.equal(dupBiddingMismatch({ strategy: ROAS, roasGoal: 0.9 }, { bid_strategy: ROAS, roas_goal: 0.9, conversion_event: "PURCHASE" }), null);
  assert.match(
    String(dupBiddingMismatch({ strategy: ROAS, roasGoal: 0.9 }, { bid_strategy: ROAS, roas_goal: 90 })),
    /ROAS goal 90.*requested 0\.9/,
  );
});

test("a different resolved strategy, or a monetary bid where a ROAS goal was requested, is a mismatch", () => {
  assert.match(String(dupBiddingMismatch({ strategy: CAP, startingBid: 50 }, { bid_strategy: ROAS, roas_goal: 0.5 })), /strategy/);
  assert.match(String(dupBiddingMismatch({ strategy: ROAS, roasGoal: 0.5 }, { bid_strategy: ROAS, starting_bid: 50 })), /monetary/);
});

test("monetary bid compares in Meta account units; inherit (no intent) never mismatches", () => {
  assert.equal(dupBiddingMismatch({ strategy: CAP, startingBid: 50 }, { bid_strategy: CAP, starting_bid: 50 }), null);
  assert.match(String(dupBiddingMismatch({ strategy: CAP, startingBid: 50 }, { bid_strategy: CAP, starting_bid: 5000 })), /bid 5000.*requested 50/);
  assert.equal(dupBiddingMismatch({}, { bid_strategy: CAP, starting_bid: 123 }), null);
});

// ---- lionRoasWall: Meta's min-ROAS eligibility rejection in a task's error --------------------

test("subcode 2446671 / 'Minimum ROAS Isn't Available' → actionable reason; other noise → null", () => {
  assert.match(String(lionRoasWall("(#100) Minimum ROAS Isn't Available (subcode 2446671)")), /min ROAS/i);
  assert.match(String(lionRoasWall("code 100, subcode 2446671")), /2446671/);
  assert.equal(lionRoasWall("Adset creation failed: rate limit"), null);
  assert.equal(lionRoasWall(undefined), null);
});
