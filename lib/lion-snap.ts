// Server-only reader of the partner's Snapchat daily report as LION serves it (the ONLY revenue
// source for the Snap rail; probed live 2026-09-16 with our LION_TOKEN). One call per day, cached
// 10 min per instance — "one call per day" is the partner's ask, and every keys-page open of the
// team collapses onto this cache. Pure parsing lives in lib/snap-report.ts.

import { lionGet } from "./lion";
import { parseSnapReport, type SnapReport } from "./snap-report";

type CacheEntry = { at: number; report: SnapReport };
const TTL_MS = 10 * 60_000;
const SHORT_TTL_MS = 60_000;
const byDate = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<SnapReport>>();

/** The report for `date` (YYYY-MM-DD, São Paulo). An all-zero answer is cached only briefly so a
 *  LION hiccup that answered zeros can't hide a day's revenue for 10 min. */
export async function lionSnapReport(date: string): Promise<SnapReport> {
  const hit = byDate.get(date);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.report;
  const running = inflight.get(date);
  if (running) return running;
  const p = (async () => {
    try {
      const body = await lionGet(`/api/high-adx-cluster-utms/snapchat-report/?date=${encodeURIComponent(date)}`);
      const report = parseSnapReport(body, date);
      const allZero = report.totals.revenue === 0 && report.totals.visitors === 0 && report.totals.impressions === 0;
      byDate.set(date, { at: allZero ? Date.now() - TTL_MS + SHORT_TTL_MS : Date.now(), report });
      return report;
    } finally {
      inflight.delete(date);
    }
  })();
  inflight.set(date, p);
  return p;
}
