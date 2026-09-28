// Node's built-in runner (v24 strips types natively): `node --test tests/hs-tool-routes.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts imports below are a Node requirement.
//
// The two HS TOOL routes (app/api/hs/tool-launch, app/api/hs/tool-duplicate) are thin NDJSON/pump
// glue over the PURE, dependency-injected orchestration in lib/tool-launch (runToolMedia /
// runToolPublish / runToolDuplicate) plus lib/lion-dup-bid + lib/types. Route files import the "@/"
// alias and next/server, so `node --test` cannot load them — mirroring the repo convention (see
// snap-pump-core.test.ts / launch-stream.test.ts), these tests exercise the exact decisions the
// routes make (name marking, per-shot bid mapping, one-target build, submit→follow result branches)
// against a FAKE ToolDeps, so the wiring's units + branches are verified without a live TOOL call.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TOOL_MARK,
  buildToolDuplicate,
  runToolDuplicate,
  runToolPublish,
  toolEnsureMark,
  type CampaignRequest,
  type DuplicateRequest,
  type ToolCallResult,
  type ToolDeps,
} from "../lib/tool-launch.ts";
import { dupBidPlan } from "../lib/lion-dup-bid.ts";
import { normalizeRoasGoal } from "../lib/types.ts";

// ---- a controllable fake transport (the routes drive lib/tool-run.toolDeps; here we inject) -------

type DepsOverrides = Partial<ToolDeps> & { startAt?: number };

/** A clock that advances by `sleep`, so a pending-deadline path is deterministic. */
function makeDeps(over: DepsOverrides = {}): ToolDeps & { clock: { t: number } } {
  const { startAt, ...depsOver } = over;
  const clock = { t: startAt ?? 0 };
  const base: ToolDeps = {
    createCampaign: async () => ({ ok: true, status: 202, data: { id: 1 } }),
    createDuplicates: async () => ({ ok: true, status: 201, data: { batch_id: "b", status: "queued", jobs: [{ id: 1 }] } }),
    mediaFromUrl: async () => ({ ok: true, status: 201, data: { media_id: "med_1", status: "ready" } }),
    getMedia: async () => ({ ok: true, status: 200, data: { media_id: "med_1", status: "ready" } }),
    getJob: async () => ({ ok: true, status: 200, data: { id: 1, status: "done", result: { created: {} } } }),
    jobEvents: async () => ({ ok: true, status: 200, data: [] }),
    sleep: async (ms: number) => {
      clock.t += ms;
    },
    now: () => clock.t,
  };
  return { ...base, ...depsOver, sleep: depsOver.sleep ?? base.sleep, now: depsOver.now ?? base.now, clock };
}

const ok = <T>(data: T, status = 200): ToolCallResult<T> => ({ ok: true, status, data });

// ================================================================================================
// 1. Name marking — the route stamps `toolEnsureMark(hsFullName(...,"tool"))` (launch) and
//    `toolEnsureMark(name || "Clone of <id>")` (duplicate). GCL TOOL lands in the TOKEN slot and a
//    TOKEN-/SOC- marker is NEVER carried alongside it.
// ================================================================================================

test("TOOL_MARK is the exact GC Launcher · TOOL marker", () => {
  assert.equal(TOOL_MARK, "GCL TOOL - ");
});

test("HS-grammar launch name gets GCL TOOL in the TOKEN slot, no TOKEN marker", () => {
  const name = toolEnsureMark("[28/09] (GLO-01) API - (#ADX [HIGH]) - [BR] - nazar");
  assert.equal(name, "[28/09] (GLO-01) API - (#ADX [HIGH]) - [BR] - GCL TOOL - nazar");
  assert.ok(!/\bTOKEN -/.test(name));
});

test("a TOKEN-marked HS name is corrected to GCL TOOL server-side (client name never trusted)", () => {
  const name = toolEnsureMark("[28/09] (GLO-01) API - (#ADX [HIGH]) - [BR] - TOKEN - nazar");
  assert.equal(name, "[28/09] (GLO-01) API - (#ADX [HIGH]) - [BR] - GCL TOOL - nazar");
});

