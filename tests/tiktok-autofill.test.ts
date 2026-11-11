// `node --test tests/tiktok-autofill.test.ts` — the TikTok launcher's "Change all campaigns" (team ask
// 11.11: «такой же автофил как на ФБ … менять гео, ссылку, тег, и остальное во всех компаниях — здесь
// автофил делает только полностью копию компании а не меняет переменные»): what every card becomes
// when the ticked fields of ONE form land on the board, and what Undo puts back.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type TiktokAutofillCard,
  type TiktokAutofillKey,
  TIKTOK_AUTOFILL_KEYS,
  tiktokAutofillCard,
  tiktokAutofillCards,
  tiktokAutofillDraft,
  tiktokAutofillEmpty,
  tiktokAutofillNote,
  tiktokAutofillPatch,
  tiktokAutofillProblem,
  tiktokAutofillTakes,
  undoTiktokAutofill,
} from "../lib/tiktok-autofill.ts";

const file = (id: string, kind: "image" | "video" = "video") => ({ id, name: `${id}.${kind === "video" ? "mp4" : "png"}`, size: 1000, kind, url: `blob:local/${id}` });

const card = (over: Partial<TiktokAutofillCard> = {}): TiktokAutofillCard => ({
  id: "c1",
  advertiser: "7681271094669852680",
  pixel: "",
  budget: "20,00",
  cbo: false,
  mode: "NORMAL_WITH_BID",
  bid: "0,46",
  landingUrl: "https://guide-choice.com/ht/age-gate/cars/en/",
  suffix: "CREO",
  mosh: false,
  smartPlus: false,
  adText: "Main text",
  ctas: ["LEARN_MORE"],
  identityName: "Daily Trends",
  identityFiles: [file("av-1", "image")],
  identityUrl: "",
  videoFiles: [file("v-1"), file("v-2")],
  countries: ["US"],
  language: "en",
  state: "idle",
  msg: undefined,
  progress: undefined,
  ...over,
});

// ---- which cards it reaches ---------------------------------------------------------------------

test("every card that is not on its way out takes the autofill; a card uploading or submitting is skipped", () => {
  assert.equal(tiktokAutofillTakes(card()), true);
  assert.equal(tiktokAutofillTakes(card({ state: "ok" })), true); // a queued card becomes a fresh draft
  assert.equal(tiktokAutofillTakes(card({ state: "error" })), true);
  assert.equal(tiktokAutofillTakes(card({ state: "unsure" })), true); // the fields change, the hold stays
  assert.equal(tiktokAutofillTakes(card({ state: "uploading" })), false);
  assert.equal(tiktokAutofillTakes(card({ state: "sending" })), false);
});

// ---- the ask: geo, link, tag on every campaign --------------------------------------------------

test("geo, landing and name tag land on EVERY card — the three the team asked for", () => {
  const cards = [card({ id: "a" }), card({ id: "b", countries: ["CA", "GB"], landingUrl: "https://fast-flow.org/ht/x/", suffix: "" })];
  const patch = { countries: ["DE", "AT"], landingUrl: "  https://choice-flow.org/ht/age-gate/cars/de/  ", suffix: "DE test" };
  const out = tiktokAutofillCards(cards, patch);
  assert.equal(out.changed, 2);
  assert.equal(out.skipped, 0);
  for (const c of out.cards) {
    assert.deepEqual(c.countries, ["DE", "AT"]);
    assert.equal(c.landingUrl, "https://choice-flow.org/ht/age-gate/cars/de/"); // trimmed like the card's own field
    assert.equal(c.suffix, "DE test");
  }
  assert.notEqual(out.cards[0].countries, patch.countries); // its own array — a later edit can't bleed
  assert.notEqual(out.cards[0].countries, out.cards[1].countries);
  // everything that was not ticked stays as each card had it
  assert.equal(out.cards[0].language, "en");
  assert.equal(out.cards[1].budget, "20,00");
  assert.deepEqual(out.cards[1].videoFiles, cards[1].videoFiles);
});

test("a card that already holds exactly these values is not changed — the SAME object comes back", () => {
  const c = card({ countries: ["DE"], language: "de", suffix: "x" });
  assert.equal(tiktokAutofillCard(c, { countries: ["DE"], language: "de", suffix: "x" }), c);
  const out = tiktokAutofillCards([c, card({ id: "b" })], { countries: ["DE"] });
  assert.equal(out.cards[0], c);
  assert.equal(out.changed, 1);
});

