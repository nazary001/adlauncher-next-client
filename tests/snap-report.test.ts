// Node's built-in runner (v24 strips types natively): `node --test tests/snap-report.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// Snapchat rail — the LION daily report (GET /api/high-adx-cluster-utms/snapchat-report/): the
// body shape probed live 16.09 (totals + 100 campaigns keyed by utm_campaign), tolerant parsing,
// and the today/yesterday/ISO date resolution with the São Paulo "partial day" rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_SNAP_METRICS, isSnapReportPartial, parseSnapReport, snapReportDate } from "../lib/snap-report.ts";

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
});

test("partial: today (São Paulo) is partial, every earlier day is final", () => {
  const at = new Date("2026-09-16T01:30:00Z");
  assert.equal(isSnapReportPartial("2026-09-15", at), true);
  assert.equal(isSnapReportPartial("2026-09-14", at), false);
  assert.equal(isSnapReportPartial("2026-09-16", at), true);
});
