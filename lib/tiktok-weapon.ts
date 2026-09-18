// Server-only client for the partner's tiktok-weapon API (TikTok launches through LION's
// infrastructure): one place holds the host, the bearer, the retry policy, the read caches and the
// two gates — routes stay thin. Contract + live probes:
// docs/superpowers/specs/2026-09-18-tiktok-rail-design.md.
//
// Self-contained on purpose (type-only imports) so `node --test tests/tiktok-partner.test.ts`
// loads it straight off Node's type stripping with a stubbed fetch.
//
// ⚠️ Every path ends with a trailing slash.

import type { TiktokCloneWire, TiktokJuroWire, TiktokLaunchWire, TiktokTaskLike } from "./tiktok-launch";

const PRODUCTION_HOST = "tiktok-weapon.highstakes.tech";
const BASE = (process.env.TIKTOK_WEAPON_BASE || `https://${PRODUCTION_HOST}`).replace(/\/+$/, "");
// Same bearer as LION unless the partner hands out a dedicated one.
const TOKEN = process.env.TIKTOK_WEAPON_TOKEN || process.env.LION_TOKEN || "";

export class TiktokWeaponError extends Error {
  status?: number;
  detail?: unknown;
  constructor(message: string, status?: number, detail?: unknown) {
    super(message);
    this.name = "TiktokWeaponError";
    this.status = status;
    this.detail = detail;
  }
}

export const tiktokWeaponConfigured = (): boolean => Boolean(TOKEN);

/** The TikTok rail's dormancy switch, read SERVER-side too: the build-time NEXT_PUBLIC flag hides
 *  the tab/page, but the money-creating routes must not be reachable by a crafted authenticated
 *  POST on a deployment where the rail is meant to be off (prod until the owner enables it). */
export const tiktokRailEnabled = (): boolean => process.env.NEXT_PUBLIC_TIKTOK_ENABLED === "1";

/** Bases a launch may ALWAYS reach: the contract mock lives on the loopback interface. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * May THIS instance fire a launch at the base it points to? The 14.09 Google incident: a local
 * instance started without the mock override sent a test POST to the partner's LIVE host. The rule
 * is an ALLOWLIST, so no spelling of the partner's host (a trailing dot, an IP, a staging alias, a
 * proxy in front of it) can slip past it: a launch goes out freely only to a LOOPBACK base (the
 * mock); ANY other base counts as live and is reached only from the production deployment
 * (`VERCEL_ENV`) or behind an explicit `TIKTOK_ALLOW_LIVE_LAUNCH=1`.
 * Reads are never gated — a local board shows the real advertisers and launches nothing.
 */
export function tiktokLiveLaunchAllowed(): boolean {
  let host = "";
  try {
    host = new URL(BASE).hostname.toLowerCase();
  } catch {
    host = "";
  }
  if (LOOPBACK_HOSTS.has(host)) return true;
  return process.env.VERCEL_ENV === "production" || process.env.TIKTOK_ALLOW_LIVE_LAUNCH === "1";
}

export const TIKTOK_LIVE_LAUNCH_BLOCKED =
  "tiktok_live_launch_blocked: this instance is not production — point TIKTOK_WEAPON_BASE at the local mock (a loopback address), or set TIKTOK_ALLOW_LIVE_LAUNCH=1 to fire at a live partner on purpose";

const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x ?? "")).filter(Boolean) : []);

/** Human sentence for a tiktok-weapon refusal body (`{error|message, hint?, allowed_domains?,
 *  available_pixels?}`) — the partner's words first, its lists appended. */
export function tiktokWeaponErrorMessage(status: number | undefined, body: unknown): string {
  const rec = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const pick = (v: unknown): string => (typeof v === "string" && v.trim() ? v.trim() : "");
  let msg = pick(rec.error) || pick(rec.message) || pick(rec.detail) || (typeof body === "string" && body.trim() ? body.trim().slice(0, 300) : "");
  if (!msg) msg = status ? `tiktok-weapon HTTP ${status}` : "tiktok-weapon unreachable";
  const domains = listOf(rec.allowed_domains ?? rec.allowedDomains ?? rec.domains);
  if (domains.length) msg += ` · allowed domains: ${domains.join(", ")}`;
  const pixels = listOf(rec.available_pixels ?? rec.availablePixels);
  if (pixels.length) msg += ` · available pixels: ${pixels.join(", ")}`;
  const hint = pick(rec.hint);
  if (hint && !msg.includes(hint)) msg += ` (${hint})`;
  if (status === 403 && !/advertiser/i.test(msg)) msg += " — advertiser not allowed for the LION user or not launch eligible";
  return msg;
}

/** Fetch with auth + one retry on network errors / 5xx. 4xx bodies are surfaced verbatim (they
 *  carry the actionable sentence). `attempts=1` disables the retry — REQUIRED for the three
 *  campaign-creating launches: a network cut or 5xx is an AMBIGUOUS outcome (the task may have
 *  been accepted before the answer was lost) and a resend could build a second campaign. */
