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
