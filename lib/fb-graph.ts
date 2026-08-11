// Shared read-side Graph API client. Mirrors the rate-limit/backoff behaviour proven in
// app/api/launch/route.ts (this ad account gets throttled hard during launch waves — code
// 4/17/613/is_transient), extracted so read routes (clone sources) get the same resilience.
// Server-only: FB_LAUNCH_TOKEN never reaches the browser.

import { AsyncLocalStorage } from "node:async_hooks";
import { readAppCache, writeAppCache } from "./app-cache";

const FB = "https://graph.facebook.com/v21.0";
const TOKEN = process.env.FB_LAUNCH_TOKEN ?? "";

// ---------- per-request retry budget (write pipelines) ----------

// The launch/clone routes opt into MORE PATIENT rate-limit retries (the token is on Meta's low
// development tier — mid-wave throttles are routine) whose waits honor Meta's own regain estimate.
// The deadline is the hard stop: the function must finish with a CLEAN error before Vercel kills
// it mid-stream — a timeout skips the error path entirely (no gcm release/retire, task row stuck).
// AsyncLocalStorage so the budget flows through every nested helper without threading params;
// callers outside a budget (UI reads) keep the old snappy 5×backoff behaviour.
type FbBudget = { deadlineAt: number; retries: number };
const fbBudgetALS = new AsyncLocalStorage<FbBudget>();

export function withFbBudget<T>(budget: FbBudget, fn: () => T): T {
  // fn runs synchronously inside the context; every async continuation it starts (including a
  // ReadableStream's start() begun during construction) inherits the budget via ALS.
  return fbBudgetALS.run(budget, fn);
}

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

/** Rolling ads rate-limit usage from a response's x-business-use-case-usage / x-app-usage:
 *  pct = 0–100% of the limit, regainMin = Meta's minutes-until-access-returns estimate. */
function usageOf(res: Response): { pct: number; regainMin: number } {
  const raw = res.headers.get("x-business-use-case-usage") ?? res.headers.get("x-app-usage") ?? "";
  let pct = 0;
  let regainMin = 0;
  if (!raw) return { pct, regainMin };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const stats: UsageStat[] = [];
    if (typeof (parsed as UsageStat).call_count === "number") stats.push(parsed as UsageStat); // flat x-app-usage
    for (const v of Object.values(parsed)) if (Array.isArray(v)) for (const o of v) if (o && typeof o === "object") stats.push(o as UsageStat);
    for (const s of stats) {
      pct = Math.max(pct, s.call_count ?? 0, s.total_cputime ?? 0, s.total_time ?? 0);
      regainMin = Math.max(regainMin, s.estimated_time_to_regain_access ?? 0);
    }
  } catch {
    /* malformed header — treat as no data */
  }
  return { pct, regainMin };
}

/** Pace under Meta's rolling ads rate-limit (x-business-use-case-usage / x-app-usage). */
async function throttle(res: Response): Promise<void> {
  const { pct, regainMin } = usageOf(res);
  if (regainMin > 0) await sleep(Math.min(regainMin * 60_000, 30_000));
  else if (pct >= 95) await sleep(8000);
  else if (pct >= 90) await sleep(4000);
  else if (pct >= 80) await sleep(1500);
}

/**
 * One shared retry decision for fbGet/fbPost. Rate-limited call → how long to wait before the
 * next attempt, or null to give up now. Inside a budget: waits stretch to Meta's own regain
 * estimate (capped 60s) and more attempts are allowed, but a wait that would cross the deadline
 * fails IMMEDIATELY — better a clean per-launch error than a function timeout that skips every
 * error path. Outside a budget (UI reads): the old snappy exponential ladder.
 */
