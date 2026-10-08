// Node's built-in runner (v24 strips types natively): `node --test tests/launch-queue.test.ts`.
// The lane pump ALGORITHM (lib/launch-queue.ts runLane) against a fully faked world — every side
// effect injected, modelled on tests/snap-pump-core.test.ts. The decisions that guard money:
// one-at-a-time with a breather, re-assert the lane before every claim, never start a job whose
// worst case does not fit the invocation, a crash settles as an unknown (never re-run), and a wave
// that lands late gets exactly one kick.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NEWER_BUILD_WAIT_MS, PREWARM_AHEAD, crashedOutcome, reconcileOpenRows, runLane, type LaneDeps, type ReconcileDeps } from "../lib/launch-queue.ts";
import { JOB_GAP_MAX_MS, JOB_GAP_MIN_MS, PUMP_MARGIN_MS, worstCaseMs, type JobOutcome, type QueueJob } from "../lib/launch-queue-types.ts";

type Call = [string, ...unknown[]];

const qj = (job_id: string, over: Partial<QueueJob> = {}): QueueJob => ({
  job_id,
  owner: "nazar",
  role: "buyer",
  sub: "u1",
  scope: "mo",
  kind: "mo.launch",
  lane: "mo:nazar",
  partner: "in",
  account: null,
  body: {},
  row: { name: "n", gcm: "", geo: "US", budget: "10", bid: "" },
  status: "queued",
  retryable: false,
  attempts: 0,
  seq: 1,
  queued_at: 0,
  started_at: null,
  finished_at: null,
  lease_until: null,
  began: false,
  runner: null,
  error: null,
  result: null,
  ...over,
});

const okOutcome = (job: QueueJob): JobOutcome => ({
  status: "done",
  retryable: false,
  error: null,
  result: null,
  row: { srv: 1, retry: 0, partner: job.partner, status: "done" },
  ambiguous: false,
  openRow: null,
});

/** A fake lane world: an in-memory queue, a controllable clock, recorded calls, and a hook to tick
 *  the heartbeat the pump registers with `every`. Tests mutate deps.<x> to inject behaviour. */
function world(opts: { jobs?: QueueJob[]; busy?: boolean; deadlineAt?: number; start?: number } = {}) {
  const calls: Call[] = [];
  const rec = (...c: Call) => calls.push(c);
  let clock = opts.start ?? 1_000_000;
  const queue: QueueJob[] = [...(opts.jobs ?? [])];
  let heartbeat: (() => void) | null = null;
  const settled: Array<{ job: string; outcome: JobOutcome }> = [];
  const deps: LaneDeps = {
    now: () => clock,
    deadlineAt: opts.deadlineAt ?? clock + 10_000_000,
    acquireLane: async () => {
      rec("acquire");
      return !opts.busy;
    },
    extendLane: async () => {
      rec("extend");
      return true;
    },
    releaseLane: async () => {
      rec("release");
    },
    claim: async () => {
      rec("claim");
      return queue.shift() ?? null;
    },
    unclaim: async (job) => {
      rec("unclaim", job.job_id);
      queue.unshift(job);
    },
    begin: async (job) => {
      rec("begin", job.job_id);
      return true;
    },
    peek: async (n) => {
      rec("peek", n);
      return queue.slice(0, n);
    },
    beat: async (job) => {
      rec("beat", job.job_id);
    },
    start: async (job) => {
      rec("start", job.job_id);
    },
    run: async (job) => {
      rec("run", job.job_id);
      return okOutcome(job);
    },
    settle: async (job, outcome) => {
      rec("settle", job.job_id, outcome.status);
      settled.push({ job: job.job_id, outcome });
    },
    prewarm: (job) => {
      rec("prewarm", job.job_id);
    },
    kick: async () => {
      rec("kick");
    },
    sleep: async (ms) => {
      rec("sleep", ms);
    },
    every: (ms, fn) => {
      rec("every", ms);
      heartbeat = fn;
      return () => {
        rec("stopbeat");
        heartbeat = null;
      };
    },
    random: () => 0.5,
    log: () => {},
  };
  return {
    deps,
    calls,
    queue,
    settled,
    tick: () => heartbeat?.(),
    setClock: (n: number) => {
      clock = n;
    },
    advance: (d: number) => {
      clock += d;
    },
    of: (name: string) => calls.filter((c) => c[0] === name),
    names: () => calls.map((c) => c[0]),
  };
}

