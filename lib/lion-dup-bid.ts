// Pure helpers of the LION `/duplicate/` v2 bid contract (partner docs re-read 2026-09-09):
//  - `bid_strategy` picks any of the four target strategies (omit = the source's, COST_CAP
//    included); switching to a capped strategy REQUIRES a new value (bid cap ↔ cost cap too);
//  - `starting_bid` = integer Meta account units of the DESTINATION currency (cap / cost cap);
//    `roas_goal` = multiplier 0.01–1000 (1.2 = 120%) — never both; lowest cost takes neither;
//  - inheriting a monetary bid across different account currencies is rejected by LION;
//  - LEGACY: with an EXPLICIT ROAS strategy `starting_bid: 1.2` means 1.2× (decimal!) — our
//    ×100 wire (hsWireBid "lion") is only valid with the strategy OMITTED, so ROAS values ride
//    as `roas_goal` here, never as starting_bid;
//  - the response's `bidding` block is LION's resolved strategy/value — read back to catch
//    unit slips (the 08-20 ×100 floors) BEFORE a clone is activated;
//  - Meta may reject a queued ROAS task with code 100 / subcode 2446671 "Minimum ROAS Isn't
//    Available" (destination business not eligible) — LION keeps retrying it forever.
// No runtime imports on purpose (leaf module — tests/lion-dup-bid.test.ts loads it under
// `node --test`, which can't resolve extensionless "./types"); the bid-kind match mirrors
// lib/types `bidKind` and the test pins the two together.

export type DupBidKind = "none" | "cap" | "roas";

export function dupBidKind(strategy: string): DupBidKind {
  if (strategy === "LOWEST_COST_WITH_MIN_ROAS") return "roas";
  if (strategy === "LOWEST_COST_WITH_BID_CAP" || strategy === "COST_CAP") return "cap";
  return "none";
}

export type DupBidPlan =
  | { refusal: string }
  | {
      /** The clone's EFFECTIVE strategy — the buyer's per-row switch, else the source's. */
      strategy: string;
      switched: boolean;
      kind: DupBidKind;
      /** Human bid to put on the wire (typed): cap $ → starting_bid cents, ROAS goal → roas_goal.
       *  null = nothing rides (lowest cost, or an unswitched cap/ROAS row inheriting its bid). */
      human: number | null;
      /** `bid_strategy` for the wire — only a SWITCH sends it (an unswitched row keeps the
       *  documented "omit = inherit" shape; explicit ROAS strategy + starting_bid would also flip
       *  LION into its decimal legacy reading). */
      wireStrategy: string | undefined;
      /** `conversion_event` for the wire — only a switch re-pairs the event (min ROAS optimizes
       *  PURCHASE, capped/lowest keep the team's CONTENT_VIEW); unswitched rows inherit. */
      conversionEvent: "PURCHASE" | "CONTENT_VIEW" | undefined;
    };

/**
 * Which strategy/value/event a duplicate shot puts on LION's wire. Rules mirror the JURO and
 * token rails: a switched capped/ROAS clone needs a TYPED value (the source's means another
 * thing), a lowest-cost clone refuses a typed bid instead of dropping it, and an unswitched
 * capped row may inherit — except across currencies, which LION rejects at the door.
 * Currencies are ISO codes as LION reports them ("" = unknown → no guard, LION decides).
 */
