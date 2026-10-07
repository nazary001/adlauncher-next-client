// Snapchat rail — the partner-key REGISTRY (glo-snp_001…500 — 100 until 23.09 — one key per campaign) over the
// shared `app_caches` collection: one row per claimed key, ckey "snap-key:<key>" (UNIQUE index → an insert
// on a taken key fails with E11000 → the claim is atomic without a dedicated collection), cvalue = the
// binding. Same claim contract as lib/aif-claim. Server-only; the store is reached through ./mongo.ts
// (relative `.ts` imports so `node --test` loads this module straight from disk).
// Nothing here fails quietly: a registry write that did not happen is reported to the caller (the
// pump folds it into the launch row, the keys route answers 502) — a key the registry has lost
// track of is an attribution hazard, not a detail.
// Moving to a dedicated `snap-map` collection later = replacing this one file.

import type { Document } from "mongodb";
import { coll } from "./mongo.ts";
import { APP_CACHES, STORE_TIMEOUT_MS, bounded, dupKeyOn, insertFresh, prefixFilter } from "./store.ts";

export const SNAP_KEY_CKEY_PREFIX = "snap-key:";

// The key codec below is a deliberate LOCAL COPY of lib/snap-launch.ts — snapKeyCode / snapKeyIndex /
// SNAP_KEY_RE / SNAP_KEY_POOL_MAX are the canonical twin; KEEP IN SYNC. A runtime import is not an
// option: `node --test` resolves a relative import only with an explicit `.ts` extension, and the
// rest of the rail's pure modules stay import-free for that reason.
const POOL_MAX = 500; // 500 since 23.09 (partner extended the pool from 100); twin of SNAP_KEY_POOL_MAX
/** Registry rows the list reads at most: every pool key plus slack (the old 100-per-page walk read
 *  ceil(POOL_MAX / 100) + 1 pages — a cap of 2 pages hid keys 201+ once the pool grew past 200). */
const LIST_LIMIT = (Math.ceil(POOL_MAX / 100) + 1) * 100;
const KEY_RE = /^glo-snp_(\d{3})$/;
const keyCode = (n: number): string => `glo-snp_${String(n).padStart(3, "0")}`;
const keyIndex = (key: string): number | null => {
  const m = KEY_RE.exec(String(key ?? "").trim());
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= POOL_MAX ? n : null;
};
/** The pool size the keys route reports — the same constant the arithmetic below walks
 *  (`snapFreeKeys([]).length === SNAP_KEY_POOL_SIZE`), so the GET payload is self-consistent. */
export const SNAP_KEY_POOL_SIZE = POOL_MAX;

export type SnapKeyBinding = {
  key: string;
  /** active = the campaign runs on this key · retired = a campaign exists but the launch failed
   *  after it (kept so revenue stays attributable; the owner releases it by hand). */
  status: "active" | "retired";
  user: string;
  claimed_at: number;
  campaign_id?: string;
  adsquad_id?: string;
  /** The FIRST ad of the campaign; `ad_count` says how many the card's creatives built. */
  ad_id?: string;
  ad_count?: number;
  ad_account?: string;
  niche?: string;
  landing?: string;
  name?: string;
  notes?: string;
  task_id?: string;
  /** A CLONE's source Snapchat campaign id (the cloner, /snap/clone). */
  clone_of?: string;
};
export type SnapKeyRow = SnapKeyBinding & { documentId: string };
/** A won claim: the key, its registry row and the binding written into it (what a backfill merges into). */
export type SnapKeyClaimed = { key: string; documentId: string; binding: SnapKeyBinding };

const str = (v: unknown): string => (v == null ? "" : String(v));
const errMsg = (e: unknown): string => (e as Error)?.message ?? String(e);

const PROJECTION = { _id: 0, documentId: 1, ckey: 1, cvalue: 1 } as const;

