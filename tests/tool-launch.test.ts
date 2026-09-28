// Node's built-in runner (v24 strips types natively): `node --test tests/tool-launch.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts imports below are a Node requirement.
// PURE builders + readers + dependency-injected orchestration for the TOOL launch channel: name
// marker idempotency, USD (not cents) + ROAS coefficient (not ×10000), INFERRED gating (WW / locales
// / bid-cap / cost-cap) + allow_inferred, fb-launch targeting parity, event + CTA mapping + refusals,
// job outcome / stage / failure-text reads, and the media / publish / duplicate orchestration driven
// by a FAKE ToolDeps (no network).
import { test } from "node:test";
import assert from "node:assert/strict";

import * as tl from "../lib/tool-launch.ts";
import type { CampaignRequest, DuplicateRequest, ToolBuildInput, ToolCallResult, ToolDeps } from "../lib/tool-launch.ts";

// ---- fixtures -----------------------------------------------------------------------------------

function input(over: Partial<ToolBuildInput> = {}): ToolBuildInput {
  return {
    name: "[28/09] (MO) - GCL TOOL - offer",
    objective: "OUTCOME_SALES",
    budgetUsd: 10,
    bidStrategy: "LOWEST_COST_WITHOUT_CAP",
    bid: { kind: "none" },
    optimization: "conversions",
    conversionEvent: "PURCHASE",
    pixelId: "PX1",
    pageId: "PAGE1",
    countries: ["BR"],
    localeIds: [],
    category: "",
    placement: "FULL",
    ageMin: "18",
    userOs: "all",
    creatives: [{ name: "ad1", media: { type: "image", media_id: "med_1" }, primaryText: "body", headline: "Head", url: "https://x.co", cta: "LEARN_MORE" }],
    status: "ACTIVE",
    accountCurrency: "USD",
    ...over,
  };
}

/** Build and assert-ok (throws with the refusal if not). */
function built(over: Partial<ToolBuildInput> = {}) {
  const r = tl.buildToolCampaign(input(over));
  assert.ok(r.ok, r.ok ? "" : `expected ok, got refusal: ${r.error}`);
  return r as Extract<typeof r, { ok: true }>;
}

// ================================================================================================
// name marker
// ================================================================================================

test("toolEnsureMark: HS grammar → TOKEN slot, dropping any TOKEN- marker", () => {
  const base = "[28/09] (ACR) API - (#ADX [HIGH]) - [BR] - tail";
  assert.equal(tl.toolEnsureMark(base), "[28/09] (ACR) API - (#ADX [HIGH]) - [BR] - GCL TOOL - tail");
  const tokenBorn = "[28/09] (ACR) API - (#ADX [HIGH]) - [BR] - TOKEN - tail";
  assert.equal(tl.toolEnsureMark(tokenBorn), "[28/09] (ACR) API - (#ADX [HIGH]) - [BR] - GCL TOOL - tail");
});

test("toolEnsureMark: MO/AIF partner prefix → after the prefix, dropping SOC-", () => {
  assert.equal(tl.toolEnsureMark("[28/09] (MO) - offer"), "[28/09] (MO) - GCL TOOL - offer");
  assert.equal(tl.toolEnsureMark("[28/09] (AIF) - offer"), "[28/09] (AIF) - GCL TOOL - offer");
  assert.equal(tl.toolEnsureMark("[28/09] (MO) - SOC - offer"), "[28/09] (MO) - GCL TOOL - offer");
});

test("toolEnsureMark: clone prefix (CLONE) - (tier) - keeps the prefix", () => {
  assert.equal(tl.toolEnsureMark("[28/09] (CLONE) - (t1) - offer"), "[28/09] (CLONE) - (t1) - GCL TOOL - offer");
  assert.equal(tl.toolEnsureMark("[28/09] (CLONE) - offer"), "[28/09] (CLONE) - GCL TOOL - offer");
});

test("toolEnsureMark: grammar-less name is prepended; already-marked passes through; idempotent", () => {
  assert.equal(tl.toolEnsureMark("just a name"), "GCL TOOL - just a name");
  const marked = "[28/09] (MO) - GCL TOOL - offer";
  assert.equal(tl.toolEnsureMark(marked), marked);
  for (const n of ["[28/09] (ACR) API - (#ADX [HIGH]) - [BR] - TOKEN - t", "[28/09] (MO) - SOC - o", "[28/09] (CLONE) - (t1) - o", "plain"]) {
    assert.equal(tl.toolEnsureMark(tl.toolEnsureMark(n)), tl.toolEnsureMark(n), `idempotent for ${n}`);
  }
});

test("stripToolMark drops a leading GCL TOOL -", () => {
  assert.equal(tl.stripToolMark("GCL TOOL - foo"), "foo");
  assert.equal(tl.stripToolMark("foo"), "foo");
});

