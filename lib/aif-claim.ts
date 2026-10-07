// Atomic AIF brand claim against the shared registry (`aif_maps`, UNIQUE index on `brand` → no two
// campaigns ever share a brand — the brand IS the partner's revenue key; a second insert of a brand
// fails with E11000, the former Strapi 400). Same claim contract as lib/gcm-claim, minus the MO-only
// binding ledger: AIF has no per-day revenue attribution yet, and the gcm ledger feeds MO money
// tooling that must never see foreign rows. Server-only.

import type { Document } from "mongodb";
import { AIF_POOL_MAX, aifBrandCode } from "./pool-codes.ts";
import { coll } from "./mongo.ts";
// Bounded store calls (8 s) — see lib/gcm-claim: claims fail fast, never hang a launch.
import { AIF_MAPS, STORE_TIMEOUT_MS, bounded, dupKeyOn, insertFresh, pickSchema } from "./store.ts";

type Json = Record<string, unknown>;

const errMsg = (e: unknown): string => (e as Error)?.message ?? String(e);

/** The registry row's attributes (schema.json of `aif-map`) and their column typing. */
const AIF_MAP_FIELDS = ["brand", "platform", "campaign_id", "adset_id", "ad_id", "ad_ids", "campaign_name", "destination", "status", "bound_at", "history", "notes"] as const;
const AIF_MAP_TYPING = { datetime: ["bound_at"] } as const;
const AIF_MAP_DEFAULTS: Json = {
  brand: null,
  platform: "facebook",
  campaign_id: null,
  adset_id: null,
  ad_id: null,
  ad_ids: null,
  campaign_name: null,
  destination: null,
  status: "active",
  bound_at: null,
  history: null,
  notes: null,
};

/**
 * Every brand currently in the registry (any status — the unique constraint spans them all).
 * One bounded read capped at the pool size plus slack (the 700-brand pool). Throws on a failed read —
 * a partial list must never masquerade as the whole registry.
 */
export async function fetchUsedBrands(): Promise<string[]> {
  // brand is unique → row count ≤ pool size; +1 page of slack (the old 100-per-page walk), hard-bounded.
  const limit = (Math.ceil(AIF_POOL_MAX / 100) + 1) * 100;
  let rows: Document[];
  try {
    const c = await coll(AIF_MAPS);
    rows = await bounded(c.find({}, { projection: { _id: 0, brand: 1 }, maxTimeMS: STORE_TIMEOUT_MS }).limit(limit).toArray(), "aif registry list");
  } catch (e) {
    throw new Error(`aif registry read failed: ${errMsg(e)}`);
  }
  return rows.map((r) => String(r.brand ?? "")).filter(Boolean);
}

async function usedBrands(): Promise<Set<string>> {
  // Degrade to empty on failure: the unique index is the real guard — a claim just walks forward
  // through collisions. The strict variant above is for callers that must not show a partial
  // registry (the /api/aif/brand preview).
  try {
    return new Set(await fetchUsedBrands());
  } catch {
    return new Set();
  }
}

/**
 * Reserve a brand (test01..test700 — 2-digit zero-padded below 10, per the partner's doc). Tries
 * `desired`, then walks to the next free brand on a unique-index collision. Returns the brand
 * claimed + the registry documentId (for later id back-fill / release). Atomic (the unique index).
 */
export async function claimBrand(
  desired: string,
  meta: Json,
): Promise<{ brand: string; documentId: string | null }> {
  const used = await usedBrands();
  const candidates: string[] = [];
  const m = /^test(\d{1,3})$/i.exec(desired.trim());
  const start = m ? Math.min(Math.max(parseInt(m[1], 10) || 1, 1), AIF_POOL_MAX) : 1;
  for (let n = start; n <= AIF_POOL_MAX; n++) if (!used.has(aifBrandCode(n))) candidates.push(aifBrandCode(n));
  for (let n = 1; n < start; n++) if (!used.has(aifBrandCode(n))) candidates.push(aifBrandCode(n));

  for (const brand of candidates) {
    try {
      const doc = await insertFresh(AIF_MAPS, {
        ...AIF_MAP_DEFAULTS,
        ...pickSchema(meta, AIF_MAP_FIELDS, AIF_MAP_TYPING),
        brand,
        platform: "facebook",
        status: "active",
        bound_at: new Date(),
      });
      return { brand, documentId: doc.documentId };
    } catch (e) {
      // E11000 on brand = unique violation (someone took it) → next candidate; anything else aborts.
      if (dupKeyOn(e, "brand")) continue;
      throw new Error(`brand claim failed: ${errMsg(e).slice(0, 200)}`);
    }
  }
  throw new Error(`brand pool exhausted — no free brand test01–test${AIF_POOL_MAX}`);
}

/** Patch the registry row (FB ids after a create, failure notes on a kept-retired row). Best-effort. */
export async function backfillBrand(documentId: string | null, patch: Json): Promise<void> {
  if (!documentId) return;
  const data = pickSchema(patch, AIF_MAP_FIELDS, AIF_MAP_TYPING);
  delete data.brand; // the unique key is immutable
  if (Object.keys(data).length === 0) return;
  try {
    const c = await coll(AIF_MAPS);
    await bounded(c.updateOne({ documentId }, { $set: { ...data, updatedAt: new Date() } }), "aif registry update");
  } catch {
    /* best-effort */
  }
}

/** Release a claimed brand (delete the row) when a launch fails before any FB resource exists —
 *  a brand that never carried traffic is pool capacity, not history. Best-effort. */
export async function deleteBrand(documentId: string): Promise<void> {
  try {
    const c = await coll(AIF_MAPS);
    await bounded(c.deleteOne({ documentId }), "aif registry delete");
  } catch {
    /* best-effort */
  }
}
