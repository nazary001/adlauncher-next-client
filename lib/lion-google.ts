// Server-only reader of LION's Google Ads metrics — the ONLY place LION exposes Google campaign
// facts (there is no Google details/ or targeting/ endpoint, probed 2026-09-14). One call per
// São Paulo day, cached 10 min per instance; source lookups scan back day by day and stop as soon
// as every id is found.

import { lionGet } from "./lion";
import { mapLionGoogleRow, saoPauloDate, type LionGoogleRow } from "./google-source";

type CacheEntry = { at: number; rows: LionGoogleRow[] };
const TTL_MS = 10 * 60_000;
const byDate = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<LionGoogleRow[]>>();

/** All of our team's Google campaigns that had a metrics row on `date` (YYYY-MM-DD, São Paulo). */
export async function lionGoogleMetrics(date: string): Promise<LionGoogleRow[]> {
  const hit = byDate.get(date);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;
  const running = inflight.get(date);
  if (running) return running;
  const p = (async () => {
    try {
      const body = await lionGet(`/api/google/campaigns/metrics/?date=${encodeURIComponent(date)}`);
      const raw = Array.isArray(body)
        ? (body as Record<string, unknown>[])
        : Array.isArray((body as Record<string, unknown> | null)?.campaigns)
          ? ((body as Record<string, unknown>).campaigns as Record<string, unknown>[])
          : [];
      const rows = raw.map(mapLionGoogleRow).filter((r) => r.campaignId);
      // An empty day is a legitimate answer (nothing ran) — cache it too, but briefly, so a LION
      // hiccup that answered [] doesn't hide a whole day's campaigns for 10 min.
      byDate.set(date, { at: rows.length ? Date.now() : Date.now() - TTL_MS + 60_000, rows });
      return rows;
    } finally {
      inflight.delete(date);
    }
  })();
  inflight.set(date, p);
  return p;
}

/**
 * Find source campaigns by id: today first, then yesterday, … up to `days` back (São Paulo),
 * stopping once every id has a row. The freshest day wins for an id seen on several days. Ids
 * still unknown after the window are simply absent from the map (the caller marks them
 * "unknown to LION metrics" — the dataset fetch is the real launch gate).
 */
export async function lionGoogleFindCampaigns(ids: string[], days = 7, now: Date = new Date()): Promise<Record<string, LionGoogleRow>> {
  const wanted = new Set(ids);
  const found: Record<string, LionGoogleRow> = {};
  for (let d = 0; d < days && wanted.size > 0; d++) {
    const rows = await lionGoogleMetrics(saoPauloDate(d, now));
    for (const r of rows) {
      if (wanted.has(r.campaignId)) {
        found[r.campaignId] = r;
        wanted.delete(r.campaignId);
      }
    }
  }
  return found;
}
