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

export type LionDuplicationResult = {
  result?: string;
  task_ids?: string[];
  reason?: string;
  campaign_id?: string;
};

/**
 * Clone ONE existing LION campaign into the picked binds (playbook-proven flow: duplicate →
 * creation-status → activate). `starting_budget` is integer CENTS of the account currency
 * (write-side convention). LION rebuilds the clone's name itself (re-dated prefix + "(CLONE)"
 * marker) and appends `name_suffix`. Preflight rejections (object-story creatives → "No valid
 * creative URL…") come back in duplication_results with a reason and create NOTHING.
 */
export async function lionDuplicate(args: {
  profile_slug: string;
  account_id: string;
  page_id: string;
  pixel_id: string;
  campaign_id: string;
  starting_budget: number;
  number_of_copies: number;
  name_suffix: string;
  /** META-NATIVE integer, forwarded to the Graph verbatim (same passthrough as create's `bid`,
   *  see lib/hs-launch hsWireBid): CENTS for cap sources, ROAS floor × 10000 for MIN_ROAS
   *  sources (0,34 → 3400). A human decimal here wedges the task at CREATING_ADSET (Meta
   *  "roas_average_floor … not valid" retry loop — live 08-10). Omitted = inherit the source's
   *  bid (the safe default). */
  starting_bid?: number;
  /** Full clone name (structured prefix + edited tail) — LION's own duplicator UI edits the
   *  whole name, so the field mirrors it; omitted = LION rebuilds the name itself. */
  name?: string;
}): Promise<LionDuplicationResult> {
  const body = (await lionPost("/api/facebook/campaigns/duplicate/", {
    profile_slug: args.profile_slug,
    account_id: args.account_id,
    page_id: args.page_id,
    pixel_id: args.pixel_id,
    campaigns: [
      {
        campaign_id: args.campaign_id,
        starting_budget: args.starting_budget,
        number_of_copies: args.number_of_copies,
        name_suffix: args.name_suffix,
        ...(args.starting_bid != null ? { starting_bid: args.starting_bid } : {}),
        ...(args.name ? { name: args.name } : {}),
      },
    ],
  })) as Record<string, unknown> | null;
  const results = Array.isArray(body?.duplication_results)
    ? (body!.duplication_results as LionDuplicationResult[])
    : [];
  if (results.length === 0) {
    throw new LionError("LION duplicate returned no duplication_results", undefined, body);
  }
  return results[0];
}

/** Flip one campaign's status. A clone's birth status is unpredictable (PAUSED in the morning,
 *  ACTIVE by afternoon — live 07-07), so the duplicate flow always activates after COMPLETED;
 *  re-activating an already-active campaign answers "Application does not have permission for
 *  this action", which is SUCCESS in disguise (playbook) — reported as alreadyActive. */
export async function lionSetCampaignStatus(
  campaignId: string,
  status: "ACTIVE" | "PAUSED",
): Promise<{ ok: boolean; alreadyActive?: boolean; message?: string }> {
  try {
    await lionPost(`/api/facebook/campaigns/${campaignId}/status/`, { status });
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/does not have permission/i.test(msg)) return { ok: true, alreadyActive: true };
    return { ok: false, message: msg };
  }
}

/** Today in LION's timezone (America/Sao_Paulo) as YYYY-MM-DD — the metrics date param. */
const saoPauloToday = (): string =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(),
  );

// campaign_bid map from metrics/ — the ONLY read that exposes a MIN_ROAS goal (details/ answers
// adset_bid:null for those). The payload is huge (tens of thousands of rows), so it's fetched
// lazily, kept as a slim id→bid map and cached 10 min.
let bidsCache: { at: number; map: Map<string, number> } | null = null;

async function lionMyBids(): Promise<Map<string, number>> {
  if (bidsCache && Date.now() - bidsCache.at < TTL_MS) return bidsCache.map;
  return dedupe("mybids", async () => {
    const body = (await lionGet(`/api/facebook/campaigns/metrics/?date=${saoPauloToday()}`)) as unknown;
    const rows = Array.isArray(body)
      ? (body as Record<string, unknown>[])
      : Array.isArray((body as Record<string, unknown> | null)?.campaigns)
        ? ((body as Record<string, unknown>).campaigns as Record<string, unknown>[])
        : [];
    const map = new Map<string, number>();
    for (const r of rows) {
      const bid = r.campaign_bid;
      if (typeof bid === "number" && bid > 0) map.set(String(r.campaign_id ?? ""), bid);
    }
    bidsCache = { at: Date.now(), map };
    return map;
  });
}