test("an already-GCL-TOOL name is idempotent", () => {
  const once = toolEnsureMark("[28/09] (GLO-01) API - (#ADX [HIGH]) - [BR] - GCL TOOL - nazar");
  assert.equal(toolEnsureMark(once), once);
});

test("a grammar-less clone label is prepended with GCL TOOL", () => {
  assert.equal(toolEnsureMark("Clone of 120000000001"), "GCL TOOL - Clone of 120000000001");
});

// ================================================================================================
// 2. Per-shot bid mapping — the duplicate pump's exact decision: dupBidPlan (LION v2 switch/inherit
//    rules) → a HUMAN bid, ROAS as a COEFFICIENT (normalizeRoasGoal, never ×10000), cap as USD,
//    bid_strategy ONLY on a switch. Replicated verbatim from the route so the units are pinned.
// ================================================================================================

type ShotBidIn = { bidStrategy: string; bidStrategyOverride: string; bid: number | null };
function toolDupBid(s: ShotBidIn): { refusal: string } | { bid?: number; bidStrategy?: string } {
  const plan = dupBidPlan({ sourceStrategy: s.bidStrategy, override: s.bidStrategyOverride, typedBid: s.bid, sourceCurrency: "", destCurrency: "USD" });
  if ("refusal" in plan) return { refusal: plan.refusal };
  let bid: number | undefined;
  if (plan.human != null) {
    if (plan.kind === "roas") {
      const goal = normalizeRoasGoal(plan.human);
      if (goal == null) return { refusal: "roas goal ambiguous" };
      bid = goal;
    } else {
      bid = plan.human;
    }
  }
  return { ...(bid != null ? { bid } : {}), ...(plan.wireStrategy ? { bidStrategy: plan.wireStrategy } : {}) };
}

test("switched min-ROAS clone → coefficient bid + explicit strategy (percent form normalized)", () => {
  const r = toolDupBid({ bidStrategy: "LOWEST_COST_WITHOUT_CAP", bidStrategyOverride: "LOWEST_COST_WITH_MIN_ROAS", bid: 30 });
  assert.deepEqual(r, { bid: 0.3, bidStrategy: "LOWEST_COST_WITH_MIN_ROAS" }); // 30% → 0,30 coefficient, NOT ×10000
});

test("switched bid-cap clone → USD amount + explicit strategy (no cents)", () => {
  const r = toolDupBid({ bidStrategy: "LOWEST_COST_WITHOUT_CAP", bidStrategyOverride: "LOWEST_COST_WITH_BID_CAP", bid: 0.5 });
  assert.deepEqual(r, { bid: 0.5, bidStrategy: "LOWEST_COST_WITH_BID_CAP" }); // $0,50 as USD, NOT 50 cents
});

test("unswitched clone inherits: no bid, no strategy on the wire (TOOL keeps the source's)", () => {
  const r = toolDupBid({ bidStrategy: "LOWEST_COST_WITH_MIN_ROAS", bidStrategyOverride: "", bid: null });
  assert.deepEqual(r, {});
});

test("switch to lowest cost → strategy only, no bid", () => {
  const r = toolDupBid({ bidStrategy: "LOWEST_COST_WITH_MIN_ROAS", bidStrategyOverride: "LOWEST_COST_WITHOUT_CAP", bid: null });
  assert.deepEqual(r, { bidStrategy: "LOWEST_COST_WITHOUT_CAP" });
});

test("a typed bid on a lowest-cost (no switch) source is refused, not silently dropped", () => {
  const r = toolDupBid({ bidStrategy: "LOWEST_COST_WITHOUT_CAP", bidStrategyOverride: "", bid: 0.5 });
  assert.ok("refusal" in r);
});

