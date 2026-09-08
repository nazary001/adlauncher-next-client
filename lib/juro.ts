// Pure helpers of the JURO clone rails (new campaign from a source's page posts) — shared by the
// LION channel (/jurar/) and the FB Token channel (direct Graph build through our token pool).
// LION wire facts probed live 2026-08-25: budget = cents; cap bid = cents; MIN_ROAS bid = goal
// ×100 int (0,9 → 90 → Meta floor 9000 — the API doc's "decimal 1.20" is wrong: 1.2 lands as
// floor 100); the executor profile must LIST the source post's page; campaigns are BORN ACTIVE.

// No runtime imports on purpose: extensionless "./types" would break `node --test`'s type
// stripping — this module stays leaf-level so tests/juro.test.ts can load it directly.
import type { GeoOverride } from "./targeting-override";

/** Page carrying a set of object stories (story id = `<page>_<post>`). "" = underivable. */
export function juroStoryPage(stories: string[]): string {
  const first = stories[0] ?? "";
  const m = /^(\d{5,})_\d+$/.exec(first);
  return m ? m[1] : "";
}

/** Per-page ad tally of a story set — one ad is born per story, ON the story's page. A source
 *  can (rarely) carry ads on more than one fanpage: every page must then pass the profile check
 *  and the registry ledger charges each page its own count. null = a malformed story id. */
