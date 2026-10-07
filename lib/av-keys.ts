// AV rail — the KEY REGISTRY (av001…, one key per campaign — the AIF-brand twin) over the shared
// `app_caches` collection: one row per claimed key, ckey "av-key:<key>" (UNIQUE index → an insert on a
// taken key fails with E11000 → the claim is atomic without a dedicated collection), cvalue = the
// binding. Same claim contract as lib/snap-keys. Server-only; the store is reached through ./mongo.ts
// (relative `.ts` imports so `node --test` loads this module straight from disk).
//
// The LAUNCHABLE range is the registered one: a key earns reportable revenue only once it is uploaded
// to AV's "UTM Campaign Values" (UI only, no API) — so every claim walks av001…av<registered> and
// nothing else. registered = 0 (the default until the owner uploads the pool) = no key can be claimed.
// Nothing here fails quietly: a registry write that did not happen is reported to the caller.

import type { Document } from "mongodb";
import { coll } from "./mongo.ts";
import { APP_CACHES, STORE_TIMEOUT_MS, bounded, dupKeyOn, insertFresh, prefixFilter } from "./store.ts";

export const AV_KEY_CKEY_PREFIX = "av-key:";

// Key codec — a deliberate LOCAL COPY of lib/av-link.ts (avKeyCode / avKeyIndex / AV_KEY_POOL_MAX are
// the canonical twin; KEEP IN SYNC). A runtime import is not an option for a `node --test`-able module
// here: node resolves a relative import only with an explicit `.ts` extension — the same reason
// lib/snap-keys copies its codec.
const POOL_MAX = 999;
const LIST_LIMIT = (Math.ceil(POOL_MAX / 100) + 1) * 100;
const KEY_RE = /^av(\d{3})$/;
const keyCode = (n: number): string => `av${String(n).padStart(3, "0")}`;
const keyIndex = (key: string): number | null => {
  const m = KEY_RE.exec(String(key ?? "").trim());
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= POOL_MAX ? n : null;
};
const clampRegistered = (registered: number): number =>
  Number.isFinite(registered) && registered > 0 ? Math.min(Math.floor(registered), POOL_MAX) : 0;

export type AvKeyBinding = {
  key: string;
  /** active = the campaign runs on this key · retired = a campaign exists but the launch failed after
   *  it (kept so revenue stays attributable; the owner releases it by hand on the AV keys page). */
  status: "active" | "retired";
  user: string;
  claimed_at: number;
  /** "launch" | "clone" — which board claimed it. */
  via?: string;
  campaign_id?: string;
  adset_id?: string;
  /** The FIRST ad of the campaign; `ad_count` says how many the card's creatives built. */
  ad_id?: string;
  ad_count?: number;
  ad_account?: string;
  destination?: string;
  name?: string;
  notes?: string;
  task_id?: string;
  source_campaign_id?: string;
};
export type AvKeyRow = AvKeyBinding & { documentId: string };

const str = (v: unknown): string => (v == null ? "" : String(v));
const errMsg = (e: unknown): string => (e as Error)?.message ?? String(e);

const PROJECTION = { _id: 0, documentId: 1, ckey: 1, cvalue: 1 } as const;

function rowOf(raw: Document): AvKeyRow | null {
  const documentId = str(raw.documentId);
  const v = (raw.cvalue && typeof raw.cvalue === "object" ? raw.cvalue : {}) as Record<string, unknown>;
  const key = str(v.key) || str(raw.ckey).replace(AV_KEY_CKEY_PREFIX, "");
  if (!documentId || keyIndex(key) == null) return null;
  return {
    ...(v as Partial<AvKeyBinding>),
    key,
    status: v.status === "retired" ? "retired" : "active",
    user: str(v.user),
    claimed_at: Number(v.claimed_at) || 0,
    documentId,
  };
}

// ---------- pure pool arithmetic (registered range only) ----------

/** Registered keys not in `used`, in pool order. */
export function avFreeKeys(used: Iterable<string>, registered: number): string[] {
  const taken = new Set(used);
  const max = clampRegistered(registered);
  const out: string[] = [];
  for (let n = 1; n <= max; n++) if (!taken.has(keyCode(n))) out.push(keyCode(n));
  return out;
}

/** Claim order: `desired` first (when it is a registered key), then forward from it, wrapping around. */
export function avKeyCandidates(used: Iterable<string>, registered: number, desired?: string): string[] {
  const taken = new Set(used);
  const max = clampRegistered(registered);
  const want = keyIndex(desired ?? "");
  const start = want != null && want <= max ? want : 1;
  const out: string[] = [];
  for (let n = start; n <= max; n++) if (!taken.has(keyCode(n))) out.push(keyCode(n));
  for (let n = 1; n < start; n++) if (!taken.has(keyCode(n))) out.push(keyCode(n));
  return out;
}

/** The key a launch would take: desired when free, else the next free one (wrap), null when none. */
export function avNextKey(used: Iterable<string>, registered: number, desired?: string): string | null {
  return avKeyCandidates(used, registered, desired)[0] ?? null;
}

// ---------- reads ----------

/** Every registry row (any status), key order. Throws on a failed read (`registry read failed …`) —
 *  a partial registry must never masquerade as the whole. */