test("the ambiguous 10–20 ROAS band is refused (never guessed)", () => {
  const r = toolDupBid({ bidStrategy: "LOWEST_COST_WITHOUT_CAP", bidStrategyOverride: "LOWEST_COST_WITH_MIN_ROAS", bid: 15 });
  assert.ok("refusal" in r);
});

// ================================================================================================
// 3. buildToolDuplicate — the one-target request the pump submits: copies:1, status/ad_status ACTIVE,
//    USD budget, coefficient bid, page/pixel/start_time, source id.
// ================================================================================================

test("a duplicate shot builds ONE ACTIVE target with USD budget + coefficient bid + binds", () => {
  const built = buildToolDuplicate({
    sourceCampaignId: "120000000123",
    accountId: "act_555",
    pageId: "999",
    pixelId: "777",
    name: "[28/09] (GLO-01) API - (#ADX [HIGH]) - [BR] - GCL TOOL - clone",
    budgetUsd: 10,
    bid: 0.3,
    bidStrategy: "LOWEST_COST_WITH_MIN_ROAS",
    status: "ACTIVE",
    startTime: "2026-09-28T12:30:00.000Z",
  });
  assert.ok(built.ok);
  const body = (built as { ok: true; body: DuplicateRequest }).body;
  assert.equal(body.source_campaign_id, "120000000123");
  assert.equal(body.targets.length, 1);
  const t = body.targets[0];
  assert.equal(t.copies, 1);
  assert.equal(t.status, "ACTIVE");
  assert.equal(t.ad_status, "ACTIVE");
  assert.equal(t.daily_budget, 10); // USD number, not cents
  assert.equal(t.bid, 0.3); // coefficient, not ×10000
  assert.equal(t.bid_strategy, "LOWEST_COST_WITH_MIN_ROAS");
  assert.equal(t.page_id, "999");
  assert.equal(t.pixel_id, "777");
  assert.equal(t.start_time, "2026-09-28T12:30:00.000Z");
});

test("buildToolDuplicate refuses a sub-$1 budget by name", () => {
  const built = buildToolDuplicate({
    sourceCampaignId: "120000000123",
    accountId: "555",
    pageId: "9",
    pixelId: "7",
    name: "x",
    budgetUsd: 0,
    status: "ACTIVE",
  });
  assert.equal(built.ok, false);
});

// ================================================================================================
// 4. runToolDuplicate — the pump's submit→follow, through the fake transport. The pump branches on
//    exactly these three shapes: ok (done), pending (deadline), clean failure (refusal).
// ================================================================================================

const dupBody: DuplicateRequest = { source_campaign_id: "120000000123", targets: [{ account_id: "555", copies: 1, status: "ACTIVE" }] };

test("runToolDuplicate happy path → done with the created ids, and forwards the Idempotency-Key", async () => {
  let sawKey = "";
  let jobCalls = 0;
  const deps = makeDeps({
    createDuplicates: async (_acct, _body, opts) => {
      sawKey = opts?.idempotencyKey ?? "";
      return ok({ batch_id: "b1", status: "queued", jobs: [{ id: 42 }] }, 201);
    },
    getJob: async () => {
      jobCalls += 1;
      return jobCalls < 2
        ? ok({ id: 42, status: "running" })
        : ok({ id: 42, status: "done", result: { created: { campaign_id: "c1", adset_ids: ["as1"], ad_ids: ["ad1", "ad2"] } } });
    },
  });
  const run = await runToolDuplicate(deps, "555", dupBody, { idempotencyKey: "hstld-w-00", deadlineAt: 10 * 60_000 });
  assert.equal(run.ok, true);
  assert.equal(sawKey, "hstld-w-00");
  if (run.ok) {
    assert.equal(run.jobId, 42);
    assert.equal(run.campaignId, "c1");
    assert.equal(run.adsetId, "as1");
    assert.deepEqual(run.adIds, ["ad1", "ad2"]);
  }
});

