// Head-start / reuse of Meta videos (spec §4.6). A video is an account-library asset: an ad that
// reuses a video_id already registered in the same ad account is the same thing a duplicate / clone
// does. So when two ads (or a job and the pump's head start) ship the SAME content-addressed
// creative into the SAME account, Meta should register it once and the processing wait mostly
// disappears.
//
// Two layers live here:
//   1. resolveCachedVideo — the PURE decision (injected deps), unit-tested in tests/fb-media-cache.ts;
//   2. the Mongo accessors over collection `fb_media_cache` the real deps are built from.
// Relative `.ts` imports only, so `node --test` can load this module (the pure decision touches no
// I/O; importing ./mongo.ts opens no connection until a Mongo accessor is actually called).

import { coll } from "./mongo.ts";
import { STORE_TIMEOUT_MS, bounded } from "./store.ts";

/** The probe verdict for a cached video id: a GET <video_id>?fields=status answer we can trust
 *  ("ready"/"processing") vs anything else ("stale" — error status, missing object, …). */
export type VideoProbeStatus = "ready" | "processing" | "stale";

/** Everything the pure decision needs, injected so it can be tested without Mongo or Graph. */
export type VideoCacheDeps = {
  /** Cached video_id for this ckey, or null for a miss. */
  readCache: (ckey: string) => Promise<string | null>;
  /** Best-effort write of a fresh upload (expiry handled inside the real impl). */
  writeCache: (ckey: string, videoId: string) => Promise<void>;
  /** Best-effort drop of a cache entry that no longer points at a usable video. */
  dropCache: (ckey: string) => Promise<void>;
  /** One GET <video_id>?fields=status → a trust verdict (may throw: a Graph "object does not
   *  exist" / network error is treated as a stale entry by the caller). */
  probe: (videoId: string) => Promise<VideoProbeStatus>;
  /** Register the video fresh (act_/advideos) and return its new id. */
  uploadFresh: () => Promise<string>;
};

/**
 * Decide a video id for one upload, reusing a cached one when it is still real.
 *
 *  - ckey null (a non-content-addressed URL, or reuse switched off) → never touch the cache: just
 *    upload fresh. Nothing can collide on a random/foreign key, so there is nothing safe to reuse.
 *  - otherwise: an in-process in-flight map makes two concurrent callers with the SAME ckey (the job
 *    and its head start) share ONE upload; a cache hit is trusted ONLY after a probe answers
 *    "ready"/"processing"; anything else (a stale/error status, a Graph throw) drops the entry and
 *    uploads fresh; a fresh upload is cached best-effort. A cache READ or WRITE failure never fails
 *    the upload — the worst case is simply "register it again", exactly today's behaviour.
 */
export async function resolveCachedVideo(
  ckey: string | null,
  deps: VideoCacheDeps,
  inflight: Map<string, Promise<string>>,
): Promise<string> {
  if (!ckey) return deps.uploadFresh();

  const existing = inflight.get(ckey);
  if (existing) return existing;

  const run = (async (): Promise<string> => {
    let cached: string | null = null;
    try {
      cached = await deps.readCache(ckey);
    } catch {
      cached = null; // a store blip must never fail the upload — fall through to a fresh register
    }
    if (cached) {
      let status: VideoProbeStatus = "stale";
      try {
        status = await deps.probe(cached);
      } catch {
        status = "stale"; // a Graph error ("object does not exist") / network throw → drop + fresh
      }
      if (status === "ready" || status === "processing") return cached;
      await deps.dropCache(ckey).catch(() => {});
    }
    const fresh = await deps.uploadFresh();
    try {
      await deps.writeCache(ckey, fresh);
    } catch {
      /* a cache write failure never fails the upload (the id is already good) */
    }
    return fresh;
  })();

  inflight.set(ckey, run);
  try {
    return await run;
  } finally {
    inflight.delete(ckey);
  }
}

// ---- Mongo accessors over `fb_media_cache` (the TTL index on expire_at is created by the indexer) ----

/** One cache row: ckey "<account>|<key>" unique, the Meta video id, the account + object key for
 *  traceability, and the TTL witness expire_at (FB_VIDEO_REUSE_HOURS from write). */
export type FbMediaCacheDoc = {
  ckey: string;
  video_id: string;
  account: string;
  key: string;
  createdAt: Date;
  expire_at: Date;
};

const COLLECTION = "fb_media_cache";

/** Cached video id for this ckey, or null for a miss. The reuse window is checked HERE as well: the
 *  TTL index only prunes about once a minute, and a row past its window must never be reused.
 *  Bounded like every store call — a hung store may cost a launch one fresh registration, never time. */
export async function readMediaCache(ckey: string, now: number = Date.now()): Promise<string | null> {
  const c = await coll<FbMediaCacheDoc>(COLLECTION);
  const doc = await bounded(c.findOne({ ckey, expire_at: { $gt: new Date(now) } }, { maxTimeMS: STORE_TIMEOUT_MS }), "fb-media-cache read");
  return doc?.video_id ? String(doc.video_id) : null;
}

/** Upsert a fresh registration with its reuse window (TTL); expire_at = now + reuseHours. */
export async function writeMediaCache(
  ckey: string,
  videoId: string,
  account: string,
  key: string,
  reuseHours: number,
  now: number = Date.now(),
): Promise<void> {
  const c = await coll<FbMediaCacheDoc>(COLLECTION);
  await bounded(
    c.updateOne(
      { ckey },
      {
        $set: {
          video_id: videoId,
          account,
          key,
          createdAt: new Date(now),
          expire_at: new Date(now + Math.max(0, reuseHours) * 3_600_000),
        },
      },
      { upsert: true },
    ),
    "fb-media-cache write",
  );
}

/** Drop whatever entries point at this video id — called when a video turned out unusable AFTER it
 *  was handed out (processing failed or never finished), so it is not reused again. Best-effort. */
export async function dropMediaCacheByVideo(videoId: string): Promise<void> {
  if (!videoId) return;
  const c = await coll<FbMediaCacheDoc>(COLLECTION);
  await bounded(c.deleteMany({ video_id: videoId }, { maxTimeMS: STORE_TIMEOUT_MS }), "fb-media-cache drop by video");
}

/** Drop an entry whose video no longer answers ready/processing. */
export async function dropMediaCache(ckey: string): Promise<void> {
  const c = await coll<FbMediaCacheDoc>(COLLECTION);
  await bounded(c.deleteOne({ ckey }), "fb-media-cache drop");
}
