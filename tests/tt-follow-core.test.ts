// Node's built-in runner (v24 strips types natively): `node --test tests/tt-follow-core.test.ts`.
// The settle pass of a TikTok wave as the tt.follow job's slice (lib/tt-follow-core).
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTtFollowSlice, type TtFollowDeps } from "../lib/tt-follow-core.ts";
import type { TiktokTaskLike } from "../lib/tiktok-launch.ts";

function world(tasks: Record<string, () => TiktokTaskLike>) {
  const calls: [string, ...unknown[]][] = [];
  let clock = 5_000_000;
  const deps: TtFollowDeps = {
    task: async (id) => {
      calls.push(["task", id]);
      const t = tasks[id];
      if (!t) throw new Error("read failed");
      return t();
    },
    outcome: (t) => (t.status === "completed" && t.campaignId ? { status: "done", stage: "created", campaign_id: t.campaignId, ...(t.campaignName ? { name: t.campaignName } : {}) } : t.status === "failed" ? { status: "error", stage: "lion", error: t.errorMessage ?? "failed" } : null),
    write: async (taskId, lionTaskId, verdict) => {
      calls.push(["write", taskId, lionTaskId, verdict]);
      return true;
    },
    now: () => clock,
    sleep: async (ms) => {
      calls.push(["sleep", ms]);
      clock += ms;
    },
  };
  return { deps, calls, of: (n: string) => calls.filter((c) => c[0] === n), clock: () => clock };
}

const like = (over: Partial<TiktokTaskLike>): TiktokTaskLike => ({ status: "running", campaignId: null, campaignName: null, errorMessage: null, errorStep: null, ...over });

test("a finished task upgrades its row (done / created with the real id and name, or error / lion); a pending one is asked again next slice", async () => {
  const w = world({
    "l-1": () => like({ status: "completed", campaignId: "c1", campaignName: "Real name" }),
    "l-2": () => like({ status: "failed", errorMessage: "pixel invalid", errorStep: "adgroup" }),
    "l-3": () => like({ status: "running" }),
  });
  const t0 = w.clock();
  const res = await runTtFollowSlice(
    [
      { taskId: "t1", lionTaskId: "l-1" },
      { taskId: "t2", lionTaskId: "l-2" },
      { taskId: "t3", lionTaskId: "l-3" },
    ],
    w.deps,
    { sliceEndAt: t0 + 1, pollMs: 1000 },
  );
  assert.deepEqual(res.settled.sort(), ["t1", "t2"]);
  assert.deepEqual(res.pending, [{ taskId: "t3", lionTaskId: "l-3" }]);
  const w1 = w.of("write").find((c) => c[1] === "t1")!;
  assert.equal(w1[2], "l-1", "the upgrade is conditional on THIS partner task id");
  assert.deepEqual(w1[3], { status: "done", stage: "created", campaign_id: "c1", name: "Real name", finished_at: t0 });
  const w2 = w.of("write").find((c) => c[1] === "t2")!;
  assert.deepEqual(w2[3], { status: "error", stage: "lion", error: "pixel invalid", finished_at: t0 });
});

test("a read that fails is not a verdict — the row stays 'sent' and the task is asked again within the slice", async () => {
  let n = 0;
  const w = world({
    "l-1": () => {
      if (n++ === 0) throw new Error("tiktok-weapon 502");
      return like({ status: "completed", campaignId: "c1" });
    },
  });
  const res = await runTtFollowSlice([{ taskId: "t1", lionTaskId: "l-1" }], w.deps, { sliceEndAt: w.clock() + 30_000, pollMs: 10_000 });
  assert.deepEqual(res.settled, ["t1"]);
  assert.equal(w.of("task").length, 2);
  assert.equal(w.of("sleep").length, 1);
});

test("the slice ends on time with what is still pending", async () => {
  const w = world({ "l-1": () => like({ status: "running" }) });
  const res = await runTtFollowSlice([{ taskId: "t1", lionTaskId: "l-1" }], w.deps, { sliceEndAt: w.clock() + 25_000, pollMs: 10_000 });
  assert.equal(res.pending.length, 1);
  assert.ok(w.clock() >= 5_000_000 + 25_000);
  assert.ok(w.of("task").length <= 4);
});
