// Atomic gcm-code claim against the shared Strapi registry (unique `gcm` field → no two ads ever
// share a code). Same contract as app/api/launch/route.ts, extracted so the clone run reuses it
// without touching the launch route. Server-only.

import { GCM_POOL_MAX, gcmCode } from "@/lib/partners";

const STRAPI = (process.env.STRAPI_API_URL ?? "").replace(/\/+$/, "");
const STRAPI_TOKEN = process.env.STRAPI_TOKEN ?? "";

type Json = Record<string, unknown>;

/**
 * Every code currently in the registry (any status — the unique constraint spans them all).
 * Paged: Strapi Cloud CLAMPS pageSize to 100 (verified live — `pageSize=200` comes back as 100),
 * so a single fetch would silently drop rows once the pool grows past 100. Throws on any failed
 * page — a partial list must never masquerade as the whole registry.
 */
export async function fetchUsedGcms(): Promise<string[]> {
  const out: string[] = [];
  // gcm is unique → row count ≤ pool size; +1 page of slack, hard-bounded against runaway loops.
  const maxPages = Math.ceil(GCM_POOL_MAX / 100) + 1;
  for (let page = 1; page <= maxPages; page++) {
    const res = await fetch(
      `${STRAPI}/api/gcm-maps?fields[0]=gcm&pagination[page]=${page}&pagination[pageSize]=100`,
      { headers: { Authorization: `Bearer ${STRAPI_TOKEN}` }, cache: "no-store" },
    );
    if (!res.ok) throw new Error(`strapi ${res.status}`);
    const body = await res.json().catch(() => ({}));
    const rows = (body.data ?? []) as Array<{ gcm?: string }>;
    out.push(...rows.map((r) => String(r.gcm ?? "")).filter(Boolean));
    if (rows.length < 100) break;
  }
  return out;
}

async function usedCodes(): Promise<Set<string>> {
  // Degrade to empty on failure: the POST's unique constraint is the real guard — a claim just
  // walks forward through 400s. The strict variant above is for callers that must not show a
  // partial registry (the /api/gcm preview).
  try {
    return new Set(await fetchUsedGcms());
  } catch {
    return new Set();
  }
}

/**
 * Did WE win this code? After a POST "succeeds", re-read every row for the code (oldest first,
 * documentId as the tiebreak) — Strapi's app-level uniqueness has a TOCTOU window that lets two
 * CONCURRENT POSTs of the same code both return 2xx (proven live: a 3-wide launch wave produced two
 * rows for one code). The row that committed first (smallest createdAt, then documentId) is the sole
 * winner; every later claimant sees the collision and yields. Deterministic → all racers agree.
 * On a read failure we optimistically keep the row (degrade to the old best-effort behaviour).
 */
async function wonClaim(gcm: string, documentId: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${STRAPI}/api/gcm-maps?filters[gcm][$eq]=${gcm}&sort[0]=createdAt:asc&sort[1]=documentId:asc&fields[0]=gcm&pagination[pageSize]=10`,
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

// ---- binding ledger (gcm-binding-logs) ------------------------------------------------------
// Append-only epoch history: one row per campaign that held a code, bound_at..released_at
// (null = current holder). hs-tools reads it to attribute per-day revenue across code reuse
// (spec: MKLearn docs/superpowers/specs/2026-08-12-gcm-recycle-ledger-design.md). Every write
// here is BEST-EFFORT — the ledger is bookkeeping, a hiccup must never break a launch.

/** Binding facts the ledger mirrors; the registry-only `status` field must never reach it
 *  (Strapi rejects unknown attributes with a 400 for the WHOLE PUT). */
const LEDGER_FIELDS = new Set([
  "campaign_id",
  "adset_id",
  "ad_id",
  "campaign_name",
  "landing",
  "notes",
]);

/** Open a fresh epoch for a just-won claim. */
async function ledgerOpen(gcm: string, meta: Json): Promise<void> {
  try {
    await fetch(`${STRAPI}/api/gcm-binding-logs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${STRAPI_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        data: {
          gcm,
          bound_at: new Date().toISOString(),
          reason: "claim",
          campaign_name: (meta.campaign_name as string | null) ?? null,
          landing: (meta.landing as string | null) ?? null,
        },
      }),
    });
  } catch {
    /* best-effort */
  }
}

