// Node's built-in runner (v24 strips types natively): `node --test tests/av-delivery.test.ts`.
// AV delivery modes (owner ask 30.09): Purchase on the AV site pixel (default) or Traffic / link
// clicks with no pixel — the mapping the card, the locks, the launch route and AV clones share.
// lib/av-delivery imports ./types without an extension (the bundler's resolution) — the hook lets
// the dynamic import below load it straight off disk.
import "./_resolve-hook.ts";
import { test } from "node:test";
import assert from "node:assert/strict";

const { AV_OBJECTIVE, AV_PIXEL, AV_PIXELS, AV_SALES_OBJECTIVE, avAdText, avDelivery, avLockPatch, avPixel, avPixelName } = await import("../lib/av-delivery.ts");
const { makeCampaign } = await import("../lib/types.ts");
const { creativePayload, imageCreativePayload } = await import("../lib/fb-launch.ts");

test("the AV site pixel is the one ActiveView's script fires", () => {
  assert.equal(AV_PIXEL.id, "1830814271425766");
});

test("avDelivery: conversions = Sales / Purchase on the AV pixel; clicks = Traffic, no pixel; anything else reads as Purchase", () => {
  assert.deepEqual(avDelivery("conversions"), { objective: AV_SALES_OBJECTIVE, optimization: "conversions", pixel: AV_PIXEL.id, conversionEvent: "PURCHASE" });
  assert.deepEqual(avDelivery("clicks"), { objective: AV_OBJECTIVE, optimization: "clicks", pixel: "" });
  assert.equal(avDelivery("").optimization, "conversions");
  assert.equal(avDelivery("garbage").pixel, AV_PIXEL.id);
  assert.equal(AV_SALES_OBJECTIVE, "OUTCOME_SALES");
  assert.equal(AV_OBJECTIVE, "OUTCOME_TRAFFIC");
});

test("avLockPatch: a fresh card (makeCampaign) converges to Purchase on the AV pixel", () => {
  const c = makeCampaign("c1");
  const patch = avLockPatch(c);
  assert.deepEqual(patch, { pixel: AV_PIXEL.id }); // makeCampaign is already Sales / conversions / PURCHASE
  assert.deepEqual(avLockPatch({ ...c, ...patch }), {}); // idempotent
});

test("avLockPatch: a link-click card drops objective to Traffic and clears the pixel", () => {
  const c = { ...makeCampaign("c2"), optimization: "clicks" as const, pixel: AV_PIXEL.id };
  assert.deepEqual(avLockPatch(c), { objective: AV_OBJECTIVE, pixel: "" });
});

test("avLockPatch: a Traffic card switched back to conversions regains Sales, Purchase and the pixel", () => {
  const c = { ...makeCampaign("c3"), objective: AV_OBJECTIVE, optimization: "conversions" as const, pixel: "", conversionEvent: "LEAD" };
  assert.deepEqual(avLockPatch(c), { objective: AV_SALES_OBJECTIVE, pixel: AV_PIXEL.id, conversionEvent: "PURCHASE" });
});

test("avLockPatch: a stray foreign pixel is replaced; min-ROAS snaps to lowest cost in either mode", () => {
  const purchase = { ...makeCampaign("c4"), pixel: "999999999999999", bidStrategy: "LOWEST_COST_WITH_MIN_ROAS", bidCap: "1,20" };
  assert.deepEqual(avLockPatch(purchase), { pixel: AV_PIXEL.id, bidStrategy: "LOWEST_COST_WITHOUT_CAP", bidCap: "" });
  const clicks = { ...makeCampaign("c5"), optimization: "clicks" as const, bidStrategy: "LOWEST_COST_WITH_MIN_ROAS", bidCap: "1,20" };
  assert.deepEqual(avLockPatch(clicks), { objective: AV_OBJECTIVE, bidStrategy: "LOWEST_COST_WITHOUT_CAP", bidCap: "" });
});

// The pixel pick (owner ask 24.11: «По AV партнеру сделай возможность выбора пикселя … в списке чтобы
// название его и айди отображалось» · «S-1 nik pixel 2126539511577664 например вот этот пиксель
// должен быть там»).
const S1 = "2126539511577664";

test("the AV pixels a Purchase card may pick: the AV site pixel first (the default), then S-1 nik pixel — each a name and an id", () => {
  assert.deepEqual(AV_PIXELS, [
    { id: "1830814271425766", name: "AV site pixel" },
    { id: S1, name: "S-1 nik pixel" },
  ]);
  assert.equal(AV_PIXELS[0], AV_PIXEL, "the default is the first of the list");
  assert.equal(new Set(AV_PIXELS.map((p) => p.id)).size, AV_PIXELS.length, "no pixel twice");
  assert.equal(new Set(AV_PIXELS.map((p) => p.name)).size, AV_PIXELS.length, "every pixel has its own name, so the list tells them apart");
  for (const p of AV_PIXELS) {
    assert.match(p.id, /^\d{10,20}$/, `${p.name}: a pixel id as Meta writes it`);
    assert.ok(p.name.trim().length > 0 && p.name.length <= 40);
  }
  assert.deepEqual(avPixel(S1), { id: S1, name: "S-1 nik pixel" });
  assert.deepEqual(avPixel(` ${S1} `), { id: S1, name: "S-1 nik pixel" });
  for (const junk of ["", "999999999999999", "S-1 nik pixel", null, undefined, 0, {}]) assert.equal(avPixel(junk), null, String(junk));
  assert.equal(avPixelName(S1), "S-1 nik pixel");
  assert.equal(avPixelName(AV_PIXEL.id), "AV site pixel");
  assert.equal(avPixelName("999999999999999"), "999999999999999", "a pixel that is none of ours reads as its id");
});