test("TOOL_MARK is the one GCL TOOL marker (lib/hs-launch imports THIS constant for its TOKEN slot)", () => {
  // hs-launch is not node-loadable (runtime imports of ./catalog + ./types), so the guard against
  // drift is structural, not a runtime compare: hs-launch's hsNamePrefix uses this exact constant.
  assert.equal(tl.TOOL_MARK, "GCL TOOL - ");
});

// ================================================================================================
// units: USD (not cents), ROAS coefficient (not ×10000)
// ================================================================================================

test("budget is USD on the campaign (CBO), not cents; no adset budget", () => {
  const { body } = built({ budgetUsd: 10 });
  assert.equal(body.campaign.budget_type, "CAMPAIGN");
  assert.equal(body.campaign.daily_budget, 10);
  assert.equal(body.adsets[0].daily_budget, undefined);
});

test("min-ROAS bid is the coefficient (0.3), not 3000; goal VALUE; event PURCHASE", () => {
  const { body } = built({ bidStrategy: "LOWEST_COST_WITH_MIN_ROAS", bid: { kind: "roas", coefficient: 0.3 } });
  assert.equal(body.campaign.bid_strategy, "LOWEST_COST_WITH_MIN_ROAS");
  assert.deepEqual(body.adsets[0].bid, { roas: 0.3 });
  assert.equal(body.adsets[0].optimization_goal, "VALUE");
  assert.equal(body.adsets[0].conversion?.event, "PURCHASE");
  assert.equal(body.adsets[0].conversion?.pixel_id, "PX1");
});

test("bid cap is USD (0.5) and INFERRED; cost cap uses cost_cap", () => {
  const cap = built({ bidStrategy: "LOWEST_COST_WITH_BID_CAP", bid: { kind: "cap", usd: 0.5 } });
  assert.deepEqual(cap.body.adsets[0].bid, { amount: 0.5 });
  assert.ok(cap.inferred.includes("bid_cap"));
  assert.equal(cap.body.options?.allow_inferred, true);
  const cost = built({ bidStrategy: "COST_CAP", bid: { kind: "cap", usd: 0.5 } });
  assert.ok(cost.inferred.includes("cost_cap"));
});

// ================================================================================================
// targeting parity with fb-launch
// ================================================================================================

test("WW → countries [US] + raw country_groups/excluded, INFERRED", () => {
  const { body, inferred } = built({ countries: ["WW"] });
  const t = body.adsets[0].targeting;
  assert.deepEqual(t.countries, ["US"]);
  assert.deepEqual(t.raw, {
    geo_locations: { country_groups: ["worldwide"], location_types: ["home", "recent"] },
    excluded_geo_locations: { countries: ["TW", "SG"] },
  });
  assert.ok(inferred.includes("WW"));
  assert.equal(body.options?.allow_inferred, true);
});

test("explicit countries pass through as-is (no raw)", () => {
  const { body, inferred } = built({ countries: ["BR", "MX"] });
  assert.deepEqual(body.adsets[0].targeting.countries, ["BR", "MX"]);
  assert.equal(body.adsets[0].targeting.raw, undefined);
  assert.ok(!inferred.includes("WW"));
});

test("locales → targeting.locales, INFERRED", () => {
  const { body, inferred } = built({ localeIds: [6, 1001] });
  assert.deepEqual(body.adsets[0].targeting.locales, [6, 1001]);
  assert.ok(inferred.includes("locales"));
});

test("gender suffix → genders + advantage_audience false; broad omits both", () => {
  assert.deepEqual(built({ placement: "FULL_HOMEM" }).body.adsets[0].targeting.genders, [1]);
  assert.equal(built({ placement: "FULL_HOMEM" }).body.adsets[0].targeting.advantage_audience, false);
  assert.deepEqual(built({ placement: "FULL_MULHER" }).body.adsets[0].targeting.genders, [2]);
  const broad = built({ placement: "FULL" }).body.adsets[0].targeting;
  assert.equal(broad.genders, undefined);
  assert.equal(broad.advantage_audience, undefined);
});

test("age>18 narrows → advantage_audience false", () => {
  const t = built({ ageMin: "25" }).body.adsets[0].targeting;
  assert.equal(t.age_min, 25);
  assert.equal(t.advantage_audience, false);
});

test("COMPLIANCE placement → feeds-only platforms/positions", () => {
  const t = built({ placement: "COMPLIANCE" }).body.adsets[0].targeting;
  assert.deepEqual(t.publisher_platforms, ["facebook", "instagram"]);
  assert.deepEqual(t.facebook_positions, ["feed"]);
  assert.deepEqual(t.instagram_positions, ["stream"]);
});

test("android → user_os [Android]", () => {
  assert.deepEqual(built({ userOs: "android" }).body.adsets[0].targeting.user_os, ["Android"]);
});

