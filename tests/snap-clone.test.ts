// Node's built-in runner (v24 strips types natively): `node --test tests/snap-clone.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// Snapchat cloner — the pure decisions in lib/snap-launch.ts (Part 3): the link's refs (campaign
// ids AND partner keys), the console name read back (key, tail, CLONE_FROM), the clone marker,
// and the DRAFT — how a live campaign maps onto the launcher's vocabulary, with a note for every
// setting the clone cannot carry and a default pick of the creatives worth re-running.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SNAP_CAMPAIGN_ID_RE,
  SNAP_CLONE_MAX_SOURCES,
  snapCampaignName,
  snapCloneDraft,
  snapCloneMark,
  snapCloneRefs,
  snapKeyOfLink,
  snapLaunchWire,
  snapMicroText,
  snapParseCampaignName,
  snapShotMediaIn,
  snapShotTaskId,
  type SnapLaunchShotIn,
} from "../lib/snap-launch.ts";
import type { SnapCloneSource, SnapSourceAd, SnapSourceMedia } from "../lib/snap-source.ts";

const ACCT = "edf89285-d130-489b-a05a-2658280511af";
const CMP = "cf459275-d6aa-48a2-bd91-26ad85d10750";
const NAME = "[01.10] (SNP) Cars - US+CA - glo-snp_250 - Katya - GC-Launcher - CREO - Halloween";
const URL250 = "https://azmvhs.com/v/auto-financing-by-ford/?utm_source=stone&utm_campaign=glo-snp_250";

const media = (n: number, over: Partial<SnapSourceMedia> = {}): SnapSourceMedia => ({
  id: `m-${n}`,
  accountId: ACCT,
  kind: "video",
  name: `clip${n}.mp4`,
  fileName: `e02b-${n}.mp4`,
  downloadUrl: `https://storage.googleapis.com/ad-manager-creatives-production-us/m-${n}/e02b-${n}.mp4`,
  sizeBytes: 9_000_000,
  width: 1080,
  height: 1920,
  durationSec: 8.1,
  ready: true,
  ...over,
});
const ad = (n: number, review: string, over: Partial<SnapSourceAd> = {}): SnapSourceAd => ({
  adId: `ad-${n}`,
  adName: `${NAME} #${n}`,
  adStatus: "ACTIVE",
  squadId: "sq-1",
  review,
  reviewReasons: review === "REJECTED" ? ["potentially confusing"] : [],
  creativeId: `cr-${n}`,
  creativeType: "WEB_VIEW",
  headline: "🟢 LEARN MORE →",
  brandName: "GC",
  cta: "MORE",
  profileId: "prof-1",
  url: URL250,
  media: media(n),
  mediaError: "",
  ...over,
});
const source = (over: Partial<SnapCloneSource> = {}): SnapCloneSource => ({
  campaignId: CMP,
  name: NAME,
  adAccountId: ACCT,
  status: "ACTIVE",
  delivery: ["VALID"],
  createdAt: "2026-10-01T14:39:36.222Z",
  objective: "AWARENESS_AND_ENGAGEMENT",
  objectiveAuto: true,
  squad: {
    id: "sq-1",
    name: NAME,
    status: "ACTIVE",
    deliveryConstraint: "DAILY_BUDGET",
    dailyBudgetMicro: 30_000_000,
    lifetimeBudgetMicro: null,
    bidStrategy: "LOWEST_COST_WITH_MAX_BID",
    bidMicro: 270_000,
    goal: "LANDING_PAGE_VIEW",
    pixelId: "px-1",
    countries: ["US", "CA"],
    subCountryGeo: false,
    minAge: "18",
    maxAge: "",
    gender: "",
    languages: [],
    deviceOs: ["ANDROID"],
    deviceDetails: false,
    extraTargeting: [],
  },
  squadCount: 1,
  otherSquadAds: 0,
  ads: [ad(1, "APPROVED"), ad(2, "REJECTED"), ad(3, "PENDING")],
  ...over,
});

