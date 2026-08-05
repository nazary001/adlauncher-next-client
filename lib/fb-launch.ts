import type { Campaign } from "./types";
import { parseMoney } from "./types";

/** Resolved, server-enforced binds for a launch (locked partner values). */
export type LaunchBinds = {
  accountId: string; // digits only, no act_ prefix
  pageId: string;
  pixelId: string;
};

export const money = (v: string): number => Math.round(parseMoney(v) * 100); // major → cents

/** conversions optimize for the pixel event; clicks optimize for link clicks. */
export function optimizationGoal(c: Campaign): string {
  return c.optimization === "conversions" ? "OFFSITE_CONVERSIONS" : "LINK_CLICKS";
}

/** UI `category` values are already Meta special-ad-category enums; empty = none. */
export function specialAdCategories(c: Campaign): string[] {
  return c.category ? [c.category] : [];
}

/** Bid cap only carries a bid_amount; lowest-cost has none. */
export function bidAmountCents(c: Campaign): number | undefined {
  if (c.bidStrategy === "LOWEST_COST_WITHOUT_CAP") return undefined;
  const cents = money(c.bidCap);
  return cents > 0 ? cents : undefined;
}

/** Placement encodes a placement set (FULL vs COMPLIANCE) + optional gender suffix. */
function placementBits(placement: string) {
  return {
    male: placement.endsWith("HOMEM"),
    female: placement.endsWith("MULHER"),
    compliance: placement.startsWith("COMPLIANCE"),
  };
}

/** Targeting spec from geo / age / gender / placement / OS / resolved locales. */
export function targeting(c: Campaign, localeIds: number[]): Record<string, unknown> {
  const t: Record<string, unknown> = {};

  t.geo_locations = c.countries.includes("WW")
    ? { location_types: ["home", "recent"], country_groups: ["worldwide"] }
    : { location_types: ["home", "recent"], countries: c.countries };

  t.age_min = parseInt(c.ageMin || "18", 10) || 18;
  t.age_max = 65;

  const { male, female, compliance } = placementBits(c.placement);
  if (male) t.genders = [1];
  else if (female) t.genders = [2];

  if (compliance) {
    // Restricted-niche safe set: feeds only.
    t.publisher_platforms = ["facebook", "instagram"];
    t.facebook_positions = ["feed"];
    t.instagram_positions = ["stream"];
  }
  // FULL → omit platforms/positions = Advantage+ (automatic) placements.

  if (c.userOs === "android") {
    t.user_os = ["Android"];
    t.device_platforms = ["mobile"];
  }

  if (localeIds.length) t.locales = localeIds;

  return t;
}

/** POST /act_<id>/campaigns. Budgets live on the ad set (no CBO), so Meta requires an
 *  explicit is_adset_budget_sharing_enabled — false = ad sets keep their own budgets. */
export function campaignPayload(c: Campaign, name: string): Record<string, unknown> {
  return {
    name,
    objective: c.objective,
    status: "PAUSED",
    special_ad_categories: specialAdCategories(c),
    is_adset_budget_sharing_enabled: false,
  };
}

/** POST /act_<id>/adsets — budget + bid + optimization + targeting + promoted pixel. */
export function adsetPayload(
  c: Campaign,
  name: string,
  campaignId: string,
  binds: LaunchBinds,
  localeIds: number[],
): Record<string, unknown> {
  const p: Record<string, unknown> = {
    name,
    campaign_id: campaignId,
    daily_budget: money(c.budget),
    billing_event: "IMPRESSIONS",
    optimization_goal: optimizationGoal(c),
    bid_strategy: c.bidStrategy,
    status: "PAUSED",
    targeting: targeting(c, localeIds),
  };

  const bid = bidAmountCents(c);
  if (bid !== undefined) p.bid_amount = bid;

  // OUTCOME_SALES needs a promoted pixel; conversions also name the event.
  if (binds.pixelId) {
    const promoted: Record<string, unknown> = { pixel_id: binds.pixelId };
    if (c.optimization === "conversions") promoted.custom_event_type = c.conversionEvent;
    p.promoted_object = promoted;
  }

  // Worldwide reach includes regulated locations (Taiwan, Singapore) that each require a self-
  // declared "universal ads" category, or Meta rejects the ad set with "Invalid parameter". The
  // launch route self-heals any further regions Meta may demand.
  const declarations = regionalDeclarations(c);
  if (declarations.length) p.regional_regulated_categories = declarations;

  return p;
}

/** Self-declared "universal ads" categories Meta requires for regulated locations in the audience.
 *  Only worldwide reaches them by default; specific-country runs that happen to include one are
 *  covered by the launch route's self-healing retry. */
export function regionalDeclarations(c: Campaign): string[] {
  return c.countries.includes("WW") ? ["TAIWAN_UNIVERSAL", "SINGAPORE_UNIVERSAL"] : [];
}

/** POST /act_<id>/adcreatives — video creative with CTA pointing at the tracking link. */
export function creativePayload(
  c: Campaign,
  name: string,
  binds: LaunchBinds,
  media: { videoId: string; thumbUrl: string; link: string },
): Record<string, unknown> {
  const videoData: Record<string, unknown> = {
    video_id: media.videoId,
    image_url: media.thumbUrl,
    message: c.copy || undefined, // primary text
    title: c.headline || c.title || undefined, // headline
  };
  if (c.title && c.headline && c.title !== c.headline) videoData.link_description = c.title;
  if (c.cta) {
    videoData.call_to_action = { type: c.cta, value: { link: media.link } };
  }

  return {
    name,
    object_story_spec: { page_id: binds.pageId, video_data: videoData },
  };
}

/** POST /act_<id>/ads */
export function adPayload(name: string, adsetId: string, creativeId: string): Record<string, unknown> {
  return {
    name,
    adset_id: adsetId,
    creative: { creative_id: creativeId },
    status: "PAUSED",
  };
}