test("special ad category → age 18, no genders, category on the campaign", () => {
  const { body } = built({ category: "FINANCIAL_PRODUCTS_SERVICES", ageMin: "25", placement: "FULL_HOMEM" });
  assert.deepEqual(body.campaign.special_ad_categories, ["FINANCIAL_PRODUCTS_SERVICES"]);
  assert.equal(body.adsets[0].targeting.age_min, 18);
  assert.equal(body.adsets[0].targeting.genders, undefined);
});

test("no category → special_ad_categories [NONE]", () => {
  assert.deepEqual(built().body.campaign.special_ad_categories, ["NONE"]);
});

// ================================================================================================
// event + CTA mapping and refusals
// ================================================================================================

test("event mapping CONTENT_VIEW → VIEW_CONTENT; unknown event refused by name", () => {
  assert.equal(built({ conversionEvent: "CONTENT_VIEW" }).body.adsets[0].conversion?.event, "VIEW_CONTENT");
  const r = tl.buildToolCampaign(input({ conversionEvent: "ADD_TO_WISHLIST" }));
  assert.ok(!r.ok && /conversion_event_unsupported: ADD_TO_WISHLIST/.test(r.error));
});

test("CTA mapping: empty → NO_BUTTON; SHOP_NOW → SHOP_NOW; unknown refused by name", () => {
  assert.equal(built({ creatives: [{ ...input().creatives[0], cta: "" }] }).body.adsets[0].ads[0].creative.cta, "NO_BUTTON");
  assert.equal(built({ creatives: [{ ...input().creatives[0], cta: "SHOP_NOW" }] }).body.adsets[0].ads[0].creative.cta, "SHOP_NOW");
  const r = tl.buildToolCampaign(input({ creatives: [{ ...input().creatives[0], cta: "BOOK_NOW" }] }));
  assert.ok(!r.ok && /cta_unsupported: BOOK_NOW/.test(r.error));
});

test("refusals: currency, objective, empty creatives, budget, roas band, cap, missing pixel", () => {
  const bad = (over: Partial<ToolBuildInput>, re: RegExp) => {
    const r = tl.buildToolCampaign(input(over));
    assert.ok(!r.ok && re.test(r.error), r.ok ? "expected refusal" : r.error);
  };
  bad({ accountCurrency: "EUR" }, /account_currency_not_usd: EUR/);
  bad({ objective: "OUTCOME_ENGAGEMENT" }, /objective_unsupported: OUTCOME_ENGAGEMENT/);
  bad({ creatives: [] }, /creatives_required/);
  bad({ budgetUsd: 0.5 }, /budget_too_low/);
  bad({ bidStrategy: "LOWEST_COST_WITH_MIN_ROAS", bid: { kind: "roas", coefficient: 0 } }, /roas_goal_invalid/);
  bad({ bidStrategy: "LOWEST_COST_WITH_MIN_ROAS", bid: { kind: "roas", coefficient: 101 } }, /roas_goal_invalid/);
  bad({ bidStrategy: "LOWEST_COST_WITH_BID_CAP", bid: { kind: "cap", usd: 0 } }, /bid_required/);
  bad({ pixelId: "" }, /pixel_required/);
});

test("clicks optimization needs no pixel / conversion", () => {
  const { body } = built({ optimization: "clicks", pixelId: "" });
  assert.equal(body.adsets[0].optimization_goal, "LINK_CLICKS");
  assert.equal(body.adsets[0].conversion, undefined);
});

// ================================================================================================
// status / activate
// ================================================================================================

test("status ACTIVE → all ACTIVE + options.activate true", () => {
  const { body } = built({ status: "ACTIVE" });
  assert.equal(body.campaign.status, "ACTIVE");
  assert.equal(body.adsets[0].status, "ACTIVE");
  assert.equal(body.adsets[0].ads[0].status, "ACTIVE");
  assert.equal(body.options?.activate, true);
});

test("status PAUSED → all PAUSED + options.activate false", () => {
  const { body } = built({ status: "PAUSED" });
  assert.equal(body.campaign.status, "PAUSED");
  assert.equal(body.adsets[0].status, "PAUSED");
  assert.equal(body.adsets[0].ads[0].status, "PAUSED");
  assert.equal(body.options?.activate, false);
});

test("creative + thumbnail + page_id ride into the body", () => {
  const { body } = built({
    creatives: [{ name: "A", media: { type: "video", video_id: undefined, media_id: "med_v" }, thumbnail: { type: "image", media_id: "med_c" }, primaryText: "P", headline: "H", description: "D", url: "https://l.co", cta: "SHOP_NOW" }],
  });
  const cr = body.adsets[0].ads[0].creative;
  assert.deepEqual(cr.media, { type: "video", video_id: undefined, media_id: "med_v" });
  assert.deepEqual(cr.thumbnail, { type: "image", media_id: "med_c" });
  assert.equal(cr.primary_text, "P");
  assert.equal(cr.headline, "H");
  assert.equal(cr.description, "D");
  assert.equal(body.page_id, "PAGE1");
});

