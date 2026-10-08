// Node's built-in runner (v24 strips types natively): `node --test tests/launch-queue-types.test.ts`.
// The PURE contract of the server-side launch queue (lib/launch-queue-types.ts): hand-off validation
// (parseEnqueue), the verdict a finished run turns into for EVERY kind (outcomeOf), the task-row
// patches, and the small pure helpers. No store, no network — every input is injected.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BEACON_FRESH_MS,
  CANCELED_STAGE,
  HEARTBEAT_MS,
  JOB_LEASE_MS,
  LANE_LEASE_MS,
  REAP_GRACE_MS,
  INTERRUPTED_MSG,
  JOB_SCHEMA_VERSION,
  SCOPE_PARTNER,
  SWEEP_LATE_MS,
  canceledRow,
  closingRowFor,
  firstStage,
  handlerBody,
  isNewerBuild,
  isSuperseded,
  jobMediaUrls,
  laneOf,
  outcomeOf,
  parseEnqueue,
  queuedRow,
  reapedRow,
  runningRow,
  sweepLateMinutes,
  unsupportedOutcome,
  unsupportedReason,
  worstCaseMs,
  type EnqueueInput,
  type JobRow,
  type QueueJob,
  type QueueKind,
  type RunReply,
} from "../lib/launch-queue-types.ts";

// ---------------------------------------------------------------------------
// parseEnqueue
// ---------------------------------------------------------------------------

