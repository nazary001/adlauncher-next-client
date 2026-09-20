// Node's built-in runner (v24 strips types natively): `node --test tests/snap-report.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// Snapchat rail — the LION daily report (GET /api/high-adx-cluster-utms/snapchat-report/): the
// body shape probed live 16.09 (totals + 100 campaigns keyed by utm_campaign), tolerant parsing,
// and the today/yesterday/ISO date resolution with the São Paulo "partial day" rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_SNAP_METRICS, SNAP_REPORT_FIRST_DAY, SNAP_REPORT_MAX_DAYS, isSnapReportPartial, isSnapReportSettled, mergeSnapReports, parseSnapReport, snapDayOf, snapReportDate, snapReportRange, snapRevenueBefore } from "../lib/snap-report.ts";

const LIVE_SHAPE = {
  date: "2026-09-15",
  affiliate: "globecoders",
  utm_prefix: "glo-snp_",
  totals: { revenue: 12.5, forecasted_revenue: 14, impressions: 300, ecpm: 41.67, triggered: 9, fired: 8, visitors: 120, conversions: 2 },
  campaigns: [
    { utm_campaign: "glo-snp_001", revenue: 12.5, forecasted_revenue: 14, impressions: 300, ecpm: 41.67, triggered: 9, fired: 8, visitors: 120, conversions: 2 },
    { utm_campaign: "glo-snp_002", revenue: 0, forecasted_revenue: 0, impressions: 0, ecpm: 0, triggered: 0, fired: 0, visitors: 0, conversions: 0 },
  ],
};

test("parses the live shape: totals + a per-key map with camelCased metrics", () => {
  const r = parseSnapReport(LIVE_SHAPE, "2026-09-15");
  assert.equal(r.date, "2026-09-15");
  assert.equal(r.affiliate, "globecoders");
  assert.equal(r.utmPrefix, "glo-snp_");
  assert.deepEqual(r.totals, { revenue: 12.5, forecastedRevenue: 14, impressions: 300, ecpm: 41.67, triggered: 9, fired: 8, visitors: 120, conversions: 2 });
  assert.deepEqual(Object.keys(r.byKey), ["glo-snp_001", "glo-snp_002"]);
  assert.equal(r.byKey["glo-snp_001"].revenue, 12.5);
  assert.deepEqual(r.byKey["glo-snp_002"], EMPTY_SNAP_METRICS);
});

test("tolerant: strings become numbers, junk becomes 0, missing arrays become empty, date falls back", () => {
  const r = parseSnapReport({ totals: { revenue: "3.5", impressions: "x" }, campaigns: [{ utm_campaign: "glo-snp_007", revenue: "1" }, { revenue: 5 }, null] }, "2026-09-16");
  assert.equal(r.date, "2026-09-16");
  assert.equal(r.affiliate, "");
  assert.equal(r.totals.revenue, 3.5);
  assert.equal(r.totals.impressions, 0);
  assert.deepEqual(Object.keys(r.byKey), ["glo-snp_007"]);
  assert.equal(r.byKey["glo-snp_007"].revenue, 1);
  assert.deepEqual(parseSnapReport(null, "2026-09-16").byKey, {});
  assert.deepEqual(parseSnapReport("garbage", "2026-09-16").totals, EMPTY_SNAP_METRICS);
});

test("date resolution: today / yesterday in São Paulo, ISO passthrough, junk and future refused", () => {
  const at = new Date("2026-09-16T01:30:00Z"); // 15.09 22:30 in São Paulo
  assert.equal(snapReportDate("today", at), "2026-09-15");
  assert.equal(snapReportDate("yesterday", at), "2026-09-14");
  assert.equal(snapReportDate("", at), "2026-09-15");
  assert.equal(snapReportDate(undefined, at), "2026-09-15");
  assert.equal(snapReportDate("2026-09-01", at), "2026-09-01");
  assert.equal(snapReportDate("2026-09-16", at), null); // tomorrow in São Paulo
  assert.equal(snapReportDate("16.09.2026", at), null);
  assert.equal(snapReportDate("2026-13-01", at), null);
  // impossible days pass the 1..31 range check but not the calendar
  assert.equal(snapReportDate("2026-02-31", at), null);
  assert.equal(snapReportDate("2026-02-29", at), null);
  assert.equal(snapReportDate("2026-04-31", at), null);
  assert.equal(snapReportDate("2024-02-29", at), "2024-02-29");
  assert.equal(snapReportDate("2026-02-28", at), "2026-02-28");
});

