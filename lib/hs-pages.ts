// Server-only client for the hs-tools pages registry (Hetzner Django, hs.gctracking.xyz):
// the ONE source for fanpage fill numbers (Meta's real used/limit per page, swept by the box's
// own checker), the ledger every launch/duplicate reports its taken slots into, AND — since
// 09-07 — the fanka STATUS the HS rail gates on (lib/hs-page-gate: only `state: "ok"` pages
// are offered or launched on). Replaces the per-instance Graph ads_volume sweeps and the LION
// metrics tally as the badge feed — those remain only as the keyless fallback for the badges
// (HS_PAGES_API_KEY unset = kill switch for the fill numbers; the status gate then FAILS CLOSED,
// see hsPageRefusal).
//
// Registry semantics (probed live 08-20, states re-probed 09-07):
//  - GET  <scope>/fb/api/v1/pages       → rows {page_id, name, state, limit, used, free, has_data, …};
//    has_data:false = the box never read this page's meter → numbers are null, NOT zero — but
//    the row still carries a `state` (no_access …), and the state is what gates.
//  - POST <scope>/fb/api/v1/pages/used  → {"items":[{page_id, delta}]} — an optimistic counter:
//    free recalcs instantly, the box's next Facebook sweep overwrites with facts (by design).
// Scope = partner: HS rides the default tables, MO under /mo, AIF under /aif. The AIF scope is
// EMPTY until the box syncs AIF pages — reads answer zero rows and reports log "page not found",
// both harmless by construction here.

import { gatePages, pageGateRefusal, registryRowStates } from "./hs-page-gate";
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
  /** Registry page state (ok / banned / pub_stale / no_access / …) — display material here;
   *  the gate reads hsToolsPageStates, which covers rows WITHOUT numbers too. */
  state: string;
  /** Page display name as the registry knows it ("" = registry row carries none) — lets boards
   *  name pages outside the picked profile's catalog (JURO source pages). */
  name: string;
};

const CALL_TIMEOUT_MS = 15_000;
// Short on purpose: the registry is our own box and every launch report invalidates it anyway —
// this only dedupes the picker's polls across cards within one instance.
const STATS_TTL_MS = 60_000;
// A registry blip must not turn into a wall of "status unavailable" refusals mid-wave: a read
// that fails inside this window serves the last good snapshot instead. The box re-checks pages
// on its own cadence anyway, so a snapshot this old is as fresh as the gate ever gets between
// two of its sweeps; older than this the gate refuses rather than trusts (fail closed).
const STALE_MAX_MS = 15 * 60_000;

type RegistryRow = {
  page_id?: string | number;
  name?: string | null;
  has_data?: boolean;
  limit?: number | null;
  used?: number | null;
  free?: number | null;
  restricted?: boolean;
  state?: string;
};

/** One registry read, shaped three ways: fill stats (numbered rows only), state per row (ALL
 *  rows — the gate), registry names (ALL rows — refusal texts for pages outside a catalog). */
type Snapshot = {
  readAt: number;
  /** A used-report moved the registry → refetch on the next read, but keep this as the stale
   *  fallback (the numbers are merely optimistic-behind, the states unchanged). */
  expired: boolean;
  stats: Record<string, PageStats>;
  states: Record<string, string>;
  names: Record<string, string>;
};

const snapshots = new Map<string, Snapshot>();
const inflight = new Map<string, Promise<Snapshot>>();

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

function shapeSnapshot(rows: RegistryRow[]): Snapshot {
  const stats: Record<string, PageStats> = {};
  const names: Record<string, string> = {};
  for (const r of rows) {
    if (!r?.page_id) continue;
    const id = String(r.page_id);
    if (r.name) names[id] = String(r.name);
    // ONLY pages the registry has real numbers for (has_data) get stats — an absent id means
    // "unknown", never "0 ads" (painting them 0/250 would invite launches onto meters nobody
    // has read).
    if (r.has_data !== true) continue;
    if (typeof r.used !== "number" || typeof r.limit !== "number") continue;
    stats[id] = {
      used: r.used,
      limit: r.limit,
      free: typeof r.free === "number" ? r.free : Math.max(r.limit - r.used, 0),
      restricted: r.restricted === true,
      state: String(r.state ?? ""),
      name: String(r.name ?? ""),
    };
  }
  return { readAt: Date.now(), expired: false, stats, states: registryRowStates(rows), names };
}

/** The partner scope's registry snapshot: fresh within STATS_TTL_MS, else re-read (one fetch
 *  per scope at a time); a failed re-read serves the last snapshot while it is younger than
 *  STALE_MAX_MS and throws beyond that. */
