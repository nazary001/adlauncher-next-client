// Node's built-in runner (v24 strips types natively): `node --test tests/snap-source.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// Snapchat cloner — the READ side: Snap's envelopes for one live campaign (campaign → ad squads →
// ads → creatives → media, shapes probed read-only 01.10.2026 on a real launcher campaign) folded
// into ONE clone source the board drafts from. Pure: no network, no vocabulary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSnapCloneSource, parseSnapSourceMedia, snapEnvelopeEntities } from "../lib/snap-source.ts";

const ACCT = "edf89285-d130-489b-a05a-2658280511af";
const CMP = "cf459275-d6aa-48a2-bd91-26ad85d10750";
const SQ = "3a4596fd-c2b6-4b97-8dc8-131f52c67dda";
const NAME = "[01.10] (SNP) Cars - US+CA - glo-snp_250 - Katya - GC-Launcher - CREO - Halloween";

const campaign = {
  id: CMP,
  name: NAME,
  ad_account_id: ACCT,
  status: "ACTIVE",
  objective: "BRAND_AWARENESS",
  start_time: "2026-10-01T14:40:35.865Z",
  created_at: "2026-10-01T14:39:36.222Z",
  delivery_status: ["VALID", "LEARNING_PHASE"],
  objective_v2_properties: { objective_v2_type: "AWARENESS_AND_ENGAGEMENT", is_auto_generated: true },
};
const squad = {
  id: SQ,
  name: NAME,
  status: "ACTIVE",
  campaign_id: CMP,
  type: "SNAP_ADS",
  targeting: {
    regulated_content: false,
    demographics: [{ min_age: "18" }],
    geos: [{ country_code: "us" }, { country_code: "ca" }],
    devices: [{ os_type: "ANDROID" }],
    enable_targeting_expansion: true,
    auto_expansion_options: { interest_expansion_option: { enabled: true }, custom_audience_expansion_option: { enabled: true } },
  },
  billing_event: "IMPRESSION",
  bid_micro: 270000,
  auto_bid: false,
  bid_strategy: "LOWEST_COST_WITH_MAX_BID",
  daily_budget_micro: 30000000,
  optimization_goal: "LANDING_PAGE_VIEW",
  pixel_id: "7d05c475-e49e-4216-98e9-1b7aa8687ac6",
  delivery_constraint: "DAILY_BUDGET",
  created_at: "2026-10-01T14:39:37.414Z",
};
const ad = (n: number, review: string, over: Record<string, unknown> = {}) => ({
  id: `ad-${n}`,
  name: `${NAME} #${n}`,
  ad_squad_id: SQ,
  creative_id: `cr-${n}`,
  status: "ACTIVE",
  type: "REMOTE_WEBPAGE",
  review_status: review,
  ...(review === "REJECTED" ? { review_status_reasons: ["Oh no! Your ad is potentially confusing to Snapchatters."] } : {}),
  created_at: `2026-10-01T14:39:4${n}.000Z`,
  ...over,
});
const creative = (n: number, over: Record<string, unknown> = {}) => ({
  id: `cr-${n}`,
  name: `${NAME} #${n}`,
  ad_account_id: ACCT,
  type: "WEB_VIEW",
  headline: "🟢 LEARN MORE →",
  brand_name: "GC",
  call_to_action: "MORE",
  top_snap_media_id: `m-${n}`,
  web_view_properties: { url: "https://azmvhs.com/v/auto-financing-by-ford/?utm_source=stone&utm_campaign=glo-snp_250", block_preload: false },
  ad_product: "SNAP_AD",
  profile_properties: { profile_id: "d33b1552-d74c-495d-957d-463ff2196011" },
  ...over,
});
const media = (n: number, over: Record<string, unknown> = {}) => ({
  id: `m-${n}`,
  name: `clip${n}.mp4`,
  ad_account_id: ACCT,
  type: "VIDEO",
  media_status: "READY",
  file_name: `e02b114d-${n}.mp4`,
  download_link: `https://storage.googleapis.com/ad-manager-creatives-production-us/m-${n}/e02b114d-${n}.mp4`,
  duration_in_seconds: 8.103991,
  video_metadata: { width_px: 1080, height_px: 1920 },
  file_size_in_bytes: 9367731,
  ...over,
});

const world = () => ({
  campaign,
  squads: [squad],
  ads: [ad(2, "REJECTED"), ad(1, "APPROVED"), ad(3, "PENDING")],
  creatives: new Map([1, 2, 3].map((n) => [`cr-${n}`, creative(n)])),
  media: new Map([1, 2, 3].map((n) => [`m-${n}`, media(n)])),
});