test("busy lane: does nothing and returns busy (no claim, no release)", async () => {
  const w = world({ busy: true, jobs: [qj("j1")] });
  assert.equal(await runLane(w.deps), "busy");
  assert.equal(w.of("claim").length, 0);
  assert.equal(w.of("release").length, 0);
  assert.equal(w.of("acquire").length, 1);
});

test("drains the lane in order, settles each, releases exactly once", async () => {
  const w = world({ jobs: [qj("j1"), qj("j2"), qj("j3")] });
  assert.equal(await runLane(w.deps), "drained");
  assert.deepEqual(w.of("run").map((c) => c[1]), ["j1", "j2", "j3"]);
  assert.deepEqual(w.of("settle").map((c) => c[1]), ["j1", "j2", "j3"]);
  assert.equal(w.of("claim").length, 4, "three jobs + one empty claim that ends the loop");
  assert.equal(w.of("release").length, 1);
  assert.equal(w.of("kick").length, 0);
});

test("no breather before the first job, one jittered 1–3 s pause between jobs", async () => {
  const w = world({ jobs: [qj("j1"), qj("j2"), qj("j3")] });
  await runLane(w.deps);
  const sleeps = w.of("sleep").map((c) => c[1] as number);
  // One breather at the top of every iteration where a job already ran: between the 3 jobs AND before
  // the final empty claim that ends the loop — never before the first job.
  assert.equal(sleeps.length, 3);
  for (const ms of sleeps) assert.ok(ms >= JOB_GAP_MIN_MS && ms < JOB_GAP_MAX_MS, `breather ${ms} is inside [1000,3000)`);
  // the first run happens before any sleep
  assert.ok(w.names().indexOf("run") < w.names().indexOf("sleep"));
  // the breather floor and ceiling track random()
  const lo = world({ jobs: [qj("a"), qj("b")] });
  lo.deps.random = () => 0;
  await runLane(lo.deps);
  assert.equal(lo.of("sleep")[0][1], JOB_GAP_MIN_MS);
  const hi = world({ jobs: [qj("a"), qj("b")] });
  hi.deps.random = () => 0.999999;
  await runLane(hi.deps);
  assert.ok((hi.of("sleep")[0][1] as number) < JOB_GAP_MAX_MS);
});

test("the lane is re-asserted (extend) before every claim", async () => {
  const w = world({ jobs: [qj("j1"), qj("j2")] });
  await runLane(w.deps);
  // in the base world nothing ticks the heartbeat, so extends == claims and each extend precedes a claim
  assert.equal(w.of("extend").length, w.of("claim").length);
  const seq = w.names().filter((n) => n === "extend" || n === "claim");
  for (let i = 0; i < seq.length; i += 2) assert.deepEqual([seq[i], seq[i + 1]], ["extend", "claim"]);
});

test("a failed extend exits 'lost' without releasing the lane", async () => {
  const w = world({ jobs: [qj("j1")] });
  w.deps.extendLane = async () => {
    w.calls.push(["extend"]);
    return false;
  };
  assert.equal(await runLane(w.deps), "lost");
  assert.equal(w.of("claim").length, 0, "a lost lease means we never claim");
  assert.equal(w.of("release").length, 0, "lost never releases — whoever holds it now carries on");
});

test("a job whose worst case does not fit the invocation is un-claimed and the lane released (handoff) — even the FIRST job; a pump that ran nothing does not kick", async () => {
  const start = 1_000_000;
  // deadline leaves LESS than worstCase + margin → the first job cannot fit
  const deadlineAt = start + worstCaseMs("mo.launch") + PUMP_MARGIN_MS - 1;
  const w = world({ jobs: [qj("j1"), qj("j2")], start, deadlineAt });
  assert.equal(await runLane(w.deps), "handoff");
  assert.deepEqual(w.of("unclaim").map((c) => c[1]), ["j1"]);
  assert.equal(w.of("run").length, 0, "nothing a platform kill could cut in half was started");
  assert.equal(w.of("release").length, 1);
  // An invocation that could not even start its first job would only spawn another one in the same
  // position — a loop at network speed. The every-minute sweep restarts the lane instead.
  assert.equal(w.of("kick").length, 0);
});