async function twFetch(path: string, init?: RequestInit, attempts = 2, timeoutMs = 60_000): Promise<unknown> {
  if (!TOKEN) throw new TiktokWeaponError("tiktok-weapon token is not configured (TIKTOK_WEAPON_TOKEN / LION_TOKEN)");
  const url = `${BASE}${path}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
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
      if (res.ok) return body;
      const err = new TiktokWeaponError(tiktokWeaponErrorMessage(res.status, body), res.status, body);
      if (res.status >= 500 && attempt < attempts - 1) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      throw err;
    } catch (e) {
      if (e instanceof TiktokWeaponError && e.status) throw e;
      lastErr = e;
      if (attempt < attempts - 1) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new TiktokWeaponError(String(lastErr));
}

const str = (v: unknown): string => (v == null ? "" : String(v));
const recOf = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

// ---------- advertisers (cached) ----------

export type TwAdvertiser = {
  advertiserId: string;
  name: string;
  /** STATUS_ENABLE | STATUS_LIMIT | STATUS_DISABLE | … */
  status: string;
  currency: string;
  country: string;
  timezone: string;
  /** Business Center the account belongs to. */
  bcId: string;
  /** Enabled, opted in and pixel-ready — launchable NOW (fresh, clone or JURO). */
  launchEligible: boolean;
};

type CacheEntry<T> = { at: number; value: T };
const TTL_MS = 10 * 60_000;
const advertisersCache: { entry?: CacheEntry<TwAdvertiser[]> } = {};
let advertisersInflight: Promise<TwAdvertiser[]> | null = null;

/** Every advertiser our LION user can see. Cached 10 min per instance; an EMPTY answer is never
 *  cached (a transient blank would pin "no accounts" on every picker). */
export async function twAdvertisers(): Promise<TwAdvertiser[]> {
  const e = advertisersCache.entry;
  if (e && Date.now() - e.at < TTL_MS) return e.value;
  if (advertisersInflight) return advertisersInflight;
  advertisersInflight = (async () => {
    try {
      const body = recOf(await twFetch("/api/external/advertisers/"));
      const raw = Array.isArray(body.advertisers) ? (body.advertisers as unknown[]).map(recOf) : [];
      const rows = raw
        .map((a) => ({
          advertiserId: str(a.advertiser_id),
          name: str(a.name).trim(),
          status: str(a.status),
          currency: str(a.currency).toUpperCase(),
          country: str(a.country).toUpperCase(),
          timezone: str(a.timezone),
          bcId: str(a.owner_bc_id),
          launchEligible: a.launch_eligible === true,
        }))
        .filter((a) => a.advertiserId)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      if (rows.length === 0) throw new TiktokWeaponError("tiktok-weapon returned no advertisers", undefined, body);
      advertisersCache.entry = { at: Date.now(), value: rows };
      return rows;
    } finally {
      advertisersInflight = null;
    }
  })();
  return advertisersInflight;
}

// ---------- advertiser config (cached per advertiser) ----------

export type TwPixel = { pixelId: string; pixelCode: string; supportedModes: string[] };
export type TwConfig = {
  advertiserId: string;
  name: string;
  currency: string;
  pixels: TwPixel[];
  countries: { code: string; name: string }[];
  languages: { code: string; name: string }[];
};

const configCache = new Map<string, CacheEntry<TwConfig>>();
const configInflight = new Map<string, Promise<TwConfig>>();

/** Pixels (with the modes each can run), targetable countries and languages of ONE advertiser.
 *  403 = the advertiser is not allowed for the LION user or not launch eligible. */
export async function twAdvertiserConfig(advertiserId: string): Promise<TwConfig> {
  const hit = configCache.get(advertiserId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const running = configInflight.get(advertiserId);
  if (running) return running;
  const p = (async () => {
    try {
      const body = recOf(await twFetch(`/api/external/advertisers/${encodeURIComponent(advertiserId)}/config/`));
      const locales = recOf(body.locales);
      const cfg: TwConfig = {
        advertiserId: str(body.advertiser_id) || advertiserId,
        name: str(body.name).trim(),
        currency: str(body.currency).toUpperCase(),
        pixels: (Array.isArray(body.pixels) ? (body.pixels as unknown[]).map(recOf) : [])
          .map((px) => ({ pixelId: str(px.pixel_id), pixelCode: str(px.pixel_code), supportedModes: listOf(px.supported_modes) }))
          .filter((px) => px.pixelCode),
        countries: (Array.isArray(locales.countries) ? (locales.countries as unknown[]).map(recOf) : [])
          .map((c) => ({ code: str(c.country_code).toUpperCase(), name: str(c.region_name).trim() }))
          .filter((c) => c.code),
        languages: (Array.isArray(locales.languages) ? (locales.languages as unknown[]).map(recOf) : [])
          .map((l) => ({ code: str(l.code), name: str(l.name).trim() }))
          .filter((l) => l.code),
      };
      configCache.set(advertiserId, { at: Date.now(), value: cfg });
      return cfg;
    } finally {
      configInflight.delete(advertiserId);
    }
  })();
  configInflight.set(advertiserId, p);
  return p;
}

/** Bounds for a read made INSIDE the wave pump, where every second comes out of one time budget
 *  (the defaults — two attempts of 60 s — suit a route that serves a board). */
export type TwReadOpts = { attempts?: number; timeoutMs?: number };

// ---------- dataset ----------

/** Trigger the partner's fetch of a source campaign (202, done in 30–120 s; there is NO status
 *  read — the launch itself answers 404 until the source is in). Idempotent → keeps the retry.
 *  Throws 404 for a campaign LION never saw. */
export async function twDatasetFetch(campaignId: string, opts: TwReadOpts = {}): Promise<{ runId: string }> {
  const body = recOf(await twFetch("/api/external/dataset/fetch/", { method: "POST", body: JSON.stringify({ campaign_id: campaignId }) }, opts.attempts ?? 2, opts.timeoutMs ?? 60_000));
  return { runId: str(body.runId ?? body.run_id) };
}

// ---------- launches (exactly-once, live-guarded) ----------

const taskIdOf = (body: unknown, what: string): string => {
  const rec = recOf(body);
  const id = str(rec.taskId ?? rec.task_id);
  if (!id) throw new TiktokWeaponError(`tiktok-weapon ${what} returned no taskId`, undefined, body);
  return id;
};

async function fire(path: string, body: unknown, what: string): Promise<{ taskId: string }> {
  // Refused BEFORE any I/O — a 4xx-class status so the pump records a clean refusal, not an
  // ambiguous outcome (nothing left the process).
  if (!tiktokLiveLaunchAllowed()) throw new TiktokWeaponError(TIKTOK_LIVE_LAUNCH_BLOCKED, 403);
  // `redirect: "error"`: a launch is sent to the base it was checked against, nowhere else.
  const res = await twFetch(path, { method: "POST", body: JSON.stringify(body), redirect: "error" }, 1);
  return { taskId: taskIdOf(res, what) };
}

/** POST /campaign/launch/ — ONE attempt, never re-sent (see twFetch). */
export const twCampaignLaunch = (body: TiktokLaunchWire): Promise<{ taskId: string }> => fire("/api/external/campaign/launch/", body, "launch");
/** POST /clone/launch/ — ONE attempt, never re-sent. */
export const twCloneLaunch = (body: TiktokCloneWire): Promise<{ taskId: string }> => fire("/api/external/clone/launch/", body, "clone");
/** POST /juro/launch/ — ONE attempt, never re-sent. */
export const twJuroLaunch = (body: TiktokJuroWire): Promise<{ taskId: string }> => fire("/api/external/juro/launch/", body, "juro");

// ---------- tasks ----------

export type TwTask = TiktokTaskLike & {
  taskId: string;
  /** launch | clone | juro */
  kind: string;
  adgroupId: string | null;
  adIds: string[];
  createdAt: string | null;
  updatedAt: string | null;
};

export async function twTask(taskId: string, opts: TwReadOpts = {}): Promise<TwTask> {
  const rec = recOf(await twFetch(`/api/external/tasks/${encodeURIComponent(taskId)}/`, undefined, opts.attempts ?? 2, opts.timeoutMs ?? 60_000));
  return {
    taskId: str(rec.taskId ?? rec.task_id) || taskId,
    kind: str(rec.kind),
    /** pending → running → completed | failed; "unknown"/"not_found" when the read itself failed. */
    status: str(rec.status).toLowerCase(),
    campaignId: rec.campaign_id ? str(rec.campaign_id) : null,
    campaignName: rec.campaign_name ? str(rec.campaign_name) : null,
    adgroupId: rec.adgroup_id ? str(rec.adgroup_id) : null,
    adIds: listOf(rec.ad_ids),
    errorMessage: rec.error_message ? str(rec.error_message) : null,
    errorStep: rec.error_step ? str(rec.error_step) : null,
    createdAt: rec.created_at ? str(rec.created_at) : null,
    updatedAt: rec.updated_at ? str(rec.updated_at) : null,
  };
}

/** Read many tasks (≤ `limit` in flight). A per-id failure never sinks the batch — that task
 *  comes back as status "unknown" with the error text (404 = the id belongs to another user or
 *  never existed → "not_found", the caller decides). */
export async function twTasks(taskIds: string[], limit = 5): Promise<TwTask[]> {
  const out: TwTask[] = new Array(taskIds.length);
  let next = 0;
  const worker = async () => {
    while (next < taskIds.length) {
      const i = next++;
      const id = taskIds[i];
      try {
        out[i] = await twTask(id);
      } catch (e) {
        const err = e instanceof TiktokWeaponError ? e : null;
        out[i] = {
          taskId: id,
          kind: "",
          status: err?.status === 404 ? "not_found" : "unknown",
          campaignId: null,
          campaignName: null,
          adgroupId: null,
          adIds: [],
          errorMessage: e instanceof Error ? e.message : String(e),
          errorStep: null,
          createdAt: null,
          updatedAt: null,
        };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, taskIds.length) }, worker));
  return out;
}
