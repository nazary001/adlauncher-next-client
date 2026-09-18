// Node's built-in runner (v24 strips types natively): `node --test tests/tiktok-pump-core.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// TikTok rail — the after() pump algorithm with EVERY side effect injected and a fake clock:
// exactly-once submits, the four dispositions (sent / refused / interrupted / out of time), the
// launch-first dataset path (404 → fetch → deferred → retried, other sources keep moving) and the
// settle pass that upgrades "Sent to LION" rows to the real outcome.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTiktokPump, type TiktokPumpDeps, type TiktokPumpShot } from "../lib/tiktok-pump-core.ts";
import { tiktokTaskOutcome, type TiktokKind, type TiktokTaskLike } from "../lib/tiktok-launch.ts";

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });
const shot = (taskId: string, kind: TiktokKind, campaignId = "", rowKey = taskId): TiktokPumpShot => ({ taskId, kind, campaignId, body: { id: taskId }, rowKey });
const task = (status: string, over: Partial<TiktokTaskLike> = {}): TiktokTaskLike => ({ status, campaignId: null, campaignName: null, errorMessage: null, errorStep: null, ...over });

type Script = {
  submit?: (kind: TiktokKind, body: { id: string }, call: number, now: number) => { taskId: string };
  datasetFetch?: (campaignId: string, call: number) => void;
  task?: (taskId: string, now: number) => TiktokTaskLike;
};

function harness(script: Script = {}) {
  let t = 1_000_000;
  const start = t;
  const writes: Array<{ taskId: string; fields: Record<string, unknown> }> = [];
  const submits: Array<{ kind: TiktokKind; id: string; at: number }> = [];
  const fetches: Array<{ campaignId: string; at: number }> = [];
  const polls: string[] = [];
  const sleeps: number[] = [];
  let flushed = 0;
  const deps: TiktokPumpDeps = {
    async submit(kind, body) {
      const b = body as { id: string };
      submits.push({ kind, id: b.id, at: t - start });
      return (script.submit ?? ((_k, x) => ({ taskId: `p-${x.id}` })))(kind, b, submits.length, t - start);
    },
    async datasetFetch(campaignId) {
      fetches.push({ campaignId, at: t - start });
      script.datasetFetch?.(campaignId, fetches.length);
    },
    async task(taskId) {
      polls.push(taskId);
      return (script.task ?? (() => task("completed", { campaignId: "1800", campaignName: "real name" })))(taskId, t - start);
    },
    outcome: tiktokTaskOutcome,
    write: (taskId, fields) => void writes.push({ taskId, fields }),
    flush: async () => void (flushed += 1),
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    now: () => t,
    jitter: () => 1500,
  };
  const row = (taskId: string): Record<string, unknown> => Object.assign({}, ...writes.filter((w) => w.taskId === taskId).map((w) => w.fields));
  return { deps, writes, submits, fetches, polls, sleeps, row, deadline: start + 770_000, flushed: () => flushed, elapsed: () => t - start };
}

test("a 201 makes the row terminal at once — done / sent with the partner task id", async () => {
  const h = harness({ task: () => task("running") });
  await runTiktokPump([shot("ttl-w-01", "launch")], h.deadline, h.deps, { settleMs: 0 });
  const r = h.row("ttl-w-01");
  assert.equal(r.status, "done");
  assert.equal(r.stage, "sent");
  assert.equal(r.link, "p-ttl-w-01");
  assert.equal(typeof r.finished_at, "number");
  assert.equal(h.submits.length, 1);
  assert.equal(h.flushed(), 1);
});

test("shots go out one at a time with a jitter between them — never before the first", async () => {
  const h = harness();
  await runTiktokPump([shot("a", "launch"), shot("b", "launch"), shot("c", "launch")], h.deadline, h.deps, { settleMs: 0 });
  assert.deepEqual(h.submits.map((s) => s.at), [0, 1500, 3000]);
});

test("a clean 4xx is the partner's sentence; identical copies are refused without being sent", async () => {
  const h = harness({
    submit: (_k, b) => {
      if (b.id === "a1") throw httpError(400, "landing URL not allowed · allowed domains: choice-flow.org");
      return { taskId: `p-${b.id}` };
    },
  });
  await runTiktokPump([shot("a1", "launch", "", "rowA"), shot("a2", "launch", "", "rowA"), shot("b1", "launch", "", "rowB")], h.deadline, h.deps, { settleMs: 0 });
  assert.equal(h.row("a1").status, "error");
  assert.equal(h.row("a1").stage, "submit");
  assert.match(String(h.row("a1").error), /landing URL not allowed/);
  assert.equal(h.row("a2").status, "error");
  assert.equal(h.row("a2").error, h.row("a1").error);
  assert.equal(h.row("b1").status, "done");
  assert.deepEqual(h.submits.map((s) => s.id), ["a1", "b1"]);
});

