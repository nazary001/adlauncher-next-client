// MongoDB store of the server-side launch queue: the `launch_jobs` collection (one document per
// handed-over task, see lib/launch-queue-types.ts QueueJob) and the `launch_lanes` collection (one
// leased lock per lane). Server-only. Every call is bounded (lib/store.ts `bounded`, 8 s) — a hung
// store must fail FAST, never pin a Vercel function to its maxDuration.
//
// The money-safety primitives live here, and they are all ATOMIC: a claim is one findOneAndUpdate
// (queued → running), every state change repeats its own precondition in the filter (so two racing
// callers can never both win), and the lane lock is one upsert against a UNIQUE index — a live
// foreign holder collides (E11000) and reads as "busy". Nothing here reads-then-writes a state it
// then assumes still holds.

import type { Document, Filter } from "mongodb";
import { coll, isDupKey } from "./mongo.ts";
import { STORE_TIMEOUT_MS, bounded, dupKeyOn, insertFresh } from "./store.ts";
import {
  FOLLOW_REQUEUE_DELAY_MS,
  IDEMPOTENT_MAX_ATTEMPTS,
  INTERRUPTED_MSG,
  JOB_LEASE_MS,
  JOB_TTL_MS,
  LANE_LEASE_MS,
  REAP_GRACE_MS,
  type BuildBeacon,
  type JobResult,
  type QueueJob,
  type QueueScope,
} from "./launch-queue-types.ts";

export const LAUNCH_JOBS = "launch_jobs";
export const LAUNCH_LANES = "launch_lanes";

/** At most this many expired leases are reaped per sweep — the reap piggybacks on a cron tick and
 *  must never turn into a bulk stall. */
const REAP_MAX = 50;

/** What a new job needs; the store adds status "queued", attempts 0, the leases, timestamps, the
 *  Strapi-style envelope (lib/store.ts insertFresh) and `expire_at` (JOB_TTL_MS, TTL index). */
export type NewJob = Pick<QueueJob, "job_id" | "owner" | "role" | "sub" | "scope" | "kind" | "lane" | "partner" | "account" | "body" | "row" | "seq" | "queued_at"> &
  Partial<Pick<QueueJob, "v" | "build" | "group" | "idempotent" | "not_before" | "row_extra">>;

/** A queued job is claimable only once its `not_before` (a follow-up's next slice) has passed;
 *  a job without one — every submit — is due at once. `null` matches an absent field too. */
const due = (now: number) => ({ $or: [{ not_before: null }, { not_before: { $lte: now } }] });

// The two UNIQUE indexes the queue's safety RESTS on: without `job_id` unique a hand-off POSTed twice
// at the same instant inserts the job twice (→ a campaign launched twice); without `lane` unique two
// pumps can both take a brand-new lane. scripts/ensure-indexes.mjs creates them with the rest of the
// plan — but a deploy must never depend on someone having run a script first, so the two gates that
// need them (insertJob, acquireLane) make sure of them themselves: once per process, idempotent
// (createIndex on an existing index is a no-op), and FAIL CLOSED — if they cannot be ensured the
// hand-off is refused, never accepted on an unguarded collection.
let queueIndexes: Promise<void> | null = null;
export function ensureQueueIndexes(): Promise<void> {
  if (!queueIndexes) {
    queueIndexes = (async () => {
      const jobs = await coll(LAUNCH_JOBS);
      const lanes = await coll(LAUNCH_LANES);
      await bounded(jobs.createIndex({ job_id: 1 }, { unique: true }), "launch-jobs unique index", 20_000);
      await bounded(lanes.createIndex({ lane: 1 }, { unique: true }), "launch-lanes unique index", 20_000);
      // The rest of the plan (scripts/ensure-indexes.mjs) is ensured here too — idempotent, and a
      // second team's database must not depend on someone remembering the script: without the TTL
      // the collection grows for ever, without the claim index every claim scans the lane.
      await bounded(jobs.createIndex({ expire_at: 1 }, { expireAfterSeconds: 0 }), "launch-jobs ttl index", 20_000).catch(() => {});
      await bounded(jobs.createIndex({ lane: 1, status: 1, seq: 1 }), "launch-jobs lane index", 20_000).catch(() => {});
      await bounded(jobs.createIndex({ status: 1, lease_until: 1 }), "launch-jobs lease index", 20_000).catch(() => {});
      await bounded(jobs.createIndex({ group: 1, status: 1 }), "launch-jobs group index", 20_000).catch(() => {});
    })();
    // A failed attempt is not remembered — the next call tries again.
    queueIndexes.catch(() => {
      queueIndexes = null;
    });
  }
  return queueIndexes;
}

