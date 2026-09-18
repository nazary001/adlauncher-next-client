// Node's built-in runner (v24 strips types natively): `node --test tests/snap-launch.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// Snapchat rail — the LAUNCH decisions in lib/snap-launch.ts: the strategy/goal/CTA vocabulary
// (no MIN_ROAS — deprecated by Snap 10.02.2025), micro money, geo wire, task ids, bid labels and
// snapLaunchWire — the ONE validator the board dry-runs and the pump runs for real.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SNAP_BID_STRATEGIES,
  SNAP_CTAS,
  SNAP_GEO_PRESETS,
  SNAP_MAX_CREATIVES,
  SNAP_NAME_MAX,
  SNAP_OPTIMIZATION_GOALS,
  snapAdUnitName,
  snapBidKind,
  snapBidLabel,
  snapGeoWire,
  snapGoalNeedsPixel,
  snapLaunchWire,
  snapMicro,
  snapMoneyText,
  snapShotTaskId,
  type SnapLaunchShotIn,
  type SnapResolved,
} from "../lib/snap-launch.ts";
import { isSnapLaunchAccount } from "../lib/snap-launch.ts";

test("isSnapLaunchAccount hides the org's Self Service account and listed ids, keeps the buying accounts", () => {
  assert.equal(isSnapLaunchAccount({ id: "d7defe80-abed-4109-8a8f-556619f14989", name: "GlobeCoders OÜ Self Service" }), false);
  assert.equal(isSnapLaunchAccount({ id: "x", name: "Some Org self service" }), false);
  assert.equal(isSnapLaunchAccount({ id: "0ee94840-33aa-48ae-b57e-105c5ee0ebfd", name: "GC-HS-snapchat-LA-1" }), true);
  assert.equal(isSnapLaunchAccount({ id: "y", name: "Self Service Desk Ads" }), true);
});

test("vocabulary: three bid strategies (no MIN_ROAS), five goals, PIXEL_* need a pixel", () => {
  assert.deepEqual(SNAP_BID_STRATEGIES.map((s) => [s.value, s.kind]), [
    ["AUTO_BID", "none"],
    ["LOWEST_COST_WITH_MAX_BID", "bid"],
    ["TARGET_COST", "bid"],
  ]);
  assert.equal(snapBidKind("MIN_ROAS"), "unknown");
  assert.equal(snapBidKind("TARGET_COST"), "bid");
  assert.deepEqual(
    SNAP_OPTIMIZATION_GOALS.map((g) => g.value),
    ["PIXEL_PURCHASE", "PIXEL_PAGE_VIEW", "LANDING_PAGE_VIEW", "SWIPES", "IMPRESSIONS"],
  );
  assert.equal(snapGoalNeedsPixel("PIXEL_PURCHASE"), true);
  assert.equal(snapGoalNeedsPixel("SWIPES"), false);
  assert.equal(snapGoalNeedsPixel("NOPE"), false);
  assert.equal(SNAP_CTAS[0].value, "MORE");
  assert.ok(SNAP_CTAS.every((c) => /^[A-Z_]+$/.test(c.value)));
  assert.deepEqual(SNAP_GEO_PRESETS.map((p) => p.label), ["US", "Anglo", "LATAM", "Franco", "EU"]);
  assert.deepEqual(SNAP_GEO_PRESETS[1].codes, ["US", "CA", "GB", "AU", "NZ", "IE"]);
  assert.equal(SNAP_GEO_PRESETS[4].codes.length, 27);
});

test("micro money: decimal comma/point, cents rounding, min/max in the human unit", () => {
  assert.equal(snapMicro("10,00", 5, 10_000), 10_000_000);
  assert.equal(snapMicro("10", 5, 10_000), 10_000_000);
  assert.equal(snapMicro("7.5", 5, 10_000), 7_500_000);
  assert.equal(snapMicro("4,99", 5, 10_000), null);
  assert.equal(snapMicro("10000,01", 5, 10_000), null);
  assert.equal(snapMicro("", 5, 10_000), null);
  assert.equal(snapMicro("abc", 5, 10_000), null);
  assert.equal(snapMicro("0,50", 0.01, 500), 500_000);
  assert.equal(snapMicro("0", 0.01, 500), null);
  assert.equal(snapMicro("500,01", 0.01, 500), null);
  assert.equal(snapMoneyText(0.5), "0,5");
  assert.equal(snapMoneyText(10), "10");
  assert.equal(snapMoneyText(1.25), "1,25");
});

