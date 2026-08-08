// Shared read-side Graph API client. Mirrors the rate-limit/backoff behaviour proven in
// app/api/launch/route.ts (this ad account gets throttled hard during launch waves — code
// 4/17/613/is_transient), extracted so read routes (clone sources) get the same resilience.
// Server-only: FB_LAUNCH_TOKEN never reaches the browser.

import { readAppCache, writeAppCache } from "./app-cache";

const FB = "https://graph.facebook.com/v21.0";
const TOKEN = process.env.FB_LAUNCH_TOKEN ?? "";

export function hasFbToken(): boolean {
  return TOKEN.length > 0;
}

type Json = Record<string, unknown>;

export class FbError extends Error {
  detail: unknown;
  status: number;
  constructor(message: string, detail: unknown, status = 502) {
    super(message);
    this.detail = detail;
    this.status = status;
  }
}

/** Meta's most actionable error text: prefer the user-facing title/message over "Invalid parameter". */
function fbErrorMessage(body: Json, fallback: string): string {
  const e = (body?.error ?? {}) as Record<string, unknown>;
  const title = typeof e.error_user_title === "string" ? e.error_user_title : "";
  const msg = typeof e.error_user_msg === "string" ? e.error_user_msg : "";
  if (title || msg) return [title, msg].filter(Boolean).join(": ");
  return typeof e.message === "string" ? e.message : fallback;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Meta throttles the whole app/account with (#4)/(#17)/(#613) or is_transient when call volume
// spikes. Temporary → back off and retry the SAME call (reads are idempotent, so safe to retry).
const RATE_LIMIT_CODES = new Set([4, 17, 613, 80004, 80014]);
function isRateLimited(body: Json): boolean {
  const e = (body?.error ?? {}) as { code?: number; is_transient?: boolean };
  return RATE_LIMIT_CODES.has(e.code ?? -1) || e.is_transient === true;
}
const RATE_RETRIES = 5;
const rateBackoff = (attempt: number) => Math.min(4000 * 2 ** attempt, 30000); // 4→8→16→30→30s

type UsageStat = {
  call_count?: number;
  total_cputime?: number;
  total_time?: number;
  estimated_time_to_regain_access?: number;
};

/** Pace under Meta's rolling ads rate-limit (x-business-use-case-usage / x-app-usage). */
async function throttle(res: Response): Promise<void> {
  const raw = res.headers.get("x-business-use-case-usage") ?? res.headers.get("x-app-usage") ?? "";
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const stats: UsageStat[] = [];
    if (typeof (parsed as UsageStat).call_count === "number") stats.push(parsed as UsageStat); // flat x-app-usage
    for (const v of Object.values(parsed)) if (Array.isArray(v)) for (const o of v) if (o && typeof o === "object") stats.push(o as UsageStat);
    let pct = 0;
    let regainMin = 0;
    for (const s of stats) {
      pct = Math.max(pct, s.call_count ?? 0, s.total_cputime ?? 0, s.total_time ?? 0);
      regainMin = Math.max(regainMin, s.estimated_time_to_regain_access ?? 0);
    }
    if (regainMin > 0) await sleep(Math.min(regainMin * 60_000, 30_000));
    else if (pct >= 95) await sleep(8000);
    else if (pct >= 90) await sleep(4000);
    else if (pct >= 80) await sleep(1500);
  } catch {
    /* malformed header — ignore */
  }
}

/**
 * GET a Graph path (no leading slash beyond an optional `?...` root query), with rate-limit
 * backoff. Returns the parsed JSON body; throws FbError (with a Graph-facing message + a mapped
 * HTTP status: 429 when rate-limited, 502 otherwise) on failure.
 */
export async function fbGet(path: string): Promise<Json> {
  if (!TOKEN) throw new FbError("no_fb_token", null, 500);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${FB}/${path}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      cache: "no-store",
    });
    const body = (await res.json().catch(() => ({}))) as Json;
    // Meta can ship an error body WITH HTTP 200 (seen live: the account-checkpoint error 31 on
    // POST /ads) — trusting res.ok alone turns those into silent failures, so check both.
    if (res.ok && !body.error) {
      await throttle(res);
      return body;
    }
    if (attempt < RATE_RETRIES && isRateLimited(body)) {
      await sleep(rateBackoff(attempt));
      continue;
    }
    throw new FbError(fbErrorMessage(body, `GET ${path} failed`), body, isRateLimited(body) ? 429 : 502);
  }
}