test("partial: today (São Paulo) is partial, every earlier day is final", () => {
  const at = new Date("2026-09-16T01:30:00Z");
  assert.equal(isSnapReportPartial("2026-09-15", at), true);
  assert.equal(isSnapReportPartial("2026-09-14", at), false);
  assert.equal(isSnapReportPartial("2026-09-16", at), true);
});

// ---------- ranges (the date picker, 20.09) ----------

test("range resolution: ?date= still names one day; from/to are ordered, cut to today and to the rail's first day", () => {
  const at = new Date("2026-09-21T01:30:00Z"); // 20.09 22:30 in São Paulo
  assert.deepEqual(snapReportRange({ date: "today" }, at), { from: "2026-09-20", to: "2026-09-20" });
  assert.deepEqual(snapReportRange({ date: "yesterday" }, at), { from: "2026-09-19", to: "2026-09-19" });
  assert.deepEqual(snapReportRange({}, at), { from: "2026-09-20", to: "2026-09-20" });
  assert.deepEqual(snapReportRange({ from: "2026-09-17", to: "2026-09-19" }, at), { from: "2026-09-17", to: "2026-09-19" });
  assert.deepEqual(snapReportRange({ from: "2026-09-19", to: "2026-09-17" }, at), { from: "2026-09-17", to: "2026-09-19" });
  assert.deepEqual(snapReportRange({ from: "2026-09-18" }, at), { from: "2026-09-18", to: "2026-09-18" });
  // a viewer whose clock is a little ahead asks for "tomorrow" around São Paulo's midnight — the end is cut, not refused
  assert.deepEqual(snapReportRange({ from: "2026-09-18", to: "2026-09-21" }, at), { from: "2026-09-18", to: "2026-09-20" });
  // nothing was running before the rail's first day: those days are never asked from LION
  assert.equal(SNAP_REPORT_FIRST_DAY, "2026-09-16");
  assert.deepEqual(snapReportRange({ from: "2026-09-01", to: "2026-09-18" }, at), { from: "2026-09-16", to: "2026-09-18" });
  // from/to win over a stray date
  assert.deepEqual(snapReportRange({ date: "yesterday", from: "2026-09-17", to: "2026-09-18" }, at), { from: "2026-09-17", to: "2026-09-18" });
});

test("range resolution refuses junk, wholly-future and wholly-too-early ranges, and windows over the cap", () => {
  const at = new Date("2026-11-30T15:00:00Z");
  assert.ok("error" in snapReportRange({ date: "16.09.2026" }, at));
  assert.ok("error" in snapReportRange({ from: "2026-09-31", to: "2026-10-02" }, at));
  assert.ok("error" in snapReportRange({ from: "soon" }, at));
  assert.ok("error" in snapReportRange({ from: "2026-12-05", to: "2026-12-08" }, at));
  assert.ok("error" in snapReportRange({ from: "2026-09-01", to: "2026-09-10" }, at));
  assert.equal(SNAP_REPORT_MAX_DAYS, 31);
  assert.deepEqual(snapReportRange({ from: "2026-10-31", to: "2026-11-30" }, at), { from: "2026-10-31", to: "2026-11-30" });
  const long = snapReportRange({ from: "2026-10-30", to: "2026-11-30" }, at);
  assert.ok("error" in long && /31/.test(long.error));
});

test("settled: a day is still moving until the morning after it closed", () => {
  const at = new Date("2026-09-21T01:30:00Z"); // 20.09 in São Paulo
  assert.equal(isSnapReportSettled("2026-09-20", at), false);
  assert.equal(isSnapReportSettled("2026-09-19", at), false);
  assert.equal(isSnapReportSettled("2026-09-18", at), true);
});

const day = (date: string, revenue: number, impressions: number, extra: Partial<{ forecast: number; visitors: number; conversions: number; partial: boolean }> = {}) => {
  const m = { revenue, forecastedRevenue: extra.forecast ?? 0, impressions, ecpm: impressions ? (revenue / impressions) * 1000 : 0, triggered: 2, fired: 1, visitors: extra.visitors ?? 10, conversions: extra.conversions ?? 1 };
  return { date, partial: extra.partial ?? false, report: { date, affiliate: "globecoders", utmPrefix: "glo-snp_", totals: { ...m }, byKey: { "glo-snp_001": { ...m } } } };
};

