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
  SNAP_DEFAULT_DEVICE_OS,
  SNAP_DEVICE_OPTIONS,
  SNAP_GEO_PRESETS,
  SNAP_MAX_CREATIVES,
  SNAP_NAME_MAX,
  SNAP_OPTIMIZATION_GOALS,
  SNAP_DEFAULT_GOAL,
  SNAP_OBJECTIVES,
  SNAP_DEFAULT_OBJECTIVE,
  snapGoalsFor,
  snapObjectiveForGoal,
  snapObjectiveLabel,
  snapAdUnitName,
  snapShotMediaIn,
  snapBidKind,
  snapBidLabel,
  snapDeviceOs,
  snapDeviceShort,
  snapGeoWire,
  snapGoalNeedsPixel,
  snapLaunchWire,
  snapMicro,
  snapMoneyText,
  snapNicheFromLanding,
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
  // Owner ask 23.09: ONLY Pixel purchase and Landing page view — Swipes (clicks), Pixel page view
  // and Impressions left the vocabulary, so the validator refuses them (checked in the refusal matrix).
  assert.deepEqual(SNAP_OPTIMIZATION_GOALS.map((g) => g.value), ["PIXEL_PURCHASE", "LANDING_PAGE_VIEW"]);
  assert.equal(SNAP_DEFAULT_GOAL, "PIXEL_PURCHASE");
  assert.ok(SNAP_OPTIMIZATION_GOALS.some((g) => g.value === SNAP_DEFAULT_GOAL));
  assert.equal(snapGoalNeedsPixel("PIXEL_PURCHASE"), true);
  assert.equal(snapGoalNeedsPixel("LANDING_PAGE_VIEW"), false);
  assert.equal(snapGoalNeedsPixel("SWIPES"), false);
  assert.equal(snapGoalNeedsPixel("NOPE"), false);
  // Campaign objective (owner ask 23.09): each goal implies one (Ads Manager's pairing) — Sales for
  // Pixel purchase (the default), Traffic for Landing page view; the vocabulary = the two launch kinds,
  // Sales (purchase) and Traffic (page view), both always listed — Leads / Awareness / App promotion are
  // not offered (Snap's WEB matrix, docs 23.09, backs the pairs).
  assert.deepEqual(SNAP_OPTIMIZATION_GOALS.map((g) => [g.value, g.objective]), [
    ["PIXEL_PURCHASE", "SALES"],
    ["LANDING_PAGE_VIEW", "TRAFFIC"],
  ]);
  assert.equal(snapObjectiveForGoal("PIXEL_PURCHASE"), "SALES");
  assert.equal(snapObjectiveForGoal("NOPE"), undefined);
  assert.deepEqual(SNAP_OBJECTIVES.map((o) => [o.value, o.note, [...o.goals]]), [
    ["SALES", "purchase", ["PIXEL_PURCHASE", "LANDING_PAGE_VIEW"]],
    ["TRAFFIC", "page view", ["LANDING_PAGE_VIEW"]],
  ]);
  assert.equal(SNAP_DEFAULT_OBJECTIVE, "SALES");
  assert.equal(SNAP_DEFAULT_OBJECTIVE, snapObjectiveForGoal(SNAP_DEFAULT_GOAL));
  // every goal's implied objective admits it
  for (const g of SNAP_OPTIMIZATION_GOALS) assert.ok(snapGoalsFor(g.objective).includes(g.value), g.value);
  assert.deepEqual(snapGoalsFor("AWARENESS_AND_ENGAGEMENT"), []);
  assert.deepEqual(snapGoalsFor("LEADS"), []);
  assert.equal(snapObjectiveLabel("TRAFFIC"), "Traffic");
  assert.equal(snapObjectiveLabel("NOPE"), "NOPE");
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
  landingUrl: "https://fast-flow.org/ht/captcha-1/cars/en/",
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
  assert.equal(r.landingBase, "https://fast-flow.org/ht/captcha-1/cars/en/");
  assert.equal(r.bidMicro, undefined);
  assert.deepEqual(r.wire.campaign, {
    name: resolved.name,
    ad_account_id: "acct-a",
    status: "PAUSED",
    start_time: "2026-09-16T12:00:00.000Z",
    // Sales at the campaign level (owner ask 23.09): omitted, Snap stamps BRAND_AWARENESS / "Awareness"
    // (probe 23.09: 74/74 live campaigns is_auto_generated) and Ads Manager offers no Purchase /
    // Landing page view on a clone. SALES + web allows both launcher goals (docs 23.09).
    objective_v2_properties: { objective_v2_type: "SALES" },
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
    // No deviceOs on the shot = the partner's default: Android only (ask 21.09).
    targeting: { geos: [{ country_code: "us" }], demographics: [{ min_age: "18" }], devices: [{ os_type: "ANDROID" }] },
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
      url: "https://fast-flow.org/ht/captcha-1/cars/en/?utm_source=stone&utm_campaign=glo-snp_003",
      block_preload: false,
      allow_snap_javascript_sdk: false,
      use_immersive_mode: false,
    },
    profile_properties: { profile_id: "prof-1" },
  });
  assert.deepEqual(r.wire.ads[0].ad, { name: resolved.name, type: "REMOTE_WEBPAGE", status: "ACTIVE" });
  assert.equal(r.wire.landingUrl, "https://fast-flow.org/ht/captcha-1/cars/en/?utm_source=stone&utm_campaign=glo-snp_003");
});

