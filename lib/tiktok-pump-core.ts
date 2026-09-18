// TikTok rail — the after() wave pump ALGORITHM with every side effect injected (lib/tiktok-pump.ts
// binds the real tiktok-weapon client and the task-store writer). Kept pure so
// `node --test tests/tiktok-pump-core.test.ts` proves the dispositions without a network.
//
// Rows are already stamped into the shared store by the route; this advances them server-side so
// the team sees the truth even when the firing browser dies. Three movements:
//   1. submit — shots go out ONE AT A TIME with a 1–3 s jitter, EXACTLY ONCE. 201 → the row is
//      terminal at once: "done / sent" with the partner task id ("Sent to LION", Google/HS parity —
//      nobody is left "running"). A clean 4xx is the partner's sentence on the row, and the other
//      copies of the same board row (identical wire) are refused with it WITHOUT being sent. A
//      5xx / network cut is AMBIGUOUS (the task may exist) → "interrupted", never re-sent.
//   2. dataset — tiktok-weapon has NO dataset status read, so the launch itself is the probe: a 404
//      on a clone / JURO means "source not fetched" — a clean refusal (nothing was created), which
//      makes it the ONE outcome that is safe to retry. The source is fetched once, its shots are
//      deferred (the rest of the wave keeps moving), and ONE probe shot per source is retried after
//      `firstWaitMs`, then every `retryMs`; the fetch is re-triggered once after `refetchAfterMs`;
//      past `giveUpMs` the source's shots fail with a sentence that names the wait. A 404 from the
//      FETCH means LION never saw the campaign — every shot of that source fails at once.
//   3. settle — the sent tasks are polled until LION finishes them (or `settleMs` / the deadline
//      runs out) — ALSO while the pump sits out a cold source, so one slow dataset never keeps the
//      rest of the wave at "Sent to LION": completed → "done / created" with the real campaign id
//      and name, failed → "error / lion" with LION's step and sentence. A read that fails never
//      downgrades a row; a task that outlives the pass simply stays "Sent to LION".

import type { TiktokKind, TiktokTaskLike } from "./tiktok-launch";

export const TIKTOK_PUMP_BUDGET_MS = 770_000;

export type TiktokPumpShot = {
  taskId: string;
  kind: TiktokKind;
  /** Source campaign id (clone / JURO); "" for a fresh launch. */
  campaignId: string;
  /** The exact partner wire for this shot. */
  body: unknown;
  /** Board row this shot is a copy of — copies share one wire, so one refusal covers them all. */
  rowKey: string;
};

export type TiktokPumpDeps = {
  /** ONE attempt. Throws an Error carrying `status` for an HTTP answer; anything else is a network cut. */
  submit(kind: TiktokKind, body: unknown): Promise<{ taskId: string }>;
  datasetFetch(campaignId: string): Promise<unknown>;
  task(taskId: string): Promise<TiktokTaskLike>;
  /** lib/tiktok-launch tiktokTaskOutcome — injected so this module stays import-pure. */
  outcome(t: TiktokTaskLike): null | Record<string, unknown>;
  write(taskId: string, fields: Record<string, unknown>): void;
  flush(): Promise<unknown>;
  sleep(ms: number): Promise<void>;
  now(): number;
  jitter?(): number;
};

export type TiktokPumpOpts = {
  firstWaitMs?: number;
  retryMs?: number;
  refetchAfterMs?: number;
  giveUpMs?: number;
  settleMs?: number;
  settlePollMs?: number;
  deadlineMarginMs?: number;
};

const statusOf = (e: unknown): number | undefined => {
  const st = (e as { status?: unknown } | null)?.status;
  return typeof st === "number" ? st : undefined;
};
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const SETTLE_CONCURRENCY = 5;

