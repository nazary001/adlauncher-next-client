// Server-side clone builder. Given a buyer's per-clone edits + the source campaign id, re-fetches
// the source's full structure from Facebook and assembles the campaign/adset/creative/ad payloads
// for a faithful PAUSED duplicate — reusing the launch payload builders so the FB shape matches the
// launcher exactly. The creative is rebuilt from the source's own video_data (same video, copy,
// title, CTA) with only the gcm swapped in the tracking link.

import { type Campaign, makeCampaign } from "./types";
import type { CloneEdit } from "./clone";
import { fbGet } from "./fb-graph";
import { adPayload, adsetPayload, campaignPayload, type LaunchBinds } from "./fb-launch";

type Json = Record<string, unknown>;

/** What the run needs from the source campaign to rebuild a faithful clone. */
export type SourceDetail = {
  objective: string;
  specialCategories: string[];
  bidStrategy: string;
  optimizationGoal: string;
  conversionEvent: string;
  videoData: Json; // source ad's object_story_spec.video_data (video_id/message/title/cta/image)
};

const SRC_FIELDS = [
  "objective",
  "special_ad_categories",
  "adsets.limit(1){bid_strategy,optimization_goal,promoted_object}",
  "ads.limit(1){creative{object_story_spec}}",
].join(",");

/** Pull the source campaign's objective + first ad set's delivery + first ad's creative story. */
export async function fetchSourceDetail(campaignId: string): Promise<SourceDetail> {
  const obj = await fbGet(`${campaignId}?fields=${encodeURIComponent(SRC_FIELDS)}`);
  const adset = (((obj.adsets as { data?: Json[] } | undefined)?.data?.[0] ?? {}) as Json);
  const ad = (((obj.ads as { data?: Json[] } | undefined)?.data?.[0] ?? {}) as Json);
  const creative = (ad.creative ?? {}) as Json;
  const oss = (creative.object_story_spec ?? {}) as Json;
  const videoData = (oss.video_data ?? {}) as Json;
  const promoted = (adset.promoted_object ?? {}) as Json;
  const cats = obj.special_ad_categories as string[] | undefined;

  return {
    objective: typeof obj.objective === "string" ? obj.objective : "OUTCOME_SALES",
    specialCategories: Array.isArray(cats) ? cats.filter((c) => c && c !== "NONE") : [],
    bidStrategy: typeof adset.bid_strategy === "string" ? adset.bid_strategy : "LOWEST_COST_WITHOUT_CAP",
    optimizationGoal: typeof adset.optimization_goal === "string" ? adset.optimization_goal : "OFFSITE_CONVERSIONS",
    conversionEvent: typeof promoted.custom_event_type === "string" ? promoted.custom_event_type : "PURCHASE",
    videoData,
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

/**
 * Rebuild the creative from the source's video_data (same video/copy/title/CTA), swapping only the
 * gcm in the CTA link. Only known-writable fields are forwarded (the read fetch returns extras).
 */
export function cloneCreativePayload(name: string, pageId: string, videoData: Json, gcm: string): Json {
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

  return { name, object_story_spec: { page_id: pageId, video_data: vd } };
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