test("one day merges to itself — LION's own totals and eCPM, untouched", () => {
  const d = day("2026-09-18", 2.5, 100, { forecast: 0.4, partial: true });
  d.report.totals.ecpm = 24.99; // LION's rounding stays LION's
  const m = mergeSnapReports([d]);
  assert.equal(m.totals.ecpm, 24.99);
  assert.equal(m.totals.forecastedRevenue, 0.4);
  assert.equal(m.affiliate, "globecoders");
  assert.deepEqual(m.daily, [{ date: "2026-09-18", partial: true, missing: false, revenue: 2.5, forecastedRevenue: 0.4, impressions: 100, visitors: 10, conversions: 1 }]);
  assert.deepEqual(m.missing, []);
});

test("several days: counts add up, eCPM is recomputed from the sums, the forecast counts for the open day only", () => {
  const m = mergeSnapReports([day("2026-09-18", 2, 100, { forecast: 9 }), day("2026-09-19", 4, 400, { visitors: 30 }), day("2026-09-20", 1, 500, { forecast: 0.5, partial: true })]);
  assert.equal(m.totals.revenue, 7);
  assert.equal(m.totals.impressions, 1000);
  assert.equal(m.totals.ecpm, 7);
  assert.equal(m.totals.visitors, 50);
  assert.equal(m.totals.triggered, 6);
  assert.equal(m.totals.fired, 3);
  assert.equal(m.totals.conversions, 3);
  // a closed day's forecast (should be 0 anyway) never inflates the range
  assert.equal(m.totals.forecastedRevenue, 0.5);
  assert.equal(m.byKey["glo-snp_001"].revenue, 7);
  assert.equal(m.byKey["glo-snp_001"].forecastedRevenue, 0.5);
  assert.deepEqual(m.daily.map((d) => d.revenue), [2, 4, 1]);
});

test("a day LION did not answer for is named and left out of the sums — it never reads as zero revenue", () => {
  const m = mergeSnapReports([day("2026-09-18", 2, 100), { date: "2026-09-19", partial: false, report: null, error: "LION 502" }, day("2026-09-20", 1, 100, { partial: true })]);
  assert.equal(m.totals.revenue, 3);
  assert.deepEqual(m.missing, [{ date: "2026-09-19", error: "LION 502" }]);
  assert.deepEqual(m.daily[1], { date: "2026-09-19", partial: false, missing: true, revenue: 0, forecastedRevenue: 0, impressions: 0, visitors: 0, conversions: 0 });
  const none = mergeSnapReports([{ date: "2026-09-19", partial: false, report: null, error: "down" }]);
  assert.deepEqual(none.totals, EMPTY_SNAP_METRICS);
  assert.equal(none.missing.length, 1);
});

test("a lone day that is 'tomorrow' for the server is today — a viewer's clock seconds ahead at São Paulo's midnight", () => {
  const at = new Date("2026-09-21T02:59:30Z"); // 20.09 23:59:30 in São Paulo
  assert.deepEqual(snapReportRange({ from: "2026-09-21" }, at), { from: "2026-09-20", to: "2026-09-20" });
  assert.deepEqual(snapReportRange({ from: "2026-09-21", to: "2026-09-21" }, at), { from: "2026-09-20", to: "2026-09-20" });
  // further out is still refused — that is not a clock a few seconds ahead
  assert.ok("error" in snapReportRange({ from: "2026-09-22" }, at));
});

test("a registry timestamp's São Paulo day, and what a key earned in the range BEFORE that day", () => {
  assert.equal(snapDayOf(Date.parse("2026-09-19T02:30:00Z")), "2026-09-18"); // 23:30 on the 18th there
  assert.equal(snapDayOf(Date.parse("2026-09-19T03:00:00Z")), "2026-09-19");
  const days = [day("2026-09-17", 2, 100), { date: "2026-09-18", partial: false, report: null, error: "down" }, day("2026-09-19", 4, 100), day("2026-09-20", 1, 100, { partial: true })];
  // claimed on the 19th: the 17th's revenue was an earlier holder's; an unread day adds nothing
  assert.equal(snapRevenueBefore(days, "glo-snp_001", "2026-09-19"), 2);
  assert.equal(snapRevenueBefore(days, "glo-snp_001", "2026-09-17"), 0);
  assert.equal(snapRevenueBefore(days, "glo-snp_001", "2026-09-25"), 7);
  assert.equal(snapRevenueBefore(days, "glo-snp_099", "2026-09-19"), 0);
});
