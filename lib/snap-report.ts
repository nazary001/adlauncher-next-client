// Snapchat rail — the partner's DAILY REPORT as LION serves it, parsed into board rows. Pure and
// dependency-free (node --test). Live shape (probed 2026-09-16 with our LION_TOKEN):
//   GET /api/high-adx-cluster-utms/snapchat-report/?date=YYYY-MM-DD →
//   { date, affiliate:"globecoders", utm_prefix:"glo-snp_",
//     totals:    { revenue, forecasted_revenue, impressions, ecpm, triggered, fired, visitors, conversions },
//     campaigns: [ { utm_campaign:"glo-snp_001", …same metrics… } × up to 500 ] }
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
  if (!isCalendarDay(p)) return null;
  return p > today ? null : p;
}

/** `YYYY-MM-DD` that names a real day. */
function isCalendarDay(p: string): boolean {
  const m = ISO_RE.exec(p);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  // A Date.UTC round-trip rejects the impossible days the range check lets through (2026-02-31
  // rolls over to 03-03 — LION would answer for that rolled day as if it were the asked one).
  const rt = new Date(Date.UTC(year, month - 1, day));
  return rt.getUTCFullYear() === year && rt.getUTCMonth() === month - 1 && rt.getUTCDate() === day;
}

/** The day the keys page opens on. The report day is a São Paulo day, so for the first hours after
 *  its midnight "today" is an almost empty table while the day everyone is asking about is the one
 *  that just closed: before 06:00 there the page opens on yesterday, after it on today. */
export function snapDefaultReportDay(now: Date = new Date()): "today" | "yesterday" {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "America/Sao_Paulo", hour: "2-digit", hourCycle: "h23" }).format(now));
  return hour < 6 ? "yesterday" : "today";
}

/** Today (São Paulo) or later = still accumulating (+ the partner's forecast); earlier = final. */
export function isSnapReportPartial(date: string, now: Date = new Date()): boolean {
  return date >= saoPauloISO(0, now);
}

// ---------- ranges (the keys page's date picker) ----------

/** The rail's first day: LION's Snapchat report was first read on it and nothing ran before it,
 *  so earlier days are never asked (one LION call per day is the partner's own ask). */
export const SNAP_REPORT_FIRST_DAY = "2026-09-16";
/** The longest range: one LION read per day, and Snap's stats window is asked as one TOTAL. */
export const SNAP_REPORT_MAX_DAYS = 31;

const dayNumber = (iso: string): number => {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
};

/** The route's query → the São Paulo days to report. `from`/`to` (either order, `to` defaults to
 *  `from`) name a range: its end is CUT to today (a viewer's clock a little ahead asks for
 *  "tomorrow" around São Paulo's midnight) and its start to the rail's first day; a range wholly
 *  outside those bounds, a malformed day, or one longer than the cap is refused. Without `from`
 *  the old single-day `date` (today | yesterday | YYYY-MM-DD) still answers. */
export function snapReportRange(q: { date?: string | null; from?: string | null; to?: string | null }, now: Date = new Date()): { from: string; to: string } | { error: string } {
  const from = String(q.from ?? "").trim();
  if (!from) {
    const day = snapReportDate(q.date, now);
    return day ? { from: day, to: day } : { error: "bad_date (today | yesterday | YYYY-MM-DD, not in the future)" };
  }
  const today = saoPauloISO(0, now);
  const toRaw = String(q.to ?? "").trim() || from;
  if (!isCalendarDay(from) || !isCalendarDay(toRaw)) return { error: "bad_range (from / to are YYYY-MM-DD)" };
  let [a, b] = from <= toRaw ? [from, toRaw] : [toRaw, from];
  if (b > today) b = today;
  // The same few seconds for a LONE day: "tomorrow" picked on a clock just ahead of ours is today.
  if (a > today && dayNumber(a) - dayNumber(today) === 1) a = today;
  if (a < SNAP_REPORT_FIRST_DAY) a = SNAP_REPORT_FIRST_DAY;
  if (a > b) return { error: `bad_range (nothing between ${SNAP_REPORT_FIRST_DAY} and today)` };
  if (dayNumber(b) - dayNumber(a) + 1 > SNAP_REPORT_MAX_DAYS) return { error: `range_too_long (max ${SNAP_REPORT_MAX_DAYS} days)` };
  return { from: a, to: b };
}