// ================================================================================================
// duplicate body
// ================================================================================================

test("buildToolDuplicate: one target, copies 1, status on both, USD/coefficient bid", () => {
  const r = tl.buildToolDuplicate({
    sourceCampaignId: "120210000000101",
    accountId: "1702978257719186",
    pageId: "PG",
    pixelId: "PX",
    name: "[28/09] (CLONE) - (t1) - GCL TOOL - x",
    budgetUsd: 12,
    bid: 0.4,
    bidStrategy: "LOWEST_COST_WITH_MIN_ROAS",
    status: "PAUSED",
    startTime: "2026-09-28T10:00:00-07:00",
  });
  assert.ok(r.ok);
  assert.equal(r.body.source_campaign_id, "120210000000101");
  assert.equal(r.body.targets.length, 1);
  const t = r.body.targets[0];
  assert.equal(t.account_id, "1702978257719186");
  assert.equal(t.page_id, "PG");
  assert.equal(t.pixel_id, "PX");
  assert.equal(t.daily_budget, 12);
  assert.equal(t.bid, 0.4);
  assert.equal(t.bid_strategy, "LOWEST_COST_WITH_MIN_ROAS");
  assert.equal(t.status, "PAUSED");
  assert.equal(t.ad_status, "PAUSED");
  assert.equal(t.start_time, "2026-09-28T10:00:00-07:00");
  assert.equal(t.copies, 1);
});

test("buildToolDuplicate refuses a short source id / low budget", () => {
  assert.ok(!tl.buildToolDuplicate({ sourceCampaignId: "12", accountId: "1", pageId: "", pixelId: "", name: "", budgetUsd: 10, status: "ACTIVE" }).ok);
  assert.ok(!tl.buildToolDuplicate({ sourceCampaignId: "120210000000101", accountId: "1", pageId: "", pixelId: "", name: "", budgetUsd: 0, status: "ACTIVE" }).ok);
});

// ================================================================================================
// job reading
// ================================================================================================

const doneJob = (over: Record<string, unknown> = {}) => ({
  id: 6,
  status: "done",
  stage: "SUCCEEDED",
  kind: "campaign.create",
  result: { created: { campaign_id: "120253810228480635", adset_ids: ["a1"], ad_ids: ["ad1", "ad2"] } },
  ...over,
});

test("toolJobOutcome: done → ids + activated (default false); result.activated true → true", () => {
  const o = tl.toolJobOutcome(doneJob());
  assert.ok(o.state === "done" && o.campaignId === "120253810228480635" && o.adsetIds.length === 1 && o.adIds.length === 2 && o.activated === false);
  const a = tl.toolJobOutcome(doneJob({ result: { created: { campaign_id: "c", adset_ids: [], ad_ids: [] }, activated: true } }));
  assert.ok(a.state === "done" && a.activated === true);
});

test("toolJobOutcome: partial/error/canceled/unknown → failed (with created if any); running/queued → pending", () => {
  const partial = tl.toolJobOutcome({ status: "partial", error: null, result: { created: { campaign_id: "c", adset_ids: [], ad_ids: [] } } });
  assert.ok(partial.state === "failed" && partial.created?.campaignId === "c");
  for (const s of ["error", "canceled", "unknown"]) {
    const o = tl.toolJobOutcome({ status: s, error: "boom", result: null });
    assert.ok(o.state === "failed" && /boom/.test(o.error), `failed for ${s}`);
  }
  assert.equal(tl.toolJobOutcome({ status: "running" }).state, "pending");
  assert.equal(tl.toolJobOutcome({ status: "queued" }).state, "pending");
});

test("toolStageOf: event steps → NDJSON stages; media + terminal", () => {
  const run = (events: unknown[]) => tl.toolStageOf({ status: "running", kind: "campaign.create" }, events);
  assert.equal(run([{ step: "queued" }]), "campaign");
  assert.equal(run([{ step: "queued" }, { step: "fragments" }]), "adset");
  assert.equal(run([{ step: "publish", meta: {} }]), "creative");
  assert.equal(run([{ step: "publish", meta: { campaign_id: "c", ad_ids: ["x"] } }]), "ad");
  assert.equal(run([{ step: "close" }]), "ad");
  assert.equal(tl.toolStageOf({ status: "running", kind: "media.upload" }), "processing");
  assert.equal(tl.toolStageOf({ status: "queued", kind: "media.upload" }), "video");
  assert.equal(tl.toolStageOf({ status: "done", kind: "campaign.create" }), "done");
  assert.equal(tl.toolStageOf({ status: "error", kind: "campaign.create" }), "error");
});