test("a 5xx or a network cut is AMBIGUOUS — interrupted, exactly one submit, never re-sent", async () => {
  const h = harness({
    submit: (_k, b) => {
      if (b.id === "a") throw httpError(502, "bad gateway");
      if (b.id === "b") throw new Error("fetch failed");
      return { taskId: "p" };
    },
  });
  await runTiktokPump([shot("a", "clone", "1900000000000001"), shot("b", "launch")], h.deadline, h.deps, { settleMs: 0 });
  for (const id of ["a", "b"]) {
    assert.equal(h.row(id).status, "interrupted");
    assert.match(String(h.row(id).error), /may exist on tiktok-weapon/);
  }
  assert.deepEqual(h.submits.map((s) => s.id), ["a", "b"]);
  assert.equal(h.fetches.length, 0);
});

test("clone 404 = cold dataset: fetch once, defer the source, keep the others moving, retry after the first wait", async () => {
  const SRC = "1900000000000001";
  const h = harness({
    // The source becomes launchable 40 s after the pump started.
    submit: (kind, b, _n, now) => {
      if (kind === "clone" && now < 40_000) throw httpError(404, "source not in dataset");
      return { taskId: `p-${b.id}` };
    },
  });
  await runTiktokPump([shot("c1", "clone", SRC, "row1"), shot("c2", "clone", SRC, "row1"), shot("l1", "launch")], h.deadline, h.deps, { settleMs: 0 });
  // c1 probed (404) → fetch → c2 is deferred WITHOUT burning a submit → l1 goes out → c1 probes again at +30 s (still cold)
  // → again 20 s later (ready) → c2 follows.
  assert.deepEqual(h.fetches.map((f) => f.campaignId), [SRC]);
  assert.deepEqual(h.submits.map((s) => s.id), ["c1", "l1", "c1", "c1", "c2"]);
  assert.equal(h.row("c1").status, "done");
  assert.equal(h.row("c2").status, "done");
  assert.equal(h.row("l1").status, "done");
  assert.equal(h.row("c1").link, "p-c1");
  // The deferred rows showed the dataset stage while they waited.
  assert.ok(h.writes.some((w) => w.taskId === "c2" && w.fields.stage === "dataset"));
});

