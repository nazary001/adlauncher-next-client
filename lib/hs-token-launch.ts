// Server-only config + helpers for the HS "FB Token" launch rail: the same launch the LION
// create weapon performs, built directly on the Graph API with OUR partner-side user token
// instead of a LION anti-detect profile. The partner's rules for outside-the-weapon launches
// (their message, 08-17) are encoded here:
//   1. campaign names follow the exact LION-validated pattern (lib/hs-launch hsFullName);
//   2. campaigns land only in ad accounts a weapon-connected profile can see (the launch route
//      validates binds against LION's own profile catalog, same as the LION rail);
//   3. delivery starts ≥30 min after creation — their ingestion routines need the minutes to add
//      the campaign id to the reportable keys, so the ad set carries a future start_time.

import { createAdsetSelfHealing, fbGet, fbPost } from "./fb-graph";
import { uploadImage, uploadVideo, videoThumb, waitForVideo } from "./fb-media";

// The write token: FB_HS_LAUNCH_TOKEN when provisioned, else the FB_HS_VOLUME_TOKEN fallback —
// that is "Gcforhs2", the partner-side user with the ~30 VD-C1 pool accounts (the badge sweep
// proves it READS them; whether Meta lets it WRITE surfaces as a clear per-launch error, not a
// config failure). Server-only: neither token ever reaches the browser.
const HS_FB_TOKEN = process.env.FB_HS_LAUNCH_TOKEN || process.env.FB_HS_VOLUME_TOKEN || "";

export const hsTokenConfigured = (): boolean => HS_FB_TOKEN.length > 0;
/** Raw bearer for lib/clone-run's parameterized Graph calls (server-only, never to the browser). */
export const hsRawToken = (): string => HS_FB_TOKEN;

type Json = Record<string, unknown>;

/** Graph calls on the HS partner-side token — same client (backoff, budget, error mapping) as
 *  the MO rail, only the bearer differs. The media/adset helpers below bind the same token so
 *  the route never handles it directly. */
export const hsFbGet = (path: string): Promise<Json> => fbGet(path, HS_FB_TOKEN);
export const hsFbPost = (path: string, params: Json): Promise<Json> => fbPost(path, params, HS_FB_TOKEN);
export const hsUploadVideo = (accountId: string, fileUrl: string, name: string): Promise<string> =>
  uploadVideo(accountId, fileUrl, name, HS_FB_TOKEN);
export const hsUploadImage = (accountId: string, buf: Buffer): Promise<string> =>
  uploadImage(accountId, buf, HS_FB_TOKEN);
export const hsWaitForVideo = (videoId: string): Promise<void> => waitForVideo(videoId, undefined, HS_FB_TOKEN);
export const hsVideoThumb = (videoId: string): Promise<string> => videoThumb(videoId, HS_FB_TOKEN);
export const hsCreateAdset = (path: string, payload: Json): Promise<Json> =>
  createAdsetSelfHealing(path, payload, HS_FB_TOKEN);

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