test("after at least one job ran, a job that no longer fits hands the lane to a fresh invocation (the kick)", async () => {
  const start = 1_000_000;
  const w = world({ jobs: [qj("j1"), qj("j2")], start, deadlineAt: start + worstCaseMs("mo.launch") + PUMP_MARGIN_MS + 5_000 });
  w.deps.run = async (job) => {
    w.calls.push(["run", job.job_id]);
    w.advance(10_000); // j1 took its time: j2 no longer fits what is left
    return okOutcome(job);
  };
  assert.equal(await runLane(w.deps), "handoff");
  assert.deepEqual(w.of("run"), [["run", "j1"]]);
  assert.deepEqual(w.of("unclaim").map((c) => c[1]), ["j2"]);
  assert.equal(w.of("release").length, 1);
  assert.equal(w.of("kick").length, 1, "paid for with a real run — this chain cannot spin");
});

test("NO KICK LOOP: whatever makes a pump step aside at once, an invocation that ran nothing never asks for another", async () => {
  // Every way out of runLane that does no work, each with jobs still queued behind it.
  const start = 1_000_000;
  const cases: Array<[string, (w: ReturnType<typeof world>) => void]> = [
    ["superseded before the first claim", (w) => void (w.deps.superseded = async () => true)],
    ["the first job does not fit", (w) => void (w.deps.deadlineAt = start + 1)],
    ["the first job cannot be marked begun", (w) => void (w.deps.begin = async () => false)],
    ["the first job needs a newer build", (w) => void ((w.deps.build = "2026-10-08T00:00:00.000Z"), (w.queue[0] = qj("j1", { v: 2, build: "2026-10-09T00:00:00.000Z", queued_at: start })))],
  ];
  for (const [name, arrange] of cases) {
    const w = world({ jobs: [qj("j1"), qj("j2")], start });
    arrange(w);
    assert.equal(await runLane(w.deps), "handoff", name);
    assert.equal(w.of("run").length, 0, name);
    assert.equal(w.of("release").length, 1, name + ": the lane is free for the sweep");
    assert.equal(w.of("kick").length, 0, name + ": no kick");
  }
  // ...and an empty lane that fills up right after the last claim: nothing ran → no kick either.
  const empty = world({ jobs: [] });
  empty.deps.claim = async () => {
    empty.queue.push(qj("late"));
    return null;
  };
  assert.equal(await runLane(empty.deps), "drained");
  assert.equal(empty.of("kick").length, 0);
});

test("heartbeat: while a run is in flight it beats the job AND the lane, then stops", async () => {
  const w = world({ jobs: [qj("j1")] });
  w.deps.run = async (job) => {
    w.calls.push(["run", job.job_id]);
    w.tick(); // two heartbeat ticks during the run
    w.tick();
    return okOutcome(job);
  };
  await runLane(w.deps);
  assert.equal(w.of("beat").length, 2, "the job lease is extended on every tick");
  // one extend before the j1 claim + two from the heartbeat ticks + one before the final empty claim
  assert.equal(w.of("extend").length, 4);
  assert.equal(w.of("stopbeat").length, 1);
  // the heartbeat does not fire after the run (stopbeat cleared it)
  w.tick();
  assert.equal(w.of("beat").length, 2);
});

test("prewarm: the next PREWARM_AHEAD queued jobs get a head start; a throwing prewarm changes nothing", async () => {
  const w = world({ jobs: [qj("j1"), qj("j2"), qj("j3")] });
  await runLane(w.deps);
  const warmed = w.of("prewarm").map((c) => c[1]);
  // while j1 runs: peek(2) → [j2,j3]; while j2 runs: peek(2) → [j3]; while j3 runs: []
  assert.deepEqual(warmed, ["j2", "j3", "j3"]);
  // the per-job head-start peeks ask for PREWARM_AHEAD (the trailing peek(1) is the late re-check)
  assert.equal(w.of("peek").filter((c) => c[1] === PREWARM_AHEAD).length, 3);

  const t = world({ jobs: [qj("j1"), qj("j2")] });
  t.deps.prewarm = () => {
    throw new Error("prewarm boom");
  };
  assert.equal(await runLane(t.deps), "drained", "a head start is never worth a failed job");
  assert.deepEqual(t.of("run").map((c) => c[1]), ["j1", "j2"]);
});

