// Node's built-in runner (v24 strips types natively): `node --test tests/tiktok-launcher-ui.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// TikTok rail — what the LAUNCHER card binds to. The card mirrors LION's own "Campaign Launcher"
// (owner ask 18.09): ONE Ad Text field that under Smart+ carries up to 5 texts separated by `|`, a
// CTA picker that under Smart+ takes several (the first picked is the main one), a CBO switch next
// to the budget, LION's own CTA list, Autofill copies of card 01.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TIKTOK_CTAS,
  TIKTOK_FIXED_AGE,
  TIKTOK_FIXED_GENDER,
  TIKTOK_MAX_COPIES,
  splitPipes,
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
  adText: "  Main text |  Second   text | Third ",
  ctas: ["LEARN_MORE", "SHOP_NOW"],
  videoUrls: ["https://pending.local/1.mp4"],
  countries: ["US"],
  language: "",
  mosh: false,
  smartPlus: false,
  cbo: true,
};
const built = (d: TiktokCardDraft) => tiktokLaunchWire(tiktokDraftShot(d), { advertiserId: d.advertiser, pixelCode: "PX", nameSuffix: "s" });

test("a classic card sends its Ad Text WHOLE and its first CTA — no Smart+ leftovers can refuse it", () => {
  const shot = tiktokDraftShot(DRAFT);
  assert.equal(shot.title, "Main text | Second text | Third"); // a pipe is just a character here
  assert.equal(shot.callToAction, "LEARN_MORE");
  assert.equal(shot.smartPlus, undefined);
  assert.equal(shot.budgetLevel, undefined);
  assert.equal(shot.adTexts, undefined);
  assert.equal(shot.callToActions, undefined);
  assert.equal(shot.pixel, undefined);
  assert.equal(shot.language, undefined);
  assert.equal(shot.bid, "0,46");
  assert.equal(shot.suffix, "CREO");
  assert.equal(shot.landingUrl, "https://guide-choice.com/ht/x/");
  const w = built(DRAFT);
  assert.ok(!("refusal" in w), "refusal" in w ? w.refusal : "");
  assert.equal(w.wire.campaign_kind, undefined);
});

test("Smart+: the Ad Text splits on `|` (first = main), the CTAs ride in pick order, CBO sets the budget level", () => {
  const shot = tiktokDraftShot({ ...DRAFT, smartPlus: true, pixel: "PX", language: "en", mosh: true });
  assert.equal(shot.title, "Main text");
  assert.deepEqual(shot.adTexts, ["Second text", "Third"]);
  assert.equal(shot.callToAction, "LEARN_MORE");
  assert.deepEqual(shot.callToActions, ["SHOP_NOW"]);
  assert.equal(shot.smartPlus, true);
  assert.equal(shot.budgetLevel, "campaign");
  const w = built({ ...DRAFT, smartPlus: true });
  assert.ok(!("refusal" in w), "refusal" in w ? w.refusal : "");
  assert.deepEqual(w.wire.creative_data.ad_texts, ["Main text", "Second text", "Third"]);
  assert.deepEqual(w.wire.creative_data.call_to_actions, ["LEARN_MORE", "SHOP_NOW"]);
  assert.equal(w.wire.budget_level, "campaign");
  assert.equal(tiktokDraftShot({ ...DRAFT, smartPlus: true, cbo: false }).budgetLevel, "adgroup");
});

test("Smart+ with ONE text and ONE CTA sends no lists; too many of either is refused by the shared validator", () => {
  const one = built({ ...DRAFT, smartPlus: true, adText: "Only text", ctas: ["SIGN_UP"] });
  assert.ok(!("refusal" in one));
  assert.equal(one.wire.creative_data.ad_texts, undefined);
  assert.equal(one.wire.creative_data.call_to_actions, undefined);
  const sixTexts = built({ ...DRAFT, smartPlus: true, adText: "a|b|c|d|e|f" });
  assert.ok("refusal" in sixTexts && /At most 5 ad texts/.test(sixTexts.refusal));
  const fourCtas = built({ ...DRAFT, smartPlus: true, ctas: ["LEARN_MORE", "SHOP_NOW", "SIGN_UP", "APPLY_NOW"] });
  assert.ok("refusal" in fourCtas && /At most 3 calls to action/.test(fourCtas.refusal));
  const none = built({ ...DRAFT, ctas: [] });
  assert.ok("refusal" in none && /Pick a call to action/.test(none.refusal));
});

test("pipe codec", () => {
  assert.deepEqual(splitPipes(" a |  b   c || d "), ["a", "b c", "d"]);
  assert.deepEqual(splitPipes(""), []);
});

test("Autofill copies clamp to 1…20", () => {
  assert.equal(TIKTOK_MAX_COPIES, 20);
  assert.equal(tiktokCopies("3"), 3);
  assert.equal(tiktokCopies(""), 1);
  assert.equal(tiktokCopies("0"), 1);
  assert.equal(tiktokCopies("99"), 20);
  assert.equal(tiktokCopies("abc"), 1);
  assert.equal(tiktokCopies(2.6), 3);
});

test("launcher texture: LION's own CTA list in its order, and the audience its API fixes", () => {
  assert.deepEqual(
    TIKTOK_CTAS.map((c) => c.value),
    ["LEARN_MORE", "APPLY_NOW", "BOOK_NOW", "CALL_NOW", "CONTACT_US", "DOWNLOAD_NOW", "EXPERIENCE_NOW", "GET_QUOTE", "INSTALL_NOW", "INTERESTED", "LISTEN_NOW", "ORDER_NOW", "PLAY_GAME", "PREORDER_NOW", "READ_MORE", "SEND_MESSAGE", "SHOP_NOW", "SIGN_UP", "SUBSCRIBE", "VIEW_NOW", "WATCH_NOW"],
  );
  assert.equal(TIKTOK_FIXED_GENDER, "GENDER_UNLIMITED");
  assert.equal(TIKTOK_FIXED_AGE, "AGE_18_100 (AUTOGEN)");
});
