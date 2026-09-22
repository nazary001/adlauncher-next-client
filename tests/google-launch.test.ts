// Node's built-in runner (v24 strips types natively): `node --test tests/google-launch.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// Google Ads rail — the FRESH-LAUNCH decisions in lib/google-bid.ts: the launch-mode bid plan
// (strategy REQUIRED, no source to inherit), the marker-less name suffix, the ggl- task id, the
// geo wire/label split, the YouTube-URL classifier, and googleLaunchWire — the ONE validator the
// board dry-runs and the route runs for real (copy limits 40/90/90 × 1–5, CTA vocabulary, https
// logo, EXACTLY ONE video source, https landing, geo/language shapes, budget, mosh).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  googleLandingBase,
  googleLandingSegments,
  googleLogoDimsIssue,
  googleLogoUrlNote,
  googleTrackingTail,
  googleBidPlan,
  googleNameSuffix,
  googleShotTaskId,
  googleGeoWire,
  googleGeoLabel,
  isYoutubeUrl,
  googleLaunchWire,
  type GoogleLaunchAdIn,
  type GoogleLaunchShotIn,
} from "../lib/google-bid.ts";

// ---- googleBidPlan mode "launch": strategy is REQUIRED (nothing to inherit) -------------------

test("launch bid plan: an empty strategy is refused with 'Pick a bidding strategy'", () => {
  const p = googleBidPlan({ mode: "launch", override: "", typedBid: "3,95" });
  assert.ok("refusal" in p);
  if ("refusal" in p) assert.match(p.refusal, /Pick a bidding strategy/);
});

test("launch bid plan: Target CPA rides strategy + value + label", () => {
  assert.deepEqual(googleBidPlan({ mode: "launch", override: "target_cpa", typedBid: "3,95" }), {
    wireStrategy: "target_cpa",
    wireBid: 3.95,
    kind: "cpa",
    label: "CPA 3,95",
  });
});

test("launch bid plan: a no-value strategy with a bid is refused ('takes no bid value')", () => {
  const p = googleBidPlan({ mode: "launch", override: "maximize_conversions", typedBid: "5" });
  assert.ok("refusal" in p);
  if ("refusal" in p) assert.match(p.refusal, /takes no bid value/);
  // …and clean when the bid is empty.
  assert.deepEqual(googleBidPlan({ mode: "launch", override: "maximize_conversions", typedBid: "" }), {
    wireStrategy: "maximize_conversions",
    kind: "none",
    label: "auto",
  });
});

// ---- googleNameSuffix launch mode: NO CLONE_FROM/JURO_FROM marker -----------------------------

test("launch suffix is bare 'DD.MM <user>' (LION adds the ' | ' itself)", () => {
  assert.equal(googleNameSuffix({ mode: "launch", user: "nazar", ddmm: "14.09" }), "14.09 nazar GC-Launcher");
});

test("launch suffix lands the tail after the buyer, squashing whitespace", () => {
  assert.equal(googleNameSuffix({ mode: "launch", user: "nazar", ddmm: "14.09", tail: "promo   run" }), "14.09 nazar GC-Launcher promo run");
});

test("launch suffix trims an over-long tail to the 80-char cap", () => {
  const out = googleNameSuffix({ mode: "launch", user: "nazar", ddmm: "14.09", tail: "x".repeat(200) });
  assert.ok(out.length <= 80, `length ${out.length}`);
  assert.ok(out.startsWith("14.09 nazar GC-Launcher "), out);
});

// ---- googleShotTaskId launch → ggl- ----------------------------------------------------------

test("googleShotTaskId launch prefixes ggl- and zero-pads the 1-based index", () => {
  assert.equal(googleShotTaskId("launch", "wave", 0), "ggl-wave-01");
  assert.equal(googleShotTaskId("launch", "w", 9), "ggl-w-10");
  assert.equal(googleShotTaskId("launch", "w", 99), "ggl-w-100");
});

// ---- googleGeoWire: worldwide, mixed refusal, ISO-2 upper-casing, junk refusal ---------------

