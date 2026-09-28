// Server-only. Thin client for the TOOL Sessions API (https://tool.gctracking.xyz/api/v1) — the
// HS team's Ads Manager sessions service (owner ask 2026-09-25). One place holds the host, the
// bearer key, the timeout, the error normalisation and the `me` cache; the routes stay thin and
// the decisions (shape guards, validation) live in lib/tool-sessions-model.
//
// Env: TOOL_SESSIONS_API_KEY (an `hst_…` team key issued on /keys — all six scopes) and the
// optional TOOL_SESSIONS_BASE (defaults to the live host; point it at _e2e/_tool_sessions_mock.mjs
// for an offline smoke). The key never leaves this process; request bodies (tokens, cookies,
// proxies) are never logged and never echoed back in an error.
//
// TRANSPORT ONLY: every call answers TOOL's JSON as it came (typed loosely); the routes run it
// through the model's guards (toSession, toJobView, …). No runtime "@/" or relative imports on
// purpose (type-only from the model) so `node --test` can load this file with a stubbed fetch.

import type { CreateBody, ToolJob, ToolMe, UpdateBody } from "./tool-sessions-model";
import type { CampaignRequest, DuplicateRequest } from "./tool-launch";

const DEFAULT_BASE = "https://tool.gctracking.xyz";
const TIMEOUT_MS = 30_000;

const base = (): string => (process.env.TOOL_SESSIONS_BASE || DEFAULT_BASE).replace(/\/+$/, "");
const key = (): string => (process.env.TOOL_SESSIONS_API_KEY || "").trim();

/** False until the owner puts the `hst_…` key into the env (the page then shows how). */
export const toolConfigured = (): boolean => key().length > 0;
/** For the page's "where am I talking to" line — host only, never the key. */
export const toolHost = (): string => base();

export type ToolFailure = { ok: false; status: number; error: string; message: string; field?: string; problems?: unknown[] };
export type ToolResult<T> = { ok: true; status: number; data: T } | ToolFailure;

type Query = Record<string, string | number | boolean | undefined | null>;

const str = (v: unknown): string => (v == null ? "" : String(v));

/** TOOL's own error body ({error, message, field, problems}) → a ToolFailure; plain-text or empty
 *  bodies get a sentence per status so the board never shows a bare "HTTP 500". */
export function toolFailure(status: number, body: unknown): ToolFailure {
  const r = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const error = str(r?.error);
  const message = str(r?.message);
  if (status === 401) {
    return { ok: false, status, error: "key_rejected", message: "TOOL rejected the API key — revoked or wrong; issue a new one on tool.gctracking.xyz/keys and update TOOL_SESSIONS_API_KEY" };
  }
  if (status === 403) {
    return { ok: false, status, error: "scope_missing", message: message || "the API key lacks the scope for this action — re-issue it with every scope on tool.gctracking.xyz/keys" };
  }
  if (r && (error || message)) {
    const out: ToolFailure = { ok: false, status, error: error || `http_${status}`, message: message || error };
    if (str(r.field)) out.field = str(r.field);
    if (Array.isArray(r.problems)) out.problems = r.problems;
    return out;
  }
  const text = typeof body === "string" ? body.trim().slice(0, 200) : "";
  return { ok: false, status, error: `http_${status}`, message: text || (status === 404 ? "not found" : status >= 500 ? `TOOL answered HTTP ${status}` : `TOOL refused the request (HTTP ${status})`) };
}

/**
 * One bounded call. Never throws: network / timeout failures come back as a 502 ToolFailure.
 * A 2xx with a non-JSON body is a 502 too (the contract is JSON); an empty 2xx body is `null`.
 */