test("bid labels for the monitor tag", () => {
  assert.equal(snapBidLabel("AUTO_BID", undefined, "USD"), "auto");
  assert.equal(snapBidLabel("LOWEST_COST_WITH_MAX_BID", 500_000, "USD"), "max $0,5");
  assert.equal(snapBidLabel("TARGET_COST", 1_200_000, "USD"), "target $1,2");
  assert.equal(snapBidLabel("TARGET_COST", 1_200_000, "EUR"), "target €1,2");
  assert.equal(snapBidLabel("TARGET_COST", undefined, "USD"), "target ?");
});

test("geo wire: lower-cased ISO-2 for Snap, upper-cased label, WW and junk refused", () => {
  assert.deepEqual(snapGeoWire(["us", "CA", "us"]), { geos: [{ country_code: "us" }, { country_code: "ca" }], label: "US+CA" });
  const empty = snapGeoWire([]);
  assert.ok("refusal" in empty && /at least one country/i.test(empty.refusal));
  const ww = snapGeoWire(["WW"]);
  assert.ok("refusal" in ww && /worldwide/i.test(ww.refusal));
  const junk = snapGeoWire(["USA"]);
  assert.ok("refusal" in junk && /USA/.test(junk.refusal));
});

test("task ids are deterministic per wave: snl-<wave>-NN", () => {
  assert.equal(snapShotTaskId("wave-1234-abcd", 0), "snl-wave-1234-abcd-01");
  assert.equal(snapShotTaskId("wave-1234-abcd", 11), "snl-wave-1234-abcd-12");
});

// ---- snapLaunchWire ----------------------------------------------------------------------------

const shot = (over: Partial<SnapLaunchShotIn> = {}): SnapLaunchShotIn => ({
  adAccount: "acct-a",
  pixel: "px-1",
  optimizationGoal: "PIXEL_PURCHASE",
  bidStrategy: "AUTO_BID",
  bid: "",
  budget: "10,00",
  startPaused: false,
  headline: "Drive it home today",
  brandName: "GC Cars",
  cta: "MORE",
  media: [{ url: "https://blob.vercel-storage.com/snap/x/v.mp4", kind: "video", name: "v.mp4" }],
  geo: ["US"],
  minAge: "18",
  landingId: "cars",
  landingUrl: "",
  suffix: "",
  ...over,
});

const resolved: SnapResolved = {
  adAccountId: "acct-a",
  pixelId: "px-1",
  profileId: "prof-1",
  name: "[16.09] (SNP) Cars - US - glo-snp_003 - nazar - GC-Launcher",
  key: "glo-snp_003",
  mediaIds: ["media-1"],
  startTimeIso: "2026-09-16T12:00:00.000Z",
};

test("happy path: the Snap bodies (one creative → one ad unit) + the final landing URL, AUTO_BID sends no bid_micro", () => {
  const r = snapLaunchWire(shot(), resolved);
  assert.ok(!("refusal" in r), JSON.stringify(r));
  if ("refusal" in r) return;
  assert.equal(r.label, "auto");
  assert.equal(r.geoLabel, "US");
  assert.equal(r.niche, "Cars");
  assert.equal(r.landingBase, "https://azmvhs.com/v/auto-financing-by-ford/");
  assert.equal(r.bidMicro, undefined);
  assert.deepEqual(r.wire.campaign, {
    name: resolved.name,
    ad_account_id: "acct-a",
    status: "PAUSED",
    start_time: "2026-09-16T12:00:00.000Z",
  });
  assert.deepEqual(r.wire.adsquad, {
    name: resolved.name,
    type: "SNAP_ADS",
    billing_event: "IMPRESSION",
    delivery_constraint: "DAILY_BUDGET",
    daily_budget_micro: 10_000_000,
    bid_strategy: "AUTO_BID",
    optimization_goal: "PIXEL_PURCHASE",
    placement_v2: { config: "AUTOMATIC" },
    targeting: { geos: [{ country_code: "us" }], demographics: [{ min_age: "18" }] },
    pixel_id: "px-1",
    status: "ACTIVE",
    start_time: "2026-09-16T12:00:00.000Z",
  });
  assert.equal(r.wire.ads.length, 1);
  assert.equal(r.wire.ads[0].index, 0);
  assert.deepEqual(r.wire.ads[0].creative, {
    ad_account_id: "acct-a",
    name: resolved.name,
    type: "WEB_VIEW",
    ad_product: "SNAP_AD",
    headline: "Drive it home today",
    brand_name: "GC Cars",
    call_to_action: "MORE",
    top_snap_media_id: "media-1",
    shareable: true,
    web_view_properties: {
      url: "https://azmvhs.com/v/auto-financing-by-ford/?utm_source=stone&utm_campaign=glo-snp_003",
      block_preload: false,
      allow_snap_javascript_sdk: false,
      use_immersive_mode: false,
    },
    profile_properties: { profile_id: "prof-1" },
  });
  assert.deepEqual(r.wire.ads[0].ad, { name: resolved.name, type: "REMOTE_WEBPAGE", status: "ACTIVE" });
  assert.equal(r.wire.landingUrl, "https://azmvhs.com/v/auto-financing-by-ford/?utm_source=stone&utm_campaign=glo-snp_003");
});

