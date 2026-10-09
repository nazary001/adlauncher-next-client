// The settle pass of a TikTok wave as a PURE algorithm (every side effect injected) — the old
// pass 3 of lib/tiktok-pump-core: the sent tasks are read until LION finishes them and the
// "done · Sent to LION" rows are upgraded to what LION actually built (the real campaign id and
// name) or to LION's failure. Since 09.10 it runs as the wave's tt.follow queue job in slices
// (lib/launch-queue-runners): every write is a conditional upgrade of a row that still says
// "sent" for THIS partner task — a repeated slice can never rewrite a row somebody settled.
// Relative `.ts` imports only (node --test loads this straight from disk).

import type { TiktokTaskLike } from "./tiktok-launch.ts";

export type TtFollowShot = { taskId: string; lionTaskId: string };

export type TtFollowDeps = {
  /** ONE bounded read of a partner task (a failed read must throw — it is not a verdict). */
  task(taskId: string): Promise<TiktokTaskLike>;
  /** lib/tiktok-launch tiktokTaskOutcome: null = not final yet. */
  outcome(t: TiktokTaskLike): null | Record<string, unknown>;
  /** Upgrade the row while it still says "sent" for this partner task. True = written. */
  write(taskId: string, lionTaskId: string, verdict: Record<string, unknown>): Promise<boolean>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log?(msg: string): void;
};

export type TtFollowResult = { settled: string[]; pending: TtFollowShot[] };

const CONCURRENCY = 5;

/** One slice: read every pending task (≤ 5 in flight) every `pollMs` until the slice ends or
 *  nothing is pending. A read that fails is not a verdict — the row stays "sent" and is asked again. */
export async function runTtFollowSlice(shots: TtFollowShot[], deps: TtFollowDeps, opts: { sliceEndAt: number; pollMs?: number }): Promise<TtFollowResult> {
  const pollMs = opts.pollMs ?? 15_000;
  const pending = new Map(shots.map((s) => [s.taskId, s]));
  const settled: string[] = [];
  const now = () => deps.now();
  while (pending.size > 0 && now() < opts.sliceEndAt) {
    const list = [...pending.values()];
    let next = 0;
    const worker = async () => {
      while (next < list.length && now() < opts.sliceEndAt) {
        const s = list[next++];
        try {
          const verdict = deps.outcome(await deps.task(s.lionTaskId));
          if (!verdict) continue;
          await deps.write(s.taskId, s.lionTaskId, { ...verdict, finished_at: now() });
          pending.delete(s.taskId);
          settled.push(s.taskId);
        } catch (e) {
          deps.log?.(`tt follow read ${s.lionTaskId} failed: ${(e as Error).message ?? String(e)}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
    if (pending.size === 0 || now() >= opts.sliceEndAt) break;
    await deps.sleep(Math.min(pollMs, Math.max(0, opts.sliceEndAt - now())));
  }
  return { settled, pending: [...pending.values()] };
}