export async function toolFetch<T = unknown>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  opts: { body?: unknown; query?: Query; timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<ToolResult<T>> {
  const k = key();
  if (!k) return { ok: false, status: 500, error: "not_configured", message: "TOOL_SESSIONS_API_KEY is not set on this deployment" };
  const url = new URL(`${base()}/api/v1${path.startsWith("/") ? path : `/${path}`}`);
  for (const [name, v] of Object.entries(opts.query ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(name, String(v));
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${k}`, Accept: "application/json", ...(opts.headers ?? {}) };
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: opts.body !== undefined ? { ...headers, "Content-Type": "application/json" } : headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
    });
  } catch (e) {
    const cause = str((e as { cause?: { message?: unknown } })?.cause?.message);
    const msg = (e instanceof Error && e.message) || String(e);
    return { ok: false, status: 502, error: "tool_unreachable", message: `TOOL Sessions unreachable: ${cause ? `${msg} (${cause})` : msg}` };
  }
  const text = await res.text().catch(() => "");
  let body: unknown = text;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      /* keep the text — toolFailure shows a slice of it */
    }
  }
  if (!res.ok) return toolFailure(res.status, body);
  if (text && typeof body === "string") return { ok: false, status: 502, error: "bad_answer", message: `TOOL answered ${res.status} with a non-JSON body` };
  return { ok: true, status: res.status, data: (text ? body : null) as T };
}

// ---- who am I (cached per instance; the key's scopes gate the board's buttons) --------------------

const ME_TTL_MS = 5 * 60_000;
let meCache: { at: number; me: ToolMe } | null = null;
let meInflight: Promise<ToolResult<ToolMe>> | null = null;
export function _resetToolCaches(): void {
  meCache = null;
  meInflight = null;
}

/** GET /me — {actor, team_id, teams, is_hs_admin, scopes}; guarded lightly here (scopes is the
 *  one field the board relies on), cached 5 min per instance, in-flight calls dedupe. */
export async function toolMe(force = false): Promise<ToolResult<ToolMe>> {
  if (!force && meCache && Date.now() - meCache.at < ME_TTL_MS) return { ok: true, status: 200, data: meCache.me };
  if (meInflight) return meInflight;
  meInflight = (async () => {
    try {
      const r = await toolFetch<Record<string, unknown>>("GET", "/me");
      if (!r.ok) return r;
      const d = r.data && typeof r.data === "object" ? r.data : {};
      const me: ToolMe = {
        actor: str(d.actor),
        team_id: Number(d.team_id) || 0,
        teams: Array.isArray(d.teams) ? d.teams.map((t) => Number(t) || 0) : [],
        is_hs_admin: d.is_hs_admin === true,
        scopes: Array.isArray(d.scopes) ? d.scopes.map(str).filter(Boolean) : [],
      };
      meCache = { at: Date.now(), me };
      return { ok: true as const, status: r.status, data: me };
    } finally {
      meInflight = null;
    }
  })();
  return meInflight;
}

// ---- sessions (raw SessionOut / SessionOut[]; routes apply toSession / toSessionRow) ------------

export const listSessions = (status?: string) => toolFetch<unknown[]>("GET", "/sessions", { query: { status } });
export const getSession = (id: number) => toolFetch<unknown>("GET", `/sessions/${id}`);
export const createSession = (body: CreateBody) => toolFetch<unknown>("POST", "/sessions", { body, timeoutMs: 60_000 });
export const updateSession = (id: number, body: UpdateBody) => toolFetch<unknown>("PATCH", `/sessions/${id}`, { body, timeoutMs: 60_000 });
export const deleteSession = (id: number) => toolFetch<{ ok?: boolean } | null>("DELETE", `/sessions/${id}`);
/** Queues a session.check job (me + accounts + egress IP through the proxy) → the raw JobOut. */
export const checkSession = (id: number) => toolFetch<ToolJob>("POST", `/sessions/${id}/check`);
export const sessionEvents = (id: number, limit = 100) => toolFetch<unknown[]>("GET", `/sessions/${id}/events`, { query: { limit } });
export const sessionAccounts = (id: number) => toolFetch<{ accounts?: unknown[] }>("GET", `/sessions/${id}/accounts`);

// ---- jobs ------------------------------------------------------------------------------------------

export type JobFilters = { session_id?: number; kind?: string; status?: string; batch_id?: string; limit?: number; offset?: number };

/** GET /jobs → {rows, total}; a missing total counts the rows. */
export async function listJobs(f: JobFilters = {}): Promise<ToolResult<{ rows: ToolJob[]; total: number }>> {
  const r = await toolFetch<{ rows?: unknown; total?: unknown }>("GET", "/jobs", { query: { ...f } });
  if (!r.ok) return r;
  const rows = Array.isArray(r.data?.rows) ? (r.data.rows as ToolJob[]) : [];
  const total = Number(r.data?.total);
  return { ok: true, status: r.status, data: { rows, total: Number.isFinite(total) ? total : rows.length } };
}
export const getJob = (id: number) => toolFetch<ToolJob>("GET", `/jobs/${id}`);
export const jobEvents = (id: number) => toolFetch<unknown[]>("GET", `/jobs/${id}/events`);
export const retryJob = (id: number) => toolFetch<ToolJob>("POST", `/jobs/${id}/retry`);
export const cancelJob = (id: number) => toolFetch<{ ok?: boolean } | null>("POST", `/jobs/${id}/cancel`);

// ---- team accounts ---------------------------------------------------------------------------------

export const teamAccounts = () => toolFetch<{ accounts?: unknown[]; scope?: unknown[] }>("GET", "/accounts");

// ---- campaign / duplicate / media writes (the buyer-facing launch channel, owner ask 28.09) -------
// All through toolFetch (bounded, never-throws, JSON). Writes get a generous 60s timeout (the create
// job is queued fast, but a cold server + proxy handshake can be slow). The Idempotency-Key header
// carries OUR task id (shot task id for HS waves) so a retried wave never double-creates — TOOL
// records it as the job's client_request_id. account_id is act_-stripped (TOOL's canonical form; it
// accepts act_ too, but the digits are what our registries key on). Media uses …/from-url (JSON) so
// it rides toolFetch — multipart cannot (toolFetch always sets Content-Type: application/json).

type ToolWriteOpts = { idempotencyKey?: string };
const idemHeaders = (o?: ToolWriteOpts): Record<string, string> | undefined =>
  o?.idempotencyKey ? { "Idempotency-Key": o.idempotencyKey } : undefined;
const acctPath = (accountId: string): string => encodeURIComponent(String(accountId).replace(/^act_/, ""));

/** POST /accounts/{id}/campaigns — 200 DryRunResult (dry_run) | 201/202 JobOut (validate/publish) |
 *  422 ErrorOut. The caller branches on status/body; here we just carry the answer. */
export const createCampaign = (accountId: string, body: CampaignRequest, opts: ToolWriteOpts = {}) =>
  toolFetch<Record<string, unknown>>("POST", `/accounts/${acctPath(accountId)}/campaigns`, {
    body,
    timeoutMs: 60_000,
    headers: idemHeaders(opts),
  });

/** POST /accounts/{id}/duplicates — 201 DuplicateBatchOut {batch_id, status, jobs:[JobOut]} (one
 *  child job per target×copy). */
export const createDuplicates = (accountId: string, body: DuplicateRequest, opts: ToolWriteOpts = {}) =>
  toolFetch<Record<string, unknown>>("POST", `/accounts/${acctPath(accountId)}/duplicates`, {
    body,
    timeoutMs: 60_000,
    headers: idemHeaders(opts),
  });

/** POST /accounts/{id}/media/{images|videos}/from-url — register a media from a PUBLIC http(s) URL
 *  → 201 MediaOut {media_id, status, facebook{image_hash|video_id}}; poll GET /media/{id} for
 *  `ready`. account_id rides the path (server default); engine defaults to `session`. */
export const mediaFromUrl = (
  accountId: string,
  kind: "image" | "video",
  body: { url: string; filename?: string },
  opts: ToolWriteOpts = {},
) =>
  toolFetch<Record<string, unknown>>(
    "POST",
    `/accounts/${acctPath(accountId)}/media/${kind === "video" ? "videos" : "images"}/from-url`,
    {
      body: body.filename ? { url: body.url, filename: body.filename } : { url: body.url },
      timeoutMs: 60_000,
      headers: idemHeaders(opts),
    },
  );

/** GET /media/{media_id} → MediaOut (poll until status `ready`). */
export const getMedia = (mediaId: string) =>
  toolFetch<Record<string, unknown>>("GET", `/media/${encodeURIComponent(mediaId)}`, { timeoutMs: 60_000 });
