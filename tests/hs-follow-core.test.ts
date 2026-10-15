// Node's built-in runner (v24 strips types natively): `node --test tests/hs-follow-core.test.ts`.
// The follow-up of a LION duplicate / JURO wave (lib/hs-follow-core) against a faked LION: the
// activation after COMPLETED, the bid gate, the reality check, the walls, the rename, the slice end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runHsFollowSlice, type FollowDeps, type FollowShot, type LionTaskRead } from "../lib/hs-follow-core.ts";

type Call = [string, ...unknown[]];

const shot = (taskId: string, over: Partial<FollowShot> = {}): FollowShot => ({
  taskId,
  lionTaskId: `lion-${taskId}`,
  cloneId: null,
  name: "",
  account: "acct-1",
  biddingMismatch: null,
  campaignId: "src-1",
  renamed: false,
  ...over,
});

function world(opts: { tasks?: () => LionTaskRead[]; ads?: Record<string, { status: string; adsCount: number }>; rename?: boolean; activateOk?: boolean; activateNotFound?: boolean; activateOnce?: (id: string) => { ok: boolean; message?: string } } = {}) {
  const calls: Call[] = [];
  let clock = 1_000_000;
  const rows: Record<string, Record<string, unknown>[]> = {};
  const gated: Record<string, Record<string, unknown>[]> = {};
  const deps: FollowDeps = {
    creationStatus: async (ids) => {
      calls.push(["status", ids]);
      return opts.tasks ? opts.tasks() : [];
    },
    campaignAds: async (ids) => {
      calls.push(["ads", ids]);
      const out: Record<string, { status: string; adsCount: number }> = {};
      for (const id of ids) out[id] = opts.ads?.[id] ?? { status: "UNREADABLE", adsCount: 0 };
      return out;
    },
    activate: async (id) => {
      calls.push(["activate", id]);
      if (opts.activateNotFound) return { ok: false, message: "Campaign not found", attempts: 5 };
      return opts.activateOk === false ? { ok: false, message: "LION 502", attempts: 5 } : { ok: true, attempts: 1 };
    },
    activateOnce: async (id) => {
      calls.push(["activateOnce", id]);
      return opts.activateOnce ? opts.activateOnce(id) : { ok: false, message: "Campaign not found" };
    },
    pause: async (id) => {
      calls.push(["pause", id]);
      return true;
    },
    rename: opts.rename === false ? null : async (id, name, account) => void calls.push(["rename", id, name, account]) || true,
    transientRenameError: (m) => /transient/.test(m),
    writeOpen: async (taskId, fields) => {
      calls.push(["writeOpen", taskId, fields]);
      (rows[taskId] ??= []).push(fields);
      return true;
    },
    writeBidGate: async (taskId, fields) => {
      calls.push(["writeBidGate", taskId, fields]);
      (gated[taskId] ??= []).push(fields);
      return true;
    },
    roasWall: (m) => (/2446671/.test(String(m ?? "")) ? "Meta: min ROAS isn't available" : null),
    blockingError: (m) => (/certif/i.test(String(m ?? "")) ? { reason: "not certified", scope: "account" } : /verified advertiser/i.test(String(m ?? "")) ? { reason: "needs a verified advertiser", scope: "family" } : null),
    acctKey: (a) => a.replace(/^act_/, ""),
    now: () => clock,
    sleep: async (ms) => {
      calls.push(["sleep", ms]);
      clock += ms;
    },
    log: () => {},
  };
  return { deps, calls, rows, gated, of: (n: string) => calls.filter((c) => c[0] === n), clock: () => clock, advance: (ms: number) => void (clock += ms) };
}

test("dup: a COMPLETED task activates the born-PAUSED clone (with retry) and closes the row done at 'ads' with the ad count", async () => {
  const w = world({ tasks: () => [{ task_id: "lion-t1", status: "COMPLETED", campaign_id: "c1", ad_ids: ["a", "b", "c"] }] });
  const res = await runHsFollowSlice([shot("t1")], w.deps, { sliceEndAt: w.clock() + 60_000, mode: "dup" });
  assert.deepEqual(res.settled, ["t1"]);
  assert.deepEqual(res.pending, []);
  assert.deepEqual(w.of("activate"), [["activate", "c1"]]);
  const last = w.rows.t1.at(-1)!;
  assert.deepEqual([last.status, last.stage, last.campaign_id, last.ad_id, last.error], ["done", "ads", "c1", "3", null]);
  // the clone id was persisted the moment it showed up (before the activation)
  assert.deepEqual(w.rows.t1[0], { campaign_id: "c1" });
  assert.equal(w.of("sleep").length, 0, "nothing left pending — the slice ends at once");
});