test("language: a code, or \"\" for no language segmentation; an empty tag clears the tag", () => {
  const out = tiktokAutofillCards([card()], { language: "", suffix: "" });
  assert.equal(out.cards[0].language, "");
  assert.equal(out.cards[0].suffix, "");
  assert.equal(out.changed, 1);
});

// ---- account & bidding --------------------------------------------------------------------------

test("budget lands verbatim (the field's cash-register spelling)", () => {
  const out = tiktokAutofillCards([card(), card({ id: "b", budget: "50,00" })], { budget: "35,00" });
  assert.deepEqual(out.cards.map((c) => c.budget), ["35,00", "35,00"]);
});

test("mode + bid land together; a mode that takes no value clears the bid", () => {
  const roas = tiktokAutofillCard(card(), { bidding: { mode: "VO_MIN_ROAS", bid: "1,2" } });
  assert.equal(roas.mode, "VO_MIN_ROAS");
  assert.equal(roas.bid, "1,2");
  const auto = tiktokAutofillCard(card(), { bidding: { mode: "NORMAL_NO_BID", bid: "0,46" } });
  assert.equal(auto.mode, "NORMAL_NO_BID");
  assert.equal(auto.bid, ""); // a leftover bid would be LION's refusal on every card
});

test("advertiser: a NEW advertiser starts with a clean pixel (it is that advertiser's own); a card already on it keeps its pick", () => {
  const other = card({ id: "a", advertiser: "7000000000000000001", pixel: "PIX-OLD" });
  const same = card({ id: "b", advertiser: "7000000000000000002", pixel: "PIX-MINE" });
  const out = tiktokAutofillCards([other, same], { advertiser: { advertiser: "7000000000000000002", pixel: "" } });
  assert.equal(out.cards[0].advertiser, "7000000000000000002");
  assert.equal(out.cards[0].pixel, "");
  assert.equal(out.cards[1], same); // nothing to change
  assert.equal(out.changed, 1);
  // a pixel picked in the form rides to every card
  const picked = tiktokAutofillCards([other, same], { advertiser: { advertiser: "7000000000000000002", pixel: "PIX-B" } });
  assert.deepEqual(picked.cards.map((c) => c.pixel), ["PIX-B", "PIX-B"]);
});

// ---- creative -----------------------------------------------------------------------------------

test("Smart+ off makes every card classic by the card's own rule: no CBO, ONE CTA", () => {
  const smart = card({ smartPlus: true, cbo: true, ctas: ["LEARN_MORE", "SHOP_NOW", "SIGN_UP"] });
  const out = tiktokAutofillCard(smart, { smartPlus: { on: false, cbo: false } });
  assert.equal(out.smartPlus, false);
  assert.equal(out.cbo, false);
  assert.deepEqual(out.ctas, ["LEARN_MORE"]);
});

test("Smart+ on carries CBO; the CTA list respects what each card ends up being", () => {
  const classic = card({ id: "a" });
  const smart = card({ id: "b", smartPlus: true });
  // CTAs alone: the classic card takes the first, the Smart+ card all three
  const ctas = tiktokAutofillCards([classic, smart], { ctas: ["SHOP_NOW", "SIGN_UP", "APPLY_NOW"] });
  assert.deepEqual(ctas.cards[0].ctas, ["SHOP_NOW"]);
  assert.deepEqual(ctas.cards[1].ctas, ["SHOP_NOW", "SIGN_UP", "APPLY_NOW"]);
  // Smart+ on together with the CTAs: both cards are Smart+ now and take them all
  const both = tiktokAutofillCards([classic, smart], { smartPlus: { on: true, cbo: true }, ctas: ["SHOP_NOW", "SIGN_UP"] });
  for (const c of both.cards) {
    assert.equal(c.smartPlus, true);
    assert.equal(c.cbo, true);
    assert.deepEqual(c.ctas, ["SHOP_NOW", "SIGN_UP"]);
  }
  // more than LION takes is cut, never sent
  const cut = tiktokAutofillCard(smart, { ctas: ["LEARN_MORE", "SHOP_NOW", "SIGN_UP", "APPLY_NOW"] });
  assert.equal(cut.ctas.length, 3);
});

test("ad text and MOSH land as typed", () => {
  const out = tiktokAutofillCard(card(), { adText: "New | Second", mosh: true });
  assert.equal(out.adText, "New | Second");
  assert.equal(out.mosh, true);
});

