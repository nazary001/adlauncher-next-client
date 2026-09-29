// Server-only client for ActiveView's external REST API (https://external-api.activeview.app, docs
// /llms/full.txt read live 28.09). Bearer = AV_API_KEY (Settings → APIs, `<64hex>:<20hex>` — env only,
// never the FB token vault: its shape check refuses the colon, and it is not an FB bearer);
// AV_API_BASE overrides the host for the offline contract mock (_e2e/_av_mock.mjs).
//
// Contract notes (docs + live reads 28.09):
// - every JSON body is wrapped {"response": …} EXCEPT /healthcheck/ and the redirect routes, which
//   answer their own top-level keys ({"redirectDomains": […]} …) — unwrap() handles both;
// - errors come as {"error": …} or {"message": …}; 401 = missing/invalid key or no access to the
//   site, 403 = route not enabled for the publisher, 429 = rate limit (honour Retry-After), 5xx =
//   theirs (Cloud Run);
// - the redirect PATH routes (detail / mappings / create) were never exercised live (no path exists
//   yet and there is no delete route) → their bodies are read defensively (several key spellings).
// No runtime imports: `node --test` covers it with a stubbed fetch.

const base = (): string => (process.env.AV_API_BASE ?? "https://external-api.activeview.app").replace(/\/+$/, "");
const key = (): string => (process.env.AV_API_KEY ?? "").trim();

export const avApiConfigured = (): boolean => key().length > 0;

const CALL_TIMEOUT_MS = 12_000;
const MAX_RETRIES = 2;
const RETRY_AFTER_CAP_MS = 10_000;

export class AvApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function retryAfterMs(res: Response, attempt: number): number {
  const raw = res.headers.get("retry-after");
  const secs = raw != null && raw.trim() !== "" ? Number(raw) : NaN;
  const ms = Number.isFinite(secs) && secs >= 0 ? secs * 1000 : 1000 * 2 ** attempt;
  return Math.min(ms, RETRY_AFTER_CAP_MS);
}

function errorText(body: unknown): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const v = b.message ?? b.error ?? b.detail;
    if (typeof v === "string") return v;
    if (v && typeof v === "object") {
      const m = (v as Record<string, unknown>).message;
      if (typeof m === "string") return m;
      return JSON.stringify(v).slice(0, 300);
    }
  }
  return typeof body === "string" ? body.slice(0, 300) : "";
}

/** {"response": x} → x; anything else as-is. */
export function unwrap(body: unknown): unknown {
  if (body && typeof body === "object" && !Array.isArray(body) && "response" in (body as Record<string, unknown>)) {
    return (body as Record<string, unknown>).response;
  }
  return body;
}

/**
 * One API call: bounded (12 s), authenticated, retried on 429 (Retry-After, ≤10 s) and — for
 * idempotent methods only — on 5xx / network errors (≤2 retries). A POST is never retried after the
 * server may have acted on it (5xx / timeout), only on 429. Non-ok → AvApiError with a stable code.
 */