test("a run that throws is settled as the crashed outcome (ambiguous, non-retryable) and the lane continues", async () => {
  const w = world({ jobs: [qj("j1"), qj("j2")] });
  w.deps.run = async (job) => {
    w.calls.push(["run", job.job_id]);
    if (job.job_id === "j1") throw new Error("kaboom");
    return okOutcome(job);
  };
  assert.equal(await runLane(w.deps), "drained");
  const crashed = w.settled.find((s) => s.job === "j1")!;
  assert.equal(crashed.outcome.status, "error");
  assert.equal(crashed.outcome.ambiguous, true);
  assert.equal(crashed.outcome.retryable, false);
  assert.deepEqual(crashed.outcome, crashedOutcome(qj("j1"), new Error("kaboom"), w.deps.now()));
  assert.equal(w.settled.find((s) => s.job === "j2")?.outcome.status, "done", "the wave went on");
});

test("a settle that throws does not stop the lane", async () => {
  const w = world({ jobs: [qj("j1"), qj("j2")] });
  let first = true;
  w.deps.settle = async (job) => {
    w.calls.push(["settle", job.job_id]);
    if (first) {
      first = false;
      throw new Error("settle 503");
    }
  };
  assert.equal(await runLane(w.deps), "drained");
  assert.deepEqual(w.of("settle").map((c) => c[1]), ["j1", "j2"]);
  assert.equal(w.of("release").length, 1);
});

test("a claim that throws exits 'lost' (store blip mid-loop; the sweeper restarts the lane)", async () => {
  const w = world({ jobs: [qj("j1")] });
  w.deps.claim = async () => {
    w.calls.push(["claim"]);
    throw new Error("claim 503");
  };
  assert.equal(await runLane(w.deps), "lost");
  assert.equal(w.of("release").length, 0, "a release through a store that just failed proves nothing");
});

test("after draining, a job that lands late triggers exactly one kick", async () => {
  const w = world({ jobs: [qj("j1")] });
  const late = qj("late");
  // the post-loop re-check calls peek(1); hand it a late arrival exactly once
  let served = false;
  w.deps.peek = async (n) => {
    w.calls.push(["peek", n]);
    if (n === 1 && !served) {
      served = true;
      return [late];
    }
    return w.queue.slice(0, n);
  };
  assert.equal(await runLane(w.deps), "drained");
  assert.equal(w.of("release").length, 1);
  assert.equal(w.of("kick").length, 1, "exactly one kick for the late wave");
});

test("drained with nothing late: no kick", async () => {
  const w = world({ jobs: [qj("j1")] });
  assert.equal(await runLane(w.deps), "drained");
  assert.equal(w.of("kick").length, 0);
});

test("an empty lane drains immediately, releases once, no run", async () => {
  const w = world({ jobs: [] });
  assert.equal(await runLane(w.deps), "drained");
  assert.equal(w.of("run").length, 0);
  assert.equal(w.of("claim").length, 1);
  assert.equal(w.of("release").length, 1);
});

// ---- the began mark: a run is recorded on the job BEFORE its handler is called (review 08.10) ----

test("every run is recorded as begun before it starts: begin → start → run, in that order", async () => {
  const w = world({ jobs: [qj("j1")] });
  assert.equal(await runLane(w.deps), "drained");
  const order = w.names().filter((n) => ["claim", "begin", "start", "run", "settle"].includes(n as string));
  assert.deepEqual(order.slice(0, 5), ["claim", "begin", "start", "run", "settle"]);
});

