// Default destination picks (owner rule 2026-09-08): every fanka / ad-account picker DEFAULTS to
// the LEAST-FILLED fanka (fewest ads against its per-page limit) and the LEAST-LOADED account
// relative to our 5-per-30-min launch timer — the buyer keeps the choice, the default just lands
// on the emptiest slot. Pure and dependency-free so `node --test tests/pick-defaults.test.ts`
// runs it straight off Node's type stripping.

export type PageFill = {
  id: string;
  /** Ads running/in review on the page (null = fill unknown right now). */
  used: number | null;
  /** The page's ad limit (null = unknown → the caller's tier default is used when given). */
  limit: number | null;
  /** Unpickable (full, not OK in the registry …) — never a default. */
  disabled?: boolean;
};

/**
 * The page a picker should default to: the lowest KNOWN fill ratio (used / limit) first, ties
 * broken by more free slots, then list order; pages whose fill is unknown rank after every known
 * one (a number beats a guess) but still before nothing; disabled pages are never returned.
 * "" = no pickable page.
 */
export function leastFilledPage(pages: readonly PageFill[], defaultLimit = 250): string {
  let best: { idx: number; known: boolean; ratio: number; free: number } | null = null;
  pages.forEach((p, idx) => {
    if (p.disabled) return;
    const limit = p.limit != null && p.limit > 0 ? p.limit : defaultLimit;
    const known = p.used != null;
    const ratio = known ? (p.used as number) / limit : Number.POSITIVE_INFINITY;
    const free = known ? Math.max(limit - (p.used as number), 0) : -1;
    if (known && ratio >= 1) return; // full — the meter would block it anyway
    const cand = { idx, known, ratio, free };
    if (
      best === null ||
      (cand.known && !best.known) ||
      (cand.known === best.known && (cand.ratio < best.ratio || (cand.ratio === best.ratio && cand.free > best.free)))
    ) {
      best = cand;
    }
  });
  return best === null ? "" : pages[(best as { idx: number }).idx].id;
}

export type AcctLoad = {
  id: string;
  /** Launches already in the account's open 30-min window (own queued demand included). */
  count: number;
  /** When that window resets (epoch ms); null = no open window at all. */
  resetAt: number | null;
  disabled?: boolean;
};

/**
 * The account a picker should default to, relative to the launch timer: the fewest launches in
 * its open window first, then the window that resets SOONER (null = no window = best), then list
 * order. Accounts at the limit are skipped while any other has room. "" = nothing pickable.
 */
export function leastLoadedAccount(accounts: readonly AcctLoad[], limit: number): string {
  let best: { idx: number; count: number; resetAt: number } | null = null;
  const consider = (full: boolean) => {
    accounts.forEach((a, idx) => {
      if (a.disabled) return;
      const isFull = a.count >= limit;
      if (isFull !== full) return;
      const resetAt = a.resetAt ?? 0;
      const cand = { idx, count: a.count, resetAt };
      if (best === null || cand.count < best.count || (cand.count === best.count && cand.resetAt < best.resetAt)) {
        best = cand;
      }
    });
  };
  consider(false);
  if (best === null) consider(true);
  return best === null ? "" : accounts[(best as { idx: number }).idx].id;
}

/** Shape the client limit context into AcctLoad rows for `leastLoadedAccount`. */
export function accountLoads(
  ids: readonly { id: string; disabled?: boolean }[],
  limits: { countFor: (id: string) => number; resetAtFor: (id: string) => number | null },
): AcctLoad[] {
  return ids.map((a) => ({ id: a.id, count: limits.countFor(a.id), resetAt: limits.resetAtFor(a.id), disabled: a.disabled }));
}
