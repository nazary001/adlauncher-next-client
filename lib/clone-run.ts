// Server-side clone builder. Given a buyer's per-clone edits + the source campaign id, re-fetches
// the source's full structure from Facebook and assembles the campaign/adset/creative/ad payloads
// for a faithful PAUSED duplicate — reusing the launch payload builders so the FB shape matches the
// launcher exactly. The creative is rebuilt from the source's own media — video_data for video ads,
// link_data for static image ads (same asset, copy, title, CTA) — with only the gcm swapped in the
// tracking link.

import { type Campaign, bidKind, makeCampaign } from "./types";
import type { CloneEdit } from "./clone";
import { FbError, fbGet, fbPost } from "./fb-graph";
import { adPayload, adsetPayload, campaignPayload, type LaunchBinds } from "./fb-launch";
// TOOL channel (owner ask 28.09) — type-only: the wire shapes the extractors below emit, consumed by
// lib/tool-launch's buildToolCampaign / runToolMedia. No runtime coupling to that leaf.
import type { ToolMediaItem, ToolMediaRefOut } from "./tool-launch";

type Json = Record<string, unknown>;

/** The source ad's reusable creative media. Video ads carry a video_data-shaped object (video_id/
 *  message/title/cta/image); static image ads carry a link_data-shaped one (link/image_hash/message/
 *  name/description/cta). The clone rebuilds the same creative kind. */
export type SourceMedia = { kind: "video"; data: Json } | { kind: "image"; data: Json };

/** What the run needs from the source campaign to rebuild a faithful clone. */
export type SourceDetail = {
  objective: string;
  specialCategories: string[];
  bidStrategy: string;
  optimizationGoal: string;
  conversionEvent: string;
  /** The source's OWN ad account (digits) — the DEFAULT build location: reused media
   *  (video_id / image_hash) is an account-library asset, invalid in any other account.
   *  Cloning into a different account requires migrateMediaToAccount() first. */
  accountId: string;
  /** The source adset's promoted pixel (empty when it optimizes for clicks / has none). */
  pixelId: string;
  /** First reusable media found on the source's ads (video preferred), null when none. */
  media: SourceMedia | null;
};

const SRC_FIELDS = [
  "account_id",
  "objective",
  "special_ad_categories",
  // Campaign-budget (CBO) sources carry the bid strategy on the CAMPAIGN; legacy ad-set-budget
  // sources carry it on the ad set. Read both and prefer the campaign's (see fetchSourceDetail).
  "bid_strategy",
  "adsets.limit(1){bid_strategy,optimization_goal,promoted_object}",
  // Read several ads + both places a video can live: inline video_data, and the asset_feed_spec that
  // Advantage+/flexible ads use instead (this is how ads built by hand in Ads Manager usually look).
  "ads.limit(5){creative{object_story_spec,asset_feed_spec}}",
].join(",");

const firstOf = (arr: unknown): Json | undefined => (Array.isArray(arr) && arr.length ? (arr[0] as Json) : undefined);
const textOf = (o: Json | undefined): string | undefined =>
  o && typeof o.text === "string" && o.text ? o.text : undefined;

/**
 * Advantage+ / flexible-media ads keep their video + copy in asset_feed_spec, not in
 * object_story_spec.video_data. Collapse the first video + first body/title/description/CTA/link into
 * a video_data-shaped object so the clone rebuilds a plain single-video creative (the gcm is swapped
 * into the link downstream). Null when there's no reusable video there.
 */
function videoDataFromAssetFeed(afs: Json): Json | null {
  const videos = Array.isArray(afs.videos) ? (afs.videos as Json[]) : [];
  const vid = videos.find((v) => v && typeof (v as Json).video_id === "string" && (v as Json).video_id);
  if (!vid) return null;

  const vd: Json = { video_id: (vid as Json).video_id };
  const thumb = (vid as Json).thumbnail_url;
  if (typeof thumb === "string" && thumb) vd.image_url = thumb;
  const message = textOf(firstOf(afs.bodies));
  if (message) vd.message = message;
  const title = textOf(firstOf(afs.titles));
  if (title) vd.title = title;
  const description = textOf(firstOf(afs.descriptions));
  if (description) vd.link_description = description;
  const ctaType = Array.isArray(afs.call_to_action_types) ? afs.call_to_action_types[0] : undefined;
  if (typeof ctaType === "string" && ctaType) {
    const link = firstOf(afs.link_urls)?.website_url;
    vd.call_to_action = { type: ctaType, value: typeof link === "string" && link ? { link } : {} };
  }
  return vd;
}

