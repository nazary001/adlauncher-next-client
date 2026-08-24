// Server-only config + helpers for the HS "FB Token" launch rail: the same launch the LION
// create weapon performs, built directly on the Graph API with OUR partner-side user token
// instead of a LION anti-detect profile. The partner's rules for outside-the-weapon launches
// (their message, 08-17) are encoded here:
//   1. campaign names follow the exact LION-validated pattern (lib/hs-launch hsFullName);
//   2. campaigns land only in ad accounts a weapon-connected profile can see (the launch route
//      validates binds against LION's own profile catalog, same as the LION rail);
//   3. delivery starts ≥30 min after creation — their ingestion routines need the minutes to add
//      the campaign id to the reportable keys, so the ad set carries a future start_time.

import { createHash } from "node:crypto";
import { FbError, createAdsetSelfHealing, fbGet, fbPost, withFbAppLimitFailFast } from "./fb-graph";
import { type TokenHealthDelta, applyHealthDelta } from "./token-pool-guards";
import { uploadImage, uploadVideo, videoThumb, waitForVideo } from "./fb-media";
import { readAppCache, writeAppCache } from "./app-cache";

// ---- token POOL with automatic failover (owner ask 08-20, widened to 4 same day) ---------------
// FOUR bearers for the same partner-side user "Gcforhs2", each issued through a DIFFERENT FB app
// (probed live 08-20: T1 app + "GC for HS 2.1"/"2.2"/"2.4"; ad-account sets identical, 379 each).
// The (#4) "Application request limit" that stormed the rail on 08-20 is APP-level, so the pool
// rotates T1→T2→T3→T4 by health: a burned app's bearer is skipped/failed-over mid-call and comes
// back when its cooldown lifts. Same user ⇒ zero permission drift: objects created by one token
// are fully manageable by any other. Server-only: no token ever reaches the browser (the status
// endpoint ships fingerprints only).
const RAW_TOKENS = [
  process.env.FB_HS_LAUNCH_TOKEN || process.env.FB_HS_VOLUME_TOKEN || "",
  process.env.FB_HS_LAUNCH_TOKEN_2 || "",
  process.env.FB_HS_LAUNCH_TOKEN_3 || "",
  process.env.FB_HS_LAUNCH_TOKEN_4 || "",
];

export type HsPoolToken = { token: string; fp: string; index: number };
const POOL: HsPoolToken[] = [];
{
  const seen = new Set<string>();
  for (const t of RAW_TOKENS) {
    if (!t || seen.has(t)) continue;
    seen.add(t);
    POOL.push({ token: t, fp: createHash("sha256").update(t).digest("hex").slice(0, 12), index: POOL.length + 1 });
  }
}

export const hsTokenConfigured = (): boolean => POOL.length > 0;

// Health = per-token cooldown marks in the SHARED app-cache row (Strapi), so every serverless
// instance — and the header's status widget — sees the same failover state. Keyed by token
// FINGERPRINT (sha256 prefix), never by the token itself. Module L1 keeps reads cheap.
type TokenHealth = { limitedUntil: number; reason: string };
type HealthRow = {
  health: Record<string, TokenHealth>;
  /** Resolved display identities ({user, app} per fingerprint) — written once by the prober. */
  names: Record<string, { user?: string; app?: string }>;
};
const HEALTH_KEY = "hs-token-health";
const HEALTH_L1_MS = 20_000;
/** A 429 thrown through fbGet/fbPost's OWN retry ladder = the limit is sustained, not a blip. */
const FAILURE_COOLDOWN_MS = 30 * 60_000;
/** OAuth-dead token (code 190: expired/deauthorized) — park it long; the prober keeps checking. */
const DEAD_COOLDOWN_MS = 6 * 60 * 60_000;

let healthL1: { at: number; row: HealthRow; docId: string | null } | null = null;

const emptyRow = (): HealthRow => ({ health: {}, names: {} });