/** documentId of the code's OPEN epoch (released_at null), newest first, or null. */
async function ledgerOpenRow(gcm: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${STRAPI}/api/gcm-binding-logs?filters[gcm][$eq]=${gcm}&filters[released_at][$null]=true` +
        `&sort=createdAt:desc&pagination[pageSize]=1&fields[0]=gcm`,
      { headers: { Authorization: `Bearer ${STRAPI_TOKEN}` }, cache: "no-store" },
    );
    if (!res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as {
      data?: Array<{ documentId?: string }>;
    };
    return body?.data?.[0]?.documentId ?? null;
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
  await fetch(`${STRAPI}/api/gcm-binding-logs/${doc}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${STRAPI_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ data }),
  }).catch(() => {});
}

/** Drop the open epoch — a claim that failed before ANY FB resource existed never carried
 *  traffic, so it is noise, not history. */
async function ledgerDrop(gcm: string): Promise<void> {
  const doc = await ledgerOpenRow(gcm);
  if (!doc) return;
  await fetch(`${STRAPI}/api/gcm-binding-logs/${doc}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${STRAPI_TOKEN}` },
  }).catch(() => {});
}

/**
 * Reserve a gcm code (01–200: 2-digit padded below 100, plain 3-digit above — the buy-link contract
 * gcm=N accepts 1..200 since 2026-08-10). Tries `desired`, then walks to the next free code on a
 * unique-violation OR a lost concurrent race. Returns the code claimed + the Strapi documentId
 * (for later id back-fill / release). Race-safe (see wonClaim). A won claim also opens the code's
 * ledger epoch (bound_at = now) for per-day revenue attribution.
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
    const res = await fetch(`${STRAPI}/api/gcm-maps`, {
      method: "POST",
      headers: { Authorization: `Bearer ${STRAPI_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        data: {
          gcm,
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
      // Can't verify without a documentId → keep it (best-effort, pre-fix behaviour).
      if (!documentId || (await wonClaim(gcm, documentId))) {
        await ledgerOpen(gcm, meta);
        return { gcm, documentId };
      }
      // Lost a concurrent race for this code → release our loser row and try the next candidate.
      // (No ledger row exists for the loser — ledgerOpen only runs after a confirmed win.)
      await deleteGcm(documentId);
      continue;
    }
    if (res.status !== 400) {
      // 400 = unique violation (someone took it) → next candidate; anything else aborts.
      const body = await res.json().catch(() => ({}));
      throw new Error(`gcm claim failed (${res.status}): ${JSON.stringify(body).slice(0, 200)}`);
    }
  }
  throw new Error(`gcm pool exhausted — no free code 01–${GCM_POOL_MAX}`);
}

/** Patch the registry row; when `gcm` is given, mirror the binding facts into its open ledger
 *  epoch too (FB ids after a create, failure notes on a kept-retired row). */
export async function backfillGcm(documentId: string | null, patch: Json, gcm?: string): Promise<void> {
  if (documentId) {
    await fetch(`${STRAPI}/api/gcm-maps/${documentId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${STRAPI_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ data: patch }),
    }).catch(() => {});
  }
  if (gcm) await ledgerPatch(gcm, patch);
}

/** Release a claimed code (delete the row) when a launch/clone fails before any FB resource is
 *  created. Pass `gcm` to also drop the code's open ledger epoch (never-carried-traffic noise). */
export async function deleteGcm(documentId: string, gcm?: string): Promise<void> {
  await fetch(`${STRAPI}/api/gcm-maps/${documentId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${STRAPI_TOKEN}` },
  }).catch(() => {});
  if (gcm) await ledgerDrop(gcm);
}