/** A reusable video_data for one fetched ad — inline object_story_spec.video_data first, then the
 *  asset_feed_spec fallback. Null when neither carries a video. */
function videoDataFromAd(ad: Json): Json | null {
  const creative = (ad.creative ?? {}) as Json;
  const inline = (((creative.object_story_spec ?? {}) as Json).video_data ?? {}) as Json;
  if (typeof inline.video_id === "string" && inline.video_id) return inline;
  const afs = creative.asset_feed_spec as Json | undefined;
  return afs ? videoDataFromAssetFeed(afs) : null;
}

/**
 * Advantage+ image ads keep their image hashes + copy in asset_feed_spec. Collapse the first image +
 * first body/title/description/CTA/link into a link_data-shaped object (link_data's headline field is
 * `name` and its description is `description` — different key names than video_data). Null when
 * there's no reusable image, or no destination link (link_data.link is mandatory on write).
 */
function linkDataFromAssetFeed(afs: Json): Json | null {
  const images = Array.isArray(afs.images) ? (afs.images as Json[]) : [];
  const img = images.find((i) => i && typeof (i as Json).hash === "string" && (i as Json).hash);
  if (!img) return null;
  const link = firstOf(afs.link_urls)?.website_url;
  if (typeof link !== "string" || !link) return null;

  const ld: Json = { link, image_hash: (img as Json).hash };
  const message = textOf(firstOf(afs.bodies));
  if (message) ld.message = message;
  const title = textOf(firstOf(afs.titles));
  if (title) ld.name = title;
  const description = textOf(firstOf(afs.descriptions));
  if (description) ld.description = description;
  const ctaType = Array.isArray(afs.call_to_action_types) ? afs.call_to_action_types[0] : undefined;
  if (typeof ctaType === "string" && ctaType) ld.call_to_action = { type: ctaType };
  return ld;
}

/** A reusable link_data (static image ad) for one fetched ad — inline object_story_spec.link_data
 *  first, then the asset_feed_spec fallback. Requires a destination link + an image (hash or picture
 *  URL) so the clone provably looks like the source. Null when the ad carries no image creative. */
function linkDataFromAd(ad: Json): Json | null {
  const creative = (ad.creative ?? {}) as Json;
  const inline = ((creative.object_story_spec ?? {}) as Json).link_data as Json | undefined;
  if (
    inline &&
    typeof inline.link === "string" &&
    inline.link &&
    ((typeof inline.image_hash === "string" && inline.image_hash) ||
      (typeof inline.picture === "string" && inline.picture))
  ) {
    return inline;
  }
  const afs = creative.asset_feed_spec as Json | undefined;
  return afs ? linkDataFromAssetFeed(afs) : null;
}

/** First reusable media on one fetched ad — video (the launcher's native format) wins over image. */
function mediaFromAd(ad: Json): SourceMedia | null {
  const vd = videoDataFromAd(ad);
  if (vd) return { kind: "video", data: vd };
  const ld = linkDataFromAd(ad);
  if (ld) return { kind: "image", data: ld };
  return null;
}

/** Public per-ad media extraction for rails that read whole source trees themselves (the HS
 *  token-duplicate pump rebuilds EVERY reusable ad, not just the first). */
export function extractAdMedia(ad: Json): SourceMedia | null {
  return mediaFromAd(ad);
}

/** Pull the source campaign's objective + first ad set's delivery + first reusable ad media.
 *  `token` selects the Graph bearer (MO launch token by default; the AIF rail passes its own). */