test("a job that cannot be recorded as begun is NOT run: un-claimed, lane released, and no self-kick (the sweep restarts it)", async () => {
  for (const mode of ["false", "throw"] as const) {
    const w = world({ jobs: [qj("j1"), qj("j2")] });
    w.deps.begin = async (job) => {
      w.calls.push(["begin", job.job_id]);
      if (mode === "throw") throw new Error("store timeout");
      return false;
    };
    assert.equal(await runLane(w.deps), "handoff", mode);
    assert.equal(w.of("run").length, 0, "never run without the mark");
    assert.equal(w.of("start").length, 0);
    assert.deepEqual(w.of("unclaim"), [["unclaim", "j1"]]);
    assert.equal(w.of("release").length, 1, "the lane is released");
    assert.equal(w.of("kick").length, 0, "no kick — a refusal that repeats would chain kicks");
  }
});

test("an un-claim the store drops on the fit check does not strand the lane: still a hand-off, and the lane is released", async () => {
  const start = 1_000_000;
  const w = world({ jobs: [qj("j1")], start, deadlineAt: start + worstCaseMs("mo.launch") + PUMP_MARGIN_MS - 1 });
  w.deps.unclaim = async (job) => {
    w.calls.push(["unclaim", job.job_id]);
    throw new Error("store timeout");
  };
  assert.equal(await runLane(w.deps), "handoff");
  assert.equal(w.of("run").length, 0);
  assert.equal(w.of("begin").length, 0, "a job that does not fit is never marked begun — the sweeper may re-queue it");
  assert.equal(w.of("release").length, 1, "the lane is released all the same");
  assert.equal(w.of("kick").length, 0, "nothing ran in this invocation — the sweep restarts the lane");
});

// ---- updates: a pump that has been replaced hands its lane over; jobs a build cannot run ----

test("a newer build is live: the pump takes nothing more and releases the lane; having run nothing itself, it leaves the restart to the sweep", async () => {
  const w = world({ jobs: [qj("j1"), qj("j2")] });
  w.deps.superseded = async () => true;
  assert.equal(await runLane(w.deps), "handoff");
  assert.equal(w.of("claim").length, 0, "nothing is claimed by a replaced build");
  assert.equal(w.of("run").length, 0);
  assert.equal(w.of("release").length, 1);
  assert.equal(w.of("kick").length, 0, "it ran nothing — the new build's own sweep takes the lane within a minute");
});

test("a newer build goes live after the LAST job of a wave: handed over, but no invocation is spent on an empty lane", async () => {
  const w = world({ jobs: [qj("j1")] });
  let live = false;
  w.deps.superseded = async () => live;
  w.deps.run = async (job) => {
    w.calls.push(["run", job.job_id]);
    live = true;
    return okOutcome(job);
  };
  assert.equal(await runLane(w.deps), "handoff");
  assert.equal(w.of("release").length, 1);
  assert.equal(w.of("kick").length, 0, "nothing is queued behind it");
});

test("an update that lands mid-wave: the running job is finished and settled, the rest is left — in order — to the new build", async () => {
  const w = world({ jobs: [qj("j1"), qj("j2"), qj("j3")] });
  let live = false;
  w.deps.superseded = async () => live;
  w.deps.run = async (job) => {
    w.calls.push(["run", job.job_id]);
    live = true; // the owner ships while j1 is building
    return okOutcome(job);
  };
  assert.equal(await runLane(w.deps), "handoff");
  assert.deepEqual(w.of("run"), [["run", "j1"]]);
  assert.deepEqual(w.settled.map((x) => x.job), ["j1"]);
  assert.deepEqual(w.queue.map((j) => j.job_id), ["j2", "j3"], "still queued, in order");
  assert.equal(w.of("release").length, 1);
  assert.equal(w.of("kick").length, 1);
});

test("a beacon read that fails never stops a lane (yielding is an optimisation, never a duty)", async () => {
  const w = world({ jobs: [qj("j1")] });
  w.deps.superseded = async () => {
    throw new Error("store timeout");
  };
  assert.equal(await runLane(w.deps), "drained");
  assert.deepEqual(w.of("run"), [["run", "j1"]]);
});

