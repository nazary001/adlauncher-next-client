// Server-side clone builder. Given a buyer's per-clone edits + the source campaign id, re-fetches
// the source's full structure from Facebook and assembles the campaign/adset/creative/ad payloads
// for a faithful PAUSED duplicate — reusing the launch payload builders so the FB shape matches the
// launcher exactly. The creative is rebuilt from the source's own media — video_data for video ads,
// link_data for static image ads (same asset, copy, title, CTA) — with only the gcm swapped in the
// tracking link.

import { type Campaign, makeCampaign } from "./types";
import type { CloneEdit } from "./clone";
import { fbGet } from "./fb-graph";
import { adPayload, adsetPayload, campaignPayload, type LaunchBinds } from "./fb-launch";

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
  /** First reusable media found on the source's ads (video preferred), null when none. */
  media: SourceMedia | null;
};

const SRC_FIELDS = [
  "objective",
  "special_ad_categories",
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

/** Pull the source campaign's objective + first ad set's delivery + first reusable ad media. */
export async function fetchSourceDetail(campaignId: string): Promise<SourceDetail> {
  const obj = await fbGet(`${campaignId}?fields=${encodeURIComponent(SRC_FIELDS)}`);
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
    bidStrategy: typeof adset.bid_strategy === "string" ? adset.bid_strategy : "LOWEST_COST_WITHOUT_CAP",
    optimizationGoal: typeof adset.optimization_goal === "string" ? adset.optimization_goal : "OFFSITE_CONVERSIONS",
    conversionEvent: typeof promoted.custom_event_type === "string" ? promoted.custom_event_type : "PURCHASE",
    media,
  };
}

/** Swap the gcm=NN value in a tracking link (or append it), keeping every other param + FB macro. */
export function swapGcm(link: string, gcm: string): string {
  if (!link) return link;
  if (/([?&]gcm=)\d+/.test(link)) return link.replace(/([?&]gcm=)\d+/, `$1${gcm}`);
  return link + (link.includes("?") ? "&" : "?") + `gcm=${gcm}`;
}

/** A Campaign-shaped object from the clone edit + source, to reuse the launch payload builders. */
export function cloneToCampaign(edit: CloneEdit, src: SourceDetail): Campaign {
  const c = makeCampaign(edit.campaignId, "", edit.name); // namePrefix "" → fullName === edit.name
  c.objective = src.objective;
  c.optimization = src.optimizationGoal === "LINK_CLICKS" ? "clicks" : "conversions";
  c.bidStrategy = src.bidStrategy;
  c.bidCap = edit.roasGoal; // becomes bid_amount only for cap strategies (see fb-launch bidAmountCents)
  c.conversionEvent = src.conversionEvent;
  c.budget = edit.budget;
  c.countries = [...edit.countries];
  c.locales = [...edit.locales];
  c.category = edit.category;
  c.placement = edit.placement;
  c.ageMin = edit.ageMin;
  c.userOs = edit.userOs;
  return c;
}

/** video_data rebuild: same video/copy/title/CTA, only the gcm in the CTA link swapped. */
function videoCreativeData(videoData: Json, gcm: string): Json {
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
    const link = typeof val.link === "string" ? swapGcm(val.link, gcm) : val.link;
    vd.call_to_action = { type: cta.type, value: { ...val, link } };
  }
  return vd;
}

/** link_data rebuild (static image ad): same image/copy/headline/CTA, the gcm swapped in the
 *  destination link (and in the CTA link when the source carries one). The image is reused by
 *  image_hash — an account-library asset, valid here because clones are created in the same ad
 *  account the source lives in. */
function imageCreativeData(linkData: Json, gcm: string): Json {
  const ld: Json = {};
  if (typeof linkData.link === "string") ld.link = swapGcm(linkData.link, gcm);
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
    const link = typeof val.link === "string" ? swapGcm(val.link, gcm) : undefined;
    ld.call_to_action = link ? { type: cta.type, value: { ...val, link } } : { type: cta.type };
  }
  return ld;
}

/**
 * Rebuild the creative from the source's media — video_data for video ads, link_data for static
 * image ads — swapping only the gcm in the tracking link. Only known-writable fields are forwarded
 * (the read fetch returns extras).
 */
export function cloneCreativePayload(name: string, pageId: string, media: SourceMedia, gcm: string): Json {
  const spec =
    media.kind === "video"
      ? { video_data: videoCreativeData(media.data, gcm) }
      : { link_data: imageCreativeData(media.data, gcm) };
  return { name, object_story_spec: { page_id: pageId, ...spec } };
}

/** Resolve locale display names → Meta locale ids (exact match only). Empty in, empty out (no call). */
export async function resolveLocales(names: string[]): Promise<number[]> {
  const ids: number[] = [];
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  for (const raw of names) {
    if (/\(all\)/i.test(raw)) continue; // "all" = no restriction
    try {
      const body = await fbGet(`search?type=adlocale&limit=25&q=${encodeURIComponent(raw.replace(/[()]/g, " ").trim())}`);
      const data = (body.data as Array<{ key?: number; name?: string }> | undefined) ?? [];
      const hit = data.find((d) => d.name && norm(d.name) === norm(raw));
      if (typeof hit?.key === "number") ids.push(hit.key);
    } catch {
      /* locale lookup is best-effort — skip on failure */
    }
  }
  return [...new Set(ids)];
}

// Re-export the launch builders the run route composes, so it imports them from one place.
export { adPayload, adsetPayload, campaignPayload };
export type { LaunchBinds };
