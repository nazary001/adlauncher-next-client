// Pure decisions of the HS token-pool resilience layer (lib/hs-token-launch + lib/fb-graph).
// Deliberately dependency-free (no "@/" imports) so `node --test tests/token-pool-guards.test.ts`
// runs them straight off Node's type stripping — this module carries the DECISIONS; the pool and
// the Graph client own the I/O around them.

export type TokenHealthMark = { limitedUntil: number; reason: string };
export type TokenHealthRow = {
  health: Record<string, TokenHealthMark>;
  names: Record<string, { user?: string; app?: string }>;
};

export type TokenHealthDelta =
  | { kind: "mark"; fp: string; mark: TokenHealthMark }
  | { kind: "clear"; fp: string }
  | { kind: "names"; fp: string; names: { user?: string; app?: string } };

/**
 * Apply one writer's delta to the shared health row, pure and commutative where it matters:
 * a mark keeps the LATER cooldown of (stored, incoming), so two instances marking within the
 * same read-modify-write window converge instead of a stale base ever shortening a cooldown
 * another instance just extended. Never mutates the input row.
 */
export function applyHealthDelta(row: TokenHealthRow, d: TokenHealthDelta): TokenHealthRow {
  const next: TokenHealthRow = { health: { ...row.health }, names: { ...row.names } };
  if (d.kind === "mark") {
    const cur = next.health[d.fp];
    next.health[d.fp] = cur && cur.limitedUntil >= d.mark.limitedUntil ? cur : d.mark;
  } else if (d.kind === "clear") {
    delete next.health[d.fp];
  } else {
    next.names[d.fp] = { ...next.names[d.fp], ...d.names };
  }
  return next;
}

/**
 * APP-scoped Meta rate-limit codes — the ones a DIFFERENT FB app's bearer escapes: (#4) app
 * request limit and (#17) user-app pair limit. Account-scoped throttles (613, 80004, 80014,
 * is_transient) follow the ad account, so failing over gains nothing there and the retry
 * ladder stays the right answer.
 */
export function isAppLevelLimitCode(code: unknown): boolean {
  return code === 4 || code === 17;
}
