// TikTok rail — binds the pure wave algorithm (lib/tiktok-pump-core.ts) to the real tiktok-weapon
// client and the shared task store. Runs inside after() behind /api/tiktok/{launch,clone,juro}.

import { tiktokTaskOutcome, type TiktokCloneWire, type TiktokJuroWire, type TiktokLaunchWire } from "./tiktok-launch";
import { runTiktokPump, type TiktokPumpShot } from "./tiktok-pump-core";
import { twCampaignLaunch, twCloneLaunch, twDatasetFetch, twJuroLaunch, twTask } from "./tiktok-weapon";
import { taskWriter, type TaskRowData } from "./task-store";

export const TIKTOK_PARTNER = "tt";
export { TIKTOK_PUMP_BUDGET_MS, type TiktokPumpShot } from "./tiktok-pump-core";

type Writer = ReturnType<typeof taskWriter>;

export async function pumpTiktokWave(user: string, shots: TiktokPumpShot[], deadline: number): Promise<void> {
  const writers = new Map<string, Writer>();
  const writerOf = (taskId: string): Writer => {
    let w = writers.get(taskId);
    if (!w) {
      w = taskWriter(user, taskId, { partner: TIKTOK_PARTNER });
      writers.set(taskId, w);
    }
    return w;
  };
  await runTiktokPump(shots, deadline, {
    submit: (kind, body) =>
      kind === "launch" ? twCampaignLaunch(body as TiktokLaunchWire) : kind === "clone" ? twCloneLaunch(body as TiktokCloneWire) : twJuroLaunch(body as TiktokJuroWire),
    // Reads inside the pump are ONE bounded attempt: the pump re-asks by design (the dataset probe,
    // the settle pass), and a hung partner must not eat the wave's time budget.
    datasetFetch: (campaignId) => twDatasetFetch(campaignId, { attempts: 1, timeoutMs: 30_000 }),
    task: (taskId) => twTask(taskId, { attempts: 1, timeoutMs: 15_000 }),
    outcome: tiktokTaskOutcome,
    write: (taskId, fields) => writerOf(taskId).write(fields as TaskRowData),
    flush: () => Promise.all([...writers.values()].map((w) => w.flush())),
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    // Monotonic: a wall-clock step (NTP, a VM resume) must not stretch or collapse the wave's budget.
    // Same epoch as Date.now(), so it compares with the route's `deadline` and stamps rows in ms.
    now: () => Math.round(performance.timeOrigin + performance.now()),
  });
}
