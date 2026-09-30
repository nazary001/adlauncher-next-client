// Node's built-in runner (v24 strips types natively): `node --test tests/av-delivery.test.ts`.
// AV delivery modes (owner ask 30.09): Purchase on the AV site pixel (default) or Traffic / link
// clicks with no pixel — the mapping the card, the locks, the launch route and AV clones share.
// lib/av-delivery imports ./types without an extension (the bundler's resolution) — the hook lets
// the dynamic import below load it straight off disk.
import "./_resolve-hook.ts";
import { test } from "node:test";
import assert from "node:assert/strict";

const { AV_OBJECTIVE, AV_PIXEL, AV_SALES_OBJECTIVE, avDelivery, avLockPatch } = await import("../lib/av-delivery.ts");
const { makeCampaign } = await import("../lib/types.ts");

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