test("a bid strategy carries bid_micro; a goal without a pixel sends no pixel_id", () => {
  const r = snapLaunchWire(shot({ bidStrategy: "LOWEST_COST_WITH_MAX_BID", bid: "0,50", optimizationGoal: "SWIPES", pixel: "" }), { ...resolved, pixelId: undefined });
  assert.ok(!("refusal" in r));
  if ("refusal" in r) return;
  assert.equal(r.wire.adsquad.bid_micro, 500_000);
  assert.equal(r.wire.adsquad.pixel_id, undefined);
  assert.equal(r.label, "max $0,5");
  assert.equal(r.bidMicro, 500_000);
});

test("custom landing: https base with its own query dropped; niche 'Custom'", () => {
  const r = snapLaunchWire(shot({ landingId: "custom", landingUrl: "https://example.com/offer/?utm_source=bad#x" }), resolved);
  assert.ok(!("refusal" in r));
  if ("refusal" in r) return;
  assert.equal(r.niche, "Custom");
  assert.equal(r.wire.ads[0].creative.web_view_properties.url, "https://example.com/offer/?utm_source=stone&utm_campaign=glo-snp_003");
});

test("refusal matrix names the field and the fix", () => {
  const refusal = (s: SnapLaunchShotIn, res: SnapResolved = resolved): string => {
    const r = snapLaunchWire(s, res);
    return "refusal" in r ? r.refusal : "";
  };
  assert.match(refusal(shot({ budget: "4,99" })), /budget.*5.*10000/i);
  assert.match(refusal(shot({ bidStrategy: "MIN_ROAS" })), /Unknown bidding strategy/);
  assert.match(refusal(shot({ bidStrategy: "TARGET_COST", bid: "" })), /Target cost needs a bid/);
  assert.match(refusal(shot({ bidStrategy: "TARGET_COST", bid: "600" })), /0,01.*500/);
  assert.match(refusal(shot({ bidStrategy: "AUTO_BID", bid: "1" })), /takes no bid/);
  assert.match(refusal(shot({ optimizationGoal: "NOPE" })), /Unknown optimization goal/);
  assert.match(refusal(shot(), { ...resolved, pixelId: undefined }), /Pixel purchase needs a conversion pixel/);
  assert.match(refusal(shot({ headline: "" })), /Headline is required/);
  assert.match(refusal(shot({ headline: "x".repeat(35) })), /Headline.*34/);
  assert.match(refusal(shot({ brandName: "" })), /Brand name is required/);
  assert.match(refusal(shot({ brandName: "x".repeat(33) })), /Brand name.*32/);
  assert.match(refusal(shot({ cta: "BUY_TICKETS" })), /Call to action/);
  assert.match(refusal(shot({ media: [] })), /creative.*required/i);
  assert.match(refusal(shot({ media: [{ url: "http://x.com/v.mp4", kind: "video" }] })), /https/);
  assert.match(refusal(shot({ media: [{ url: "https://x.com/a.mp4", kind: "video" }, { url: "ftp://x.com/b.mp4", kind: "video" }] })), /Creative 2 .*https/);
  assert.match(refusal(shot({ media: [{ url: "https://x.com/a.gif", kind: "gif" as "image" }] })), /kind must be video or image/);
  assert.match(refusal(shot({ media: Array.from({ length: SNAP_MAX_CREATIVES + 1 }, (_, i) => ({ url: `https://x.com/${i}.mp4`, kind: "video" as const })) })), new RegExp(`at most ${SNAP_MAX_CREATIVES}`));
  assert.match(refusal(shot({ geo: [] })), /at least one country/i);
  assert.match(refusal(shot({ minAge: "16" })), /Minimum age/);
  assert.match(refusal(shot({ landingId: "custom", landingUrl: "http://example.com/" })), /https:\/\/ address/);
  assert.match(refusal(shot({ landingId: "nope" as "dmi" })), /Pick a landing/);
  assert.match(refusal(shot(), { ...resolved, profileId: "" }), /Public Profile/);
  assert.match(refusal(shot(), { ...resolved, key: "glo-snp_000" }), /not one of the partner keys/);
  assert.match(refusal(shot(), { ...resolved, mediaIds: [""] }), /media id/i);
  assert.match(refusal(shot(), { ...resolved, mediaIds: [] }), /media id/i);
  assert.match(refusal(shot(), { ...resolved, name: "x".repeat(376) }), /375/);
});

