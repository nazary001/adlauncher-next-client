// Node's built-in runner (v24 strips types natively): `node --test tests/tool-follow-core.test.ts`.
// Following one TOOL job past its handler's window (lib/tool-follow-core): done with ids, done
// without a campaign id (never a success), failed with Facebook's reason, a slice that ends
// pending, the 429 back-off, a failing read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runToolFollowSlice, type ToolFollowDeps, type ToolFollowVerdict } from "../lib/tool-follow-core.ts";

function world(reads: Array<{ ok: true; data: unknown } | { ok: false; status: number }>, outcome: (job: unknown) => ToolFollowVerdict, reason?: string) {
  const calls: [string, ...unknown[]][] = [];
  let clock = 9_000_000;
  let i = 0;
  const deps: ToolFollowDeps = {
    getJob: async (id) => {
      calls.push(["getJob", id]);
      return reads[Math.min(i++, reads.length - 1)];
    },
    outcome,
    ...(reason !== undefined ? { failedReason: async () => reason } : {}),
    now: () => clock,
    sleep: async (ms) => {
      calls.push(["sleep", ms]);
      clock += ms;
    },
  };
  return { deps, calls, of: (n: string) => calls.filter((c) => c[0] === n), clock: () => clock };
}

test("done with a campaign → done with its ids", async () => {
  const w = world([{ ok: true, data: { status: "done" } }], () => ({ state: "done", campaignId: "c1", adsetIds: ["s1"], adIds: ["a1", "a2"] }));
  assert.deepEqual(await runToolFollowSlice(7, w.deps, { sliceEndAt: w.clock() + 60_000 }), { state: "done", campaignId: "c1", adsetId: "s1", adIds: ["a1", "a2"] });
});

test("done WITHOUT a campaign id is never a success — the row keeps its pending note", async () => {
  const w = world([{ ok: true, data: {} }], () => ({ state: "done", campaignId: "", adsetIds: [], adIds: [] }));
  const r = await runToolFollowSlice(7, w.deps, { sliceEndAt: w.clock() + 60_000 });
  assert.equal(r.state, "failed");
  assert.match(String((r as { error: string }).error), /without reporting a campaign id/);
});

test("failed → Facebook's own reason from the events when there is one, else the job's; created ids ride along", async () => {
  const w = world([{ ok: true, data: {} }], () => ({ state: "failed", error: "TOOL job partial", created: { campaignId: "c9", adsetIds: [], adIds: [] } }), "Invalid parameter: bid too low");
  assert.deepEqual(await runToolFollowSlice(7, w.deps, { sliceEndAt: w.clock() + 60_000 }), { state: "failed", error: "Invalid parameter: bid too low", created: { campaignId: "c9", adsetIds: [], adIds: [] } });
  const bare = world([{ ok: true, data: {} }], () => ({ state: "failed", error: "TOOL job error" }));
  assert.deepEqual(await runToolFollowSlice(7, bare.deps, { sliceEndAt: bare.clock() + 60_000 }), { state: "failed", error: "TOOL job error" });
});

test("still running at the slice end → pending (the next slice continues); a 429 backs the polls off; a failed read is transient", async () => {
  const w = world([{ ok: false, status: 429 }, { ok: false, status: 502 }, { ok: true, data: {} }], () => ({ state: "pending" }));
  const r = await runToolFollowSlice(7, w.deps, { sliceEndAt: w.clock() + 20_000, pollMs: 2_000 });
  assert.deepEqual(r, { state: "pending" });
  const sleeps = w.of("sleep").map((c) => c[1] as number);
  assert.equal(sleeps[0], 4_000, "doubled after the 429");
  assert.ok(sleeps.length >= 3);
  assert.ok(w.clock() >= 9_000_000 + 20_000);
});
