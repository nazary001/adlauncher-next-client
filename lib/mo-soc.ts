// MO "soc" launch channel — server-only registry of PERSONAL user tokens (наши соцы) that can
// sign the SAME direct-Graph launch tree the system-user token builds. The board offers a
// channel switch (System token ↔ each provisioned soc); the launch route resolves the pick here
// and threads the chosen bearer through every Graph call. Why it exists: Meta's business-level
// restrictions can hit the system-user token (e.g. the 08-27 VD-C1 ADSET-CREATE wall) while
// personal profiles keep passing — the soc channel launches as those profiles, no LION involved.
//
// Env: FB_MO_SOC_TOKENS = JSON array of { name, token } entries, e.g.
//   [{"name":"aleph","token":"EAAB…"},{"name":"userforhs","token":"EAAB…"}]
// `name` is the label shown on the board's channel switch (letters/digits/._- only, ≤24 chars);
// the token is that соц's long-lived user access token (ads_management + business_management +
// pages_show_list / pages_manage_ads). Removing an entry (or the whole env) kills the channel —
// in-flight picks fail with a clean config error instead of silently falling back to the system
// token (the wave was aimed at the soc; a silent fallback would launch it into the restriction
// the buyer was routing around).

import type { TokenCatalog } from "./fb-graph";

type SocEntry = { name: string; token: string };

function parseSocs(): SocEntry[] {
  const raw = process.env.FB_MO_SOC_TOKENS ?? "";
  if (!raw.trim()) return [];
  try {
    const j = JSON.parse(raw) as unknown;
    const list = Array.isArray(j) ? j : [];
    const out: SocEntry[] = [];
    const seen = new Set<string>();
    for (const e of list) {
      const name = String((e as { name?: unknown } | null)?.name ?? "").trim();
      const token = String((e as { token?: unknown } | null)?.token ?? "").trim();
      // Names travel in URLs, cache keys and campaign-name-adjacent notes — keep them boring.
      if (!/^[\w.-]{1,24}$/.test(name) || !token || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, token });
    }
    return out;
  } catch {
    return []; // malformed env = channel simply not provisioned; the board then hides the switch
  }
}

const SOCS = parseSocs();

/** Soc labels for the board's channel switch (names only — tokens never leave the server). */
export function moSocNames(): string[] {
  return SOCS.map((s) => s.name);
}

export type MoChannel =
  | { kind: "system" }
  | { kind: "soc"; name: string; token: string; cat: TokenCatalog };

/**
 * Resolve the wire channel value ("" / "system" / "soc:<name>") to a launch channel.
 * null = the client named a soc this server doesn't carry (stale tab, mid-deploy env change) —
 * callers surface that as a config error rather than guessing a token.
 */
export function resolveMoChannel(raw: unknown): MoChannel | null {
  const v = String(raw ?? "").trim();
  if (!v || v === "system") return { kind: "system" };
  const m = /^soc:(.+)$/.exec(v);
  if (!m) return null;
  const e = SOCS.find((s) => s.name === m[1]);
  if (!e) return null;
  // Own cache identity per soc: its me/accounts + me/adaccounts catalogs must never bleed into
  // the system token's (same discipline as the AIF catalog in lib/fb-graph).
  return { kind: "soc", name: e.name, token: e.token, cat: { token: e.token, cacheKey: `mo-soc-${e.name}` } };
}