export async function runTiktokPump(shots: TiktokPumpShot[], deadline: number, deps: TiktokPumpDeps, opts: TiktokPumpOpts = {}): Promise<void> {
  const firstWaitMs = opts.firstWaitMs ?? 30_000;
  const retryMs = opts.retryMs ?? 20_000;
  const refetchAfterMs = opts.refetchAfterMs ?? 150_000;
  const giveUpMs = opts.giveUpMs ?? 270_000;
  const settleMs = opts.settleMs ?? 360_000;
  const settlePollMs = opts.settlePollMs ?? 10_000;
  // The tail a shot admitted AT the margin may still need: its submit (the client's 60 s timeout)
  // plus, on a cold source, the dataset fetch (30 s in the pump's binding). Vercel kills the function
  // past maxDuration with the outcome UNRECORDED — a row left "running" over a campaign that may
  // exist — so the last 100 s of the budget admit nothing new.
  const margin = opts.deadlineMarginMs ?? 100_000;
  const jitter = deps.jitter ?? (() => 1000 + Math.floor(Math.random() * 2000));
  const now = () => deps.now();
  const outOfTime = () => now() >= deadline - margin;

  const fail = (shot: TiktokPumpShot, stage: string, error: string, status: "error" | "interrupted" = "error") =>
    deps.write(shot.taskId, { status, stage, error: error.slice(0, 1000), finished_at: now() });

  /** Board rows the partner refused — their remaining copies are not sent. */
  const rowRefusal = new Map<string, string>();
  /** Sources that can't be launched from in this wave, with the reason. */
  const sourceFailed = new Map<string, string>();
  /** Cold sources: when their fetch was first triggered, when the probe may go again. */
  const cold = new Map<string, { first: number; due: number; refetched: boolean; said: string }>();
  /** Partner task id → our row id, for every task sent and not yet settled. */
  const pending = new Map<string, string>();
  let lastSubmitAt = now();
  let firstSubmit = true;

  /** One settle pass: read every unsettled task (≤5 in flight) and write the FINAL ones. */
  const settleOnce = async (): Promise<void> => {
    const ids = [...pending.keys()];
    let next = 0;
    const worker = async () => {
      // No new read past the margin: a settle pass over many tasks must end inside the budget too.
      while (next < ids.length && !outOfTime()) {
        const partnerId = ids[next++];
        try {
          const verdict = deps.outcome(await deps.task(partnerId));
          if (!verdict) continue;
          deps.write(pending.get(partnerId) as string, { ...verdict, finished_at: now() });
          pending.delete(partnerId);
        } catch {
          // A failed read is not a verdict — the row stays "Sent to LION" and is asked again.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(SETTLE_CONCURRENCY, ids.length) }, worker));
  };

  /** Sleep `ms`, settling what was already sent every `settlePollMs` of it. */
  const sleepSettling = async (ms: number): Promise<void> => {
    let left = ms;
    while (left > 0) {
      const chunk = settleMs > 0 && pending.size > 0 ? Math.min(left, settlePollMs) : left;
      await deps.sleep(chunk);
      left -= chunk;
      if (settleMs > 0 && pending.size > 0) await settleOnce();
    }
  };

  /** Submit one shot. "deferred" = its source is cold (fetch triggered) — retry it later. */
  const attempt = async (shot: TiktokPumpShot): Promise<"sent" | "failed" | "deferred"> => {
    const shared = rowRefusal.get(shot.rowKey);
    if (shared) {
      fail(shot, "submit", shared);
      return "failed";
    }
    // Out of time BEFORE the jitter: a long tail of copies must be failed at once, not 1–3 s apiece
    // out of the seconds the final store writes still need.
    if (!firstSubmit && !outOfTime()) await deps.sleep(jitter());
    if (outOfTime()) {
      fail(shot, "submit", "Not submitted — the wave's time budget ran out before this copy; fire it again");
      return "failed";
    }
    firstSubmit = false;
    deps.write(shot.taskId, { stage: "submit", started_at: now() });
    try {
      const res = await deps.submit(shot.kind, shot.body);
      lastSubmitAt = now();
      deps.write(shot.taskId, { status: "done", stage: "sent", link: res.taskId, error: "", finished_at: now() });
      pending.set(res.taskId, shot.taskId);
      return "sent";
    } catch (e) {
      lastSubmitAt = now();
      const st = statusOf(e);
      if (st === 404 && shot.kind !== "launch") {
        const state = cold.get(shot.campaignId);
        if (!state) {
          try {
            await deps.datasetFetch(shot.campaignId);
          } catch (fe) {
            const reason =
              statusOf(fe) === 404
                ? `LION never saw campaign ${shot.campaignId} — it can't be ${shot.kind === "juro" ? "JURO'd" : "cloned"} through LION`
                : `source ${shot.campaignId}: the dataset fetch failed (${messageOf(fe)}) — re-fetch it on the board and fire again`;
            sourceFailed.set(shot.campaignId, reason);
            fail(shot, "dataset", reason);
            return "failed";
          }
          cold.set(shot.campaignId, { first: now(), due: now() + firstWaitMs, refetched: false, said: messageOf(e) });
        } else {
          state.due = now() + retryMs;
          state.said = messageOf(e);
        }
        deps.write(shot.taskId, { stage: "dataset" });
        return "deferred";
      }
      if (st !== undefined && st >= 400 && st < 500) {
        // Deterministic partner refusal: identical copies would be refused identically.
        const msg = messageOf(e);
        rowRefusal.set(shot.rowKey, msg);
        fail(shot, "submit", msg);
        return "failed";
      }
      fail(shot, "submit", `Ambiguous outcome (${messageOf(e)}) — the task may exist on tiktok-weapon; check the account in LION before re-firing`, "interrupted");
      return "failed";
    }
  };

  try {
    // ---- pass 1: every shot once, in board order ------------------------------------------------
    let deferred: TiktokPumpShot[] = [];
    for (const shot of shots) {
      const bad = shot.kind === "launch" ? undefined : sourceFailed.get(shot.campaignId);
      if (bad) {
        fail(shot, "dataset", bad);
        continue;
      }
      // A source already known to be cold: don't burn a submit on its other copies.
      if (shot.kind !== "launch" && cold.has(shot.campaignId)) {
        deps.write(shot.taskId, { stage: "dataset" });
        deferred.push(shot);
        continue;
      }
      if ((await attempt(shot)) === "deferred") deferred.push(shot);
    }

    // ---- pass 2: cold sources — one probe per source until it answers or the wait runs out -------
    while (deferred.length > 0) {
      if (outOfTime()) {
        for (const s of deferred) fail(s, "dataset", "Not submitted — the wave's time budget ran out while LION was still fetching the source; fire it again");
        break;
      }
      const sources = [...new Set(deferred.map((s) => s.campaignId))];
      const nextDue = Math.min(...sources.map((id) => cold.get(id)?.due ?? now()));
      const wait = Math.min(nextDue - now(), deadline - margin - now());
      if (wait > 0) await sleepSettling(wait);
      const stillWaiting: TiktokPumpShot[] = [];
      for (const id of sources) {
        const mine = deferred.filter((s) => s.campaignId === id);
        const state = cold.get(id);
        if (!state || state.due > now()) {
          stillWaiting.push(...mine);
          continue;
        }
        if (!state.refetched && now() - state.first >= refetchAfterMs) {
          state.refetched = true;
          // Best effort: a failed re-trigger is not a verdict — the first fetch may still land.
          await deps.datasetFetch(id).catch(() => undefined);
        }
        const [probe, ...rest] = mine;
        const outcome = await attempt(probe);
        if (outcome === "deferred") {
          if (now() - state.first >= giveUpMs) {
            // Every clone / JURO 404 is READ as "source not fetched" — the partner's own sentence rides
            // along, so a 404 that meant something else is not hidden behind ours.
            const reason = `source ${id}: not in LION's dataset after ${Math.round((now() - state.first) / 1000)} s — re-fetch it on the board and fire again (LION: ${state.said.slice(0, 200)})`;
            sourceFailed.set(id, reason);
            for (const s of mine) fail(s, "dataset", reason);
          } else {
            stillWaiting.push(...mine);
          }
          continue;
        }
        // The probe got a real answer (sent / refused / ambiguous): the source is no longer the
        // question — its other copies go out now (a shared refusal skips them by rowKey).
        cold.delete(id);
        for (const s of rest) if ((await attempt(s)) === "deferred") stillWaiting.push(s);
      }
      deferred = stillWaiting;
    }

    // ---- pass 3: settle — upgrade "Sent to LION" rows to what LION actually built ---------------
    const settleUntil = Math.min(lastSubmitAt + settleMs, deadline - margin);
    while (pending.size > 0 && now() < settleUntil) {
      await deps.sleep(Math.min(settlePollMs, settleUntil - now()));
      await settleOnce();
    }
  } finally {
    await deps.flush();
  }
}