export function juroStoryPages(stories: string[]): { pageId: string; delta: number }[] | null {
  const counts = new Map<string, number>();
  for (const st of stories) {
    const m = /^(\d{5,})_\d+$/.exec(st);
    if (!m) return null;
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  return [...counts].map(([pageId, delta]) => ({ pageId, delta }));
}

/** The bid strategies LION's `/jurar/` documents as `bid_strategy` (partner docs 09-08): lowest
 *  cost (the default when no bid rides), bid cap (cents) and min ROAS (goal ×100). COST_CAP is
 *  documented for the bid ENDPOINTS only — never sent on this wire. */
export const JURO_LION_BID_STRATEGIES = ["LOWEST_COST_WITHOUT_CAP", "LOWEST_COST_WITH_BID_CAP", "LOWEST_COST_WITH_MIN_ROAS"] as const;

export function juroLionStrategyAccepted(strategy: string): boolean {
  return (JURO_LION_BID_STRATEGIES as readonly string[]).includes(strategy);
}

export type JuroBidKind = "none" | "cap" | "roas";

/** How a strategy bids — mirrors lib/types `bidKind` arm for arm (kept inline, see the import
 *  note above; tests/juro.test.ts pins the two together). */
export function juroBidKind(strategy: string): JuroBidKind {
  if (strategy === "LOWEST_COST_WITH_MIN_ROAS") return "roas";
  if (strategy === "LOWEST_COST_WITH_BID_CAP" || strategy === "COST_CAP") return "cap";
  return "none";
}

/** jurar's conversion_event rides the bid kind: MIN_ROAS optimizes PURCHASE (value), everything
 *  else keeps the team's CONTENT_VIEW default (same pairing the HS bot ships). */
export function juroConversionEvent(bidStrategy: string): "PURCHASE" | "CONTENT_VIEW" {
  return juroBidKind(bidStrategy) === "roas" ? "PURCHASE" : "CONTENT_VIEW";
}

export type JuroBidPlan =
  | { refusal: string }
  | {
      /** The copy's EFFECTIVE strategy — the buyer's per-row switch, else the source's. */
      strategy: string;
      switched: boolean;
      kind: JuroBidKind;
      /** Human bid to scale onto the wire (typed, else the source's own); null on lowest cost. */
      human: number | null;
      /** `bid_strategy` for the jurar wire: the effective strategy whenever a bid rides or the
       *  buyer switched (an explicit lowest-cost switch must reach LION — the source's cap/ROAS
       *  would not inherit anyway, but the intent is on the wire). undefined keeps today's
       *  bid-less wire for an unswitched lowest-cost source (live-verified shape). */
      wireStrategy: string | undefined;
    };

/**
 * jurar has NO bid inheritance: whatever rides the wire IS the new campaign's strategy. Since
 * 09-08 the buyer may switch that strategy per row (ROAS ↔ cap ↔ lowest — LION's /jurar/ takes
 * `bid_strategy` natively, unlike /duplicate/). The rules mirror the token JURO rail:
 *  - a switched cap/ROAS copy needs a TYPED bid (the source's bid means another thing);
 *  - an unswitched cap/ROAS copy rides the typed bid, else the source's own (unreadable →
 *    refuse rather than birth a shell Meta then rejects);
 *  - a lowest-cost copy (source's or switched) takes no bid — a typed one is refused instead
 *    of silently dropped (same honesty rule as the duplicate rails).
 * The human bid is scaled by the caller (hsWireBid "lion": ROAS ×100 / cap cents).
 */
export function juroBidPlan(args: {
  sourceStrategy: string;
  /** "" = ride the source's strategy. */
  override: string;
  typedBid: number | null;
  sourceBid: number | null;
}): JuroBidPlan {
  const strategy = args.override || args.sourceStrategy;
  const switched = Boolean(args.override) && args.override !== args.sourceStrategy;
  const kind = juroBidKind(strategy);
  if (kind === "none") {
    if (args.typedBid != null) {
      return {
        refusal: switched
          ? "strategy switched to lowest cost (no cap) — clear the Bid on this row"
          : "source bids lowest-cost (no cap) — clear the Bid on this row",
      };
    }
    return { strategy, switched, kind, human: null, wireStrategy: switched ? strategy : undefined };
  }
  if (switched && args.typedBid == null) {
    return {
      refusal: `strategy switched to ${strategy} — type a Bid on this row (the source's bid doesn't carry across strategies)`,
    };
  }
  const human = args.typedBid ?? args.sourceBid;
  if (human == null) return { refusal: "source bid unreadable right now (LION metrics lag) — type a Bid on this row" };
  if (kind === "roas" && human > 100) return { refusal: "roas_goal_invalid" };
  return { strategy, switched, kind, human, wireStrategy: strategy };
}

/** Countries for the jurar wire: the override wins (WW → LION's "WORLD" token), else the
 *  source's targeting. Empty = undecidable — the caller refuses the shot rather than guessing
 *  (jurar has no inheritance: whatever is sent IS the new campaign's geo). */
export function juroWireCountries(override: GeoOverride | null, sourceCountries: string[]): string[] {
  if (override && override.countries.length > 0) {
    return override.countries.includes("WW") ? ["WORLD"] : override.countries;
  }
  return sourceCountries.filter(Boolean);
}

/**
 * Guarantee the `API - JURO - ` marker on a name (or a grammar prefix) about to be born through
 * a JURO rail. A "(CLONE)" is dropped (a JURO copy is a fresh campaign built from the posts, not
 * a tree clone) and an already-marked segment is normalized in place — idempotent, so the board
 * preview and the server belt can both run it. Names without the `API -` grammar zone get the
 * marker prepended (nothing to splice into).
 */
export function juroEnsureMark(name: string): string {
  const m = /\bAPI\s*(?:\(CLONE\)\s*)?-\s*(?:JURO\s*-\s*)?/.exec(name);
  if (!m) return name ? `JURO - ${name}` : name;
  return `${name.slice(0, m.index)}API - JURO - ${name.slice(m.index + m[0].length)}`;
}

/** Countries for the TOKEN (Graph) wire: the override wins verbatim ("WW" stays the board's
 *  worldwide sentinel — the targeting builder resolves it), else the source's targeting-derived
 *  geo. Empty = undecidable — the caller refuses the shot rather than guessing (same
 *  no-inheritance rule as the LION wire's juroWireCountries). */
export function juroTokenCountries(override: GeoOverride | null, sourceCountries: string[]): string[] {
  if (override && override.countries.length > 0) return override.countries;
  return sourceCountries.filter(Boolean);
}

/** Source geo as board-style codes from a GRAPH targeting object: explicit countries verbatim,
 *  the worldwide country group → ["WW"]. Region/city-only targeting (or a non-worldwide group)
 *  yields [] — jurar builds country-level geo only, so the caller asks for an override. */
export function juroSourceGeo(targeting: Record<string, unknown>): string[] {
  const g = ((targeting ?? {}).geo_locations ?? {}) as Record<string, unknown>;
  const countries = Array.isArray(g.countries) ? g.countries.map(String).filter(Boolean) : [];
  if (countries.length > 0) return countries;
  const groups = Array.isArray(g.country_groups) ? g.country_groups.map(String) : [];
  return groups.includes("worldwide") ? ["WW"] : [];
}

/** Source locale ids from a GRAPH targeting object (the field jurar-over-LION LOSES — probed
 *  08-26: /jurar/ silently ignores `locales`; the token rail carries them natively). */
export function juroSourceLocaleIds(targeting: Record<string, unknown>): number[] {
  const raw = (targeting ?? {}).locales;
  if (!Array.isArray(raw)) return [];
  return raw.map((l) => Number(l)).filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * Fresh jurar-style targeting for the token rail — the same minimal shape LION's jurar births
 * (country-level geo, ages 18–65, Advantage+ placements; deliberately NOT the source's verbatim
 * targeting: audiences/exclusions are account-local and a geo test wants a clean slate), plus
 * the locales the LION wire drops. WW mirrors the launcher's worldwide rule: the country group
 * MINUS Taiwan+Singapore (owner rule 08-11 — without a verified advertiser Meta never delivers
 * there, it just demands declarations).
 */
export function juroTokenTargeting(countries: string[], localeIds: number[]): Record<string, unknown> {
  const t: Record<string, unknown> = { age_min: 18, age_max: 65 };
  if (countries.includes("WW")) {
    t.geo_locations = { location_types: ["home", "recent"], country_groups: ["worldwide"] };
    t.excluded_geo_locations = { countries: ["TW", "SG"] };
  } else {
    t.geo_locations = { location_types: ["home", "recent"], countries };
  }
  if (localeIds.length) t.locales = localeIds;
  return t;
}

/** A WW token-rail shot needs the TW/SG universal-ads declarations up front (same pair the
 *  launcher and token-duplicate send; further regions self-heal in createAdsetSelfHealing). */
export function juroTokenRegionalCategories(countries: string[]): string[] {
  return countries.includes("WW") ? ["TAIWAN_UNIVERSAL", "SINGAPORE_UNIVERSAL"] : [];
}

/**
 * Non-transient walls a jurar task retries against forever (creation-status `error` while the
 * status stays CREATING_ADS): map them to an actionable reason, or null for transient noise.
 * `scope` says how far the failure deterministically reaches: "account" walls kill every shot of
 * the wave (one wave = one target account), "family" walls kill the source's remaining copies.
 */
export function juroBlockingError(message: string | undefined | null): { reason: string; scope: "account" | "family" } | null {
  const msg = String(message ?? "");
  if (!msg) return null;
  if (/certif/i.test(msg)) {
    return {
      // Live 08-25: subcode 2859002 on cloneAd — the TARGET ACCOUNT lacks Meta's
      // non-discrimination certification, any geo (a [MX]-only shot hit it too).
      reason:
        "Target account is not non-discrimination certified on Meta — jurar can't create ads there (any geo). Pick another account.",
      scope: "account",
    };
  }
  if (/verified advertiser/i.test(msg)) {
    return { reason: "Meta wall: geo needs a verified advertiser (BR-class) — not launchable via API.", scope: "family" };
  }
  if (/person or organization being promoted/i.test(msg)) {
    return { reason: "Meta wall: EU DSA beneficiary required — jurar can't set it via API.", scope: "family" };
  }
  if (/2446671|Minimum ROAS Isn.?t Available/i.test(msg)) {
    // Partner docs 09-09: code 100 / subcode 2446671 — the destination business isn't eligible
    // for minimum ROAS; LION keeps retrying the requested strategy, never launches another.
    // (Same match as lib/lion-dup-bid lionRoasWall — both leaves, duplicated on purpose.)
    return {
      reason:
        "Meta: min ROAS isn't available for the destination business/account (subcode 2446671) — LION keeps the task on the requested strategy; re-fire with bid cap / lowest cost or pick another account.",
      scope: "family",
    };
  }
  return null;
}