/** A stored document → the QueueJob shape: drop `_id`, the Strapi envelope and `expire_at`; keep only
 *  what the pump and the client read. One full-bodied mapper (no thin wrapper — Turbopack const-fold). */
function toJob(doc: Document): QueueJob {
  return {
    job_id: String(doc.job_id),
    owner: String(doc.owner),
    role: doc.role == null ? null : String(doc.role),
    sub: doc.sub as string | number,
    scope: doc.scope as QueueScope,
    kind: doc.kind as QueueJob["kind"],
    lane: String(doc.lane),
    partner: String(doc.partner),
    account: doc.account == null ? null : String(doc.account),
    body: (doc.body ?? {}) as Record<string, unknown>,
    row: doc.row as QueueJob["row"],
    status: doc.status as QueueJob["status"],
    retryable: Boolean(doc.retryable),
    attempts: Number(doc.attempts) || 0,
    seq: Number(doc.seq) || 0,
    queued_at: Number(doc.queued_at) || 0,
    started_at: doc.started_at == null ? null : Number(doc.started_at),
    finished_at: doc.finished_at == null ? null : Number(doc.finished_at),
    lease_until: doc.lease_until == null ? null : Number(doc.lease_until),
    began: doc.began === true,
    runner: doc.runner == null ? null : String(doc.runner),
    error: doc.error == null ? null : String(doc.error),
    result: (doc.result ?? null) as JobResult | null,
    // Documents written before versions existed carry no `v` — they are version 1.
    v: Number(doc.v) > 0 ? Number(doc.v) : 1,
    build: doc.build == null ? null : String(doc.build),
    group: doc.group == null ? null : String(doc.group),
    idempotent: doc.idempotent === true,
    not_before: doc.not_before == null ? null : Number(doc.not_before),
    row_extra: doc.row_extra && typeof doc.row_extra === "object" ? (doc.row_extra as Record<string, string>) : null,
  };
}

/** Which of these job ids already exist (any owner, any status) — a re-sent hand-off must not
 *  re-stamp a row whose job is already running or done. Throws on a store failure. */
export async function existingJobIds(jobIds: string[]): Promise<Set<string>> {
  if (jobIds.length === 0) return new Set();
  const c = await coll(LAUNCH_JOBS);
  const docs = await bounded(
    c.find({ job_id: { $in: jobIds } }, { projection: { _id: 0, job_id: 1 }, maxTimeMS: STORE_TIMEOUT_MS }).toArray(),
    "launch-jobs existing",
  );
  return new Set(docs.map((d) => String(d.job_id)));
}

/** Insert one job. "duplicate" = a job with this job_id already exists (unique index, E11000) —
 *  the hand-off was already accepted. Throws on any other store failure. */