test("identity: name + avatar ride together and the files keep their ids (one upload for the whole board)", () => {
  const avatar = file("av-9", "image");
  const patch = { identity: { name: "Fresh Picks", files: [avatar], url: "" } };
  const out = tiktokAutofillCards([card({ id: "a" }), card({ id: "b", identityFiles: [], identityUrl: "https://cdn.example/keep/old.png" })], patch);
  for (const c of out.cards) {
    assert.equal(c.identityName, "Fresh Picks");
    assert.equal(c.identityFiles[0].id, "av-9");
    assert.notEqual(c.identityFiles[0], avatar); // a fresh object per card
    assert.equal(c.identityUrl, "");
  }
  // a remembered (hosted) avatar replaces a local file
  const hosted = tiktokAutofillCard(card(), { identity: { name: "Fresh Picks", files: [], url: "https://cdn.example/keep/a.png" } });
  assert.deepEqual(hosted.identityFiles, []);
  assert.equal(hosted.identityUrl, "https://cdn.example/keep/a.png");
});

test("identity with no avatar in the form changes the NAME alone — every card keeps its own image", () => {
  const c = card();
  const out = tiktokAutofillCard(c, { identity: { name: "Only The Name", files: [], url: "" } });
  assert.equal(out.identityName, "Only The Name");
  assert.equal(out.identityFiles, c.identityFiles);
  assert.equal(out.identityUrl, "");
});

test("creatives: every card gets the same videos — fresh objects, the same file ids", () => {
  const vids = [file("n-1"), file("n-2"), file("n-3")];
  const out = tiktokAutofillCards([card({ id: "a" }), card({ id: "b", videoFiles: [] })], { videos: vids });
  for (const c of out.cards) {
    assert.deepEqual(c.videoFiles.map((f) => f.id), ["n-1", "n-2", "n-3"]);
    assert.notEqual(c.videoFiles[0], vids[0]);
  }
  // the same videos again is no change
  assert.equal(tiktokAutofillCard(out.cards[0], { videos: vids }), out.cards[0]);
});

// ---- the launch lifecycle -----------------------------------------------------------------------

test("a changed queued / failed card is a fresh draft again; a held card keeps its hold; an untouched queued card stays queued", () => {
  const queued = card({ id: "q", state: "ok", msg: "queued — safe to close the tab", progress: "x" });
  const failed = card({ id: "f", state: "error", msg: "shot 2: refused" });
  const held = card({ id: "h", state: "unsure", msg: "no answer from the server" });
  const same = card({ id: "s", state: "ok", msg: "queued", countries: ["DE"] });
  const out = tiktokAutofillCards([queued, failed, held, same], { countries: ["DE"] });
  assert.equal(out.cards[0].state, "idle");
  assert.equal(out.cards[0].msg, undefined);
  assert.equal(out.cards[0].progress, undefined);
  assert.equal(out.cards[1].state, "idle");
  assert.equal(out.cards[1].msg, undefined);
  assert.equal(out.cards[2].state, "unsure"); // launching it again is exactly what the hold prevents
  assert.equal(out.cards[2].msg, "no answer from the server");
  assert.deepEqual(out.cards[2].countries, ["DE"]);
  assert.equal(out.cards[3], same);
  assert.equal(out.changed, 3);
});

test("cards on their way out are skipped and counted", () => {
  const out = tiktokAutofillCards([card({ id: "a" }), card({ id: "b", state: "sending" }), card({ id: "c", state: "uploading" })], { budget: "30,00" });
  assert.equal(out.changed, 1);
  assert.equal(out.skipped, 2);
  assert.equal(out.cards[1].budget, "20,00");
});

test("\"Apply to\": only the picked cards change — the rest are neither changed nor counted as skipped", () => {
  const cards = [card({ id: "a" }), card({ id: "b" }), card({ id: "c", state: "sending" })];
  const out = tiktokAutofillCards(cards, { countries: ["FR"] }, new Set(["b", "c"]));
  assert.equal(out.cards[0], cards[0]);
  assert.deepEqual(out.cards[1].countries, ["FR"]);
  assert.equal(out.changed, 1);
  assert.equal(out.skipped, 1);
});

// ---- undo ---------------------------------------------------------------------------------------

