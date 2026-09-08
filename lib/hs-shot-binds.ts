// Per-shot destination binds for the HS wave routes (duplicate / token-duplicate / jurar /
// token-jurar). Pure and dependency-free on purpose — `node --test tests/hs-shot-binds.test.ts`
// runs it straight off Node's type stripping (extensionless "./x" imports would break there).
//
// Owner ask 2026-09-08: one wave may mix destinations — every ROW of the clone board can carry
// its own profile / account / page / pixel (and its own copies) instead of the single Settings
// bind the whole wave used to share. The wire stays backward compatible: a shot without binds
// rides the WAVE-level ones (old tabs, curl); a shot's own field wins over the wave's, field by
// field, and the RESOLVED tuple is what the routes validate against LION's catalog (account on
// profile, page on profile, pixel on account) — so a half-override that mixes a foreign page
// into a row's own profile is refused before any work, exactly like a bad wave-level bind.

export type ShotBinds = { profile: string; account: string; page: string; pixel: string };

export type RawShotBinds = { profile?: unknown; account?: unknown; page?: unknown; pixel?: unknown };

const str = (v: unknown): string => String(v ?? "").trim();

/**
 * Resolve one shot's destination: its own fields win, the wave-level ones fill the gaps. `page`
 * is required only on the page-binding rails (the cloner); the JURO rails carry none (the ads
 * live on the source post's own fanpage). Returns the bound tuple, or the first missing field
 * as the same error code the wave-level checks always used.
 */
export function resolveShotBinds(
  raw: RawShotBinds | null | undefined,
  wave: Partial<ShotBinds>,
  needsPage: boolean,
): ShotBinds | { error: string } {
  const b: ShotBinds = {
    profile: str(raw?.profile) || str(wave.profile),
    account: str(raw?.account) || str(wave.account),
    page: needsPage ? str(raw?.page) || str(wave.page) : "",
    pixel: str(raw?.pixel) || str(wave.pixel),
  };
  if (!b.profile) return { error: "profile_required" };
  if (!b.account) return { error: "account_required" };
  if (needsPage && !b.page) return { error: "page_required" };
  if (!b.pixel) return { error: "pixel_required" };
  return b;
}

/** Identity of a bind tuple — catalog validation runs ONCE per distinct tuple, however many
 *  shots of the wave share it. */
export const bindsKey = (b: ShotBinds): string => `${b.profile}|${b.account}|${b.page}|${b.pixel}`;

/** Canonical account key (`act_` stripped) — mirrors lib/acct-limit's acctKey without importing it. */
export const shotAcctKey = (raw: string): string => String(raw ?? "").trim().replace(/^act_/, "");

/** Distinct values of one bind field across the wave (order of first appearance). */
export function distinctBy<T>(shots: readonly T[], pick: (s: T) => string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of shots) {
    const v = pick(s);
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** Shots per target account (canonical key) — the launch-limit precheck's demand. */
export function demandByAccount<T>(shots: readonly T[], accountOf: (s: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of shots) {
    const k = shotAcctKey(accountOf(s));
    if (!k) continue;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

export type AcctWindowInfo = { count: number; resetAt: number; name?: string };

/**
 * Wave-level launch-limit precheck over EVERY account the wave targets (5 campaigns / 30 min per
 * ad account — owner rule 2026-08-18; per-row destinations 09-08): the first account whose open
 * window can't take its share refuses the whole wave, with the countdown text the caller
 * renders (`message(resetAt)`). null = every account fits. The per-shot claim in the pump stays
 * the authority — this only stops doomed waves before any row is stamped.
 */
export function acctLimitRefusal(
  demand: ReadonlyMap<string, number>,
  accounts: Readonly<Record<string, AcctWindowInfo | undefined>>,
  limit: number,
  message: (resetAt: number) => string,
  noun = "clones",
): { error: string; status: number } | null {
  for (const [acct, need] of demand) {
    const info = accounts[acct];
    const remaining = limit - (info?.count ?? 0);
    const who = info?.name ? `${info.name} (${acct})` : acct;
    if (info && remaining <= 0) return { error: `${message(info.resetAt)} — account ${who}`, status: 429 };
    if (need > remaining) {
      const tail = info ? ` — ${message(info.resetAt)}` : "";
      return {
        error: `account_limit — only ${Math.max(0, remaining)} of ${need} ${noun} fit account ${who}'s 30-min window${tail}`,
        status: 429,
      };
    }
  }
  return null;
}
