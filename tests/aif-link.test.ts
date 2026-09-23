// Node's built-in runner (v24 strips types natively): `node --test tests/aif-link.test.ts`.
// lib/aif-link.ts imports only a TYPE from ./partners (erased), so it loads straight off Node.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AIF_CLIENT_ID, AIF_QUIZ_CLIENT_ID, aifFlowOf, aifLink, aifLinkSegments } from "../lib/aif-link.ts";

const PIXEL = "1363973565348799";

test("RW link = the implementation guide's shape: destination slug, 52105, brand, ppid macro, pixel", () => {
  assert.equal(
    aifLink("rw", "wealth-building-habbits", "test07", PIXEL),
    `https://content.honeyandhues.com/rewarded?destination=wealth-building-habbits&clientId=${AIF_CLIENT_ID}&brand=test07&ppid={{campaign.id}}&pixel=${PIXEL}`,
  );
  assert.equal(AIF_CLIENT_ID, "52105");
});

test("Quiz Flow link = the partner's 23.09 URL + our tracking: slug in the path, layout=qcow, 52149", () => {
  assert.equal(
    aifLink("quiz", "baseball-usa-2026", "test07", PIXEL),
    `https://swiftsearch.co/article/baseball-usa-2026?layout=qcow&clientId=${AIF_QUIZ_CLIENT_ID}&brand=test07&ppid={{campaign.id}}&pixel=${PIXEL}`,
  );
  assert.equal(AIF_QUIZ_CLIENT_ID, "52149");
});

test("click launches carry no pixel; a malformed pixel is dropped, never appended", () => {
  assert.equal(
    aifLink("quiz", "baseball-usa-2026", "test07"),
    "https://swiftsearch.co/article/baseball-usa-2026?layout=qcow&clientId=52149&brand=test07&ppid={{campaign.id}}",
  );
  assert.equal(
    aifLink("rw", "x", "test01", "abc"),
    "https://content.honeyandhues.com/rewarded?destination=x&clientId=52105&brand=test01&ppid={{campaign.id}}",
  );
});

test("no slug → no link (the card shows its placeholder, the route refuses the launch)", () => {
  assert.deepEqual(aifLinkSegments("rw", "", "test01"), []);
  assert.deepEqual(aifLinkSegments("quiz", "", "test01", PIXEL), []);
  assert.equal(aifLink("quiz", "", "test01"), "");
});

test("segments: the brand rides the shared gcm slot, the slug is its own role, the macro stays literal", () => {
  for (const flow of ["rw", "quiz"] as const) {
    const segs = aifLinkSegments(flow, "baseball-usa-2026", "…", PIXEL);
    assert.equal(segs.find((s) => s.role === "gcm")?.text, "…");
    assert.equal(segs.find((s) => s.role === "gcmKey")?.text, "&brand=");
    assert.equal(segs.find((s) => s.role === "slug")?.text, "baseball-usa-2026");
    assert.equal(segs.find((s) => s.role === "pixel")?.text, `&pixel=${PIXEL}`);
    assert.ok(segs.some((s) => s.role === "params" && s.text.includes("{{campaign.id}}")));
    assert.ok(!segs.map((s) => s.text).join("").includes("%7B"), "macro must not be URL-encoded");
    // the joined segments ARE the link — one source of truth for preview and launch
    assert.equal(segs.map((s) => s.text).join(""), aifLink(flow, "baseball-usa-2026", "…", PIXEL));
  }
});

test("the two flows never share a base or a clientId", () => {
  const rw = aifLink("rw", "s", "test01");
  const quiz = aifLink("quiz", "s", "test01");
  assert.ok(rw.startsWith("https://content.honeyandhues.com/rewarded?destination=s&clientId=52105"));
  assert.ok(quiz.startsWith("https://swiftsearch.co/article/s?layout=qcow&clientId=52149"));
  assert.ok(!rw.includes("52149") && !quiz.includes("52105"));
  assert.ok(!quiz.includes("destination="), "the quiz page takes the slug from the path, not destination=");
});

test("flow lookup: the catalog entry decides; unmarked and unknown slugs are RW", () => {
  const cat = [{ slug: "wealth-building-habbits" }, { slug: "baseball-usa-2026", flow: "quiz" as const }];
  assert.equal(aifFlowOf(cat, "baseball-usa-2026"), "quiz");
  assert.equal(aifFlowOf(cat, "wealth-building-habbits"), "rw");
  assert.equal(aifFlowOf(cat, "not-in-catalog"), "rw");
  assert.equal(aifFlowOf([], "baseball-usa-2026"), "rw");
});

test("the clone rail's brand/pixel swaps stay valid on a quiz link (query-generic rewrite)", () => {
  // Twins of lib/clone-run swapBrand/swapPixel (that module drags the Graph client along and is not
  // loadable here) — the SAME regexes, guarding the contract the AIF clone relies on: a brand/pixel
  // swap on a quiz link must yield exactly the quiz link the launcher would have built.
  const swapBrand = (link: string, brand: string) => link.replace(/([?&]brand=)[^&#]*/g, `$1${brand}`);
  const swapPixel = (link: string, id: string) => link.replace(/([?&]pixel=)[^&#]*/g, `$1${id}`);
  const link = aifLink("quiz", "baseball-usa-2026", "test07", PIXEL);
  assert.equal(
    swapPixel(swapBrand(link, "test08"), "4367956310124642"),
    aifLink("quiz", "baseball-usa-2026", "test08", "4367956310124642"),
  );
});