test("snapEnvelopeEntities unwraps Snap's batch envelope and skips refused items", () => {
  const body = {
    request_status: "SUCCESS",
    adsquads: [
      { sub_request_status: "SUCCESS", adsquad: { id: "a" } },
      { sub_request_status: "ERROR", sub_request_error_reason: "nope" },
      { sub_request_status: "SUCCESS", adsquad: { id: "b" } },
    ],
  };
  assert.deepEqual(snapEnvelopeEntities(body, "adsquads").map((e) => e.id), ["a", "b"]);
  // media is its own plural ("media" → "media")
  assert.deepEqual(snapEnvelopeEntities({ media: [{ sub_request_status: "SUCCESS", media: { id: "m" } }] }, "media").map((e) => e.id), ["m"]);
  assert.deepEqual(snapEnvelopeEntities(null, "ads"), []);
  assert.deepEqual(snapEnvelopeEntities({ ads: "x" }, "ads"), []);
});

test("parseSnapSourceMedia reads the downloadable original, its kind, size and frame", () => {
  const m = parseSnapSourceMedia(media(1));
  assert.deepEqual(m, {
    id: "m-1",
    accountId: ACCT,
    kind: "video",
    name: "clip1.mp4",
    fileName: "e02b114d-1.mp4",
    downloadUrl: "https://storage.googleapis.com/ad-manager-creatives-production-us/m-1/e02b114d-1.mp4",
    sizeBytes: 9367731,
    width: 1080,
    height: 1920,
    durationSec: 8.1,
    ready: true,
  });
  const img = parseSnapSourceMedia(media(4, { type: "IMAGE", name: "", file_name: "f.png", video_metadata: undefined, image_metadata: { width_px: 1080, height_px: 1920 }, duration_in_seconds: undefined }));
  assert.equal(img.kind, "image");
  assert.equal(img.name, "f.png", "no display name → the stored file name");
  assert.equal(img.width, 1080);
  assert.equal(img.durationSec, null);
  // a link that is not https is not a downloadable original
  assert.equal(parseSnapSourceMedia(media(5, { download_link: "http://x/y.mp4" })).downloadUrl, "");
  assert.equal(parseSnapSourceMedia(media(6, { media_status: "PENDING_UPLOAD" })).ready, false);
  assert.equal(parseSnapSourceMedia(media(7, { type: "LENS" })).kind, "");
});

test("buildSnapCloneSource: one campaign, its ad squad and every ad in the buyer's #N order with creative and media", () => {
  const src = buildSnapCloneSource(world());
  assert.equal(src.campaignId, CMP);
  assert.equal(src.name, NAME);
  assert.equal(src.adAccountId, ACCT);
  assert.equal(src.status, "ACTIVE");
  assert.deepEqual(src.delivery, ["VALID", "LEARNING_PHASE"]);
  assert.equal(src.objective, "AWARENESS_AND_ENGAGEMENT");
  assert.equal(src.objectiveAuto, true);
  assert.equal(src.squadCount, 1);
  const q = src.squad;
  assert.ok(q);
  assert.equal(q.id, SQ);
  assert.equal(q.goal, "LANDING_PAGE_VIEW");
  assert.equal(q.bidStrategy, "LOWEST_COST_WITH_MAX_BID");
  assert.equal(q.bidMicro, 270000);
  assert.equal(q.dailyBudgetMicro, 30000000);
  assert.equal(q.lifetimeBudgetMicro, null);
  assert.equal(q.deliveryConstraint, "DAILY_BUDGET");
  assert.equal(q.pixelId, "7d05c475-e49e-4216-98e9-1b7aa8687ac6");
  assert.deepEqual(q.countries, ["US", "CA"]);
  assert.equal(q.subCountryGeo, false);
  assert.equal(q.minAge, "18");
  assert.equal(q.maxAge, "");
  assert.deepEqual(q.deviceOs, ["ANDROID"]);
  assert.deepEqual(q.deviceDetails, false);
  // Snap's own defaults (expansion, regulated_content) are not "extra targeting" the clone loses
  assert.deepEqual(q.extraTargeting, []);
  // ads ordered by their "#N" (the card's file order), not by Snap's list order
  assert.deepEqual(src.ads.map((a) => a.adId), ["ad-1", "ad-2", "ad-3"]);
  assert.deepEqual(src.ads.map((a) => a.review), ["APPROVED", "REJECTED", "PENDING"]);
  assert.deepEqual(src.ads[1].reviewReasons, ["Oh no! Your ad is potentially confusing to Snapchatters."]);
  const a1 = src.ads[0];
  assert.equal(a1.creativeType, "WEB_VIEW");
  assert.equal(a1.headline, "🟢 LEARN MORE →");
  assert.equal(a1.brandName, "GC");
  assert.equal(a1.cta, "MORE");
  assert.equal(a1.profileId, "d33b1552-d74c-495d-957d-463ff2196011");
  assert.equal(a1.url, "https://azmvhs.com/v/auto-financing-by-ford/?utm_source=stone&utm_campaign=glo-snp_250");
  assert.equal(a1.media?.id, "m-1");
  assert.equal(a1.media?.downloadUrl.startsWith("https://storage.googleapis.com/"), true);
  assert.equal(a1.mediaError, "");
});