test("runToolDuplicate: a 4xx submit is a clean refusal — nothing created (slot gets released)", async () => {
  const deps = makeDeps({
    createDuplicates: async () => ({ ok: false, status: 422, error: "invalid_request", message: "bad target" }),
  });
  const run = await runToolDuplicate(deps, "555", dupBody, { idempotencyKey: "k", deadlineAt: 10 * 60_000 });
  assert.equal(run.ok, false);
  if (!run.ok) {
    assert.equal(run.pending, undefined); // NOT pending → the pump releases the slot
    assert.equal(run.created, undefined);
    assert.match(run.error, /bad target/);
  }
});

test("runToolDuplicate: deadline hit while still running → pending with the job id (slot kept)", async () => {
  const deps = makeDeps({
    createDuplicates: async () => ok({ batch_id: "b1", status: "queued", jobs: [{ id: 42 }] }, 201),
    getJob: async () => ok({ id: 42, status: "running" }), // never terminal
  });
  const run = await runToolDuplicate(deps, "555", dupBody, { idempotencyKey: "k", deadlineAt: 1_000 });
  assert.equal(run.ok, false);
  if (!run.ok) {
    assert.equal(run.pending, true);
    assert.equal(run.jobId, 42);
  }
});

// ================================================================================================
// 5. runToolPublish — the launch route's submit→follow. Same three branches, plus the live 28.09
//    fact: with no live session TOOL answers HTTP 200 carrying a `missing_context` problem and NO
//    job id → a clean refusal with the actionable session sentence, never a false "pending".
// ================================================================================================

const campBody: CampaignRequest = {
  campaign: { name: "n", objective: "OUTCOME_SALES", budget_type: "CAMPAIGN", daily_budget: 10 },
  adsets: [{ name: "n", optimization_goal: "OFFSITE_CONVERSIONS", targeting: { countries: ["BR"] }, ads: [{ name: "n", creative: {} }] }],
};

test("runToolPublish happy path → done with campaign/adset/ad ids", async () => {
  let calls = 0;
  const deps = makeDeps({
    createCampaign: async () => ok({ id: 7 }, 202),
    getJob: async () => {
      calls += 1;
      return calls < 2
        ? ok({ id: 7, status: "running" })
        : ok({ id: 7, status: "done", result: { created: { campaign_id: "c9", adset_ids: ["as9"], ad_ids: ["ad9"] } } });
    },
  });
  const run = await runToolPublish(deps, "555", campBody, { idempotencyKey: "t", deadlineAt: 10 * 60_000 });
  assert.equal(run.ok, true);
  if (run.ok) {
    assert.equal(run.campaignId, "c9");
    assert.equal(run.adsetId, "as9");
    assert.deepEqual(run.adIds, ["ad9"]);
  }
});

test("runToolPublish: no live session → 200 + missing_context problem, no job id → clean refusal", async () => {
  const deps = makeDeps({
    createCampaign: async () =>
      ok(
        {
          problems: [{ error: "missing_context", field: "session_id/account_id", message: "нет активной сессии с доступом к кабинету 555" }],
        },
        200,
      ),
  });
  const run = await runToolPublish(deps, "555", campBody, { idempotencyKey: "t", deadlineAt: 10 * 60_000 });
  assert.equal(run.ok, false);
  if (!run.ok) {
    assert.equal(run.pending, undefined); // a refusal, NOT pending — nothing was created
    assert.match(run.error, /No live TOOL session sees/);
    assert.match(run.error, /555/);
  }
});

test("runToolPublish: a 5xx / network submit is PENDING, not a refusal (ambiguous outcome)", async () => {
  const deps = makeDeps({
    createCampaign: async () => ({ ok: false, status: 502, error: "tool_unreachable", message: "TOOL Sessions unreachable" }),
  });
  const run = await runToolPublish(deps, "555", campBody, { idempotencyKey: "t", deadlineAt: 10 * 60_000 });
  assert.equal(run.ok, false);
  if (!run.ok) assert.equal(run.pending, true);
});
