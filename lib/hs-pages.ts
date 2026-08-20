// Server-only client for the hs-tools pages registry (Hetzner Django, hs.gctracking.xyz):
// the ONE source for fanpage fill numbers (Meta's real used/limit per page, swept by the box's
// own checker) and the ledger every launch/duplicate reports its taken slots into. Replaces the
// per-instance Graph ads_volume sweeps and the LION metrics tally as the badge feed — those
// remain only as the keyless fallback (HS_PAGES_API_KEY unset = kill switch).
//
// Registry semantics (probed live 08-20):
//  - GET  <scope>/fb/api/v1/pages       → rows {page_id, name, limit, used, free, has_data, …};
//    has_data:false = the box never read this page's meter → numbers are null, NOT zero.
//  - POST <scope>/fb/api/v1/pages/used  → {"items":[{page_id, delta}]} — an optimistic counter:
//    free recalcs instantly, the box's next Facebook sweep overwrites with facts (by design).
// Scope = partner: HS rides the default tables, MO under /mo, AIF under /aif. The AIF scope is
// EMPTY until the box syncs AIF pages — reads answer zero rows and reports log "page not found",
// both harmless by construction here.

import type { PartnerId } from "./partners";

const BASE = (process.env.HS_PAGES_API_URL || "https://hs.gctracking.xyz").replace(/\/+$/, "");
const KEY = process.env.HS_PAGES_API_KEY ?? "";

/** hs-tools partner prefix per adlauncher partner (br = HS default tables). */
const SCOPE: Record<PartnerId, string> = { br: "", in: "/mo", us: "/aif" };

export const hsPagesConfigured = (): boolean => KEY.length > 0;

export type PageStats = {
  used: number;
  limit: number;
  free: number;
  restricted: boolean;
  /** Registry page state (ok / limited / no_access / …) — display material only. */
  state: string;
};

const CALL_TIMEOUT_MS = 15_000;
// Short on purpose: the registry is our own box and every launch report invalidates it anyway —
// this only dedupes the picker's polls across cards within one instance.
const STATS_TTL_MS = 60_000;

const statsCache = new Map<string, { at: number; stats: Record<string, PageStats> }>();
const statsInflight = new Map<string, Promise<Record<string, PageStats>>>();

type Json = Record<string, unknown>;

async function registryGet(partner: PartnerId, path: string): Promise<Json> {
  const res = await fetch(`${BASE}${SCOPE[partner]}${path}`, {
    headers: { "X-Api-Key": KEY },
    cache: "no-store",
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok || body.ok !== true) {
    throw new Error(`hs-pages GET ${path}: HTTP ${res.status} ${JSON.stringify(body.error ?? "")}`);
  }
  return body;
}

/**
 * used/limit per page id for a partner's scope. ONLY pages the registry has real numbers for
 * (has_data) are present — an absent id means "unknown", never "0 ads" (44 HS pages live like
 * that right now; painting them 0/250 would invite launches onto meters nobody has read).
 */
export async function hsToolsPageStats(partner: PartnerId): Promise<Record<string, PageStats>> {
  const cached = statsCache.get(partner);
  if (cached && Date.now() - cached.at < STATS_TTL_MS) return cached.stats;
  const inflight = statsInflight.get(partner);
  if (inflight) return inflight;

  const next = (async () => {
    const body = await registryGet(partner, "/fb/api/v1/pages");
    type Row = {
      page_id?: string;
      has_data?: boolean;
      limit?: number | null;
      used?: number | null;
      free?: number | null;
      restricted?: boolean;
      state?: string;
    };
    const stats: Record<string, PageStats> = {};
    for (const r of (body.pages as Row[] | undefined) ?? []) {
      if (!r?.page_id || r.has_data !== true) continue;
      if (typeof r.used !== "number" || typeof r.limit !== "number") continue;
      stats[String(r.page_id)] = {
        used: r.used,
        limit: r.limit,
        free: typeof r.free === "number" ? r.free : Math.max(r.limit - r.used, 0),
        restricted: r.restricted === true,
        state: String(r.state ?? ""),
      };
    }
    statsCache.set(partner, { at: Date.now(), stats });
    return stats;
  })().finally(() => {
    statsInflight.delete(partner);
  });
  statsInflight.set(partner, next);
  return next;
}

export function invalidateHsPages(partner: PartnerId): void {
  statsCache.delete(partner);
}

export type UsedReport = { pageId: string; delta: number };

/**
 * "I took N slots on these pages" — called right after ads land on Facebook (create AND
 * duplicate rails), so the registry's free counts move immediately instead of waiting for the
 * box's next sweep. FIRE-SAFE by contract: never throws, never stalls a launch beyond the call
 * timeout; a failed report only costs freshness (the sweep restores truth). Zero/invalid deltas
 * are dropped; an unregistered page logs "page not found" and the rest of the batch still lands.
 */
export async function reportPagesUsed(partner: PartnerId, items: UsedReport[]): Promise<void> {
  if (!hsPagesConfigured()) return;
  const clean = items
    .filter((i) => /^\d{5,}$/.test(i.pageId) && Number.isFinite(i.delta) && Math.round(i.delta) !== 0)
    .map((i) => ({ page_id: i.pageId, delta: Math.round(i.delta) }));
  if (clean.length === 0) return;
  try {
    const res = await fetch(`${BASE}${SCOPE[partner]}/fb/api/v1/pages/used`, {
      method: "POST",
      headers: { "X-Api-Key": KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ items: clean }),
      cache: "no-store",
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      errors?: Array<{ page_id?: string | null; error?: string }>;
    };
    for (const e of body.errors ?? []) {
      console.warn(`[hs-pages] used report (${partner}) ${e.page_id ?? "?"}: ${e.error}`);
    }
    // The registry moved — drop the cached stats so the next badge poll shows the new fill.
    if (body.ok) invalidateHsPages(partner);
  } catch (e) {
    console.warn(`[hs-pages] used report (${partner}) failed: ${(e as Error).message ?? e}`);
  }
}
