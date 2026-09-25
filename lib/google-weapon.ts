// Server-only client for the partner's google-weapon API (Google Ads launches through LION's
// infrastructure): one place holds the host, the bearer, the retry policy and the read caches —
// routes stay thin. Contract + live probes: docs/superpowers/specs/2026-09-14-google-clone-juro-design.md.
//
// ⚠️ Every path ends with a trailing slash — a POST without it is a plain 404.

import { googleWeaponErrorMessage, isGoogleLaunchAccount, type GoogleLaunchWire } from "./google-bid";
import { foldGoogleLaunchCatalog, type GoogleHiddenAccount } from "./google-account-status";
import { ensureGoogleDataset, saoPauloDate, type GoogleEnsureResult } from "./google-source";

const BASE = (process.env.GOOGLE_WEAPON_BASE || "https://google-weapon.highstakes.tech").replace(/\/+$/, "");
// Same bearer as LION unless the partner hands out a dedicated one.
const TOKEN = process.env.GOOGLE_WEAPON_TOKEN || process.env.LION_TOKEN || "";

export class GoogleWeaponError extends Error {
  status?: number;
  detail?: unknown;
  constructor(message: string, status?: number, detail?: unknown) {
    super(message);
    this.name = "GoogleWeaponError";
    this.status = status;
    this.detail = detail;
  }
}

export const googleWeaponConfigured = (): boolean => Boolean(TOKEN);

/** The Google rail's dormancy switch, read SERVER-side too: the build-time NEXT_PUBLIC flag hides
 *  the tab/page, but the money-creating routes must not be reachable by a crafted authenticated
 *  POST on a deployment where the rail is meant to be off (prod until the owner enables it). */
export const googleRailEnabled = (): boolean => process.env.NEXT_PUBLIC_GOOGLE_ENABLED === "1";

/** Fetch with auth + one retry on network errors / 5xx. 4xx bodies are surfaced verbatim (they
 *  carry the actionable sentence). `attempts=1` disables the retry — REQUIRED for the two
 *  campaign-creating launches: a network cut or 5xx is an AMBIGUOUS outcome (the task may have
 *  been accepted before the answer was lost) and a resend could build a second campaign. */
async function gwFetch(path: string, init?: RequestInit, attempts = 2): Promise<unknown> {
  if (!TOKEN) throw new GoogleWeaponError("google-weapon token is not configured (GOOGLE_WEAPON_TOKEN / LION_TOKEN)");
  const url = `${BASE}${path}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
        cache: "no-store",
        signal: AbortSignal.timeout(60_000),
      });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      if (res.ok) return body;
      if (res.status >= 500 && attempt < attempts - 1) {
        lastErr = new GoogleWeaponError(googleWeaponErrorMessage(res.status, body), res.status, body);
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      throw new GoogleWeaponError(googleWeaponErrorMessage(res.status, body), res.status, body);
    } catch (e) {
      if (e instanceof GoogleWeaponError && e.status && e.status < 500) throw e;
      lastErr = e;
      if (attempt < attempts - 1) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new GoogleWeaponError(String(lastErr));
}

/** GET with the raw status too — the dataset endpoints encode state in 200 vs 202. */
async function gwFetchWithStatus(path: string, init?: RequestInit, attempts = 2): Promise<{ status: number; body: unknown }> {
  if (!TOKEN) throw new GoogleWeaponError("google-weapon token is not configured (GOOGLE_WEAPON_TOKEN / LION_TOKEN)");
  const url = `${BASE}${path}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
        cache: "no-store",
        signal: AbortSignal.timeout(60_000),
      });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      if (res.ok) return { status: res.status, body };
      if (res.status >= 500 && attempt < attempts - 1) {
        lastErr = new GoogleWeaponError(googleWeaponErrorMessage(res.status, body), res.status, body);
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      throw new GoogleWeaponError(googleWeaponErrorMessage(res.status, body), res.status, body);
    } catch (e) {
      if (e instanceof GoogleWeaponError && e.status && e.status < 500) throw e;
      lastErr = e;
      if (attempt < attempts - 1) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new GoogleWeaponError(String(lastErr));
}

const str = (v: unknown): string => (v == null ? "" : String(v));

// ---------- customers (cached) ----------

export type GwCustomer = {
  customerId: string;
  name: string;
  mccId: string;
  currency: string;
  /** Conversion pixels available on the account (`pixel_id` strings like "AW-…/…"). */
  pixels: string[];
  /** Google's CustomerStatus as LION passes it through (ENABLED | SUSPENDED | …, since 25.09);
   *  "" when the row came without one — such an account is NOT offered (not known to be active). */
  status: string;
};

