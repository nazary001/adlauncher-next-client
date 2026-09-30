// Node's built-in runner (v24 strips types natively): `node --test tests/av-platforms.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts imports below are a Node requirement.
// AV Platforms pick (owner ask 30.09: "при заливе на AV выбирать соц") — lib/publisher-platforms.ts:
// the card's choices, the Meta words each one stands for, the refusal of a word we do not know, and
// the SAME publisher_platforms / positions on both AV channels (TOOL's builder and the direct-Graph
// targeting), for every placement set.
import "./_resolve-hook.ts";
import { test } from "node:test";
import assert from "node:assert/strict";

const pp = await import("../lib/publisher-platforms.ts");
const { targeting, adsetPayload } = await import("../lib/fb-launch.ts");
const tl = await import("../lib/tool-launch.ts");
const { makeCampaign } = await import("../lib/types.ts");

test("the card offers All (auto) first, then Facebook, Instagram, Facebook + Instagram — every choice parses", () => {
  assert.deepEqual(
    pp.PLATFORM_CHOICES.map((o) => o.value),
    ["auto", "facebook", "instagram", "facebook+instagram"],
  );
  for (const o of pp.PLATFORM_CHOICES) {
    assert.ok(o.label.trim(), o.value);
    assert.notEqual(pp.publisherPlatformsOf(o.value), null, o.value);
  }
});

test("publisherPlatformsOf: auto / blank / missing = [] (Advantage+); a pick = its Meta words; any other word = null", () => {
  for (const v of ["auto", "", "  ", undefined, null]) assert.deepEqual(pp.publisherPlatformsOf(v), [], String(v));
  assert.deepEqual(pp.publisherPlatformsOf("facebook"), ["facebook"]);
  assert.deepEqual(pp.publisherPlatformsOf(" Instagram "), ["instagram"]); // spelling is normalized
  assert.deepEqual(pp.publisherPlatformsOf("facebook+instagram"), ["facebook", "instagram"]);
  // Never guessed: a word outside the card's choices is refused, not widened to "every platform".
  for (const v of ["threads", "tiktok", "facebook,instagram", "audience_network", 1, {}, ["facebook"], true]) {
    assert.equal(pp.publisherPlatformsOf(v), null, JSON.stringify(v));
  }
});

test("a fresh card starts on All (auto)", () => {
  assert.equal(makeCampaign("c1").platforms, "auto");
});

test("both AV channels put the SAME platforms/positions on the ad set, for every choice × placement set", () => {
  const pick = (t: Record<string, unknown>) => [t.publisher_platforms, t.facebook_positions, t.instagram_positions];
  for (const choice of pp.PLATFORM_CHOICES.map((o) => o.value)) {
    const platforms = pp.publisherPlatformsOf(choice) as string[];
    for (const placement of ["FULL", "FULL_HOMEM", "COMPLIANCE", "COMPLIANCE_MULHER"]) {
      const c = { ...makeCampaign("c1"), countries: ["BR"], placement };
      const graph = targeting(c, [], platforms);
      const built = tl.buildToolCampaign({
        name: "n",
        objective: "OUTCOME_TRAFFIC",
        budgetUsd: 10,
        bidStrategy: "LOWEST_COST_WITHOUT_CAP",
        bid: { kind: "none" },
        optimization: "clicks",
        conversionEvent: "PURCHASE",
        pixelId: "",
        pageId: "P1",
        countries: ["BR"],
        localeIds: [],
        category: "",
        placement,
        platforms,
        ageMin: "18",
        userOs: "all",
        creatives: [{ name: "a", media: { type: "image", media_id: "m1" }, primaryText: "t", headline: "h", url: "https://x.co", cta: "LEARN_MORE" }],
        status: "ACTIVE",
        accountCurrency: "USD",
      });
      assert.ok(built.ok, `${choice} × ${placement}`);
      assert.deepEqual(pick(built.ok ? built.body.adsets[0].targeting : {}), pick(graph), `${choice} × ${placement}`);
    }
  }
});

test("the Graph targeting without a pick is exactly what it was: FULL omits platforms, COMPLIANCE = FB + IG feeds", () => {
  const c = { ...makeCampaign("c1"), countries: ["BR"] };
  assert.equal(targeting(c, []).publisher_platforms, undefined);
  const comp = targeting({ ...c, placement: "COMPLIANCE" }, []);
  assert.deepEqual([comp.publisher_platforms, comp.facebook_positions, comp.instagram_positions], [["facebook", "instagram"], ["feed"], ["stream"]]);
});

test("adsetPayload carries the pick into the ad set's targeting (the direct-Graph AV path)", () => {
  const c = { ...makeCampaign("c1"), countries: ["BR"] };
  const binds = { accountId: "1", pageId: "P1", pageName: "", pixelId: "" };
  const p = adsetPayload(c, "n", "C1", binds, [], ["instagram"]) as { targeting: Record<string, unknown> };
  assert.deepEqual(p.targeting.publisher_platforms, ["instagram"]);
  const none = adsetPayload(c, "n", "C1", binds, []) as { targeting: Record<string, unknown> };
  assert.equal(none.targeting.publisher_platforms, undefined);
});

test("placementPlatformFields: the one rule — no pick keeps the placement set's own platforms", () => {
  assert.deepEqual(pp.placementPlatformFields(false, []), {});
  assert.deepEqual(pp.placementPlatformFields(false, ["instagram"]), { publisher_platforms: ["instagram"] });
  assert.deepEqual(pp.placementPlatformFields(true, []), {
    publisher_platforms: ["facebook", "instagram"],
    facebook_positions: ["feed"],
    instagram_positions: ["stream"],
  });
  assert.deepEqual(pp.placementPlatformFields(true, ["facebook"]), { publisher_platforms: ["facebook"], facebook_positions: ["feed"] });
});