test("toolFailureText: missing_context → session sentence with the account; else message/problem/string", () => {
  const mc = tl.toolFailureText({ problems: [{ error: "missing_context", field: "session_id/account_id", message: "нет активной сессии" }] }, "1702978257719186");
  assert.match(mc, /No live TOOL session sees account 1702978257719186/);
  assert.equal(tl.toolFailureText({ error: "validation_failed", message: "bad name" }), "bad name");
  assert.equal(tl.toolFailureText("boom"), "boom");
  assert.equal(tl.toolFailureText([{ error: "x", field: "f", message: "m" }]), "m");
});

// ================================================================================================
// orchestration with a fake ToolDeps
// ================================================================================================

const ok = <T>(data: T, status = 200): ToolCallResult<T> => ({ ok: true, status, data });
const fail = (status: number, error: string, message = error, problems?: unknown[]): ToolCallResult => ({ ok: false, status, error, message, problems });

type Calls = Record<"createCampaign" | "createDuplicates" | "mediaFromUrl" | "getMedia" | "getJob" | "jobEvents" | "sleep", unknown[][]>;

/** A ToolDeps whose async fns delegate to the supplied stubs; records every call's args. */
function fakeDeps(over: Partial<ToolDeps> & { clock?: { t: number }; advanceOnSleep?: number } = {}): { deps: ToolDeps; calls: Calls } {
  const calls: Calls = { createCampaign: [], createDuplicates: [], mediaFromUrl: [], getMedia: [], getJob: [], jobEvents: [], sleep: [] };
  const clock = over.clock ?? { t: 1000 };
  const deps: ToolDeps = {
    createCampaign: (accountId, body, opts) => {
      calls.createCampaign.push([accountId, body, opts]);
      return over.createCampaign ? over.createCampaign(accountId, body, opts) : Promise.resolve(fail(500, "no stub"));
    },
    createDuplicates: (accountId, body, opts) => {
      calls.createDuplicates.push([accountId, body, opts]);
      return over.createDuplicates ? over.createDuplicates(accountId, body, opts) : Promise.resolve(fail(500, "no stub"));
    },
    mediaFromUrl: (accountId, kind, body, opts) => {
      calls.mediaFromUrl.push([accountId, kind, body, opts]);
      return over.mediaFromUrl ? over.mediaFromUrl(accountId, kind, body, opts) : Promise.resolve(fail(500, "no stub"));
    },
    getMedia: (mediaId) => {
      calls.getMedia.push([mediaId]);
      return over.getMedia ? over.getMedia(mediaId) : Promise.resolve(fail(500, "no stub"));
    },
    getJob: (id) => {
      calls.getJob.push([id]);
      return over.getJob ? over.getJob(id) : Promise.resolve(fail(500, "no stub"));
    },
    jobEvents: (id) => {
      calls.jobEvents.push([id]);
      return over.jobEvents ? over.jobEvents(id) : Promise.resolve(ok([]));
    },
    sleep: async (ms) => {
      calls.sleep.push([ms]);
      clock.t += over.advanceOnSleep ?? 0;
    },
    now: () => clock.t,
  };
  return { deps, calls };
}

/** Read the Idempotency-Key that reached a recorded (accountId, body, opts) call. */
const idemOf = (call: unknown[] | undefined): string | undefined => (call?.[2] as { idempotencyKey?: string } | undefined)?.idempotencyKey;

// A minimal valid CampaignRequest / DuplicateRequest — the fake createCampaign / createDuplicates
// ignore the body, so only the type has to hold.
const publishBody: CampaignRequest = { campaign: { name: "n", objective: "OUTCOME_SALES" }, adsets: [] };
const duplicateBody: DuplicateRequest = { source_campaign_id: "120210000000101", targets: [{ copies: 1 }] };

test("runToolMedia: image ready after N polls → MediaRef by media_id", async () => {
  const statuses = ["uploading", "uploading", "ready"];
  const { deps, calls } = fakeDeps({
    mediaFromUrl: () => ok({ media_id: "med_1", status: "uploading" }),
    getMedia: () => ok({ media_id: "med_1", status: statuses.shift() ?? "ready" }),
  });
  const r = await tl.runToolMedia(deps, "acct", [{ url: "https://blob/x.jpg", kind: "image" }], { deadlineAt: Date.now() + 60_000 });
  assert.ok(r.ok);
  assert.deepEqual(r.refs[0].media, { type: "image", media_id: "med_1" });
  assert.equal(calls.getMedia.length, 3);
  assert.equal(calls.sleep.length, 3);
});

