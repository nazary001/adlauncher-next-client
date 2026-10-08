// Browser side of the server launch queue (POST /api/launch-queue): hand a job over, re-queue a
// failed one, cancel a queued one. Shared by the MO / AIF / AV task manager and the HS task manager —
// neither runs launches any more; they hand them to the server and mirror its rows.
//
// The task id is the idempotency key: the server answers "accepted" for a job it already has, so a
// re-send after a lost reply can never create a second job. Client-only (window timers, fetch).

import type { JobRow, QueueActionResponse, QueueEnqueueResponse, QueueKind, QueueScope } from "@/lib/launch-queue-types";

export type QueueSendJob = {
  taskId: string;
  kind: QueueKind;
  /** The launch route's request body, without the task id (the server stamps it). */
  body: Record<string, unknown>;
  row: Partial<JobRow>;
  /** Numeric ad account id the job lands on (launch-limit demand) — optional. */
  account?: string | null;
};

const QUEUE_API = "/api/launch-queue";
/** Jobs handed over within this window ride ONE request per scope (a wave becomes ready card by
 *  card as uploads finish; cards that were already uploaded all arrive in the same beat). */
const BATCH_WINDOW_MS = 60;
/** Mirrors QUEUE_MAX_JOBS_PER_REQUEST with headroom. */
const BATCH_MAX = 25;
const SEND_TIMEOUT_MS = 45_000;
const NET_ATTEMPTS = 3;
/** Ids per retry request (the route refuses a longer list). */
const RETRY_MAX = 100;

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/**
 * The hand-off got NO VERDICT: the connection dropped, the request timed out, or the platform
 * answered without a body. The server commits a job BEFORE it answers, so it may well have this
 * campaign already. Two things follow, and the sentence says both: Retry is safe (the task id is the
 * idempotency key — a re-send can never create a second job), and launching the card again from the
 * board is NOT (that mints a new id, i.e. a second campaign). The task managers also clear the item
 * by themselves as soon as the server's own row for it shows up in the drawer.
 */
export class HandoffUnconfirmedError extends Error {
  constructor(reason: string) {
    super(
      `could not confirm with the server (${reason}) — it may already have this campaign. Press Retry here (safe: it can never ` +
        `create a second one) and do NOT launch the card again until this clears`,
    );
    this.name = "HandoffUnconfirmed";
  }
}
export const isHandoffUnconfirmed = (e: unknown): boolean => (e as { name?: unknown } | null)?.name === "HandoffUnconfirmed";

type Waiter = { job: QueueSendJob; resolve: () => void; reject: (e: Error) => void };
const pending = new Map<QueueScope, Waiter[]>();
const timers = new Map<QueueScope, number>();

/** What a refused hand-off means for the buyer, in their words. */
function humanError(status: number, error: string): string {
  if (status === 401) return "your launcher login expired — log in again in a new tab, then press Retry here";
  if (/creative_not_uploaded/.test(error)) return "a creative of this campaign is not uploaded yet — re-attach it on the card and launch again";
  if (status === 503) return `the server queue is unavailable right now (${error}) — press Retry in a moment`;
  return error || `HTTP ${status}`;
}

async function postJson<T>(body: unknown): Promise<{ status: number; data: T | null }> {
  let lastErr: unknown = null;
  for (let n = 1; n <= NET_ATTEMPTS; n++) {
    try {
      const res = await fetch(QUEUE_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      const data = (await res.json().catch(() => null)) as T | null;
      // A 5xx without a readable body is the platform, not a verdict — worth another attempt.
      if (res.status >= 500 && !data && n < NET_ATTEMPTS) {
        await sleep(1500 * n);
        continue;
      }
      return { status: res.status, data };
    } catch (e) {
      lastErr = e;
      if (n < NET_ATTEMPTS) await sleep(1500 * n);
    }
  }
  throw new Error(`could not reach the server (${(lastErr as Error | null)?.message ?? "network error"}) — check the connection and press Retry`);
}

async function flush(scope: QueueScope): Promise<void> {
  timers.delete(scope);
  const all = pending.get(scope) ?? [];
  pending.delete(scope);
  for (let i = 0; i < all.length; i += BATCH_MAX) {
    const batch = all.slice(i, i + BATCH_MAX);
    try {
      const { status, data } = await postJson<QueueEnqueueResponse>({
        scope,
        jobs: batch.map((w) => ({ taskId: w.job.taskId, kind: w.job.kind, body: w.job.body, row: w.job.row, account: w.job.account ?? null })),
      });
      if (!data) {
        // An answer without a readable body (a gateway / platform page) is not a verdict either way.
        const err = new HandoffUnconfirmedError(`HTTP ${status}`);
        for (const w of batch) w.reject(err);
        continue;
      }
      if (data.ok !== true) {
        const err = new Error(humanError(status, data.error || `HTTP ${status}`));
        for (const w of batch) w.reject(err);
        continue;
      }
      const accepted = new Set(data.accepted);
      const failed = new Map(data.failed.map((f) => [f.taskId, f.error]));
      for (const w of batch) {
        if (accepted.has(w.job.taskId)) w.resolve();
        else w.reject(new Error(humanError(status, failed.get(w.job.taskId) ?? "the server did not accept this campaign")));
      }
    } catch (e) {
      // Every attempt died on the network: nothing says the server did NOT take it.
      const err = new HandoffUnconfirmedError((e as Error | null)?.message?.replace(/^could not reach the server \((.*)\) — .*$/, "$1") || "network error");
      for (const w of batch) w.reject(err);
    }
  }
}

/**
 * Hand one job to the server queue. Resolves once the server ACCEPTED it — from that moment the
 * launch no longer depends on this tab. Rejects with an Error whose message is a complete sentence
 * for the buyer; calling again with the same job is always safe.
 */
export function sendToQueue(scope: QueueScope, job: QueueSendJob): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const list = pending.get(scope) ?? [];
    list.push({ job, resolve, reject });
    pending.set(scope, list);
    if (!timers.has(scope)) timers.set(scope, window.setTimeout(() => void flush(scope), BATCH_WINDOW_MS));
  });
}

async function act(body: unknown): Promise<string[]> {
  const { status, data } = await postJson<QueueActionResponse>(body);
  if (!data || data.ok !== true) throw new Error(humanError(status, (data && !data.ok && data.error) || `HTTP ${status}`));
  return data.taskIds;
}

/** Re-queue the caller's failed / canceled jobs that the server still considers safe to run again.
 *  Resolves with the ids it actually re-queued (others no longer qualified). */
export async function retryQueued(taskIds: string[]): Promise<string[]> {
  // The server takes at most RETRY_MAX ids per request — a "Retry failed" over a bad spell used to
  // answer 400 for the whole list once it grew past that (review find 08.10).
  const done: string[] = [];
  for (let i = 0; i < taskIds.length; i += RETRY_MAX) done.push(...(await act({ action: "retry", taskIds: taskIds.slice(i, i + RETRY_MAX) })));
  return done;
}

/** Cancel the caller's QUEUED jobs (the listed ones, or every queued job of a scope). A job that
 *  already started is not touched. Resolves with the ids it actually canceled. */
export function cancelQueued(sel: { taskIds?: string[]; scope?: QueueScope }): Promise<string[]> {
  return act({ action: "cancel", ...sel });
}