test("Undo puts back every field and the state of the cards that still exist; cards added since keep theirs", () => {
  const before = [card({ id: "a", state: "ok", msg: "queued" }), card({ id: "b", smartPlus: true, cbo: true, ctas: ["LEARN_MORE", "SHOP_NOW"] })];
  const patch = {
    countries: ["DE"],
    language: "de",
    landingUrl: "https://choice-flow.org/de/",
    suffix: "t",
    budget: "40,00",
    bidding: { mode: "NORMAL_NO_BID", bid: "" },
    advertiser: { advertiser: "7000000000000000009", pixel: "" },
    adText: "x",
    ctas: ["SIGN_UP"],
    identity: { name: "N", files: [file("z", "image")], url: "" },
    videos: [file("zz")],
    smartPlus: { on: false, cbo: false },
    mosh: true,
  };
  const after = tiktokAutofillCards(before, patch).cards;
  const added = card({ id: "new", countries: ["DE"] });
  const undone = undoTiktokAutofill([...after, added], before, patch);
  assert.deepEqual(undone[0], before[0]);
  assert.deepEqual(undone[1], before[1]);
  assert.equal(undone[0].state, "ok"); // exactly the queued content again → queued again
  assert.equal(undone[2], added);
});

test("Undo puts back only what the autofill SET — a field edited by hand since stays, and the card is a draft", () => {
  const before = [card({ id: "a", state: "ok", msg: "queued" })];
  const patch = { countries: ["DE"], suffix: "de" };
  const after = tiktokAutofillCards(before, patch).cards;
  // the buyer fixed the ad text by hand after the autofill, then launched: the card is queued with it
  const edited = [{ ...after[0], adText: "Fixed by hand", state: "ok" as const, msg: "queued (new)" }];
  const undone = undoTiktokAutofill(edited, before, patch);
  assert.deepEqual(undone[0].countries, ["US"]);
  assert.equal(undone[0].suffix, "CREO");
  assert.equal(undone[0].adText, "Fixed by hand"); // not the autofill's to take back
  assert.equal(undone[0].state, "idle"); // this exact content was never queued
  assert.equal(undone[0].msg, undefined);
});

test("Undo leaves a card that is on its way out alone", () => {
  const before = [card({ id: "a" })];
  const after = tiktokAutofillCards(before, { countries: ["DE"] }).cards;
  const sending = [{ ...after[0], state: "sending" as const }];
  assert.equal(undoTiktokAutofill(sending, before, { countries: ["DE"] })[0], sending[0]);
});

test("an Undo neither lifts nor re-imposes a hold", () => {
  const before = [card({ id: "a", state: "idle" }), card({ id: "b", state: "unsure", msg: "held" })];
  const patch = { countries: ["DE"] };
  const after = tiktokAutofillCards(before, patch).cards;
  // card a's wave went unanswered after the autofill → it is held now; card b's hold was resolved
  const now = [{ ...after[0], state: "unsure" as const, msg: "held now" }, { ...after[1], state: "error" as const, msg: "released" }];
  const undone = undoTiktokAutofill(now, before, patch);
  assert.equal(undone[0].state, "unsure");
  assert.equal(undone[0].msg, "held now");
  assert.deepEqual(undone[0].countries, ["US"]);
  assert.equal(undone[1].state, "error");
  assert.equal(undone[1].msg, "released");
});

// ---- the banner note ----------------------------------------------------------------------------

test("the note names what landed, in the form's order", () => {
  assert.equal(tiktokAutofillNote({ suffix: "x", landingUrl: "https://a.b/", countries: ["DE"] }), "countries · landing · name tag");
  assert.equal(tiktokAutofillNote({ bidding: { mode: "NORMAL_WITH_BID", bid: "0,5" }, budget: "20,00" }), "budget · mode + bid");
  assert.equal(tiktokAutofillNote({ bidding: { mode: "NORMAL_NO_BID", bid: "" } }), "mode");
  assert.equal(tiktokAutofillNote({ smartPlus: { on: true, cbo: true }, mosh: false, videos: [file("v")], identity: { name: "n", files: [], url: "" } }), "identity · creatives · Smart+ · MOSH");
  assert.equal(tiktokAutofillNote({ language: "", advertiser: { advertiser: "1", pixel: "" }, adText: "t", ctas: ["LEARN_MORE"] }), "language · advertiser · ad text · CTA");
});

// ---- why the form cannot be applied yet ---------------------------------------------------------

test("nothing ticked is nothing to apply", () => {
  assert.equal(tiktokAutofillEmpty({}), true);
  assert.equal(tiktokAutofillEmpty({ mosh: false }), false);
  assert.equal(tiktokAutofillEmpty({ suffix: "" }), false);
  assert.equal(tiktokAutofillEmpty({ language: "" }), false);
  assert.match(tiktokAutofillProblem({}) ?? "", /Tick at least one field/);
});