export async function insertJob(job: NewJob): Promise<"inserted" | "duplicate"> {
  await ensureQueueIndexes();
  try {
    await insertFresh(LAUNCH_JOBS, {
      job_id: job.job_id,
      owner: job.owner,
      role: job.role,
      sub: job.sub,
      scope: job.scope,
      kind: job.kind,
      lane: job.lane,
      partner: job.partner,
      account: job.account,
      body: job.body,
      row: job.row,
      status: "queued",
      retryable: false,
      attempts: 0,
      seq: job.seq,
      queued_at: job.queued_at,
      started_at: null,
      finished_at: null,
      lease_until: null,
      began: false,
      runner: null,
      error: null,
      result: null,
      v: Number(job.v) > 0 ? Number(job.v) : 1,
      build: job.build ?? null,
      group: job.group ?? null,
      idempotent: job.idempotent === true,
      not_before: job.not_before ?? null,
      row_extra: job.row_extra ?? null,
      // TTL: documents age out JOB_TTL_MS after they were queued (index on expire_at).
      expire_at: new Date(job.queued_at + JOB_TTL_MS),
    });
    return "inserted";
  } catch (e) {
    if (dupKeyOn(e, "job_id")) return "duplicate";
    throw e;
  }
}

/** One job by id (any owner), or null. Throws on a store failure. */
export async function findJob(jobId: string): Promise<QueueJob | null> {
  const c = await coll(LAUNCH_JOBS);
  const doc = await bounded(c.findOne({ job_id: jobId }, { maxTimeMS: STORE_TIMEOUT_MS }), "launch-jobs find");
  return doc ? toJob(doc) : null;
}

/** The jobs behind these ids in ONE read (without their bodies) — for the sweep's row check. Ids
 *  with no document are simply absent from the map. Throws on a store failure. */
export async function findJobsBrief(jobIds: string[]): Promise<Map<string, QueueJob>> {
  const out = new Map<string, QueueJob>();
  if (jobIds.length === 0) return out;
  const c = await coll(LAUNCH_JOBS);
  const docs = await bounded(
    c.find({ job_id: { $in: jobIds } }, { projection: { _id: 0, body: 0, row: 0 }, maxTimeMS: STORE_TIMEOUT_MS }).toArray(),
    "launch-jobs brief",
  );
  for (const d of docs) out.set(String(d.job_id), toJob(d));
  return out;
}

/**
 * ATOMICALLY claim the lane's next queued job — lowest `seq` first — in ONE findOneAndUpdate:
 * status queued → running, runner, lease_until = now + JOB_LEASE_MS, started_at = now, attempts + 1.
 * Two concurrent callers can never both get the same job. Null when nothing is queued in the lane.
 * Throws on a store failure.
 */
export async function claimNextJob(lane: string, runner: string, now: number): Promise<QueueJob | null> {
  const c = await coll(LAUNCH_JOBS);
  const doc = await bounded(
    c.findOneAndUpdate(
      { lane, status: "queued", ...due(now) },
      { $set: { status: "running", runner, lease_until: now + JOB_LEASE_MS, started_at: now, began: false, updatedAt: new Date() }, $inc: { attempts: 1 } },
      { sort: { seq: 1 }, returnDocument: "after" },
    ),
    "launch-jobs claim",
  );
  return doc ? toJob(doc) : null;
}

/**
 * A follow-up hands its job back for its next slice: running (held by `runner`) → queued, claimable
 * from `notBefore`, lease and runner cleared, `began` reset (nothing a re-run could double), attempts
 * KEPT (the sweep's re-queue cap counts every slice), and the body replaced when the follow-up
 * recorded progress. Only while still ours. True = handed back.
 */
export async function deferJob(jobId: string, runner: string, notBefore: number, body?: Record<string, unknown>): Promise<boolean> {
  const c = await coll(LAUNCH_JOBS);
  const r = await bounded(
    c.updateOne(
      { job_id: jobId, runner, status: "running" },
      { $set: { status: "queued", runner: null, lease_until: null, started_at: null, began: false, not_before: notBefore, updatedAt: new Date(), ...(body ? { body } : {}) } },
    ),
    "launch-jobs defer",
  );
  return r.matchedCount > 0;
}

