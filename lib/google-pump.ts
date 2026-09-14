// Google Ads rail — the after() wave pump behind /api/google/clone and /api/google/juro.
// Mirrors the HS/LION duplicate pump (app/api/hs/duplicate/route.ts): rows are already stamped
// into the shared Strapi store by the route; this advances them server-side so the team sees the
// truth even when the firing browser dies. Three phases:
//   1. dataset — every distinct source is brought into google-weapon's launch dataset (fetch →
//      poll); a source that can't be fetched fails ALL its shots at stage "dataset".
//   2. submit  — shots go out ONE AT A TIME with a 1–3 s jitter, EXACTLY ONCE: 201 → the row
//      carries the partner task id; a clean 4xx is the partner's sentence on the row and the
//      remaining copies of the same board row (identical wire) skip with the same refusal; a
//      5xx/network cut is AMBIGUOUS (the task may exist) → status "interrupted", never re-sent.
//   3. poll    — task reads every 10 s until every task is terminal or the time budget ends;
//      completed → done (+ the real campaign id/name), failed → error. Rows still running at the
//      deadline are finished by the owner's browser (the Google task manager polls /api/google/status).

import { googleTaskStage, type GoogleMode } from "./google-bid";
import {
  GoogleWeaponError,
  gwCampaignLaunch,
  gwCloneLaunch,
  gwEnsureDataset,
  gwJuroLaunch,
  gwTasks,
  type GwCloneBody,
  type GwJuroBody,
  type GwLaunchBody,
} from "./google-weapon";
import { taskWriter, type TaskRowData } from "./task-store";

export const GOOGLE_PARTNER = "gg";
export const GOOGLE_PUMP_BUDGET_MS = 770_000;
const POLL_MS = 10_000;
const DEADLINE_MARGIN_MS = 20_000;

export type GooglePumpShot = {
  taskId: string;
  mode: GoogleMode;
  campaignId: string;
  /** The exact partner wire for this shot. */
  body: GwCloneBody | GwJuroBody | GwLaunchBody;
  /** Board row this shot is a copy of — copies share one wire, so one refusal covers them all. */
  rowKey: string;
};

type Writer = ReturnType<typeof taskWriter>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const jitter = () => 1000 + Math.floor(Math.random() * 2000);