test("avDelivery with a pick: a Purchase card runs on the AV pixel it picked; any other value is the default; link clicks carry none whatever was picked", () => {
  assert.deepEqual(avDelivery("conversions", S1), { objective: AV_SALES_OBJECTIVE, optimization: "conversions", pixel: S1, conversionEvent: "PURCHASE" });
  assert.equal(avDelivery("conversions", AV_PIXEL.id).pixel, AV_PIXEL.id);
  assert.equal(avDelivery("conversions", "").pixel, AV_PIXEL.id, "no pick → the default");
  assert.equal(avDelivery("conversions", undefined).pixel, AV_PIXEL.id);
  assert.equal(avDelivery("conversions", "999999999999999").pixel, AV_PIXEL.id, "a foreign pixel is never optimized on");
  assert.equal(avDelivery("garbage", S1).pixel, S1, "anything but clicks reads as Purchase — the pick holds");
  assert.deepEqual(avDelivery("clicks", S1), { objective: AV_OBJECTIVE, optimization: "clicks", pixel: "" });
});

test("avLockPatch keeps a picked AV pixel: the card is not snapped back to the default, a foreign pixel still is", () => {
  const picked = { ...makeCampaign("p1"), pixel: S1 };
  assert.deepEqual(avLockPatch(picked), {}, "Sales / conversions / PURCHASE on S-1 nik pixel already conforms");
  // the card's own moves: Purchase → clicks → Purchase (avDelivery(next, c.pixel), as the Optimization select patches)
  const toClicks = { ...picked, ...avDelivery("clicks", picked.pixel) };
  assert.equal(toClicks.pixel, "");
  assert.deepEqual(avLockPatch(toClicks), {});
  const back = { ...toClicks, ...avDelivery("conversions", toClicks.pixel) };
  assert.equal(back.pixel, AV_PIXEL.id, "the pick does not survive a trip through link clicks — the default returns");
  assert.deepEqual(avLockPatch(back), {});
  // a card that came from another partner with its pixel
  assert.deepEqual(avLockPatch({ ...makeCampaign("p2"), pixel: "1505591128290736" }), { pixel: AV_PIXEL.id });
  // min-ROAS still snaps, the pick stays
  assert.deepEqual(avLockPatch({ ...picked, bidStrategy: "LOWEST_COST_WITH_MIN_ROAS", bidCap: "1,20" }), { bidStrategy: "LOWEST_COST_WITHOUT_CAP", bidCap: "" });
});

// AV ad text (owner ask 30.09: "для AV поменяй местами … headline должен передаваться как title, а
// title как headline"): on AV the card's Title feeds the ad's HEADLINE and its Headline feeds the slot
// Title feeds on every other rail (the description). Checked through the shared creative builders, so
// the test pins what Meta / TOOL actually receive.
const binds = { accountId: "1219398880126269", pageId: "103944112039841", pageName: "", pixelId: "" };

test("avAdText swaps Title and Headline: the card's Title becomes the ad headline, its Headline the description", () => {
  const c = { ...makeCampaign("t1"), title: "🟢 LEER MÁS →", headline: "TOP JOBS", copy: "body" };
  assert.deepEqual(avAdText(c), { title: "TOP JOBS", headline: "🟢 LEER MÁS →" });
  const av = { ...c, ...avAdText(c) };
  const ld = (imageCreativePayload(av, "ad", binds, { imageHash: "h", link: "https://x.co" }).object_story_spec as { link_data: Record<string, unknown> }).link_data;
  assert.equal(ld.name, "🟢 LEER MÁS →"); // the bold headline under the image
  assert.equal(ld.description, "TOP JOBS");
  assert.equal(ld.message, "body"); // primary text untouched
  const vd = (creativePayload(av, "ad", binds, { videoId: "v", thumbUrl: "t", link: "https://x.co" }).object_story_spec as { video_data: Record<string, unknown> }).video_data;
  assert.equal(vd.title, "🟢 LEER MÁS →");
  assert.equal(vd.link_description, "TOP JOBS");
});

test("avAdText: a card with only a Title (or the same text in both) launches exactly as before", () => {
  const onlyTitle = { ...makeCampaign("t2"), title: "TOP JOBS", headline: "" };
  const ld = (imageCreativePayload({ ...onlyTitle, ...avAdText(onlyTitle) }, "ad", binds, { imageHash: "h", link: "https://x.co" })
    .object_story_spec as { link_data: Record<string, unknown> }).link_data;
  assert.equal(ld.name, "TOP JOBS");
  assert.equal(ld.description, undefined);
  const same = { ...makeCampaign("t3"), title: "Same", headline: "Same" };
  assert.deepEqual(avAdText(same), { title: "Same", headline: "Same" });
});