/**
 * A refusal that is a fact of the SOURCE (LION rejected the family, the account's window is full,
 * the partner refused the wire every copy shares) settles the identical QUEUED siblings of a job
 * without sending them — the wave pumps' `familyFailed` / `rowRefusal` rules, made durable. Only
 * queued jobs of the same lane and group whose body matches `match` (dot paths) move; a sibling that
 * already began is never touched. Atomic per job; returns the jobs it closed (their rows are the
 * caller's to write). Throws on a store failure — then the siblings simply run and learn the
 * refusal themselves.
 */
export async function failQueuedSiblings(
  lane: string,
  group: string,
  match: Record<string, unknown>,
  verdict: { error: string; retryable: boolean; now: number; except?: string },
): Promise<QueueJob[]> {
  if (!group) return [];
  const c = await coll(LAUNCH_JOBS);
  const filter: Filter<Document> = { lane, group, status: "queued", ...match };
  if (verdict.except) filter.job_id = { $ne: verdict.except };
  const docs = await bounded(c.find(filter, { projection: { _id: 0, job_id: 1 }, maxTimeMS: STORE_TIMEOUT_MS }).toArray(), "launch-jobs siblings scan");
  const out: QueueJob[] = [];
  for (const d of docs) {
    const doc = await bounded(
      c.findOneAndUpdate(
        { job_id: String(d.job_id), status: "queued" },
        { $set: { status: "error", retryable: verdict.retryable, error: verdict.error, finished_at: verdict.now, runner: null, lease_until: null, updatedAt: new Date() } },
        { returnDocument: "after" },
      ),
      "launch-jobs sibling fail",
    );
    if (doc) out.push(toJob(doc));
  }
  return out;
}

/**
 * Re-open a finished IDEMPOTENT job (a wave's follow-up that had already declared the wave done)
 * for `notBefore`: done / error → queued. A retried submit of a kind with a follow-up needs its
 * wave's follow-up back. False = no such job, or it is still open. Throws on a store failure.
 */
export async function reopenJob(jobId: string, notBefore: number): Promise<boolean> {
  const c = await coll(LAUNCH_JOBS);
  const r = await bounded(
    c.updateOne(
      { job_id: jobId, idempotent: true, status: { $in: ["done", "error"] } },
      { $set: { status: "queued", retryable: false, error: null, result: null, started_at: null, finished_at: null, runner: null, lease_until: null, began: false, not_before: notBefore, updatedAt: new Date() } },
    ),
    "launch-jobs reopen",
  );
  return r.matchedCount > 0;
}

/** The jobs of one wave (`group`), oldest first — a follow-up reads its submits this way (bodies and
 *  results included). Throws on a store failure. */
export async function findJobsByGroup(group: string, kinds?: readonly string[]): Promise<QueueJob[]> {
  if (!group) return [];
  const c = await coll(LAUNCH_JOBS);
  const filter: Filter<Document> = { group };
  if (kinds && kinds.length) filter.kind = { $in: [...kinds] };
  const docs = await bounded(c.find(filter, { sort: { seq: 1 }, limit: 200, maxTimeMS: STORE_TIMEOUT_MS }).toArray(), "launch-jobs group");
  return docs.map(toJob);
}

/** Undo a claim that never started (the job did not fit the invocation): running → queued, only
 *  while still held by `runner`; attempts − 1, leases + started_at cleared. */
export async function unclaimJob(jobId: string, runner: string): Promise<void> {
  const c = await coll(LAUNCH_JOBS);
  await bounded(
    c.updateOne(
      { job_id: jobId, runner, status: "running" },
      { $set: { status: "queued", runner: null, lease_until: null, started_at: null, began: false, updatedAt: new Date() }, $inc: { attempts: -1 } },
    ),
    "launch-jobs unclaim",
  );
}

