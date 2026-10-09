// Snapchat rail — binds the real world into the pure pump (lib/snap-pump-core.ts): the Snapchat
// client (exactly-once creates), the key registry (app-cache rows), the creative download (the
// board's S3 file, or Snap's own download link for a clone re-hosted on another account) and the
// shared task-store writer. Since 09.10 a wave is one queue job PER SHOT (lib/launch-queue-runners):
// the runner feeds this binder one shot and its own observed row writer; the media a card's copies
// used to share inside one wave is remembered DURABLY (app_caches `snap-media:<account>|<url>`,
// 12 h) so copies that run as separate jobs upload each creative once.

import { createHash } from "node:crypto";
import { taskWriter, type TaskRowData } from "./task-store";
import { readAppCache, writeAppCache } from "./app-cache";
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

export const SNAP_PARTNER = "sn";

/** How long a remembered Snap media id is reused (a media object is an account-library asset; the
 *  core still asks Snapchat whether it is READY before trusting a remembered id). */
export const SNAP_MEDIA_REUSE_MS = 12 * 60 * 60_000;

type Writer = ReturnType<typeof taskWriter>;

/** The registry key of one (ad account, creative URL) upload — the URL hashed so the key stays short. */
export function snapMediaCacheKey(cacheKey: string): string {
  const [account, ...rest] = cacheKey.split("|");
  const url = rest.join("|");
  return `snap-media:${account}|${createHash("sha1").update(url).digest("hex")}`;
}

async function lookupSnapMedia(cacheKey: string): Promise<string | null> {
  const row = await readAppCache<{ id?: string; at?: number }>(snapMediaCacheKey(cacheKey));
  const id = String(row?.value?.id ?? "").trim();
  const at = Number(row?.value?.at) || 0;
  if (!id || Date.now() - at > SNAP_MEDIA_REUSE_MS) return null;
  return id;
}

async function rememberSnapMedia(cacheKey: string, mediaId: string): Promise<void> {
  const key = snapMediaCacheKey(cacheKey);
  const existing = await readAppCache<unknown>(key);
  await writeAppCache(key, { id: mediaId, at: Date.now() }, existing?.documentId ?? null);
}

export type SnapPumpOverrides = {
  /** The row writer to use instead of a fresh task-store writer per task (the queue runner's observed one). */
  write?: (taskId: string, fields: Record<string, unknown>) => void;
  flush?: () => Promise<void>;
  /** Durable media reuse on / off (on by default). */
  durableMedia?: boolean;
};

/** Build the real-world deps for a run of the pure pump. */
export function snapPumpDeps(user: string, overrides: SnapPumpOverrides = {}): SnapPumpDeps {
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
  const durable = overrides.durableMedia !== false;
  return {
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
    buildWire: (shot, resolved) => {
      const b = snapLaunchWire(shot, resolved);
      return "refusal" in b ? b : { wire: b.wire, label: b.label };
    },
    buildName: ({ key, niche, geoLabel, tail, cloneOf }) => snapCampaignName({ ddmm: todaySaoPauloDotDDMM(), niche, geoLabel, key, user, tail, cloneOf }),
    write: overrides.write ?? ((taskId, fields) => writerOf(taskId).write(fields as TaskRowData)),
    flush:
      overrides.flush ??
      (async () => {
        await Promise.all([...writers.values()].map((w) => w.flush()));
      }),
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    maxMediaBytes: SNAP_MEDIA_MAX_BYTES,
    mediaPollMs: 5_000,
    mediaWaitMs: 120_000,
    ...(durable ? { lookupMedia: lookupSnapMedia, rememberMedia: rememberSnapMedia } : {}),
  };
}

/** Run shots (one, on the queue) with the real deps. */
export function pumpSnapWave(user: string, shots: SnapPumpShot[], deadline: number, overrides: SnapPumpOverrides = {}): Promise<void> {
  return runSnapPump(user, shots, deadline, snapPumpDeps(user, overrides));
}