async function readHealth(maxAgeMs: number = HEALTH_L1_MS): Promise<{ row: HealthRow; docId: string | null }> {
  if (healthL1 && Date.now() - healthL1.at < maxAgeMs) return healthL1;
  try {
    const r = await readAppCache<HealthRow>(HEALTH_KEY);
    const v = r?.value;
    healthL1 = {
      at: Date.now(),
      row: v && typeof v === "object" ? { ...emptyRow(), ...v, health: v.health ?? {}, names: v.names ?? {} } : emptyRow(),
      docId: r?.documentId ?? null,
    };
  } catch {
    // Store unreachable → run on whatever this instance already knows (fail open).
    healthL1 = { at: Date.now(), row: healthL1?.row ?? emptyRow(), docId: healthL1?.docId ?? null };
  }
  return healthL1;
}

/** Apply one typed delta on a FRESH read of the shared row (L1 bypassed): the old blind
 *  read-modify-write over a ≤20s-stale snapshot let two instances marking DIFFERENT tokens
 *  clobber each other's whole-row PUTs (last write wins) — a genuinely limited token popped
 *  back "healthy" and got picked again. applyHealthDelta merges monotonically (a stale mark
 *  never shortens a stored cooldown), so racing writers converge instead. */
async function writeHealth(delta: TokenHealthDelta): Promise<void> {
  const { row, docId } = await readHealth(0);
  const next = applyHealthDelta(row, delta);
  healthL1 = { at: Date.now(), row: next, docId };
  try {
    const id = await writeAppCache(HEALTH_KEY, next, docId);
    if (id) healthL1.docId = id;
  } catch {
    /* store blip — the L1 mark still steers THIS instance; others learn via their own failures */
  }
}

export const hsMarkTokenLimited = (fp: string, reason: string, cooldownMs = FAILURE_COOLDOWN_MS): Promise<void> =>
  writeHealth({ kind: "mark", fp, mark: { limitedUntil: Date.now() + cooldownMs, reason: reason.slice(0, 200) } });

export const hsClearTokenLimited = (fp: string): Promise<void> => writeHealth({ kind: "clear", fp });

export const hsRememberTokenNames = (fp: string, names: { user?: string; app?: string }): Promise<void> =>
  writeHealth({ kind: "names", fp, names });

export type HsTokenState = {
  index: number;
  fp: string;
  user: string;
  app: string;
  limitedUntil: number;
  reason: string;
};

/** Shared-row snapshot for the status endpoint (no probing here — see /api/hs/token-status). */
export async function hsTokenHealthSnapshot(): Promise<HsTokenState[]> {
  const { row } = await readHealth();
  const now = Date.now();
  return POOL.map((t) => {
    const h = row.health[t.fp];
    const limited = h && h.limitedUntil > now ? h : null;
    return {
      index: t.index,
      fp: t.fp,
      user: row.names[t.fp]?.user ?? "",
      app: row.names[t.fp]?.app ?? "",
      limitedUntil: limited?.limitedUntil ?? 0,
      reason: limited?.reason ?? "",
    };
  });
}

/** Pool entries for the prober (server-only caller — the raw bearer stays inside lib/ + routes). */
export const hsPoolTokens = (): HsPoolToken[] => [...POOL];

/** Next-call order: healthy tokens first in configured priority (T1 → T2), cooled-down ones
 *  last by soonest expiry — an expired cooldown gets retried naturally and clears on success. */
async function orderedPool(): Promise<{ t: HsPoolToken; limited: boolean }[]> {
  const { row } = await readHealth();
  const now = Date.now();
  const entries = POOL.map((t) => ({ t, limited: (row.health[t.fp]?.limitedUntil ?? 0) > now }));
  return [
    ...entries.filter((e) => !e.limited),
    ...entries
      .filter((e) => e.limited)
      .sort((a, b) => (row.health[a.t.fp]?.limitedUntil ?? 0) - (row.health[b.t.fp]?.limitedUntil ?? 0)),
  ];
}

/** The bearer the next call would use — for callers that need a RAW token (media migration). */
export async function hsActiveToken(): Promise<string> {
  const order = await orderedPool();
  if (order.length === 0) throw new FbError("no_hs_token", null, 500);
  return order[0].t.token;
}

/** Rate-limit answer that survived the client's whole retry ladder (fbGet/fbPost map those to
 *  HTTP 429) — the failover trigger. */