export function dupBidPlan(args: {
  sourceStrategy: string;
  /** "" = ride the source's strategy. */
  override: string;
  typedBid: number | null;
  /** The source's OWN bid in human units (LION details, major) — the board prefills the Bid
   *  field with it, so a "typed" value equal to it is really an inherit in disguise. */
  sourceBid?: number | null;
  sourceCurrency: string;
  destCurrency: string;
}): DupBidPlan {
  const strategy = args.override || args.sourceStrategy;
  const switched = Boolean(args.override) && args.override !== args.sourceStrategy;
  const kind = dupBidKind(strategy);
  if (!strategy && args.typedBid != null) {
    // LION can't read the source right now (fresh-campaign lag) and the client sent no fallback
    // — a bid can't be scaled against an unknown strategy (audit 09-09: the old text blamed
    // "lowest-cost" for what is a read lag).
    return { refusal: "source strategy unreadable right now (LION lag) — clear the Bid to inherit, or retry in a minute" };
  }
  if (kind === "none") {
    if (args.typedBid != null) {
      return {
        refusal: switched
          ? "strategy switched to lowest cost (no cap) — clear the Bid on this row"
          : "source bids lowest-cost (no cap) — clear the Bid to inherit",
      };
    }
    return {
      strategy,
      switched,
      kind,
      human: null,
      wireStrategy: switched ? strategy : undefined,
      conversionEvent: switched ? "CONTENT_VIEW" : undefined,
    };
  }
  if (args.typedBid == null) {
    if (switched) {
      return {
        refusal: `strategy switched to ${strategy} — type a Bid on this row (the source's bid doesn't carry across strategies)`,
      };
    }
    if (kind === "cap" && args.sourceCurrency && args.destCurrency && args.sourceCurrency !== args.destCurrency) {
      return {
        refusal: `source bids in ${args.sourceCurrency}, the destination account is ${args.destCurrency} — LION can't inherit a monetary bid across currencies; type a Bid in ${args.destCurrency}`,
      };
    }
    return { strategy, switched, kind, human: null, wireStrategy: undefined, conversionEvent: undefined };
  }
  if (kind === "roas" && args.typedBid > 100) return { refusal: "roas_goal_invalid" };
  if (
    kind === "cap" &&
    !switched &&
    args.sourceBid != null &&
    args.typedBid === args.sourceBid &&
    args.sourceCurrency &&
    args.destCurrency &&
    args.sourceCurrency !== args.destCurrency
  ) {
    // The board prefills the Bid with the source's own cap — sent unchanged into an account of
    // another currency it would ride as that NUMBER in the destination units (audit 09-09:
    // R$2,45 → $2.45, ~5×). Only a value the buyer actually changed is a destination cap.
    return {
      refusal: `source bids ${args.sourceBid} in ${args.sourceCurrency}, the destination account is ${args.destCurrency} — that is the source's own cap, not a ${args.destCurrency} amount; retype the Bid in ${args.destCurrency}`,
    };
  }
  return {
    strategy,
    switched,
    kind,
    human: args.typedBid,
    wireStrategy: switched ? strategy : undefined,
    conversionEvent: switched ? (kind === "roas" ? "PURCHASE" : "CONTENT_VIEW") : undefined,
  };
}

/** LION's resolved bidding, as `duplication_results[].bidding` reports it (v2). */
export type LionBidding = {
  bid_strategy?: string;
  conversion_event?: string;
  roas_goal?: number;
  /** Meta account units; no cap reports 0. */
  starting_bid?: number;
};

/**
 * Compare what we asked for with what LION says it resolved. A mismatch means the queued task
 * will build a clone with OTHER bidding than the buyer typed — the pump then leaves it PAUSED
 * and names the difference instead of activating it. Missing `bidding` (older LION) or a field
 * we never sent (inherit) can't be verified → null.
 */
export function dupBiddingMismatch(
  intent: { strategy?: string; roasGoal?: number; startingBid?: number },
  bidding: LionBidding | undefined,
): string | null {
  if (!bidding) return null;
  if (intent.strategy && bidding.bid_strategy && bidding.bid_strategy !== intent.strategy) {
    return `LION resolved strategy ${bidding.bid_strategy} ≠ requested ${intent.strategy}`;
  }
  if (intent.roasGoal != null) {
    if (bidding.roas_goal != null && Math.abs(bidding.roas_goal - intent.roasGoal) > 1e-4) {
      return `LION resolved ROAS goal ${bidding.roas_goal} ≠ requested ${intent.roasGoal}`;
    }
    if (bidding.roas_goal == null && bidding.starting_bid) {
      return `LION resolved a monetary bid ${bidding.starting_bid} where a ROAS goal ${intent.roasGoal} was requested`;
    }
  }
  if (intent.startingBid != null && bidding.starting_bid != null && bidding.starting_bid !== intent.startingBid) {
    return `LION resolved bid ${bidding.starting_bid} ≠ requested ${intent.startingBid} (Meta account units)`;
  }
  return null;
}

/**
 * Meta's min-ROAS eligibility rejection inside a LION task error (code 100, subcode 2446671,
 * "Minimum ROAS Isn't Available"): the destination business can't run minimum ROAS, LION keeps
 * the task on the requested strategy and never launches an alternative — the pump settles the
 * shot with this reason instead of spinning to its deadline. null = not that wall.
 * (lib/juro `juroBlockingError` carries the same match for the JURO pump — both modules are
 * import-free leaves, so the regex lives twice on purpose.)
 */
export function lionRoasWall(message: string | null | undefined): string | null {
  const msg = String(message ?? "");
  if (!/2446671|Minimum ROAS Isn.?t Available/i.test(msg)) return null;
  return "Meta: min ROAS isn't available for the destination business/account (subcode 2446671) — LION keeps the task on the requested strategy; re-fire with bid cap / lowest cost or pick another account.";
}