test("dup: a bid read-back mismatch parks the clone PAUSED — never activated — and the ids land over the bid-gate row", async () => {
  const w = world({ tasks: () => [{ task_id: "lion-t1", status: "COMPLETED", campaign_id: "c1", ad_ids: ["a"] }] });
  const res = await runHsFollowSlice([shot("t1", { biddingMismatch: "LION resolved strategy X ≠ requested Y" })], w.deps, { sliceEndAt: w.clock() + 60_000, mode: "dup" });
  assert.deepEqual(res.settled, ["t1"]);
  assert.equal(w.of("activate").length, 0);
  assert.deepEqual(w.of("pause"), [["pause", "c1"]]);
  const g = w.gated.t1[0];
  assert.equal(g.status, "error");
  assert.equal(g.campaign_id, "c1");
  assert.match(String(g.error), /left PAUSED/);
});

test("dup: a min-ROAS wall on an in-progress task settles it (and pauses a born shell); a COMPLETED task's stale error text is not a wall", async () => {
  const w = world({ tasks: () => [{ task_id: "lion-t1", status: "CREATING_ADSET", campaign_id: "c1", error: { message: "code 100 subcode 2446671" } }, { task_id: "lion-t2", status: "COMPLETED", campaign_id: "c2", ad_ids: ["a"], error: { message: "2446671 earlier" } }] });
  const res = await runHsFollowSlice([shot("t1"), shot("t2")], w.deps, { sliceEndAt: w.clock() + 60_000, mode: "dup" });
  assert.deepEqual(res.settled.sort(), ["t1", "t2"]);
  assert.deepEqual(w.of("pause"), [["pause", "c1"]]);
  assert.deepEqual(w.of("activate"), [["activate", "c2"]]);
  assert.match(String(w.rows.t1.at(-1)!.error), /min ROAS/);
});

test("the reality check settles a task whose record wedged: the campaign exists with ads → finalized like COMPLETED", async () => {
  const w = world({ tasks: () => [{ task_id: "lion-t1", status: "CREATING_ADS", campaign_id: "c1" }], ads: { c1: { status: "ACTIVE", adsCount: 4 } } });
  const res = await runHsFollowSlice([shot("t1")], w.deps, { sliceEndAt: w.clock() + 60_000, mode: "jurar", realityEveryMs: 0 });
  assert.deepEqual(res.settled, ["t1"]);
  assert.deepEqual(w.of("activate"), [["activate", "c1"]], "jurar: the activate is a belt for a PAUSED birth");
  assert.equal(w.rows.t1.at(-1)!.ad_id, "4");
});

test("a task still creating stays pending: the slice polls until its end, then returns it (the next slice carries on)", async () => {
  const w = world({ tasks: () => [{ task_id: "lion-t1", status: "CREATING_CAMPAIGN" }] });
  const res = await runHsFollowSlice([shot("t1")], w.deps, { sliceEndAt: w.clock() + 25_000, mode: "dup", pollMs: 10_000 });
  assert.deepEqual(res.settled, []);
  assert.equal(res.pending.length, 1);
  assert.ok(w.of("status").length >= 2, "polled more than once inside the slice");
  assert.ok(w.clock() >= 1_000_000 + 25_000);
});

test("activation that keeps failing is said on the row (done with the note) — never a silent green", async () => {
  const w = world({ tasks: () => [{ task_id: "lion-t1", status: "COMPLETED", campaign_id: "c1", ad_ids: ["a"] }], activateOk: false });
  const res = await runHsFollowSlice([shot("t1")], w.deps, { sliceEndAt: w.clock() + 60_000, mode: "dup" });
  assert.deepEqual(res.settled, ["t1"]);
  const last = w.rows.t1.at(-1)!;
  assert.equal(last.status, "done");
  assert.match(String(last.error), /activation failed — flip it ACTIVE in LION/);
});