const isRateLimitErr = (e: unknown): boolean => e instanceof FbError && e.status === 429;
/** Token itself is dead (OAuth 190: expired/deauthorized/checkpointed user session). */
const isDeadTokenErr = (e: unknown): boolean =>
  e instanceof FbError && (e.detail as { error?: { code?: number } } | null)?.error?.code === 190;

/**
 * Run one Graph call through the pool: try tokens in health order; a sustained rate limit or a
 * dead token marks the bearer (shared row) and the SAME call retries on the next one — the
 * calling launch never notices beyond the latency. Any other error is the call's own problem
 * and propagates untouched (failing over would just repeat it). A token that answers fine while
 * still inside a cooldown mark heals the mark early.
 */
async function poolCall<T>(fn: (token: string) => Promise<T>): Promise<T> {
  const order = await orderedPool();
  if (order.length === 0) throw new FbError("no_hs_token", null, 500);
  let lastErr: unknown = null;
  for (const { t, limited } of order) {
    try {
      // Fail-fast armed: an APP-level limit — (#4)/(#17), what a different app's bearer escapes —
      // throws its 429 on the first sighting instead of riding the retry ladder on the burned
      // app, so the failover below happens in milliseconds. Account-scoped throttles keep the
      // ladder inside the call (rotating bearers cannot help those).
      const out = await withFbAppLimitFailFast(() => fn(t.token));
      if (limited) void hsClearTokenLimited(t.fp);
      return out;
    } catch (e) {
      if (isRateLimitErr(e)) {
        await hsMarkTokenLimited(t.fp, (e as FbError).message || "rate limited", FAILURE_COOLDOWN_MS);
        lastErr = e;
        continue;
      }
      if (isDeadTokenErr(e)) {
        await hsMarkTokenLimited(t.fp, `token dead: ${(e as FbError).message || "OAuth 190"}`, DEAD_COOLDOWN_MS);
        lastErr = e;
        continue;
      }
      throw e;
    }
  }
  // EVERY bearer answered a sustained limit (or is dead) for this one call — surface it as the
  // pool-wide condition, not the last token's raw message; the gate keeps NEW launches from
  // firing while this holds, and cooldown expiry / the prober re-open the pool automatically.
  if (lastErr instanceof FbError && lastErr.status === 429) {
    throw new FbError(
      "all_hs_tokens_limited — every FB launch token is rate-limited right now; the pool re-opens after a cooldown (watch the Tokens widget)",
      lastErr.detail,
      429,
    );
  }
  throw (lastErr as Error) ?? new FbError("no_hs_token", null, 500);
}

/**
 * Pre-flight gate for the token-rail routes: may a NEW launch/duplicate start right now?
 * Healthy token in the pool → yes. All bearers marked → one probe pass (raw, cheap, 30s-cached)
 * checks whether a limit already lifted — a healed token clears its mark and the gate opens; if
 * every token is STILL burned, the gate refuses with the soonest retry time, so waves die as a
 * clean 429 BEFORE any row is stamped or campaign shell created (owner ask 08-20: when both
 * tokens are exhausted, launches must be blocked with an explicit "tokens are out" error).
 */
export async function hsTokenGate(): Promise<{ ok: true } | { ok: false; error: string; retryAt: number }> {
  if (POOL.length === 0) return { ok: false, error: "hs_fb_token_missing", retryAt: 0 };
  const now = Date.now();
  const { row } = await readHealth();
  if (POOL.some((t) => (row.health[t.fp]?.limitedUntil ?? 0) <= now)) return { ok: true };
  await hsProbeTokenHealth(); // maybe a limit already lifted — the probe clears healed marks
  const { row: after } = await readHealth();
  if (POOL.some((t) => (after.health[t.fp]?.limitedUntil ?? 0) <= Date.now())) return { ok: true };
  const retryAt = Math.min(...POOL.map((t) => after.health[t.fp]?.limitedUntil ?? Date.now()));
  const mins = Math.max(1, Math.ceil((retryAt - Date.now()) / 60_000));
  return {
    ok: false,
    retryAt,
    error: `all_hs_tokens_limited — ${POOL.length === 1 ? "the FB launch token is" : `all ${POOL.length} FB launch tokens are`} rate-limited/dead right now; launches are blocked for ~${mins} min (the pool re-opens automatically — watch the Tokens widget in the header)`,
  };
}