// Ads-per-fanpage tally — the HS "N/250" fill badge feed. LION has no per-page volume read, so
// the tally reduces today's metrics (the same multi-MB payload lionMyBids reads): every ACTIVE
// campaign contributes its ads to its page_id bucket. object_story_ids is 1:1 with the
// campaign's ads on this pool (verified live 08-13: 0 of 13.5k ACTIVE rows lacked it) — the
// max(1, …) floor covers a row that materializes before its stories do. Only campaigns this
// token's LION user sees are counted (the whole GLO-01 team — the dominant load on these
// pages), so like MO's tally backstop the number is an honest lower bound of what Meta's
// per-page limit meters. Cached slim (page → count), never the raw rows.
let pageVolumeCache: { at: number; counts: Record<string, number> } | null = null;

export async function lionPageAdCounts(): Promise<Record<string, number>> {
  if (pageVolumeCache && Date.now() - pageVolumeCache.at < TTL_MS) return pageVolumeCache.counts;
  return dedupe("pagevolume", async () => {
    const body = (await lionGet(`/api/facebook/campaigns/metrics/?date=${saoPauloToday()}`)) as unknown;
    const rows = Array.isArray(body)
      ? (body as Record<string, unknown>[])
      : Array.isArray((body as Record<string, unknown> | null)?.campaigns)
        ? ((body as Record<string, unknown>).campaigns as Record<string, unknown>[])
        : [];
    // An empty answer is a LION hiccup (or the São Paulo midnight reset), not "every page is
    // free" — throw so the client leaves badges off instead of painting believable zeros.
    if (rows.length === 0) throw new LionError("LION metrics returned no rows", undefined, null);
    const counts: Record<string, number> = {};
    for (const r of rows) {
      if (str(r.campaign_status) !== "ACTIVE") continue;
      const pid = str(r.page_id);
      if (!pid) continue;
      const stories = Array.isArray(r.object_story_ids) ? r.object_story_ids.length : 0;
      counts[pid] = (counts[pid] ?? 0) + Math.max(1, stories);
    }
    pageVolumeCache = { at: Date.now(), counts };
    return counts;
  });
}

export type LionSourceInfo = {
  campaignId: string;
  name: string;
  status: string;
  /** MAJOR units (dollars) — LION reads are major, writes are cents (asymmetry, verified live). */
  budget: number | null;
  /** Ad set bid as LION reports it — MAJOR/decimal like all LION reads (cap $2.45 reads as
   *  2.45, verified 08-12 details==metrics; MIN_ROAS goals are the ROAS decimal, e.g. 0.34).
   *  Null = none (lowest cost) or unknown. */
  bid: number | null;
  /** Campaign-level bid strategy (details/ carries it) — names the empty-bid case. */
  bidStrategy: string;
  adsCount: number;
  countries: string[];
};

/** Read source campaigns for the duplicator table: details/ (name, budget, adsets/ads) +
 *  targeting/ (countries), both answering {campaignsData:[…]} ARRAYS (form gotcha, verified
 *  07-13 — never index by campaign id). A source details/ can't read ("Campaign data not
 *  found") is reported with status "UNREADABLE" — its duplicate would die the same way. */