test("rename: the board's exact name goes on the newborn once; a final wall gives up quietly; a team without tokens never renames", async () => {
  const w = world({ tasks: () => [{ task_id: "lion-t1", status: "CREATING_ADS", campaign_id: "c1" }, { task_id: "lion-t2", status: "CREATING_ADS", campaign_id: "c2" }] });
  w.deps.rename = async (id, name) => {
    w.calls.push(["rename", id, name]);
    if (id === "c2") throw new Error("final wall");
    return true;
  };
  const res = await runHsFollowSlice([shot("t1", { name: "Exact A" }), shot("t2", { name: "Exact B" })], w.deps, { sliceEndAt: w.clock() + 15_000, mode: "dup", pollMs: 10_000, realityEveryMs: 1e9 });
  assert.deepEqual(res.renamed.sort(), ["t1", "t2"], "landed, or given up for good");
  assert.equal(w.of("rename").length, 2, "once each, however many ticks");
  const none = world({ tasks: () => [{ task_id: "lion-t1", status: "CREATING_ADS", campaign_id: "c1" }], rename: false });
  await runHsFollowSlice([shot("t1", { name: "Exact" })], none.deps, { sliceEndAt: none.clock() + 1, mode: "dup" });
  assert.equal(none.of("rename").length, 0);
});

test("jurar: an ACCOUNT wall settles every pending shot bound to that account (shell paused), a FAMILY wall the source's copies; NO_COUNTRIES_LEFT is final", async () => {
  const w = world({
    tasks: () => [
      { task_id: "lion-t1", status: "CREATING_ADS", campaign_id: "c1", error: { message: "subcode 2859002 non-discrimination certification" } },
      { task_id: "lion-t2", status: "CREATING_ADS" },
      { task_id: "lion-t3", status: "CREATING_ADS" },
      { task_id: "lion-t4", status: "CREATING_ADS", campaign_id: "c4", error: { message: "needs a verified advertiser" } },
      { task_id: "lion-t5", status: "CREATING_ADS" },
      { task_id: "lion-t6", status: "NO_COUNTRIES_LEFT" },
    ],
  });
  const shots = [
    shot("t1", { account: "acct-A" }),
    shot("t2", { account: "acct-A" }),
    shot("t3", { account: "acct-B" }),
    shot("t4", { account: "acct-B", campaignId: "src-9" }),
    shot("t5", { account: "acct-B", campaignId: "src-9" }),
    shot("t6", { account: "acct-B", campaignId: "src-7" }),
  ];
  const res = await runHsFollowSlice(shots, w.deps, { sliceEndAt: w.clock() + 1, mode: "jurar" });
  assert.deepEqual(res.settled.sort(), ["t1", "t2", "t4", "t5", "t6"]);
  assert.deepEqual(res.pending.map((s) => s.taskId), ["t3"]);
  assert.deepEqual(w.of("pause").map((c) => c[1]).sort(), ["c1", "c4"]);
  assert.match(String(w.rows.t2.at(-1)!.error), /not certified/);
  assert.match(String(w.rows.t5.at(-1)!.error), /verified advertiser/);
  assert.match(String(w.rows.t6.at(-1)!.error), /no eligible countries/);
});

test("a LION blip ends the tick, not the slice: the next tick asks again", async () => {
  let n = 0;
  const w = world({
    tasks: () => {
      if (n++ === 0) throw new Error("LION 502");
      return [{ task_id: "lion-t1", status: "COMPLETED", campaign_id: "c1", ad_ids: ["a"] }];
    },
  });
  const res = await runHsFollowSlice([shot("t1")], w.deps, { sliceEndAt: w.clock() + 60_000, mode: "dup", pollMs: 5_000 });
  assert.deepEqual(res.settled, ["t1"]);
  assert.equal(w.of("status").length, 2);
});

// ---- 15.10: LION progress on the row + activation that outlives LION's sync lag ----

test("the LION creation status lands on the open row as its stage (queue → campaign → adset → ads), written only when it changes", async () => {
  const seq = ["PENDING", "CREATING_CAMPAIGN", "CREATING_CAMPAIGN", "CREATING_ADSET", "CREATING_ADS"];
  let i = 0;
  const w = world({ tasks: () => [{ task_id: "lion-t1", status: seq[Math.min(i++, seq.length - 1)], ...(i > 3 ? { campaign_id: "c1" } : {}) }] });
  const res = await runHsFollowSlice([shot("t1", { stage: "queue" })], w.deps, { sliceEndAt: w.clock() + 45_000, mode: "dup", pollMs: 10_000, realityEveryMs: 1e9 });
  assert.equal(res.settled.length, 0);
  const stages = w.rows.t1.filter((f) => "stage" in f).map((f) => f.stage);
  assert.deepEqual(stages, ["campaign", "adset", "ads"], "queue was already on the row; each later status once");
  assert.equal(res.pending[0].stage, "ads", "the shot remembers the stage it wrote (the next slice starts from it)");
});