function retryWaitMs(res: Response, attempt: number): number | null {
  const budget = fbBudgetALS.getStore();
  const maxAttempts = budget?.retries ?? RATE_RETRIES;
  if (attempt >= maxAttempts) return null;
  if (!budget) return rateBackoff(attempt);
  const { regainMin } = usageOf(res);
  const wait = Math.max(rateBackoff(attempt), Math.min(regainMin * 60_000, 60_000));
  return Date.now() + wait <= budget.deadlineAt ? wait : null;
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
    if (isRateLimited(body)) {
      const wait = retryWaitMs(res, attempt);
      if (wait !== null) {
        await sleep(wait);
        continue;
      }
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
// An EMPTY result (transient de-permission / edge blip) is trusted only briefly — caching it for the
// full TTL would reject every launch with fanpage_not_allowed for 5 minutes with no self-correction.
const PAGES_EMPTY_TTL_MS = 20_000;
let pagesCache: { at: number; ttl: number; pages: FanPage[] } | null = null;

/** Read a paging cursor: prefer cursors.after, else pull `after` out of the next URL (relay-style
 *  paging / >100 entries return a next URL without cursors.after — dropping it truncated the list). */
function nextAfter(paging: { cursors?: { after?: string }; next?: string } | undefined): string {
  if (paging?.cursors?.after) return paging.cursors.after;
  if (paging?.next) {
    try {
      return new URL(paging.next).searchParams.get("after") ?? "";
    } catch {
      /* malformed next URL — stop paging */
    }
  }
  return "";
}

/** Every page the launch token can advertise with (ADVERTISE task), paginated + cached. */
export async function advertisablePages(): Promise<FanPage[]> {
  if (pagesCache && Date.now() - pagesCache.at < pagesCache.ttl) return pagesCache.pages;

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
    const nxt = nextAfter(body.paging as { cursors?: { after?: string }; next?: string } | undefined);
    if (!nxt || nxt === after) break;
    after = nxt;
  }

  // Stable order for the picker; duplicate display names exist → id is the tiebreaker.
  pages.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  pagesCache = { at: Date.now(), ttl: pages.length > 0 ? PAGES_TTL_MS : PAGES_EMPTY_TTL_MS, pages };
  return pages;
}

/** Server-side guard: only ids from the token's own page list are accepted for a launch/clone. */
export async function isAdvertisablePage(pageId: string): Promise<boolean> {
  if (!/^\d{5,}$/.test(pageId)) return false;
  const pages = await advertisablePages();
  return pages.some((p) => p.id === pageId);
}

/** Display name of one of the token's own pages ("" when unknown) — free, the list is cached.
 *  Feeds the ad set's DSA beneficiary/payor declaration (what Ads Manager pre-fills there). */
export async function advertisablePageName(pageId: string): Promise<string> {
  const pages = await advertisablePages();
  return pages.find((p) => p.id === pageId)?.name ?? "";
}

// ---------- ad accounts of the launch token (with their pixels) ----------

export type TokenAdAccount = { id: string; name: string; pixels: { id: string; name: string }[] };

/** Shared row shape (app-cache key `token-adaccounts`). */
type AccountsState = { accounts: TokenAdAccount[]; expiresAt: number };

const ACCOUNTS_KEY = "token-adaccounts";
const ACCOUNTS_OK_TTL_MS = 15 * 60_000;
const ACCOUNTS_FAIL_TTL_MS = 5 * 60_000;
// The account LIST loaded but the pixel sweep was throttled (some accounts have empty pixels) —
// re-sweep soon to fill them, don't sit on the partial pixel data for the full OK_TTL.
const ACCOUNTS_INCOMPLETE_TTL_MS = 60_000;
const ACCOUNTS_CLAIM_TTL_MS = 2 * 60_000;

let accountsL1: { readAt: number; hasL2: boolean; state: AccountsState } | null = null;
let accountsInflight: Promise<TokenAdAccount[]> | null = null;

/**
 * Every ACTIVE ad account the launch token can use, each with its pixel list (pixels gate the
 * launch validation AND the per-account pixel picker). Same shared-cache discipline as the
 * fanpage volume sweep: one Strapi row for all instances, claim before refreshing, stale beats
 * empty, and the per-account pixel sweep aborts on the first rate-limit error.
 */
export async function tokenAdAccounts(): Promise<TokenAdAccount[]> {
  const now = Date.now();
  if (
    accountsL1 &&
    now < accountsL1.state.expiresAt &&
    accountsL1.state.accounts.length > 0 &&
    (accountsL1.hasL2 ? now < accountsL1.readAt + VOLUME_L1_MS : true)
  ) {
    return accountsL1.state.accounts;
  }
  if (accountsInflight) return accountsInflight;
  accountsInflight = resolveAccounts().finally(() => {
    accountsInflight = null;
  });
  return accountsInflight;
}

async function resolveAccounts(): Promise<TokenAdAccount[]> {
  const now = Date.now();
  const row = await readAppCache<AccountsState>(ACCOUNTS_KEY);
  const shared = row?.value && Array.isArray(row.value.accounts) ? row.value : null;
  const hasL2 = row !== null;

  if (shared && now < shared.expiresAt && shared.accounts.length > 0) {
    accountsL1 = { readAt: now, hasL2, state: shared };
    return shared.accounts;
  }

  // Claim the refresh so parallel instances serve the stale list instead of refetching too.
  const claim: AccountsState = { accounts: shared?.accounts ?? [], expiresAt: now + ACCOUNTS_CLAIM_TTL_MS };
  const claimedId = (await writeAppCache(ACCOUNTS_KEY, claim, row?.documentId ?? null)) ?? row?.documentId ?? null;

  try {
    // Account list — one or two paginated calls (fbGet retries are fine at this size).
    const accounts: TokenAdAccount[] = [];
    let after = "";
    for (let i = 0; i < 10; i++) {
      const body = await fbGet(
        `me/adaccounts?fields=account_id,name,account_status&limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`,
      );
      const data = (body.data as Array<{ account_id?: string; name?: string; account_status?: number }> | undefined) ?? [];
      for (const a of data) {
        if (a?.account_id && a.name && a.account_status === 1) {
          accounts.push({ id: String(a.account_id), name: String(a.name), pixels: [] });
        }
      }
      const nxt = nextAfter(body.paging as { cursors?: { after?: string }; next?: string } | undefined);
      if (!nxt || nxt === after) break;
      after = nxt;
    }
    accounts.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

    // Pixels per account — gentle single-shot sweep, aborts once the account quota pushes back.
    let next = 0;
    let throttled = false;
    const prevPixels = new Map((shared?.accounts ?? []).map((a) => [a.id, a.pixels]));
    const worker = async () => {
      while (!throttled) {
        const i = next++;
        if (i >= accounts.length) return;
        const acct = accounts[i];
        try {
          const res = await fetch(`${FB}/act_${acct.id}/adspixels?fields=id,name&limit=50`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
            cache: "no-store",
          });
          const body = (await res.json().catch(() => ({}))) as Json;
          const err = body.error as { code?: number } | undefined;
          if ((err && RATE_LIMIT_CODES.has(err.code ?? -1)) || res.status === 429 || res.status >= 500) {
            throttled = true;
            return;
          }
          const data = (body.data as Array<{ id?: string; name?: string }> | undefined) ?? [];
          acct.pixels = data
            .filter((p) => p?.id)
            .map((p) => ({ id: String(p.id), name: String(p.name ?? p.id) }));
        } catch {
          /* leave pixels unknown for this account */
        }
        await pause(COUNTS_STAGGER_MS);
      }
    };
    await Promise.all(Array.from({ length: Math.min(COUNTS_CONCURRENCY, accounts.length) }, worker));

    // Unknown pixel lists inherit the previous refresh's data (stale beats empty).
    for (const a of accounts) {
      if (a.pixels.length === 0) {
        const prev = prevPixels.get(a.id);
        if (prev?.length) a.pixels = prev;
      }
    }

    // TTL: full success → 15 min; account list loaded but pixels throttled → 60 s (re-fill soon);
    // no accounts at all → 5 min backoff.
    const ttl =
      accounts.length === 0
        ? ACCOUNTS_FAIL_TTL_MS
        : throttled
          ? ACCOUNTS_INCOMPLETE_TTL_MS
          : ACCOUNTS_OK_TTL_MS;
    const state: AccountsState = { accounts, expiresAt: Date.now() + ttl };
    await writeAppCache(ACCOUNTS_KEY, state, claimedId);
    accountsL1 = { readAt: Date.now(), hasL2, state };
    return accounts;
  } catch (e) {
    // Total failure (rate limit / transport): keep serving the stale list when there is one.
    if (shared && shared.accounts.length > 0) {
      const state: AccountsState = { accounts: shared.accounts, expiresAt: Date.now() + ACCOUNTS_FAIL_TTL_MS };
      await writeAppCache(ACCOUNTS_KEY, state, claimedId);
      accountsL1 = { readAt: Date.now(), hasL2, state };
      return shared.accounts;
    }
    throw e;
  }
}