/** Closed AND past its morning-after: today is accumulating and yesterday "is final the next
 *  morning", so both may still move; anything earlier will not. */
export function isSnapReportSettled(date: string, now: Date = new Date()): boolean {
  return date < saoPauloISO(1, now);
}

/** A registry timestamp (ms) → its São Paulo day. */
export function snapDayOf(ms: number): string {
  return saoPauloISO(0, new Date(ms));
}

/** One day of a range as the reader got it: `report: null` = LION did not answer for it. */
export type SnapReportDay = { date: string; partial: boolean; report: SnapReport | null; error?: string };
export type SnapDailyRow = { date: string; partial: boolean; missing: boolean; revenue: number; forecastedRevenue: number; impressions: number; visitors: number; conversions: number };
export type SnapMergedReport = { affiliate: string; totals: SnapReportMetrics; byKey: Record<string, SnapReportMetrics>; daily: SnapDailyRow[]; missing: { date: string; error: string }[] };

function addMetrics(into: SnapReportMetrics, m: SnapReportMetrics, partial: boolean): void {
  into.revenue += m.revenue;
  // The forecast is the partner's add-on for the unfinished part of a day — a closed day has none.
  if (partial) into.forecastedRevenue += m.forecastedRevenue;
  into.impressions += m.impressions;
  into.triggered += m.triggered;
  into.fired += m.fired;
  into.visitors += m.visitors;
  into.conversions += m.conversions;
}

/** The days of a range as ONE report. A single day is returned as LION sent it (its own totals and
 *  eCPM); several days are summed and the eCPM recomputed from the sums (revenue per 1000 ad
 *  impressions — LION's own definition). A day that was not read is named in `missing` and left out
 *  of every sum: a gap must never read as a day of zero revenue. */
export function mergeSnapReports(days: SnapReportDay[]): SnapMergedReport {
  const daily: SnapDailyRow[] = days.map((d) => ({
    date: d.date,
    partial: d.partial,
    missing: !d.report,
    revenue: d.report?.totals.revenue ?? 0,
    forecastedRevenue: d.report && d.partial ? d.report.totals.forecastedRevenue : 0,
    impressions: d.report?.totals.impressions ?? 0,
    visitors: d.report?.totals.visitors ?? 0,
    conversions: d.report?.totals.conversions ?? 0,
  }));
  const missing = days.filter((d) => !d.report).map((d) => ({ date: d.date, error: d.error || "not read" }));
  const read = days.filter((d): d is SnapReportDay & { report: SnapReport } => Boolean(d.report));
  const affiliate = read.find((d) => d.report.affiliate)?.report.affiliate ?? "";
  if (days.length === 1 && read.length === 1) {
    // `daily` keeps the day's forecast as sent, too — a lone day is shown exactly as LION reports it.
    daily[0].forecastedRevenue = read[0].report.totals.forecastedRevenue;
    return { affiliate, totals: read[0].report.totals, byKey: read[0].report.byKey, daily, missing };
  }
  const totals: SnapReportMetrics = { ...EMPTY_SNAP_METRICS };
  const byKey: Record<string, SnapReportMetrics> = {};
  for (const d of read) {
    addMetrics(totals, d.report.totals, d.partial);
    for (const [key, m] of Object.entries(d.report.byKey)) addMetrics((byKey[key] ??= { ...EMPTY_SNAP_METRICS }), m, d.partial);
  }
  for (const m of [totals, ...Object.values(byKey)]) m.ecpm = m.impressions > 0 ? (m.revenue / m.impressions) * 1000 : 0;
  return { affiliate, totals, byKey, daily, missing };
}

/** What `key` earned on the range's days BEFORE `day`. A key released and claimed again mid-range
 *  carries its earlier holder's revenue in the range's sum, while Snapchat's spend is read for the
 *  campaign bound NOW — the row's P/L must not credit that campaign with money it never made. */
export function snapRevenueBefore(days: SnapReportDay[], key: string, day: string): number {
  let sum = 0;
  for (const d of days) if (d.report && d.date < day) sum += d.report.byKey[key]?.revenue ?? 0;
  return sum;
}