test("runToolMedia: media error short-circuits with the index", async () => {
  const { deps } = fakeDeps({
    mediaFromUrl: () => ok({ media_id: "med_1", status: "processing" }),
    getMedia: () => ok({ media_id: "med_1", status: "error", error: "bad file" }),
  });
  const r = await tl.runToolMedia(deps, "acct", [{ url: "u", kind: "image" }], { deadlineAt: Date.now() + 60_000 });
  assert.ok(!r.ok && r.index === 0 && /bad file/.test(r.error));
});

test("runToolMedia: video + custom cover → media + thumbnail; kinds video then image", async () => {
  const idByKind: Record<string, string> = { video: "med_v", image: "med_c" };
  const { deps, calls } = fakeDeps({
    mediaFromUrl: (_acct: string, kind: "image" | "video") => ok({ media_id: idByKind[kind], status: "ready" }),
    getMedia: () => ok({ status: "ready" }),
  });
  const r = await tl.runToolMedia(deps, "acct", [{ url: "https://blob/v.mp4", kind: "video", coverUrl: "https://blob/cover.jpg", name: "clip" }], { deadlineAt: Date.now() + 60_000 });
  assert.ok(r.ok);
  assert.deepEqual(r.refs[0].media, { type: "video", media_id: "med_v" });
  assert.deepEqual(r.refs[0].thumbnail, { type: "image", media_id: "med_c" });
  assert.equal(calls.mediaFromUrl[0][1], "video");
  assert.equal(calls.mediaFromUrl[1][1], "image");
});

test("runToolPublish: 202 → running → done returns the created ids; Idempotency-Key passed through", async () => {
  const jobs = [ok({ id: 5, status: "running", kind: "campaign.create", stage: "RUNNING" }), ok(doneJob({ id: 5 }))];
  const stages: string[] = [];
  const { deps, calls } = fakeDeps({
    createCampaign: () => ok({ id: 5, status: "queued" }, 202),
    getJob: () => jobs.shift() ?? ok(doneJob({ id: 5 })),
    jobEvents: () => ok([{ step: "fragments" }]),
  });
  const r = await tl.runToolPublish(deps, "acct", publishBody, {
    idempotencyKey: "task-42",
    deadlineAt: Date.now() + 60_000,
    onStage: (s) => stages.push(s),
  });
  assert.ok(r.ok && r.jobId === 5 && r.campaignId === "120253810228480635" && r.adsetId === "a1" && r.adIds.length === 2);
  assert.equal(idemOf(calls.createCampaign[0]), "task-42");
  assert.ok(stages.includes("adset") && stages.includes("done"));
});

test("runToolPublish: 422 with problems is a clean refusal (nothing created, not pending)", async () => {
  const { deps } = fakeDeps({ createCampaign: () => fail(422, "validation_failed", "bad", [{ error: "string_too_short", field: "name", message: "too short" }]) });
  const r = await tl.runToolPublish(deps, "acct", publishBody, { deadlineAt: Date.now() + 60_000 });
  assert.ok(!r.ok && !r.pending && /bad/.test(r.error));
});

test("runToolPublish: 2xx carrying problems and no job id → refusal via missing_context text", async () => {
  const { deps } = fakeDeps({ createCampaign: () => ok({ problems: [{ error: "missing_context", field: "session_id/account_id", message: "нет сессии" }] }) });
  const r = await tl.runToolPublish(deps, "1702978257719186", publishBody, { deadlineAt: Date.now() + 60_000 });
  assert.ok(!r.ok && !r.pending && /No live TOOL session sees account 1702978257719186/.test(r.error));
});

test("runToolPublish: network/5xx on submit → pending (ambiguous, nothing proven)", async () => {
  const { deps } = fakeDeps({ createCampaign: () => fail(502, "tool_unreachable", "down") });
  const r = await tl.runToolPublish(deps, "acct", publishBody, { deadlineAt: Date.now() + 60_000 });
  assert.ok(!r.ok && r.pending === true);
});

// review find 28.09: which terminal failures are DEFINITE (the caller frees slot + gcm/brand) and
// which are ambiguous (pending — keep everything). A kept marker for a job that provably built
// nothing leaks a code from the pool; a freed marker under a half-built tree double-books it.
test("runToolPublish: terminal error / canceled with no ids → definite failure (not pending)", async () => {
  for (const status of ["error", "canceled"]) {
    const { deps } = fakeDeps({
      createCampaign: () => ok({ id: 7, status: "queued" }, 202),
      getJob: () => ok({ id: 7, status, error: "Facebook error HTTP 400 code=100: Invalid parameter", result: null }),
    });
    const r = await tl.runToolPublish(deps, "acct", publishBody, { deadlineAt: Date.now() + 60_000 });
    assert.ok(!r.ok && !r.pending && r.jobId === 7 && !r.created, status);
  }
});