// ---- health prober (feeds /api/hs/token-status and the header widget) --------------------------
// One RAW single-shot `GET /me` per token (no retry ladder — a health check must answer in
// seconds), cached briefly so many open tabs don't multiply Graph calls. Besides reporting, the
// prober STEERS the pool: a probe that sees the rate limit marks the token (short sliding
// cooldown, refreshed every poll while the limit persists), so launches skip the burned token
// without ever paying the ladder latency; a probe that sees it healthy again clears the mark.
const PROBE_TTL_MS = 30_000;
const PROBE_COOLDOWN_MS = 10 * 60_000;
const PROBE_RATE_CODES = new Set([4, 17, 613, 80004, 80014]);

export type HsTokenProbe = HsTokenState & { state: "ok" | "limited" | "dead"; active: boolean };

let probeCache: { at: number; states: HsTokenProbe[] } | null = null;

export async function hsProbeTokenHealth(): Promise<HsTokenProbe[]> {
  if (probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) return probeCache.states;
  const states: (HsTokenState & { state: "ok" | "limited" | "dead" })[] = [];
  for (const t of POOL) {
    let state: "ok" | "limited" | "dead" = "ok";
    let probeReason = "";
    try {
      const res = await fetch(`https://graph.facebook.com/v21.0/me?fields=id,name`, {
        headers: { Authorization: `Bearer ${t.token}` },
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      });
      const body = (await res.json().catch(() => ({}))) as {
        id?: string;
        name?: string;
        error?: { code?: number; message?: string; is_transient?: boolean };
      };
      if (body.error) {
        const code = body.error.code ?? 0;
        probeReason = `(#${code}) ${body.error.message ?? ""}`.trim();
        if (PROBE_RATE_CODES.has(code) || body.error.is_transient === true) {
          state = "limited";
          await hsMarkTokenLimited(t.fp, probeReason, PROBE_COOLDOWN_MS);
        } else {
          // 190 = dead session; anything else unexpected is equally unusable for launches.
          state = "dead";
          await hsMarkTokenLimited(t.fp, probeReason, code === 190 ? DEAD_COOLDOWN_MS : PROBE_COOLDOWN_MS);
        }
      } else if (body.id) {
        const { row } = await readHealth();
        if ((row.health[t.fp]?.limitedUntil ?? 0) > Date.now()) await hsClearTokenLimited(t.fp);
        if (!row.names[t.fp]?.user || !row.names[t.fp]?.app) {
          // Resolve display identity once: the user behind the bearer + the APP it was issued
          // through (the (#4) limit is app-level — the app name IS the meaningful label).
          let app = row.names[t.fp]?.app ?? "";
          try {
            const ares = await fetch(`https://graph.facebook.com/v21.0/app?fields=name`, {
              headers: { Authorization: `Bearer ${t.token}` },
              cache: "no-store",
              signal: AbortSignal.timeout(8_000),
            });
            const abody = (await ares.json().catch(() => ({}))) as { name?: string };
            if (abody.name) app = String(abody.name);
          } catch {
            /* name resolution is decoration */
          }
          await hsRememberTokenNames(t.fp, { user: String(body.name ?? ""), ...(app ? { app } : {}) });
        }
      }
    } catch {
      probeReason = "probe timeout"; // network blip — report, but never mark on it
    }
    const { row } = await readHealth();
    const h = row.health[t.fp];
    const limited = h && h.limitedUntil > Date.now() ? h : null;
    states.push({
      index: t.index,
      fp: t.fp,
      user: row.names[t.fp]?.user ?? "",
      app: row.names[t.fp]?.app ?? "",
      limitedUntil: limited?.limitedUntil ?? 0,
      reason: limited?.reason || probeReason,
      state: limited ? state === "dead" ? "dead" : "limited" : state,
    });
  }
  // "active" = the token the next launch call would actually pick (orderedPool's head).
  const firstOk = states.findIndex((s) => s.state === "ok");
  const activeIdx =
    firstOk >= 0
      ? firstOk
      : states.reduce((best, s, i) => (s.limitedUntil < (states[best]?.limitedUntil ?? Infinity) ? i : best), 0);
  const out = states.map((s, i) => ({ ...s, active: i === activeIdx }));
  probeCache = { at: Date.now(), states: out };
  return out;
}

