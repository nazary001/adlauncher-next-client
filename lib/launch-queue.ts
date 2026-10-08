// The lane pump of the server-side launch queue — the ALGORITHM only, every side effect injected
// (the house rule for pumps: lib/snap-pump-core.ts, lib/tiktok-pump-core.ts), so the decisions that
// guard money are unit-tested against fakes. lib/launch-queue-run.ts binds the real store, the real
// handlers and the real clock.
//
// A LANE is one buyer's queue on one rail (`mo:<user>`, `hs:<user>` …). Its jobs run strictly one
// at a time, in the order they were handed over, with the same jittered 1–3 s breather between
// them the browser pumps kept. Exactly one pump works a lane at any moment (a leased lock); a pump
// lives inside ONE serverless invocation, so before each job it checks that the job's worst case
// still fits what is left of the invocation — when it does not, it hands the lane to a fresh
// invocation instead of starting something a platform kill would cut in half.

import { HEARTBEAT_MS, INTERRUPTED_MSG, JOB_GAP_MAX_MS, JOB_GAP_MIN_MS, PUMP_MARGIN_MS, worstCaseMs, type JobOutcome, type QueueJob } from "./launch-queue-types.ts";

/**
 *  busy     — another pump holds the lane; nothing was done here.
 *  drained  — the lane is empty and released.
 *  handoff  — jobs remain but the next one does not fit this invocation; the lane was released
 *             and a fresh invocation was asked for.
 *  lost     — the lane lease lapsed under us (or the store failed mid-loop): stop without touching
 *             the lane; whoever holds it now — or the sweeper — carries on.
 */
export type LaneExit = "busy" | "drained" | "handoff" | "lost";

export type LaneDeps = {
  now: () => number;
  /** Absolute ms — nothing of this pump may still be running past it. */
  deadlineAt: number;
  acquireLane: () => Promise<boolean>;
  /** Extend the lane lease; false = it is no longer ours. */
  extendLane: () => Promise<boolean>;
  releaseLane: () => Promise<void>;
  /** Atomically take the lane's next queued job (queued → running, leased). Null = none queued. */
  claim: () => Promise<QueueJob | null>;
  /** Put a just-claimed, not-yet-started job back (it did not fit this invocation). */
  unclaim: (job: QueueJob) => Promise<void>;
  /** Record on the job — atomically — that its handler is about to be called. True = recorded; the
   *  run may go ahead. False (or a throw) = it is not ours to run. Nothing is ever run without it:
   *  this record is what lets the sweeper tell "claimed, never ran" (re-queue) from "ran" (never). */
  begin: (job: QueueJob) => Promise<boolean>;
  /** The next queued jobs, in order, WITHOUT claiming them. */
  peek: (n: number) => Promise<QueueJob[]>;
  /** Extend a running job's lease. */
  beat: (job: QueueJob) => Promise<void>;
  /** Mark the job's row running (before the handler takes over the row). */
  start: (job: QueueJob) => Promise<void>;
  /** Run the job to its verdict. Must not throw — a throw is treated as an unknown outcome. */
  run: (job: QueueJob) => Promise<JobOutcome>;
  /** Persist the verdict (job document + task row). */
  settle: (job: QueueJob, outcome: JobOutcome) => Promise<void>;
  /** Best-effort head start for a job that will run soon (e.g. register its videos so the
   *  platform processes them while the current job builds). Must never throw. */
  prewarm: (job: QueueJob) => void;
  /** Ask for a fresh invocation to continue this lane. */
  kick: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  /** Run `fn` every `ms` until the returned stop() is called. */
  every: (ms: number, fn: () => void) => () => void;
  random: () => number;
  log?: (msg: string) => void;
};

/** How many upcoming jobs get a head start while one runs. */
export const PREWARM_AHEAD = 2;

/** The verdict of a run whose runner broke its contract and threw: unknown outcome, never retried. */
export function crashedOutcome(job: Pick<QueueJob, "kind" | "partner">, error: unknown, now: number): JobOutcome {
  const hs = job.kind === "hs.lion" || job.kind === "hs.token" || job.kind === "hs.tool";
  const msg = `${INTERRUPTED_MSG} (${error instanceof Error ? error.message : String(error)})`;
  return {
    status: "error",
    retryable: false,
    error: msg,
    result: null,
    ambiguous: true,
    row: { srv: 1, retry: 0, partner: job.partner },
    openRow: { srv: 1, retry: 0, partner: job.partner, status: hs ? "interrupted" : "error", error: msg, finished_at: now },
  };
}

