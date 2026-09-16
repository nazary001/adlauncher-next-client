// Snapchat rail — the partner-key REGISTRY (glo-snp_001…100, one key per campaign) over the
// existing Strapi `app-cache` collection: one row per claimed key, ckey "snap-key:<key>" (UNIQUE →
// a POST on a taken key is a 400 → the claim is atomic without a new Strapi collection), cvalue =
// the binding. Same race-safe claim-then-verify contract as lib/aif-claim (Strapi's app-level
// uniqueness has a TOCTOU window under concurrent POSTs — the OLDEST row wins). Server-only; no
// runtime imports (own 8 s-bounded fetch) so `node --test` covers it with a stubbed fetch.
// Moving to a dedicated `snap-map` collection later = replacing this one file.

const STRAPI = (process.env.STRAPI_API_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.STRAPI_TOKEN ?? "";
const H = () => ({ Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" });

export const SNAP_KEY_CKEY_PREFIX = "snap-key:";
const POOL_MAX = 100;
const KEY_RE = /^glo-snp_(\d{3})$/;
const keyCode = (n: number): string => `glo-snp_${String(n).padStart(3, "0")}`;
const keyIndex = (key: string): number | null => {
  const m = KEY_RE.exec(String(key ?? "").trim());
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= POOL_MAX ? n : null;
};

export type SnapKeyBinding = {
  key: string;
  /** active = the campaign runs on this key · retired = a campaign exists but the launch failed
   *  after it (kept so revenue stays attributable; the owner releases it by hand). */
  status: "active" | "retired";
  user: string;
  claimed_at: number;
  campaign_id?: string;
  adsquad_id?: string;
  ad_id?: string;
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

export async function findSnapKey(key: string): Promise<SnapKeyRow | null> {
  const res = await strapi(`${STRAPI}/api/app-caches?filters[ckey][$eq]=${encodeURIComponent(SNAP_KEY_CKEY_PREFIX + key)}&pagination[pageSize]=1`);
  if (!res.ok) return null;
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
      await releaseSnapKey(documentId); // lost a concurrent race → next candidate
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
 *  Strapi's uniqueness check). Best-effort: a missing row or a failed write is swallowed. */
export async function backfillSnapKey(key: string, patch: Partial<SnapKeyBinding>): Promise<void> {
  try {
    const row = await findSnapKey(key);
    if (!row) return;
    const { documentId, ...current } = row;
    const merged: SnapKeyBinding = { ...current, ...patch, key };
    await strapi(`${STRAPI}/api/app-caches/${documentId}`, { method: "PUT", body: JSON.stringify({ data: { cvalue: merged, refreshed_at: Date.now() } }) });
  } catch {
    /* best-effort */
  }
}

/** Delete the row — the key returns to the pool (a key that never carried traffic is capacity, not history). */
export async function releaseSnapKey(documentId: string): Promise<void> {
  await strapi(`${STRAPI}/api/app-caches/${documentId}`, { method: "DELETE" }).catch(() => {});
}

/** Owner release from the keys page. True when a row existed and was deleted. */
export async function releaseSnapKeyByKey(key: string): Promise<boolean> {
  const row = await findSnapKey(key);
  if (!row) return false;
  await releaseSnapKey(row.documentId);
  return true;
}