async function registrySnapshot(partner: PartnerId): Promise<Snapshot> {
  const cached = snapshots.get(partner);
  if (cached && !cached.expired && Date.now() - cached.readAt < STATS_TTL_MS) return cached;
  const running = inflight.get(partner);
  if (running) return running;

  const next = (async () => {
    try {
      const body = await registryGet(partner, "/fb/api/v1/pages");
      const snap = shapeSnapshot((body.pages as RegistryRow[] | undefined) ?? []);
      snapshots.set(partner, snap);
      return snap;
    } catch (e) {
      const stale = snapshots.get(partner);
      if (stale && Date.now() - stale.readAt < STALE_MAX_MS) {
        console.warn(`[hs-pages] registry read (${partner}) failed, serving the last snapshot: ${(e as Error).message ?? e}`);
        return stale;
      }
      throw e;
    }
  })().finally(() => {
    inflight.delete(partner);
  });
  inflight.set(partner, next);
  return next;
}

/**
 * used/limit per page id for a partner's scope. ONLY pages the registry has real numbers for
 * (has_data) are present — an absent id means "unknown", never "0 ads" (44 HS pages live like
 * that right now; painting them 0/250 would invite launches onto meters nobody has read).
 */
export async function hsToolsPageStats(partner: PartnerId): Promise<Record<string, PageStats>> {
  return (await registrySnapshot(partner)).stats;
}

/**
 * Registry `state` per page id for a partner's scope — EVERY row, numbers or not (a no_access
 * page has no meter but has a state, and that state is what the HS gate reads). A page absent
 * from the map has no registry row at all. Throws when the registry is unreachable and no
 * usable snapshot exists (callers fail closed on that).
 */
export async function hsToolsPageStates(partner: PartnerId): Promise<Record<string, string>> {
  return (await registrySnapshot(partner)).states;
}

export function invalidateHsPages(partner: PartnerId): void {
  const s = snapshots.get(partner);
  if (s) s.expired = true;
}

export type HsPageRefusal = { error: string; status: number };

const GATE_RULE = "the HS rail launches only on fankas hs-tools marks OK";

/**
 * Fire-time fanka gate (owner rule 2026-09-07) for one launch's page set: null = every page is
 * OK in the registry; otherwise the refusal to answer with — a readable reason (400) naming the
 * offending fanka and its state, or "status unavailable" (503) when the registry is off or
 * unreachable: the rule is unconditional, so no verdict means no launch, never a silent pass.
 * Names decorate the reason: the caller's catalog name first, the registry's as fallback.
 */
export async function hsPageRefusal(
  partner: PartnerId,
  pages: ReadonlyArray<{ id: string; name?: string }>,
): Promise<HsPageRefusal | null> {
  if (!hsPagesConfigured()) {
    return { error: `fanka_status_unavailable — HS_PAGES_API_KEY is not configured; ${GATE_RULE}`, status: 503 };
  }
  let snap: Snapshot;
  try {
    snap = await registrySnapshot(partner);
  } catch (e) {
    return {
      error: `fanka_status_unavailable — hs-tools registry unreachable (${(e as Error).message ?? e}); ${GATE_RULE}`,
      status: 503,
    };
  }
  const named = pages.map((p) => ({ id: p.id, name: p.name || snap.names[p.id] || undefined }));
  const reason = pageGateRefusal(named, snap.states);
  return reason ? { error: reason, status: 400 } : null;
}

/**
 * Picker-side gate (same rule, same source): a profile's page catalog reduced to the fankas the
 * registry marks OK, plus how many it hid. Registry off/unreachable = NOTHING offered — the
 * pickers show `unavailable` as the reason instead of pages the fire-time gate would refuse.
 */
export async function hsOfferablePages<T extends { id: string }>(
  partner: PartnerId,
  pages: readonly T[],
): Promise<{ pages: T[]; hidden: number; unavailable: string | null }> {
  if (!hsPagesConfigured()) {
    return { pages: [], hidden: pages.length, unavailable: "HS_PAGES_API_KEY is not configured" };
  }
  let states: Record<string, string>;
  try {
    states = await hsToolsPageStates(partner);
  } catch (e) {
    return { pages: [], hidden: pages.length, unavailable: `hs-tools registry unreachable (${(e as Error).message ?? e})` };
  }
  const { offered, hidden } = gatePages(pages, states);
  return { pages: offered, hidden: hidden.length, unavailable: null };
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
