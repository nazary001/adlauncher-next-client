// Node's built-in runner (v24 strips types natively): `node --test tests/vc-tool.test.ts`.
// VC through TOOL (owner ask 23.10 "сделай на основе Tool тоже"): the body /api/vc/launch hands TOOL for
// each VC delivery mode — Purchase on the VC pixel, min-ROAS (value on the same pixel), link clicks —
// built by the very helpers the route calls (vcDelivery → the toolInputFromCampaign mapping →
// buildToolCampaign), with the VC link (adtitle = the ad's title) on every creative and the
// "GCL TOOL - " marker after the (VC) prefix.
import "./_resolve-hook.ts";
import { test } from "node:test";
import assert from "node:assert/strict";

const tl = await import("../lib/tool-launch.ts");
const { VC_PIXEL, vcAdTitle, vcDelivery, vcLink } = await import("../lib/vc-link.ts");
const { makeCampaign, normalizeRoasGoal, parseMoney, bidKind } = await import("../lib/types.ts");
type Campaign = ReturnType<typeof makeCampaign>;

const LP = "https://www.qualitydays.com/rsp/construction-software-pt/?cmpid=aoz37upzf0";

/** The route's own steps: serverCampaign = card + vcDelivery, then lib/tool-run toolInputFromCampaign's
 *  field mapping (kept literal here — that module imports "@/" at runtime). */
function toolBody(over: Partial<Campaign>) {
  const card = { ...makeCampaign("c1"), countries: ["BR"], landing: LP, headline: "Software de gestão", title: "desc", cta: "LEARN_MORE", ...over };
  const c = { ...card, ...vcDelivery(card.optimization, card.bidStrategy) };
  const kind = bidKind(c.bidStrategy);
  const raw = parseMoney(c.bidCap);
  const link = vcLink(c.landing, vcAdTitle(c));
  return tl.buildToolCampaign({
    name: tl.toolEnsureMark("[23/10] (VC) - tail"),
    objective: c.objective,
    budgetUsd: parseMoney(c.budget),
    bidStrategy: c.bidStrategy,
    bid: kind === "roas" ? { kind: "roas", coefficient: normalizeRoasGoal(raw) ?? 0 } : kind === "cap" ? { kind: "cap", usd: raw } : { kind: "none" },
    optimization: c.optimization,
    conversionEvent: c.conversionEvent,
    pixelId: c.pixel,
    pageId: "610000000000001",
    countries: c.countries,
    localeIds: [],
    category: c.category,
    placement: c.placement,
    platforms: [],
    ageMin: c.ageMin,
    userOs: c.userOs,
    creatives: [{ name: "a", media: { type: "video", media_id: "m1" }, primaryText: c.copy, headline: c.headline || c.title, url: link, cta: c.cta }],
    status: "ACTIVE",
    accountCurrency: "USD",
  });
}

test("VC via TOOL: the name carries GCL TOOL right after the (VC) prefix", () => {
  assert.equal(tl.toolEnsureMark("[23/10] (VC) - tail"), "[23/10] (VC) - GCL TOOL - tail");
});

test("VC via TOOL · Purchase: Sales, conversion PURCHASE on the VC pixel, the VC link on the creative", () => {
  const r = toolBody({});
  assert.ok(r.ok, r.ok ? "" : r.error);
  if (!r.ok) return;
  assert.equal(r.body.campaign.objective, "OUTCOME_SALES");
  assert.equal(r.body.adsets[0].optimization_goal, "OFFSITE_CONVERSIONS");
  assert.equal(r.body.adsets[0].conversion?.pixel_id, VC_PIXEL.id);
  assert.equal(r.body.adsets[0].conversion?.event, "PURCHASE");
  const json = JSON.stringify(r.body);
  assert.ok(json.includes("cmpid=aoz37upzf0&adtitle=Software+de+gest%C3%A3o"), "creative url = the VC link with adtitle");
});

test("VC via TOOL · min ROAS: VALUE on the VC pixel", () => {
  const r = toolBody({ bidStrategy: "LOWEST_COST_WITH_MIN_ROAS", bidCap: "0,5", optimization: "clicks" });
  assert.ok(r.ok, r.ok ? "" : r.error);
  if (!r.ok) return;
  assert.equal(r.body.adsets[0].optimization_goal, "VALUE");
  assert.equal(r.body.adsets[0].conversion?.pixel_id, VC_PIXEL.id);
});

test("VC via TOOL · link clicks: Traffic, LINK_CLICKS, no conversion", () => {
  const r = toolBody({ optimization: "clicks" });
  assert.ok(r.ok, r.ok ? "" : r.error);
  if (!r.ok) return;
  assert.equal(r.body.campaign.objective, "OUTCOME_TRAFFIC");
  assert.equal(r.body.adsets[0].optimization_goal, "LINK_CLICKS");
  assert.equal(r.body.adsets[0].conversion, undefined);
});