export async function lionSourceInfo(campaignIds: string[]): Promise<LionSourceInfo[]> {
  if (campaignIds.length === 0) return [];
  type DetailsRow = {
    campaign_id?: string | number;
    campaign_name?: string;
    campaign_status?: string;
    bid_strategy?: string;
    campaign_budget?: number;
    adsets?: Array<{ bid_amount?: number; adset_bid?: number; ads?: Array<Record<string, unknown>> }>;
  };
  type TargetingRow = { campaign_id?: string | number; countries_code?: string[]; countries?: string[] };
  const [detailsBody, targetingBody] = await Promise.all([
    lionPost("/api/facebook/campaigns/details/", { campaign_ids: campaignIds }) as Promise<Record<string, unknown> | null>,
    lionGet(`/api/facebook/campaigns/targeting/?campaign_ids=${encodeURIComponent(JSON.stringify(campaignIds))}`) as Promise<
      Record<string, unknown> | null
    >,
  ]);
  const details = Array.isArray(detailsBody?.campaignsData) ? (detailsBody!.campaignsData as DetailsRow[]) : [];
  const targeting = Array.isArray(targetingBody?.campaignsData)
    ? (targetingBody!.campaignsData as TargetingRow[])
    : [];
  const geoById = new Map(
    targeting.map((t) => [String(t.campaign_id ?? ""), (t.countries_code ?? t.countries ?? []).map(String)]),
  );
  const byId = new Map(details.map((d) => [String(d.campaign_id ?? ""), d]));
  const rows = campaignIds.map((cid) => {
    const d = byId.get(cid);
    if (!d) {
      return { campaignId: cid, name: "", status: "UNREADABLE", budget: null, bid: null, bidStrategy: "", adsCount: 0, countries: geoById.get(cid) ?? [] };
    }
    const adsets = Array.isArray(d.adsets) ? d.adsets : [];
    const bidRaw = adsets[0]?.bid_amount ?? adsets[0]?.adset_bid;
    return {
      campaignId: cid,
      name: String(d.campaign_name ?? ""),
      status: String(d.campaign_status ?? ""),
      budget: typeof d.campaign_budget === "number" ? d.campaign_budget : null,
      bid: typeof bidRaw === "number" ? bidRaw : null,
      bidStrategy: String(d.bid_strategy ?? ""),
      adsCount: adsets.reduce((s, a) => s + (Array.isArray(a.ads) ? a.ads.length : 0), 0),
      countries: geoById.get(cid) ?? [],
    };
  });
  // MIN_ROAS goals never appear in details/ — metrics' campaign_bid is the only read that has
  // them (verified live: 0.34/0.3/0.35 matched the weapon UI). Consulted only when needed.
  if (rows.some((r) => r.bid == null && r.status !== "UNREADABLE")) {
    try {
      const bids = await lionMyBids();
      for (const r of rows) {
        if (r.bid == null) {
          const b = bids.get(r.campaignId);
          if (b != null) r.bid = b;
        }
      }
    } catch {
      /* metrics down — bids stay null, the UI says "inherits" */
    }
  }
  return rows;
}

/** The one fact the duplicate route needs about a source before scaling a bid override: its
 *  bid strategy (campaign-level, details/ carries it). "" = source unreadable right now
 *  ("Campaign data not found" — known LION lag on fresh campaigns). Uncached: one submit-time
 *  read, and a stale answer here would mis-scale a bid 100×/10000×. */
export async function lionBidStrategy(campaignId: string): Promise<string> {
  try {
    const body = (await lionPost("/api/facebook/campaigns/details/", {
      campaign_ids: [campaignId],
    })) as Record<string, unknown> | null;
    const rows = Array.isArray(body?.campaignsData)
      ? (body!.campaignsData as Array<{ campaign_id?: string | number; bid_strategy?: string }>)
      : [];
    const row = rows.find((r) => String(r.campaign_id ?? "") === campaignId);
    return String(row?.bid_strategy ?? "");
  } catch {
    return "";
  }
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

export type LionCampaignReality = { status: string; adsCount: number };

/** Reality check behind the task manager's poll: does the campaign itself exist and carry ads?
 *  LION's creation-status record is NOT a reliable proxy for that — on WORLD creates its
 *  beneficiary retry loop keeps the record "creating" for 45+ min after the ads are live, and
 *  finished records get pruned to NOT_FOUND (both live 08-13) — while details/ reads the real
 *  tree. "UNREADABLE" = details answered nothing for the id (deleted, or the known fresh-campaign
 *  lag) — the caller keeps waiting rather than concluding anything from it. Uncached: callers
 *  throttle, and a stale answer here would mislabel a live launch. */
export async function lionCampaignAds(campaignIds: string[]): Promise<Record<string, LionCampaignReality>> {
  if (campaignIds.length === 0) return {};
  type Row = { campaign_id?: string | number; campaign_status?: string; adsets?: Array<{ ads?: unknown[] }> };
  const body = (await lionPost("/api/facebook/campaigns/details/", {
    campaign_ids: campaignIds,
  })) as Record<string, unknown> | null;
  const rows = Array.isArray(body?.campaignsData) ? (body!.campaignsData as Row[]) : [];
  const out: Record<string, LionCampaignReality> = {};
  for (const id of campaignIds) out[id] = { status: "UNREADABLE", adsCount: 0 };
  for (const r of rows) {
    const id = str(r.campaign_id);
    if (!id) continue;
    const adsets = Array.isArray(r.adsets) ? r.adsets : [];
    out[id] = {
      status: str(r.campaign_status),
      adsCount: adsets.reduce((s, a) => s + (Array.isArray(a.ads) ? a.ads.length : 0), 0),
    };
  }
  return out;
}