test("campaign ids are Snap's lower-case UUIDs; the cap matches the other cloners", () => {
  assert.ok(SNAP_CAMPAIGN_ID_RE.test(CMP));
  assert.ok(!SNAP_CAMPAIGN_ID_RE.test(CMP.toUpperCase()), "refs are lower-cased before the test");
  assert.ok(!SNAP_CAMPAIGN_ID_RE.test("24250092416"));
  assert.equal(SNAP_CLONE_MAX_SOURCES, 30);
});

test("snapCloneRefs: campaign ids and partner keys, any separator, repeated params, deduped, garbage dropped, capped", () => {
  assert.deepEqual(snapCloneRefs(`${CMP.toUpperCase()}, glo-snp_250;GLO-SNP_007  junk 123 ${CMP}`), [CMP, "glo-snp_250", "glo-snp_007"]);
  // ?ids=a&ids=b arrives as an array; ?keys= rides next to it
  assert.deepEqual(snapCloneRefs([CMP, "glo-snp_001"], "glo-snp_002,glo-snp_001"), [CMP, "glo-snp_001", "glo-snp_002"]);
  assert.deepEqual(snapCloneRefs(undefined, null, ""), []);
  assert.deepEqual(snapCloneRefs("glo-snp_000,glo-snp_501,glo-snp_12"), [], "keys outside the pool are dropped");
  const many = Array.from({ length: 40 }, (_, i) => `glo-snp_${String(i + 1).padStart(3, "0")}`).join(",");
  assert.equal(snapCloneRefs(many).length, SNAP_CLONE_MAX_SOURCES);
});

test("snapParseCampaignName reads the console name back — key, user, tail without the clone marker", () => {
  assert.deepEqual(snapParseCampaignName(NAME), { ddmm: "01.10", niche: "Cars", geo: "US+CA", key: "glo-snp_250", user: "Katya", tail: "CREO - Halloween", cloneOf: "" });
  assert.deepEqual(snapParseCampaignName("[16.09] (SNP) Digital marketing - ?? - glo-snp_012 - nazar - GC-Launcher"), {
    ddmm: "16.09",
    niche: "Digital marketing",
    geo: "??",
    key: "glo-snp_012",
    user: "nazar",
    tail: "",
    cloneOf: "",
  });
  // a clone of a clone: the old marker is read off the tail, never chained
  assert.deepEqual(snapParseCampaignName("[02.10] (SNP) Cars - US - glo-snp_301 - Tima - GC-Launcher - CREO - CLONE_FROM=glo-snp_250"), {
    ddmm: "02.10",
    niche: "Cars",
    geo: "US",
    key: "glo-snp_301",
    user: "Tima",
    tail: "CREO",
    cloneOf: "glo-snp_250",
  });
  assert.equal(snapParseCampaignName("My manual campaign"), null);
  assert.equal(snapParseCampaignName(""), null);
});

test("snapKeyOfLink: the partner key a live ad URL carries in utm_campaign", () => {
  assert.equal(snapKeyOfLink(URL250), "glo-snp_250");
  assert.equal(snapKeyOfLink("https://x.org/a/?utm_campaign=GLO-SNP_007&ScCid=1"), "glo-snp_007");
  assert.equal(snapKeyOfLink("https://x.org/a/?utm_campaign=other"), "");
  assert.equal(snapKeyOfLink("not a url"), "");
});

test("snapCloneMark: the source's key, else the head of its campaign id", () => {
  assert.equal(snapCloneMark("glo-snp_250", CMP), "glo-snp_250");
  assert.equal(snapCloneMark("", CMP), "cf459275");
  assert.equal(snapCloneMark("", ""), "");
});