test("googleGeoWire: empty and ['WW'] are worldwide (geo omitted)", () => {
  assert.deepEqual(googleGeoWire([]), {});
  assert.deepEqual(googleGeoWire(["WW"]), {});
  assert.deepEqual(googleGeoWire(["ww"]), {}); // case-insensitive
});

test("googleGeoWire: WW mixed with a country is refused", () => {
  const g = googleGeoWire(["ww", "be"]);
  assert.ok("refusal" in g);
  if ("refusal" in g) assert.match(g.refusal, /Worldwide \(WW\) cannot be mixed/);
});

test("googleGeoWire: countries upper-case and de-duplicate", () => {
  assert.deepEqual(googleGeoWire(["be", "ca"]), { geo: ["BE", "CA"] });
  assert.deepEqual(googleGeoWire(["BE", "be", "CA"]), { geo: ["BE", "CA"] });
});

test("googleGeoWire: a junk code is refused naming it", () => {
  const g = googleGeoWire(["be", "xyz"]);
  assert.ok("refusal" in g);
  if ("refusal" in g) assert.match(g.refusal, /Unknown country code[s]?: XYZ/);
});

// ---- googleGeoLabel: the monitor geo column --------------------------------------------------

test("googleGeoLabel joins countries with '+', worldwide reads 'WW', junk reads ''", () => {
  assert.equal(googleGeoLabel(["be", "ca"]), "BE+CA");
  assert.equal(googleGeoLabel([]), "WW");
  assert.equal(googleGeoLabel(["WW"]), "WW");
  assert.equal(googleGeoLabel(["be", "xyz"]), "");
});

// ---- isYoutubeUrl: watch / youtu.be / shorts / mobile; rejects vimeo + plain ------------------

test("isYoutubeUrl accepts watch, youtu.be, shorts, embed and the mobile host", () => {
  assert.ok(isYoutubeUrl("https://youtube.com/watch?v=abc123xyz"));
  assert.ok(isYoutubeUrl("https://www.youtube.com/watch?v=abcdefg"));
  assert.ok(isYoutubeUrl("https://www.youtube.com/watch?feature=share&v=abcdefg"));
  assert.ok(isYoutubeUrl("https://youtu.be/abcdefg"));
  assert.ok(isYoutubeUrl("https://youtube.com/shorts/abcdefg"));
  assert.ok(isYoutubeUrl("https://m.youtube.com/watch?v=abc1234"));
});

test("isYoutubeUrl rejects vimeo and non-URLs", () => {
  assert.equal(isYoutubeUrl("https://vimeo.com/123456"), false);
  assert.equal(isYoutubeUrl("https://assets.example.com/video.mp4"), false);
  assert.equal(isYoutubeUrl("not a url"), false);
  assert.equal(isYoutubeUrl(""), false);
});

// ---- googleLaunchWire: the ONE validator — happy wire + the whole refusal matrix -------------

const AD: GoogleLaunchAdIn = {
  headlines: ["Discover today's rates"],
  longHeadlines: ["Compare auto financing options in minutes"],
  descriptions: ["Fast, simple and free to check"],
  callToAction: "LEARN_MORE",
  logoUrl: "https://assets.example.com/logo.png",
  youtubeUrls: ["https://youtube.com/watch?v=abc123xyz"],
  videoUrls: [],
};

const SHOT: GoogleLaunchShotIn = {
  customer: "5378080027",
  budget: "30,00",
  bidStrategy: "target_cpa",
  bid: "3,95",
  suffix: "smoke",
  landingUrl: "https://corquieu.com/r/bmo-s-auto-financing/",
  geo: ["BE", "CA"],
  language: "en",
  ads: [AD],
};

const RESOLVED = { customerId: "5378080027", pixel: "AW-16753471792/8WQeCOLQrJAaELDi1rQ-", nameSuffix: "| 14.09 nazar smoke" };

/** Build with one field overridden; deep-clones AD so an ads override is independent. */
const shot = (over: Partial<GoogleLaunchShotIn> = {}): GoogleLaunchShotIn => ({ ...SHOT, ads: [{ ...AD }], ...over });
const ad = (over: Partial<GoogleLaunchAdIn> = {}): GoogleLaunchAdIn => ({ ...AD, ...over });
const build = (over: Partial<GoogleLaunchShotIn> = {}) => googleLaunchWire(shot(over), RESOLVED);
const refusalOf = (r: ReturnType<typeof build>): string => ("refusal" in r ? r.refusal : "");