/**
 * Record — ATOMICALLY, on the job itself — that its handler is about to be called: only while the
 * job is still running under `runner`, set `began` and refresh the lease. True = recorded, the
 * call may go ahead. False = the job is no longer ours (the sweeper took it back, another pump has
 * it) — the caller must NOT run it. This write is the line between "claimed, never ran" (safe to
 * re-queue) and "ran" (never re-run): the handler is invoked only after it succeeded.
 */
export async function markJobBegan(jobId: string, runner: string, now: number): Promise<boolean> {
  const c = await coll(LAUNCH_JOBS);
  const r = await bounded(
    c.updateOne({ job_id: jobId, runner, status: "running" }, { $set: { began: true, lease_until: now + JOB_LEASE_MS, updatedAt: new Date() } }),
    "launch-jobs began",
  );
  return r.matchedCount > 0;
}

/** The lane's next `n` QUEUED jobs in `seq` order, without claiming. */
export async function peekQueued(lane: string, n: number, now: number = Date.now()): Promise<QueueJob[]> {
  if (n <= 0) return [];
  const c = await coll(LAUNCH_JOBS);
  const docs = await bounded(
    c.find({ lane, status: "queued", ...due(now) }, { sort: { seq: 1 }, limit: n, maxTimeMS: STORE_TIMEOUT_MS }).toArray(),
    "launch-jobs peek",
  );
  return docs.map(toJob);
}

/** Extend a running job's lease (only while still running under `runner`). */
export async function beatJob(jobId: string, runner: string, now: number): Promise<void> {
  const c = await coll(LAUNCH_JOBS);
  await bounded(
    c.updateOne({ job_id: jobId, runner, status: "running" }, { $set: { lease_until: now + JOB_LEASE_MS, updatedAt: new Date() } }),
    "launch-jobs beat",
  );
}

/** Store a run's verdict: running (held by `runner`) → done / error, leases cleared. False when the
 *  job is no longer ours to finish (e.g. the sweeper already closed it) — then NOTHING is written. */
export async function finishJob(
  jobId: string,
  runner: string,
  verdict: { status: "done" | "error"; retryable: boolean; error: string | null; result: JobResult | null; finished_at: number },
): Promise<boolean> {
  const c = await coll(LAUNCH_JOBS);
  const r = await bounded(
    c.updateOne(
      { job_id: jobId, runner, status: "running" },
      {
        $set: {
          status: verdict.status,
          retryable: verdict.retryable,
          error: verdict.error,
          result: verdict.result,
          finished_at: verdict.finished_at,
          lease_until: null,
          updatedAt: new Date(),
        },
      },
    ),
    "launch-jobs finish",
  );
  return r.matchedCount > 0;
}

/**
 * Re-queue the OWNER's jobs that may run again: status error or canceled AND retryable === true.
 * Each becomes queued with a fresh `seq`/`queued_at` (it goes to the back of its lane), error /
 * result / started_at / finished_at / runner / lease_until cleared, retryable false. Atomic per job
 * (a job two clicks race for is re-queued once). Returns the re-queued jobs as they are AFTER the
 * update; ids that do not qualify are simply absent.
 */
export async function requeueJobs(owner: string, jobIds: string[], now: number): Promise<QueueJob[]> {
  if (jobIds.length === 0) return [];
  const c = await coll(LAUNCH_JOBS);
  const out: QueueJob[] = [];
  for (let i = 0; i < jobIds.length; i++) {
    const doc = await bounded(
      c.findOneAndUpdate(
        { job_id: jobIds[i], owner, status: { $in: ["error", "canceled"] }, retryable: true },
        {
          $set: {
            status: "queued",
            // now * 1000 + i keeps a batch's relative order AND lands it behind everything queued
            // before now — the back of the lane, as the contract promises.
            seq: now * 1000 + i,
            queued_at: now,
            retryable: false,
            error: null,
            result: null,
            started_at: null,
            finished_at: null,
            runner: null,
            lease_until: null,
            began: false,
            updatedAt: new Date(),
          },
        },
        { returnDocument: "after" },
      ),
      "launch-jobs requeue",
    );
    if (doc) out.push(toJob(doc));
  }
  return out;
}