function rowOf(raw: Document): SnapKeyRow | null {
  const documentId = str(raw.documentId);
  const v = (raw.cvalue && typeof raw.cvalue === "object" ? raw.cvalue : {}) as Record<string, unknown>;
  const key = str(v.key) || str(raw.ckey).replace(SNAP_KEY_CKEY_PREFIX, "");
  if (!documentId || keyIndex(key) == null) return null;
  return {
    ...(v as Partial<SnapKeyBinding>),
    key,
    status: v.status === "retired" ? "retired" : "active",
    user: str(v.user),
    claimed_at: Number(v.claimed_at) || 0,
    documentId,
  };
}

// ---------- pure pool arithmetic ----------

/** Keys not in `used`, in pool order. */
export function snapFreeKeys(used: Iterable<string>): string[] {
  const taken = new Set(used);
  const out: string[] = [];
  for (let n = 1; n <= POOL_MAX; n++) if (!taken.has(keyCode(n))) out.push(keyCode(n));
  return out;
}

/** Claim order: `desired` first (when it is a pool key), then forward from it, wrapping around. */
export function snapKeyCandidates(used: Iterable<string>, desired?: string): string[] {
  const taken = new Set(used);
  const start = keyIndex(desired ?? "") ?? 1;
  const out: string[] = [];
  for (let n = start; n <= POOL_MAX; n++) if (!taken.has(keyCode(n))) out.push(keyCode(n));
  for (let n = 1; n < start; n++) if (!taken.has(keyCode(n))) out.push(keyCode(n));
  return out;
}

/** The key a launch would take: desired when free, else the next free one (wrap), null when none. */
export function snapNextKey(used: Iterable<string>, desired?: string): string | null {
  return snapKeyCandidates(used, desired)[0] ?? null;
}

// ---------- reads ----------

/** Every registry row (any status), key order. Throws on a failed read (`registry read failed …`) —
 *  a partial registry must never masquerade as the whole. */