/** Run a batch of async jobs with at most `limit` in flight. */
async function eachLimit<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await run(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export async function pumpGoogleWave(
  user: string,
  shots: GooglePumpShot[],
  deadline: number,
  deps: {
    ensureDataset?: typeof gwEnsureDataset;
    cloneLaunch?: typeof gwCloneLaunch;
    juroLaunch?: typeof gwJuroLaunch;
    campaignLaunch?: typeof gwCampaignLaunch;
    readTasks?: typeof gwTasks;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<void> {
  const ensureDataset = deps.ensureDataset ?? gwEnsureDataset;
  const cloneLaunch = deps.cloneLaunch ?? gwCloneLaunch;
  const juroLaunch = deps.juroLaunch ?? gwJuroLaunch;
  const campaignLaunch = deps.campaignLaunch ?? gwCampaignLaunch;
  const readTasks = deps.readTasks ?? gwTasks;
  const wait = deps.sleep ?? sleep;
  const now = deps.now ?? (() => Date.now());

  const writers = new Map<string, Writer>();
  const writerOf = (taskId: string): Writer => {
    let w = writers.get(taskId);
    if (!w) {
      w = taskWriter(user, taskId, { partner: GOOGLE_PARTNER });
      writers.set(taskId, w);
    }
    return w;
  };
  const write = (taskId: string, fields: TaskRowData) => writerOf(taskId).write(fields);
  const flushAll = async () => {
    await Promise.all([...writers.values()].map((w) => w.flush()));
  };

  const failed = new Set<string>();
  const fail = (shot: GooglePumpShot, stage: string, error: string, status: "error" | "interrupted" = "error") => {
    failed.add(shot.taskId);
    write(shot.taskId, { status, stage, error: error.slice(0, 1000), finished_at: now() });
  };

  // ---- phase 1: datasets (clone / JURO only — a fresh launch has no source) ----------------
  const sources = [...new Set(shots.filter((s) => s.mode !== "launch").map((s) => s.campaignId))];
  const datasetFailure = new Map<string, string>();
  for (const s of shots) if (s.mode !== "launch") write(s.taskId, { stage: "dataset" });
  await eachLimit(sources, 3, async (campaignId) => {
    // Datasets take 30–120 s; keep them inside the pump's budget (minus room to submit).
    const budget = Math.max(30_000, Math.min(180_000, deadline - now() - 120_000));
    const r = await ensureDataset(campaignId, { maxWaitMs: budget, retryWaitMs: Math.min(120_000, budget) });
    if (!r.ok) datasetFailure.set(campaignId, r.reason);
  });
  for (const s of shots) {
    const reason = datasetFailure.get(s.campaignId);
    if (reason) fail(s, "dataset", reason);
  }

  // ---- phase 2: submit, one at a time --------------------------------------------------------
  const pending = new Map<string, GooglePumpShot>(); // partner task id → shot
  const rowRefusal = new Map<string, string>();
  let first = true;
  for (const shot of shots) {
    if (failed.has(shot.taskId)) continue;
    if (now() > deadline - DEADLINE_MARGIN_MS) {
      fail(shot, "submit", "Not submitted — the wave's time budget ran out before this copy; fire it again");
      continue;
    }
    const shared = rowRefusal.get(shot.rowKey);
    if (shared) {
      fail(shot, "submit", shared);
      continue;
    }
    if (!first) await wait(jitter());
    first = false;
    write(shot.taskId, { stage: "submit", started_at: now() });
    try {
      const res =
        shot.mode === "clone"
          ? await cloneLaunch(shot.body as GwCloneBody)
          : shot.mode === "juro"
            ? await juroLaunch(shot.body as GwJuroBody)
            : await campaignLaunch(shot.body as GwLaunchBody);
      pending.set(res.taskId, shot);
      write(shot.taskId, { stage: "lion", link: res.taskId, status: "running" });
    } catch (e) {
      const err = e instanceof GoogleWeaponError ? e : null;
      if (err?.status && err.status < 500) {
        // Deterministic partner refusal: identical copies would be refused identically.
        const msg = err.message;
        rowRefusal.set(shot.rowKey, msg);
        fail(shot, "submit", msg);
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        fail(shot, "submit", `Ambiguous outcome (${msg}) — the task may exist on google-weapon; check the account before re-firing`, "interrupted");
      }
    }
  }

  // ---- phase 3: poll ---------------------------------------------------------------------------
  // Stage writes only on CHANGE — a 45-shot wave polled every 10 s would otherwise hammer the
  // shared Strapi with no-op writes.
  const lastStage = new Map<string, string>();
  while (pending.size > 0 && now() < deadline - DEADLINE_MARGIN_MS) {
    await wait(POLL_MS);
    const ids = [...pending.keys()];
    let tasks;
    try {
      tasks = await readTasks(ids);
    } catch {
      continue; // transient — next tick
    }
    for (const t of tasks) {
      const shot = pending.get(t.taskId);
      if (!shot) continue;
      const stage = googleTaskStage(t.status);
      if (stage === "done") {
        pending.delete(t.taskId);
        write(shot.taskId, {
          status: "done",
          stage: "done",
          campaign_id: t.campaignId ?? "",
          ...(t.campaignName ? { name: t.campaignName } : {}),
          finished_at: now(),
        });
      } else if (stage === "failed") {
        pending.delete(t.taskId);
        fail(shot, "failed", t.error || "google-weapon task failed");
      } else if (t.status === "not_found") {
        // The task record vanished (or belongs to another user) — nothing more to learn here.
        pending.delete(t.taskId);
        fail(shot, "lion", `google-weapon lost task ${t.taskId} (${t.error ?? "not found"}) — check the account`, "interrupted");
      } else if (stage === "lion" || stage === "queue") {
        if (lastStage.get(shot.taskId) !== stage) {
          lastStage.set(shot.taskId, stage);
          write(shot.taskId, { stage });
        }
      }
      // "unknown" (read failed) → keep polling
    }
  }
  await flushAll();
}
