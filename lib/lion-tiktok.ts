// Server-only reader of LION's TikTok metrics — the place LION exposes TikTok campaign facts (name,
// status, budget, bid, landing, advertiser). One call per São Paulo day (~1.6 s, ~1.6k rows for our
// team), cached 10 min per instance; source lookups scan back day by day and stop as soon as every
// id is found. Money arrives already converted to USD floats (LION's TikTok exception).

import { lionGet } from "./lion";
import { mapLionTiktokRow, rankTiktokLandings, saoPauloDate, type LionTiktokRow } from "./tiktok-source";

type CacheEntry = { at: number; rows: LionTiktokRow[] };
const TTL_MS = 10 * 60_000;
const byDate = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<LionTiktokRow[]>>();

/** All of our team's TikTok campaigns that had a metrics row on `date` (YYYY-MM-DD, São Paulo). */
export async function lionTiktokMetrics(date: string): Promise<LionTiktokRow[]> {
  const hit = byDate.get(date);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;
  const running = inflight.get(date);
  if (running) return running;
  const p = (async () => {
    try {
      const body = await lionGet(`/api/tiktok/campaigns/metrics/?date=${encodeURIComponent(date)}`);
      const raw = Array.isArray(body)
        ? (body as Record<string, unknown>[])
        : Array.isArray((body as Record<string, unknown> | null)?.campaigns)
          ? ((body as Record<string, unknown>).campaigns as Record<string, unknown>[])
          : [];
      const rows = raw.map(mapLionTiktokRow).filter((r) => r.campaignId);
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
 * still unknown after the window are simply absent from the map (the caller marks them "unknown to
 * LION metrics" — the partner's dataset is the real launch gate).
 */
export async function lionTiktokFindCampaigns(ids: string[], days = 7, now: Date = new Date()): Promise<Record<string, LionTiktokRow>> {
  const wanted = new Set(ids);
  const found: Record<string, LionTiktokRow> = {};
  for (let d = 0; d < days && wanted.size > 0; d++) {
    const rows = await lionTiktokMetrics(saoPauloDate(d, now));
    for (const r of rows) {
      if (wanted.has(r.campaignId)) {
        found[r.campaignId] = r;
        wanted.delete(r.campaignId);
      }
    }
  }
  return found;
}

/** The bare landings the team's TikTok campaigns run today and yesterday, most used first — every
 *  one is on LION's allowed-domain list by construction (the launcher's landing suggestions). */
export async function lionTiktokLandings(limit = 40, now: Date = new Date()): Promise<{ url: string; count: number }[]> {
  const [today, yesterday] = await Promise.all([
    lionTiktokMetrics(saoPauloDate(0, now)).catch(() => [] as LionTiktokRow[]),
    lionTiktokMetrics(saoPauloDate(1, now)).catch(() => [] as LionTiktokRow[]),
  ]);
  // One row per campaign: a campaign running both days must not count twice.
  const byId = new Map<string, LionTiktokRow>();
  for (const r of [...yesterday, ...today]) byId.set(r.campaignId, r);
  return rankTiktokLandings([...byId.values()], limit);
}
