// Shared server-side operations of the launch queue that both the pump wiring (lib/launch-queue-run)
// and the runners (lib/launch-queue-runners) need — kept apart so the two never import each other:
//   • the row writer a runner feeds its rail's pump core (every write carries srv:1 + the partner);
//   • the verdict a runner derives from the rows its core wrote (verdictFromRows);
//   • failing a job's queued siblings on a refusal that is a fact of the source / the account;
//   • queuing a follow-up job for a wave or for one TOOL job.
// Server-only (the store and the task rows).

import { type TaskRowData, taskWriter, upsertTaskRow } from "./task-store";
import { failQueuedSiblings, insertJob, type NewJob } from "./launch-queue-store";
import { JOB_SCHEMA_VERSION, SCOPE_PARTNER, followLaneOf, isFollowKind, laneOf, type QueueJob, type QueueKind, type QueueScope } from "./launch-queue-types";
import { queueBuild } from "./launch-queue-wire";

export { verdictFromRows } from "./launch-queue-verdict";

const SRV = { srv: 1 } as const;

/** The build stamp the queue records on what it queues (same literal read as lib/launch-queue-run). */
function thisBuild(): string {
  return queueBuild(process.env.NEXT_PUBLIC_BUILD_STAMP, process.env);
}

// ---- the observed row writer ----

export type RowObserver = {
  /** The dep a pump core writes its rows through: ordered, best-effort, stamped srv + partner. */
  write: (taskId: string, fields: Record<string, unknown>) => void;
  /** Await the writes in flight (a core calls it last; the runner calls it again before the verdict). */
  flush: () => Promise<void>;
  /** Everything the core wrote for THIS job's row, merged in order (later writes win). */
  seen: () => Record<string, unknown>;
};

/** A task-row writer for one job that also REMEMBERS what the core wrote: the core's terminal
 *  row (done / error / interrupted) is the job's verdict (verdictFromRows). Writes to other task
 *  ids (a core may touch siblings) go through unobserved. */
export function observeRows(job: QueueJob): RowObserver {
  const partner = job.partner || SCOPE_PARTNER[job.scope];
  const writers = new Map<string, ReturnType<typeof taskWriter>>();
  const writerOf = (taskId: string) => {
    let w = writers.get(taskId);
    if (!w) {
      w = taskWriter(job.owner, taskId, { partner, ...SRV });
      writers.set(taskId, w);
    }
    return w;
  };
  const merged: Record<string, unknown> = {};
  return {
    write(taskId, fields) {
      if (taskId === job.job_id) Object.assign(merged, fields);
      writerOf(taskId).write(fields as TaskRowData);
    },
    async flush() {
      await Promise.all([...writers.values()].map((w) => w.flush()));
    },
    seen: () => ({ ...merged }),
  };
}

// ---- siblings ----

/**
 * Settle the queued siblings of `job` that share a fact the refusal was about (a dot-path match on
 * their bodies: `{"body.campaignId": id}`, `{"body.rowKey": key}`, `{"body.shot.binds.account": a}`)
 * — as the wave pumps' `familyFailed` / `rowRefusal` / account-window rules did in memory. Each closed
 * sibling's row is written with the same sentence. Best-effort: a store failure means the siblings
 * simply run and learn the refusal themselves. Returns how many were closed.
 */
export async function failSiblings(
  job: QueueJob,
  match: Record<string, unknown>,
  verdict: { error: string; retryable: boolean },
  log?: (msg: string) => void,
): Promise<number> {
  if (!job.group) return 0;
  const now = Date.now();
  let closed: QueueJob[] = [];
  try {
    closed = await failQueuedSiblings(job.lane, job.group, match, { ...verdict, now, except: job.job_id });
  } catch (e) {
    log?.(`siblings of ${job.job_id} could not be closed: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
  for (const sib of closed) {
    await upsertTaskRow(sib.owner, sib.job_id, {
      ...SRV,
      retry: verdict.retryable ? 1 : 0,
      partner: sib.partner,
      status: "error",
      error: verdict.error.slice(0, 1000),
      finished_at: now,
    }).catch(() => undefined);
  }
  if (closed.length) log?.(`${closed.length} sibling(s) of ${job.job_id} settled without a submit: ${verdict.error.slice(0, 120)}`);
  return closed.length;
}

// ---- follow-ups ----

export type FollowUpSpec = {
  /** The job id — unique per wave (`fol-<waveId>`) or per TOOL job (`tf-<taskId>`); a second queue of
   *  the same follow-up is a no-op (duplicate insert). */
  jobId: string;
  scope: QueueScope;
  kind: QueueKind;
  /** The wave it follows (its submits carry the same group). */
  group: string | null;
  body: Record<string, unknown>;
  /** Not before this moment (default: in FOLLOW_DEFER_MS from now — the first submits land first). */
  notBefore?: number | null;
};

/** Queue a follow-up job on behalf of `owner` (the submit's owner — the follow-up runs as them).
 *  No task row: a follow-up finishes the submits' rows. Returns the lane to pump, or null when the
 *  insert failed (logged — the wave's submits still stand; the row check closes their rows at the cap). */
export async function enqueueFollowUp(
  owner: Pick<QueueJob, "owner" | "role" | "sub">,
  spec: FollowUpSpec,
  now: number,
  log?: (msg: string) => void,
): Promise<string | null> {
  if (!isFollowKind(spec.kind)) throw new Error(`enqueueFollowUp: ${spec.kind} is not a follow-up kind`);
  const lane = followLaneOf(spec.scope, owner.owner);
  const job: NewJob = {
    v: JOB_SCHEMA_VERSION,
    build: thisBuild() || null,
    job_id: spec.jobId,
    owner: owner.owner,
    role: owner.role ?? null,
    sub: owner.sub,
    scope: spec.scope,
    kind: spec.kind,
    lane,
    partner: SCOPE_PARTNER[spec.scope],
    account: null,
    body: spec.body,
    row: { name: "", gcm: "", geo: "", budget: "", bid: "" },
    seq: now * 1000,
    queued_at: now,
    group: spec.group,
    idempotent: true,
    not_before: spec.notBefore ?? null,
    row_extra: null,
  };
  try {
    await insertJob(job);
    return lane;
  } catch (e) {
    log?.(`follow-up ${spec.jobId} could not be queued: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** The submit lane of a job's scope (re-exported for the runners). */
export const submitLaneOf = (scope: QueueScope, owner: string): string => laneOf(scope, owner);
