// Snapchat rail — the partner-key REGISTRY (glo-snp_001…100, one key per campaign) over the
// existing Strapi `app-cache` collection: one row per claimed key, ckey "snap-key:<key>" (UNIQUE →
// a POST on a taken key is a 400 → the claim is atomic without a new Strapi collection), cvalue =
// the binding. Same race-safe claim-then-verify contract as lib/aif-claim (Strapi's app-level
// uniqueness has a TOCTOU window under concurrent POSTs — the OLDEST row wins). Server-only; no
// runtime imports (own 8 s-bounded fetch) so `node --test` covers it with a stubbed fetch.
// Nothing here fails quietly: a registry write that did not happen is reported to the caller (the
// pump folds it into the launch row, the keys route answers 502) — a key the registry has lost
// track of is an attribution hazard, not a detail.
// Moving to a dedicated `snap-map` collection later = replacing this one file.

const STRAPI = (process.env.STRAPI_API_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.STRAPI_TOKEN ?? "";
const H = () => ({ Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" });

export const SNAP_KEY_CKEY_PREFIX = "snap-key:";

// The key codec below is a deliberate LOCAL COPY of lib/snap-launch.ts — snapKeyCode / snapKeyIndex /
// SNAP_KEY_RE / SNAP_KEY_POOL_MAX are the canonical twin; KEEP IN SYNC. A runtime import is not an
// option: `node --test` resolves a relative import only with an explicit `.ts` extension, which the
// app's tsconfig does not allow (no allowImportingTsExtensions) — that is why every pure module on
// this rail is import-free.
const POOL_MAX = 100;
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
};
export type SnapKeyRow = SnapKeyBinding & { documentId: string };

/** Bounded Strapi call (8 s): the registry must fail FAST, never hang a launch. */
async function strapi(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, headers: { ...H(), ...(init.headers ?? {}) }, cache: "no-store", signal: AbortSignal.timeout(8_000) });
}

const str = (v: unknown): string => (v == null ? "" : String(v));