test("buildSnapCloneSource keeps what it could not read visible instead of dropping the ad", () => {
  const w = world();
  w.creatives.delete("cr-3");
  w.media.set("m-2", { error: "Snapchat HTTP 404" });
  const src = buildSnapCloneSource(w);
  assert.equal(src.ads.length, 3);
  const a2 = src.ads.find((a) => a.adId === "ad-2");
  assert.equal(a2?.media, null);
  assert.equal(a2?.mediaError, "Snapchat HTTP 404");
  const a3 = src.ads.find((a) => a.adId === "ad-3");
  assert.equal(a3?.creativeType, "");
  assert.equal(a3?.mediaError, "creative cr-3 could not be read");
});

test("buildSnapCloneSource: several ad squads → the one carrying the most ads leads; others are counted", () => {
  const w = world();
  const second = { ...squad, id: "sq-2", optimization_goal: "PIXEL_PURCHASE", created_at: "2026-10-01T15:00:00.000Z" };
  w.squads = [second, squad];
  w.ads = [...w.ads, ad(9, "APPROVED", { ad_squad_id: "sq-2" })];
  w.creatives.set("cr-9", creative(9));
  w.media.set("m-9", media(9));
  const src = buildSnapCloneSource(w);
  assert.equal(src.squadCount, 2);
  assert.equal(src.squad?.id, SQ, "3 ads beat 1");
  assert.equal(src.ads.every((a) => a.squadId === SQ), true, "only the leading squad's ads are cloned");
  assert.equal(src.otherSquadAds, 1);
});

test("buildSnapCloneSource reads lifetime budgets, sub-country geo, ages, genders, extra targeting and device details", () => {
  const w = world();
  w.squads = [
    {
      ...squad,
      delivery_constraint: "LIFETIME_BUDGET",
      daily_budget_micro: undefined,
      lifetime_budget_micro: 900000000,
      bid_strategy: "AUTO_BID",
      bid_micro: undefined,
      targeting: {
        geos: [{ country_code: "us", region_id: ["3"] }, { country_code: "gb" }],
        demographics: [{ min_age: "21", max_age: "35", gender: "FEMALE", languages: ["en"] }],
        devices: [{ os_type: "iOS", os_version_min: "15.0" }, { os_type: "ANDROID" }],
        interests: [{ category_id: ["SLC_1"] }],
        segments: [{ segment_id: ["s1"] }],
        regulated_content: false,
      },
    },
  ];
  const q = buildSnapCloneSource(w).squad;
  assert.ok(q);
  assert.equal(q.dailyBudgetMicro, null);
  assert.equal(q.lifetimeBudgetMicro, 900000000);
  assert.equal(q.deliveryConstraint, "LIFETIME_BUDGET");
  assert.equal(q.bidMicro, null);
  assert.deepEqual(q.countries, ["US", "GB"]);
  assert.equal(q.subCountryGeo, true);
  assert.equal(q.minAge, "21");
  assert.equal(q.maxAge, "35");
  assert.equal(q.gender, "FEMALE");
  assert.deepEqual(q.languages, ["en"]);
  assert.deepEqual(q.deviceOs, ["iOS", "ANDROID"]);
  assert.equal(q.deviceDetails, true);
  assert.deepEqual(q.extraTargeting, ["interests", "segments"]);
});

test("buildSnapCloneSource without an ad squad still describes the campaign (nothing to clone)", () => {
  const w = world();
  w.squads = [];
  w.ads = [];
  const src = buildSnapCloneSource(w);
  assert.equal(src.squad, null);
  assert.equal(src.squadCount, 0);
  assert.deepEqual(src.ads, []);
});

test("an ad without #N in its name keeps Snap's creation order after the numbered ones", () => {
  const w = world();
  w.ads = [ad(2, "APPROVED"), ad(7, "APPROVED", { name: "manual ad", created_at: "2026-10-01T10:00:00.000Z" }), ad(1, "APPROVED")];
  w.creatives.set("cr-7", creative(7));
  w.media.set("m-7", media(7));
  const src = buildSnapCloneSource(w);
  assert.deepEqual(src.ads.map((a) => a.adId), ["ad-1", "ad-2", "ad-7"]);
});
