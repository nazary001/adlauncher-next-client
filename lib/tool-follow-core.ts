// Following ONE TOOL job past the window of the handler that submitted it — as a PURE algorithm
// (every side effect injected). A TOOL launch / duplicate whose poll hit the handler's deadline used
// to settle its row as a terminal "pending tool job #N — verify in Ads Manager" that nobody ever
// finished, while TOOL went on and built (and activated) the campaign. Since 09.10 the queue runs
// this as a tool.follow job in slices (lib/launch-queue-runners): the job is read until it is
// terminal, and the row is upgraded from TOOL's own verdict. Reads only, plus one conditional row
// write — a repeated slice can never double anything. Claims (gcm / brand / AV key / account slot)
// are left as the handler left them: a verdict here never frees a marker (conservative — the
// campaign may well exist).
// Relative `.ts` imports only (node --test loads this straight from disk).

export type ToolFollowVerdict =
  | { state: "pending" }
  | { state: "done"; campaignId: string; adsetIds: string[]; adIds: string[] }
  | { state: "failed"; error: string; created?: { campaignId?: string; adsetIds: string[]; adIds: string[] } };

export type ToolFollowDeps = {
  /** One read of the job; `ok:false` on any transport / 4xx / 5xx failure (never a verdict). */
  getJob(jobId: number): Promise<{ ok: true; data: unknown } | { ok: false; status: number }>;
  /** lib/tool-launch toolJobOutcome. */
  outcome(job: unknown): ToolFollowVerdict;
  /** Facebook's own reason for a failed / partial job (lib/tool-launch toolFailedReason over the events). */
  failedReason?(jobId: number): Promise<string>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log?(msg: string): void;
};

export type ToolFollowResult = { state: "pending" } | { state: "done"; campaignId: string; adsetId: string; adIds: string[] } | { state: "failed"; error: string; created?: { campaignId?: string; adsetIds: string[]; adIds: string[] } };

/** One slice: poll the job every `pollMs` (backing off to ~10 s on a 429) until it is terminal or
 *  the slice ends. A failed read is transient — the next tick asks again. */
export async function runToolFollowSlice(jobId: number, deps: ToolFollowDeps, opts: { sliceEndAt: number; pollMs?: number }): Promise<ToolFollowResult> {
  const basePollMs = opts.pollMs ?? 5_000;
  let pollMs = basePollMs;
  const now = () => deps.now();
  for (;;) {
    const jr = await deps.getJob(jobId).catch(() => ({ ok: false as const, status: 0 }));
    if (jr.ok) {
      pollMs = basePollMs;
      const v = deps.outcome(jr.data);
      if (v.state === "done") {
        if (!v.campaignId) {
          // A "done" that names no campaign cannot be settled either way — the tree may exist
          // without ids we can backfill (review find 28.09): the row keeps its pending note.
          return { state: "failed", error: `TOOL job #${jobId} finished without reporting a campaign id — check Ads Manager sessions → Jobs` };
        }
        return { state: "done", campaignId: v.campaignId, adsetId: v.adsetIds[0] ?? "", adIds: v.adIds };
      }
      if (v.state === "failed") {
        let reason = v.error;
        if (deps.failedReason) {
          try {
            reason = (await deps.failedReason(jobId)) || reason;
          } catch {
            /* the job's own sentence stands */
          }
        }
        return { state: "failed", error: reason, ...(v.created ? { created: v.created } : {}) };
      }
    } else if (jr.status === 429) {
      pollMs = Math.min(pollMs * 2, 10_000);
    }
    if (now() >= opts.sliceEndAt) return { state: "pending" };
    await deps.sleep(Math.min(pollMs, Math.max(0, opts.sliceEndAt - now())));
  }
}
