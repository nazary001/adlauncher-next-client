// Shared cross-instance KV cache backed by the MongoDB `app_caches` collection (one row per key:
// ckey UNIQUE, cvalue json, refreshed_at). Serverless module caches die on every cold start and
// aren't shared between instances; this row survives and is shared, so all instances see one
// swept result and one refresh claim. Every helper degrades to null/no-op when the store is
// unavailable — callers must treat this layer as best-effort. Bounded (8 s): best-effort must also
// mean fail-FAST — a hung store otherwise pins the calling route to its maxDuration.

import type { Document } from "mongodb";
import { coll } from "./mongo.ts";
import { APP_CACHES, STORE_TIMEOUT_MS, bounded, insertFresh, storeConfigured, strapiRow } from "./store.ts";

export type AppCacheRow<T> = { documentId: string; value: T | null; refreshedAt: number };

const PROJECTION = { _id: 0, documentId: 1, cvalue: 1, refreshed_at: 1 } as const;

function rowOf<T>(r: Document | null): AppCacheRow<T> | null {
  if (!r?.documentId) return null;
  return { documentId: String(r.documentId), value: (r.cvalue ?? null) as T | null, refreshedAt: Number(r.refreshed_at) || 0 };
}

export async function readAppCache<T>(key: string): Promise<AppCacheRow<T> | null> {
  const r = await readAppCacheDetailed<T>(key);
  return r.ok ? r.row : null;
}

/** Like readAppCache, but DISTINGUISHES "no row yet" (ok:true, row:null) from "store
 *  unavailable" (ok:false) — read-modify-write callers must refuse to write over a row they
 *  could not read, or a store blip would silently wipe it. */
export async function readAppCacheDetailed<T>(
  key: string,
): Promise<{ ok: boolean; row: AppCacheRow<T> | null }> {
  if (!storeConfigured()) return { ok: false, row: null };
  try {
    const c = await coll(APP_CACHES);
    const doc = await bounded(c.findOne({ ckey: key }, { projection: PROJECTION, maxTimeMS: STORE_TIMEOUT_MS }), "app-cache read");
    return { ok: true, row: rowOf<T>(doc) };
  } catch {
    return { ok: false, row: null };
  }
}

/** Upsert the row (update by documentId, else insert). Returns the documentId, null when unavailable.
 *  An insert losing the unique-ckey race (E11000 — the former POST 400) just returns null — the next
 *  read picks the winner's row. */
export async function writeAppCache<T>(
  key: string,
  value: T,
  documentId?: string | null,
): Promise<string | null> {
  if (!storeConfigured()) return null;
  try {
    const c = await coll(APP_CACHES);
    if (documentId) {
      // The update never touches ckey (immutable) — and a failed update must NOT fall through to an
      // insert of the same ckey.
      const r = await bounded(
        c.updateOne({ documentId }, { $set: { cvalue: value as unknown, refreshed_at: Date.now(), updatedAt: new Date() } }),
        "app-cache update",
      );
      return r.matchedCount > 0 ? documentId : null;
    }
    const doc = await insertFresh(APP_CACHES, { ckey: key, cvalue: value as unknown, refreshed_at: Date.now() });
    return doc.documentId;
  } catch {
    return null;
  }
}

/**
 * EVERY row stored under one key, OLDEST first (createdAt, then documentId — the same total order
 * every reader computes). With the unique index on ckey there is at most one row per key; callers
 * that verify a claim keep working unchanged (the one row is the one winner). `ok:false` = the store
 * could not be read (never "no rows").
 */
export async function readAppCacheAll<T>(key: string): Promise<{ ok: boolean; rows: AppCacheRow<T>[] }> {
  if (!storeConfigured()) return { ok: false, rows: [] };
  try {
    const c = await coll(APP_CACHES);
    const docs = await bounded(
      c.find({ ckey: key }, { projection: PROJECTION, maxTimeMS: STORE_TIMEOUT_MS }).sort({ createdAt: 1, documentId: 1 }).limit(10).toArray(),
      "app-cache read",
    );
    const rows = docs.map((d) => rowOf<T>(strapiRow(d))).filter((r): r is AppCacheRow<T> => r !== null);
    return { ok: true, rows };
  } catch {
    return { ok: false, rows: [] };
  }
}
