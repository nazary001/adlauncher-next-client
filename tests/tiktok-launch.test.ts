// Node's built-in runner (v24 strips types natively): `node --test tests/tiktok-launch.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// TikTok rail — the pure decisions: money, the bid plan per kind, naming, locales, the ONE
// fresh-launch validator and the clone / JURO wires (partner docs + live name grammar 18.09).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TIKTOK_CLONE_MODES,
  TIKTOK_LAUNCH_MODES,
  isTiktokLaunchAccount,
  parseTiktokBid,
  parseTiktokRoas,
  tiktokBidPlan,
  tiktokBudgetWire,
  tiktokCloneWire,
  tiktokGeoLabel,
  tiktokJuroWire,
  tiktokLandingBase,
  tiktokLandingSegments,
  tiktokLaunchWire,
  tiktokLocalesWire,
  tiktokModeKind,
  tiktokNameHeadPreview,
  tiktokNamePreview,
  tiktokNameSuffix,
  tiktokShotTaskId,
  tiktokTaskOutcome,
  tiktokTaskStage,
  tiktokWeaponErrorMessage,
  todaySaoPauloDotDDMM,
  type TiktokCloneShotIn,
  type TiktokLaunchShotIn,
  type TiktokResolved,
} from "../lib/tiktok-launch.ts";

const refusalOf = (r: object): string => ("refusal" in r ? String((r as { refusal: string }).refusal) : "");

// ---------- money ----------

test("budget: $20 floor, $10000 ceiling, two places on the wire", () => {
  assert.equal(tiktokBudgetWire("20"), "20.00");
  assert.equal(tiktokBudgetWire("20,5"), "20.50");
  assert.equal(tiktokBudgetWire("300.00"), "300.00");
  assert.equal(tiktokBudgetWire("1,234.56"), "1234.56");
  assert.equal(tiktokBudgetWire("19,99"), null);
  assert.equal(tiktokBudgetWire("10000,01"), null);
  assert.equal(tiktokBudgetWire(""), null);
  assert.equal(tiktokBudgetWire("abc"), null);
});

test("bid and ROAS parsing", () => {
  assert.equal(parseTiktokBid("0,46"), 0.46);
  assert.equal(parseTiktokBid("0.156"), 0.16);
  assert.equal(parseTiktokBid("100"), 100);
  assert.equal(parseTiktokBid("100,01"), null);
  assert.equal(parseTiktokBid("0"), null);
  assert.equal(parseTiktokBid("-1"), null);
  assert.equal(parseTiktokBid(""), null);
  assert.equal(parseTiktokRoas("1,2"), 1.2);
  assert.equal(parseTiktokRoas("0.01"), 0.01);
  assert.equal(parseTiktokRoas("1000"), 1000);
  assert.equal(parseTiktokRoas("1000,5"), null);
  assert.equal(parseTiktokRoas("0"), null);
});

test("mode vocabulary: four launch modes, clone adds WARM_UP", () => {
  assert.deepEqual(TIKTOK_LAUNCH_MODES.map((m) => m.value), ["NORMAL_WITH_BID", "NORMAL_NO_BID", "VO_HIGHEST_VALUE", "VO_MIN_ROAS"]);
  assert.deepEqual(TIKTOK_CLONE_MODES.map((m) => m.value), ["NORMAL_WITH_BID", "NORMAL_NO_BID", "VO_HIGHEST_VALUE", "VO_MIN_ROAS", "WARM_UP"]);
  assert.equal(tiktokModeKind("NORMAL_WITH_BID"), "bid");
  assert.equal(tiktokModeKind("VO_MIN_ROAS"), "roas");
  assert.equal(tiktokModeKind("WARM_UP"), "none");
  assert.equal(tiktokModeKind("nope"), "unknown");
});

// ---------- bid plan ----------

