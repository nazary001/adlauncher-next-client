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

function world(opts: { tasks?: () => LionTaskRead[]; ads?: Record<string, { status: string; adsCount: number }>; rename?: boolean; activateOk?: boolean } = {}) {
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
      return opts.activateOk === false ? { ok: false, message: "LION 502", attempts: 5 } : { ok: true, attempts: 1 };
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