export async function fetchSourceDetail(campaignId: string, token?: string): Promise<SourceDetail> {
  const obj = await fbGet(`${campaignId}?fields=${encodeURIComponent(SRC_FIELDS)}`, token);
  const adset = (((obj.adsets as { data?: Json[] } | undefined)?.data?.[0] ?? {}) as Json);
  const ads = ((obj.ads as { data?: Json[] } | undefined)?.data ?? []) as Json[];
  // Scan the campaign's ads for the first with reusable media — a video (inline video_data or
  // asset_feed_spec) or a static image (link_data with an image, or asset_feed_spec images).
  let media: SourceMedia | null = null;
  for (const ad of ads) {
    media = mediaFromAd(ad);
    if (media) break;
  }
  const promoted = (adset.promoted_object ?? {}) as Json;
  const cats = obj.special_ad_categories as string[] | undefined;

  return {
    objective: typeof obj.objective === "string" ? obj.objective : "OUTCOME_SALES",
    specialCategories: Array.isArray(cats) ? cats.filter((c) => c && c !== "NONE") : [],
    bidStrategy:
      typeof obj.bid_strategy === "string"
        ? obj.bid_strategy // campaign-budget (CBO) source — strategy lives on the campaign
        : typeof adset.bid_strategy === "string"
          ? adset.bid_strategy // legacy ad-set-budget source
          : "LOWEST_COST_WITHOUT_CAP",
    optimizationGoal: typeof adset.optimization_goal === "string" ? adset.optimization_goal : "OFFSITE_CONVERSIONS",
    conversionEvent: typeof promoted.custom_event_type === "string" ? promoted.custom_event_type : "PURCHASE",
    accountId: String(obj.account_id ?? "").replace(/^act_/, ""),
    pixelId: typeof promoted.pixel_id === "string" ? promoted.pixel_id : "",
    media,
  };
}

/** A plausible Meta pixel id (same guard as lib/partners isPixelId / the launch route). */
const isPixelId = (v?: string): v is string => !!v && /^\d{10,20}$/.test(v);

/** The account + pixel a clone is actually built with. Default (no target picked) = the source's
 *  own account and pixel, exactly the pre-cross-account behaviour. A picked target account makes
 *  the clone CROSS-account: media must be migrated there, and a conversion-optimized source needs
 *  the buyer's picked pixel of that account (the source's pixel usually isn't shared to it). Click
 *  sources stay pixel-less either way. Pure — unit-testable without FB. */
export function resolveCloneBinds(
  edit: Pick<CloneEdit, "accountId" | "pixelId">,
  src: Pick<SourceDetail, "accountId" | "pixelId">,
): { accountId: string; pixelId: string; cross: boolean } {
  const target = String(edit.accountId ?? "")
    .trim()
    .replace(/^act_/, "");
  const chosen = String(edit.pixelId ?? "").trim();
  const srcPixel = isPixelId(src.pixelId) ? src.pixelId : "";
  if (!target || target === src.accountId) {
    // Same-account clone. A pixel explicitly picked with the target (validated to live on this
    // account upstream) replaces the source's for conversion sources; click sources ignore it.
    const pixelId = srcPixel ? (isPixelId(chosen) ? chosen : srcPixel) : "";
    return { accountId: src.accountId, pixelId, cross: false };
  }
  return { accountId: target, pixelId: srcPixel && isPixelId(chosen) ? chosen : "", cross: true };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until an uploaded video finishes processing (mirrors /api/launch's waitForVideo).
 *  6s cadence — status polls dominate a wave's call count on the dev-tier quota. */
async function waitVideoReady(videoId: string, token?: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await fbGet(`${videoId}?fields=status`, token);
    const status = ((body?.status ?? {}) as Json).video_status;
    if (status === "ready") return;
    if (status === "error") throw new FbError("migrated video processing failed", body);
    await sleep(6000);
  }
  throw new FbError("migrated video processing timed out", { videoId });
}

/** The thumbnail FB auto-generates for a processed video — required as the creative's image. */
async function videoThumbUrl(videoId: string, token?: string): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const body = await fbGet(`${videoId}/thumbnails?fields=uri,is_preferred`, token);
    const thumbs = (body?.data as Array<Json> | undefined) ?? [];
    const pick = thumbs.find((t) => t.is_preferred) ?? thumbs[0];
    if (pick?.uri) return String(pick.uri);
    await sleep(4000);
  }
  throw new FbError("no thumbnail available for the migrated video", { videoId });
}

