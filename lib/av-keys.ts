// AV rail — the KEY REGISTRY (av001…, one key per campaign — the AIF-brand twin) over the existing
// Strapi `app-cache` collection: one row per claimed key, ckey "av-key:<key>" (UNIQUE → a POST on a
// taken key is a 400 → the claim is atomic without a new Strapi collection), cvalue = the binding.
// Same race-safe claim-then-verify contract as lib/snap-keys (Strapi's app-level uniqueness has a
// TOCTOU window under concurrent POSTs — the OLDEST row wins). Server-only; no runtime imports (own
// 8 s-bounded fetch) so `node --test` covers it with a stubbed fetch.
//
// The LAUNCHABLE range is the registered one: a key earns reportable revenue only once it is uploaded
// to AV's "UTM Campaign Values" (UI only, no API) — so every claim walks av001…av<registered> and
// nothing else. registered = 0 (the default until the owner uploads the pool) = no key can be claimed.
// Nothing here fails quietly: a registry write that did not happen is reported to the caller.

const STRAPI = (process.env.STRAPI_API_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.STRAPI_TOKEN ?? "";
const H = () => ({ Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" });

export const AV_KEY_CKEY_PREFIX = "av-key:";

// Key codec — a deliberate LOCAL COPY of lib/av-link.ts (avKeyCode / avKeyIndex / AV_KEY_POOL_MAX are
// the canonical twin; KEEP IN SYNC). A runtime import is not an option for a `node --test`-able module
// here: node resolves a relative import only with an explicit `.ts` extension, which the app's tsconfig
// does not allow — the same reason lib/snap-keys copies its codec.
const POOL_MAX = 999;
const LIST_PAGES = Math.ceil(POOL_MAX / 100) + 1;
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

/** Bounded Strapi call (8 s): the registry must fail FAST, never hang a launch. */
async function strapi(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, headers: { ...H(), ...(init.headers ?? {}) }, cache: "no-store", signal: AbortSignal.timeout(8_000) });
}

const str = (v: unknown): string => (v == null ? "" : String(v));

function rowOf(raw: Record<string, unknown>): AvKeyRow | null {
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

/** Every registry row (any status). Paged ×100 (Strapi Cloud clamps pageSize); throws on a failed
 *  page — a partial registry must never masquerade as the whole. */
export async function listAvKeys(): Promise<AvKeyRow[]> {
  const out: AvKeyRow[] = [];
  for (let page = 1; page <= LIST_PAGES; page++) {
    const res = await strapi(
      `${STRAPI}/api/app-caches?filters[ckey][$startsWith]=${encodeURIComponent(AV_KEY_CKEY_PREFIX)}&pagination[page]=${page}&pagination[pageSize]=100&sort[0]=ckey:asc`,
    );
    if (!res.ok) throw new Error(`strapi ${res.status}`);
    const body = (await res.json().catch(() => ({}))) as { data?: Record<string, unknown>[] };
    const rows = (body.data ?? []).map(rowOf).filter((r): r is AvKeyRow => Boolean(r));
    out.push(...rows);
    if ((body.data ?? []).length < 100) break;
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** The row bound to `key`, null ONLY when no row exists; a failed read throws (`strapi <status>`) so
 *  "unknown" is never reported as "free". */
export async function findAvKey(key: string): Promise<AvKeyRow | null> {
  const res = await strapi(`${STRAPI}/api/app-caches?filters[ckey][$eq]=${encodeURIComponent(AV_KEY_CKEY_PREFIX + key)}&pagination[pageSize]=1`);
  if (!res.ok) throw new Error(`strapi ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as { data?: Record<string, unknown>[] };
  return body.data?.[0] ? rowOf(body.data[0]) : null;
}

// ---------- claim ----------

/** Did WE win this key? Re-read its rows oldest-first; ours must be the earliest. Read failure → keep
 *  the row (best-effort). */
async function wonClaim(key: string, documentId: string): Promise<boolean> {
  try {
    const res = await strapi(
      `${STRAPI}/api/app-caches?filters[ckey][$eq]=${encodeURIComponent(AV_KEY_CKEY_PREFIX + key)}&sort[0]=createdAt:asc&sort[1]=documentId:asc&fields[0]=ckey&pagination[pageSize]=10`,
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
 * Reserve one REGISTERED key: `desired` first, then the next free ones (wrap). A unique-ckey 400 =
 * taken → next candidate; a won POST is verified against a committed twin (older row wins → ours is
 * deleted and the walk continues). Throws `av_keys_not_registered` when the registered range is empty
 * (the stub), `av key pool exhausted` when every registered key is bound, or on any other Strapi
 * failure.
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
    used = []; // the POST's unique constraint is the real guard — a claim just walks through 400s
  }
  const candidates = avKeyCandidates(used, max, desired);
  if (candidates.length === 0) throw new Error(`av key pool exhausted — every registered key av001…${keyCode(max)} is bound (register more in ActiveView)`);
  for (const key of candidates) {
    const binding: AvKeyBinding = { ...meta, key, status: "active", user: meta.user, claimed_at: Date.now() };
    const res = await strapi(`${STRAPI}/api/app-caches`, {
      method: "POST",
      body: JSON.stringify({ data: { ckey: AV_KEY_CKEY_PREFIX + key, cvalue: binding, refreshed_at: Date.now() } }),
    });
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { data?: { documentId?: string } };
      const documentId = body.data?.documentId ?? "";
      if (!documentId || (await wonClaim(key, documentId))) return { key, documentId };
      // Lost a concurrent race → drop our younger twin and walk on (a failed delete is tolerated here:
      // the older row owns the key; a leftover twin shows on the AV keys page and is released by hand).
      try {
        await releaseAvKey(documentId);
      } catch {
        /* walk on */
      }
      continue;
    }
    if (res.status !== 400) {
      const text = await res.text().catch(() => "");
      throw new Error(`av key claim failed (${res.status}): ${text.slice(0, 200)}`);
    }
  }
  throw new Error(`av key pool exhausted — every registered key av001…${keyCode(max)} is bound (register more in ActiveView)`);
}

// ---------- writes ----------

/** Merge `patch` into the row's binding by documentId (PUT carries NO ckey — re-sending the unique key
 *  trips Strapi's uniqueness check). Throws on a failed find/PUT or a missing row. */
export async function backfillAvKey(key: string, patch: Partial<AvKeyBinding>): Promise<void> {
  const row = await findAvKey(key);
  if (!row) throw new Error(`av key backfill failed: no registry row for ${key}`);
  const { documentId, ...current } = row;
  const merged: AvKeyBinding = { ...current, ...patch, key };
  const res = await strapi(`${STRAPI}/api/app-caches/${documentId}`, { method: "PUT", body: JSON.stringify({ data: { cvalue: merged, refreshed_at: Date.now() } }) });
  if (!res.ok) throw new Error(`av key backfill failed (${res.status})`);
}

/** Delete the row — the key returns to the pool (a key that never carried traffic is capacity, not
 *  history). Throws on a non-ok answer. */
export async function releaseAvKey(documentId: string): Promise<void> {
  const res = await strapi(`${STRAPI}/api/app-caches/${documentId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`av key release failed (${res.status})`);
}

/** Owner release from the AV keys page: false ONLY when no row exists, true after a SUCCESSFUL delete;
 *  a failed find or delete propagates (the route answers 502, never `released: true`). */
export async function releaseAvKeyByKey(key: string): Promise<boolean> {
  const row = await findAvKey(key);
  if (!row) return false;
  await releaseAvKey(row.documentId);
  return true;
}
