// Atomic gcm-code claim against the shared registry (`gcm_maps`, UNIQUE index on `gcm` → no two ads
// ever share a code: a second insert of a code fails with E11000, the former Strapi 400). Same
// contract as app/api/launch/route.ts, extracted so the clone run reuses it without touching the
// launch route. Server-only.

import type { Document } from "mongodb";
import { GCM_POOL_MAX, gcmCode } from "./pool-codes.ts";
import { coll } from "./mongo.ts";
// Bounded store calls (8 s): a hung registry must fail a claim fast, never pin the launch function to
// its maxDuration — the same class of hang that caused the task-route 504s.
import { GCM_BINDING_LOGS, GCM_MAPS, STORE_TIMEOUT_MS, bounded, dupKeyOn, insertFresh, pickSchema } from "./store.ts";

type Json = Record<string, unknown>;

const errMsg = (e: unknown): string => (e as Error)?.message ?? String(e);

/** The registry row's attributes (schema.json of `gcm-map`) and their column typing. */
const GCM_MAP_FIELDS = ["gcm", "platform", "campaign_id", "adset_id", "ad_id", "ad_ids", "campaign_name", "landing", "status", "bound_at", "history", "notes"] as const;
const GCM_MAP_TYPING = { datetime: ["bound_at"] } as const;
/** Every attribute a fresh row carries (schema defaults, nulls for the rest) — other readers of this
 *  collection (hs-tools gcm-stats, the MO value pipeline) index the keys directly. */
const GCM_MAP_DEFAULTS: Json = {
  gcm: null,
  platform: "facebook",
  campaign_id: null,
  adset_id: null,
  ad_id: null,
  ad_ids: null,
  campaign_name: null,
  landing: null,
  status: "active",
  bound_at: null,
  history: null,
  notes: null,
};

/**
 * Every code currently in the registry (any status — the unique constraint spans them all).
 * One bounded read capped at the pool size plus slack. Throws on a failed read — a partial list must
 * never masquerade as the whole registry.
 */
export async function fetchUsedGcms(): Promise<string[]> {
  // gcm is unique → row count ≤ pool size; +1 page of slack (the old 100-per-page walk), hard-bounded.
  const limit = (Math.ceil(GCM_POOL_MAX / 100) + 1) * 100;
  let rows: Document[];
  try {
    const c = await coll(GCM_MAPS);
    rows = await bounded(c.find({}, { projection: { _id: 0, gcm: 1 }, maxTimeMS: STORE_TIMEOUT_MS }).limit(limit).toArray(), "gcm registry list");
  } catch (e) {
    throw new Error(`gcm registry read failed: ${errMsg(e)}`);
  }
  return rows.map((r) => String(r.gcm ?? "")).filter(Boolean);
}

async function usedCodes(): Promise<Set<string>> {
  // Degrade to empty on failure: the unique index is the real guard — a claim just walks forward
  // through collisions. The strict variant above is for callers that must not show a partial
  // registry (the /api/gcm preview).
  try {
    return new Set(await fetchUsedGcms());
  } catch {
    return new Set();
  }
}

// ---- binding ledger (gcm_binding_logs) ------------------------------------------------------
// Append-only epoch history: one row per campaign that held a code, bound_at..released_at
// (null = current holder). hs-tools reads it to attribute per-day revenue across code reuse
// (spec: MKLearn docs/superpowers/specs/2026-08-12-gcm-recycle-ledger-design.md). Every write
// here is BEST-EFFORT — the ledger is bookkeeping, a hiccup must never break a launch.

/** Binding facts the ledger mirrors; the registry-only `status` field must never reach it
 *  (only the ledger's own attributes are persisted). */
const LEDGER_FIELDS = new Set([
  "campaign_id",
  "adset_id",
  "ad_id",
  "campaign_name",
  "landing",
  "notes",
]);

/** Open a fresh epoch for a just-won claim (full ledger shape: released_at null = current holder). */
async function ledgerOpen(gcm: string, meta: Json): Promise<void> {
  try {
    await insertFresh(GCM_BINDING_LOGS, {
      gcm,
      campaign_id: null,
      adset_id: null,
      ad_id: null,
      campaign_name: (meta.campaign_name as string | null) ?? null,
      landing: (meta.landing as string | null) ?? null,
      bound_at: new Date(),
      released_at: null,
      reason: "claim",
      notes: null,
    });
  } catch {
    /* best-effort */
  }
}

/** documentId of the code's OPEN epoch (released_at null — a missing field counts as null, like SQL
 *  IS NULL), newest first, or null. */
