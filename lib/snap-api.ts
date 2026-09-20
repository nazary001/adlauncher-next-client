// Snapchat rail — server-only client for the Snapchat Marketing API (our OWN ad account; no
// partner rail). One place holds the hosts, the OAuth refresh, the retry policy and the read
// caches — routes and the pump stay thin. Contract: docs/superpowers/specs/2026-09-16-snapchat-rail-design.md.
// No runtime imports on purpose (type-only from ./snap-launch) so `node --test` can load it with a
// stubbed fetch.
//
// Hosts (docs read 16.09.2026): ads API https://adsapi.snapchat.com/v1 · OAuth
// https://accounts.snapchat.com/login/oauth2/{authorize,access_token} · Public Profiles
// https://businessapi.snapchat.com/v1. Every write is a batch envelope ({campaigns:[…]} →
// {request_status, campaigns:[{sub_request_status, campaign}]}); errors are 4xx/5xx with
// request_status:"ERROR" + display_message/debug_message.

import type { SnapAdSquadWire, SnapAdWire, SnapCampaignWire, SnapCreativeWire } from "./snap-launch";

const API_BASE = (process.env.SNAP_API_BASE || "https://adsapi.snapchat.com/v1").replace(/\/+$/, "");
const AUTH_BASE = (process.env.SNAP_AUTH_BASE || "https://accounts.snapchat.com").replace(/\/+$/, "");
const BUSINESS_BASE = (process.env.SNAP_BUSINESS_API_BASE || "https://businessapi.snapchat.com/v1").replace(/\/+$/, "");
const CLIENT_ID = process.env.SNAP_CLIENT_ID || "";
const CLIENT_SECRET = process.env.SNAP_CLIENT_SECRET || "";
const REFRESH_TOKEN = process.env.SNAP_REFRESH_TOKEN || "";
const OAUTH_SCOPE = "snapchat-marketing-api";
const TIMEOUT_MS = 60_000;

export class SnapApiError extends Error {
  status?: number;
  detail?: unknown;
  constructor(message: string, status?: number, detail?: unknown) {
    super(message);
    this.name = "SnapApiError";
    this.status = status;
    this.detail = detail;
  }
}

/** The rail's dormancy switch read SERVER-side too (the NEXT_PUBLIC flag only hides the tab). */
export const snapRailEnabled = (): boolean => process.env.NEXT_PUBLIC_SNAP_ENABLED === "1";
export const snapConfigured = (): boolean => Boolean(CLIENT_ID && CLIENT_SECRET && REFRESH_TOKEN);
/** Board defaults from env (all optional; the catalog route hands them to the pickers). */
export const snapDefaults = () => ({
  adAccount: process.env.SNAP_AD_ACCOUNT_ID || "",
  pixel: process.env.SNAP_PIXEL_ID || "",
  profile: process.env.SNAP_PROFILE_ID || "",
  brandName: process.env.SNAP_BRAND_NAME || "",
  organization: process.env.SNAP_ORGANIZATION_ID || "",
});

const str = (v: unknown): string => (v == null ? "" : String(v));
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** Snap's sentence for a failed call: display_message (+ debug_message in parentheses when it
 *  adds something), else debug_message / error, else a plain-text body, else the status. */
export function snapErrorMessage(status: number | undefined, body: unknown): string {
  const r = rec(body);
  const display = str(r.display_message).trim();
  const debug = str(r.debug_message).trim();
  // Batch refusals carry the sentence per item (`sub_request_error_reason`), not at the top:
  // read it from the item itself or from the first item of any batch array in the envelope,
  // otherwise a refused ad squad reads as a bare "Snapchat HTTP 400" in the task manager.
  const itemReason = str(r.sub_request_error_reason).trim() || (() => {
    for (const key of ["campaigns", "adsquads", "creatives", "ads", "media"]) {
      const first = Array.isArray(r[key]) ? rec((r[key] as unknown[])[0]) : null;
      const reason = first ? str(first.sub_request_error_reason).trim() : "";
      if (reason) return reason;
    }
    return "";
  })();
  let msg = display && debug && display !== debug ? `${display} (${debug})` : display || debug || itemReason || str(r.error).trim();
  if (!msg && typeof body === "string" && body) msg = body.slice(0, 300);
  if (!msg) msg = status ? `Snapchat HTTP ${status}` : "Snapchat unreachable";
  return msg;
}