test("a job a NEWER build queued in a shape this build does not know is given back and left for that build — no run, no verdict, no kick loop", async () => {
  const start = 1_000_000_000;
  const w = world({ jobs: [qj("j1", { v: 2, build: "2026-10-09T00:00:00.000Z", queued_at: start - 30_000 }), qj("j2")], start });
  w.deps.build = "2026-10-08T00:00:00.000Z";
  assert.equal(await runLane(w.deps), "handoff");
  assert.equal(w.of("run").length, 0);
  assert.equal(w.of("begin").length, 0);
  assert.equal(w.settled.length, 0, "an older build never decides the fate of a newer build's job");
  assert.deepEqual(w.of("unclaim"), [["unclaim", "j1"]]);
  assert.equal(w.of("release").length, 1);
  assert.equal(w.of("kick").length, 0, "a kick would land on this same build while it still answers production");
  assert.deepEqual(w.queue.map((j) => j.job_id), ["j1", "j2"], "order kept");
});

test("a job no live build can run (a rollback): refused cleanly and retryably once nobody newer came for it — and the lane goes on", async () => {
  const start = 1_000_000_000;
  const cases: QueueJob[] = [
    qj("waited", { v: 2, build: "2026-10-09T00:00:00.000Z", queued_at: start - NEWER_BUILD_WAIT_MS - 1 }),
    qj("same-build", { v: 2, build: "2026-10-08T00:00:00.000Z", queued_at: start }),
    qj("unknown-kind", { kind: "xx.future" as QueueJob["kind"], queued_at: start }),
  ];
  for (const job of cases) {
    const w = world({ jobs: [job, qj("next")], start });
    w.deps.build = "2026-10-08T00:00:00.000Z";
    assert.equal(await runLane(w.deps), "drained", job.job_id);
    assert.deepEqual(w.of("run"), [["run", "next"]], job.job_id + ": only the runnable job ran");
    const refused = w.settled.find((x) => x.job === job.job_id)?.outcome;
    assert.ok(refused, job.job_id + ": settled");
    assert.deepEqual([refused.status, refused.retryable, refused.ambiguous], ["error", true, false], job.job_id);
    assert.equal(refused.row.retry, 1);
    assert.match(String(refused.error), /nothing was sent/);
    assert.equal(w.of("begin").filter((c) => c[1] === job.job_id).length, 0, "never marked begun");
    assert.equal(w.of("unclaim").length, 0);
  }
});

// ---------------------------------------------------------------------------
// reconcileOpenRows — rows that outlived their job
// ---------------------------------------------------------------------------

type StaleRow = { task_id: string; partner: string };
function rowWorld(rows: StaleRow[], jobs: Record<string, Partial<QueueJob>>, opts: { max?: number; closedMeanwhile?: string[]; failOn?: string[] } = {}) {
  const writes: Array<{ id: string; row: Record<string, unknown> }> = [];
  const logs: string[] = [];
  let jobReads = 0;
  const deps: ReconcileDeps = {
    staleRows: async () => rows,
    jobs: async (ids) => {
      jobReads++;
      return new Map(ids.filter((id) => jobs[id]).map((id) => [id, qj(id, jobs[id])]));
    },
    patchOpen: async (id, row) => {
      if (opts.failOn?.includes(id)) throw new Error("store down");
      if (opts.closedMeanwhile?.includes(id)) return false;
      writes.push({ id, row });
      return true;
    },
    max: opts.max ?? 40,
    log: (m) => logs.push(m),
  };
  return { deps, writes, logs, jobReads: () => jobReads };
}
const sr = (...ids: string[]): StaleRow[] => ids.map((task_id) => ({ task_id, partner: "in" }));

test("row check: a row whose job is still queued or running is never touched, however old", async () => {
  const w = rowWorld(sr("q", "r"), { q: { status: "queued" }, r: { status: "running", began: true } });
  assert.equal(await reconcileOpenRows(w.deps, 9000), 0);
  assert.deepEqual(w.writes, []);
  assert.equal(w.jobReads(), 1, "one read for all the jobs");
});