test("the form refuses what every card would refuse — with the fix", () => {
  const p = tiktokAutofillProblem;
  assert.equal(p({ countries: ["DE"], landingUrl: "https://choice-flow.org/de/", suffix: "" }), null);
  assert.match(p({ countries: [] }) ?? "", /at least one country/i);
  assert.match(p({ countries: ["WW", "DE"] }) ?? "", /cannot be mixed/i);
  assert.match(p({ countries: ["WW"], language: "" }) ?? "", /Worldwide needs a language/);
  assert.equal(p({ countries: ["WW"], language: "en" }), null);
  assert.equal(p({ countries: ["WW"] }), null); // the cards keep their own language — each one says if it lacks it
  assert.match(p({ landingUrl: "choice-flow.org/de" }) ?? "", /https:\/\//);
  assert.match(p({ landingUrl: "" }) ?? "", /https:\/\//);
  assert.match(p({ budget: "19,99" }) ?? "", /Budget/);
  assert.match(p({ budget: "" }) ?? "", /Budget/);
  assert.equal(p({ budget: "20,00" }), null);
  assert.match(p({ bidding: { mode: "NORMAL_WITH_BID", bid: "" } }) ?? "", /needs a bid/);
  assert.match(p({ bidding: { mode: "VO_MIN_ROAS", bid: "" } }) ?? "", /ROAS goal/);
  assert.equal(p({ bidding: { mode: "NORMAL_NO_BID", bid: "" } }), null);
  assert.match(p({ budget: "20,00", bidding: { mode: "NORMAL_WITH_BID", bid: "25,00" } }) ?? "", /below the daily budget/);
  assert.match(p({ advertiser: { advertiser: "", pixel: "" } }) ?? "", /Pick an advertiser/);
  assert.match(p({ adText: "   " }) ?? "", /ad text/i);
  assert.match(p({ adText: "x".repeat(101) }) ?? "", /at most 100/);
  assert.equal(p({ adText: `${"x".repeat(100)} | ${"y".repeat(100)}` }), null); // Smart+ pieces — each within the cap
  assert.match(p({ ctas: [] }) ?? "", /call to action/i);
  assert.match(p({ identity: { name: " ", files: [], url: "" } }) ?? "", /identity name/i);
  assert.match(p({ videos: [] }) ?? "", /video/i);
});

// ---- the form: a card's values → the draft → the patch of what was ticked ------------------------

test("the form starts from a card's own values and sends ONLY what was ticked", () => {
  const seed = card({ smartPlus: true, cbo: true, ctas: ["LEARN_MORE", "SHOP_NOW"], pixel: "PIX-1" });
  const draft = tiktokAutofillDraft(seed);
  assert.equal(draft.landingUrl, seed.landingUrl);
  assert.deepEqual(draft.countries, ["US"]);
  assert.notEqual(draft.countries, seed.countries); // the form edits its own copy
  const none = tiktokAutofillPatch(draft, new Set());
  assert.deepEqual(none, {});
  const geo = tiktokAutofillPatch({ ...draft, countries: ["DE"], suffix: "tag" }, new Set<TiktokAutofillKey>(["countries", "tag"]));
  assert.deepEqual(geo, { countries: ["DE"], suffix: "tag" });
  const all = tiktokAutofillPatch(draft, new Set(TIKTOK_AUTOFILL_KEYS));
  assert.deepEqual(Object.keys(all).sort(), ["adText", "advertiser", "bidding", "budget", "countries", "ctas", "identity", "landingUrl", "language", "mosh", "smartPlus", "suffix", "videos"]);
  assert.deepEqual(all.advertiser, { advertiser: seed.advertiser, pixel: "PIX-1" });
  assert.deepEqual(all.smartPlus, { on: true, cbo: true });
  assert.equal(all.identity?.files[0].id, "av-1");
  assert.deepEqual(all.videos?.map((f) => f.id), ["v-1", "v-2"]);
});

test("the patch never carries what its own switches rule out: a bid under a no-value mode, CBO without Smart+", () => {
  const draft = tiktokAutofillDraft(card({ mode: "NORMAL_NO_BID", bid: "0,46", smartPlus: false, cbo: true }));
  const patch = tiktokAutofillPatch(draft, new Set<TiktokAutofillKey>(["bidding", "smartPlus"]));
  assert.deepEqual(patch.bidding, { mode: "NORMAL_NO_BID", bid: "" });
  assert.deepEqual(patch.smartPlus, { on: false, cbo: false });
});

test("a board with no card to start from gives an empty form, not a crash", () => {
  const draft = tiktokAutofillDraft(undefined);
  assert.equal(draft.advertiser, "");
  assert.deepEqual(draft.countries, []);
  assert.deepEqual(draft.ctas, []);
});