/** Unwrap ONE entity from a batch envelope; item-level errors throw with Snap's sentence (400). */
export function snapBatchItem(body: unknown, key: string): Record<string, unknown> {
  const r = rec(body);
  if (str(r.request_status).toUpperCase() === "ERROR") throw new SnapApiError(snapErrorMessage(400, r), 400, body);
  const items = Array.isArray(r[key]) ? (r[key] as unknown[]) : [];
  if (items.length === 0) throw new SnapApiError(`Snapchat answered an empty ${key} batch`, 502, body);
  const item = rec(items[0]);
  if (str(item.sub_request_status).toUpperCase() !== "SUCCESS") throw new SnapApiError(snapErrorMessage(400, item), 400, body);
  const singular = key.endsWith("s") ? key.slice(0, -1) : key;
  const entity = rec(item[singular] ?? item[key.replace(/s$/, "")]);
  return entity;
}

// ---------- OAuth ----------

let tokenCache: { token: string; expiresAt: number } | null = null;
let tokenInflight: Promise<string> | null = null;
export function _resetSnapTokenCache(): void {
  tokenCache = null;
  tokenInflight = null;
}

/** Refresh-token grant, cached per instance until 60 s before expiry; in-flight calls dedupe.
 *  The three failure shapes are kept apart so nobody re-consents over an outage: a network /
 *  timeout failure → 502 "OAuth unreachable"; HTTP 400/401 or an OAuth `error` of invalid_grant /
 *  invalid_client → 401 "refresh token rejected" (re-consent needed); any other non-2xx → its own
 *  status ("Snapchat OAuth HTTP <status>: <sentence>"). */