test("runToolPublish: partial / unknown with no ids → pending (ambiguous), with ids → failed carrying created", async () => {
  for (const status of ["partial", "unknown"]) {
    const { deps } = fakeDeps({
      createCampaign: () => ok({ id: 8, status: "queued" }, 202),
      getJob: () => ok({ id: 8, status, error: "half way", result: null }),
    });
    const r = await tl.runToolPublish(deps, "acct", publishBody, { deadlineAt: Date.now() + 60_000 });
    assert.ok(!r.ok && r.pending === true && r.jobId === 8, status);
  }
  const { deps } = fakeDeps({
    createCampaign: () => ok({ id: 9, status: "queued" }, 202),
    getJob: () => ok({ id: 9, status: "partial", error: "ads failed", result: { created: { campaign_id: "120200000000009", adset_ids: ["a9"], ad_ids: [] } } }),
  });
  const r = await tl.runToolPublish(deps, "acct", publishBody, { deadlineAt: Date.now() + 60_000 });
  assert.ok(!r.ok && !r.pending && r.created?.campaignId === "120200000000009");
});

test("runToolPublish: done without a campaign id → pending, never a success with an empty id", async () => {
  const { deps } = fakeDeps({
    createCampaign: () => ok({ id: 10, status: "queued" }, 202),
    getJob: () => ok({ id: 10, status: "done", stage: "SUCCEEDED", result: { created: {} } }),
  });
  const r = await tl.runToolPublish(deps, "acct", publishBody, { deadlineAt: Date.now() + 60_000 });
  assert.ok(!r.ok && r.pending === true && r.jobId === 10);
});

test("runToolPublish: deadline while running → pending with the jobId", async () => {
  const clock = { t: 0 };
  const { deps } = fakeDeps({
    createCampaign: () => ok({ id: 9, status: "queued" }, 202),
    getJob: () => ok({ id: 9, status: "running", kind: "campaign.create" }),
    jobEvents: () => ok([{ step: "queued" }]),
    clock,
    advanceOnSleep: 2500,
  });
  const r = await tl.runToolPublish(deps, "acct", publishBody, { deadlineAt: 6000 });
  assert.ok(!r.ok && r.pending === true && r.jobId === 9);
});

test("runToolDuplicate: batch → single child job → done ids", async () => {
  const jobs = [ok({ id: 11, status: "running", kind: "campaign.duplicate" }), ok(doneJob({ id: 11, kind: "campaign.duplicate" }))];
  const { deps, calls } = fakeDeps({
    createDuplicates: () => ok({ batch_id: "b1", status: "queued", jobs: [{ id: 11, status: "queued" }] }, 201),
    getJob: () => jobs.shift() ?? ok(doneJob({ id: 11 })),
  });
  const r = await tl.runToolDuplicate(deps, "acct", duplicateBody, { idempotencyKey: "shot-7", deadlineAt: Date.now() + 60_000 });
  assert.ok(r.ok && r.jobId === 11 && r.campaignId === "120253810228480635");
  assert.equal(idemOf(calls.createDuplicates[0]), "shot-7");
});

test("runToolDuplicate: 4xx submit → refusal (not pending)", async () => {
  const { deps } = fakeDeps({ createDuplicates: () => fail(400, "bad_request", "no source") });
  const r = await tl.runToolDuplicate(deps, "acct", { source_campaign_id: "x", targets: [] } satisfies DuplicateRequest, { deadlineAt: Date.now() + 60_000 });
  assert.ok(!r.ok && !r.pending && /no source/.test(r.error));
});

// ================================================================================================
// transient status-poll failures (review find 28.09): after a good submit the job is REAL, so a
// FAILED getJob (4xx incl. 401/429, post-submit 404, 5xx, network) is transient — keep polling to the
// deadline, then PENDING (jobId kept). Never a clean "nothing created" refusal that would free the
// gcm/slot while TOOL finishes a live ACTIVE campaign carrying that gcm's link.
// ================================================================================================

test("runToolPublish: 429 on the status poll then done → ok with ids (rate-limit is transient, keeps polling)", async () => {
  const jobs: ToolCallResult[] = [fail(429, "rate_limited", "slow down"), ok(doneJob({ id: 5 }))];
  const { deps, calls } = fakeDeps({
    createCampaign: () => ok({ id: 5, status: "queued" }, 202),
    getJob: () => jobs.shift() ?? ok(doneJob({ id: 5 })),
  });
  const r = await tl.runToolPublish(deps, "acct", publishBody, { deadlineAt: Date.now() + 60_000 });
  assert.ok(r.ok && r.jobId === 5 && r.campaignId === "120253810228480635" && r.adIds.length === 2);
  assert.equal(calls.getJob.length, 2); // did NOT refuse after the single 429 read
});

