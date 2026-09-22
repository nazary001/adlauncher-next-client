// Server-only reader of LION's Google Ads metrics — the ONLY place LION exposes Google campaign
// facts (there is no Google details/ or targeting/ endpoint, probed 2026-09-14). One call per
// São Paulo day, cached 10 min per instance; source lookups scan back day by day and stop as soon
// as every id is found.

import { lionGet } from "./lion";
import { mapLionGoogleRow, saoPauloDate, type LionGoogleRow } from "./google-source";
import { readAppCacheDetailed, writeAppCache } from "./app-cache";
import { cleanGoogleAccountBook, mergeGoogleAccountBooks, mergeGoogleAccountDay, type GoogleAccountStatusBook } from "./google-account-status";

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

// ---------- account statuses (which launch accounts are suspended) ----------

/** The remembered book — one app-cache row shared by every instance (and outliving the scan
 *  window: a suspended account has no metrics rows a few days after the ban). */
export const GOOGLE_ACCOUNT_STATUS_KEY = "google-account-status";
const STATUS_SCAN_DAYS = 7;
const STATUS_TTL_MS = 10 * 60_000;
/** The catalog route answers in 30 s and LION may hang for 60: past this the scan is abandoned
 *  for THIS answer (it keeps running and warms the per-day cache for the next one). */
const STATUS_BUDGET_MS = 9_000;
let statusCache: { at: number; book: GoogleAccountStatusBook } | null = null;
let statusInflight: Promise<GoogleAccountStatusBook> | null = null;

async function scanGoogleAccountStatuses(now: Date): Promise<GoogleAccountStatusBook> {
  const stored = await readAppCacheDetailed<unknown>(GOOGLE_ACCOUNT_STATUS_KEY);
  const remembered = cleanGoogleAccountBook(stored.row?.value);
  const days = Array.from({ length: STATUS_SCAN_DAYS }, (_, d) => saoPauloDate(d, now));
  const reads = await Promise.allSettled(days.map((d) => lionGoogleMetrics(d)));
  let book = remembered;
  let changed = false;
  reads.forEach((r, i) => {
    if (r.status !== "fulfilled") return; // a day LION could not serve changes nothing
    const m = mergeGoogleAccountDay(book, days[i], r.value);
    book = m.book;
    changed = changed || m.changed;
  });
  // Never write over a row that could not be read (a Strapi blip would wipe the memory). Awaited:
  // a floating write dies with the serverless response; the caller's budget bounds the wait.
  if (changed && stored.ok) await writeAppCache(GOOGLE_ACCOUNT_STATUS_KEY, book, stored.row?.documentId ?? null);
  return book;
}

/**
 * customer id → the latest account status LION's metrics showed (last 7 São Paulo days folded over
 * the remembered book). Cached 10 min per instance. FAIL-OPEN by design: LION lag must never block
 * a launch — when the scan fails or runs out of time the last book this instance knew is served,
 * and with nothing known at all no account is hidden.
 */
export async function lionGoogleAccountStatuses(now: Date = new Date()): Promise<GoogleAccountStatusBook> {
  if (statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.book;
  if (!statusInflight) {
    statusInflight = scanGoogleAccountStatuses(now)
      .then((book) => {
        statusCache = { at: Date.now(), book: mergeGoogleAccountBooks(statusCache?.book ?? {}, book) };
        return statusCache.book;
      })
      .finally(() => {
        statusInflight = null;
      });
  }
  const fallback = statusCache?.book ?? {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outOfTime = new Promise<GoogleAccountStatusBook>((resolve) => {
    timer = setTimeout(() => resolve(fallback), STATUS_BUDGET_MS);
  });
  return Promise.race([statusInflight.catch(() => fallback), outOfTime]).finally(() => clearTimeout(timer));
}
