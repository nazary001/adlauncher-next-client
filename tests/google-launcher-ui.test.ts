// Node's built-in runner (v24 strips types natively): `node --test tests/google-launcher-ui.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// Google Ads rail — the LAUNCHER TEXTURE decisions in lib/google-bid.ts, the pure vocabulary the
// mirrored Demand Generation Launcher board renders (owner ask 14.09): the 5-strategy launch
// picker, the four geo presets, the full 52-language list, the pipe/line field codecs, the bulk
// video → ad-group splitter, the offer word derived from the landing domain, the read-only
// campaign-name head preview, and googleLaunchWire fanning MULTIPLE ad groups onto the wire.
// These are the shapes the card binds to; the board owns the I/O and DOM around them.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GOOGLE_LAUNCH_BID_STRATEGIES,
  GOOGLE_GEO_PRESETS,
  GOOGLE_LANGUAGES_FULL,
  splitPipes,
  joinPipes,
  splitLines,
  chunkVideosIntoAdGroups,
  googleOfferFromLanding,
  googleNameHeadPreview,
  googleLaunchWire,
  type GoogleLaunchAdIn,
  type GoogleLaunchShotIn,
} from "../lib/google-bid.ts";

// ---- GOOGLE_LAUNCH_BID_STRATEGIES: the 5 the launcher UI offers (the two "_cap"/"_target" -----
// variants stay in GOOGLE_BID_STRATEGIES for the clone board's inherit-and-switch, NOT here).

test("the launcher picker carries exactly the 5 strategies, in LION's order", () => {
  assert.deepEqual(
    GOOGLE_LAUNCH_BID_STRATEGIES.map((s) => s.value),
    ["maximize_conversions", "target_cpa", "target_roas", "maximize_conversion_value", "manual_cpc"],
  );
  assert.equal(GOOGLE_LAUNCH_BID_STRATEGIES.length, 5);
  // The kinds ride through unchanged from the full vocabulary (drives the conditional bid field).
  assert.deepEqual(
    GOOGLE_LAUNCH_BID_STRATEGIES.map((s) => s.kind),
    ["none", "cpa", "roas", "none", "none"],
  );
});

// ---- GOOGLE_GEO_PRESETS: the four one-click preset buttons under the Countries multi-select -----

test("geo presets = World / LATAM / Anglo / Franco in order, with the right codes", () => {
  assert.deepEqual(GOOGLE_GEO_PRESETS.map((p) => p.label), ["World", "LATAM", "Anglo", "Franco"]);
  const byLabel = new Map(GOOGLE_GEO_PRESETS.map((p) => [p.label, p.codes]));
  // World = the WW sentinel (no geo on the wire), never an empty list.
  assert.deepEqual(byLabel.get("World"), ["WW"]);
  // LATAM = 17 Latin-American markets.
  assert.equal(byLabel.get("LATAM")!.length, 17);
  // Anglo = the six English markets; Franco = the French-speaking set (CA in both).
  assert.deepEqual(byLabel.get("Anglo"), ["US", "CA", "GB", "AU", "NZ", "IE"]);
  assert.deepEqual(byLabel.get("Franco"), ["FR", "BE", "CH", "LU", "MC", "CA"]);
});

// ---- GOOGLE_LANGUAGES_FULL: LION's full launcher language list (external API takes ONE code) ----

test("the full language list leads with the no-targeting sentinel and carries LION's codes", () => {
  // 52 entries (51 languages + the "" sentinel). NOTE: the slice brief said 53 — the shipped list
  // in lib/google-bid.ts is 52 (the intro figure), so the runner asserts the real length.
  assert.equal(GOOGLE_LANGUAGES_FULL.length, 52);
  assert.equal(GOOGLE_LANGUAGES_FULL[0].value, "");
  const codes = GOOGLE_LANGUAGES_FULL.map((l) => l.value);
  // The three the brief calls out: plain English, the region-suffixed Chinese, Google's legacy
  // Hebrew code ("iw", not "he").
  for (const code of ["en", "zh_CN", "iw"]) assert.ok(codes.includes(code), `missing ${code}`);
  // No duplicate codes (a dropdown with two "en" would silently collide).
  assert.equal(new Set(codes).size, codes.length);
});

// ---- splitPipes / joinPipes: the one-input "H1 | H2 | H3" copy fields ---------------------------