test("a bid strategy carries bid_micro; a goal without a pixel sends no pixel_id; no objective sent → the goal's own (Landing page view → Traffic), a sent one rides as is", () => {
  const r = snapLaunchWire(shot({ bidStrategy: "LOWEST_COST_WITH_MAX_BID", bid: "0,50", optimizationGoal: "LANDING_PAGE_VIEW", pixel: "" }), { ...resolved, pixelId: undefined });
  assert.ok(!("refusal" in r));
  if ("refusal" in r) return;
  assert.deepEqual(r.wire.campaign.objective_v2_properties, { objective_v2_type: "TRAFFIC" });
  assert.equal(r.wire.adsquad.optimization_goal, "LANDING_PAGE_VIEW");
  const overridden = snapLaunchWire(shot({ objective: "SALES", optimizationGoal: "LANDING_PAGE_VIEW", pixel: "" }), { ...resolved, pixelId: undefined });
  assert.ok(!("refusal" in overridden));
  if (!("refusal" in overridden)) assert.deepEqual(overridden.wire.campaign.objective_v2_properties, { objective_v2_type: "SALES" });
  assert.equal(r.wire.adsquad.bid_micro, 500_000);
  assert.equal(r.wire.adsquad.pixel_id, undefined);
  assert.equal(r.label, "max $0,5");
  assert.equal(r.bidMicro, 500_000);
});

test("pasted landing: https base with its own query dropped, Snap's tags and the campaign's OWN key appended; the niche is read from the path", () => {
  const r = snapLaunchWire(shot({ landingUrl: "https://example.com/offer/?utm_source=bad#x" }), resolved);
  assert.ok(!("refusal" in r));
  if ("refusal" in r) return;
  assert.equal(r.niche, "Offer");
  assert.equal(r.wire.ads[0].creative.web_view_properties.url, "https://example.com/offer/?utm_source=stone&utm_campaign=glo-snp_003");
  // The partner's own example (22.09) ends in utm_campaign=glo-snp_001 — pasted whole, it still
  // launches on THIS campaign's key, with nothing else in the query.
  const ex = snapLaunchWire(shot({ landingUrl: "https://fast-flow.org/ht/captcha-1/cars/en/?utm_source=stone&utm_campaign=glo-snp_001" }), resolved);
  assert.ok(!("refusal" in ex));
  if ("refusal" in ex) return;
  assert.equal(ex.niche, "Cars");
  assert.equal(ex.landingBase, "https://fast-flow.org/ht/captcha-1/cars/en/");
  assert.equal(ex.wire.ads[0].creative.web_view_properties.url, "https://fast-flow.org/ht/captcha-1/cars/en/?utm_source=stone&utm_campaign=glo-snp_003");
});

