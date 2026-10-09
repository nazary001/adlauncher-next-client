// The verdict a RUNNER derives from the rows its rail's pump core wrote (09.10) — pure, so
// `node --test tests/launch-queue-verdict.test.ts` proves the money rules without a store:
//   • the core's terminal `done` row is a done job with the ids it recorded;
//   • an `error` row that carries NO campaign and NO partner task id was refused before anything
//     existed — a one-click retry is safe; one with an id is final (a blind re-run would build a
//     second tree);
//   • `interrupted` (the core's ambiguous outcome: a 5xx / network cut after a submit) is final and
//     never retried;
//   • no terminal write at all (a throw the core swallowed, a write the store dropped) is ambiguous:
//     settled only over a row that is still open, never retried.
// Relative `.ts` imports only.

import { SCOPE_PARTNER, doneStage, type JobOutcome, type JobResult, type QueueJob } from "./launch-queue-types.ts";

const SRV = { srv: 1 } as const;
const s = (v: unknown): string | undefined => (v == null || v === "" ? undefined : String(v));

export function verdictFromRows(job: Pick<QueueJob, "kind" | "scope" | "partner">, seen: Record<string, unknown>, now: number): JobOutcome {
  const partner = job.partner || SCOPE_PARTNER[job.scope];
  const base = { ...SRV, partner };
  const status = s(seen.status);
  const ids: JobResult = {};
  for (const k of ["campaign_id", "adset_id", "ad_id", "link", "gcm", "name"] as const) {
    const v = s(seen[k]);
    if (v) ids[k] = v;
  }
  const finishedAt = Number(seen.finished_at) || now;
  if (status === "done") {
    return {
      status: "done",
      retryable: false,
      error: null,
      result: ids,
      ambiguous: false,
      openRow: null,
      // The core's own terminal row, repeated: the same write the browser task manager used to add.
      row: { ...base, retry: 0, status: "done", stage: s(seen.stage) ?? doneStage(job.kind), error: s(seen.error) ?? null, finished_at: finishedAt, ...ids },
    };
  }
  if (status === "error") {
    const retryable = !ids.campaign_id && !ids.link;
    const error = s(seen.error) ?? "failed";
    return {
      status: "error",
      retryable,
      error,
      result: Object.keys(ids).length ? ids : null,
      ambiguous: false,
      openRow: null,
      row: { ...base, retry: retryable ? 1 : 0, status: "error", stage: s(seen.stage) ?? null, error, finished_at: finishedAt, ...ids },
    };
  }
  if (status === "interrupted") {
    const error = s(seen.error) ?? "Interrupted — check the partner before re-firing";
    return {
      status: "error",
      retryable: false,
      error,
      result: Object.keys(ids).length ? ids : null,
      ambiguous: false,
      openRow: null,
      row: { ...base, retry: 0, status: "interrupted", stage: s(seen.stage) ?? null, error, finished_at: finishedAt, ...ids },
    };
  }
  const msg = "the run ended without a verdict — it may still have finished; check the partner before re-firing";
  return {
    status: "error",
    retryable: false,
    error: msg,
    result: Object.keys(ids).length ? ids : null,
    ambiguous: true,
    row: { ...base, retry: 0 },
    openRow: { ...base, retry: 0, status: "interrupted", stage: s(seen.stage) ?? null, error: msg, finished_at: now, ...ids },
  };
}