test("dup: activation answered 'Campaign not found' keeps the row OPEN at stage 'activate' and retries once per tick — done clean when LION finally syncs", async () => {
  let n = 0;
  const w = world({
    tasks: () => [{ task_id: "lion-t1", status: "COMPLETED", campaign_id: "c1", ad_ids: ["a", "b"] }],
    activateNotFound: true,
    activateOnce: () => (++n < 3 ? { ok: false, message: "Campaign not found" } : { ok: true }),
  });
  const res = await runHsFollowSlice([shot("t1")], w.deps, { sliceEndAt: w.clock() + 120_000, mode: "dup", pollMs: 10_000, realityEveryMs: 1e9 });
  assert.deepEqual(res.settled, ["t1"]);
  const parked = w.rows.t1.find((f) => f.stage === "activate")!;
  assert.ok(parked, "the row was parked at 'activate' with the clone's ids");
  assert.deepEqual([parked.campaign_id, parked.ad_id, parked.status], ["c1", "2", undefined], "still open — no status written");
  assert.equal(w.of("activate").length, 1, "the long retry helper runs once");
  assert.equal(w.of("activateOnce").length, 3, "then one cheap attempt per tick");
  const last = w.rows.t1.at(-1)!;
  assert.deepEqual([last.status, last.stage, last.campaign_id, last.ad_id, last.error], ["done", "ads", "c1", "2", null]);
});

test("a clone flipped ACTIVE by someone else (or a JURO born ACTIVE) closes clean at the reality check — no note", async () => {
  for (const mode of ["dup", "jurar"] as const) {
    const w = world({ tasks: () => [{ task_id: "lion-t1", status: "COMPLETED", campaign_id: "c1", ad_ids: ["a"] }], activateNotFound: true, ads: { c1: { status: "ACTIVE", adsCount: 1 } } });
    const res = await runHsFollowSlice([shot("t1")], w.deps, { sliceEndAt: w.clock() + 60_000, mode, pollMs: 10_000, realityEveryMs: 0 });
    assert.deepEqual(res.settled, ["t1"], mode);
    const last = w.rows.t1.at(-1)!;
    assert.deepEqual([last.status, last.error], ["done", null], mode);
  }
});

test("activation refused for any other reason closes the row at once with the note (unchanged)", async () => {
  const w = world({ tasks: () => [{ task_id: "lion-t1", status: "COMPLETED", campaign_id: "c1", ad_ids: ["a"] }], activateOk: false });
  const res = await runHsFollowSlice([shot("t1")], w.deps, { sliceEndAt: w.clock() + 60_000, mode: "dup" });
  assert.deepEqual(res.settled, ["t1"]);
  assert.equal(w.of("activateOnce").length, 0);
  assert.ok(String(w.rows.t1.at(-1)!.error).includes("activation failed — flip it ACTIVE in LION (LION 502)"));
});

test("still 'Campaign not found' after the give-up window → done with the note (the chain exists, the buyer flips it)", async () => {
  const w = world({ tasks: () => [{ task_id: "lion-t1", status: "COMPLETED", campaign_id: "c1", ad_ids: ["a"] }], activateNotFound: true });
  const res = await runHsFollowSlice([shot("t1")], w.deps, { sliceEndAt: w.clock() + 120_000, mode: "dup", pollMs: 10_000, realityEveryMs: 1e9, activateGiveUpMs: 25_000 });
  assert.deepEqual(res.settled, ["t1"]);
  const last = w.rows.t1.at(-1)!;
  assert.equal(last.status, "done");
  assert.ok(String(last.error).includes("activation failed — flip it ACTIVE in LION (Campaign not found)"));
  assert.ok(w.clock() - 1_000_000 >= 25_000 && w.clock() - 1_000_000 < 60_000, "gave up after the window, not at the slice end");
});

test("the next slice resumes an 'activate' shot from the row even when LION pruned its task record", async () => {
  const w = world({ tasks: () => [], ads: { c1: { status: "ACTIVE", adsCount: 1 } }, activateOnce: () => ({ ok: false, message: "Campaign not found" }) });
  const res = await runHsFollowSlice([shot("t1", { stage: "activate", cloneId: "c1", activatingSince: 1_000_000 - 5_000 })], w.deps, { sliceEndAt: w.clock() + 60_000, mode: "dup", pollMs: 10_000, realityEveryMs: 0 });
  assert.deepEqual(res.settled, ["t1"]);
  assert.ok(w.of("activateOnce").length >= 1, "kept trying from the row's clone id");
  assert.deepEqual([w.rows.t1.at(-1)!.status, w.rows.t1.at(-1)!.error], ["done", null]);
});