test("snapNicheFromLanding reads the niche word past the partner's gate/language segments", () => {
  assert.equal(snapNicheFromLanding("https://fast-flow.org/ht/age-gate/digital-marketing/en/"), "Digital marketing");
  assert.equal(snapNicheFromLanding("https://fast-flow.org/ht/captcha-1/cars/en/?utm_source=stone&utm_campaign=glo-snp_001"), "Cars");
  assert.equal(
    snapNicheFromLanding("https://fast-flow.org/htai/captcha-1/simparic-trio-what-should-dog-owners-ask-their-vet-before-switching-treatments/"),
    "Simparic trio what should dog owners as…", // 40 chars with the ellipsis
  );
  assert.equal(snapNicheFromLanding("https://azmvhs.com/v/dmi-online-marketing-course/"), "Dmi online marketing course");
  assert.equal(snapNicheFromLanding("https://fast-flow.org/ht/quiz-2/pt-br/"), "Fast flow"); // nothing but gate words → the domain
  assert.equal(snapNicheFromLanding("https://fast-flow.org/"), "Fast flow");
  assert.equal(snapNicheFromLanding("http://fast-flow.org/ht/cars/"), ""); // not https → no landing at all
  assert.equal(snapNicheFromLanding("not a url"), "");
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
  // campaign objective (23.09): unknown → by name with the three offered; a goal Snap's matrix does not
  // admit under the objective → the goals it does, or Sales; nothing sent = the goal's own objective
  assert.equal(refusal(shot({ objective: "AWARENESS_AND_ENGAGEMENT" })), "Unknown campaign objective \"AWARENESS_AND_ENGAGEMENT\" — only Sales / Traffic");
  assert.equal(refusal(shot({ objective: "LEADS", optimizationGoal: "LANDING_PAGE_VIEW", pixel: "" })), "Unknown campaign objective \"LEADS\" — only Sales / Traffic");
  assert.equal(refusal(shot({ objective: "TRAFFIC" })), "Pixel purchase is not offered under the Traffic objective — choose Landing page view or the Sales objective");
  assert.equal(refusal(shot({ objective: "TRAFFIC", optimizationGoal: "LANDING_PAGE_VIEW", pixel: "" })), "");
  assert.equal(refusal(shot({ objective: "SALES", optimizationGoal: "LANDING_PAGE_VIEW", pixel: "" })), "");
  assert.equal(refusal(shot({ objective: "" })), "");
  assert.equal(refusal(shot({ objective: " SALES " })), "");
  // the goals removed 23.09 are refused by name, with the two that remain spelled out
  for (const gone of ["SWIPES", "PIXEL_PAGE_VIEW", "IMPRESSIONS"]) {
    assert.match(refusal(shot({ optimizationGoal: gone, pixel: "" })), new RegExp(`Unknown optimization goal "${gone}" — only Pixel purchase or Landing page view`));
  }
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
  assert.match(refusal(shot({ deviceOs: "WINDOWS" })), /Devices must be one of Android only \/ iOS only \/ All devices/);
  assert.match(refusal(shot({ landingUrl: "http://example.com/" })), /https:\/\/ address/);
  assert.match(refusal(shot({ landingUrl: "" })), /Landing must be a pasted https/); // no presets any more (22.09)
  // a tab from before 22.09 sending the old preset id and no URL is refused the same way
  assert.match(refusal({ ...shot({ landingUrl: "" }), landingId: "cars" } as unknown as SnapLaunchShotIn), /Landing must be a pasted https/);
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

test("snapShotMediaIn: the media list normalized; the pre-multi single-creative shape still reads as one creative", () => {
  assert.deepEqual(snapShotMediaIn({ media: [{ url: " https://b/a.mp4 ", kind: "video", name: " a.mp4 " }, { url: "https://b/b.jpg", kind: "image" }] }), [
    { url: "https://b/a.mp4", kind: "video", name: "a.mp4" },
    { url: "https://b/b.jpg", kind: "image" },
  ]);
  // an old tab / script: mediaUrl + mediaKind + mediaName, no `media`
  assert.deepEqual(snapShotMediaIn({ mediaUrl: "https://b/old.jpg", mediaKind: "image", mediaName: "old.jpg" }), [{ url: "https://b/old.jpg", kind: "image", name: "old.jpg" }]);
  assert.deepEqual(snapShotMediaIn({ mediaUrl: "https://b/old.mp4" }), [{ url: "https://b/old.mp4", kind: "video" }]);
  // `media` wins when both are sent; an unknown kind reads as video (the validator has the last word on the file)
  assert.deepEqual(snapShotMediaIn({ media: [{ url: "https://b/new.mp4", kind: "gif" }], mediaUrl: "https://b/old.mp4" }), [{ url: "https://b/new.mp4", kind: "video" }]);
  // junk never throws: no creative at all → the validator's "At least one creative" refusal
  assert.deepEqual(snapShotMediaIn({}), []);
  assert.deepEqual(snapShotMediaIn(null), []);
  assert.deepEqual(snapShotMediaIn({ media: [null, 7] }), [{ url: "", kind: "video" }, { url: "", kind: "video" }]);
  assert.deepEqual(snapShotMediaIn({ media: "https://b/a.mp4", mediaUrl: "  " }), []);
});

// ---- devices: Android only by default (partner ask 21.09) ----------------------------------------

test("devices: Android only is the default — on the vocabulary, on a shot that says nothing, in any spelling", () => {
  assert.equal(SNAP_DEFAULT_DEVICE_OS, "ANDROID");
  assert.deepEqual(SNAP_DEVICE_OPTIONS.map((o) => o.value), ["ANDROID", "iOS", "ALL"]); // Snap's own os_type words + our "no targeting"
  assert.equal(snapDeviceOs(undefined), "ANDROID");
  assert.equal(snapDeviceOs(""), "ANDROID");
  assert.equal(snapDeviceOs(" android "), "ANDROID");
  assert.equal(snapDeviceOs("ios"), "iOS"); // Snap spells it "iOS" — the wire must too
  assert.equal(snapDeviceOs("all"), "ALL");
  assert.equal(snapDeviceOs("WEB"), null); // Snap has it, the launcher does not offer it
  assert.equal(snapDeviceOs("windows"), null);
  assert.equal(snapDeviceShort("ANDROID"), "Android");
  assert.equal(snapDeviceShort("iOS"), "iOS");
  assert.equal(snapDeviceShort("ALL"), "");
});

test("devices ride the ad squad's targeting: ANDROID / iOS as os_type, ALL sends no devices at all", () => {
  const devices = (deviceOs?: string) => {
    const r = snapLaunchWire(shot(deviceOs === undefined ? {} : { deviceOs }), resolved);
    assert.ok(!("refusal" in r), "refusal" in r ? r.refusal : "");
    if ("refusal" in r) throw new Error(r.refusal);
    return { targeting: r.wire.adsquad.targeting, os: r.deviceOs };
  };
  assert.deepEqual(devices().targeting.devices, [{ os_type: "ANDROID" }]);
  assert.equal(devices().os, "ANDROID");
  assert.deepEqual(devices("ANDROID").targeting.devices, [{ os_type: "ANDROID" }]);
  assert.deepEqual(devices("iOS").targeting.devices, [{ os_type: "iOS" }]);
  assert.deepEqual(devices("ios").targeting.devices, [{ os_type: "iOS" }]);
  const all = devices("ALL");
  assert.equal("devices" in all.targeting, false);
  assert.equal(all.os, "ALL");
  // geo and age are untouched by the device choice
  assert.deepEqual(all.targeting, { geos: [{ country_code: "us" }], demographics: [{ min_age: "18" }] });
});