export async function listSnapKeys(): Promise<SnapKeyRow[]> {
  let docs: Document[];
  try {
    const c = await coll(APP_CACHES);
    docs = await bounded(
      c.find({ ckey: prefixFilter(SNAP_KEY_CKEY_PREFIX) }, { projection: PROJECTION, maxTimeMS: STORE_TIMEOUT_MS }).sort({ ckey: 1 }).limit(LIST_LIMIT).toArray(),
      "snap registry list",
    );
  } catch (e) {
    throw new Error(`registry read failed: ${errMsg(e)}`);
  }
  return docs
    .map(rowOf)
    .filter((r): r is SnapKeyRow => Boolean(r))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** The row bound to `key`, null ONLY when no row exists; a failed read throws (`registry read failed …`)
 *  so "unknown" is never reported as "free". */
export async function findSnapKey(key: string): Promise<SnapKeyRow | null> {
  let doc: Document | null;
  try {
    const c = await coll(APP_CACHES);
    doc = await bounded(c.findOne({ ckey: SNAP_KEY_CKEY_PREFIX + key }, { projection: PROJECTION, maxTimeMS: STORE_TIMEOUT_MS }), "snap registry read");
  } catch (e) {
    throw new Error(`registry read failed: ${errMsg(e)}`);
  }
  return doc ? rowOf(doc) : null;
}

// ---------- claim ----------

/**
 * Reserve one key: `desired` first, then the next free ones (wrap). A unique-ckey collision (E11000)
 * = taken → next candidate; the index is atomic, so a successful insert IS the win. Throws when the
 * pool is exhausted or the store fails otherwise.
 */
export async function claimSnapKey(desired: string | undefined, meta: Partial<SnapKeyBinding> & { user: string }): Promise<SnapKeyClaimed> {
  let used: string[] = [];
  try {
    used = (await listSnapKeys()).map((r) => r.key);
  } catch {
    used = []; // the unique index is the real guard — a claim just walks through collisions
  }
  const candidates = snapKeyCandidates(used, desired);
  if (candidates.length === 0) throw new Error(`snap key pool exhausted — no free key glo-snp_001…${POOL_MAX}`);
  for (const key of candidates) {
    const binding: SnapKeyBinding = { ...meta, key, status: "active", user: meta.user, claimed_at: Date.now() };
    try {
      const doc = await insertFresh(APP_CACHES, { ckey: SNAP_KEY_CKEY_PREFIX + key, cvalue: binding, refreshed_at: Date.now() });
      return { key, documentId: doc.documentId, binding };
    } catch (e) {
      if (dupKeyOn(e, "ckey")) continue; // someone holds this key — walk on
      throw new Error(`snap key claim failed: ${errMsg(e).slice(0, 200)}`);
    }
  }
  throw new Error(`snap key pool exhausted — no free key glo-snp_001…${POOL_MAX}`);
}

// ---------- writes ----------

async function putBinding(documentId: string, merged: SnapKeyBinding): Promise<boolean> {
  const c = await coll(APP_CACHES);
  const r = await bounded(c.updateOne({ documentId }, { $set: { cvalue: merged, refreshed_at: Date.now(), updatedAt: new Date() } }), "snap registry update");
  return r.matchedCount > 0;
}

/** Merge `patch` into the key's binding (the update never touches the unique ckey). Throws on a failed
 *  find, on a missing row (the campaign would be running on a key the registry considers free) and on a
 *  failed update (`snap key backfill failed …`) — the pump folds the message into the launch row.
 *  Given the CLAIM of this same key (its row id + the binding it wrote — nothing else writes the row
 *  between the claim and the pump's one backfill), the row is updated by id with no find. */
export async function backfillSnapKey(key: string, patch: Partial<SnapKeyBinding>, claim?: { key: string; documentId: string; binding?: Partial<SnapKeyBinding> }): Promise<void> {
  if (claim && claim.key === key && claim.documentId && claim.binding) {
    const merged = { ...claim.binding, ...patch, key } as SnapKeyBinding;
    let matched: boolean;
    try {
      matched = await putBinding(claim.documentId, merged);
    } catch (e) {
      throw new Error(`snap key backfill failed (${errMsg(e)})`);
    }
    if (!matched) throw new Error(`snap key backfill failed: no registry row for ${key}`);
    return;
  }
  const row = await findSnapKey(key);
  if (!row) throw new Error(`snap key backfill failed: no registry row for ${key}`);
  const { documentId, ...current } = row;
  const merged: SnapKeyBinding = { ...current, ...patch, key };
  let matched: boolean;
  try {
    matched = await putBinding(documentId, merged);
  } catch (e) {
    throw new Error(`snap key backfill failed (${errMsg(e)})`);
  }
  if (!matched) throw new Error(`snap key backfill failed: no registry row for ${key}`);
}

/** Delete the row — the key returns to the pool (a key that never carried traffic is capacity, not
 *  history). Throws when no row went away (`snap key release failed (not found)`) or on a store error
 *  (`snap key release failed (…)`) — the caller decides (the pump keeps the key visible, the route
 *  answers 502). */
export async function releaseSnapKey(documentId: string): Promise<void> {
  let deleted: number;
  try {
    const c = await coll(APP_CACHES);
    deleted = (await bounded(c.deleteOne({ documentId }), "snap registry delete")).deletedCount;
  } catch (e) {
    throw new Error(`snap key release failed (${errMsg(e)})`);
  }
  if (deleted === 0) throw new Error("snap key release failed (not found)");
}

/** Owner release from the keys page: false ONLY when no row exists, true after a SUCCESSFUL
 *  delete; a failed find or delete propagates (the route answers 502, never `released: true`). */
export async function releaseSnapKeyByKey(key: string): Promise<boolean> {
  const row = await findSnapKey(key);
  if (!row) return false;
  await releaseSnapKey(row.documentId);
  return true;
}