type CacheEntry<T> = { at: number; value: T };
const TTL_MS = 10 * 60_000;
const customersCache: { entry?: CacheEntry<GwCustomer[]> } = {};
let customersInflight: Promise<GwCustomer[]> | null = null;

/** The Google Ads accounts our LION user may launch on. Cached 10 min per instance; an EMPTY
 *  answer is never cached (a transient blank would pin "no accounts" on every picker). */
export async function gwCustomers(): Promise<GwCustomer[]> {
  const e = customersCache.entry;
  if (e && Date.now() - e.at < TTL_MS) return e.value;
  if (customersInflight) return customersInflight;
  customersInflight = (async () => {
    try {
      const body = (await gwFetch("/api/external/customers/")) as Record<string, unknown> | null;
      const raw = Array.isArray(body?.customers) ? (body!.customers as Record<string, unknown>[]) : [];
      const rows = raw
        .map((c) => ({
          customerId: str(c.customer_id),
          name: str(c.customer_name),
          mccId: str(c.mcc_id),
          currency: str(c.currency_code).toUpperCase(),
          pixels: (Array.isArray(c.pixels) ? (c.pixels as unknown[]) : []).map(str).filter(Boolean),
          status: str(c.status).trim().toUpperCase(),
        }))
        .filter((c) => c.customerId)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      if (rows.length === 0) throw new GoogleWeaponError("google-weapon returned no customers", undefined, body);
      customersCache.entry = { at: Date.now(), value: rows };
      return rows;
    } finally {
      customersInflight = null;
    }
  })();
  return customersInflight;
}

/** A launch account taken off the pickers because it is not active on Google (LION's verdict). */
export type GwSuspendedCustomer = GoogleHiddenAccount;

/**
 * The launch catalog: the accounts the console OFFERS and ACCEPTS as targets — the owner's GLO-HS
 * list over the partner's full list, minus the ones that are not ENABLED on Google (owner ask
 * 21.09) — and the hidden ones by name, so a board can say what it hid and a route can refuse
 * with the reason. One catalog for the pickers AND the wave routes: "not shown" always means
 * "not launchable". The status is the `status` word google-weapon puts on every account of
 * `/customers/` (Google's CustomerStatus, since 25.09) — read live with the list, cached with it
 * (10 min); a row without one is hidden too. Nothing else is consulted (the campaign-derived
 * book of 21.09 is gone, owner call 25.09).
 */
export async function gwLaunchCatalog(): Promise<{ customers: GwCustomer[]; suspended: GwSuspendedCustomer[]; dead: GwSuspendedCustomer[] }> {
  return foldGoogleLaunchCatalog(await gwCustomers(), saoPauloDate(0), isGoogleLaunchAccount);
}

/** Just the launchable accounts of the catalog. Read-only lookups (a source's currency) keep gwCustomers. */
export async function gwLaunchableCustomers(): Promise<GwCustomer[]> {
  return (await gwLaunchCatalog()).customers;
}

export async function gwCustomerById(customerId: string): Promise<GwCustomer | null> {
  const all = await gwCustomers();
  return all.find((c) => c.customerId === customerId) ?? null;
}

// ---------- dataset ----------

export type GwDatasetFetchResult = { state: "ready" | "fetching"; fetchedAt: string | null };

/** Ensure the source is in the launch dataset: 200 cached → ready now; 202 → fetching (poll
 *  gwDatasetStatus). Throws GoogleWeaponError 404 "campaign not found" for ids LION never saw,
 *  400 when the campaign's MCC has no credentials on the platform. `force` re-snapshots. */
export async function gwDatasetFetch(campaignId: string, force = false): Promise<GwDatasetFetchResult> {
  const { status, body } = await gwFetchWithStatus("/api/external/dataset/fetch/", {
    method: "POST",
    body: JSON.stringify(force ? { campaign_id: campaignId, force: true } : { campaign_id: campaignId }),
  });
  const rec = (body ?? {}) as Record<string, unknown>;
  if (status === 200 && rec.cached) return { state: "ready", fetchedAt: rec.fetched_at ? str(rec.fetched_at) : null };
  if (status === 202 || rec.status === "fetching") return { state: "fetching", fetchedAt: null };
  // Any other 2xx is treated as "fetching" and confirmed by the status poll.
  return { state: "fetching", fetchedAt: null };
}