test("a valid YouTube shot builds the exact wire (youtube_urls, no video_urls, no mosh)", () => {
  const r = googleLaunchWire(SHOT, RESOLVED);
  assert.ok(!("refusal" in r), refusalOf(r));
  if ("refusal" in r) return;
  assert.equal(r.label, "CPA 3,95");
  assert.equal(r.kind, "cpa");
  assert.deepEqual(r.wire, {
    customer_id: "5378080027",
    budget: "30.00",
    bid_strategy: "target_cpa",
    bid_value: 3.95,
    pixel: "AW-16753471792/8WQeCOLQrJAaELDi1rQ-",
    name_suffix: "| 14.09 nazar smoke",
    landing_url: "https://corquieu.com/r/bmo-s-auto-financing/",
    geo: ["BE", "CA"],
    language: "en",
    ads: [
      {
        headlines: ["Discover today's rates"],
        long_headlines: ["Compare auto financing options in minutes"],
        descriptions: ["Fast, simple and free to check"],
        call_to_action: "LEARN_MORE",
        logo_url: "https://assets.example.com/logo.png",
        youtube_urls: ["https://youtube.com/watch?v=abc123xyz"],
      },
    ],
  });
});

test("a valid uploaded-files shot rides video_urls only (no youtube_urls key)", () => {
  const r = build({ ads: [ad({ youtubeUrls: [], videoUrls: ["https://assets.example.com/v.mp4"] })] });
  assert.ok(!("refusal" in r), refusalOf(r));
  if ("refusal" in r) return;
  assert.deepEqual(r.wire.ads[0], {
    headlines: ["Discover today's rates"],
    long_headlines: ["Compare auto financing options in minutes"],
    descriptions: ["Fast, simple and free to check"],
    call_to_action: "LEARN_MORE",
    logo_url: "https://assets.example.com/logo.png",
    video_urls: ["https://assets.example.com/v.mp4"],
  });
  assert.equal("youtube_urls" in r.wire.ads[0], false);
});

test("call_to_action is omitted when empty; a bad CTA is refused", () => {
  const r = build({ ads: [ad({ callToAction: "" })] });
  assert.ok(!("refusal" in r));
  if (!("refusal" in r)) assert.equal("call_to_action" in r.wire.ads[0], false);
  assert.match(refusalOf(build({ ads: [ad({ callToAction: "BOOK_NOW" })] })), /Call to action/);
});

test("mosh true rides as mosh:true; language '' is omitted", () => {
  const r = build({ mosh: true, language: "" });
  assert.ok(!("refusal" in r), refusalOf(r));
  if ("refusal" in r) return;
  assert.equal(r.wire.mosh, true);
  assert.equal("language" in r.wire, false);
});

test("budget out of range is refused", () => {
  assert.match(refusalOf(build({ budget: "0,5" })), /budget/);
  assert.match(refusalOf(build({ budget: "abc" })), /budget/);
});

test("landing must be present and https://", () => {
  assert.match(refusalOf(build({ landingUrl: "" })), /landing/i);
  assert.match(refusalOf(build({ landingUrl: "http://corquieu.com/r/x/" })), /https/i);
});

test("copy limits: headline >40, long headline >90, description >90, empty descriptions, 6 headlines", () => {
  assert.match(refusalOf(build({ ads: [ad({ headlines: ["x".repeat(41)] })] })), /Headlines/);
  assert.match(refusalOf(build({ ads: [ad({ longHeadlines: ["x".repeat(91)] })] })), /Long headlines/);
  assert.match(refusalOf(build({ ads: [ad({ descriptions: ["x".repeat(91)] })] })), /Descriptions/);
  assert.match(refusalOf(build({ ads: [ad({ descriptions: [] })] })), /Descriptions/);
  assert.match(refusalOf(build({ ads: [ad({ headlines: Array.from({ length: 6 }, (_, i) => `h${i}`) })] })), /at most 5/);
});