/**
 * Cancel the OWNER's QUEUED jobs — the listed ids, or every queued job of `scope` when no ids are
 * given: queued → canceled (retryable true, finished_at = now). Atomic per job: a job the pump
 * claimed first is not canceled. Returns the canceled jobs.
 */
export async function cancelQueuedJobs(owner: string, sel: { jobIds?: string[]; scope?: QueueScope }, now: number): Promise<QueueJob[]> {
  const c = await coll(LAUNCH_JOBS);
  let ids = sel.jobIds;
  if (!ids) {
    // No ids → resolve every queued job of the owner in the scope, THEN cancel each atomically (a
    // blanket updateMany could not report which jobs it actually moved from queued, and the client
    // needs that list).
    const filter: Filter<Document> = { owner, status: "queued" };
    if (sel.scope) filter.scope = sel.scope;
    const docs = await bounded(
      c.find(filter, { projection: { _id: 0, job_id: 1 }, maxTimeMS: STORE_TIMEOUT_MS }).toArray(),
      "launch-jobs cancel scan",
    );
    ids = docs.map((d) => String(d.job_id));
  }
  const out: QueueJob[] = [];
  for (const id of ids) {
    const doc = await bounded(
      c.findOneAndUpdate(
        { job_id: id, owner, status: "queued" },
        { $set: { status: "canceled", retryable: true, finished_at: now, runner: null, lease_until: null, updatedAt: new Date() } },
        { returnDocument: "after" },
      ),
      "launch-jobs cancel",
    );
    if (doc) out.push(toJob(doc));
  }
  return out;
}

/**
 * The sweeper's reap: every job still "running" whose lease ran out more than REAP_GRACE_MS ago
 * lost its pump. What happens to it depends on ONE recorded fact — did its handler get called?
 *   • `began` true  → the run started and died with its function: closed as error, retryable false,
 *     error = INTERRUPTED_MSG. It is NEVER re-queued (a second run could build a second campaign).
 *   • `began` not true → its pump tripped between the claim and the call (a store blip on the
 *     un-claim, a claim whose answer was lost): the handler provably never ran, so the job simply
 *     goes back to the queue — nothing was lost, nothing can double.
 * Each transition is ATOMIC and repeats its whole precondition in the filter (a pump recording
 * `began` at the same instant makes exactly one of the two writes win). At most REAP_MAX per call.
 */
export async function reapExpiredJobs(now: number): Promise<{ interrupted: QueueJob[]; requeued: QueueJob[] }> {
  const c = await coll(LAUNCH_JOBS);
  const cutoff = now - REAP_GRACE_MS;
  const stale = await bounded(
    c.find({ status: "running", lease_until: { $lt: cutoff } }, { projection: { _id: 0, job_id: 1 }, sort: { lease_until: 1 }, limit: REAP_MAX, maxTimeMS: STORE_TIMEOUT_MS }).toArray(),
    "launch-jobs reap scan",
  );
  const interrupted: QueueJob[] = [];
  const requeued: QueueJob[] = [];
  for (const d of stale) {
    const id = String(d.job_id);
    const back = await bounded(
      c.findOneAndUpdate(
        { job_id: id, status: "running", lease_until: { $lt: cutoff }, began: { $ne: true } },
        { $set: { status: "queued", runner: null, lease_until: null, started_at: null, began: false, updatedAt: new Date() }, $inc: { attempts: -1 } },
        { returnDocument: "after" },
      ),
      "launch-jobs reap requeue",
    );
    if (back) {
      requeued.push(toJob(back));
      continue;
    }
    // An IDEMPOTENT job (a follow-up: it only reads and repeats idempotent writes) that began and
    // died is simply run again, a little later — bounded by its attempt count so a follow-up that
    // keeps dying cannot spin for ever. Attempts are kept (the claim incremented them).
    const again = await bounded(
      c.findOneAndUpdate(
        { job_id: id, status: "running", lease_until: { $lt: cutoff }, began: true, idempotent: true, attempts: { $lt: IDEMPOTENT_MAX_ATTEMPTS } },
        { $set: { status: "queued", runner: null, lease_until: null, started_at: null, began: false, not_before: now + FOLLOW_REQUEUE_DELAY_MS, updatedAt: new Date() } },
        { returnDocument: "after" },
      ),
      "launch-jobs reap requeue idempotent",
    );
    if (again) {
      requeued.push(toJob(again));
      continue;
    }
    const doc = await bounded(
      c.findOneAndUpdate(
        { job_id: id, status: "running", lease_until: { $lt: cutoff }, began: true },
        { $set: { status: "error", retryable: false, error: INTERRUPTED_MSG, finished_at: now, lease_until: null, updatedAt: new Date() } },
        { returnDocument: "after" },
      ),
      "launch-jobs reap",
    );
    if (doc) interrupted.push(toJob(doc));
  }
  return { interrupted, requeued };
}