test("row check: each row gets the row its closed job calls for; a row with no job was never accepted", async () => {
  const w = rowWorld(sr("done", "clean", "dead", "gone", "live", "canceled"), {
    done: { status: "done", finished_at: 5000, result: { campaign_id: "c1", adset_id: "s1", ad_id: "a1" } },
    clean: { status: "error", retryable: true, error: "account_disabled", finished_at: 5000 },
    dead: { kind: "hs.tool", partner: "br", status: "error", retryable: false, error: null, finished_at: 5000 },
    live: { status: "running", began: true },
    canceled: { status: "canceled", finished_at: 5000 },
  });
  assert.equal(await reconcileOpenRows(w.deps, 9000), 5);
  assert.deepEqual(w.writes.map((x) => x.id), ["done", "clean", "dead", "gone", "canceled"], "in the order given (oldest first); the live one is skipped");
  const by = Object.fromEntries(w.writes.map((x) => [x.id, x.row]));
  assert.deepEqual([by.done.status, by.done.stage, by.done.campaign_id, by.done.retry, by.done.srv], ["done", "ad", "c1", 0, 1]);
  assert.deepEqual([by.clean.status, by.clean.retry, by.clean.error], ["error", 1, "account_disabled"]);
  assert.deepEqual([by.dead.status, by.dead.retry, by.dead.partner], ["interrupted", 0, "br"]);
  assert.match(String(by.dead.error), /^Interrupted on the server/);
  assert.deepEqual([by.gone.status, by.gone.retry, by.gone.partner, by.gone.finished_at], ["error", 0, "in", 9000]);
  assert.match(String(by.gone.error), /^Not accepted by the queue/);
  assert.equal(by.canceled.error, "Canceled before it started");
  assert.equal(w.logs.filter((l) => /was still open/.test(l)).length, 5, "every closed row is said in the log");
});

test("row check: a row that closed in the meantime is not counted, and a write that fails does not stop the rest", async () => {
  const jobs = { a: { status: "done" }, b: { status: "done" }, c: { status: "done" } } as Record<string, Partial<QueueJob>>;
  const w = rowWorld(sr("a", "b", "c"), jobs, { closedMeanwhile: ["a"], failOn: ["b"] });
  assert.equal(await reconcileOpenRows(w.deps, 9000), 1);
  assert.deepEqual(w.writes.map((x) => x.id), ["c"]);
  assert.equal(w.logs.filter((l) => /could not be closed/.test(l)).length, 1);
});

test("row check: at most `max` rows are closed in one pass — rows that need no write do not use the allowance", async () => {
  const ids = ["live1", "live2", "d1", "d2", "d3", "d4"];
  const jobs = Object.fromEntries(ids.map((id) => [id, { status: id.startsWith("live") ? "running" : "done" }])) as Record<string, Partial<QueueJob>>;
  const w = rowWorld(sr(...ids), jobs, { max: 3 });
  assert.equal(await reconcileOpenRows(w.deps, 9000), 3);
  assert.deepEqual(w.writes.map((x) => x.id), ["d1", "d2", "d3"], "the oldest first; the fourth waits for the next sweep");
  assert.equal(w.logs.filter((l) => /wait for the next sweep/.test(l)).length, 1);
  // exactly `max` stranded rows: all closed, and nothing is said about a rest that does not exist
  const exact = rowWorld(sr("d1", "d2", "d3"), jobs, { max: 3 });
  assert.equal(await reconcileOpenRows(exact.deps, 9000), 3);
  assert.equal(exact.logs.filter((l) => /wait for the next sweep/.test(l)).length, 0);
});

test("row check: nothing stale → the jobs are not even read; a failed read writes nothing and is the caller's to report", async () => {
  const none = rowWorld([], {});
  assert.equal(await reconcileOpenRows(none.deps, 9000), 0);
  assert.equal(none.jobReads(), 0);

  const noRows = rowWorld(sr("a"), { a: { status: "done" } });
  noRows.deps.staleRows = async () => {
    throw new Error("rows unavailable");
  };
  await assert.rejects(reconcileOpenRows(noRows.deps, 9000), /rows unavailable/);
  assert.deepEqual(noRows.writes, []);

  const noJobs = rowWorld(sr("a"), { a: { status: "done" } });
  noJobs.deps.jobs = async () => {
    throw new Error("jobs unavailable");
  };
  await assert.rejects(reconcileOpenRows(noJobs.deps, 9000), /jobs unavailable/);
  assert.deepEqual(noJobs.writes, [], "a row is never closed as 'no job' because the jobs could not be read");
});
