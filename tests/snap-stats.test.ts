// Node's built-in runner (v24 strips types natively): `node --test tests/snap-stats.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// Snapchat rail — the Snapchat side of the keys report: the São Paulo day as a stats window, the
// live body shapes probed 18.09 (account stats broken down by campaign, campaign list, ad list),
// the join with the key registry, the delivery sentence and the sub-cent money format.
import { test } from "node:test";
import assert from "node:assert/strict";
import { joinSnapLive, parseSnapAccountStats, parseSnapAdReviews, parseSnapCampaignStates, snapDayWindow, snapDeliveryNote, snapRangeWindow, snapLiveTotals, snapMoney } from "../lib/snap-stats.ts";
import { snapDefaultReportDay } from "../lib/snap-report.ts";

const STATS_BODY = {
  request_status: "SUCCESS",
  total_stats: [
    {
      sub_request_status: "SUCCESS",
      total_stat: {
        id: "acct-2",
        type: "AD_ACCOUNT",
        granularity: "TOTAL",
        breakdown_stats: {
          campaign: [
            { id: "cmp-7", type: "CAMPAIGN", stats: { impressions: 307, swipes: 5, spend: 270803 } },
            { id: "cmp-4", type: "CAMPAIGN", stats: { impressions: 9932, swipes: 200, spend: 19316527 } },
          ],
        },
      },
    },
  ],
};

test("the São Paulo day is asked as a [midnight, next midnight) window with the zone's offset", () => {
  assert.deepEqual(snapDayWindow("2026-09-18"), { start: "2026-09-18T00:00:00.000-03:00", end: "2026-09-19T00:00:00.000-03:00" });
  assert.deepEqual(snapDayWindow("2026-12-31"), { start: "2026-12-31T00:00:00.000-03:00", end: "2027-01-01T00:00:00.000-03:00" });
  // Brazil still had DST in early 2019 (−02:00 until 17.02): the offset is read, not assumed.
  assert.equal(snapDayWindow("2019-01-15").start, "2019-01-15T00:00:00.000-02:00");
});

test("a range of São Paulo days is ONE window: the first day's midnight to the midnight after the last", () => {
  assert.deepEqual(snapRangeWindow("2026-09-14", "2026-09-20"), { start: "2026-09-14T00:00:00.000-03:00", end: "2026-09-21T00:00:00.000-03:00" });
  assert.deepEqual(snapRangeWindow("2026-09-18", "2026-09-18"), snapDayWindow("2026-09-18"));
});

test("account stats: per-campaign numbers, spend from micro to currency", () => {
  const s = parseSnapAccountStats(STATS_BODY);
  assert.deepEqual(Object.keys(s).sort(), ["cmp-4", "cmp-7"]);
  assert.deepEqual(s["cmp-4"], { spend: 19.316527, impressions: 9932, swipes: 200 });
  assert.deepEqual(s["cmp-7"], { spend: 0.270803, impressions: 307, swipes: 5 });
  assert.deepEqual(parseSnapAccountStats(null), {});
  assert.deepEqual(parseSnapAccountStats({ total_stats: [{ total_stat: { breakdown_stats: { campaign: [{ stats: { spend: 5 } }, null] } } }] }), {});
});

test("campaign states and ad reviews parse page lists; unknown review states count as pending", () => {
  const states = parseSnapCampaignStates([{ campaigns: [{ campaign: { id: "cmp-4", status: "active", delivery_status: ["VALID", "LEARNING_PHASE"] } }] }, { campaigns: [{ campaign: { id: "cmp-3", status: "PAUSED" } }, { campaign: {} }] }]);
  assert.deepEqual(states, { "cmp-4": { status: "ACTIVE", delivery: ["VALID", "LEARNING_PHASE"] }, "cmp-3": { status: "PAUSED", delivery: [] } });
  const ads = [
    { ad: { ad_squad_id: "sq-4", review_status: "APPROVED" } },
    { ad: { ad_squad_id: "sq-4", review_status: "REJECTED" } },
    { ad: { ad_squad_id: "sq-4", review_status: "PENDING" } },
    { ad: { ad_squad_id: "sq-4", review_status: "SOMETHING_NEW" } },
    { ad: { ad_squad_id: "sq-3", review_status: "REJECTED" } },
    { ad: { review_status: "APPROVED" } },
  ];
  assert.deepEqual(parseSnapAdReviews([{ ads }]), { "sq-4": { total: 4, approved: 1, pending: 2, rejected: 1 }, "sq-3": { total: 1, approved: 0, pending: 0, rejected: 1 } });
});

