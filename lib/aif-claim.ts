// Atomic AIF brand claim against the shared Strapi registry (`aif-maps`, unique `brand` field →
// no two campaigns ever share a brand — the brand IS the partner's revenue key). Same race-safe
// claim-then-verify contract as lib/gcm-claim (proven live there under concurrent waves), minus
// the MO-only binding ledger: AIF has no per-day revenue attribution yet, and the gcm ledger
// feeds MO money tooling that must never see foreign rows. Server-only.

import { AIF_POOL_MAX, aifBrandCode } from "@/lib/partners";
// Bounded Strapi client (8s abort) — see lib/gcm-claim: claims fail fast, never hang a launch.
import { strapiFetch } from "@/lib/task-store";

const STRAPI = (process.env.STRAPI_API_URL ?? "").replace(/\/+$/, "");
const STRAPI_TOKEN = process.env.STRAPI_TOKEN ?? "";

type Json = Record<string, unknown>;

/**
 * Every brand currently in the registry (any status — the unique constraint spans them all).
 * Paged: Strapi Cloud CLAMPS pageSize to 100, so a single fetch would silently drop rows once
 * the pool grows past 100 (the 700-brand pool guarantees it will). Throws on any failed page —
 * a partial list must never masquerade as the whole registry.
 */
export async function fetchUsedBrands(): Promise<string[]> {
  const out: string[] = [];
  // brand is unique → row count ≤ pool size; +1 page of slack, hard-bounded against runaway loops.
  const maxPages = Math.ceil(AIF_POOL_MAX / 100) + 1;
  for (let page = 1; page <= maxPages; page++) {
    const res = await strapiFetch(
      `${STRAPI}/api/aif-maps?fields[0]=brand&pagination[page]=${page}&pagination[pageSize]=100`,
      { headers: { Authorization: `Bearer ${STRAPI_TOKEN}` }, cache: "no-store" },
    );
    if (!res.ok) throw new Error(`strapi ${res.status}`);
    const body = await res.json().catch(() => ({}));
    const rows = (body.data ?? []) as Array<{ brand?: string }>;
    out.push(...rows.map((r) => String(r.brand ?? "")).filter(Boolean));
    if (rows.length < 100) break;
  }
  return out;
}

async function usedBrands(): Promise<Set<string>> {
  // Degrade to empty on failure: the POST's unique constraint is the real guard — a claim just
  // walks forward through 400s. The strict variant above is for callers that must not show a
  // partial registry (the /api/aif/brand preview).
  try {
    return new Set(await fetchUsedBrands());
  } catch {
    return new Set();
  }
}

/**
 * Did WE win this brand? After a POST "succeeds", re-read every row for the brand (oldest first,
 * documentId as the tiebreak) — Strapi's app-level uniqueness has a TOCTOU window that lets two
 * CONCURRENT POSTs of the same value both return 2xx (proven live on the gcm registry). The row
 * that committed first is the sole winner; every later claimant sees the collision and yields.
 * On a read failure we optimistically keep the row (degrade to best-effort).
 */
async function wonClaim(brand: string, documentId: string): Promise<boolean> {
  try {
    const res = await strapiFetch(
      `${STRAPI}/api/aif-maps?filters[brand][$eq]=${brand}&sort[0]=createdAt:asc&sort[1]=documentId:asc&fields[0]=brand&pagination[pageSize]=10`,
      { headers: { Authorization: `Bearer ${STRAPI_TOKEN}` }, cache: "no-store" },
    );
    if (!res.ok) return true;
    const body = await res.json().catch(() => ({}));
    const rows = (body.data ?? []) as Array<{ documentId?: string }>;
    if (rows.length <= 1) return true;
    return rows[0]?.documentId === documentId; // we win only if ours is the earliest row
  } catch {
    return true;
  }
}

/**
 * Reserve a brand (test01..test700 — 2-digit zero-padded below 10, per the partner's doc). Tries
 * `desired`, then walks to the next free brand on a unique-violation OR a lost concurrent race.
 * Returns the brand claimed + the Strapi documentId (for later id back-fill / release).
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
    const res = await strapiFetch(`${STRAPI}/api/aif-maps`, {
      method: "POST",
      headers: { Authorization: `Bearer ${STRAPI_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        data: {
          brand,
          platform: "facebook",
          status: "active",
          bound_at: new Date().toISOString(),
          ...meta,
        },
      }),
    });
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      const documentId: string | null = body?.data?.documentId ?? null;
      // Can't verify without a documentId → keep it (best-effort).
      if (!documentId || (await wonClaim(brand, documentId))) {
        return { brand, documentId };
      }
      // Lost a concurrent race for this brand → release our loser row and try the next candidate.
      await deleteBrand(documentId);
      continue;
    }
    if (res.status !== 400) {
      // 400 = unique violation (someone took it) → next candidate; anything else aborts.
      const body = await res.json().catch(() => ({}));
      throw new Error(`brand claim failed (${res.status}): ${JSON.stringify(body).slice(0, 200)}`);
    }
  }
  throw new Error(`brand pool exhausted — no free brand test01–test${AIF_POOL_MAX}`);
}

/** Patch the registry row (FB ids after a create, failure notes on a kept-retired row). */
export async function backfillBrand(documentId: string | null, patch: Json): Promise<void> {
  if (!documentId) return;
  await strapiFetch(`${STRAPI}/api/aif-maps/${documentId}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${STRAPI_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ data: patch }),
  }).catch(() => {});
}

/** Release a claimed brand (delete the row) when a launch fails before any FB resource exists —
 *  a brand that never carried traffic is pool capacity, not history. */
export async function deleteBrand(documentId: string): Promise<void> {
  await strapiFetch(`${STRAPI}/api/aif-maps/${documentId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${STRAPI_TOKEN}` },
  }).catch(() => {});
}