export async function listAvKeys(): Promise<AvKeyRow[]> {
  let docs: Document[];
  try {
    const c = await coll(APP_CACHES);
    docs = await bounded(
      c.find({ ckey: prefixFilter(AV_KEY_CKEY_PREFIX) }, { projection: PROJECTION, maxTimeMS: STORE_TIMEOUT_MS }).sort({ ckey: 1 }).limit(LIST_LIMIT).toArray(),
      "av registry list",
    );
  } catch (e) {
    throw new Error(`registry read failed: ${errMsg(e)}`);
  }
  return docs
    .map(rowOf)
    .filter((r): r is AvKeyRow => Boolean(r))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** The row bound to `key`, null ONLY when no row exists; a failed read throws (`registry read failed …`)
 *  so "unknown" is never reported as "free". */
export async function findAvKey(key: string): Promise<AvKeyRow | null> {
  let doc: Document | null;
  try {
    const c = await coll(APP_CACHES);
    doc = await bounded(c.findOne({ ckey: AV_KEY_CKEY_PREFIX + key }, { projection: PROJECTION, maxTimeMS: STORE_TIMEOUT_MS }), "av registry read");
  } catch (e) {
    throw new Error(`registry read failed: ${errMsg(e)}`);
  }
  return doc ? rowOf(doc) : null;
}

// ---------- claim ----------

/**
 * Reserve one REGISTERED key: `desired` first, then the next free ones (wrap). A unique-ckey collision
 * (E11000) = taken → next candidate; the index is atomic, so a successful insert IS the win. Throws
 * `av_keys_not_registered` when the registered range is empty (the stub), `av key pool exhausted` when
 * every registered key is bound, or on any other store failure.
 */
export async function claimAvKey(
  desired: string | undefined,
  registered: number,
  meta: Partial<AvKeyBinding> & { user: string },
): Promise<{ key: string; documentId: string }> {
  const max = clampRegistered(registered);
  if (max === 0) {
    throw new Error("av_keys_not_registered — no AV keys are registered in ActiveView yet (owner: upload the pool on the AV keys page, then set AV_KEYS_REGISTERED)");
  }
  let used: string[] = [];
  try {
    used = (await listAvKeys()).map((r) => r.key);
  } catch {
    used = []; // the unique index is the real guard — a claim just walks through collisions
  }
  const candidates = avKeyCandidates(used, max, desired);
  if (candidates.length === 0) throw new Error(`av key pool exhausted — every registered key av001…${keyCode(max)} is bound (register more in ActiveView)`);
  for (const key of candidates) {
    const binding: AvKeyBinding = { ...meta, key, status: "active", user: meta.user, claimed_at: Date.now() };
    try {
      const doc = await insertFresh(APP_CACHES, { ckey: AV_KEY_CKEY_PREFIX + key, cvalue: binding, refreshed_at: Date.now() });
      return { key, documentId: doc.documentId };
    } catch (e) {
      if (dupKeyOn(e, "ckey")) continue; // someone holds this key — walk on
      throw new Error(`av key claim failed: ${errMsg(e).slice(0, 200)}`);
    }
  }
  throw new Error(`av key pool exhausted — every registered key av001…${keyCode(max)} is bound (register more in ActiveView)`);
}

// ---------- writes ----------

/** Merge `patch` into the row's binding by documentId (the update never touches the unique ckey).
 *  Throws on a failed find/update or a missing row. */
export async function backfillAvKey(key: string, patch: Partial<AvKeyBinding>): Promise<void> {
  const row = await findAvKey(key);
  if (!row) throw new Error(`av key backfill failed: no registry row for ${key}`);
  const { documentId, ...current } = row;
  const merged: AvKeyBinding = { ...current, ...patch, key };
  let matched: boolean;
  try {
    const c = await coll(APP_CACHES);
    matched = (await bounded(c.updateOne({ documentId }, { $set: { cvalue: merged, refreshed_at: Date.now(), updatedAt: new Date() } }), "av registry update")).matchedCount > 0;
  } catch (e) {
    throw new Error(`av key backfill failed (${errMsg(e)})`);
  }
  if (!matched) throw new Error(`av key backfill failed: no registry row for ${key}`);
}

/** Delete the row — the key returns to the pool (a key that never carried traffic is capacity, not
 *  history). Throws when no row went away or on a store error. */
export async function releaseAvKey(documentId: string): Promise<void> {
  let deleted: number;
  try {
    const c = await coll(APP_CACHES);
    deleted = (await bounded(c.deleteOne({ documentId }), "av registry delete")).deletedCount;
  } catch (e) {
    throw new Error(`av key release failed (${errMsg(e)})`);
  }
  if (deleted === 0) throw new Error("av key release failed (not found)");
}

/** Owner release from the AV keys page: false ONLY when no row exists, true after a SUCCESSFUL delete;
 *  a failed find or delete propagates (the route answers 502, never `released: true`). */
export async function releaseAvKeyByKey(key: string): Promise<boolean> {
  const row = await findAvKey(key);
  if (!row) return false;
  await releaseAvKey(row.documentId);
  return true;
}
