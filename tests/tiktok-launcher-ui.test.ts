// Node's built-in runner (v24 strips types natively): `node --test tests/tiktok-launcher-ui.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// TikTok rail — what the LAUNCHER card binds to: the card → shot mapping (Smart+ fields ride only
// while the switch is on), the line codecs, the copies clamp, the geo presets and the CTA list.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TIKTOK_CTAS,
  TIKTOK_GEO_PRESETS,
  TIKTOK_MAX_COPIES,
  splitTextLines,
  splitUrlLines,
  tiktokCopies,
  tiktokDraftShot,
  tiktokLaunchWire,
  type TiktokCardDraft,
} from "../lib/tiktok-launch.ts";

const DRAFT: TiktokCardDraft = {
  advertiser: "7681271094669852680",
  pixel: "",
  mode: "NORMAL_WITH_BID",
  budget: "20,00",
  bid: " 0,46 ",
  suffix: "  CREO  ",
  landingUrl: " https://guide-choice.com/ht/x/ ",
  identityName: "Daily Trends",
  identityImageUrl: "https://pending.local/identity.png",
  title: "Hello",
  callToAction: "LEARN_MORE",
  videoUrls: ["https://pending.local/1.mp4"],
  countries: ["US"],
  language: "",
  mosh: false,
  smartPlus: false,
  budgetLevel: "campaign",
  extraTexts: "Second\n\n  Third   one \n",
  extraCtas: ["SHOP_NOW"],
};

test("a classic card never carries Smart+ leftovers — a hidden panel can't refuse the launch", () => {
  const shot = tiktokDraftShot(DRAFT);
  assert.equal(shot.smartPlus, undefined);
  assert.equal(shot.budgetLevel, undefined);
  assert.equal(shot.adTexts, undefined);
  assert.equal(shot.callToActions, undefined);
  assert.equal(shot.pixel, undefined);
  assert.equal(shot.language, undefined);
  assert.equal(shot.bid, "0,46");
  assert.equal(shot.suffix, "CREO");
  assert.equal(shot.landingUrl, "https://guide-choice.com/ht/x/");
  const built = tiktokLaunchWire(shot, { advertiserId: DRAFT.advertiser, pixelCode: "PX", nameSuffix: "s" });
  assert.ok(!("refusal" in built), "refusal" in built ? built.refusal : "");
});

test("a Smart+ card carries its level, the extra texts (one per line) and the extra CTAs", () => {
  const shot = tiktokDraftShot({ ...DRAFT, smartPlus: true, budgetLevel: "", pixel: "PX", language: "en", mosh: true });
  assert.equal(shot.smartPlus, true);
  assert.equal(shot.budgetLevel, "adgroup");
  assert.deepEqual(shot.adTexts, ["Second", "Third one"]);
  assert.deepEqual(shot.callToActions, ["SHOP_NOW"]);
  assert.equal(shot.pixel, "PX");
  assert.equal(shot.language, "en");
  assert.equal(shot.mosh, true);
  const built = tiktokLaunchWire(shot, { advertiserId: DRAFT.advertiser, pixelCode: "PX", nameSuffix: "s" });
  assert.ok(!("refusal" in built));
  assert.deepEqual(built.wire.creative_data.ad_texts, ["Hello", "Second", "Third one"]);
});

test("line codecs", () => {
  assert.deepEqual(splitTextLines(" a \r\n\r\n b   c \n"), ["a", "b c"]);
  assert.deepEqual(splitTextLines(""), []);
  assert.deepEqual(splitUrlLines("https://a/1.mp4\nhttps://a/2.mp4, https://a/1.mp4  https://a/3.mp4"), ["https://a/1.mp4", "https://a/2.mp4", "https://a/3.mp4"]);
});

test("copies clamp to 1…10", () => {
  assert.equal(TIKTOK_MAX_COPIES, 10);
  assert.equal(tiktokCopies("3"), 3);
  assert.equal(tiktokCopies(""), 1);
  assert.equal(tiktokCopies("0"), 1);
  assert.equal(tiktokCopies("99"), 10);
  assert.equal(tiktokCopies("abc"), 1);
  assert.equal(tiktokCopies(2.6), 3);
});

test("launcher texture: geo presets and the CTA list lead with what the partner documents", () => {
  assert.deepEqual(TIKTOK_GEO_PRESETS.map((p) => p.label), ["World", "LATAM", "Anglo", "Franco"]);
  assert.deepEqual(TIKTOK_GEO_PRESETS[0].codes, ["WW"]);
  assert.deepEqual(TIKTOK_CTAS.slice(0, 4).map((c) => c.value), ["LEARN_MORE", "SHOP_NOW", "SIGN_UP", "DOWNLOAD_NOW"]);
  assert.equal(new Set(TIKTOK_CTAS.map((c) => c.value)).size, TIKTOK_CTAS.length);
});