/**
 * Re-home the source's media in ANOTHER ad account, returning media rebuilt around the new
 * account-local assets. Video: read the original's CDN `source` URL → `advideos file_url` into the
 * target (FB fetches the bytes itself, same mechanism as the launch flow) → wait for processing →
 * take the NEW video's own thumbnail (the source's image_hash/image_url belong to the old account).
 * Image: official cross-account `adimages copy_from`, swapping in the returned target-local hash
 * (picture-URL-only sources need no migration — a URL is account-agnostic).
 */
export async function migrateMediaToAccount(
  media: SourceMedia,
  sourceAccountId: string,
  targetAccountId: string,
  name: string,
  token?: string,
): Promise<SourceMedia> {
  if (media.kind === "video") {
    const videoId = String(media.data.video_id ?? "");
    const info = await fbGet(`${videoId}?fields=source`, token);
    const sourceUrl = typeof info.source === "string" ? info.source : "";
    if (!sourceUrl) {
      throw new FbError("source video file unavailable — cannot clone it into another account", { videoId });
    }
    const up = await fbPost(`act_${targetAccountId}/advideos`, { name, file_url: sourceUrl }, token);
    if (!up?.id) throw new FbError("video migration upload failed", up);
    const newId = String(up.id);
    await waitVideoReady(newId, token);
    const thumb = await videoThumbUrl(newId, token);
    const data: Json = { ...media.data, video_id: newId, image_url: thumb };
    delete data.image_hash; // the old account's asset — invalid in the target
    return { kind: "video", data };
  }

  const hash = typeof media.data.image_hash === "string" ? media.data.image_hash : "";
  if (!hash) return media; // picture-URL image — nothing account-local to migrate
  const body = await fbPost(
    `act_${targetAccountId}/adimages`,
    { copy_from: { source_account_id: sourceAccountId, hash } },
    token,
  );
  const images = (body?.images ?? {}) as Record<string, { hash?: string }>;
  const newHash = Object.values(images)[0]?.hash;
  if (!newHash) throw new FbError("image migration failed — no hash returned", body);
  return { kind: "image", data: { ...media.data, image_hash: String(newHash) } };
}

/** Swap the gcm value in a tracking link (or append it), keeping every other param + FB macro.
 *  Matches any existing value ([^&#]*), not just digits, so a malformed `gcm=` (empty/non-numeric)
 *  is REPLACED rather than leaving a duplicate `gcm=` param the funnel would misread. */
