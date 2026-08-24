// Shared cross-instance KV cache backed by the Strapi `app-cache` collection (one row per key:
// ckey unique, cvalue json, refreshed_at). Serverless module caches die on every cold start and
// aren't shared between instances; this row survives and is shared, so all instances see one
// swept result and one refresh claim. Every helper degrades to null/no-op when Strapi (or the
// collection, pre-rebuild) is unavailable — callers must treat this layer as best-effort.

// Bounded Strapi client (8s abort): best-effort must also mean fail-FAST — a hung upstream
// otherwise pins the calling route to its maxDuration (the task-route 504 class).
import { strapiFetch } from "@/lib/task-store";

const STRAPI = (process.env.STRAPI_API_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.STRAPI_TOKEN ?? "";

export type AppCacheRow<T> = { documentId: string; value: T | null; refreshedAt: number };

export async function readAppCache<T>(key: string): Promise<AppCacheRow<T> | null> {
  const r = await readAppCacheDetailed<T>(key);
  return r.ok ? r.row : null;
}

/** Like readAppCache, but DISTINGUISHES "no row yet" (ok:true, row:null) from "store
 *  unavailable" (ok:false) — read-modify-write callers must refuse to write over a row they
 *  could not read, or a Strapi blip would silently wipe it. */
export async function readAppCacheDetailed<T>(
  key: string,
): Promise<{ ok: boolean; row: AppCacheRow<T> | null }> {
  if (!STRAPI || !TOKEN) return { ok: false, row: null };
  try {
    const res = await strapiFetch(
      `${STRAPI}/api/app-caches?filters[ckey][$eq]=${encodeURIComponent(key)}&pagination[pageSize]=1`,
      { headers: { Authorization: `Bearer ${TOKEN}` }, cache: "no-store" },
    );
    if (!res.ok) return { ok: false, row: null };
    const body = (await res.json().catch(() => ({}))) as {
      data?: Array<{ documentId?: string; cvalue?: unknown; refreshed_at?: unknown }>;
    };
    const row = body.data?.[0];
    if (!row?.documentId) return { ok: true, row: null };
    return {
      ok: true,
      row: {
        documentId: String(row.documentId),
        value: (row.cvalue ?? null) as T | null,
        refreshedAt: Number(row.refreshed_at) || 0,
      },
    };
  } catch {
    return { ok: false, row: null };
  }
}

/** Upsert the row (PUT by documentId, else POST). Returns the documentId, null when unavailable.
 *  A POST losing the unique-ckey race just returns null — the next read picks the winner's row. */
export async function writeAppCache<T>(
  key: string,
  value: T,
  documentId?: string | null,
): Promise<string | null> {
  if (!STRAPI || !TOKEN) return null;
  const payload = JSON.stringify({ data: { ckey: key, cvalue: value, refreshed_at: Date.now() } });
  const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
  try {
    if (documentId) {
      const res = await strapiFetch(`${STRAPI}/api/app-caches/${documentId}`, {
        method: "PUT",
        headers,
        body: payload,
      });
      if (res.ok) return documentId;
    }
    const res = await strapiFetch(`${STRAPI}/api/app-caches`, { method: "POST", headers, body: payload });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { data?: { documentId?: string } };
    return body.data?.documentId ?? null;
  } catch {
    return null;
  }
}
