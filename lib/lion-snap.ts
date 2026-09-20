// Server-only reader of the partner's Snapchat daily report as LION serves it (the ONLY revenue
// source for the Snap rail; probed live 2026-09-16 with our LION_TOKEN). One call per day, cached
// per instance — "one call per day" is the partner's ask, and every keys-page open of the team
// collapses onto this cache. A range is read as its days, so the cache is what keeps a "last 30
// days" from being thirty calls each time. Pure parsing lives in lib/snap-report.ts.

import { lionGet } from "./lion";
import { isSnapReportPartial, isSnapReportSettled, parseSnapReport, type SnapReport, type SnapReportDay } from "./snap-report";

type CacheEntry = { at: number; ttl: number; report: SnapReport };
/** Today and yesterday still move (a day "is final the next morning"). */
const TTL_MS = 10 * 60_000;
/** A settled day never changes again — it is held for hours, not minutes. */
const SETTLED_TTL_MS = 6 * 60 * 60_000;
const SHORT_TTL_MS = 60_000;
const byDate = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<SnapReport>>();

/** The report for `date` (YYYY-MM-DD, São Paulo). An all-zero answer is cached only briefly so a
 *  LION hiccup that answered zeros can't hide a day's revenue — 1 min for a day that still moves,
 *  10 min for a settled one (a quiet day inside a long range must not be re-asked every minute). */
export async function lionSnapReport(date: string): Promise<SnapReport> {
  const hit = byDate.get(date);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.report;
  const running = inflight.get(date);
  if (running) return running;
  const p = (async () => {
    try {
      const body = await lionGet(`/api/high-adx-cluster-utms/snapchat-report/?date=${encodeURIComponent(date)}`);
      const report = parseSnapReport(body, date);
      const allZero = report.totals.revenue === 0 && report.totals.visitors === 0 && report.totals.impressions === 0;
      const settled = isSnapReportSettled(date);
      if (byDate.size > 120) for (const [k, c] of byDate) if (Date.now() - c.at >= c.ttl) byDate.delete(k);
      byDate.set(date, { at: Date.now(), ttl: allZero ? (settled ? TTL_MS : SHORT_TTL_MS) : settled ? SETTLED_TTL_MS : TTL_MS, report });
      return report;
    } finally {
      inflight.delete(date);
    }
  })();
  inflight.set(date, p);
  return p;
}

/** Days read at once — LION is shared with every other rail's reads. */
const RANGE_CONCURRENCY = 4;
/** A day is given this long; its read keeps running past it and fills the cache for the next ask. */
const DAY_TIMEOUT_MS = 20_000;
/** No day is STARTED after this: the slowest admitted one still ends inside the route's 60 s. */
const RANGE_START_BUDGET_MS = 35_000;

/** The days of a range, each best-effort: a day LION did not answer for comes back with
 *  `report: null` and the reason — one bad day never costs the whole range. */
export async function lionSnapReportDays(dates: string[]): Promise<SnapReportDay[]> {
  const startedAt = Date.now();
  const out: SnapReportDay[] = dates.map((date) => ({ date, partial: isSnapReportPartial(date), report: null }));
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < out.length; i = next++) {
      if (Date.now() - startedAt > RANGE_START_BUDGET_MS) {
        out[i].error = "not read — LION is answering slowly";
        continue;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const read = lionSnapReport(out[i].date);
        // A lone day keeps lionGet's own patience (it is the whole answer); inside a range a slow day is skipped.
        const late = new Promise<never>((_, reject) => {
          if (out.length > 1) timer = setTimeout(() => reject(new Error(`no answer in ${DAY_TIMEOUT_MS / 1000} s`)), DAY_TIMEOUT_MS);
        });
        out[i].report = await Promise.race([read, late]);
      } catch (e) {
        out[i].error = (e instanceof Error ? e.message : String(e)).slice(0, 160);
      } finally {
        clearTimeout(timer);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(RANGE_CONCURRENCY, out.length) }, worker));
  return out;
}