test("runToolPublish: persistent 404 on the status poll → pending at the deadline with the jobId (never a clean failure)", async () => {
  const clock = { t: 0 };
  const { deps, calls } = fakeDeps({
    createCampaign: () => ok({ id: 8, status: "queued" }, 202),
    getJob: () => fail(404, "not_found", "no such job"),
    clock,
    advanceOnSleep: 2500,
  });
  const r = await tl.runToolPublish(deps, "acct", publishBody, { deadlineAt: 6000 });
  assert.ok(!r.ok && r.pending === true && r.jobId === 8);
  assert.match(r.ok ? "" : r.error, /job #8/); // "could not be read … may still appear"
  assert.ok(calls.getJob.length >= 2); // polled through the 404, did not refuse on the first read
});

test("runToolPublish: 401 mid-poll (auth blip) → pending with the jobId, not a refusal", async () => {
  const clock = { t: 0 };
  const jobs: ToolCallResult[] = [ok({ id: 3, status: "running", kind: "campaign.create" })];
  const { deps } = fakeDeps({
    createCampaign: () => ok({ id: 3, status: "queued" }, 202),
    getJob: () => jobs.shift() ?? fail(401, "unauthorized", "token blip"),
    clock,
    advanceOnSleep: 2500,
  });
  const r = await tl.runToolPublish(deps, "acct", publishBody, { deadlineAt: 5000 });
  assert.ok(!r.ok && r.pending === true && r.jobId === 3);
});

// ================================================================================================
// onSubmitted contract (review find 28.09): fires exactly once, with the job id, the instant TOOL
// accepted the submit — BEFORE any poll — and NEVER on a refused submit.
// ================================================================================================

test("runToolPublish: onSubmitted fires once with the job id, before the first poll", async () => {
  const seen: number[] = [];
  let getJobsWhenSubmitted = -1;
  const jobs: ToolCallResult[] = [ok({ id: 5, status: "running", kind: "campaign.create" }), ok(doneJob({ id: 5 }))];
  const { deps, calls } = fakeDeps({
    createCampaign: () => ok({ id: 5, status: "queued" }, 202),
    getJob: () => jobs.shift() ?? ok(doneJob({ id: 5 })),
  });
  const r = await tl.runToolPublish(deps, "acct", publishBody, {
    deadlineAt: Date.now() + 60_000,
    onSubmitted: (id) => { seen.push(id); getJobsWhenSubmitted = calls.getJob.length; },
  });
  assert.ok(r.ok);
  assert.deepEqual(seen, [5]); // exactly once, with the id
  assert.equal(getJobsWhenSubmitted, 0); // before ANY getJob poll
});

test("runToolPublish: onSubmitted never fires on a refused submit (4xx / missing_context / no-job-id 5xx)", async () => {
  let fired = 0;
  const bump = () => { fired++; };
  const d1 = fakeDeps({ createCampaign: () => fail(422, "validation_failed", "bad") }).deps;
  await tl.runToolPublish(d1, "acct", publishBody, { deadlineAt: Date.now() + 60_000, onSubmitted: bump });
  const d2 = fakeDeps({ createCampaign: () => ok({ problems: [{ error: "missing_context", field: "f", message: "m" }] }) }).deps;
  await tl.runToolPublish(d2, "1702978257719186", publishBody, { deadlineAt: Date.now() + 60_000, onSubmitted: bump });
  const d3 = fakeDeps({ createCampaign: () => fail(502, "tool_unreachable", "down") }).deps;
  await tl.runToolPublish(d3, "acct", publishBody, { deadlineAt: Date.now() + 60_000, onSubmitted: bump });
  assert.equal(fired, 0);
});

test("runToolDuplicate: onSubmitted fires once with the child job id on accept, never on a refused submit", async () => {
  const seen: number[] = [];
  const jobs: ToolCallResult[] = [ok(doneJob({ id: 11, kind: "campaign.duplicate" }))];
  const { deps } = fakeDeps({
    createDuplicates: () => ok({ batch_id: "b1", status: "queued", jobs: [{ id: 11, status: "queued" }] }, 201),
    getJob: () => jobs.shift() ?? ok(doneJob({ id: 11 })),
  });
  const r = await tl.runToolDuplicate(deps, "acct", duplicateBody, { deadlineAt: Date.now() + 60_000, onSubmitted: (id) => seen.push(id) });
  assert.ok(r.ok);
  assert.deepEqual(seen, [11]);
  const seen2: number[] = [];
  const d2 = fakeDeps({ createDuplicates: () => fail(400, "bad_request", "no source") }).deps;
  await tl.runToolDuplicate(d2, "acct", duplicateBody, { deadlineAt: Date.now() + 60_000, onSubmitted: (id) => seen2.push(id) });
  assert.deepEqual(seen2, []); // refused submit → onSubmitted silent
});