// ---------- fanpages of the launch token ----------

export type FanPage = { id: string; name: string };

// The system-user token advertises through pages ASSIGNED to it (me/accounts), not through a
// page bound to the ad account — Meta checks the "Ads" task on the page at creative-create time.
// Cached briefly: the list feeds both the UI picker and the per-launch server-side validation.
const PAGES_TTL_MS = 5 * 60_000;
let pagesCache: { at: number; pages: FanPage[] } | null = null;

/** Every page the launch token can advertise with (ADVERTISE task), paginated + cached. */
export async function advertisablePages(): Promise<FanPage[]> {
  if (pagesCache && Date.now() - pagesCache.at < PAGES_TTL_MS) return pagesCache.pages;

  const pages: FanPage[] = [];
  let after = "";
  // 20 × 100 = a 2000-page ceiling — far above the ~60 the token carries today.
  for (let i = 0; i < 20; i++) {
    const body = await fbGet(`me/accounts?fields=id,name,tasks&limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`);
    const data = (body.data as Array<{ id?: string; name?: string; tasks?: string[] }> | undefined) ?? [];
    for (const p of data) {
      if (!p?.id || !p.name) continue;
      if (!Array.isArray(p.tasks) || !p.tasks.includes("ADVERTISE")) continue;
      pages.push({ id: String(p.id), name: String(p.name) });
    }
    const paging = body.paging as { cursors?: { after?: string }; next?: string } | undefined;
    const next = paging?.next ? paging.cursors?.after ?? "" : "";
    if (!next || next === after) break;
    after = next;
  }

  // Stable order for the picker; duplicate display names exist → id is the tiebreaker.
  pages.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  pagesCache = { at: Date.now(), pages };
  return pages;
}

/** Server-side guard: only ids from the token's own page list are accepted for a launch/clone. */
export async function isAdvertisablePage(pageId: string): Promise<boolean> {
  if (!/^\d{5,}$/.test(pageId)) return false;
  const pages = await advertisablePages();
  return pages.some((p) => p.id === pageId);
}

// ---------- per-fanpage ad volume ----------

// Meta returns the "ads running or in review" count per page only via one ads_volume call PER
// page (`?page_id=` — the show_breakdown_by_actor variant answers [] for this system user), so a
// full sweep is ~60 reads. Semantics verified live 08-08: ads_running_or_in_review_count is the
// page's CROSS-ACCOUNT total (what the 250 limit meters — Marisel8 showed 34 total vs 2 on this
// account via current_account_ads_running_or_in_review_count). Cached hard and deduped: the sweep
// runs at most once per TTL, and concurrent /api/fanpages requests share one in-flight sweep
// instead of stacking 60-call storms onto the launch quota.
// Cache windows. The shared row (Strapi app-cache, see lib/app-cache) is the source of truth —
// module memory is only a short L1 so each instance re-reads the shared row at most once a
// minute. A successful sweep is trusted for OK_TTL; an ALL-null sweep (account rate limit,
// code 17) backs off for FAIL_TTL — retrying a 60-call sweep every minute is what previously
// kept the account pinned inside its own rate limit (self-sustaining storm, seen live 08-08).
const VOLUME_OK_TTL_MS = 15 * 60_000;
const VOLUME_FAIL_TTL_MS = 5 * 60_000;
// A claim marks the row briefly while a sweep runs so other instances serve stale data instead
// of sweeping in parallel; if the claimer dies, the row re-expires soon.
const VOLUME_CLAIM_TTL_MS = 2 * 60_000;
// Holes (individual failed slots) may be re-swept this often — small sweeps, not the full list.
const VOLUME_HEAL_MS = 60_000;
const VOLUME_L1_MS = 60_000;
// Gentle on purpose: a 6-way burst of 60 reads is exactly the spike that trips the
// development-tier rate limit and punches holes in the result.
const COUNTS_CONCURRENCY = 3;
const COUNTS_STAGGER_MS = 120;