/** Take the lane lock for `holder` when it is free, expired, or already ours; lease = now +
 *  LANE_LEASE_MS. ONE atomic upsert on the unique `lane` — a live foreign holder makes it fail with
 *  E11000, which is the "busy" answer (false). Throws on any other store failure.
 *  NOTE: `lane` is NOT in $setOnInsert — the filter equality already seeds it on insert, and setting
 *  it in both places is a Mongo path conflict (not E11000). */
export async function acquireLane(lane: string, holder: string, now: number): Promise<boolean> {
  await ensureQueueIndexes();
  const c = await coll(LAUNCH_LANES);
  try {
    const doc = await bounded(
      c.findOneAndUpdate(
        { lane, $or: [{ lease_until: { $lte: now } }, { holder }] },
        { $set: { holder, lease_until: now + LANE_LEASE_MS, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true, returnDocument: "after" },
      ),
      "launch-lanes acquire",
    );
    return Boolean(doc);
  } catch (e) {
    if (isDupKey(e)) return false; // a live foreign holder → the insert collided on the unique lane
    throw e;
  }
}

/** Extend the lease only while `holder` still owns the lane. False = not ours any more. */
export async function extendLane(lane: string, holder: string, now: number): Promise<boolean> {
  const c = await coll(LAUNCH_LANES);
  const r = await bounded(
    c.updateOne({ lane, holder }, { $set: { lease_until: now + LANE_LEASE_MS, updatedAt: new Date() } }),
    "launch-lanes extend",
  );
  return r.matchedCount > 0;
}

/** Free the lane (lease_until = 0, holder cleared) only while `holder` owns it. */
export async function releaseLane(lane: string, holder: string): Promise<void> {
  const c = await coll(LAUNCH_LANES);
  await bounded(
    c.updateOne({ lane, holder }, { $set: { lease_until: 0, holder: null, updatedAt: new Date() } }),
    "launch-lanes release",
  );
}

/** Lanes that have at least one queued job and NO live lock (never locked, released or expired) —
 *  the lanes the sweeper must restart. */
export async function lanesNeedingPump(now: number): Promise<string[]> {
  const jobsC = await coll(LAUNCH_JOBS);
  // Only a lane with a DUE job: a follow-up waiting for its next slice needs no pump yet.
  const queuedLanes = (await bounded(jobsC.distinct("lane", { status: "queued", ...due(now) }), "launch-jobs lanes")) as string[];
  if (queuedLanes.length === 0) return [];
  const lanesC = await coll(LAUNCH_LANES);
  const locked = await bounded(
    lanesC.find({ lane: { $in: queuedLanes }, lease_until: { $gt: now } }, { projection: { _id: 0, lane: 1 }, maxTimeMS: STORE_TIMEOUT_MS }).toArray(),
    "launch-lanes locked",
  );
  const lockedSet = new Set(locked.map((d) => String(d.lane)));
  return queuedLanes.filter((l) => !lockedSet.has(l));
}

/** How many QUEUED jobs wait per ad account (jobs with a known `account` only) — folded into the
 *  launch-limit picture so every buyer sees capacity net of what is already on its way. */
export async function queuedDemandByAccount(): Promise<Record<string, number>> {
  const c = await coll(LAUNCH_JOBS);
  const rows = await bounded(
    c
      .aggregate(
        [
          { $match: { status: "queued", account: { $nin: [null, ""] } } },
          { $group: { _id: "$account", n: { $sum: 1 } } },
        ],
        { maxTimeMS: STORE_TIMEOUT_MS },
      )
      .toArray(),
    "launch-jobs demand",
  );
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (r._id == null || r._id === "") continue;
    out[String(r._id)] = Number(r.n) || 0;
  }
  return out;
}