export async function snapAccessToken(): Promise<string> {
  if (!snapConfigured()) throw new SnapApiError("Snapchat is not configured (SNAP_CLIENT_ID / SNAP_CLIENT_SECRET / SNAP_REFRESH_TOKEN)", 500);
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  if (tokenInflight) return tokenInflight;
  tokenInflight = (async () => {
    try {
      let res: Response;
      try {
        res = await fetch(`${AUTH_BASE}/login/oauth2/access_token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: REFRESH_TOKEN }),
          cache: "no-store",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        // fetch throws on DNS / connection / AbortSignal.timeout — never a Response, so never a rejection.
        const cause = str((e as { cause?: { message?: unknown } })?.cause?.message);
        const msg = (e instanceof Error && e.message) || String(e);
        throw new SnapApiError(`Snapchat OAuth unreachable: ${cause ? `${msg} (${cause})` : msg}`, 502, e);
      }
      const body = await res.json().catch(() => ({}));
      const r = rec(body);
      const oauthError = str(r.error).trim();
      if (res.status === 400 || res.status === 401 || oauthError === "invalid_grant" || oauthError === "invalid_client") {
        const description = str(r.error_description).trim();
        throw new SnapApiError(`Snapchat refresh token rejected (${snapErrorMessage(res.status, body)}${description ? `: ${description}` : ""})`, 401, body);
      }
      if (!res.ok) throw new SnapApiError(`Snapchat OAuth HTTP ${res.status}: ${snapErrorMessage(res.status, body)}`, res.status, body);
      const token = str(r.access_token);
      if (!token) throw new SnapApiError("Snapchat OAuth answered without an access_token", 502, body);
      const ttl = Number(r.expires_in) || 3600;
      tokenCache = { token, expiresAt: Date.now() + Math.max(60, ttl - 60) * 1000 };
      return token;
    } finally {
      tokenInflight = null;
    }
  })();
  return tokenInflight;
}

/** The consent URL for the owner-only OAuth helper (scope snapchat-marketing-api). */
export function snapAuthorizeUrl(state: string, redirectUri: string): string {
  const q = new URLSearchParams({ response_type: "code", client_id: CLIENT_ID, redirect_uri: redirectUri, scope: OAUTH_SCOPE, state });
  return `${AUTH_BASE}/login/oauth2/authorize?${q.toString()}`;
}

/** Authorization-code grant — used ONCE by the helper to mint the refresh token the owner pastes into env. */
export async function snapExchangeCode(code: string, redirectUri: string): Promise<{ refreshToken: string; accessToken: string; expiresIn: number }> {
  const res = await fetch(`${AUTH_BASE}/login/oauth2/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, redirect_uri: redirectUri }),
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  const r = rec(body);
  if (!res.ok || !str(r.refresh_token)) throw new SnapApiError(`code exchange failed (${snapErrorMessage(res.status, body)})`, res.status || 502, body);
  return { refreshToken: str(r.refresh_token), accessToken: str(r.access_token), expiresIn: Number(r.expires_in) || 0 };
}

// ---------- bounded fetch ----------

/**
 * Bearer + JSON + 60 s timeout. `attempts=2` retries ONCE on 5xx/network (reads); `attempts=1` is
 * REQUIRED for every create/update — an ambiguous outcome must never be re-sent. 4xx bodies are
 * surfaced verbatim (they carry the actionable sentence); a 2xx whose request_status is ERROR is
 * an error too.
 */
async function snapFetch(url: string, init: RequestInit = {}, attempts = 2, timeoutMs = TIMEOUT_MS): Promise<unknown> {
  const token = await snapAccessToken();
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...(init.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) },
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      if (res.ok) {
        if (str(rec(body).request_status).toUpperCase() === "ERROR") throw new SnapApiError(snapErrorMessage(400, body), 400, body);
        return body;
      }
      const err = new SnapApiError(snapErrorMessage(res.status, body), res.status, body);
      // A 401 from the ads/business host = the cached access token is revoked (or expired early):
      // drop it so the NEXT call refreshes instead of replaying it for up to an hour. A refresh in
      // flight, if any, is left alone — it overwrites the cache with a fresh token anyway.
      if (res.status === 401) tokenCache = null;
      if (res.status >= 500 && attempt < attempts - 1) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      throw err;
    } catch (e) {
      if (e instanceof SnapApiError && e.status && e.status < 500) throw e;
      lastErr = e;
      if (attempt < attempts - 1) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new SnapApiError(String(lastErr));
}

const jsonInit = (method: "POST" | "PUT", body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

// ---------- reads (cached 10 min per instance; an EMPTY list only 60 s — a pixel-less account
//            with SNAP_PIXEL_ID set would otherwise be re-read once per shot, ~45 reads a wave) ----------

export type SnapAdAccount = { id: string; name: string; currency: string; timezone: string; status: string; organizationId: string };
export type SnapPixel = { id: string; name: string; status: string };
export type SnapProfile = { id: string; displayName: string; profileType: string };

const TTL_MS = 10 * 60_000;
const EMPTY_TTL_MS = 60_000;
type Cached<T> = { at: number; ttl: number; value: T };
const caches = new Map<string, Cached<unknown>>();
const inflight = new Map<string, Promise<unknown>>();
async function cached<T>(key: string, load: () => Promise<T>, ttl = TTL_MS): Promise<T> {
  const hit = caches.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value as T;
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = (async () => {
    try {
      const value = await load();
      // The per-day stats keys add one entry per opened date — drop what has expired.
      if (caches.size > 200) for (const [k, c] of caches) if (Date.now() - c.at >= c.ttl) caches.delete(k);
      caches.set(key, { at: Date.now(), ttl: Array.isArray(value) && value.length === 0 ? EMPTY_TTL_MS : ttl, value });
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/** Every ad account under every organization the token can see (one call). */
export async function snapAdAccounts(): Promise<SnapAdAccount[]> {
  return cached("adaccounts", async () => {
    const body = await snapFetch(`${API_BASE}/me/organizations?with_ad_accounts=true`);
    const orgs = Array.isArray(rec(body).organizations) ? (rec(body).organizations as unknown[]) : [];
    const out: SnapAdAccount[] = [];
    for (const o of orgs) {
      const org = rec(rec(o).organization);
      const accts = Array.isArray(org.ad_accounts) ? (org.ad_accounts as unknown[]) : [];
      for (const a of accts) {
        const acc = rec(a);
        if (!str(acc.id)) continue;
        out.push({
          id: str(acc.id),
          name: str(acc.name),
          currency: str(acc.currency).toUpperCase(),
          timezone: str(acc.timezone),
          status: str(acc.status),
          organizationId: str(org.id),
        });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  });
}

export async function snapPixels(adAccountId: string): Promise<SnapPixel[]> {
  return cached(`pixels:${adAccountId}`, async () => {
    const body = await snapFetch(`${API_BASE}/adaccounts/${encodeURIComponent(adAccountId)}/pixels`);
    const items = Array.isArray(rec(body).pixels) ? (rec(body).pixels as unknown[]) : [];
    return items
      .map((p) => rec(rec(p).pixel))
      .filter((p) => str(p.id))
      .map((p) => ({ id: str(p.id), name: str(p.name), status: str(p.status || p.effective_status) }));
  });
}

/** Public Profiles live on the business host; every ad must reference one (since 26.02.2024). */
export async function snapProfiles(organizationId: string): Promise<SnapProfile[]> {
  return cached(`profiles:${organizationId}`, async () => {
    const body = await snapFetch(`${BUSINESS_BASE}/organizations/${encodeURIComponent(organizationId)}/public_profiles`);
    const items = Array.isArray(rec(body).public_profiles) ? (rec(body).public_profiles as unknown[]) : [];
    return items
      .map((p) => rec(rec(p).public_profile))
      .filter((p) => str(p.id))
      .map((p) => ({ id: str(p.id), displayName: str(p.display_name), profileType: str(p.profile_type) }));
  });
}

// ---------- live reads for the keys report ----------
// RAW bodies on purpose: lib/snap-stats.ts parses them (pure, tested) and this file stays free of
// runtime imports. They share the token's rate limit (10 rps) with the launch pump, so: 5 min of
// cache per instance, ONE attempt and a 12 s ceiling — the keys page would rather name an account
// it could not read than sit on it, and never competes with a launch for long.

const LIVE_TTL_MS = 5 * 60_000;
const LIVE_TIMEOUT_MS = 12_000;
const LIVE_MAX_PAGES = 5;

/** A paged list: follows paging.next_link while it stays on OUR ads host (the bearer goes with it). */
async function snapPages(url: string): Promise<unknown[]> {
  const pages: unknown[] = [];
  let next = url;
  for (let i = 0; i < LIVE_MAX_PAGES && next; i++) {
    const body = await snapFetch(next, {}, 1, LIVE_TIMEOUT_MS);
    pages.push(body);
    const link = str(rec(rec(body).paging).next_link);
    next = link.startsWith(`${API_BASE}/`) ? link : "";
  }
  return pages;
}

/** One account's stats for a window, broken down by campaign (granularity TOTAL takes any
 *  hour-aligned window — lib/snap-stats.ts says why the day is not asked as DAY). */
export async function snapAccountStatsRaw(adAccountId: string, startTime: string, endTime: string): Promise<unknown> {
  return cached(
    // Both ends: a range and a day can start on the same midnight.
    `stats:${adAccountId}:${startTime}:${endTime}`,
    () => {
      const q = new URLSearchParams({ granularity: "TOTAL", breakdown: "campaign", start_time: startTime, end_time: endTime, fields: "impressions,swipes,spend" });
      return snapFetch(`${API_BASE}/adaccounts/${encodeURIComponent(adAccountId)}/stats?${q.toString()}`, {}, 1, LIVE_TIMEOUT_MS);
    },
    LIVE_TTL_MS,
  );
}

export async function snapAccountCampaignsRaw(adAccountId: string): Promise<unknown[]> {
  return cached(`live-campaigns:${adAccountId}`, () => snapPages(`${API_BASE}/adaccounts/${encodeURIComponent(adAccountId)}/campaigns`), LIVE_TTL_MS);
}

export async function snapAccountAdsRaw(adAccountId: string): Promise<unknown[]> {
  return cached(`live-ads:${adAccountId}`, () => snapPages(`${API_BASE}/adaccounts/${encodeURIComponent(adAccountId)}/ads`), LIVE_TTL_MS);
}

// ---------- media ----------

export async function snapCreateMedia(adAccountId: string, name: string, type: "VIDEO" | "IMAGE"): Promise<{ id: string }> {
  const body = await snapFetch(`${API_BASE}/adaccounts/${encodeURIComponent(adAccountId)}/media`, jsonInit("POST", { media: [{ name, type, ad_account_id: adAccountId }] }), 1);
  return { id: str(snapBatchItem(body, "media").id) };
}

/** Multipart upload of the bytes (field `file`), one attempt. */
export async function snapUploadMedia(mediaId: string, bytes: Uint8Array, filename: string, mime: string): Promise<void> {
  const form = new FormData();
  form.append("file", new Blob([bytes as BlobPart], { type: mime || "application/octet-stream" }), filename);
  await snapFetch(`${API_BASE}/media/${encodeURIComponent(mediaId)}/upload`, { method: "POST", body: form }, 1);
}

export async function snapMediaReady(mediaId: string): Promise<boolean> {
  const body = await snapFetch(`${API_BASE}/media/${encodeURIComponent(mediaId)}`);
  return str(snapBatchItem(body, "media").media_status).toUpperCase() === "READY";
}

// ---------- creates (exactly-once) ----------

export async function snapCreateCampaign(adAccountId: string, body: SnapCampaignWire): Promise<{ id: string }> {
  const res = await snapFetch(`${API_BASE}/adaccounts/${encodeURIComponent(adAccountId)}/campaigns`, jsonInit("POST", { campaigns: [body] }), 1);
  return { id: str(snapBatchItem(res, "campaigns").id) };
}

export async function snapCreateAdSquad(campaignId: string, body: SnapAdSquadWire & { campaign_id: string }): Promise<{ id: string }> {
  const res = await snapFetch(`${API_BASE}/campaigns/${encodeURIComponent(campaignId)}/adsquads`, jsonInit("POST", { adsquads: [body] }), 1);
  return { id: str(snapBatchItem(res, "adsquads").id) };
}

export async function snapCreateCreative(adAccountId: string, body: SnapCreativeWire): Promise<{ id: string }> {
  const res = await snapFetch(`${API_BASE}/adaccounts/${encodeURIComponent(adAccountId)}/creatives`, jsonInit("POST", { creatives: [body] }), 1);
  return { id: str(snapBatchItem(res, "creatives").id) };
}

export async function snapCreateAd(adSquadId: string, body: SnapAdWire & { ad_squad_id: string; creative_id: string }): Promise<{ id: string }> {
  const res = await snapFetch(`${API_BASE}/adsquads/${encodeURIComponent(adSquadId)}/ads`, jsonInit("POST", { ads: [body] }), 1);
  return { id: str(snapBatchItem(res, "ads").id) };
}

/** Snap's PUT wants the WHOLE object (omitted attributes reset): read it, whitelist the writable
 *  fields, flip the status, send once. */
const CAMPAIGN_PUT_FIELDS = ["id", "name", "ad_account_id", "status", "start_time", "end_time", "buy_model", "objective_v2_properties", "daily_budget_micro", "lifetime_spend_cap_micro", "measurement_spec", "regulations"] as const;
export async function snapSetCampaignStatus(campaignId: string, status: "ACTIVE" | "PAUSED"): Promise<void> {
  const read = await snapFetch(`${API_BASE}/campaigns/${encodeURIComponent(campaignId)}`);
  const cur = snapBatchItem(read, "campaigns");
  const next: Record<string, unknown> = {};
  for (const k of CAMPAIGN_PUT_FIELDS) if (cur[k] !== undefined && cur[k] !== null) next[k] = cur[k];
  next.status = status;
  const adAccountId = str(cur.ad_account_id);
  if (!adAccountId) throw new SnapApiError(`campaign ${campaignId} carries no ad_account_id`, 502, read);
  const res = await snapFetch(`${API_BASE}/adaccounts/${encodeURIComponent(adAccountId)}/campaigns`, jsonInit("PUT", { campaigns: [next] }), 1);
  snapBatchItem(res, "campaigns");
}

// ---------- creative bytes (public Blob URL → memory, bounded) ----------

/**
 * Download ONE creative into memory, never more than `maxBytes` of it. The body is streamed with a
 * running counter and the request is torn down the moment the count passes the cap, so a host that
 * omits (or understates) content-length cannot make the pump buffer 60 s of bytes — an OOM would
 * kill the whole after() function and wedge every remaining row of the wave. A present
 * content-length still refuses before the first byte (Vercel Blob sends it). One 60 s timeout
 * covers the headers and the body.
 */
export async function snapFetchBytes(url: string, maxBytes: number): Promise<{ bytes: Uint8Array; mime: string; size: number }> {
  const cap = Math.round(maxBytes / 1024 / 1024);
  const overCap = (mb: string) => new SnapApiError(`creative is ${mb} MB — Snapchat single upload takes at most ${cap} MB; trim the file`, 400);
  const controller = new AbortController();
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(TIMEOUT_MS)]) });
  if (!res.ok) throw new SnapApiError(`creative download failed (HTTP ${res.status})`, 400);
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > maxBytes) throw overCap(String(Math.round(declared / 1024 / 1024)));
  // A null body (a 204-class answer) cannot be metered — and cannot be a creative either.
  if (!res.body) throw new SnapApiError("creative download answered without a body — re-attach the file", 400);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      // Cancel the stream (the source stops producing) and abort the request (the socket goes):
      // the rest of the file never lands in memory.
      await reader.cancel().catch(() => {});
      controller.abort();
      throw overCap(`over ${cap}`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { bytes, mime: res.headers.get("content-type") || "", size };
}