test("snapCampaignName with a clone marker: CLONE_FROM rides last and survives the length cut, the tail goes first", () => {
  const n = snapCampaignName({ ddmm: "02.10", niche: "Cars", geoLabel: "US+CA", key: "glo-snp_301", user: "Tima", tail: "CREO - Halloween", cloneOf: "glo-snp_250" });
  assert.equal(n, "[02.10] (SNP) Cars - US+CA - glo-snp_301 - Tima - GC-Launcher - CREO - Halloween - CLONE_FROM=glo-snp_250");
  assert.equal(snapCampaignName({ ddmm: "02.10", niche: "Cars", geoLabel: "US", key: "glo-snp_301", user: "Tima", cloneOf: "glo-snp_250" }), "[02.10] (SNP) Cars - US - glo-snp_301 - Tima - GC-Launcher - CLONE_FROM=glo-snp_250");
  const long = snapCampaignName({ ddmm: "02.10", niche: "Cars", geoLabel: "US", key: "glo-snp_301", user: "Tima", tail: "x".repeat(400), cloneOf: "glo-snp_250" });
  assert.equal(long.length, 375);
  assert.ok(long.endsWith(" - CLONE_FROM=glo-snp_250"));
  // without a marker the name is exactly what it always was
  assert.equal(snapCampaignName({ ddmm: "02.10", niche: "Cars", geoLabel: "US", key: "glo-snp_301", user: "Tima", tail: "t" }), "[02.10] (SNP) Cars - US - glo-snp_301 - Tima - GC-Launcher - t");
});

test("snapMicroText: micro-currency → the card's comma money", () => {
  assert.equal(snapMicroText(30_000_000), "30,00");
  assert.equal(snapMicroText(270_000), "0,27");
  assert.equal(snapMicroText(5_005_000), "5,01");
  assert.equal(snapMicroText(null), "");
});

test("snapCloneDraft: a launcher campaign maps 1:1 — account, goal, bid, budget, geo, devices, texts, bare landing, tail, key", () => {
  const d = snapCloneDraft(source());
  assert.deepEqual(d.fields, {
    adAccount: ACCT,
    pixel: "px-1",
    profileId: "prof-1",
    objective: "AWARENESS_AND_ENGAGEMENT",
    optimizationGoal: "LANDING_PAGE_VIEW",
    bidStrategy: "LOWEST_COST_WITH_MAX_BID",
    bid: "0,27",
    budget: "30,00",
    headline: "🟢 LEARN MORE →",
    brandName: "GC",
    cta: "MORE",
    geo: ["US", "CA"],
    minAge: "18",
    deviceOs: "ANDROID",
    landingUrl: "https://azmvhs.com/v/auto-financing-by-ford/",
    suffix: "CREO - Halloween",
  });
  assert.equal(d.key, "glo-snp_250");
  assert.equal(d.launcherName, true);
  assert.deepEqual(d.notes, []);
  // creatives in #N order; the rejected one is NOT picked by default, the pending one is
  assert.deepEqual(
    d.creatives.map((c) => [c.n, c.review, c.pick, c.issue]),
    [
      [1, "APPROVED", true, ""],
      [2, "REJECTED", false, ""],
      [3, "PENDING", true, ""],
    ],
  );
  assert.equal(d.creatives[0].mediaId, "m-1");
  assert.equal(d.creatives[0].accountId, ACCT);
  assert.equal(d.creatives[0].uploadName, "clip1.mp4");
});

test("snapCloneDraft: Sales and both launcher goals ride as they are; a CTA outside the ten falls back to More", () => {
  const s = source({ objective: "SALES", objectiveAuto: false });
  s.squad = { ...s.squad!, goal: "PIXEL_PURCHASE", bidStrategy: "AUTO_BID", bidMicro: null };
  s.ads = s.ads.map((a) => ({ ...a, cta: "ORDER_NOW" }));
  const d = snapCloneDraft(s);
  assert.equal(d.fields.objective, "SALES");
  assert.equal(d.fields.optimizationGoal, "PIXEL_PURCHASE");
  assert.equal(d.fields.bidStrategy, "AUTO_BID");
  assert.equal(d.fields.bid, "");
  assert.equal(d.fields.cta, "MORE");
  assert.ok(d.notes.some((n) => /ORDER_NOW/.test(n)));
});

