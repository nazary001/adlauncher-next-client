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
  isGoogleLaunchAccount,
  GOOGLE_ACTIVE_LAUNCH_ACCOUNTS,
  GOOGLE_AD_GROUPS_MAX,
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
  googleAdGroupsAtLaunch,
  googleStructureLabel,
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

// ---- structure: "1-1-5" (videos together) vs "1-5-5" (an ad group per video) — owner ask 21.09 --

const FIVE = ["a", "b", "c", "d", "e"].map((x) => `https://youtu.be/vid${x}00000`);
const structureShot = (ads: GoogleLaunchAdIn[], adGroupPerVideo?: boolean): GoogleLaunchShotIn => ({
  customer: "1633475800",
  budget: "30,00",
  bidStrategy: "target_cpa",
  bid: "3,95",
  suffix: "structure",
  landingUrl: "https://corquieu.com/r/x/",
  geo: ["WW"],
  ads,
  ...(adGroupPerVideo === undefined ? {} : { adGroupPerVideo }),
});
const structureAd = (over: Partial<GoogleLaunchAdIn> = {}): GoogleLaunchAdIn => ({
  headlines: ["H1", "H2"],
  longHeadlines: ["Long one"],
  descriptions: ["Desc one"],
  callToAction: "SIGN_UP",
  logoUrl: "https://assets.example.com/logo.png",
  youtubeUrls: FIVE,
  videoUrls: [],
  ...over,
});

test("googleLaunchWire keeps five videos in ONE ad group by default (1-1-5)", () => {
  for (const flag of [undefined, false]) {
    const built = googleLaunchWire(structureShot([structureAd()], flag), { customerId: "1633475800", nameSuffix: "s" });
    assert.ok(!("refusal" in built), "refusal" in built ? built.refusal : "");
    if ("refusal" in built) return;
    assert.equal(built.wire.ads.length, 1);
    assert.deepEqual(built.wire.ads[0].youtube_urls, FIVE);
    assert.equal("adGroupPerVideo" in built.wire, false); // our switch never rides to the partner
  }
});

test("googleLaunchWire gives every video its OWN ad group with the same copy/CTA/logo (1-5-5)", () => {
  const built = googleLaunchWire(structureShot([structureAd()], true), { customerId: "1633475800", nameSuffix: "s" });
  assert.ok(!("refusal" in built), "refusal" in built ? built.refusal : "");
  if ("refusal" in built) return;
  assert.equal(built.wire.ads.length, 5);
  built.wire.ads.forEach((ad, i) => {
    assert.deepEqual(ad.youtube_urls, [FIVE[i]]); // one video each, order kept
    assert.equal(ad.video_urls, undefined);
    assert.deepEqual(ad.headlines, ["H1", "H2"]);
    assert.deepEqual(ad.long_headlines, ["Long one"]);
    assert.deepEqual(ad.descriptions, ["Desc one"]);
    assert.equal(ad.call_to_action, "SIGN_UP");
    assert.equal(ad.logo_url, "https://assets.example.com/logo.png");
  });
  assert.notEqual(built.wire.ads[0].headlines, built.wire.ads[1].headlines); // no shared arrays
  assert.equal("adGroupPerVideo" in built.wire, false);
});

test("googleLaunchWire per-video split: uploaded videos keep their channel id, several groups split in order", () => {
  const uploads = ["https://blob.example.com/v0.mp4", "https://blob.example.com/v1.mp4"];
  const upload = structureAd({ headlines: ["Upload copy"], youtubeUrls: [], videoUrls: uploads, channelId: "UC-chan" });
  const built = googleLaunchWire(structureShot([structureAd({ youtubeUrls: FIVE.slice(0, 3) }), upload], true), { customerId: "1633475800", nameSuffix: "s" });
  assert.ok(!("refusal" in built), "refusal" in built ? built.refusal : "");
  if ("refusal" in built) return;
  assert.equal(built.wire.ads.length, 5); // 3 + 2
  assert.deepEqual(built.wire.ads.slice(0, 3).map((a) => a.youtube_urls?.[0]), FIVE.slice(0, 3));
  for (const [i, ad] of built.wire.ads.slice(3).entries()) {
    assert.deepEqual(ad.video_urls, [uploads[i]]);
    assert.equal(ad.youtube_urls, undefined);
    assert.equal(ad.channel_id, "UC-chan");
    assert.deepEqual(ad.headlines, ["Upload copy"]);
  }
});

