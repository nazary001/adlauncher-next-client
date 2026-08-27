// Pure helpers of the JURO clone rail (LION /jurar/ — new campaign from a source's page posts).
// Wire facts probed live 2026-08-25: budget = cents; cap bid = cents; MIN_ROAS bid = goal ×100
// int (0,9 → 90 → Meta floor 9000 — the API doc's "decimal 1.20" is wrong: 1.2 lands as floor
// 100); the executor profile must LIST the source post's page; campaigns are BORN ACTIVE.

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

/** jurar's conversion_event rides the bid kind: MIN_ROAS optimizes PURCHASE (value), everything
 *  else keeps the team's CONTENT_VIEW default (same pairing the HS bot ships). The strategy
 *  match mirrors lib/types bidKind's "roas" arm (kept inline — see the import note above). */
export function juroConversionEvent(bidStrategy: string): "PURCHASE" | "CONTENT_VIEW" {
  return bidStrategy === "LOWEST_COST_WITH_MIN_ROAS" ? "PURCHASE" : "CONTENT_VIEW";
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
  return null;
}