test("the fetch is re-triggered once when the source stays cold, and the wait gives up with a sentence", async () => {
  const SRC = "1900000000000002";
  const h = harness({
    submit: () => {
      throw httpError(404, "source not in dataset");
    },
  });
  await runTiktokPump([shot("j1", "juro", SRC), shot("j2", "juro", SRC)], h.deadline, h.deps, { settleMs: 0 });
  assert.equal(h.fetches.length, 2, "one fetch + exactly one re-trigger");
  assert.ok(h.fetches[1].at >= 150_000);
  for (const id of ["j1", "j2"]) {
    assert.equal(h.row(id).status, "error");
    assert.equal(h.row(id).stage, "dataset");
    assert.match(String(h.row(id).error), /not in LION's dataset after \d+ s/);
  }
  assert.ok(h.elapsed() >= 270_000 && h.elapsed() < 330_000, `gave up at ${h.elapsed()} ms`);
  // Only the probe shot is ever submitted while the source is cold.
  assert.ok(h.submits.every((s) => s.id === "j1"));
});

test("a fetch that answers 404 means LION never saw the campaign — every shot of that source fails", async () => {
  const h = harness({
    submit: (kind, b) => {
      if (kind === "clone") throw httpError(404, "source not in dataset");
      return { taskId: `p-${b.id}` };
    },
    datasetFetch: () => {
      throw httpError(404, "campaign not found");
    },
  });
  await runTiktokPump([shot("c1", "clone", "404000000000001"), shot("c2", "clone", "404000000000001"), shot("l1", "launch")], h.deadline, h.deps, { settleMs: 0 });
  for (const id of ["c1", "c2"]) {
    assert.equal(h.row(id).status, "error");
    assert.equal(h.row(id).stage, "dataset");
    assert.match(String(h.row(id).error), /LION never saw campaign 404000000000001/);
  }
  assert.equal(h.row("l1").status, "done");
  assert.deepEqual(h.submits.map((s) => s.id), ["c1", "l1"]);
});

test("a 404 on a FRESH launch is a plain refusal — there is no dataset to fetch", async () => {
  const h = harness({
    submit: () => {
      throw httpError(404, "not found");
    },
  });
  await runTiktokPump([shot("l1", "launch")], h.deadline, h.deps, { settleMs: 0 });
  assert.equal(h.row("l1").status, "error");
  assert.equal(h.row("l1").stage, "submit");
  assert.equal(h.fetches.length, 0);
});

test("past the deadline margin nothing new is admitted", async () => {
  const h = harness();
  const deadline = h.deps.now() + 21_000; // margin 20 s → room for the first shot only (jitter 1.5 s eats the rest)
  await runTiktokPump([shot("a", "launch"), shot("b", "launch")], deadline, h.deps, { settleMs: 0 });
  assert.equal(h.row("a").status, "done");
  assert.equal(h.row("b").status, "error");
  assert.match(String(h.row("b").error), /time budget ran out/);
  assert.deepEqual(h.submits.map((s) => s.id), ["a"]);
});

test("settle: a completed task upgrades the row to the real campaign; a failed one carries LION's step and sentence", async () => {
  const h = harness({
    task: (taskId, now) => {
      if (now < 25_000) return task("running");
      return taskId === "p-ok" ? task("completed", { campaignId: "1800000000000001", campaignName: "{HS-Ab3k} (GLO-01) […]" }) : task("failed", { errorStep: "video_upload", errorMessage: "Video too short" });
    },
    submit: (_k, b) => ({ taskId: b.id === "a" ? "p-ok" : "p-bad" }),
  });
  await runTiktokPump([shot("a", "launch"), shot("b", "launch")], h.deadline, h.deps);
  assert.equal(h.row("a").status, "done");
  assert.equal(h.row("a").stage, "created");
  assert.equal(h.row("a").campaign_id, "1800000000000001");
  assert.equal(h.row("a").name, "{HS-Ab3k} (GLO-01) […]");
  assert.equal(h.row("a").link, "p-ok");
  assert.equal(h.row("b").status, "error");
  assert.equal(h.row("b").stage, "lion");
  assert.equal(h.row("b").error, "video_upload: Video too short");
  // Both settled → the pass ends well before its 6-minute ceiling.
  assert.ok(h.elapsed() < 60_000);
});

test("settle: a task read that throws never downgrades the row, and the pass ends at its ceiling", async () => {
  const h = harness({
    task: () => {
      throw new Error("tiktok-weapon HTTP 500");
    },
  });
  await runTiktokPump([shot("a", "launch")], h.deadline, h.deps, { settleMs: 60_000, settlePollMs: 10_000 });
  assert.equal(h.row("a").status, "done");
  assert.equal(h.row("a").stage, "sent");
  assert.equal(h.polls.length, 6);
  assert.equal(h.flushed(), 1);
});

test("settle polls only what was sent", async () => {
  const h = harness({
    submit: (_k, b) => {
      if (b.id === "bad") throw httpError(400, "nope");
      return { taskId: "p-good" };
    },
  });
  await runTiktokPump([shot("bad", "launch", "", "r1"), shot("good", "launch", "", "r2")], h.deadline, h.deps);
  assert.deepEqual([...new Set(h.polls)], ["p-good"]);
});

test("the store is flushed even when a dependency blows up unexpectedly", async () => {
  const h = harness();
  h.deps.write = () => {
    throw new Error("writer exploded");
  };
  await assert.rejects(runTiktokPump([shot("a", "launch")], h.deadline, h.deps, { settleMs: 0 }));
  assert.equal(h.flushed(), 1);
});

test("rows sent before a cold source are settled WHILE the pump waits for its dataset", async () => {
  const SRC = "1900000000000003";
  const settledAt: Record<string, number> = {};
  const h = harness({
    submit: (kind, b, _n, now) => {
      if (kind === "clone" && now < 100_000) throw httpError(404, "source not in dataset");
      return { taskId: `p-${b.id}` };
    },
  });
  const write = h.deps.write;
  h.deps.write = (taskId, fields) => {
    if (fields.stage === "created") settledAt[taskId] = h.elapsed();
    write(taskId, fields);
  };
  await runTiktokPump([shot("l1", "launch"), shot("c1", "clone", SRC)], h.deadline, h.deps);
  assert.equal(h.row("l1").stage, "created");
  assert.equal(h.row("c1").stage, "created");
  assert.ok(settledAt.l1 < 30_000, `l1 settled at ${settledAt.l1} ms — before the cold source's first retry`);
  assert.ok(settledAt.c1 > 100_000);
});