export async function gwDatasetStatus(campaignId: string): Promise<{ ready: boolean; fetchedAt: string | null }> {
  const body = (await gwFetch(`/api/external/dataset/status/?campaign_id=${encodeURIComponent(campaignId)}`)) as
    | Record<string, unknown>
    | null;
  return { ready: Boolean(body?.ready), fetchedAt: body?.fetched_at ? str(body.fetched_at) : null };
}

export type GwEnsureResult = GoogleEnsureResult;

/** Ensure a source is in the dataset and wait for it — the pure algorithm lives in
 *  lib/google-source.ts (ensureGoogleDataset, unit-tested); this binds the real I/O. */
export async function gwEnsureDataset(
  campaignId: string,
  opts: { maxWaitMs?: number; retryWaitMs?: number; pollMs?: number } = {},
): Promise<GwEnsureResult> {
  return ensureGoogleDataset(
    campaignId,
    {
      fetch: gwDatasetFetch,
      status: gwDatasetStatus,
      sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
      now: () => Date.now(),
    },
    opts,
  );
}

// ---------- launches (exactly-once) ----------

export type GwCloneBody = {
  source_campaign_id: string;
  customer_id?: string;
  /** Decimal string in the TARGET account currency ("30.00"). */
  budget: string;
  bid_strategy?: string;
  bid_value?: number;
  pixel?: string;
  name_suffix?: string;
};

export type GwJuroBody = {
  source_campaign_id: string;
  budget: string;
  bid_value?: number;
  pixel?: string;
  name_suffix?: string;
};

const taskIdOf = (body: unknown, what: string): string => {
  const rec = (body ?? {}) as Record<string, unknown>;
  const id = str(rec.taskId ?? rec.task_id);
  if (!id) throw new GoogleWeaponError(`google-weapon ${what} returned no taskId`, undefined, body);
  return id;
};

/** POST /clone/launch/ — ONE attempt, never re-sent (see gwFetch). */
export async function gwCloneLaunch(body: GwCloneBody): Promise<{ taskId: string }> {
  const res = await gwFetch("/api/external/clone/launch/", { method: "POST", body: JSON.stringify(body) }, 1);
  return { taskId: taskIdOf(res, "clone") };
}

/** POST /juro/launch/ — ONE attempt, never re-sent. */
export async function gwJuroLaunch(body: GwJuroBody): Promise<{ taskId: string }> {
  const res = await gwFetch("/api/external/juro/launch/", { method: "POST", body: JSON.stringify(body) }, 1);
  return { taskId: taskIdOf(res, "juro") };
}

/** Fresh Demand Gen launch body (built by lib/google-bid googleLaunchWire). */
export type GwLaunchBody = GoogleLaunchWire;

/** POST /campaign/launch/ — ONE attempt, never re-sent. */
export async function gwCampaignLaunch(body: GwLaunchBody): Promise<{ taskId: string }> {
  const res = await gwFetch("/api/external/campaign/launch/", { method: "POST", body: JSON.stringify(body) }, 1);
  return { taskId: taskIdOf(res, "launch") };
}

// ---------- tasks ----------

export type GwTask = {
  taskId: string;
  type: string;
  /** pending → running → completed | failed; "unknown" when the read itself failed. */
  status: string;
  campaignId: string | null;
  campaignName: string | null;
  error: string | null;
};

export async function gwTask(taskId: string): Promise<GwTask> {
  const body = (await gwFetch(`/api/external/tasks/${encodeURIComponent(taskId)}/`)) as Record<string, unknown> | null;
  const rec = body ?? {};
  return {
    taskId: str(rec.taskId ?? rec.task_id) || taskId,
    type: str(rec.type),
    status: str(rec.status).toLowerCase(),
    campaignId: rec.campaign_id ? str(rec.campaign_id) : null,
    campaignName: rec.campaign_name ? str(rec.campaign_name) : null,
    error: rec.error ? str(rec.error) : null,
  };
}

/** Read many tasks (≤ `limit` in flight). A per-id failure never sinks the batch — that task
 *  comes back as status "unknown" with the error text (404 = the id belongs to another user
 *  or never existed → the caller decides). */
export async function gwTasks(taskIds: string[], limit = 5): Promise<GwTask[]> {
  const out: GwTask[] = new Array(taskIds.length);
  let next = 0;
  const worker = async () => {
    while (next < taskIds.length) {
      const i = next++;
      const id = taskIds[i];
      try {
        out[i] = await gwTask(id);
      } catch (e) {
        const err = e instanceof GoogleWeaponError ? e : null;
        out[i] = {
          taskId: id,
          type: "",
          status: err?.status === 404 ? "not_found" : "unknown",
          campaignId: null,
          campaignName: null,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, taskIds.length) }, worker));
  return out;
}