export async function avFetch(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  if (!avApiConfigured()) throw new AvApiError(500, "av_not_configured", "av_not_configured — AV_API_KEY is not set on the server");
  const method = (init.method ?? "GET").toUpperCase();
  const idempotent = method !== "POST";
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${base()}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${key()}`,
          Accept: "application/json",
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        cache: "no-store",
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (e) {
      if (idempotent && attempt < MAX_RETRIES) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new AvApiError(502, "av_unreachable", `av_unreachable — ActiveView API did not answer (${(e as Error).message ?? e})`);
    }
    const text = await res.text().catch(() => "");
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body stays text */
    }
    if (res.ok) return body;
    if (res.status === 429 && attempt < MAX_RETRIES) {
      await sleep(retryAfterMs(res, attempt));
      continue;
    }
    if (res.status >= 500 && idempotent && attempt < MAX_RETRIES) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    const detail = errorText(body);
    if (res.status === 401) throw new AvApiError(401, "av_key_rejected", `av_key_rejected — ActiveView refused the API key${detail ? ` (${detail})` : ""}`);
    if (res.status === 403) throw new AvApiError(403, "av_forbidden", `av_forbidden — this ActiveView route is not enabled for our publisher${detail ? ` (${detail})` : ""}`);
    if (res.status === 429) throw new AvApiError(429, "av_rate_limited", "av_rate_limited — ActiveView rate limit, try again in a minute");
    if (res.status === 404) throw new AvApiError(404, "av_not_found", `av_not_found${detail ? ` — ${detail}` : ""}`);
    if (res.status >= 500) throw new AvApiError(502, "av_upstream", `av_upstream — ActiveView answered ${res.status}${detail ? ` (${detail})` : ""}`);
    throw new AvApiError(res.status, "av_rejected", detail ? `ActiveView: ${detail}` : `ActiveView answered ${res.status}`);
  }
}

const str = (v: unknown): string => (v == null ? "" : String(v));
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

// ---------- token access ----------

export type AvSite = { domain: string; siteName: string; networkCode: string; parentNetworkCode: string; delegationType: string };

/** GET /me — the sites this key reaches (live 28.09: thecadrion.com / 2550370616 / MANAGE_PARTNER). */
export async function avMe(): Promise<{ publisherId: string; sites: AvSite[] }> {
  const r = obj(unwrap(await avFetch("/me")));
  const sites = arr(r.sites)
    .map((s) => {
      const o = obj(s);
      return {
        domain: str(o.domain).toLowerCase(),
        siteName: str(o.site_name),
        networkCode: str(o.network_code),
        parentNetworkCode: str(o.parent_network_code),
        delegationType: str(o.delegation_type),
      };
    })
    .filter((s) => s.domain);
  return { publisherId: str(r.publisher_id), sites };
}

// ---------- redirects ----------

export type AvMapping = { url: string; percentage: number };
export type AvRedirectPathRef = { id: string; path: string };
export type AvRedirectDomain = { id: string; name: string; createdAt: string; paths: AvRedirectPathRef[] };
export type AvRedirectPath = { id: string; path: string; fallbackUrl: string; redirectType: string; mappings: AvMapping[] };

const normPath = (p: unknown): string => {
  const s = str(p).trim();
  return s ? (s.startsWith("/") ? s : `/${s}`) : "";
};

/** A target's weight: a number however it is written ("40", "40%"); one that cannot be read stays
 *  unknown (NaN) — never 0, which reads as "gets no visitors" (lib/av-destination checks the chats
 *  a path sends visitors to). */
function weightOf(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : NaN;
}

function mappingsOf(v: unknown): AvMapping[] {
  const o = obj(v);
  const list = Array.isArray(v) ? v : arr(o.redirectMappings ?? o.mappings ?? o.data);
  return list
    .map((m) => {
      const x = obj(m);
      return { url: str(x.url), percentage: weightOf(x.percentage) };
    })
    .filter((m) => m.url);
}

function pathOf(v: unknown): AvRedirectPath {
  let o = obj(unwrap(v));
  // create answers {redirectDomains:{…path…}}, detail answers the path itself (or {redirectPath:{…}})
  for (const k of ["redirectPath", "redirectDomains", "path"]) {
    const inner = o[k];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      o = inner as Record<string, unknown>;
      break;
    }
  }
  return {
    id: str(o.id),
    path: normPath(o.path),
    fallbackUrl: str(o.fallbackUrl ?? o.fallback_url ?? o.fallback),
    redirectType: str(o.redirectType ?? o.redirect_type),
    mappings: mappingsOf(o.redirectMappings ?? o.mappings ?? []),
  };
}

/** GET /v1/redirects — every redirect domain with its paths (own top-level key, no envelope). */
export async function avRedirects(): Promise<AvRedirectDomain[]> {
  const r = obj(unwrap(await avFetch("/v1/redirects")));
  return arr(r.redirectDomains).map((d) => {
    const o = obj(d);
    return {
      id: str(o.id),
      name: str(o.name).toLowerCase(),
      createdAt: str(o.createdAt),
      paths: arr(o.redirectPaths)
        .map((p) => ({ id: str(obj(p).id), path: normPath(obj(p).path) }))
        .filter((p) => p.id && p.path),
    };
  }).filter((d) => d.id && d.name);
}

/** GET /v1/redirects/paths/:id — the path with its fallback and (when the body carries them) mappings. */
export async function avRedirectPath(pathId: string): Promise<AvRedirectPath> {
  return pathOf(await avFetch(`/v1/redirects/paths/${encodeURIComponent(pathId)}`));
}

/** GET /v1/redirects/paths/:id/mappings — the weighted targets. */
export async function avRedirectMappings(pathId: string): Promise<AvMapping[]> {
  return mappingsOf(unwrap(await avFetch(`/v1/redirects/paths/${encodeURIComponent(pathId)}/mappings`)));
}

/** POST /v1/redirects/:domainId/path {path, fallback} — creates a path (400 {message} on validation). */
export async function avCreateRedirectPath(domainId: string, input: { path: string; fallback?: string }): Promise<AvRedirectPath> {
  const body: Record<string, string> = { path: normPath(input.path) };
  if (input.fallback) body.fallback = input.fallback;
  return pathOf(await avFetch(`/v1/redirects/${encodeURIComponent(domainId)}/path`, { method: "POST", body }));
}

/** PUT /v1/redirects/paths/:id/mappings [{url, percentage}] — percentages must sum to 100. */
export async function avPutMappings(pathId: string, mappings: AvMapping[]): Promise<AvMapping[]> {
  const sum = mappings.reduce((s, m) => s + m.percentage, 0);
  if (mappings.length === 0 || Math.round(sum) !== 100) {
    throw new AvApiError(400, "av_mappings_invalid", `av_mappings_invalid — the weights must sum to 100 (got ${sum})`);
  }
  return mappingsOf(unwrap(await avFetch(`/v1/redirects/paths/${encodeURIComponent(pathId)}/mappings`, { method: "PUT", body: mappings })));
}
