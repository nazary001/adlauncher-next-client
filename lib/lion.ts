// Server-only client for the LION REST API (HS partner launches). One place holds the base URL,
// the bearer token, the retry policy and the read caches — routes stay thin.

const BASE = (process.env.LION_BASE || "https://lion.highstakes.tech").replace(/\/+$/, "");
const TOKEN = process.env.LION_TOKEN ?? "";
/** Media-buyer acronym bound to the token's LION user. Campaign names must carry it — LION
 *  rejects a mismatched `(ACR)` segment, so it is configuration, not user input. */
export const LION_ACR = process.env.LION_ACR ?? "";

export class LionError extends Error {
  status?: number;
  detail?: unknown;
  constructor(message: string, status?: number, detail?: unknown) {
    super(message);
    this.name = "LionError";
    this.status = status;
    this.detail = detail;
  }
}

export const lionConfigured = (): boolean => Boolean(TOKEN && LION_ACR);

/** Fetch with auth + one retry on network errors / 5xx (LION lags routinely per live memory).
 *  4xx bodies are surfaced verbatim — they carry the actionable reason. */
async function lionFetch(path: string, init?: RequestInit): Promise<unknown> {
  if (!TOKEN) throw new LionError("LION_TOKEN is not configured");
  const url = `${BASE}${path}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
        cache: "no-store",
      });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text; // LION sends some errors as plain text (e.g. 404 with a sentence)
      }
      if (res.ok) return body;
      if (res.status >= 500 && attempt === 0) {
        lastErr = new LionError(`LION ${res.status}`, res.status, body);
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      const msg =
        typeof body === "string" && body
          ? body.slice(0, 300)
          : ((body as Record<string, unknown> | null)?.error as string) || `LION HTTP ${res.status}`;
      throw new LionError(msg, res.status, body);
    } catch (e) {
      if (e instanceof LionError && e.status && e.status < 500) throw e;
      lastErr = e;
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new LionError(String(lastErr));
}

export const lionGet = (path: string): Promise<unknown> => lionFetch(path);
export const lionPost = (path: string, body: unknown): Promise<unknown> =>
  lionFetch(path, { method: "POST", body: JSON.stringify(body) });

// ---------- typed reads (cached) ----------

export type LionAccount = { id: string; name: string; currency: string; status: number };
export type LionPage = { id: string; name: string };
export type LionLocale = { id: number; name: string };
export type LionPixel = { id: string; name: string };
export type LionProfileData = { accounts: LionAccount[]; pages: LionPage[]; locales: LionLocale[] };

type CacheEntry<T> = { at: number; value: T };
const TTL_MS = 10 * 60_000;

// Module caches are per-instance (fine locally; on Vercel a cold start just re-fetches).
const profilesCache: { entry?: CacheEntry<string[]> } = {};
const profileDataCache = new Map<string, CacheEntry<LionProfileData>>();
const pixelsCache = new Map<string, CacheEntry<LionPixel[]>>();
// De-dupe concurrent fetches of the same key (several cards ensure the same profile at once).
const inflight = new Map<string, Promise<unknown>>();

function dedupe<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const p = run().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

const fresh = <T>(e: CacheEntry<T> | undefined): T | undefined =>
  e && Date.now() - e.at < TTL_MS ? e.value : undefined;

const str = (v: unknown): string => (v == null ? "" : String(v));

/** Profile slugs the token can operate on. Display names are dropped (double-encoded cyrillic —
 *  slugs are the clean, stable identifier). */
export async function lionProfiles(): Promise<string[]> {
  const cached = fresh(profilesCache.entry);
  if (cached) return cached;
  return dedupe("profiles", async () => {
    const body = (await lionGet("/api/facebook/profiles/list/")) as Record<string, unknown> | null;
    const raw = Array.isArray(body?.profiles) ? (body!.profiles as Record<string, unknown>[]) : [];
    const slugs = raw.map((p) => str(p.slug)).filter(Boolean).sort();
    if (slugs.length === 0) throw new LionError("LION returned no profiles", undefined, body);
    profilesCache.entry = { at: Date.now(), value: slugs };
    return slugs;
  });
}

/** A profile's accounts, pages and locales (the create/ bind space). Heavy (hundreds of
 *  accounts) → cached 10 min per slug. */
export async function lionProfileData(slug: string): Promise<LionProfileData> {
  const cached = fresh(profileDataCache.get(slug));
  if (cached) return cached;
  return dedupe(`data:${slug}`, async () => {
    const body = (await lionGet(
      `/api/facebook/profile/data/?profile_slug=${encodeURIComponent(slug)}`,
    )) as Record<string, unknown> | null;
    const data = (body?.data ?? body ?? {}) as Record<string, unknown>;
    const accounts = (Array.isArray(data.accounts) ? (data.accounts as Record<string, unknown>[]) : []).map(
      (a) => ({ id: str(a.id), name: str(a.name), currency: str(a.currency), status: Number(a.status ?? 0) }),
    );
    const pages = (Array.isArray(data.pages) ? (data.pages as Record<string, unknown>[]) : []).map((p) => ({
      id: str(p.id),
      name: str(p.name),
    }));
    const locales = (Array.isArray(data.locales) ? (data.locales as Record<string, unknown>[]) : []).map(
      (l) => ({ id: Number(l.id ?? 0), name: str(l.name) }),
    );
    if (accounts.length === 0 && pages.length === 0) {
      throw new LionError(`LION returned no data for profile "${slug}"`, undefined, body);
    }
    const value: LionProfileData = { accounts, pages, locales };
    profileDataCache.set(slug, { at: Date.now(), value });
    return value;
  });
}

/** Pixels of one ad account under a profile. */
export async function lionAccountPixels(slug: string, accountId: string): Promise<LionPixel[]> {
  const key = `${slug}|${accountId}`;
  const cached = fresh(pixelsCache.get(key));
  if (cached) return cached;
  return dedupe(`px:${key}`, async () => {
    const body = (await lionGet(
      `/api/facebook/profile/account/pixels/?profile_slug=${encodeURIComponent(slug)}&account_id=${encodeURIComponent(accountId)}`,
    )) as unknown;
    // Tolerant shape read: {pixels:[…]} | {data:[…]} | bare array; entries {id,name} | {pixel_id,…}.
    const rec = (body ?? {}) as Record<string, unknown>;
    const rawList = Array.isArray(body) ? (body as unknown[]) : (rec.pixels ?? rec.data ?? []);
    const pixels = (Array.isArray(rawList) ? (rawList as Record<string, unknown>[]) : []).map((p) => ({
      id: str(p.id ?? p.pixel_id),
      name: str(p.name ?? p.pixel_name) || str(p.id ?? p.pixel_id),
    }));
    const value = pixels.filter((p) => p.id);
    pixelsCache.set(key, { at: Date.now(), value });
    return value;
  });
}

// ---------- writes ----------

export type LionCreateResult = { result: string; task_id?: string; reason?: string; campaign_name?: string };

/** Submit ONE campaign-create task. The caller builds the campaign object (lib/hs-launch). */
export async function lionCreateCampaign(binds: {
  profile_slug: string;
  account_id: string;
  page_id: string;
  pixel_id: string;
  campaign: Record<string, unknown>;
}): Promise<LionCreateResult> {
  const body = (await lionPost("/api/facebook/campaigns/create/", {
    profile_slug: binds.profile_slug,
    account_id: binds.account_id,
    page_id: binds.page_id,
    pixel_id: binds.pixel_id,
    campaigns: [binds.campaign],
  })) as Record<string, unknown> | null;
  const results = Array.isArray(body?.creation_results)
    ? (body!.creation_results as LionCreateResult[])
    : [];
  if (results.length === 0) {
    throw new LionError("LION create returned no creation_results", undefined, body);
  }
  return results[0];
}

export type LionTaskStatus = {
  task_id: string;
  campaign_id?: string | null;
  adset_id?: string | null;
  ad_ids?: string[];
  campaign_name?: string | null;
  status: string;
  error?: { message?: string; method?: string; date?: string } | null;
};

/** Creation progress of previously submitted tasks. */
export async function lionCreationStatus(taskIds: string[]): Promise<LionTaskStatus[]> {
  if (taskIds.length === 0) return [];
  const body = (await lionPost("/api/facebook/campaigns/creation-status/", {
    task_ids: taskIds,
  })) as Record<string, unknown> | null;
  return Array.isArray(body?.tasks) ? (body!.tasks as LionTaskStatus[]) : [];
}