test("splitPipes splits on |, squashes inner whitespace, drops empty cells", () => {
  assert.deepEqual(splitPipes("H1 | H2 |  | H3 "), ["H1", "H2", "H3"]);
  assert.deepEqual(splitPipes("H1   two   words"), ["H1 two words"]);
  assert.deepEqual(splitPipes("   "), []);
  assert.deepEqual(splitPipes(""), []);
});

test("joinPipes round-trips a split field back to the ' | ' text", () => {
  assert.equal(joinPipes(splitPipes("H1 | H2 | H3")), "H1 | H2 | H3");
  assert.equal(joinPipes(["A", "  B  ", "", "C"]), "A | B | C");
});

// ---- splitLines: the YouTube-URLs textarea (one per line, tolerant of commas/spaces) -----------

test("splitLines splits on newlines/commas/spaces, dedupes, empty → []", () => {
  assert.deepEqual(splitLines("a\nb, c a"), ["a", "b", "c"]);
  assert.deepEqual(splitLines("u1\nu1\nu2"), ["u1", "u2"]);
  assert.deepEqual(splitLines(""), []);
  assert.deepEqual(splitLines("   \n  "), []);
});

// ---- chunkVideosIntoAdGroups: the "up to 50 videos → ad groups of 5" bulk splitter -------------

test("chunkVideosIntoAdGroups splits into groups of 5 and caps at 50 videos", () => {
  assert.deepEqual(chunkVideosIntoAdGroups([], {}, "youtubeUrls"), []);
  assert.equal(chunkVideosIntoAdGroups(["a", "b", "c", "d", "e"], {}, "youtubeUrls").length, 1);
  const six = chunkVideosIntoAdGroups(["a", "b", "c", "d", "e", "f"], {}, "youtubeUrls");
  assert.deepEqual(six.map((g) => g.youtubeUrls.length), [5, 1]);
  const fifty = chunkVideosIntoAdGroups(Array.from({ length: 50 }, (_, i) => `v${i}`), {}, "videoUrls");
  assert.equal(fifty.length, 10);
  // 51 videos → capped to 50 → still exactly 10 groups (never an 11th ad group of one).
  const overflow = chunkVideosIntoAdGroups(Array.from({ length: 51 }, (_, i) => `v${i}`), {}, "videoUrls");
  assert.equal(overflow.length, 10);
  assert.equal(overflow.reduce((n, g) => n + g.videoUrls.length, 0), 50);
});

test("chunkVideosIntoAdGroups duplicates the template and honours the source key", () => {
  const tpl = { headlines: "H1 | H2", callToAction: "LEARN_MORE", logoUrl: "https://x/l.png" };
  // youtubeUrls key: each group carries the chunk under youtubeUrls, videoUrls stays [].
  const yt = chunkVideosIntoAdGroups(["a", "b", "c", "d", "e", "f"], tpl, "youtubeUrls");
  assert.equal(yt.length, 2);
  for (const g of yt) {
    assert.equal(g.headlines, "H1 | H2");
    assert.equal(g.callToAction, "LEARN_MORE");
    assert.equal(g.logoUrl, "https://x/l.png");
    assert.deepEqual(g.videoUrls, []);
  }
  assert.deepEqual(yt[1].youtubeUrls, ["f"]);
  // videoUrls key: mirror image — the chunk lands under videoUrls, youtubeUrls stays [].
  const up = chunkVideosIntoAdGroups(["a", "b"], tpl, "videoUrls");
  assert.deepEqual(up[0].videoUrls, ["a", "b"]);
  assert.deepEqual(up[0].youtubeUrls, []);
});

// ---- googleOfferFromLanding: the offer word LION derives from the landing's registrable domain --

test("googleOfferFromLanding upper-cases the second-level domain, '' for a non-URL", () => {
  assert.equal(googleOfferFromLanding("https://corquieu.com/r/x/"), "CORQUIEU");
  assert.equal(googleOfferFromLanding("https://www.c5concepts.com/r/curso/"), "C5CONCEPTS");
  assert.equal(googleOfferFromLanding("nope"), "");
});

// ---- googleNameHeadPreview: the read-only campaign-name PREFIX the card shows (muted) ----------

