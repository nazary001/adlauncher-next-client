// Shared read-side Graph API client. Mirrors the rate-limit/backoff behaviour proven in
// app/api/launch/route.ts (this ad account gets throttled hard during launch waves — code
// 4/17/613/is_transient), extracted so read routes (clone sources) get the same resilience.
// Server-only: FB_LAUNCH_TOKEN never reaches the browser.

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
// full sweep is ~60 reads. Cached hard and deduped: the sweep runs at most once per TTL, and
// concurrent /api/fanpages requests share one in-flight sweep instead of stacking 60-call storms
// onto the launch quota (fbGet self-paces under the usage headers on top).
const COUNTS_TTL_MS = 10 * 60_000;
const COUNTS_CONCURRENCY = 6;
let countsCache: { key: string; at: number; counts: Map<string, number | null> } | null = null;
let countsInflight: { key: string; promise: Promise<Map<string, number | null>> } | null = null;

async function sweepPageAdCounts(accountId: string, pageIds: string[]): Promise<Map<string, number | null>> {
  const counts = new Map<string, number | null>();
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= pageIds.length) return;
      const id = pageIds[i];
      try {
        const body = await fbGet(`act_${accountId}/ads_volume?page_id=${id}&fields=ads_running_or_in_review_count`);
        const n = (body.data as Array<{ ads_running_or_in_review_count?: number }> | undefined)?.[0]
          ?.ads_running_or_in_review_count;
        counts.set(id, typeof n === "number" ? n : null);
      } catch {
        counts.set(id, null); // one page failing must not sink the whole list
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(COUNTS_CONCURRENCY, pageIds.length) }, worker));
  return counts;
}

/** Ads-running-or-in-review count per fanpage (null = unavailable). Cached; sweep deduped. */
export async function pageAdCounts(accountId: string, pageIds: string[]): Promise<Map<string, number | null>> {
  const key = `${accountId}:${pageIds.length}`;
  if (countsCache && countsCache.key === key && Date.now() - countsCache.at < COUNTS_TTL_MS) {
    return countsCache.counts;
  }
  if (countsInflight && countsInflight.key === key) return countsInflight.promise;
  const promise = sweepPageAdCounts(accountId, pageIds)
    .then((counts) => {
      countsCache = { key, at: Date.now(), counts };
      return counts;
    })
    .finally(() => {
      countsInflight = null;
    });
  countsInflight = { key, promise };
  return promise;
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