test("launch plan: a mode is required and carries exactly the value it takes", () => {
  assert.match(refusalOf(tiktokBidPlan({ kind: "launch", mode: "", typedBid: "" })), /Pick a mode/);
  assert.match(refusalOf(tiktokBidPlan({ kind: "launch", mode: "WARM_UP", typedBid: "" })), /Warm-up is a clone-only mode/);
  assert.match(refusalOf(tiktokBidPlan({ kind: "launch", mode: "BOGUS", typedBid: "" })), /Unknown mode/);
  assert.match(refusalOf(tiktokBidPlan({ kind: "launch", mode: "NORMAL_WITH_BID", typedBid: "" })), /needs a bid/);
  assert.match(refusalOf(tiktokBidPlan({ kind: "launch", mode: "NORMAL_NO_BID", typedBid: "0,3" })), /clear the bid/);
  assert.match(refusalOf(tiktokBidPlan({ kind: "launch", mode: "VO_MIN_ROAS", typedBid: "" })), /needs a ROAS goal/);
  assert.deepEqual(tiktokBidPlan({ kind: "launch", mode: "NORMAL_WITH_BID", typedBid: "0,46", budget: "20,00" }), {
    wireMode: "NORMAL_WITH_BID",
    conversionBidPrice: "0.46",
    bidKind: "bid",
    label: "bid 0,46",
  });
  assert.deepEqual(tiktokBidPlan({ kind: "launch", mode: "VO_MIN_ROAS", typedBid: "1,2" }), { wireMode: "VO_MIN_ROAS", roasBid: "1.20", bidKind: "roas", label: "ROAS 1,2" });
  assert.deepEqual(tiktokBidPlan({ kind: "launch", mode: "NORMAL_NO_BID", typedBid: "" }), { wireMode: "NORMAL_NO_BID", bidKind: "none", label: "auto" });
  assert.deepEqual(tiktokBidPlan({ kind: "launch", mode: "VO_HIGHEST_VALUE", typedBid: "" }), { wireMode: "VO_HIGHEST_VALUE", bidKind: "none", label: "max value" });
});

test("a bid at or above the daily budget reads as a typo and is refused", () => {
  assert.match(refusalOf(tiktokBidPlan({ kind: "launch", mode: "NORMAL_WITH_BID", typedBid: "20", budget: "20,00" })), /below the daily budget/);
  assert.match(refusalOf(tiktokBidPlan({ kind: "clone", mode: "", typedBid: "46", budget: "20,00" })), /below the daily budget/);
});