async function ledgerOpenRow(gcm: string): Promise<string | null> {
  try {
    const c = await coll(GCM_BINDING_LOGS);
    const row = await bounded(
      c.findOne({ gcm, released_at: null }, { sort: { createdAt: -1 }, projection: { _id: 0, documentId: 1 }, maxTimeMS: STORE_TIMEOUT_MS }),
      "ledger read",
    );
    return row?.documentId ? String(row.documentId) : null;
  } catch {
    return null;
  }
}

/** Mirror binding facts (FB ids / failure notes) into the code's open epoch. */
async function ledgerPatch(gcm: string, patch: Json): Promise<void> {
  const data: Json = {};
  for (const [k, v] of Object.entries(patch)) if (LEDGER_FIELDS.has(k)) data[k] = v;
  if (Object.keys(data).length === 0) return;
  const doc = await ledgerOpenRow(gcm);
  if (!doc) return;
  try {
    const c = await coll(GCM_BINDING_LOGS);
    await bounded(c.updateOne({ documentId: doc }, { $set: { ...data, updatedAt: new Date() } }), "ledger update");
  } catch {
    /* best-effort */
  }
}

/** Drop the open epoch — a claim that failed before ANY FB resource existed never carried
 *  traffic, so it is noise, not history. */
async function ledgerDrop(gcm: string): Promise<void> {
  const doc = await ledgerOpenRow(gcm);
  if (!doc) return;
  try {
    const c = await coll(GCM_BINDING_LOGS);
    await bounded(c.deleteOne({ documentId: doc }), "ledger delete");
  } catch {
    /* best-effort */
  }
}

/**
 * Reserve a gcm code (01–200: 2-digit padded below 100, plain 3-digit above — the buy-link contract
 * gcm=N accepts 1..200 since 2026-08-10). Tries `desired`, then walks to the next free code on a
 * unique-index collision. Returns the code claimed + the registry documentId (for later id
 * back-fill / release). Atomic (the unique index). A won claim also opens the code's ledger epoch
 * (bound_at = now) for per-day revenue attribution.
 */
export async function claimGcm(
  desired: string,
  meta: Json,
): Promise<{ gcm: string; documentId: string | null }> {
  const used = await usedCodes();
  const candidates: string[] = [];
  const start = /^\d{1,3}$/.test(desired) ? Math.min(parseInt(desired, 10) || 1, GCM_POOL_MAX) : 1;
  for (let n = start; n <= GCM_POOL_MAX; n++) if (!used.has(gcmCode(n))) candidates.push(gcmCode(n));
  for (let n = 1; n < start; n++) if (!used.has(gcmCode(n))) candidates.push(gcmCode(n));

  for (const gcm of candidates) {
    try {
      const doc = await insertFresh(GCM_MAPS, {
        ...GCM_MAP_DEFAULTS,
        ...pickSchema(meta, GCM_MAP_FIELDS, GCM_MAP_TYPING),
        gcm,
        platform: "facebook",
        status: "active",
        bound_at: new Date(),
      });
      await ledgerOpen(gcm, meta);
      return { gcm, documentId: doc.documentId };
    } catch (e) {
      // E11000 on gcm = unique violation (someone took it) → next candidate; anything else aborts.
      if (dupKeyOn(e, "gcm")) continue;
      throw new Error(`gcm claim failed: ${errMsg(e).slice(0, 200)}`);
    }
  }
  throw new Error(`gcm pool exhausted — no free code 01–${GCM_POOL_MAX}`);
}

/** Patch the registry row; when `gcm` is given, mirror the binding facts into its open ledger
 *  epoch too (FB ids after a create, failure notes on a kept-retired row). Best-effort. */
export async function backfillGcm(documentId: string | null, patch: Json, gcm?: string): Promise<void> {
  if (documentId) {
    const data = pickSchema(patch, GCM_MAP_FIELDS, GCM_MAP_TYPING);
    delete data.gcm; // the unique key is immutable
    if (Object.keys(data).length > 0) {
      try {
        const c = await coll(GCM_MAPS);
        await bounded(c.updateOne({ documentId }, { $set: { ...data, updatedAt: new Date() } }), "gcm registry update");
      } catch {
        /* best-effort */
      }
    }
  }
  if (gcm) await ledgerPatch(gcm, patch);
}

/** Release a claimed code (delete the row) when a launch/clone fails before any FB resource is
 *  created. Pass `gcm` to also drop the code's open ledger epoch (never-carried-traffic noise). */
export async function deleteGcm(documentId: string, gcm?: string): Promise<void> {
  try {
    const c = await coll(GCM_MAPS);
    await bounded(c.deleteOne({ documentId }), "gcm registry delete");
  } catch {
    /* best-effort */
  }
  if (gcm) await ledgerDrop(gcm);
}
