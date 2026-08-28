// MO "soc" launch channel — server-only registry of PERSONAL user tokens (наши соцы) that can
// sign the SAME direct-Graph launch tree the system-user token builds. The board offers a
// channel switch (System token ↔ each provisioned soc); the launch route resolves the pick here
// and threads the chosen bearer through every Graph call. Why it exists: Meta's business-level
// restrictions can hit the system-user token (e.g. the 08-27 VD-C1 ADSET-CREATE wall) while
// personal profiles keep passing — the soc channel launches as those profiles, no LION involved.
//
// Env: FB_MO_SOC_TOKENS = JSON array of { name, token, system? } entries, e.g.
//   [{"name":"Spencermo","token":"EAAY…","system":true},{"name":"MO-1","token":"EAAB…"}]
// `name` is the label shown on the board's channel switch (letters/digits/._- only, ≤24 chars);
// the token is that entry's long-lived access token (ads_management + business_management +
// pages_show_list / pages_manage_ads). `system:true` marks an ALTERNATE SYSTEM USER (e.g. a
// partner-BM system user that dodges a business-level ward on ours) rather than a personal соц:
// same switch, same threading, but its launches carry NO "SOC - " name marker and the gcm
// registry note says `sys:` — audits must not read system-born runs as соц-born. Removing an
// entry (or the whole env) kills the channel — in-flight picks fail with a clean config error
// instead of silently falling back to the default system token (the wave was aimed at this
// signer; a silent fallback would launch it into the restriction the buyer was routing around).

import type { TokenCatalog } from "./fb-graph";

type SocEntry = { name: string; token: string; system: boolean };

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
      const system = (e as { system?: unknown } | null)?.system === true;
      // Names travel in URLs, cache keys and campaign-name-adjacent notes — keep them boring.
      if (!/^[\w.-]{1,24}$/.test(name) || !token || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, token, system });
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

// ---- live token health (the board's switch shows WHY a soc's catalogs come back empty) --------

type ProbeResult = { ok: boolean; error?: string };
/** Verdicts cached per soc for a minute — every board mount pings, and 5 socs must not turn a
 *  team's morning into a Graph-call storm. Transient probe failures are NOT cached. */
const probeCache = new Map<string, { at: number; res: ProbeResult }>();
const PROBE_TTL_MS = 60_000;
const GRAPH = "https://graph.facebook.com/v21.0";

/** One soc's health: a tiny RAW `/me` read — deliberately not fbGet, whose budget/backoff would
 *  turn a dead-token verdict into a patient multi-second retry. FB's own error text IS the
 *  diagnosis the buyer needs ("session has been invalidated…" = re-issue this soc's token). */
async function probeSoc(e: SocEntry): Promise<ProbeResult> {
  const hit = probeCache.get(e.name);
  if (hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.res;
  let res: ProbeResult;
  try {
    const r = await fetch(`${GRAPH}/me?fields=id&access_token=${encodeURIComponent(e.token)}`, {
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    const j = (await r.json().catch(() => null)) as
      | { id?: string; error?: { message?: string; code?: number; error_subcode?: number } }
      | null;
    if (j?.id) res = { ok: true };
    else {
      const err = j?.error;
      res = {
        ok: false,
        error: err
          ? `(#${err.code ?? "?"}${err.error_subcode ? `/${err.error_subcode}` : ""}) ${err.message ?? "token rejected"}`
          : `HTTP ${r.status}`,
      };
    }
  } catch {
    return { ok: false, error: "probe timeout — Graph unreachable" }; // transient: not cached
  }
  probeCache.set(e.name, { at: Date.now(), res });
  return res;
}

export type SocStatus = { name: string; ok: boolean; error?: string; system?: boolean };

/** Every provisioned soc with its live token verdict (probed in parallel, 60s cache). */
export async function moSocStatuses(): Promise<SocStatus[]> {
  return Promise.all(
    SOCS.map(async (s) => ({ name: s.name, ...(s.system ? { system: true } : {}), ...(await probeSoc(s)) })),
  );
}

export type MoChannel =
  | { kind: "system" }
  | { kind: "soc"; name: string; token: string; sys: boolean; cat: TokenCatalog };

/**
 * Resolve the wire channel value ("" / "system" / "soc:<name>") to a launch channel.
 * null = the client named a soc this server doesn't carry (stale tab, mid-deploy env change) —
 * callers surface that as a config error rather than guessing a token. `sys` mirrors the
 * entry's `system` flag (alternate system user: no SOC name marker, `sys:` registry note).
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
  return { kind: "soc", name: e.name, token: e.token, sys: e.system, cat: { token: e.token, cacheKey: `mo-soc-${e.name}` } };
}
