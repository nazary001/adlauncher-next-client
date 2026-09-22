// Snapchat rail — binds the real world into the pure pump (lib/snap-pump-core.ts): the Snapchat
// client (exactly-once creates), the key registry (app-cache rows), the Blob download and the
// shared task-store writer. Runs inside after() from the wave route; rows are already stamped.

import { taskWriter, type TaskRowData } from "./task-store";
import { SNAP_MEDIA_MAX_BYTES, snapCampaignName, snapLaunchWire, todaySaoPauloDotDDMM } from "./snap-launch";
import {
  snapCreateAd,
  snapCreateAdSquad,
  snapCreateCampaign,
  snapCreateCreative,
  snapCreateMedia,
  snapFetchBytes,
  snapMediaReady,
  snapSetCampaignStatus,
  snapUploadMedia,
} from "./snap-api";
import { backfillSnapKey, claimSnapKey, releaseSnapKey } from "./snap-keys";
import { runSnapPump, type SnapPumpDeps, type SnapPumpShot } from "./snap-pump-core";
import { snapResolvedSchedule } from "./snap-schedule";
import { SNAP_DEFAULT_ACCOUNT_TZ } from "./snap-launch";

export const SNAP_PARTNER = "sn";

type Writer = ReturnType<typeof taskWriter>;

export function pumpSnapWave(user: string, shots: SnapPumpShot[], deadline: number): Promise<void> {
  const writers = new Map<string, Writer>();
  const writerOf = (taskId: string): Writer => {
    let w = writers.get(taskId);
    if (!w) {
      // partner:"sn" rides on EVERY write so even a row this writer creates lands in the Snap drawer.
      w = taskWriter(user, taskId, { partner: SNAP_PARTNER });
      writers.set(taskId, w);
    }
    return w;
  };
  const deps: SnapPumpDeps = {
    claimKey: (desired, meta) => claimSnapKey(desired, { ...(meta as Record<string, string>), user }),
    releaseKey: releaseSnapKey,
    backfillKey: backfillSnapKey,
    fetchBytes: (url) => snapFetchBytes(url, SNAP_MEDIA_MAX_BYTES),
    createMedia: snapCreateMedia,
    uploadMedia: snapUploadMedia,
    mediaReady: snapMediaReady,
    createCampaign: snapCreateCampaign,
    createAdSquad: snapCreateAdSquad,
    createCreative: snapCreateCreative,
    createAd: snapCreateAd,
    setCampaignStatus: snapSetCampaignStatus,
    resolveSchedule: (tz) => snapResolvedSchedule(tz || SNAP_DEFAULT_ACCOUNT_TZ),
    buildWire: (shot, resolved) => {
      const b = snapLaunchWire(shot, resolved);
      return "refusal" in b ? b : { wire: b.wire, label: b.label };
    },
    buildName: ({ key, niche, geoLabel, tail }) => snapCampaignName({ ddmm: todaySaoPauloDotDDMM(), niche, geoLabel, key, user, tail }),
    write: (taskId, fields) => writerOf(taskId).write(fields as TaskRowData),
    flush: async () => {
      await Promise.all([...writers.values()].map((w) => w.flush()));
    },
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    maxMediaBytes: SNAP_MEDIA_MAX_BYTES,
    mediaPollMs: 5_000,
    mediaWaitMs: 120_000,
  };
  return runSnapPump(user, shots, deadline, deps);
}