type Json = Record<string, unknown>;

/** Graph calls on the HS partner-side token pool — same client (backoff, budget, error mapping)
 *  as the MO rail, with transparent T1→T2 failover per call. The media/adset helpers below ride
 *  the same pool so the routes never handle a bearer directly. */
export const hsFbGet = (path: string): Promise<Json> => poolCall((tok) => fbGet(path, tok));
export const hsFbPost = (path: string, params: Json): Promise<Json> => poolCall((tok) => fbPost(path, params, tok));
export const hsUploadVideo = (accountId: string, fileUrl: string, name: string): Promise<string> =>
  poolCall((tok) => uploadVideo(accountId, fileUrl, name, tok));
export const hsUploadImage = (accountId: string, buf: Buffer): Promise<string> =>
  poolCall((tok) => uploadImage(accountId, buf, tok));
export const hsWaitForVideo = (videoId: string): Promise<void> =>
  poolCall((tok) => waitForVideo(videoId, undefined, tok));
export const hsVideoThumb = (videoId: string): Promise<string> => poolCall((tok) => videoThumb(videoId, tok));
export const hsCreateAdset = (path: string, payload: Json): Promise<Json> =>
  poolCall((tok) => createAdsetSelfHealing(path, payload, tok));

/**
 * Best-effort bounded pause of a token-rail campaign whose build just failed: the tree is born
 * ACTIVE with only the +30 min start gap between a partial failure and unattended delivery.
 * Bounded — the failure is often the throttle itself, so the pause attempt must not hang the
 * pump on its own retry ladder; past the window the caller reports "not confirmed" honestly.
 */
export async function hsPauseCampaign(campaignId: string, confirmMs = 20_000): Promise<boolean> {
  try {
    return await Promise.race([
      hsFbPost(String(campaignId), { status: "PAUSED" }).then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), confirmMs)),
    ]);
  } catch {
    return false;
  }
}

// ---- Token-visible ad accounts ----------------------------------------------------------------
// The partner's park is bigger than what they share to our token user: LION profiles bind whole
// segments (e.g. the FARM profiles carry the HR_GC-HS-aleph-* accounts, 08-19) that Gcforhs2 has
// never been granted — a launch there passes the LION bind check and then dies on the first Graph
// POST with "Unsupported post request". This sweep is the ground truth the pickers and the token
// routes filter against. Cached like LION's profile data; null = sweep unavailable (callers fail
// OPEN — the Graph error itself is then the backstop, exactly the pre-filter behaviour).

const ACCT_CACHE_MS = 10 * 60_000;
let acctCache: { at: number; ids: Set<string> } | null = null;
let acctInflight: Promise<Set<string> | null> | null = null;

/** Digit ids of every ad account the HS token can act on (act_ stripped), or null when the
 *  sweep fails. One Graph pagination per 10 min across all callers. */
export function hsTokenAccountIds(): Promise<Set<string> | null> {
  if (acctCache && Date.now() - acctCache.at < ACCT_CACHE_MS) return Promise.resolve(acctCache.ids);
  if (acctInflight) return acctInflight;
  acctInflight = (async () => {
    try {
      const ids = new Set<string>();
      let after = "";
      for (let i = 0; i < 20; i++) {
        const body = await hsFbGet(`me/adaccounts?fields=account_id&limit=500${after ? `&after=${encodeURIComponent(after)}` : ""}`);
        for (const row of (body.data as { account_id?: unknown }[] | undefined) ?? []) {
          if (row?.account_id) ids.add(String(row.account_id));
        }
        const paging = body.paging as { next?: string; cursors?: { after?: string } } | undefined;
        after = paging?.next && paging.cursors?.after ? String(paging.cursors.after) : "";
        if (!after) break;
      }
      acctCache = { at: Date.now(), ids };
      return ids;
    } catch {
      return null; // transient Graph failure — no negative cache, next caller retries
    } finally {
      acctInflight = null;
    }
  })();
  return acctInflight;
}