test("snapCloneDraft notes every setting the launcher cannot carry and lands on its vocabulary", () => {
  const s = source({ objective: "TRAFFIC", objectiveAuto: false, squadCount: 2, otherSquadAds: 3 });
  s.squad = {
    ...s.squad!,
    goal: "SWIPES",
    bidStrategy: "MIN_ROAS",
    bidMicro: null,
    deliveryConstraint: "LIFETIME_BUDGET",
    dailyBudgetMicro: null,
    lifetimeBudgetMicro: 900_000_000,
    subCountryGeo: true,
    minAge: "13",
    maxAge: "35",
    gender: "FEMALE",
    languages: ["en"],
    deviceOs: ["iOS", "ANDROID"],
    deviceDetails: true,
    extraTargeting: ["interests"],
  };
  const d = snapCloneDraft(s);
  assert.equal(d.fields.objective, "AWARENESS_AND_ENGAGEMENT");
  assert.equal(d.fields.optimizationGoal, "PIXEL_PURCHASE");
  assert.equal(d.fields.bidStrategy, "AUTO_BID");
  assert.equal(d.fields.budget, "10,00");
  assert.equal(d.fields.minAge, "18");
  assert.equal(d.fields.deviceOs, "ALL");
  const text = d.notes.join(" | ");
  for (const word of ["2 ad squads", "TRAFFIC", "SWIPES", "MIN_ROAS", "lifetime", "regions", "35", "FEMALE", "languages", "OS version", "interests"]) {
    assert.ok(text.includes(word), `a note names ${word}: ${text}`);
  }
});

test("snapCloneDraft: min ages land on the nearest offered one that does not widen the audience", () => {
  const at = (age: string) => {
    const s = source();
    s.squad = { ...s.squad!, minAge: age };
    return snapCloneDraft(s).fields.minAge;
  };
  assert.equal(at("18"), "18");
  assert.equal(at("20"), "21");
  assert.equal(at("21"), "21");
  assert.equal(at("23"), "25");
  assert.equal(at("40"), "25");
  assert.equal(at(""), "18");
});

test("snapCloneDraft: creatives that cannot be cloned carry the reason and are never picked; paused ads are left out by default", () => {
  const s = source();
  s.ads = [
    ad(1, "APPROVED", { creativeType: "APP_INSTALL" }),
    ad(2, "APPROVED", { media: null, mediaError: "media m-2 could not be read" }),
    ad(3, "APPROVED", { media: media(3, { ready: false }) }),
    ad(4, "APPROVED", { adStatus: "PAUSED" }),
    ad(5, "APPROVED", { media: media(5, { kind: "", name: "lens" }) }),
    ad(6, "APPROVED", { media: media(6, { name: "My video", fileName: "a1b2.mov" }) }),
  ];
  const d = snapCloneDraft(s);
  const by = new Map(d.creatives.map((c) => [c.n, c]));
  assert.match(by.get(1)!.issue, /web-view/);
  assert.match(by.get(2)!.issue, /could not be read/);
  assert.match(by.get(3)!.issue, /not ready/);
  assert.equal(by.get(4)!.issue, "");
  assert.equal(by.get(4)!.pick, false, "paused in the source → off by default");
  assert.match(by.get(5)!.issue, /video or an image/);
  assert.equal(by.get(6)!.uploadName, "My video.mov", "a name without an extension borrows the stored file's");
  assert.deepEqual(d.creatives.filter((c) => c.pick).map((c) => c.n), [6]);
});