test("join: a campaign without a stats row delivered nothing (zeros); a failed account read is null, never zeros", () => {
  const bindings = [
    { key: "glo-snp_004", campaign_id: "cmp-4", adsquad_id: "sq-4", ad_account: "acct-2" },
    { key: "glo-snp_001", campaign_id: "cmp-1", adsquad_id: "sq-1", ad_account: "acct-2" },
    { key: "glo-snp_009", campaign_id: "cmp-9", adsquad_id: "sq-9", ad_account: "acct-9" },
    { key: "glo-snp_011" }, // claimed, no campaign yet
  ];
  const live = joinSnapLive(bindings, {
    "acct-2": { name: "LA-2", stats: parseSnapAccountStats(STATS_BODY), states: { "cmp-4": { status: "ACTIVE", delivery: ["VALID"] } }, reviews: { "sq-4": { total: 8, approved: 2, pending: 0, rejected: 6 } } },
    "acct-9": { stats: null, states: null, reviews: null },
  });
  assert.deepEqual(live.map((k) => k.key), ["glo-snp_001", "glo-snp_004", "glo-snp_009"]);
  const [k1, k4, k9] = live;
  assert.deepEqual(k4.stats, { spend: 19.316527, impressions: 9932, swipes: 200 });
  assert.equal(k4.adAccountName, "LA-2");
  assert.deepEqual(k4.state, { status: "ACTIVE", delivery: ["VALID"], found: true });
  assert.deepEqual(k1.stats, { spend: 0, impressions: 0, swipes: 0 });
  assert.equal(k1.state?.found, false);
  assert.deepEqual(k1.ads, { total: 0, approved: 0, pending: 0, rejected: 0 });
  assert.equal(k9.stats, null);
  assert.equal(k9.state, null);
  assert.equal(k9.ads, null);
  const totals = snapLiveTotals(live);
  assert.equal(totals.complete, false);
  assert.equal(totals.impressions, 9932);
  assert.equal(snapLiveTotals([k1, k4]).complete, true);
});

test("the delivery sentence names what stops a campaign", () => {
  const ads = (approved: number, pending: number, rejected: number) => ({ total: approved + pending + rejected, approved, pending, rejected });
  const active = { status: "ACTIVE", delivery: ["VALID", "LEARNING_PHASE"], found: true };
  assert.deepEqual(snapDeliveryNote({ state: active, ads: ads(2, 0, 6) }), { text: "2/8 ads live, 6 rejected · learning", tone: "ok" });
  assert.deepEqual(snapDeliveryNote({ state: { ...active, delivery: ["INVALID_CAMPAIGN_HAS_NO_ACTIVE_AD_SQUAD"] }, ads: ads(0, 0, 6) }), { text: "all 6 ads rejected — not delivering", tone: "bad" });
  assert.deepEqual(snapDeliveryNote({ state: { ...active, delivery: [] }, ads: ads(0, 5, 1) }), { text: "in review: 5 pending, 1 rejected", tone: "warn" });
  assert.deepEqual(snapDeliveryNote({ state: { status: "PAUSED", delivery: [], found: true }, ads: ads(1, 0, 0) }), { text: "paused · 1/1 ads live", tone: "warn" });
  assert.deepEqual(snapDeliveryNote({ state: { status: "", delivery: [], found: false }, ads: null }), { text: "campaign not found on Snapchat", tone: "bad" });
  assert.deepEqual(snapDeliveryNote({ state: { status: "ACTIVE", delivery: [], found: true }, ads: null }), { text: "active", tone: "ok" });
  assert.equal(snapDeliveryNote({ state: null, ads: null }), null);
});

test("money keeps sub-cent and sub-dollar amounts readable", () => {
  assert.equal(snapMoney(0), "$0.00");
  assert.equal(snapMoney(0.000233), "$0.0002");
  assert.equal(snapMoney(0.038372), "$0.038");
  assert.equal(snapMoney(0.712012), "$0.712");
  assert.equal(snapMoney(2.147653), "$2.15");
  assert.equal(snapMoney(19316.527), "$19,316.53");
  assert.equal(snapMoney(-38.17), "-$38.17");
  assert.equal(snapMoney(-0.004), "-$0.0040");
});

test("the page opens on yesterday for the first six São Paulo hours, on today after", () => {
  assert.equal(snapDefaultReportDay(new Date("2026-09-18T22:04:00Z")), "today"); // 19:04 São Paulo
  assert.equal(snapDefaultReportDay(new Date("2026-09-19T03:30:00Z")), "yesterday"); // 00:30
  assert.equal(snapDefaultReportDay(new Date("2026-09-19T08:59:00Z")), "yesterday"); // 05:59
  assert.equal(snapDefaultReportDay(new Date("2026-09-19T09:00:00Z")), "today"); // 06:00
});