/** Partner rule: token-rail campaigns must not start delivering for ~30 minutes after creation
 *  ("we always launch the campaigns with a 30 min gap … it takes some minutes for our routines
 *  to add the campaign id to the reportable keys"). The LION rail needs no gap here — the weapon
 *  applies its own. */
export const HS_TOKEN_START_GAP_MIN = 30;

/** Ad-set start_time honoring the partner's 30-min ingestion gap (ISO, Graph-native). */
export function hsTokenStartTime(now: Date = new Date()): string {
  return new Date(now.getTime() + HS_TOKEN_START_GAP_MIN * 60_000).toISOString();
}

/** One creative for a token-rail launch. The kind decides the Graph path (advideos vs adimages),
 *  so the client sends it explicitly — a bare URL doesn't reveal it. */
export type HsTokenCreative = {
  url: string;
  kind: "video" | "image";
  name?: string;
  /** Custom cover image for a VIDEO creative (own-Blob URL) — pinned as the ad's thumbnail. */
  cover?: string;
};

const isHttpsUrl = (v: string): boolean => /^https:\/\/\S+$/i.test(v);

/** Our own Blob-broker uploads only — the same SSRF fence as the MO launch route: this server
 *  fetches IMAGE bytes itself, so it must never be pointed at an arbitrary host. */
export function isOwnBlobUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname.endsWith(".blob.vercel-storage.com") && u.pathname.startsWith("/creatives/");
  } catch {
    return false;
  }
}

// The LION create weapon takes up to 50 creative URLs and chews on them for as long as it needs;
// this rail builds the whole tree inside one serverless window (maxDuration 300s, FB budget 240s),
// and each VIDEO needs its Meta-side processing waited out. 10 is what provably fits with the
// 3-wide processing pool; bigger decks go through the LION rail.
export const HS_TOKEN_MAX_CREATIVES = 10;

/**
 * Parse + validate the wire creatives array. Returns the clean list or a machine-friendly error
 * string (mirrors the launch guards' style). Videos may live on any https host — Meta fetches
 * those bytes itself, exactly as it does for LION's URLs. Images must be OUR Blob uploads: the
 * route downloads them server-side, and an arbitrary URL there would be an SSRF hole.
 */
export function parseTokenCreatives(raw: unknown): { creatives: HsTokenCreative[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "creatives_required" };
  if (raw.length > HS_TOKEN_MAX_CREATIVES) {
    return { error: `too_many_creatives — the FB Token rail builds at most ${HS_TOKEN_MAX_CREATIVES} ads per campaign; use the LION rail for bigger decks` };
  }
  const creatives: HsTokenCreative[] = [];
  for (const item of raw as unknown[]) {
    const o = (item ?? {}) as Record<string, unknown>;
    const url = typeof o.url === "string" ? o.url.trim() : "";
    const kind = o.kind === "image" ? "image" : o.kind === "video" ? "video" : null;
    if (!kind) return { error: "creative_kind_invalid" };
    if (!isHttpsUrl(url)) return { error: "creative_url_invalid" };
    if (kind === "image" && !isOwnBlobUrl(url)) {
      return { error: "image_url_not_allowed — paste-URL images can't ride the FB Token rail (drop the file instead, or use the LION rail)" };
    }
    const name = typeof o.name === "string" ? o.name.slice(0, 120) : "";
    // Optional custom cover: fetched server-side into adimages, so it gets the SAME fence as
    // image creatives — only a Blob our broker produced. Meaningful for videos only.
    const cover = typeof o.cover === "string" ? o.cover.trim() : "";
    if (cover) {
      if (kind !== "video") return { error: "cover_on_image — covers apply to video creatives only" };
      if (!isHttpsUrl(cover) || !isOwnBlobUrl(cover)) {
        return { error: "cover_url_not_allowed — the cover must be uploaded through the launcher" };
      }
    }
    creatives.push({ url, kind, ...(name ? { name } : {}), ...(cover ? { cover } : {}) });
  }
  return { creatives };
}