test("snapCloneDraft: creatives disagreeing on texts or landing → the first picked one wins, the rest are named", () => {
  const s = source();
  s.ads = [ad(1, "APPROVED"), ad(2, "APPROVED", { headline: "Other headline", url: "https://fast-flow.org/ht/captcha-1/cars/en/?utm_source=stone&utm_campaign=glo-snp_250" })];
  const d = snapCloneDraft(s);
  assert.equal(d.fields.headline, "🟢 LEARN MORE →");
  assert.equal(d.fields.landingUrl, "https://azmvhs.com/v/auto-financing-by-ford/");
  assert.ok(d.notes.some((n) => /#2/.test(n) && /headline/.test(n)));
  assert.ok(d.notes.some((n) => /#2/.test(n) && /landing/.test(n)));
});

test("snapCloneDraft on a campaign the launcher did not name: no tail, the key from the ad URL, a note", () => {
  const d = snapCloneDraft(source({ name: "Manual campaign from Ads Manager" }));
  assert.equal(d.launcherName, false);
  assert.equal(d.fields.suffix, "");
  assert.equal(d.key, "glo-snp_250", "read from utm_campaign when the name has none");
});

test("snapCloneDraft with no ad squad: nothing to clone, said plainly", () => {
  const d = snapCloneDraft(source({ squad: null, squadCount: 0, ads: [] }));
  assert.deepEqual(d.creatives, []);
  assert.ok(d.notes.some((n) => /no ad squad/i.test(n)));
});

// ---------- the wire takes a creative that already lives on Snapchat ----------

const shot = (over: Partial<SnapLaunchShotIn> = {}): SnapLaunchShotIn => ({
  adAccount: ACCT,
  optimizationGoal: "LANDING_PAGE_VIEW",
  bidStrategy: "AUTO_BID",
  bid: "",
  budget: "10,00",
  headline: "Hello",
  brandName: "GC",
  cta: "MORE",
  media: [{ url: "", kind: "video", name: "a.mp4", snapMediaId: "0a970ec7-0fe2-4114-8382-1a591f44f398", snapAccountId: ACCT }],
  geo: ["US"],
  minAge: "18",
  landingUrl: "https://azmvhs.com/v/auto-financing-by-ford/",
  suffix: "",
  ...over,
});
const resolved = { adAccountId: ACCT, profileId: "prof-1", name: "n", key: "glo-snp_301", mediaIds: ["0a970ec7-0fe2-4114-8382-1a591f44f398"], startTimeIso: "2026-10-02T00:00:00.000Z" };

test("snapShotMediaIn carries a source media id and its account; junk ids are dropped", () => {
  const out = snapShotMediaIn({
    media: [
      { url: "https://s/x.mp4", kind: "video", name: "x.mp4", snapMediaId: " 0A970EC7-0FE2-4114-8382-1A591F44F398 ", snapAccountId: ACCT },
      { url: "https://s/y.mp4", kind: "video", snapMediaId: "nope", snapAccountId: "also nope" },
    ],
  });
  assert.deepEqual(out, [
    { url: "https://s/x.mp4", kind: "video", name: "x.mp4", snapMediaId: "0a970ec7-0fe2-4114-8382-1a591f44f398", snapAccountId: ACCT },
    { url: "https://s/y.mp4", kind: "video" },
  ]);
});

test("snapLaunchWire accepts a creative reused by media id (no file URL) and still refuses one with neither", () => {
  const ok = snapLaunchWire(shot(), resolved);
  assert.ok(!("refusal" in ok), JSON.stringify(ok));
  if (!("refusal" in ok)) assert.equal(ok.wire.ads[0].creative.top_snap_media_id, "0a970ec7-0fe2-4114-8382-1a591f44f398");
  const none = snapLaunchWire(shot({ media: [{ url: "", kind: "video" }] }), resolved);
  assert.deepEqual(none, { refusal: "The creative has no file — a vertical video or image is required" });
  const bad = snapLaunchWire(shot({ media: [{ url: "http://evil.example/x.mp4", kind: "video", snapMediaId: "0a970ec7-0fe2-4114-8382-1a591f44f398", snapAccountId: ACCT }] }), resolved);
  assert.deepEqual(bad, { refusal: "The creative must be a public https:// file" });
});

test("clone shots get their own task-id prefix (snc-), launches keep snl-", () => {
  assert.equal(snapShotTaskId("w-1234567", 0), "snl-w-1234567-01");
  assert.equal(snapShotTaskId("w-1234567", 2, "clone"), "snc-w-1234567-03");
});

// ---------- refs → campaigns (keys through the registry) and read errors ----------

import { snapCloneResolve, snapSourceErrorText } from "../lib/snap-launch.ts";

test("snapCloneResolve: ids pass through; keys resolve to the campaign the registry binds NOW", () => {
  const registry = [
    { key: "glo-snp_250", campaign_id: CMP, user: "Katya", status: "active" },
    { key: "glo-snp_251", user: "Tima", status: "active" },
    { key: "glo-snp_252", campaign_id: "aaaaaaaa-0000-0000-0000-000000000001", user: "Mykola", status: "retired" },
  ];
  assert.deepEqual(snapCloneResolve([CMP, "glo-snp_250", "glo-snp_251", "glo-snp_252", "glo-snp_253"], registry), [
    { ref: CMP, campaignId: CMP },
    { ref: "glo-snp_250", campaignId: CMP, holder: "Katya" },
    { ref: "glo-snp_251", campaignId: "", error: "glo-snp_251 has no campaign yet — its launch is still running or failed before the campaign existed" },
    { ref: "glo-snp_252", campaignId: "aaaaaaaa-0000-0000-0000-000000000001", holder: "Mykola" },
    { ref: "glo-snp_253", campaignId: "", error: "glo-snp_253 is free — no campaign holds this key" },
  ]);
  assert.deepEqual(snapCloneResolve(["glo-snp_250", CMP], null, "strapi 503"), [
    { ref: "glo-snp_250", campaignId: "", error: "the key registry could not be read (strapi 503) — retry, or open the campaign by its id" },
    { ref: CMP, campaignId: CMP },
  ]);
});

test("snapSourceErrorText: Snap's answers about a campaign in the buyer's words", () => {
  assert.equal(snapSourceErrorText(400, "We're sorry, but the requested resource is not available at this time"), "This campaign is gone from Snapchat (deleted in Ads Manager)");
  assert.equal(snapSourceErrorText(404, "Resource can not be found"), "No such campaign on Snapchat — check the id");
  assert.equal(snapSourceErrorText(400, "Request URL can not be correctly processed"), "No such campaign on Snapchat — check the id", "a well-formed id Snap never issued (live 01.10)");
  assert.equal(snapSourceErrorText(401, "token revoked"), "Snapchat refused the read (401: token revoked)");
  assert.equal(snapSourceErrorText(undefined, "fetch failed"), "fetch failed");
  assert.equal(snapSourceErrorText(undefined, ""), "Snapchat read failed");
});

import { snapRemoteMediaIssue } from "../lib/snap-launch.ts";

test("snapRemoteMediaIssue: one creative at least; unclonable ones block; moving accounts needs a link and ≤32 MB, staying needs neither", () => {
  const c = (n: number, over: Record<string, unknown> = {}) => ({ n, on: true, issue: "", url: `https://s/${n}.mp4`, sizeBytes: 9_000_000, accountId: ACCT, ...over });
  assert.equal(snapRemoteMediaIssue([c(1, { on: false })], ACCT), "Pick at least one creative of the source");
  assert.equal(snapRemoteMediaIssue([c(1), c(2, { issue: "the media is not ready on Snapchat" })], ACCT), "Creative #2: the media is not ready on Snapchat");
  assert.equal(snapRemoteMediaIssue([c(1, { url: "", sizeBytes: 80_000_000 })], ACCT), null, "on its own account: reused as is");
  assert.equal(snapRemoteMediaIssue([c(1, { url: "" })], "other-acct"), "Creative #1 has no download link on Snapchat — it can only be cloned on its own ad account");
  assert.equal(snapRemoteMediaIssue([c(3, { sizeBytes: 40 * 1024 * 1024 })], "other-acct"), "Creative #3 is 40 MB — moving it to another ad account takes at most 32 MB; clone it on its own account");
  assert.equal(snapRemoteMediaIssue([c(1), c(2, { on: false, issue: "lens" })], "other-acct"), null, "an unpicked unclonable creative does not block");
});