function rowOf(raw: Record<string, unknown>): SnapKeyRow | null {
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

/** Every registry row (any status). Paged ×100 (Strapi Cloud clamps pageSize); throws on a failed
 *  page — a partial registry must never masquerade as the whole. */
export async function listSnapKeys(): Promise<SnapKeyRow[]> {
  const out: SnapKeyRow[] = [];
  for (let page = 1; page <= 2; page++) {
    const res = await strapi(
      `${STRAPI}/api/app-caches?filters[ckey][$startsWith]=${encodeURIComponent(SNAP_KEY_CKEY_PREFIX)}&pagination[page]=${page}&pagination[pageSize]=100&sort[0]=ckey:asc`,
    );
    if (!res.ok) throw new Error(`strapi ${res.status}`);
    const body = (await res.json().catch(() => ({}))) as { data?: Record<string, unknown>[] };
    const rows = (body.data ?? []).map(rowOf).filter((r): r is SnapKeyRow => Boolean(r));
    out.push(...rows);
    if ((body.data ?? []).length < 100) break;
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** The row bound to `key`, null ONLY when no row exists; a failed read throws (`strapi <status>`)
 *  so "unknown" is never reported as "free". */
export async function findSnapKey(key: string): Promise<SnapKeyRow | null> {
  const res = await strapi(`${STRAPI}/api/app-caches?filters[ckey][$eq]=${encodeURIComponent(SNAP_KEY_CKEY_PREFIX + key)}&pagination[pageSize]=1`);
  if (!res.ok) throw new Error(`strapi ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as { data?: Record<string, unknown>[] };
  return body.data?.[0] ? rowOf(body.data[0]) : null;
}

// ---------- claim ----------

/** Did WE win this key? Re-read its rows oldest-first; ours must be the earliest. Read failure →
 *  keep the row (best-effort). */
async function wonClaim(key: string, documentId: string): Promise<boolean> {
  try {
    const res = await strapi(
      `${STRAPI}/api/app-caches?filters[ckey][$eq]=${encodeURIComponent(SNAP_KEY_CKEY_PREFIX + key)}&sort[0]=createdAt:asc&sort[1]=documentId:asc&fields[0]=ckey&pagination[pageSize]=10`,
    );
    if (!res.ok) return true;
    const body = (await res.json().catch(() => ({}))) as { data?: Array<{ documentId?: string }> };
    const rows = body.data ?? [];
    if (rows.length <= 1) return true;
    return rows[0]?.documentId === documentId;
  } catch {
    return true;
  }
}

/**
 * Reserve one key: `desired` first, then the next free ones (wrap). A unique-ckey 400 = taken →
 * next candidate; a won POST is verified against a committed twin (older row wins → ours is
 * deleted and the walk continues). Throws when the pool is exhausted or Strapi fails otherwise.
 */
export async function claimSnapKey(desired: string | undefined, meta: Partial<SnapKeyBinding> & { user: string }): Promise<{ key: string; documentId: string }> {
  let used: string[] = [];
  try {
    used = (await listSnapKeys()).map((r) => r.key);
  } catch {
    used = []; // the POST's unique constraint is the real guard — a claim just walks through 400s
  }
  const candidates = snapKeyCandidates(used, desired);
  if (candidates.length === 0) throw new Error(`snap key pool exhausted — no free key glo-snp_001…${POOL_MAX}`);
  for (const key of candidates) {
    const binding: SnapKeyBinding = { ...meta, key, status: "active", user: meta.user, claimed_at: Date.now() };
    const res = await strapi(`${STRAPI}/api/app-caches`, {
      method: "POST",
      body: JSON.stringify({ data: { ckey: SNAP_KEY_CKEY_PREFIX + key, cvalue: binding, refreshed_at: Date.now() } }),
    });
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { data?: { documentId?: string } };
      const documentId = body.data?.documentId ?? "";
      if (!documentId || (await wonClaim(key, documentId))) return { key, documentId };
      // Lost a concurrent race → drop our younger twin and try the next candidate. This is the one
      // place a failed delete is deliberately tolerated: releaseSnapKey throws now, but a leftover
      // twin does not disturb the claim (the older row owns the key; the twin shows on the Keys
      // page and is released by hand) and must not abort the walk.
      try {
        await releaseSnapKey(documentId);
      } catch {
        /* walk on */
      }
      continue;
    }
    if (res.status !== 400) {
      const text = await res.text().catch(() => "");
      throw new Error(`snap key claim failed (${res.status}): ${text.slice(0, 200)}`);
    }
  }
  throw new Error(`snap key pool exhausted — no free key glo-snp_001…${POOL_MAX}`);
}

// ---------- writes ----------

/** Merge `patch` into the key's binding (PUT carries NO ckey — re-sending the unique key trips
 *  Strapi's uniqueness check). Throws on a failed find, on a missing row (the campaign would be
 *  running on a key the registry considers free) and on a non-ok PUT (`snap key backfill failed
 *  (<status>)`) — the pump folds the message into the launch row. */
export async function backfillSnapKey(key: string, patch: Partial<SnapKeyBinding>): Promise<void> {
  const row = await findSnapKey(key);
  if (!row) throw new Error(`snap key backfill failed: no registry row for ${key}`);
  const { documentId, ...current } = row;
  const merged: SnapKeyBinding = { ...current, ...patch, key };
  const res = await strapi(`${STRAPI}/api/app-caches/${documentId}`, { method: "PUT", body: JSON.stringify({ data: { cvalue: merged, refreshed_at: Date.now() } }) });
  if (!res.ok) throw new Error(`snap key backfill failed (${res.status})`);
}

/** Delete the row — the key returns to the pool (a key that never carried traffic is capacity, not
 *  history). Throws on a non-ok answer (`snap key release failed (<status>)`); a network error
 *  propagates as-is — the caller decides (the pump keeps the key visible, the route answers 502). */
export async function releaseSnapKey(documentId: string): Promise<void> {
  const res = await strapi(`${STRAPI}/api/app-caches/${documentId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`snap key release failed (${res.status})`);
}

/** Owner release from the keys page: false ONLY when no row exists, true after a SUCCESSFUL
 *  delete; a failed find or delete propagates (the route answers 502, never `released: true`). */
export async function releaseSnapKeyByKey(key: string): Promise<boolean> {
  const row = await findSnapKey(key);
  if (!row) return false;
  await releaseSnapKey(row.documentId);
  return true;
}