// ---- review 15.10 (adversarial pass on the park): blips, sibling walls, lagging statuses ----

test("a transient LION error while parked is NOT a refusal: the row stays open and the next tick asks again", async () => {
  let n = 0;
  const w = world({
    tasks: () => [{ task_id: "lion-t1", status: "COMPLETED", campaign_id: "c1", ad_ids: ["a"] }],
    activateNotFound: true,
    activateOnce: () => (++n < 3 ? { ok: false, message: "LION HTTP 502" } : { ok: true }),
  });
  const res = await runHsFollowSlice([shot("t1")], w.deps, { sliceEndAt: w.clock() + 120_000, mode: "dup", pollMs: 10_000, realityEveryMs: 1e9 });
  assert.deepEqual(res.settled, ["t1"]);
  assert.equal(w.of("activateOnce").length, 3);
  const last = w.rows.t1.at(-1)!;
  assert.deepEqual([last.status, last.error], ["done", null], "no note for a blip");
  assert.ok(!w.rows.t1.some((f) => typeof f.error === "string"), "never wrote a note");
});

test("any failure that outlasts the give-up window closes with the note naming LION's last answer", async () => {
  const w = world({ tasks: () => [{ task_id: "lion-t1", status: "COMPLETED", campaign_id: "c1", ad_ids: ["a"] }], activateNotFound: true, activateOnce: () => ({ ok: false, message: "LION HTTP 502" }) });
  const res = await runHsFollowSlice([shot("t1")], w.deps, { sliceEndAt: w.clock() + 120_000, mode: "dup", pollMs: 10_000, realityEveryMs: 1e9, activateGiveUpMs: 25_000 });
  assert.deepEqual(res.settled, ["t1"]);
  const last = w.rows.t1.at(-1)!;
  assert.equal(last.status, "done");
  assert.ok(String(last.error).includes("activation failed — flip it ACTIVE in LION (LION HTTP 502)"));
  assert.ok(w.clock() - 1_000_000 >= 25_000, "the blip was tolerated until the window ran out");
});

test("jurar: a sibling's account / family wall leaves a parked (already created) shell alone", async () => {
  const w = world({
    tasks: () => [
      { task_id: "lion-t1", status: "COMPLETED", campaign_id: "c1", ad_ids: ["a"] },
      { task_id: "lion-t2", status: "CREATING_ADS", campaign_id: "c2", error: { message: "subcode 2859002 non-discrimination certification" } },
      { task_id: "lion-t3", status: "CREATING_ADS", campaign_id: "c3", error: { message: "needs a verified advertiser" } },
    ],
    activateNotFound: true,
  });
  const shots = [shot("t1", { account: "acct-A", campaignId: "src-1" }), shot("t2", { account: "acct-A", campaignId: "src-2" }), shot("t3", { account: "acct-B", campaignId: "src-1" })];
  const res = await runHsFollowSlice(shots, w.deps, { sliceEndAt: w.clock() + 1, mode: "jurar", realityEveryMs: 1e9 });
  assert.deepEqual(res.settled.sort(), ["t2", "t3"], "the walls settle their own shots");
  assert.deepEqual(res.pending.map((s) => s.taskId), ["t1"], "the parked shell keeps waiting for its activation");
  assert.deepEqual(w.of("pause").map((c) => c[1]).sort(), ["c2", "c3"], "the parked shell is never paused");
  assert.ok(!w.rows.t1.some((f) => f.status === "error"), "no wall reason on the parked row");
});

test("a lagging earlier creation status never moves the stage backwards", async () => {
  const seq = ["CREATING_ADS", "CREATING_ADSET", "CREATING_ADS"];
  let i = 0;
  const w = world({ tasks: () => [{ task_id: "lion-t1", status: seq[Math.min(i++, seq.length - 1)], campaign_id: "c1" }] });
  const res = await runHsFollowSlice([shot("t1", { stage: "queue" })], w.deps, { sliceEndAt: w.clock() + 25_000, mode: "dup", pollMs: 10_000, realityEveryMs: 1e9 });
  assert.deepEqual(w.rows.t1.filter((f) => "stage" in f).map((f) => f.stage), ["ads"]);
  assert.equal(res.pending[0].stage, "ads");
});