// ---- the "current build" beacon + the health of the sweep ----
//
// One reserved document in `launch_lanes` (its UNIQUE `lane` index makes it one document for
// certain; "@beacon" can never be a real lane — those are "<scope>:<user>"). The production sweep
// writes its build stamp every minute; pumps read it to learn that a newer build has taken over
// (launch-queue-types isSuperseded), and the launch-limit poll reads its age to tell the buyers
// when the sweep has stopped.

const BEACON_LANE = "@beacon";

/** Record `build` as the build being swept right now. */
export async function writeBeacon(build: string, now: number): Promise<void> {
  await ensureQueueIndexes();
  const c = await coll(LAUNCH_LANES);
  await bounded(
    c.updateOne({ lane: BEACON_LANE }, { $set: { build, at: now, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } }, { upsert: true }),
    "launch-queue beacon write",
  );
}

/** The last build a sweep announced, or null (never swept). Throws on a store failure. */
export async function readBeacon(): Promise<BuildBeacon | null> {
  const c = await coll(LAUNCH_LANES);
  const doc = await bounded(c.findOne({ lane: BEACON_LANE }, { projection: { _id: 0, build: 1, at: 1 }, maxTimeMS: STORE_TIMEOUT_MS }), "launch-queue beacon read");
  if (!doc || typeof doc.build !== "string" || !doc.build) return null;
  return { build: doc.build, at: Number(doc.at) || 0 };
}

/** What the buyers' tabs need to notice a queue nobody is sweeping: when the sweep last ran, and
 *  since when the oldest job has been waiting. */
export async function queueHealth(): Promise<{ sweptAt: number | null; oldestQueuedAt: number | null; oldestOverdueRunningAt: number | null }> {
  const jobs = await coll(LAUNCH_JOBS);
  const now = Date.now();
  const [beacon, oldest, overdue] = await Promise.all([
    readBeacon(),
    bounded(jobs.find({ status: "queued" }, { projection: { _id: 0, queued_at: 1 }, sort: { queued_at: 1 }, limit: 1, maxTimeMS: STORE_TIMEOUT_MS }).toArray(), "launch-jobs oldest queued"),
    // A running job whose lease ran out past the reap grace and that nobody reaped: the one stranded
    // job a queued backlog never shows (a single launch whose pump died while the sweep is down).
    bounded(
      jobs.find({ status: "running", lease_until: { $lt: now - REAP_GRACE_MS } }, { projection: { _id: 0, lease_until: 1 }, sort: { lease_until: 1 }, limit: 1, maxTimeMS: STORE_TIMEOUT_MS }).toArray(),
      "launch-jobs oldest overdue",
    ),
  ]);
  return {
    sweptAt: beacon ? beacon.at : null,
    oldestQueuedAt: oldest.length ? Number(oldest[0].queued_at) || null : null,
    oldestOverdueRunningAt: overdue.length ? Number(overdue[0].lease_until) || null : null,
  };
}