/** The shared row's shape (cvalue of app-cache key `fanpage-volume:<accountId>`). */
type VolumeState = {
  counts: Record<string, number | null>;
  /** When this state stops being trusted (success → +15 min, total failure → +5 min). */
  expiresAt: number;
  /** Earliest time a fresh-but-holey state may re-sweep just its null slots. */
  healAt: number;
};

let volumeL1: { key: string; readAt: number; hasL2: boolean; state: VolumeState } | null = null;
let volumeInflight: { key: string; promise: Promise<Map<string, number | null>> } | null = null;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sweep the given page ids (single-shot per page — no fbGet retry ladder: under a rate limit
 *  it would stretch the sweep past the function timeout; a missing count is decoration).
 *  ABORTS on the first rate-limit error: once the account is throttled every remaining call
 *  would fail too, and burning them only postpones the quota's recovery. */
async function sweepPageAdCounts(accountId: string, pageIds: string[]): Promise<Map<string, number | null>> {
  const counts = new Map<string, number | null>();
  let next = 0;
  let throttled = false;
  const worker = async () => {
    while (!throttled) {
      const i = next++;
      if (i >= pageIds.length) return;
      const id = pageIds[i];
      try {
        const res = await fetch(
          `${FB}/act_${accountId}/ads_volume?page_id=${id}&fields=ads_running_or_in_review_count`,
          { headers: { Authorization: `Bearer ${TOKEN}` }, cache: "no-store" },
        );
        const body = (await res.json().catch(() => ({}))) as Json;
        const err = body.error as { code?: number } | undefined;
        if (err && RATE_LIMIT_CODES.has(err.code ?? -1)) {
          counts.set(id, null);
          throttled = true;
          return;
        }
        const n = (body.data as Array<{ ads_running_or_in_review_count?: number }> | undefined)?.[0]
          ?.ads_running_or_in_review_count;
        counts.set(id, typeof n === "number" ? n : null);
      } catch {
        counts.set(id, null); // one page failing must not sink the whole list
      }
      await pause(COUNTS_STAGGER_MS);
    }
  };
  await Promise.all(Array.from({ length: Math.min(COUNTS_CONCURRENCY, pageIds.length) }, worker));
  return counts;
}

const toMap = (pageIds: string[], counts: Record<string, number | null>): Map<string, number | null> =>
  new Map(pageIds.map((id) => [id, typeof counts[id] === "number" ? counts[id] : null]));

const holesOf = (pageIds: string[], counts: Record<string, number | null>): string[] =>
  pageIds.filter((id) => typeof counts[id] !== "number");

function setVolumeL1(key: string, state: VolumeState, hasL2: boolean): void {
  volumeL1 = { key, readAt: Date.now(), hasL2, state };
}

/**
 * Ads-running-or-in-review count per fanpage — the page's cross-account total (null =
 * unavailable). Backed by the SHARED Strapi app-cache row, so every serverless instance sees
 * the same swept result and the same refresh claim (module-only caching made each cold start
 * re-sweep 60 pages and the fleet kept the account rate-limited around the clock). Fresh-but-
 * holey state re-sweeps ONLY its null slots (≤ once per minute); a total failure backs off for
 * 5 minutes; previous numbers survive failed refreshes (stale beats empty).
 */
export async function pageAdCounts(accountId: string, pageIds: string[]): Promise<Map<string, number | null>> {
  const key = `fanpage-volume:${accountId}`;
  const now = Date.now();

  if (volumeL1 && volumeL1.key === key && now < volumeL1.state.expiresAt) {
    // Without L2 the local state IS the truth — re-reading Strapi every minute would just fail
    // again; with L2 the L1 view re-syncs once a minute to pick up other instances' heals.
    const l1Fresh = volumeL1.hasL2 ? now < volumeL1.readAt + VOLUME_L1_MS : true;
    const holes = holesOf(pageIds, volumeL1.state.counts);
    if (l1Fresh && (holes.length === 0 || now < volumeL1.state.healAt)) {
      return toMap(pageIds, volumeL1.state.counts);
    }
  }

  if (volumeInflight && volumeInflight.key === key) return volumeInflight.promise;
  const promise = resolveVolume(key, accountId, pageIds).finally(() => {
    volumeInflight = null;
  });
  volumeInflight = { key, promise };
  return promise;
}