export function swapGcm(link: string, gcm: string): string {
  if (!link) return link;
  if (/[?&]gcm=[^&#]*/.test(link)) return link.replace(/([?&]gcm=)[^&#]*/g, `$1${gcm}`);
  return link + (link.includes("?") ? "&" : "?") + `gcm=${gcm}`;
}

/** Swap the AIF `brand=` marker in an RW link (or append it) — the AIF twin of swapGcm: the brand
 *  is that rail's revenue key, one per campaign. destination/clientId/ppid stay verbatim. */
export function swapBrand(link: string, brand: string): string {
  if (!link) return link;
  if (/[?&]brand=[^&#]*/.test(link)) return link.replace(/([?&]brand=)[^&#]*/g, `$1${brand}`);
  return link + (link.includes("?") ? "&" : "?") + `brand=${brand}`;
}

/**
 * Set the `pixel=<id>` param on a tracking link to the clone's account pixel (the funnel fires
 * that pixel). Replaces an existing pixel= or appends it. Empty pixel id → link left untouched
 * (funnel falls back to its default pixel — correct for click-optimized sources with no pixel).
 */
export function swapPixel(link: string, pixelId: string): string {
  if (!link || !/^\d{10,20}$/.test(pixelId)) return link;
  if (/[?&]pixel=[^&#]*/.test(link)) return link.replace(/([?&]pixel=)[^&#]*/g, `$1${pixelId}`);
  return link + (link.includes("?") ? "&" : "?") + `pixel=${pixelId}`;
}

/** The clone's effective bid strategy: the buyer's per-row switch wins (ROAS ↔ cap ↔ lowest —
 *  owner ask 09-01), absent/empty inherits the source's. Shared by the route's validation and
 *  cloneToCampaign so they can never disagree. */
export function cloneBidStrategy(edit: Pick<CloneEdit, "bidStrategy">, src: Pick<SourceDetail, "bidStrategy">): string {
  return String(edit.bidStrategy ?? "").trim() || src.bidStrategy;
}

/** A Campaign-shaped object from the clone edit + source, to reuse the launch payload builders. */
export function cloneToCampaign(edit: CloneEdit, src: SourceDetail): Campaign {
  const c = makeCampaign(edit.campaignId, "", edit.name); // namePrefix "" → fullName === edit.name
  c.objective = src.objective;
  // Min-ROAS optimizes purchase VALUE regardless of what the source optimized (the payload
  // builders derive optimization_goal VALUE + pin PURCHASE from the strategy kind) — a click
  // source switched to ROAS must not stay "clicks". Every other strategy keeps the source's.
  c.bidStrategy = cloneBidStrategy(edit, src);
  c.optimization =
    bidKind(c.bidStrategy) === "roas" || src.optimizationGoal !== "LINK_CLICKS" ? "conversions" : "clicks";
  c.bidCap = edit.roasGoal; // becomes bid_amount only for cap strategies (see fb-launch bidAmountCents)
  c.conversionEvent = src.conversionEvent;
  c.budget = edit.budget;
  c.countries = [...edit.countries];
  c.locales = [...edit.locales];
  // The buyer's pick wins, but a source that DECLARED a special category never silently loses
  // it: a financial/housing/employment clone without its declaration is a policy violation Meta
  // rejects — or worse, delivers (review find 08-24). Multi-category sources keep their first
  // (the payload carries one; the token rail patches the full list from its raw tree instead).
  c.category = edit.category || src.specialCategories[0] || "";
  c.placement = edit.placement;
  c.ageMin = edit.ageMin;
  c.userOs = edit.userOs;
  return c;
}

/** Rewrite a tracking link for the clone: fresh gcm + the clone's account pixel (funnel fires it). */
function rewriteLink(link: string, gcm: string, pixelId: string): string {
  return swapPixel(swapGcm(link, gcm), pixelId);
}

type LinkRewriter = (link: string) => string;

/** video_data rebuild: same video/copy/title/CTA, the tracking link rewritten by `swap`. */
function videoCreativeData(videoData: Json, swap: LinkRewriter): Json {
  const vd: Json = {};
  if (videoData.video_id) vd.video_id = videoData.video_id;
  if (videoData.message) vd.message = videoData.message;
  if (videoData.title) vd.title = videoData.title;
  if (videoData.link_description) vd.link_description = videoData.link_description;
  // image_hash is a stable account asset; prefer it over the (expiring) image_url.
  if (videoData.image_hash) vd.image_hash = videoData.image_hash;
  else if (videoData.image_url) vd.image_url = videoData.image_url;

  const cta = videoData.call_to_action as Json | undefined;
  if (cta) {
    const val = (cta.value ?? {}) as Json;
    const link = typeof val.link === "string" ? swap(val.link) : val.link;
    vd.call_to_action = { type: cta.type, value: { ...val, link } };
  }
  return vd;
}

/** link_data rebuild (static image ad): same image/copy/headline/CTA, the gcm + pixel swapped in
 *  the destination link (and in the CTA link when the source carries one). The image is reused by
 *  image_hash — an account-library asset, valid because the clone is built in the account that
 *  hash lives in (the source's own, or the target after migrateMediaToAccount rehomed it). */
function imageCreativeData(linkData: Json, swap: LinkRewriter): Json {
  const ld: Json = {};
  if (typeof linkData.link === "string") ld.link = swap(linkData.link);
  if (linkData.message) ld.message = linkData.message;
  if (linkData.name) ld.name = linkData.name;
  if (linkData.description) ld.description = linkData.description;
  if (linkData.caption) ld.caption = linkData.caption;
  // image_hash is a stable account asset; prefer it over the (expiring) picture URL.
  if (linkData.image_hash) ld.image_hash = linkData.image_hash;
  else if (linkData.picture) ld.picture = linkData.picture;

  const cta = linkData.call_to_action as Json | undefined;
  if (cta && typeof cta.type === "string") {
    const val = (cta.value ?? {}) as Json;
    const link = typeof val.link === "string" ? swap(val.link) : undefined;
    ld.call_to_action = link ? { type: cta.type, value: { ...val, link } } : { type: cta.type };
  }
  return ld;
}

/**
 * Rebuild the creative from the source's media — video_data for video ads, link_data for static
 * image ads — rewriting the tracking link for the clone. Default rewrite = the MO rail's fresh
 * gcm + account pixel; the AIF rail passes its own (`swapBrand` — brand marker only, no pixel
 * param on that link). Only known-writable fields are forwarded (the read fetch returns extras).
 */
export function cloneCreativePayload(
  name: string,
  pageId: string,
  media: SourceMedia,
  gcm: string,
  pixelId: string,
  rewrite?: LinkRewriter,
): Json {
  const swap: LinkRewriter = rewrite ?? ((link) => rewriteLink(link, gcm, pixelId));
  const spec =
    media.kind === "video"
      ? { video_data: videoCreativeData(media.data, swap) }
      : { link_data: imageCreativeData(media.data, swap) };
  return { name, object_story_spec: { page_id: pageId, ...spec } };
}

/** Resolve locale display names → Meta locale ids (exact match only). Empty in, empty out (no call). */
export async function resolveLocales(names: string[], token?: string): Promise<number[]> {
  const ids: number[] = [];
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  for (const raw of names) {
    if (/\(all\)/i.test(raw)) continue; // "all" = no restriction
    try {
      const body = await fbGet(
        `search?type=adlocale&limit=25&q=${encodeURIComponent(raw.replace(/[()]/g, " ").trim())}`,
        token,
      );
      const data = (body.data as Array<{ key?: number; name?: string }> | undefined) ?? [];
      const hit = data.find((d) => d.name && norm(d.name) === norm(raw));
      if (typeof hit?.key === "number") ids.push(hit.key);
    } catch {
      /* locale lookup is best-effort — skip on failure */
    }
  }
  return [...new Set(ids)];
}

// ================================================================================================
// TOOL channel extractors (owner ask 28.09): run the MO/AIF clone through the HS Ads Manager
// sessions service (tool.gctracking.xyz) instead of direct Graph. A TOOL clone STILL recreates from
// scratch (TOOL's /duplicates cannot rewrite the per-clone gcm/brand + pixel link — the very reason
// this rail exists), so it reuses everything above (source read, cloneToCampaign, the link rewrite)
// and only swaps the build call. These three pure/near-pure helpers translate the source's media +
// creative onto TOOL's wire the way videoCreativeData / imageCreativeData do it for Graph
// object_story_spec; the CampaignRequest assembly + USD/ROAS units live in lib/tool-launch.
// ================================================================================================

/**
 * SAME-ACCOUNT TOOL MediaRef straight from the source's own account-local asset. Valid because a
 * same-account TOOL clone builds in the SOURCE's account (which the resolving TOOL session sees), so
 * its video_id / image_hash reference the very library the create job runs against. Video →
 * {video_id} + an {image_hash} thumbnail when the source carried one (TOOL auto-thumbnails
 * otherwise); static image → {image_hash}. Null when there is no account-local id/hash to reference
 * (a picture-URL-only image): the caller then registers the source's PUBLIC url via TOOL
 * media/from-url instead (toolSourceMediaItem). PURE.
 */
export function toolMediaRefFromSource(media: SourceMedia): ToolMediaRefOut | null {
  const d = media.data;
  if (media.kind === "video") {
    const videoId = typeof d.video_id === "string" ? d.video_id : "";
    if (!videoId) return null;
    const ref: ToolMediaRefOut = { media: { type: "video", video_id: videoId } };
    const hash = typeof d.image_hash === "string" ? d.image_hash : "";
    if (hash) ref.thumbnail = { type: "image", image_hash: hash };
    return ref;
  }
  const hash = typeof d.image_hash === "string" ? d.image_hash : "";
  return hash ? { media: { type: "image", image_hash: hash } } : null;
}

/**
 * The rebuilt creative's TOOL CreativeSpec text fields (primary_text / headline / description / cta)
 * plus the REWRITTEN destination url — pulled from the source's video_data / link_data, the exact
 * same fields videoCreativeData / imageCreativeData forward to Graph, flattened onto TOOL's shape.
 * A video ad's destination rides ONLY in its CTA (call_to_action.value.link — the same place
 * videoCreativeData reads it); a static image ad carries it at link_data.link (top-level). `rewrite`
 * swaps the fresh gcm/brand + account pixel into the source link exactly like Graph's rewriteLink
 * (swapPixel no-ops for pixel-less click clones). PURE.
 */
export function toolCreativeFromSource(
  media: SourceMedia,
  rewrite: LinkRewriter,
): { primaryText: string; headline: string; description?: string; cta: string; url: string } {
  const d = media.data;
  const cta = (d.call_to_action ?? {}) as Json;
  const ctaType = typeof cta.type === "string" ? cta.type : "";
  const message = typeof d.message === "string" ? d.message : "";
  if (media.kind === "video") {
    const val = (cta.value ?? {}) as Json;
    const rawLink = typeof val.link === "string" ? val.link : "";
    const desc = typeof d.link_description === "string" ? d.link_description : "";
    return {
      primaryText: message,
      headline: typeof d.title === "string" ? d.title : "",
      description: desc || undefined,
      cta: ctaType,
      url: rawLink ? rewrite(rawLink) : "",
    };
  }
  // link_data's headline is `name` and its body is `description` (different keys than video_data).
  const rawLink = typeof d.link === "string" ? d.link : "";
  const desc = typeof d.description === "string" ? d.description : "";
  return {
    primaryText: message,
    headline: typeof d.name === "string" ? d.name : "",
    description: desc || undefined,
    cta: ctaType,
    url: rawLink ? rewrite(rawLink) : "",
  };
}

/**
 * Resolve the source media's PUBLIC url so TOOL can re-register it into the build account through
 * media/from-url — for a CROSS-account clone (the source's account-local video_id/image_hash is
 * invalid in the target account) or a picture-URL-only same-account image. Video: the original's CDN
 * `source` url (GET /<video_id>?fields=source — the SAME read migrateMediaToAccount does before
 * re-uploading on Graph). Image: the existing account-agnostic picture url, else the hash's public
 * url (GET act_<src>/adimages?fields=url,permalink_url&hashes=[…], mirroring how migrateMediaToAccount
 * reads the source's images). Throws FbError when no public url is available. Reads Graph with the
 * clone signer's token; full body (no thin wrapper — Turbopack const-fold gotcha).
 */
export async function toolSourceMediaItem(
  media: SourceMedia,
  sourceAccountId: string,
  name: string,
  token?: string,
): Promise<ToolMediaItem> {
  if (media.kind === "video") {
    const videoId = String(media.data.video_id ?? "");
    const info = await fbGet(`${videoId}?fields=source`, token);
    const sourceUrl = typeof info.source === "string" ? info.source : "";
    if (!sourceUrl) throw new FbError("source video file unavailable — cannot register it on TOOL", { videoId });
    return { url: sourceUrl, kind: "video", name };
  }
  const pic = typeof media.data.picture === "string" ? media.data.picture : "";
  if (pic) return { url: pic, kind: "image", name };
  const hash = typeof media.data.image_hash === "string" ? media.data.image_hash : "";
  if (!hash) throw new FbError("source image has no reusable url or hash — cannot register it on TOOL", {});
  const body = await fbGet(
    `act_${sourceAccountId}/adimages?fields=url,permalink_url&hashes=${encodeURIComponent(JSON.stringify([hash]))}`,
    token,
  );
  const first = (((body?.data as Json[] | undefined) ?? [])[0] ?? {}) as Json;
  const url =
    typeof first.url === "string" && first.url
      ? first.url
      : typeof first.permalink_url === "string"
        ? first.permalink_url
        : "";
  if (!url) throw new FbError("source image url unavailable — cannot register it on TOOL", { hash });
  return { url, kind: "image", name };
}

// Re-export the launch builders the run route composes, so it imports them from one place.
export { adPayload, adsetPayload, campaignPayload };
export type { LaunchBinds };
