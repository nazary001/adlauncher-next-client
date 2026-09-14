// MO signer — server-only. WHICH bearer signs the MO direct-Graph rails is the owner's call
// on /tokens (lib/fb-tokens, owner ask 2026-09-14): one token for launches, one for clones,
// picked from the vault (or, while a slot is unassigned, today's env default: the system-class
// entry of FB_MO_SOC_TOKENS, else its first soc). The per-buyer "soc channel" switch of 08-27
// is gone — a wave signs as what the owner assigned, never as whatever a tab remembered.
//
// `sys` mirrors the token's class: a personal soc profile (`personal:true` in the vault, or a
// non-system FB_MO_SOC_TOKENS entry) births campaigns with the ` SOC - ` name marker and a
// `soc:` gcm-registry note; system users go unmarked / `sys:` — audits must not read
// system-born runs as соц-born.

import type { TokenCatalog } from "./fb-graph";
import { type ResolvedToken, resolveSlot } from "./fb-tokens";
import { type TokenRail, slotOf } from "./fb-token-registry";

export type MoSigner = {
  /** Display label (vault label / soc name) — rides into names, notes and task rows. */
  name: string;
  id: string;
  /** The bearer that signs EVERY Graph call of the run. Server-only. */
  token: string;
  /** System-class signer (no SOC marker, `sys:` note) vs a personal soc profile. */
  sys: boolean;
  /** Catalog identity — own in-process caches + own app-cache row per bearer. */
  cat: TokenCatalog;
  source: "registry" | "env";
};

export type MoSignerResult = { ok: true; signer: MoSigner } | { ok: false; error: string };

const toSigner = (t: ResolvedToken): MoSigner => ({
  name: t.label,
  id: t.id,
  token: t.token,
  sys: !t.personal,
  cat: { token: t.token, cacheKey: t.cacheKey },
  source: t.source,
});

/**
 * The MO signer of one rail. An error is a CLEAN config verdict for the route (400-class):
 * "no token assigned and no env default" or "assigned token unreadable" — the route must
 * surface it verbatim, never guess another bearer (the wave was aimed at the owner's pick).
 */
export async function resolveMoSigner(rail: TokenRail): Promise<MoSignerResult> {
  const r = await resolveSlot(slotOf("mo", rail));
  if (!r.ok || r.tokens.length === 0) return { ok: false, error: r.error ?? "no_token" };
  return { ok: true, signer: toSigner(r.tokens[0]) };
}

/** URL `?rail=` → the MO rail a catalog read serves ("launch" unless the clone board asks). */
export function railParam(raw: unknown): TokenRail {
  return String(raw ?? "") === "clone" ? "clone" : "launch";
}