export async function runLane(deps: LaneDeps): Promise<LaneExit> {
  if (!(await deps.acquireLane())) return "busy";
  let exit: LaneExit = "drained";
  let kickOnHandoff = true;
  let ran = 0;
  try {
    for (;;) {
      // The breather sits BETWEEN jobs — never before the first, so a fresh wave starts at once.
      if (ran > 0) await deps.sleep(JOB_GAP_MIN_MS + deps.random() * (JOB_GAP_MAX_MS - JOB_GAP_MIN_MS));
      // Re-assert the lane before every claim: a lease that lapsed (a store blip outlasting it)
      // means another pump may already be working this lane.
      if (!(await deps.extendLane())) {
        exit = "lost";
        break;
      }
      const job = await deps.claim();
      if (!job) break;
      // Does its worst case still fit this invocation? A job the platform kills mid-run skips every
      // error path (claims never released, campaign never paused) — far worse than a short wait.
      if (deps.now() + worstCaseMs(job.kind) + PUMP_MARGIN_MS > deps.deadlineAt) {
        // The un-claim is best-effort: if the store drops it, the job stays "running" WITHOUT its
        // began mark, and the sweeper puts it back in the queue once its lease runs out — late, but
        // never lost and never mislabelled (review find 08.10: an unguarded throw here stranded a
        // launch that had not even started as a non-retryable "interrupted").
        await deps.unclaim(job).catch((e) => deps.log?.(`unclaim ${job.job_id} failed: ${String(e)}`));
        exit = "handoff";
        break;
      }
      // The line a run crosses exactly once: its start is recorded on the job BEFORE the handler is
      // called. A job we cannot record as begun (the store failed, or it is no longer ours) is not
      // run — it is handed back, and a fresh invocation takes the lane from a clean state.
      let began = false;
      try {
        began = await deps.begin(job);
      } catch (e) {
        deps.log?.(`begin ${job.job_id} failed: ${String(e)}`);
      }
      if (!began) {
        await deps.unclaim(job).catch(() => {});
        // Released, but NOT self-kicked: whatever refused the record would most likely refuse it
        // again at once, and a kick that fails the same way would chain kicks at network speed. The
        // every-minute sweep restarts the lane.
        exit = "handoff";
        kickOnHandoff = false;
        break;
      }
      ran++;
      for (const next of await deps.peek(PREWARM_AHEAD).catch(() => [] as QueueJob[])) {
        try {
          deps.prewarm(next);
        } catch {
          /* a head start is never worth a failed job */
        }
      }
      await deps.start(job).catch(() => {});
      const stop = deps.every(HEARTBEAT_MS, () => {
        void deps.beat(job).catch(() => {});
        void deps.extendLane().catch(() => {});
      });
      let outcome: JobOutcome;
      try {
        outcome = await deps.run(job);
      } catch (e) {
        outcome = crashedOutcome(job, e, deps.now());
      } finally {
        stop();
      }
      // A verdict that cannot be stored leaves the job "running" until its lease runs out; the
      // sweeper then closes it as interrupted — never re-run, and never over a row the handler
      // already settled.
      await deps.settle(job, outcome).catch((e) => deps.log?.(`settle ${job.job_id} failed: ${String(e)}`));
    }
  } catch (e) {
    // A store failure mid-loop (the lane re-assert or the claim threw): stop here. The lane lease
    // simply runs out and the sweeper restarts the lane — releasing through a store that just failed
    // proves nothing. A claim whose answer was lost AFTER the store applied it leaves a job "running"
    // without its began mark: the sweeper re-queues it.
    deps.log?.(`lane loop stopped: ${String(e)}`);
    exit = "lost";
  }
  if (exit === "lost") return exit;
  await deps.releaseLane().catch(() => {});
  if (exit === "handoff") {
    if (kickOnHandoff) await deps.kick().catch(() => {});
    return exit;
  }
  // A wave can land between the last empty claim and the release — its own hand-off saw the lane
  // busy and left the work to us. Look once more now that the lane is free.
  const late = await deps.peek(1).catch(() => [] as QueueJob[]);
  if (late.length > 0) await deps.kick().catch(() => {});
  return exit;
}