test("logo must be an https:// image URL", () => {
  assert.match(refusalOf(build({ ads: [ad({ logoUrl: "" })] })), /Logo/);
  assert.match(refusalOf(build({ ads: [ad({ logoUrl: "http://x.com/a.png" })] })), /Logo/);
});

test("video sources: both is refused, neither is refused, a non-YouTube link is refused", () => {
  assert.match(
    refusalOf(build({ ads: [ad({ youtubeUrls: ["https://youtube.com/watch?v=abc123xyz"], videoUrls: ["https://x.com/v.mp4"] })] })),
    /not both/,
  );
  assert.match(refusalOf(build({ ads: [ad({ youtubeUrls: [], videoUrls: [] })] })), /At least one video/);
  assert.match(refusalOf(build({ ads: [ad({ youtubeUrls: ["https://vimeo.com/123456"] })] })), /Not a YouTube link/);
});

test("an uploaded video URL must be https://; a channel id cannot ride with YouTube links", () => {
  assert.match(refusalOf(build({ ads: [ad({ youtubeUrls: [], videoUrls: ["http://x.com/v.mp4"] })] })), /https/i);
  assert.match(
    refusalOf(build({ ads: [ad({ channelId: "UC1234567890", youtubeUrls: ["https://youtube.com/watch?v=abc123xyz"] })] })),
    /channel id/,
  );
});

test("a bad language code is refused; a mixed-WW geo is refused; no ad groups is refused", () => {
  assert.match(refusalOf(build({ language: "english" })), /language must be a code/);
  assert.match(refusalOf(build({ geo: ["WW", "BE"] })), /Worldwide \(WW\) cannot be mixed/);
  assert.match(refusalOf(build({ ads: [] })), /at least one ad group/);
});

// ---- googleLandingBase / googleLandingSegments: the bare landing LION takes + the preview ----

test("googleLandingBase keeps the https path and drops any pasted query/hash (LION strips + re-tags)", () => {
  assert.deepEqual(googleLandingBase("https://corquieu.com/r/bmo-s-auto-financing/"), {
    base: "https://corquieu.com/r/bmo-s-auto-financing/",
    strippedQuery: false,
  });
  assert.deepEqual(googleLandingBase("  https://corquieu.com/r/x/?utm_source=old&gclid=1#top "), {
    base: "https://corquieu.com/r/x/",
    strippedQuery: true,
  });
});

test("googleLandingBase refuses http, plain text and hostless values", () => {
  assert.equal(googleLandingBase("http://corquieu.com/r/x/"), null);
  assert.equal(googleLandingBase("corquieu.com/r/x/"), null);
  assert.equal(googleLandingBase("https://localhost/x"), null);
  assert.equal(googleLandingBase(""), null);
});

test("googleLandingSegments = bare landing + LION's live-verified tail (acr + pixel slots); empty for an invalid landing", () => {
  const segs = googleLandingSegments("https://corquieu.com/r/x/?a=1", { acr: "GLO-01", pixel: "AW-1/abc" });
  assert.equal(segs.map((x) => x.text).join(""), "https://corquieu.com/r/x/?utm_source=google&utm_campaign=glo-01_{campaignid}_NN&utm_medium=glo-01&mb=glo-01&pixel=AW-1/abc&platform=google");
  assert.deepEqual(segs[0], { text: "https://corquieu.com/r/x/", role: "slug" });
  assert.equal(segs[2].role, "pixel");
  assert.ok(googleLandingSegments("https://a.b/c").map((x) => x.text).join("").includes("pixel=<pixel>"));
  assert.deepEqual(googleLandingSegments("nope"), []);
});

test("googleTrackingTail defaults to glo-01 and a <pixel> slot, lower-cases the ACR", () => {
  assert.equal(googleTrackingTail(), "utm_source=google&utm_campaign=glo-01_{campaignid}_NN&utm_medium=glo-01&mb=glo-01&pixel=<pixel>&platform=google");
  assert.ok(googleTrackingTail({ acr: "GLO-02", pixel: "P" }).includes("utm_campaign=glo-02_{campaignid}_NN&utm_medium=glo-02&mb=glo-02&pixel=P&"));
});