test("several creatives: ONE campaign and ad squad, one creative+ad unit per file, numbered names, the same key link", () => {
  const media = [
    { url: "https://blob.vercel-storage.com/snap/x/a.mp4", kind: "video" as const, name: "a.mp4" },
    { url: "https://blob.vercel-storage.com/snap/x/b.jpg", kind: "image" as const, name: "b.jpg" },
    { url: "https://blob.vercel-storage.com/snap/x/c.mp4", kind: "video" as const, name: "c.mp4" },
  ];
  const r = snapLaunchWire(shot({ media }), { ...resolved, mediaIds: ["m-a", "m-b", "m-c"] });
  assert.ok(!("refusal" in r), JSON.stringify(r));
  if ("refusal" in r) return;
  assert.equal(r.wire.campaign.name, resolved.name);
  assert.equal(r.wire.adsquad.name, resolved.name);
  assert.deepEqual(r.wire.ads.map((u) => u.index), [0, 1, 2]);
  assert.deepEqual(r.wire.ads.map((u) => u.creative.top_snap_media_id), ["m-a", "m-b", "m-c"]);
  assert.deepEqual(r.wire.ads.map((u) => u.creative.name), [`${resolved.name} #1`, `${resolved.name} #2`, `${resolved.name} #3`]);
  assert.deepEqual(r.wire.ads.map((u) => u.ad.name), [`${resolved.name} #1`, `${resolved.name} #2`, `${resolved.name} #3`]);
  for (const u of r.wire.ads) {
    assert.equal(u.creative.web_view_properties.url, r.wire.landingUrl, "every ad of the campaign rides the campaign's ONE key");
    assert.equal(u.creative.headline, "Drive it home today");
    assert.deepEqual(u.ad, { name: u.creative.name, type: "REMOTE_WEBPAGE", status: "ACTIVE" });
  }
});

test("a creative the pump skipped (empty media id) builds no unit and keeps the others' numbers", () => {
  const media = [
    { url: "https://x.com/a.mp4", kind: "video" as const },
    { url: "https://x.com/b.mp4", kind: "video" as const },
    { url: "https://x.com/c.mp4", kind: "video" as const },
  ];
  const r = snapLaunchWire(shot({ media }), { ...resolved, mediaIds: ["m-a", "", "m-c"] });
  assert.ok(!("refusal" in r), JSON.stringify(r));
  if ("refusal" in r) return;
  assert.deepEqual(r.wire.ads.map((u) => u.index), [0, 2]);
  assert.deepEqual(r.wire.ads.map((u) => u.ad.name), [`${resolved.name} #1`, `${resolved.name} #3`]);
});

test("snapAdUnitName: verbatim for a single creative, numbered otherwise, the suffix always fits the cap", () => {
  assert.equal(snapAdUnitName("name", 0, 1), "name");
  assert.equal(snapAdUnitName("name", 0, 2), "name #1");
  assert.equal(snapAdUnitName("name", 11, 12), "name #12");
  const long = "x".repeat(SNAP_NAME_MAX);
  const n = snapAdUnitName(long, 99, 120);
  assert.equal(n.length, SNAP_NAME_MAX);
  assert.ok(n.endsWith(" #100"));
});