async function resolveVolume(
  key: string,
  accountId: string,
  pageIds: string[],
): Promise<Map<string, number | null>> {
  const now = Date.now();
  const row = await readAppCache<VolumeState>(key);
  const shared = row?.value && typeof row.value === "object" && row.value.counts ? row.value : null;
  const docId = row?.documentId ?? null;
  const hasL2 = row !== null;

  // Shared state still trusted → serve it; quietly heal its holes at most once per minute.
  if (shared && now < shared.expiresAt) {
    const holes = holesOf(pageIds, shared.counts);
    if (holes.length > 0 && now >= shared.healAt) {
      shared.healAt = now + VOLUME_HEAL_MS; // claim the heal window before sweeping
      await writeAppCache(key, shared, docId);
      const part = await sweepPageAdCounts(accountId, holes);
      let healed = 0;
      for (const [id, v] of part) {
        if (typeof v === "number") {
          shared.counts[id] = v;
          healed++;
        }
      }
      // A fruitless heal means the account is still throttled — back the next attempt off hard,
      // or the minute-cadence hole sweeps themselves keep the quota from ever recovering.
      shared.healAt = Date.now() + (healed > 0 ? VOLUME_HEAL_MS : VOLUME_FAIL_TTL_MS);
      await writeAppCache(key, shared, docId);
    }
    setVolumeL1(key, shared, hasL2);
    return toMap(pageIds, shared.counts);
  }

  // Stale/absent → claim the row first (short expiry) so parallel instances serve the stale
  // numbers instead of sweeping too; if this claimer dies, the claim re-expires in 2 minutes.
  const base: VolumeState = {
    counts: shared?.counts ?? {},
    expiresAt: now + VOLUME_CLAIM_TTL_MS,
    healAt: now + VOLUME_HEAL_MS,
  };
  const claimedId = (await writeAppCache(key, base, docId)) ?? docId;

  const swept = await sweepPageAdCounts(accountId, pageIds);
  const counts: Record<string, number | null> = {};
  let live = 0;
  for (const id of pageIds) {
    const v = swept.get(id);
    if (typeof v === "number") {
      counts[id] = v;
      live++;
    } else {
      counts[id] = typeof base.counts[id] === "number" ? base.counts[id] : null; // stale beats empty
    }
  }
  const next: VolumeState = {
    counts,
    expiresAt: Date.now() + (live > 0 ? VOLUME_OK_TTL_MS : VOLUME_FAIL_TTL_MS),
    healAt: Date.now() + VOLUME_HEAL_MS,
  };
  await writeAppCache(key, next, claimedId);
  setVolumeL1(key, next, hasL2);
  return toMap(pageIds, counts);
}

/**
 * POST a Graph path with form-encoding (nested objects/arrays are JSON-stringified, per the
 * Marketing API convention), with the same rate-limit backoff as fbGet. Throws FbError on failure.
 */
export async function fbPost(path: string, params: Json): Promise<Json> {
  if (!TOKEN) throw new FbError("no_fb_token", null, 500);
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    form.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${FB}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const body = (await res.json().catch(() => ({}))) as Json;
    // Same as fbGet: an error body can arrive with HTTP 200 — never treat those as success.
    if (res.ok && !body.error) {
      await throttle(res);
      return body;
    }
    if (attempt < RATE_RETRIES && isRateLimited(body)) {
      await sleep(rateBackoff(attempt));
      continue;
    }
    throw new FbError(fbErrorMessage(body, `POST ${path} failed`), body, isRateLimited(body) ? 429 : 502);
  }
}