test("value-optimisation modes ride only on a pixel that lists them", () => {
  const normalOnly = ["NORMAL_WITH_BID", "NORMAL_NO_BID"];
  assert.match(refusalOf(tiktokBidPlan({ kind: "launch", mode: "VO_MIN_ROAS", typedBid: "1,2", supportedModes: normalOnly })), /pixel doesn't support Min ROAS/);
  assert.match(refusalOf(tiktokBidPlan({ kind: "clone", mode: "VO_HIGHEST_VALUE", typedBid: "", supportedModes: normalOnly })), /pixel doesn't support/);
  // NORMAL_* and WARM_UP are always available; an empty list means "unknown", not "nothing".
  assert.ok(!("refusal" in tiktokBidPlan({ kind: "clone", mode: "WARM_UP", typedBid: "", supportedModes: normalOnly })));
  assert.ok(!("refusal" in tiktokBidPlan({ kind: "launch", mode: "VO_MIN_ROAS", typedBid: "1,2", supportedModes: [] })));
});

test("clone plan: inherit carries a typed bid as conversion_bid_price; WARM_UP takes nothing", () => {
  assert.deepEqual(tiktokBidPlan({ kind: "clone", mode: "", typedBid: "" }), { bidKind: "unknown", label: "inherit" });
  assert.deepEqual(tiktokBidPlan({ kind: "clone", mode: "", typedBid: "0,5" }), { conversionBidPrice: "0.50", bidKind: "unknown", label: "bid 0,5" });
  assert.deepEqual(tiktokBidPlan({ kind: "clone", mode: "WARM_UP", typedBid: "" }), { wireMode: "WARM_UP", bidKind: "none", label: "warm-up" });
  assert.match(refusalOf(tiktokBidPlan({ kind: "clone", mode: "WARM_UP", typedBid: "0,5" })), /clear the bid/);
  assert.match(refusalOf(tiktokBidPlan({ kind: "clone", mode: "", typedBid: "x" })), /positive number/);
});

test("JURO plan: the source's mode is fixed; the bid is optional", () => {
  assert.match(refusalOf(tiktokBidPlan({ kind: "juro", mode: "NORMAL_NO_BID", typedBid: "" })), /JURO keeps the source's mode/);
  assert.deepEqual(tiktokBidPlan({ kind: "juro", mode: "", typedBid: "" }), { bidKind: "unknown", label: "inherit" });
  assert.deepEqual(tiktokBidPlan({ kind: "juro", mode: "", typedBid: "0,46" }), { conversionBidPrice: "0.46", bidKind: "unknown", label: "bid 0,46" });
});

// ---------- naming ----------

test("suffix follows the team pattern and carries the console mark", () => {
  assert.equal(tiktokNameSuffix({ user: "Nazar", ddmm: "18.09" }), "18.09 - Nazar - GC-Launcher");
  assert.equal(tiktokNameSuffix({ user: "Nazar", ddmm: "18.09", tail: "  CREO   APRUV " }), "18.09 - Nazar - GC-Launcher - CREO APRUV");
  assert.equal(tiktokNameSuffix({ user: "", ddmm: "18.09" }), "18.09 - buyer - GC-Launcher");
  // A pipe in the tail would fake a LION segment.
  assert.equal(tiktokNameSuffix({ user: "N", ddmm: "18.09", tail: "a | b" }), "18.09 - N - GC-Launcher - a / b");
  const long = tiktokNameSuffix({ user: "Nazar", ddmm: "18.09", tail: "x".repeat(200) });
  assert.equal(long.length, 80);
  assert.ok(long.startsWith("18.09 - Nazar - GC-Launcher - xxx"));
});

test("São Paulo date rolls over at São Paulo midnight, not UTC", () => {
  assert.equal(todaySaoPauloDotDDMM(new Date("2026-09-18T02:30:00Z")), "17.09");
  assert.equal(todaySaoPauloDotDDMM(new Date("2026-09-18T03:30:00Z")), "18.09");
});

test("landing: bare https base, query and hash dropped", () => {
  assert.deepEqual(tiktokLandingBase("https://guide-choice.com/ht/age-gate/cars/en/?utm_source=x#top"), {
    base: "https://guide-choice.com/ht/age-gate/cars/en/",
    host: "guide-choice.com",
    path: "ht/age-gate/cars/en/",
    strippedQuery: true,
  });
  assert.equal(tiktokLandingBase("https://guide-choice.com/ht/x/")?.strippedQuery, false);
  assert.equal(tiktokLandingBase("http://guide-choice.com/ht/x/"), null);
  assert.equal(tiktokLandingBase("https://localhost/x"), null);
  assert.equal(tiktokLandingBase("not a url"), null);
  assert.equal(tiktokLandingBase(""), null);
});

test("head preview mirrors LION's grammar", () => {
  assert.equal(
    tiktokNameHeadPreview({ acr: "glo-01", countries: ["us", "CA"], language: "en", landing: "https://choice-flow.org/ht/clothes/en/" }),
    "{HS-____} (GLO-01) [cl|US,CA|EN] (ht/clothes/en/)",
  );
  assert.equal(tiktokNameHeadPreview({ countries: ["WW"], language: "pt", landing: "" }), "{HS-____} (GLO-01) [cl|WW|PT] (<landing>)");
  assert.equal(tiktokNameHeadPreview({ countries: ["PL"], landing: "https://a.org/ht/cars/en/" }), "{HS-____} (GLO-01) [cl|PL|ALL] (ht/cars/en/)");
});

test("full name preview: source marker inside the head, Smart+ tag before our suffix", () => {
  const head = "{HS-____} (GLO-01) [cl|US|EN] (ht/x/)";
  assert.equal(tiktokNamePreview({ head, suffix: "18.09 - N - GC-Launcher", kind: "launch" }), `${head} | 18.09 - N - GC-Launcher`);
  assert.equal(tiktokNamePreview({ head, suffix: "s", kind: "launch", smartPlus: "campaign" }), `${head} | Smart+ CBO | s`);
  assert.equal(tiktokNamePreview({ head, suffix: "s", kind: "launch", smartPlus: "adgroup" }), `${head} | Smart+ | s`);
  assert.equal(tiktokNamePreview({ head, suffix: "s", kind: "clone", sourceId: "1876" }), `${head} (CLONE_FROM=1876) | s`);
  assert.equal(tiktokNamePreview({ head, suffix: "s", kind: "juro", sourceId: "1876" }), `${head} (JURO_FROM=1876) | s`);
});

test("link preview: bare landing + LION's TikTok tracking tail", () => {
  const segs = tiktokLandingSegments("https://guide-choice.com/ht/x/?a=1", { acr: "GLO-01", pixel: "CGUJ" });
  assert.equal(segs[0].text, "https://guide-choice.com/ht/x/");
  assert.equal(segs[0].role, "slug");
  const all = segs.map((s) => s.text).join("");
  assert.match(all, /\?utm_source=tiktok&utm_campaign=__CAMPAIGN_ID__/);
  assert.match(all, /&mb=glo-01&pixel=CGUJ&cl=NN&event=Purchase/);
  assert.deepEqual(tiktokLandingSegments("nope"), []);
});

test("geo label for the monitor column", () => {
  assert.equal(tiktokGeoLabel(["us", "CA", "US"]), "US+CA");
  assert.equal(tiktokGeoLabel(["WW"]), "WW");
  assert.equal(tiktokGeoLabel([]), "");
});

// ---------- locales ----------

const CFG = { countries: ["US", "CA", "PL"], languages: ["en", "pt", "zh-Hant"] };

test("locales: WW is exclusive and needs a language; codes come from the advertiser config", () => {
  assert.deepEqual(tiktokLocalesWire(["us", " ca ", "US"], "EN", CFG), { locales: { countries: ["US", "CA"], language: "en" } });
  assert.deepEqual(tiktokLocalesWire(["PL"], "", CFG), { locales: { countries: ["PL"] } });
  assert.deepEqual(tiktokLocalesWire(["WW"], "zh-hant", CFG), { locales: { countries: ["WW"], language: "zh-Hant" } });
  assert.match(refusalOf(tiktokLocalesWire([], "en", CFG)), /at least one country/);
  assert.match(refusalOf(tiktokLocalesWire(["WW", "US"], "en", CFG)), /cannot be mixed/);
  assert.match(refusalOf(tiktokLocalesWire(["WW"], "", CFG)), /Worldwide needs a language/);
  assert.match(refusalOf(tiktokLocalesWire(["BR"], "en", CFG)), /BR.*not targetable on this advertiser/);
  assert.match(refusalOf(tiktokLocalesWire(["US"], "xx", CFG)), /Language "xx" is not offered/);
  assert.match(refusalOf(tiktokLocalesWire(["USA"], "en")), /Unknown country code/);
  // Without a config the shapes are still checked and the language rides as typed.
  assert.deepEqual(tiktokLocalesWire(["br"], "pt"), { locales: { countries: ["BR"], language: "pt" } });
});

// ---------- the fresh-launch wire ----------

const SHOT: TiktokLaunchShotIn = {
  advertiser: "7000000000000000001",
  mode: "NORMAL_WITH_BID",
  budget: "20,00",
  bid: "0,15",
  suffix: "campaign september",
  landingUrl: "https://choice-flow.org/ht/clothes/en/?utm=1",
  identityName: "Daily Trends",
  identityImageUrl: "https://cdn.example.com/identity.png",
  title: "Discover today's latest trends",
  callToAction: "LEARN_MORE",
  videoUrls: ["https://cdn.example.com/video-01.mp4"],
  countries: ["US", "CA"],
  language: "en",
};
const RES: TiktokResolved = { advertiserId: "7000000000000000001", pixelCode: "EXAMPLEPIXELCODE0001", nameSuffix: "18.09 - Nazar - GC-Launcher - campaign september", clientReference: "ttl-w-01" };
const wireOf = (over: Partial<TiktokLaunchShotIn> = {}, res: Partial<TiktokResolved> = {}) => tiktokLaunchWire({ ...SHOT, ...over }, { ...RES, ...res });

test("launch wire: the documented body, nothing else", () => {
  const built = wireOf();
  assert.ok(!("refusal" in built));
  assert.deepEqual(built.wire, {
    advertiser_id: "7000000000000000001",
    mode: "NORMAL_WITH_BID",
    budget: "20.00",
    conversion_bid_price: "0.15",
    pixel_code: "EXAMPLEPIXELCODE0001",
    name_suffix: "18.09 - Nazar - GC-Launcher - campaign september",
    landing_page_url: "https://choice-flow.org/ht/clothes/en/",
    identity: { name: "Daily Trends", image_url: "https://cdn.example.com/identity.png" },
    creative_data: { title: "Discover today's latest trends", call_to_action: "LEARN_MORE", video_urls: ["https://cdn.example.com/video-01.mp4"] },
    locales: { countries: ["US", "CA"], language: "en" },
    client_reference: "ttl-w-01",
  });
  assert.equal(built.label, "bid 0,15");
  const json = JSON.stringify(built.wire);
  assert.ok(!json.includes("targeting"));
  assert.ok(!json.includes("postback_url"));
  assert.ok(!json.includes("mosh")); // default false is simply omitted
});

test("launch wire: ROAS mode, MOSH and Smart+ extras", () => {
  const built = wireOf({
    mode: "VO_MIN_ROAS",
    bid: "1,2",
    mosh: true,
    smartPlus: true,
    budgetLevel: "campaign",
    adTexts: ["Second text", " Third   text "],
    callToActions: ["SHOP_NOW"],
  });
  assert.ok(!("refusal" in built));
  assert.equal(built.wire.roas_bid, "1.20");
  assert.equal(built.wire.conversion_bid_price, undefined);
  assert.equal(built.wire.mosh, true);
  assert.equal(built.wire.campaign_kind, "smart_plus");
  assert.equal(built.wire.budget_level, "campaign");
  assert.deepEqual(built.wire.creative_data.ad_texts, ["Discover today's latest trends", "Second text", "Third text"]);
  assert.deepEqual(built.wire.creative_data.call_to_actions, ["LEARN_MORE", "SHOP_NOW"]);
  // Smart+ with no extras sends no lists — `title` / `call_to_action` are the only ones.
  const bare = wireOf({ smartPlus: true });
  assert.ok(!("refusal" in bare));
  assert.equal(bare.wire.budget_level, "adgroup");
  assert.equal(bare.wire.creative_data.ad_texts, undefined);
  assert.equal(bare.wire.creative_data.call_to_actions, undefined);
});

test("launch wire: every refusal names its fix", () => {
  const cases: Array<[Partial<TiktokLaunchShotIn>, RegExp]> = [
    [{ budget: "19" }, /budget must be between 20 and 10000/i],
    [{ mode: "" }, /Pick a mode/],
    [{ landingUrl: "http://x.com/a" }, /https:\/\/ address/],
    [{ identityName: "  " }, /Identity name is required/],
    [{ identityName: "n".repeat(101) }, /Identity name.*100/],
    [{ identityImageUrl: "" }, /Identity image/],
    [{ identityImageUrl: "http://x/y.png" }, /Identity image/],
    [{ title: "" }, /Ad text is required/],
    [{ title: "t".repeat(101) }, /Ad text is 101 characters.*100/],
    [{ callToAction: "" }, /Pick a call to action/],
    [{ callToAction: "DANCE_NOW" }, /Unknown call to action/],
    [{ videoUrls: [] }, /At least one video/],
    [{ videoUrls: Array.from({ length: 21 }, (_, i) => `https://b/${i}.mp4`) }, /At most 20 videos/],
    [{ videoUrls: ["https://b/1.mp4", "https://b/1.mp4"] }, /listed twice/],
    [{ videoUrls: ["ftp://b/1.mp4"] }, /public https:\/\/ URLs/],
    [{ countries: [] }, /at least one country/],
    [{ adTexts: ["extra"] }, /Smart\+ only/],
    [{ callToActions: ["SHOP_NOW"] }, /Smart\+ only/],
    [{ budgetLevel: "campaign" }, /Smart\+ only/],
    [{ smartPlus: true, budgetLevel: "account" }, /Budget level/],
    [{ smartPlus: true, adTexts: ["a", "b", "c", "d", "e"] }, /At most 5 ad texts/],
    [{ smartPlus: true, adTexts: ["Discover today's latest trends"] }, /Ad texts must differ/],
    [{ smartPlus: true, adTexts: ["x".repeat(101)] }, /over 100 characters/],
    [{ smartPlus: true, callToActions: ["SHOP_NOW", "SIGN_UP", "DOWNLOAD_NOW"] }, /At most 3 calls to action/],
    [{ smartPlus: true, callToActions: ["LEARN_MORE"] }, /Calls to action must differ/],
    [{ smartPlus: true, callToActions: ["NOPE"] }, /Unknown call to action/],
  ];
  for (const [over, re] of cases) {
    const built = wireOf(over);
    assert.match(refusalOf(built), re, `expected ${re} for ${JSON.stringify(over).slice(0, 80)}`);
  }
  assert.match(refusalOf(wireOf({}, { pixelCode: "" })), /pixel/i);
  assert.match(refusalOf(wireOf({}, { advertiserId: "abc" })), /advertiser/i);
  assert.match(refusalOf(wireOf({ countries: ["BR"] }, { config: CFG })), /not targetable/);
  assert.match(refusalOf(wireOf({ mode: "VO_MIN_ROAS", bid: "1" }, { supportedModes: ["NORMAL_WITH_BID", "NORMAL_NO_BID"] })), /pixel doesn't support/);
});

// ---------- clone / JURO wires ----------

const CSHOT: TiktokCloneShotIn = { campaignId: "1900000000000001", budget: "20,00", bid: "0,15", mode: "", suffix: "x" };

test("clone wire: the documented body; an explicit mode drives which value rides", () => {
  const built = tiktokCloneWire(CSHOT, { advertiserId: "7000000000000000001", pixelCode: "PX", nameSuffix: "18.09 - N - GC-Launcher - x" });
  assert.ok(!("refusal" in built));
  assert.deepEqual(built.wire, {
    source_campaign_id: "1900000000000001",
    advertiser_id: "7000000000000000001",
    budget: "20.00",
    pixel_code: "PX",
    conversion_bid_price: "0.15",
    name_suffix: "18.09 - N - GC-Launcher - x",
  });
  const roas = tiktokCloneWire({ ...CSHOT, mode: "VO_MIN_ROAS", bid: "1,5" }, { advertiserId: "7000000000000000001", pixelCode: "PX", nameSuffix: "s" });
  assert.ok(!("refusal" in roas));
  assert.equal(roas.wire.mode, "VO_MIN_ROAS");
  assert.equal(roas.wire.roas_bid, "1.50");
  assert.equal(roas.wire.conversion_bid_price, undefined);
  assert.match(refusalOf(tiktokCloneWire({ ...CSHOT, campaignId: "12" }, { advertiserId: "7000000000000000001", pixelCode: "PX", nameSuffix: "s" })), /campaign id/i);
  assert.match(refusalOf(tiktokCloneWire(CSHOT, { advertiserId: "7000000000000000001", pixelCode: "", nameSuffix: "s" })), /pixel/i);
  assert.match(refusalOf(tiktokCloneWire({ ...CSHOT, budget: "5" }, { advertiserId: "7000000000000000001", pixelCode: "PX", nameSuffix: "s" })), /budget/i);
});

test("JURO wire: no advertiser, no pixel, no mode", () => {
  const built = tiktokJuroWire(CSHOT, { nameSuffix: "18.09 - N - GC-Launcher - x" });
  assert.ok(!("refusal" in built));
  assert.deepEqual(built.wire, { source_campaign_id: "1900000000000001", budget: "20.00", conversion_bid_price: "0.15", name_suffix: "18.09 - N - GC-Launcher - x" });
  const inherit = tiktokJuroWire({ ...CSHOT, bid: "" }, { nameSuffix: "s" });
  assert.ok(!("refusal" in inherit));
  assert.equal(inherit.wire.conversion_bid_price, undefined);
  assert.equal(inherit.label, "inherit");
  assert.match(refusalOf(tiktokJuroWire({ ...CSHOT, mode: "WARM_UP" }, { nameSuffix: "s" })), /JURO keeps/);
});

// ---------- partner sentences, tasks, ids ----------

test("refusal sentences keep the partner's words and its lists", () => {
  assert.equal(tiktokWeaponErrorMessage(400, { error: "budget must be at least 20.00" }), "budget must be at least 20.00");
  assert.equal(
    tiktokWeaponErrorMessage(400, { error: "landing URL not allowed", allowed_domains: ["choice-flow.org", "guide-choice.com"] }),
    "landing URL not allowed · allowed domains: choice-flow.org, guide-choice.com",
  );
  assert.equal(tiktokWeaponErrorMessage(404, { error: "source not in dataset", hint: "call dataset/fetch first" }), "source not in dataset (call dataset/fetch first)");
  assert.equal(tiktokWeaponErrorMessage(400, { message: "bad pixel", available_pixels: ["A", "B"] }), "bad pixel · available pixels: A, B");
  assert.match(tiktokWeaponErrorMessage(403, { error: "Forbidden" }), /advertiser not allowed for the LION user or not launch eligible/);
  assert.equal(tiktokWeaponErrorMessage(502, "<html>bad gateway</html>"), "<html>bad gateway</html>");
  assert.equal(tiktokWeaponErrorMessage(500, null), "tiktok-weapon HTTP 500");
  assert.equal(tiktokWeaponErrorMessage(undefined, null), "tiktok-weapon unreachable");
});

test("task status → stage, and the row disposition of a final task", () => {
  assert.equal(tiktokTaskStage("pending"), "queue");
  assert.equal(tiktokTaskStage("RUNNING"), "lion");
  assert.equal(tiktokTaskStage("completed"), "done");
  assert.equal(tiktokTaskStage("failed"), "failed");
  assert.equal(tiktokTaskStage("weird"), "unknown");
  const base = { campaignId: null, campaignName: null, errorMessage: null, errorStep: null };
  assert.equal(tiktokTaskOutcome({ ...base, status: "pending" }), null);
  assert.equal(tiktokTaskOutcome({ ...base, status: "running" }), null);
  assert.equal(tiktokTaskOutcome({ ...base, status: "completed" }), null); // no campaign id yet → keep waiting
  assert.deepEqual(tiktokTaskOutcome({ ...base, status: "completed", campaignId: "1800", campaignName: "{HS-Ab3k} …" }), {
    status: "done",
    stage: "created",
    campaign_id: "1800",
    name: "{HS-Ab3k} …",
  });
  assert.deepEqual(tiktokTaskOutcome({ ...base, status: "failed", errorStep: "video_upload", errorMessage: "Video too short" }), {
    status: "error",
    stage: "lion",
    error: "video_upload: Video too short",
  });
  assert.deepEqual(tiktokTaskOutcome({ ...base, status: "failed" }), { status: "error", stage: "lion", error: "LION failed the build without a reason — check the task in LION" });
});

test("task ids and the account predicate", () => {
  assert.equal(tiktokShotTaskId("launch", "wave1234", 0), "ttl-wave1234-01");
  assert.equal(tiktokShotTaskId("clone", "wave1234", 9), "ttc-wave1234-10");
  assert.equal(tiktokShotTaskId("juro", "wave1234", 44), "ttj-wave1234-45");
  assert.equal(isTiktokLaunchAccount({ name: "gcxunion 308 (London)", advertiserId: "7501321230599962632", launchEligible: true }), true);
  assert.equal(isTiktokLaunchAccount({ name: "gcxunion 308 (London)", advertiserId: "7501321230599962632", launchEligible: false }), false);
});
