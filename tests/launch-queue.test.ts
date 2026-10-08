// Node's built-in runner (v24 strips types natively): `node --test tests/launch-queue.test.ts`.
// The lane pump ALGORITHM (lib/launch-queue.ts runLane) against a fully faked world — every side
// effect injected, modelled on tests/snap-pump-core.test.ts. The decisions that guard money:
// one-at-a-time with a breather, re-assert the lane before every claim, never start a job whose
// worst case does not fit the invocation, a crash settles as an unknown (never re-run), and a wave
// that lands late gets exactly one kick.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PREWARM_AHEAD, crashedOutcome, runLane, type LaneDeps } from "../lib/launch-queue.ts";
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

test("a job whose worst case does not fit the invocation is un-claimed, the lane released, a fresh invocation kicked (handoff) — even the FIRST job", async () => {
  const start = 1_000_000;
  // deadline leaves LESS than worstCase + margin → the first job cannot fit
  const deadlineAt = start + worstCaseMs("mo.launch") + PUMP_MARGIN_MS - 1;
  const w = world({ jobs: [qj("j1"), qj("j2")], start, deadlineAt });
  assert.equal(await runLane(w.deps), "handoff");
  assert.deepEqual(w.of("unclaim").map((c) => c[1]), ["j1"]);
  assert.equal(w.of("run").length, 0, "nothing a platform kill could cut in half was started");
  assert.equal(w.of("release").length, 1);
  assert.equal(w.of("kick").length, 1);
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

test("an un-claim the store drops on the fit check does not strand the lane: still a hand-off, released and kicked", async () => {
  const start = 1_000_000;
  const w = world({ jobs: [qj("j1")], start, deadlineAt: start + worstCaseMs("mo.launch") + PUMP_MARGIN_MS - 1 });
  w.deps.unclaim = async (job) => {
    w.calls.push(["unclaim", job.job_id]);
    throw new Error("store timeout");
  };
  assert.equal(await runLane(w.deps), "handoff");
  assert.equal(w.of("run").length, 0);
  assert.equal(w.of("begin").length, 0, "a job that does not fit is never marked begun — the sweeper may re-queue it");
  assert.equal(w.of("release").length, 1);
  assert.equal(w.of("kick").length, 1);
});