test("googleLaunchWire per-video split: a refusal still names the CARD's ad group, a truthy non-boolean is not the switch, the fan-out is capped", () => {
  const noVideo = structureAd({ youtubeUrls: [] });
  const refused = googleLaunchWire(structureShot([structureAd(), noVideo], true), { customerId: "1633475800", nameSuffix: "s" });
  assert.ok("refusal" in refused);
  if ("refusal" in refused) assert.match(refused.refusal, /ad group 2/);

  const sloppy = googleLaunchWire({ ...structureShot([structureAd()]), adGroupPerVideo: "false" as unknown as boolean }, { customerId: "1633475800", nameSuffix: "s" });
  assert.ok(!("refusal" in sloppy));
  if (!("refusal" in sloppy)) assert.equal(sloppy.wire.ads.length, 1);

  // 10 groups × 5 videos = 50 launch ad groups (the ceiling) — fine; an 11th group tips it over.
  const ten = Array.from({ length: 10 }, () => structureAd());
  const atCap = googleLaunchWire(structureShot(ten, true), { customerId: "1633475800", nameSuffix: "s" });
  assert.ok(!("refusal" in atCap));
  if (!("refusal" in atCap)) assert.equal(atCap.wire.ads.length, GOOGLE_AD_GROUPS_MAX);
  const over = googleLaunchWire(structureShot([...ten, structureAd({ youtubeUrls: FIVE.slice(0, 1) })], true), { customerId: "1633475800", nameSuffix: "s" });
  assert.ok("refusal" in over);
  if ("refusal" in over) assert.match(over.refusal, /At most 50 ad groups per campaign — this one would launch 51 \(one per video\)/);
  // The same 11 groups launch fine together (11 ad groups).
  const together = googleLaunchWire(structureShot([...ten, structureAd({ youtubeUrls: FIVE.slice(0, 1) })]), { customerId: "1633475800", nameSuffix: "s" });
  assert.ok(!("refusal" in together));
});

test("googleAdGroupsAtLaunch / googleStructureLabel speak the buyers' campaigns-ad groups-videos shorthand", () => {
  assert.equal(googleAdGroupsAtLaunch([5], false), 1);
  assert.equal(googleAdGroupsAtLaunch([5], true), 5);
  assert.equal(googleAdGroupsAtLaunch([5, 3], false), 2);
  assert.equal(googleAdGroupsAtLaunch([5, 3], true), 8);
  assert.equal(googleAdGroupsAtLaunch([5, 0], true), 6); // a video-less group still counts as the one it is
  assert.equal(googleStructureLabel([5], false), "1-1-5");
  assert.equal(googleStructureLabel([5], true), "1-5-5");
  assert.equal(googleStructureLabel([5, 3], false), "1-2-8");
  assert.equal(googleStructureLabel([5, 3], true), "1-8-8");
  assert.equal(googleStructureLabel([1], false), "1-1-1");
  assert.equal(googleStructureLabel([1], true), "1-1-1");
  // Nothing attached yet → the letter form, so the switch reads as a rule rather than "1-1-0".
  assert.equal(googleStructureLabel([0], false), "1-1-N");
  assert.equal(googleStructureLabel([0], true), "1-N-N");
  assert.equal(googleStructureLabel([0, 0], false), "1-2-N");
});

// ---- isGoogleLaunchAccount: the active GLO-HS list (owner list 21.09) --------------------------

test("isGoogleLaunchAccount accepts exactly the owner's active GLO-HS list on the LION MCC, and nothing else", () => {
  // Owner list 21.09: 004, 012–017, 019–046 — 35 accounts, shown AND accepted, any spelling.
  const active = [4, ...Array.from({ length: 6 }, (_, i) => 12 + i), ...Array.from({ length: 28 }, (_, i) => 19 + i)].map(
    (n) => `GLO-HS-${String(n).padStart(3, "0")}`,
  );
  assert.equal(active.length, 35);
  assert.deepEqual([...GOOGLE_ACTIVE_LAUNCH_ACCOUNTS].sort(), [...active].sort());
  for (const n of active) assert.equal(isGoogleLaunchAccount({ name: n, mccId: "2678500976" }), true, n);
  assert.equal(isGoogleLaunchAccount({ name: " glo-hs-004 " }), true);
  // Everything else in the GLO-HS book is out of rotation — hidden AND refused.
  for (const n of ["GLO-HS-001", "GLO-HS-002", "GLO-HS-003", "GLO-HS-005", "GLO-HS-006", "GLO-HS-007", "GLO-HS-008", "GLO-HS-009", "GLO-HS-010", "GLO-HS-011", "GLO-HS-018"]) {
    assert.equal(isGoogleLaunchAccount({ name: n, mccId: "2678500976" }), false, n);
  }
  assert.equal(isGoogleLaunchAccount({ name: " glo-hs-003 " }), false);
  assert.equal(isGoogleLaunchAccount({ name: "GLO-HS-047", mccId: "2678500976" }), false); // a new account waits for the owner's word
  assert.equal(isGoogleLaunchAccount({ name: "GC-HS-Lion-BR-1", mccId: "2678500976" }), false);
  assert.equal(isGoogleLaunchAccount({ name: "Ads 1", mccId: "4904785717" }), false);
  assert.equal(isGoogleLaunchAccount({ name: "GC-Vis-2", mccId: "4904785717" }), false);
  assert.equal(isGoogleLaunchAccount({ name: "GLO-HS-004", mccId: "4904785717" }), false); // right name, wrong MCC
  assert.equal(isGoogleLaunchAccount({ name: "" }), false);
});