const row = (over: Partial<JobRow> = {}): JobRow => ({ name: "Camp", gcm: "mk01", geo: "US", budget: "10", bid: "", ...over });
const goodJob = (over: Record<string, unknown> = {}) => ({
  taskId: "task-000001",
  kind: "mo.launch" as QueueKind,
  body: { medias: [{ url: "https://cdn.example.com/v.mp4" }] },
  row: row(),
  account: "123456789",
  ...over,
});
const ok = (raw: unknown): EnqueueInput => {
  const r = parseEnqueue(raw);
  assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r)}`);
  return (r as { ok: true; value: EnqueueInput }).value;
};
const err = (raw: unknown): string => {
  const r = parseEnqueue(raw);
  assert.equal(r.ok, false, `expected refusal, got ${JSON.stringify(r)}`);
  return (r as { ok: false; error: string }).error;
};

test("parseEnqueue: every refusal path", () => {
  assert.match(err(null), /bad_request/);
  assert.match(err("nope"), /bad_request/);
  assert.match(err([]), /bad_request/);
  assert.match(err({ scope: "zz", jobs: [goodJob()] }), /bad_scope/);
  assert.match(err({ scope: "mo", jobs: [] }), /no_jobs/);
  assert.match(err({ scope: "mo" }), /no_jobs/);
  assert.match(err({ scope: "mo", jobs: Array.from({ length: 41 }, (_, i) => goodJob({ taskId: `task-0000${i}` })) }), /too_many_jobs \(max 40\)/);
  assert.match(err({ scope: "mo", jobs: ["nope"] }), /job 1: bad_job/);
  assert.match(err({ scope: "mo", jobs: [goodJob({ taskId: "no" })] }), /job 1: bad_task_id/);
  assert.match(err({ scope: "mo", jobs: [goodJob({ taskId: "bad id!" })] }), /job 1: bad_task_id/);
  assert.match(err({ scope: "mo", jobs: [goodJob(), goodJob()] }), /job 2: duplicate_task_id/);
  // kind not allowed in the scope (av.launch is not an mo kind; hs.lion is not either)
  assert.match(err({ scope: "mo", jobs: [goodJob({ kind: "av.launch" })] }), /job 1: bad_kind/);
  assert.match(err({ scope: "mo", jobs: [goodJob({ kind: "hs.lion" })] }), /job 1: bad_kind/);
  assert.match(err({ scope: "mo", jobs: [goodJob({ body: "nope" })] }), /job 1: bad_body/);
  // a non-clone job with no media
  assert.match(err({ scope: "mo", jobs: [goodJob({ body: { medias: [] } })] }), /job 1: media_required/);
  // body over the size cap
  assert.match(err({ scope: "mo", jobs: [goodJob({ body: { medias: [{ url: "https://cdn.example.com/v.mp4" }], blob: "x".repeat(200_001) } })] }), /job 1: body_too_large/);
});

test("parseEnqueue: a creative that never left the browser is refused (blob: / pending.local / non-http)", () => {
  assert.match(err({ scope: "mo", jobs: [goodJob({ body: { medias: [{ url: "blob:https://app/abc" }] } })] }), /job 1: creative_not_uploaded/);
  assert.match(err({ scope: "mo", jobs: [goodJob({ body: { medias: [{ url: "https://pending.local/x.mp4" }] } })] }), /job 1: creative_not_uploaded/);
  assert.match(err({ scope: "mo", jobs: [goodJob({ body: { medias: [{ url: "data:video/mp4;base64,AAAA" }] } })] }), /job 1: creative_not_uploaded/);
  // a cover that is still a blob is caught too
  assert.match(err({ scope: "mo", jobs: [goodJob({ body: { medias: [{ url: "https://cdn.example.com/v.mp4", coverUrl: "blob:https://app/cover" }] } })] }), /job 1: creative_not_uploaded/);
});

test("parseEnqueue: the body's own taskId / taskIds are stripped (the pump stamps them)", () => {
  const v = ok({ scope: "mo", jobs: [goodJob({ body: { medias: [{ url: "https://cdn.example.com/v.mp4" }], taskId: "SNEAKY", taskIds: ["X", "Y"], landing: "keep" } })] });
  assert.equal("taskId" in v.jobs[0].body, false);
  assert.equal("taskIds" in v.jobs[0].body, false);
  assert.equal(v.jobs[0].body.landing, "keep", "other body fields survive");
});

test("parseEnqueue: HS rows carry their kind tag in gcm; MO/AIF/AV keep the previewed gcm", () => {
  const hs = ok({
    scope: "hs",
    jobs: [
      { taskId: "task-hslion", kind: "hs.lion", body: { creatives: ["https://cdn.example.com/a.mp4"] }, row: row({ gcm: "ignored" }), account: "123456789" },
      { taskId: "task-hstoken", kind: "hs.token", body: { creatives: [{ url: "https://cdn.example.com/b.mp4" }] }, row: row({ gcm: "ignored" }), account: "123456789" },
      { taskId: "task-hstool", kind: "hs.tool", body: { creatives: [{ url: "https://cdn.example.com/c.mp4" }] }, row: row({ gcm: "ignored" }), account: "123456789" },
    ],
  });
  assert.deepEqual(hs.jobs.map((j) => j.row.gcm), ["launch", "token", "tool"]);
  const mo = ok({ scope: "mo", jobs: [goodJob({ row: row({ gcm: "mk42" }) })] });
  assert.equal(mo.jobs[0].row.gcm, "mk42");
});

test("parseEnqueue: account normalisation (act_ stripped, numeric only, else null)", () => {
  assert.equal(ok({ scope: "mo", jobs: [goodJob({ account: "act_987654321" })] }).jobs[0].account, "987654321");
  assert.equal(ok({ scope: "mo", jobs: [goodJob({ account: "987654321" })] }).jobs[0].account, "987654321");
  assert.equal(ok({ scope: "mo", jobs: [goodJob({ account: "abc" })] }).jobs[0].account, null);
  assert.equal(ok({ scope: "mo", jobs: [goodJob({ account: "" })] }).jobs[0].account, null);
  assert.equal(ok({ scope: "mo", jobs: [goodJob({ account: "123" })] }).jobs[0].account, null, "too short is not a numeric account");
});

test("parseEnqueue: row strings are clamped", () => {
  const v = ok({ scope: "mo", jobs: [goodJob({ row: row({ name: "n".repeat(400), geo: "g".repeat(300), budget: "b".repeat(80), bid: "x".repeat(80) }) })] });
  const r = v.jobs[0].row;
  assert.equal(r.name.length, 300);
  assert.equal(r.geo.length, 200);
  assert.equal(r.budget.length, 40);
  assert.equal(r.bid.length, 40);
});

test("parseEnqueue: the 40-job cap admits exactly 40", () => {
  const v = ok({ scope: "mo", jobs: Array.from({ length: 40 }, (_, i) => goodJob({ taskId: `task-0000${i}` })) });
  assert.equal(v.jobs.length, 40);
});

test("parseEnqueue: fb.clone needs no media", () => {
  const v = ok({ scope: "mo", jobs: [{ taskId: "task-clone1", kind: "fb.clone", body: { edits: [{ budget: "10" }] }, row: row(), account: "123456789" }] });
  assert.equal(v.jobs[0].kind, "fb.clone");
  // and even a clone with a bad media url is NOT refused on media grounds (it carries none)
  const v2 = ok({ scope: "mo", jobs: [{ taskId: "task-clone2", kind: "fb.clone", body: {}, row: row(), account: null }] });
  assert.equal(v2.jobs[0].account, null);
});

// ---------------------------------------------------------------------------
// jobMediaUrls / firstStage / worstCaseMs / laneOf / handlerBody
// ---------------------------------------------------------------------------

test("jobMediaUrls: each kind's media shape", () => {
  assert.deepEqual(
    jobMediaUrls("mo.launch", { medias: [{ url: "https://a", coverUrl: "https://a-cov" }, { url: "https://b" }], mediaUrl: "https://c", coverUrl: "https://d" }),
    ["https://a", "https://a-cov", "https://b", "https://c", "https://d"],
  );
  assert.deepEqual(jobMediaUrls("hs.lion", { creatives: ["https://x", "https://y", ""] }), ["https://x", "https://y"]);
  assert.deepEqual(jobMediaUrls("hs.token", { creatives: [{ url: "https://u", cover: "https://cv" }, { url: "https://u2" }] }), ["https://u", "https://cv", "https://u2"]);
  assert.deepEqual(jobMediaUrls("fb.clone", { edits: [] }), []);
});

test("firstStage / worstCaseMs / laneOf", () => {
  assert.equal(firstStage("fb.clone"), "source");
  assert.equal(firstStage("hs.lion"), "submit");
  assert.equal(firstStage("hs.token"), "submit");
  assert.equal(firstStage("hs.tool"), "submit");
  assert.equal(firstStage("mo.launch"), "gcm");
  assert.equal(firstStage("aif.launch"), "gcm");
  assert.equal(firstStage("av.launch"), "gcm");
  assert.equal(worstCaseMs("hs.lion"), 310_000, "in-process the LION route can spend minutes on cold catalog reads before the submit");
  for (const k of ["mo.launch", "aif.launch", "av.launch", "fb.clone", "hs.token", "hs.tool"] as QueueKind[]) assert.equal(worstCaseMs(k), 310_000);
  assert.equal(laneOf("mo", "nazar"), "mo:nazar");
  assert.equal(laneOf("hs", "tima"), "hs:tima");
});

test("handlerBody: clones get taskIds, everything else gets taskId", () => {
  assert.deepEqual(handlerBody({ kind: "fb.clone", body: { edits: [1] }, job_id: "J1" }), { edits: [1], taskIds: ["J1"] });
  assert.deepEqual(handlerBody({ kind: "mo.launch", body: { medias: [] }, job_id: "J2" }), { medias: [], taskId: "J2" });
  assert.deepEqual(handlerBody({ kind: "hs.lion", body: { creatives: [] }, job_id: "J3" }), { creatives: [], taskId: "J3" });
});

// ---------------------------------------------------------------------------
// row patches
// ---------------------------------------------------------------------------

const jobOf = (over: Partial<QueueJob> = {}): QueueJob => ({
  job_id: "J", owner: "nazar", role: "buyer", sub: "u1", scope: "mo", kind: "mo.launch",
  lane: "mo:nazar", partner: "in", account: null, body: {}, row: row(),
  status: "queued", retryable: false, attempts: 0, seq: 1, queued_at: 1000,
  started_at: null, finished_at: null, lease_until: null, runner: null, error: null, result: null,
  ...over,
});

test("queuedRow: srv/retry flags, nulled result fields, HS gets a submit stage", () => {
  const r = queuedRow(jobOf({ kind: "mo.launch", partner: "in", row: row({ name: "N", gcm: "g", geo: "US", budget: "10", bid: "" }), queued_at: 1234 }));
  assert.equal(r.srv, 1);
  assert.equal(r.retry, 0);
  assert.equal(r.status, "queued");
  assert.equal(r.stage, null);
  assert.equal(r.partner, "in");
  assert.equal(r.queued_at, 1234);
  assert.deepEqual([r.campaign_id, r.adset_id, r.ad_id, r.link, r.error, r.started_at, r.finished_at], [null, null, null, null, null, null, null]);
  assert.equal("bid" in r, false, "an empty bid is omitted");
  const withBid = queuedRow(jobOf({ row: row({ bid: "auto" }) }));
  assert.equal(withBid.bid, "auto");
  const hs = queuedRow(jobOf({ kind: "hs.lion", partner: "br" }));
  assert.equal(hs.stage, "submit");
});

test("runningRow / canceledRow / reapedRow", () => {
  const run = runningRow(jobOf({ kind: "fb.clone", partner: "in" }), 5000);
  assert.deepEqual([run.srv, run.retry, run.status, run.stage, run.started_at, run.error], [1, 0, "running", "source", 5000, null]);

  const can = canceledRow(jobOf({ partner: "us" }), 6000);
  assert.deepEqual([can.srv, can.retry, can.status, can.stage, can.error, can.finished_at], [1, 1, "error", CANCELED_STAGE, "Canceled before it started", 6000]);

  const reapMo = reapedRow(jobOf({ kind: "mo.launch", partner: "in" }), 7000);
  assert.deepEqual([reapMo.srv, reapMo.retry, reapMo.status, reapMo.error, reapMo.finished_at], [1, 0, "error", INTERRUPTED_MSG, 7000]);
  const reapHs = reapedRow(jobOf({ kind: "hs.token", partner: "br" }), 7000);
  assert.equal(reapHs.status, "interrupted", "HS reaped rows use the interrupted status");
});

test("SCOPE_PARTNER mapping", () => {
  assert.deepEqual(SCOPE_PARTNER, { mo: "in", aif: "us", av: "av", hs: "br" });
});

// ---------------------------------------------------------------------------
// outcomeOf — every branch of every kind
// ---------------------------------------------------------------------------

const reply = (over: Partial<RunReply> = {}): RunReply => ({ httpStatus: 200, streamed: true, final: null, lastStage: null, ...over });
const NOW = 9000;
const jb = (kind: QueueKind, body: Record<string, unknown> = {}): Pick<QueueJob, "kind" | "partner" | "body"> => ({ kind, partner: SCOPE_PARTNER[kind.startsWith("hs") ? "hs" : kind === "fb.clone" ? "mo" : (kind.split(".")[0] as "mo" | "aif" | "av")], body });

test("outcomeOf: a clean done for mo / aif / av", () => {
  for (const kind of ["mo.launch", "aif.launch", "av.launch"] as QueueKind[]) {
    const o = outcomeOf(jb(kind), reply({ final: { ok: true, campaign_id: "c1", adset_id: "s1", ad_id: "a1", gcm: "mk7", link: "https://x" }, lastStage: "ad" }), NOW);
    assert.equal(o.status, "done");
    assert.equal(o.retryable, false);
    assert.equal(o.ambiguous, false);
    assert.equal(o.openRow, null);
    assert.deepEqual(o.result, { campaign_id: "c1", adset_id: "s1", ad_id: "a1", gcm: "mk7", link: "https://x" });
    assert.equal(o.row.srv, 1);
    assert.equal(o.row.retry, 0);
    assert.equal(o.row.status, "done");
    assert.equal(o.row.stage, "ad");
    assert.equal(o.row.campaign_id, "c1");
    assert.equal(o.row.gcm, "mk7");
    assert.equal(o.row.link, "https://x");
  }
});

test("outcomeOf: a clone done carries no link", () => {
  const o = outcomeOf(jb("fb.clone"), reply({ final: { ok: true, campaign_id: "c1", adset_id: "s1", ad_id: "a1", gcm: "mk7", link: "https://nope" }, lastStage: "ad" }), NOW);
  assert.equal(o.status, "done");
  assert.equal(o.result?.link, undefined, "the clone's own link is never adopted");
  assert.equal("link" in o.row, false);
  assert.equal(o.result?.campaign_id, "c1");
});

test("outcomeOf: HS token / tool done — ad_id is the ad COUNT as a string", () => {
  for (const kind of ["hs.token", "hs.tool"] as QueueKind[]) {
    const o = outcomeOf(jb(kind, { creatives: [{ url: "a" }, { url: "b" }, { url: "c" }] }), reply({ final: { ok: true, campaign_id: "c9", adset_id: "s9", name: "Nm" } }), NOW);
    assert.equal(o.status, "done");
    assert.equal(o.row.stage, "ads");
    assert.equal(o.row.ad_id, "3", "no ad_ids in the reply → the creative count, as a string");
    assert.equal(typeof o.row.ad_id, "string");
    assert.deepEqual(o.result, { campaign_id: "c9", adset_id: "s9", ad_id: "3", name: "Nm" }, "the job records the ad count too — the row check restores a row from it");
    // with an explicit ad_ids array that count wins
    const o2 = outcomeOf(jb(kind, { creatives: [{ url: "a" }] }), reply({ final: { ok: true, campaign_id: "c9", adset_id: "s9", ad_ids: ["x", "y"] } }), NOW);
    assert.equal(o2.row.ad_id, "2");
  }
});

test("outcomeOf: HS LION done — acceptance IS terminal (stage queue, link = lionTaskId)", () => {
  const o = outcomeOf(jb("hs.lion"), reply({ streamed: false, final: { ok: true, lionTaskId: "LT-1", name: "Camp" } }), NOW);
  assert.equal(o.status, "done");
  assert.equal(o.retryable, false);
  assert.equal(o.ambiguous, false);
  assert.equal(o.row.stage, "queue");
  assert.equal(o.row.link, "LT-1");
  assert.equal(o.row.finished_at, NOW);
  assert.deepEqual(o.result, { link: "LT-1", name: "Camp" });
});

test("outcomeOf: clean error WITHOUT a created campaign is retryable", () => {
  const o = outcomeOf(jb("mo.launch"), reply({ httpStatus: 400, final: { ok: false, error: "pixel missing", stage: "pixel" }, lastStage: "pixel" }), NOW);
  assert.equal(o.status, "error");
  assert.equal(o.retryable, true);
  assert.equal(o.ambiguous, false);
  assert.equal(o.openRow, null);
  assert.equal(o.result, null);
  assert.equal(o.row.retry, 1);
  assert.equal(o.row.status, "error");
  assert.equal(o.row.error, "pixel missing");
});

test("outcomeOf: clean error WITH a created campaign is NOT retryable and keeps the ids", () => {
  const o = outcomeOf(jb("mo.launch"), reply({ final: { ok: false, error: "adset failed", created: { campaign_id: "C1", adset_id: "S1" } }, lastStage: "adset" }), NOW);
  assert.equal(o.status, "error");
  assert.equal(o.retryable, false, "a live campaign must never be blind-retried");
  assert.equal(o.ambiguous, false);
  assert.equal(o.row.retry, 0);
  assert.equal(o.row.campaign_id, "C1");
  assert.equal(o.row.adset_id, "S1");
  assert.deepEqual(o.result, { campaign_id: "C1", adset_id: "S1" });
});

test("outcomeOf: a pre-run JSON rejection (not streamed) with no created campaign is retryable", () => {
  const o = outcomeOf(jb("aif.launch"), reply({ streamed: false, httpStatus: 409, final: { ok: false, error: "account limit: 5 / 30 min" }, lastStage: null }), NOW);
  assert.equal(o.status, "error");
  assert.equal(o.retryable, true);
  assert.equal(o.row.error, "account limit: 5 / 30 min");
  assert.equal(o.row.stage, firstStage("aif.launch"));
});

test("outcomeOf: TOOL pending — ambiguous, not retryable, HS vs non-HS open-row status", () => {
  const tool = outcomeOf(jb("hs.tool"), reply({ final: { ok: false, pending: true, error: "TOOL still building" }, lastStage: "submit" }), NOW);
  assert.equal(tool.status, "error");
  assert.equal(tool.retryable, false);
  assert.equal(tool.ambiguous, true);
  assert.equal("status" in tool.row, false, "an ambiguous outcome's row carries ONLY the flags, never a status");
  assert.equal(tool.openRow?.status, "interrupted");
  assert.equal(tool.openRow?.error, "TOOL still building");
  const av = outcomeOf(jb("av.launch"), reply({ final: { pending: true }, lastStage: "gcm" }), NOW);
  assert.equal(av.ambiguous, true);
  assert.equal(av.openRow?.status, "error", "non-HS pending opens as error, not interrupted");
});

test("outcomeOf: no verdict at all — ambiguous, never retryable", () => {
  const o = outcomeOf(jb("mo.launch"), reply({ httpStatus: 502, final: null, lastStage: "adset" }), NOW);
  assert.equal(o.status, "error");
  assert.equal(o.retryable, false);
  assert.equal(o.ambiguous, true);
  assert.equal("status" in o.row, false);
  assert.equal(o.openRow?.status, "error");
  assert.match(String(o.openRow?.error), /without a verdict/);
  assert.equal(o.openRow?.stage, "adset");
});

test("outcomeOf: a handler that THREW — retryable for the streaming rails, ambiguous for hs.lion", () => {
  for (const kind of ["mo.launch", "aif.launch", "av.launch", "fb.clone", "hs.token", "hs.tool"] as QueueKind[]) {
    const o = outcomeOf(jb(kind), reply({ thrown: "boom", httpStatus: 500 }), NOW);
    assert.equal(o.status, "error");
    assert.equal(o.retryable, true, `${kind}: a throw is BEFORE any create on the streaming rails`);
    assert.equal(o.ambiguous, false);
    assert.equal(o.openRow, null);
    assert.equal(o.row.retry, 1);
    assert.match(String(o.row.error), /launch failed to start: boom/);
  }
  const lion = outcomeOf(jb("hs.lion"), reply({ thrown: "boom", httpStatus: 500 }), NOW);
  assert.equal(lion.retryable, false, "a LION submit has no such guarantee — the create may have landed");
  assert.equal(lion.ambiguous, true);
  assert.equal("status" in lion.row, false);
  assert.equal(lion.openRow?.status, "interrupted");
});

test("outcomeOf: an AMBIGUOUS LION submit (lion_create_failed / no reply) is not retryable", () => {
  const amb = outcomeOf(jb("hs.lion"), reply({ streamed: false, final: { ok: false, error: "lion_create_failed: 503" } }), NOW);
  assert.equal(amb.status, "error");
  assert.equal(amb.retryable, false);
  assert.equal(amb.ambiguous, true);
  assert.equal(amb.openRow?.status, "interrupted");
  assert.match(String(amb.openRow?.error), /may have reached LION/);
  // no reply body at all → same treatment
  const none = outcomeOf(jb("hs.lion"), reply({ streamed: false, final: null, httpStatus: 504 }), NOW);
  assert.equal(none.retryable, false);
  assert.equal(none.ambiguous, true);
  assert.equal(none.openRow?.status, "interrupted");
});

test("outcomeOf: a CLEAN LION error (not ambiguous) stays retryable", () => {
  const o = outcomeOf(jb("hs.lion"), reply({ streamed: false, httpStatus: 400, final: { ok: false, error: "geo not allowed" } }), NOW);
  assert.equal(o.status, "error");
  assert.equal(o.retryable, true);
  assert.equal(o.ambiguous, false);
  assert.equal(o.row.retry, 1);
  assert.equal(o.row.error, "geo not allowed");
});

test("outcomeOf: EVERY outcome's row carries srv:1; ambiguous rows never carry a status", () => {
  const cases: RunReply[] = [
    reply({ final: { ok: true, campaign_id: "c" }, lastStage: "ad" }),
    reply({ final: { ok: false, error: "e" } }),
    reply({ final: { ok: false, pending: true } }),
    reply({ final: null }),
    reply({ thrown: "x" }),
  ];
  for (const kind of ["mo.launch", "fb.clone", "hs.lion", "hs.token", "hs.tool"] as QueueKind[]) {
    for (const rp of cases) {
      const o = outcomeOf(jb(kind), rp, NOW);
      assert.equal(o.row.srv, 1, `${kind}: row must stamp srv`);
      if (o.ambiguous) assert.equal("status" in o.row, false, `${kind}: ambiguous row holds only flags`);
      else assert.ok("status" in o.row, `${kind}: a settled row carries its status`);
    }
  }
});

// ---------------------------------------------------------------------------
// updates: versions, the build beacon, the sweep-late notice
// ---------------------------------------------------------------------------

test("unsupportedReason: a newer document shape or an unknown kind; a document without v is version 1", () => {
  assert.equal(unsupportedReason({ kind: "mo.launch" }), null);
  assert.equal(unsupportedReason({ kind: "hs.tool", v: JOB_SCHEMA_VERSION }), null);
  assert.equal(unsupportedReason({ kind: "mo.launch", v: JOB_SCHEMA_VERSION + 1 }), "version");
  assert.equal(unsupportedReason({ kind: "xx.future" as QueueKind }), "kind");
});

test("unsupportedOutcome: a clean refusal — retryable, nothing ambiguous, the row says nothing was sent", () => {
  const o = unsupportedOutcome({ partner: "br" }, "version", 123);
  assert.deepEqual([o.status, o.retryable, o.ambiguous, o.openRow, o.result], ["error", true, false, null, null]);
  assert.deepEqual(
    { srv: o.row.srv, retry: o.row.retry, status: o.row.status, partner: o.row.partner, finished_at: o.row.finished_at },
    { srv: 1, retry: 1, status: "error", partner: "br", finished_at: 123 },
  );
  assert.match(String(o.row.error), /newer version.*nothing was sent/);
  assert.match(String(unsupportedOutcome({ partner: "in" }, "kind", 1).error), /not supported by the version running now/);
});

test("isSuperseded: only toward a NEWER build that is being swept right now", () => {
  const now = 10_000_000;
  const mine = "2026-10-08T06:36:00.000Z";
  const newer = "2026-10-08T07:21:00.000Z";
  const older = "2026-10-07T22:00:00.000Z";
  assert.equal(isSuperseded({ build: newer, at: now - 20_000 }, mine, now), true);
  assert.equal(isSuperseded({ build: mine, at: now - 20_000 }, mine, now), false, "the current build never yields");
  assert.equal(isSuperseded({ build: older, at: now - 20_000 }, mine, now), false, "never down: a rollback, or this build's first minute");
  assert.equal(isSuperseded({ build: newer, at: now - BEACON_FRESH_MS - 1 }, mine, now), false, "a stale beacon proves nothing");
  assert.equal(isSuperseded(null, mine, now), false);
  assert.equal(isSuperseded({ build: newer, at: now }, "", now), false, "a pump that does not know its build never yields");
  assert.equal(isSuperseded({ build: "", at: now }, mine, now), false);
});

test("sweepLateMinutes: said only when a job has waited AND the sweep has been silent", () => {
  const min = 60_000;
  const now = 100 * min;
  assert.equal(sweepLateMinutes(null, now), null);
  assert.equal(sweepLateMinutes({ sweptAt: now - 30 * min, oldestQueuedAt: null }, now), null, "nothing waiting");
  assert.equal(sweepLateMinutes({ sweptAt: now - 30 * min, oldestQueuedAt: now - 1 * min }, now), null, "the job only just arrived");
  assert.equal(sweepLateMinutes({ sweptAt: now - 20_000, oldestQueuedAt: now - 30 * min }, now), null, "a long lane under a live sweep");
  assert.equal(sweepLateMinutes({ sweptAt: now - 7 * min - 5_000, oldestQueuedAt: now - 9 * min }, now), 7);
  assert.equal(sweepLateMinutes({ sweptAt: null, oldestQueuedAt: now - 4 * min }, now), 4, "never swept: late since the job arrived");
  assert.equal(sweepLateMinutes({ sweptAt: now - SWEEP_LATE_MS, oldestQueuedAt: now - SWEEP_LATE_MS }, now), 3);
});

test("the lane lease outlives a job's lease plus the reap grace — a lane can only change hands after its job is dead", () => {
  // The order is the guard: with the lane lease SHORTER, a lane whose heartbeats stalled became free
  // while its job was still validly running, and a second pump started the next job beside it.
  assert.ok(LANE_LEASE_MS >= JOB_LEASE_MS + REAP_GRACE_MS, "lane ≥ job + grace");
  assert.ok(JOB_LEASE_MS >= 4 * HEARTBEAT_MS, "a job survives several missed heartbeats");
});

test("isNewerBuild: only two ISO build stamps are comparable — a foreign value in the shared document is never 'newer'", () => {
  const a = "2026-10-08T06:36:00.000Z";
  const b = "2026-10-08T07:21:00.000Z";
  assert.equal(isNewerBuild(b, a), true);
  assert.equal(isNewerBuild(a, b), false);
  assert.equal(isNewerBuild(a, a), false);
  for (const junk of ["", "build-xyz-b", "zzz", "2026-10-08", "9999", "2026-10-08T07:21:00"]) {
    assert.equal(isNewerBuild(junk, a), false, junk);
    assert.equal(isNewerBuild(b, junk), false, junk);
  }
  // …so a beacon written by anything that is not a real build can never make a pump step aside.
  assert.equal(isSuperseded({ build: "build-muz-b", at: 1000 }, a, 2000), false);
});

test("closingRowFor: what a row that stayed open becomes once its job is not open any more", () => {
  const base = { kind: "mo.launch" as QueueKind, partner: "in", retryable: false, error: null, result: null, finished_at: 5000 };
  // still queued / running → the row is right to be open
  assert.equal(closingRowFor({ ...base, status: "queued" }, "in", 9000), null);
  assert.equal(closingRowFor({ ...base, status: "running" }, "in", 9000), null);
  // done → done at the rail's final stage, with the ids the job recorded
  assert.deepEqual(closingRowFor({ ...base, status: "done", result: { campaign_id: "c1", adset_id: "s1", ad_id: "a1", link: "https://l", gcm: "07" } }, "in", 9000), {
    srv: 1, retry: 0, partner: "in", status: "done", stage: "ad", error: null, finished_at: 5000, campaign_id: "c1", adset_id: "s1", ad_id: "a1", link: "https://l", gcm: "07",
  });
  // error, not retryable → the interrupted message when the job has none; HS rows read "interrupted"
  const dead = closingRowFor({ ...base, status: "error" }, "in", 9000);
  assert.deepEqual([dead?.status, dead?.retry, dead?.error, dead?.finished_at], ["error", 0, INTERRUPTED_MSG, 5000]);
  assert.equal("stage" in (dead ?? {}), false, "the last stage the run reached stays on the row");
  const hsDead = closingRowFor({ ...base, kind: "hs.tool", partner: "br", status: "error", error: "TOOL job partial", result: { campaign_id: "c9" } }, "br", 9000);
  assert.deepEqual([hsDead?.status, hsDead?.retry, hsDead?.error, hsDead?.campaign_id], ["interrupted", 0, "TOOL job partial", "c9"]);
  // error, retryable → error with retry 1 (never "interrupted": Retry must be offered)
  const clean = closingRowFor({ ...base, kind: "hs.lion", partner: "br", status: "error", retryable: true, error: "account_disabled" }, "br", 9000);
  assert.deepEqual([clean?.status, clean?.retry, clean?.error], ["error", 1, "account_disabled"]);
  // canceled → the canceled row
  assert.deepEqual(closingRowFor({ ...base, status: "canceled" }, "in", 9000), canceledRow({ partner: "in" }, 5000));
  // a job that never recorded when it ended → the check's own clock
  assert.equal(closingRowFor({ ...base, status: "done", finished_at: null }, "in", 9000)?.finished_at, 9000);
  // no job at all → the hand-off never reached the queue; nothing to retry on the server
  const none = closingRowFor(null, "br", 9000);
  assert.deepEqual([none?.status, none?.retry, none?.partner, none?.finished_at, none?.srv], ["error", 0, "br", 9000, 1]);
  // the drawers tell "the queue has this job" from this marker — the text must keep its opening words
  assert.match(String(none?.error), /^Not accepted by the queue/);
  // every closing row is server-owned
  for (const st of ["done", "error", "canceled"] as const) assert.equal(closingRowFor({ ...base, status: st }, "in", 1)?.srv, 1);
});

test("closingRowFor: a done row lands exactly where the rail's own verdict would have put it", () => {
  for (const kind of ["mo.launch", "aif.launch", "av.launch", "fb.clone", "hs.lion", "hs.token", "hs.tool"] as QueueKind[]) {
    const final = kind === "hs.lion" ? { ok: true, lionTaskId: "lion-task-1", name: "Final name" } : { ok: true, campaign_id: "c1", adset_id: "s1", ad_id: "a1", gcm: "mk7", link: "https://x", name: "Final name" };
    const verdict = outcomeOf(jb(kind, { creatives: [{ url: "a" }] }), reply({ streamed: kind !== "hs.lion", final }), NOW);
    assert.equal(verdict.status, "done", kind);
    const closed = closingRowFor({ kind, partner: "p", status: "done", retryable: false, error: null, result: verdict.result, finished_at: NOW }, "p", NOW);
    assert.equal(closed?.status, "done", kind);
    assert.equal(closed?.stage, verdict.row.stage, `${kind}: stage`);
    // every id the verdict's own row shows — the HS ad COUNT (the row's ad_id there) included
    for (const k of ["campaign_id", "adset_id", "ad_id", "link", "gcm", "name"] as const) {
      if (verdict.row[k] != null) assert.equal(closed?.[k], verdict.row[k], `${kind}: ${k}`);
    }
  }
});
