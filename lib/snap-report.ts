// Snapchat rail — the partner's DAILY REPORT as LION serves it, parsed into board rows. Pure and
// dependency-free (node --test). Live shape (probed 2026-09-16 with our LION_TOKEN):
//   GET /api/high-adx-cluster-utms/snapchat-report/?date=YYYY-MM-DD →
//   { date, affiliate:"globecoders", utm_prefix:"glo-snp_",
//     totals:    { revenue, forecasted_revenue, impressions, ecpm, triggered, fired, visitors, conversions },
//     campaigns: [ { utm_campaign:"glo-snp_001", …same metrics… } × 100 ] }
// "Today's numbers are partial and include a forecast; a day is final the next morning" — the
// day boundary is São Paulo like the rest of LION.

export type SnapReportMetrics = {
  revenue: number;
  forecastedRevenue: number;
  impressions: number;
  ecpm: number;
  /** Pixel events the partner triggered / actually fired on our pixel. */
  triggered: number;
  fired: number;
  visitors: number;
  conversions: number;
};

export type SnapReport = {
  date: string;
  affiliate: string;
  utmPrefix: string;
  totals: SnapReportMetrics;
  /** utm_campaign (our key) → its metrics. */
  byKey: Record<string, SnapReportMetrics>;
};

export const EMPTY_SNAP_METRICS: SnapReportMetrics = Object.freeze({
  revenue: 0,
  forecastedRevenue: 0,
  impressions: 0,
  ecpm: 0,
  triggered: 0,
  fired: 0,
  visitors: 0,
  conversions: 0,
}) as SnapReportMetrics;

const num = (v: unknown): number => {
  if (v == null || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string => (v == null ? "" : String(v));

function metricsOf(r: Record<string, unknown> | null | undefined): SnapReportMetrics {
  if (!r) return { ...EMPTY_SNAP_METRICS };
  return {
    revenue: num(r.revenue),
    forecastedRevenue: num(r.forecasted_revenue),
    impressions: num(r.impressions),
    ecpm: num(r.ecpm),
    triggered: num(r.triggered),
    fired: num(r.fired),
    visitors: num(r.visitors),
    conversions: num(r.conversions),
  };
}

/** LION body → SnapReport. Never throws: junk → zeros/empties, `date` falls back to the requested day. */
export function parseSnapReport(body: unknown, date: string): SnapReport {
  const rec = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const totals = metricsOf(rec.totals && typeof rec.totals === "object" ? (rec.totals as Record<string, unknown>) : null);
  const byKey: Record<string, SnapReportMetrics> = {};
  for (const row of Array.isArray(rec.campaigns) ? rec.campaigns : []) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const key = str(r.utm_campaign).trim();
    if (!key) continue;
    byKey[key] = metricsOf(r);
  }
  return { date: str(rec.date) || date, affiliate: str(rec.affiliate), utmPrefix: str(rec.utm_prefix), totals, byKey };
}

// ---------- dates (São Paulo, LION's day) ----------

function saoPauloISO(offsetDays: number, now: Date): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(now.getTime() - offsetDays * 86_400_000))
    .reduce<Record<string, string>>((acc, x) => ((acc[x.type] = x.value), acc), {});
  return `${p.year}-${p.month}-${p.day}`;
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `today` / `yesterday` / `YYYY-MM-DD` / empty (= today) → the report day; null when malformed
 *  or later than today in São Paulo (LION has nothing for the future). */
export function snapReportDate(param: string | null | undefined, now: Date = new Date()): string | null {
  const p = String(param ?? "").trim().toLowerCase();
  const today = saoPauloISO(0, now);
  if (!p || p === "today") return today;
  if (p === "yesterday") return saoPauloISO(1, now);
  const m = ISO_RE.exec(p);
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return p > today ? null : p;
}

/** Today (São Paulo) or later = still accumulating (+ the partner's forecast); earlier = final. */
export function isSnapReportPartial(date: string, now: Date = new Date()): boolean {
  return date >= saoPauloISO(0, now);
}