test("googleNameHeadPreview builds LION's exact head from account/acr/geo/landing", () => {
  assert.equal(
    googleNameHeadPreview({ accountName: "GLO-HS-001", acr: "glo-01", geo: ["BE", "CA"], landing: "https://corquieu.com/r/x/" }),
    "{HS-____} GLO-HS-001 - (GLO-01) #ADX [HIGH] - DEMANDA (YTB) - BE+CA - CORQUIEU DIRETO",
  );
  // Worldwide / empty geo both render "WW".
  assert.match(googleNameHeadPreview({ accountName: "GLO-HS-001", acr: "glo-01", geo: ["WW"], landing: "https://corquieu.com/r/x/" }), / - WW - /);
  assert.match(googleNameHeadPreview({ accountName: "GLO-HS-001", acr: "glo-01", geo: [], landing: "https://corquieu.com/r/x/" }), / - WW - /);
  // Missing account / landing degrade to the <account> / <offer> placeholders (never crash).
  assert.equal(
    googleNameHeadPreview({ accountName: "", acr: "glo-01", geo: ["WW"], landing: "nope" }),
    "{HS-____} <account> - (GLO-01) #ADX [HIGH] - DEMANDA (YTB) - WW - <offer> DIRETO",
  );
});

// ---- googleLaunchWire: MULTIPLE ad groups per shot (the repeatable "AD GROUP N" block) ---------

test("googleLaunchWire fans two ad groups onto ads[] with each group's own video source", () => {
  const adYoutube: GoogleLaunchAdIn = {
    headlines: ["Discover today's rates"],
    longHeadlines: ["Compare auto financing options in minutes"],
    descriptions: ["Fast, simple and free to check"],
    callToAction: "LEARN_MORE",
    logoUrl: "https://assets.example.com/logo.png",
    youtubeUrls: ["https://youtu.be/abcdef"],
    videoUrls: [],
    channelId: "",
  };
  const adUpload: GoogleLaunchAdIn = {
    headlines: ["Rates that fit your budget"],
    longHeadlines: ["See personalised auto financing offers today"],
    descriptions: ["No impact to your credit score"],
    callToAction: "",
    logoUrl: "https://assets.example.com/logo2.png",
    youtubeUrls: [],
    videoUrls: ["https://example.com/v.mp4"],
    channelId: "UC-smoke-channel",
  };
  const shot: GoogleLaunchShotIn = {
    customer: "5378080027",
    budget: "30,00",
    bidStrategy: "target_cpa",
    bid: "3,95",
    suffix: "two-groups",
    landingUrl: "https://corquieu.com/r/x/",
    geo: ["BE", "CA"],
    language: "en",
    mosh: false,
    ads: [adYoutube, adUpload],
  };
  const built = googleLaunchWire(shot, { customerId: "5378080027", pixel: "", nameSuffix: "14.09 nazar GC-Launcher" });
  assert.ok(!("refusal" in built), "refusal" in built ? built.refusal : "");
  if ("refusal" in built) return;
  assert.equal(built.wire.ads.length, 2);
  // Ad group 1 rides its YouTube link; ad group 2 rides its uploaded https video + channel id.
  assert.deepEqual(built.wire.ads[0].youtube_urls, ["https://youtu.be/abcdef"]);
  assert.equal(built.wire.ads[0].video_urls, undefined);
  assert.equal(built.wire.ads[0].call_to_action, "LEARN_MORE");
  assert.deepEqual(built.wire.ads[1].video_urls, ["https://example.com/v.mp4"]);
  assert.equal(built.wire.ads[1].youtube_urls, undefined);
  assert.equal(built.wire.ads[1].channel_id, "UC-smoke-channel");
  // Automatic CTA on group 2 rides as an ABSENT call_to_action (Google picks).
  assert.equal(built.wire.ads[1].call_to_action, undefined);
});

test("googleLaunchWire names the offending ad group when a later group is short a video", () => {
  const good: GoogleLaunchAdIn = {
    headlines: ["H1"],
    longHeadlines: ["Long one"],
    descriptions: ["Desc one"],
    logoUrl: "https://assets.example.com/logo.png",
    youtubeUrls: ["https://youtu.be/abcdef"],
    videoUrls: [],
  };
  const missingVideo: GoogleLaunchAdIn = {
    headlines: ["H2"],
    longHeadlines: ["Long two"],
    descriptions: ["Desc two"],
    logoUrl: "https://assets.example.com/logo2.png",
    youtubeUrls: [],
    videoUrls: [],
  };
  const shot: GoogleLaunchShotIn = {
    customer: "5378080027",
    budget: "30,00",
    bidStrategy: "target_cpa",
    bid: "3,95",
    suffix: "bad-group",
    landingUrl: "https://corquieu.com/r/x/",
    geo: ["WW"],
    ads: [good, missingVideo],
  };
  const built = googleLaunchWire(shot, { customerId: "5378080027", nameSuffix: "s" });
  assert.ok("refusal" in built);
  if ("refusal" in built) assert.match(built.refusal, /ad group 2/);
});