/** Server-side guard: only accounts from the token's own list are accepted for a launch/clone. */
export async function isTokenAccount(accountId: string): Promise<boolean> {
  if (!/^\d{5,}$/.test(accountId)) return false;
  const accounts = await tokenAdAccounts();
  return accounts.some((a) => a.id === accountId);
}

/** Pixels of one token account; falls back to a direct read when the cached sweep missed it. */
export async function accountPixels(accountId: string): Promise<{ id: string; name: string }[]> {
  const accounts = await tokenAdAccounts();
  const acct = accounts.find((a) => a.id === accountId);
  if (acct && acct.pixels.length > 0) return acct.pixels;
  const body = await fbGet(`act_${accountId}/adspixels?fields=id,name&limit=50`);
  const data = (body.data as Array<{ id?: string; name?: string }> | undefined) ?? [];
  const pixels = data.filter((p) => p?.id).map((p) => ({ id: String(p.id), name: String(p.name ?? p.id) }));
  if (acct) acct.pixels = pixels; // enrich the L1 view for subsequent calls
  return pixels;
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

// ⚠️ Meta's ads_volume counters went dark for this Business (~2026-08-10): every page_id-filtered
// read answers 0 — current_account_ads_running_or_in_review_count included — for pages with
// provably delivering ads (verified live 08-11: page with 5 ACTIVE/PENDING_REVIEW ads → 0 on
// v21/v23/v24). The sweep therefore cross-checks reality: a per-account /ads tally attributes
// every running-or-in-review ad to its creative's page, and each page's count is lifted to
// max(ads_volume, tally). ads_volume stays in the sweep because only IT sees other Businesses'
// ads against the page limit (cross-BM total) — the day Meta heals it, max() makes it win again;
// until then the tally is an honest lower bound instead of a flat 0.
const TALLY_STATUSES = new Set(["ACTIVE", "PENDING_REVIEW", "IN_PROCESS"]);

/** The shared row's shape (cvalue of app-cache key `fanpage-volume:v2:<accountId>`). */
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
        // Abort on a Graph rate-limit code OR a gateway 429/5xx (Meta's CDN returns those with an
        // HTML body → no error.code), else the remaining ~60 calls all fail and keep the quota pinned.
        if ((err && RATE_LIMIT_CODES.has(err.code ?? -1)) || res.status === 429 || res.status >= 500) {
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

  // Reality cross-check (see TALLY_STATUSES note): lift every swept page to at least its real
  // running/in-review ad count. Filling a null hole with a tally number is deliberate — the tally
  // DID verify the page token-wide, and the full sweep re-runs each TTL anyway.
  const tally = await tallyRunningAdsByPage();
  if (tally) {
    for (const id of pageIds) {
      const real = tally.get(id) ?? 0;
      const v = counts.get(id);
      counts.set(id, typeof v === "number" ? Math.max(v, real) : real);
    }
  }
  return counts;
}

/** Real running/in-review ads per page, tallied from every ACTIVE token account's /ads edge
 *  (~15 paginated reads — cheaper than the 60-call ads_volume sweep it backstops). Lower bound
 *  only: it sees just this token's accounts, never other Businesses advertising the same page.
 *  Single-shot per hop like the volume sweep (no retry ladder), aborts on the first rate-limit
 *  answer, one broken account doesn't sink the rest. null = tally unusable (no account covered). */
async function tallyRunningAdsByPage(): Promise<Map<string, number> | null> {
  let accounts: TokenAdAccount[];
  try {
    accounts = await tokenAdAccounts();
  } catch {
    return null;
  }
  if (accounts.length === 0) return null;
  const tally = new Map<string, number>();
  let next = 0;
  let throttled = false;
  let covered = 0;
  const worker = async () => {
    while (!throttled) {
      const i = next++;
      if (i >= accounts.length) return;
      try {
        let after = "";
        for (let hop = 0; hop < 10; hop++) {
          const res = await fetch(
            `${FB}/act_${accounts[i].id}/ads?fields=effective_status,creative{object_story_spec{page_id},object_story_id}&limit=200${after ? `&after=${encodeURIComponent(after)}` : ""}`,
            { headers: { Authorization: `Bearer ${TOKEN}` }, cache: "no-store" },
          );
          const body = (await res.json().catch(() => ({}))) as Json;
          const err = body.error as { code?: number } | undefined;
          if ((err && RATE_LIMIT_CODES.has(err.code ?? -1)) || res.status === 429 || res.status >= 500) {
            throttled = true;
            return;
          }
          if (err) break;
          type AdRow = {
            effective_status?: string;
            creative?: { object_story_spec?: { page_id?: string }; object_story_id?: string };
          };
          for (const ad of (body.data as AdRow[] | undefined) ?? []) {
            if (!TALLY_STATUSES.has(ad?.effective_status ?? "")) continue;
            // Launcher-built ads carry the page in object_story_spec; post-promoting ads carry it
            // as the "<pageId>_<postId>" story id prefix.
            const pid = ad.creative?.object_story_spec?.page_id ?? ad.creative?.object_story_id?.split("_")[0] ?? "";
            if (pid) tally.set(String(pid), (tally.get(String(pid)) ?? 0) + 1);
          }
          if (hop === 0) covered++;
          const nxt = nextAfter(body.paging as { cursors?: { after?: string }; next?: string } | undefined);
          if (!nxt || nxt === after) break;
          after = nxt;
        }
      } catch {
        /* this account stays uncounted */
      }
      await pause(COUNTS_STAGGER_MS);
    }
  };
  await Promise.all(Array.from({ length: Math.min(COUNTS_CONCURRENCY, accounts.length) }, worker));
  return covered > 0 ? tally : null;
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
  // v2: key bumped when the tally cross-check shipped, so rows of trusted all-zeros written by the
  // pre-fix sweep (Meta counter outage) expire out of the picture instead of being served on.
  const key = `fanpage-volume:v2:${accountId}`;
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
    // A fully-failed sweep (live===0) must NOT invite a +1-min full re-sweep — push the heal window
    // out to the fail backoff so a throttled account gets time to recover instead of being re-stormed.
    healAt: Date.now() + (live > 0 ? VOLUME_HEAL_MS : VOLUME_FAIL_TTL_MS),
  };
  await writeAppCache(key, next, claimedId);
  setVolumeL1(key, next, hasL2);
  return toMap(pageIds, counts);
}

/** Meta replication race: creating a child object seconds after its parent can answer
 *  "<parent id> is not a valid …" (code 100; live: Margo's ad set 2026-08-11, campaign created
 *  18s earlier → orphan shell). The parent id appears IN the message (possibly digit-grouped
 *  "120 249 …"), so match digits — locale-proof — and give Meta a few seconds to catch up.
 *  Wrap adset-under-campaign and ad-under-adset creates in the launch/clone pipelines. */
export async function withParentRetry<T>(parentId: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const staleParent = String((e as FbError).message ?? "")
        .replace(/\D/g, "")
        .includes(parentId);
      if (!staleParent || attempt >= 4) throw e;
      await sleep(4000);
    }
  }
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
    if (isRateLimited(body)) {
      const wait = retryWaitMs(res, attempt);
      if (wait !== null) {
        await sleep(wait);
        continue;
      }
    }
    throw new FbError(fbErrorMessage(body, `POST ${path} failed`), body, isRateLimited(body) ? 429 : 502);
  }
}