test("googleLogoUrlNote: https image extensions pass, non-image paths warn, http refused, empty silent", () => {
  assert.equal(googleLogoUrlNote("https://a.b/logo.png"), null);
  assert.equal(googleLogoUrlNote("https://a.b/logo.JPG?x=1"), null);
  assert.equal(googleLogoUrlNote("https://placehold.co/512x512.png"), null);
  assert.match(String(googleLogoUrlNote("https://a.b/logo")), /image URL/);
  assert.match(String(googleLogoUrlNote("http://a.b/logo.png")), /https/);
  assert.equal(googleLogoUrlNote(""), null);
});

test("googleLogoDimsIssue: square ≥128 ok; non-square and tiny refused; unknown dims silent", () => {
  assert.equal(googleLogoDimsIssue({ w: 512, h: 512 }), null);
  assert.equal(googleLogoDimsIssue({ w: 128, h: 128 }), null);
  assert.match(String(googleLogoDimsIssue({ w: 512, h: 300 })), /square/);
  assert.match(String(googleLogoDimsIssue({ w: 64, h: 64 })), /at least 128/);
  assert.equal(googleLogoDimsIssue(null), null);
});

test("googleLaunchWire sends the BARE landing (pasted query dropped)", () => {
  const shot = {
    customer: "5378080027",
    budget: "30,00",
    bidStrategy: "target_cpa",
    bid: "3,95",
    suffix: "",
    landingUrl: "https://corquieu.com/r/x/?utm_source=old#frag",
    geo: [],
    ads: [{ headlines: ["h"], longHeadlines: ["l"], descriptions: ["d"], logoUrl: "https://a.b/l.png", youtubeUrls: ["https://youtu.be/abcdef123"], videoUrls: [] }],
  };
  const out = googleLaunchWire(shot, { customerId: "5378080027", nameSuffix: "14.09 x GC-Launcher" });
  assert.ok("wire" in out, JSON.stringify(out));
  if ("wire" in out) assert.equal(out.wire.landing_url, "https://corquieu.com/r/x/");
});

// ---- wireDigest: what a refused/interrupted row says was sent (22.09 diagnostics) ----------------
import { wireDigest } from "../lib/google-bid.ts";

test("wireDigest names the shape of a launch (ad groups, video source counts, copy counts, cta, logo host, landing, geo, language, mosh, bid, budget), never the copy", () => {
  const d = wireDigest({
    customer_id: "1633475800",
    budget: "30.00",
    bid_strategy: "target_cpa",
    bid_value: 3.12,
    landing_url: "https://corquieu.com/r/bmo/",
    geo: ["US", "CA", "GB", "AU", "NZ", "IE"],
    language: "en",
    mosh: true,
    name_suffix: "22.09 OLEKSII GC-Launcher OLEKSII - CREO - ANYMA22",
    ads: [
      { headlines: ["a", "b"], long_headlines: ["c"], descriptions: ["d"], call_to_action: "LEARN_MORE", logo_url: "https://blob.vercel-storage.com/x/logo.png", youtube_urls: ["https://youtu.be/a", "https://youtu.be/b"] },
      { headlines: ["a"], long_headlines: ["c"], descriptions: ["d"], logo_url: "https://blob.vercel-storage.com/x/logo.png", video_urls: ["https://blob.vercel-storage.com/x/v.mp4"], channel_id: "UC1" },
    ],
  });
  assert.equal(d, "ads=2 [yt2,up1] texts=[2/1/1,1/1/1] cta=LEARN_MORE|auto logo=blob.vercel-storage.com channel landing=corquieu.com geo=6 lang=en mosh target_cpa=3.12 budget=30.00 suffix=50ch");
  assert.ok(!d.includes("ANYMA22") && !d.includes("youtu.be/a"));
  // a clone body has no ads
  assert.equal(wireDigest({ source_campaign_id: "1", customer_id: "2", budget: "30.00", bid_strategy: "inherit" } as never), "inherit budget=30.00");
});
