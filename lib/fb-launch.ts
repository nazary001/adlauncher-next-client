import type { Campaign } from "./types";
import { bidKind, parseMoney } from "./types";

/** Resolved, server-enforced binds for a launch (locked partner values). */
export type LaunchBinds = {
  accountId: string; // digits only, no act_ prefix
  pageId: string;
  /** Display name of the fanpage — becomes the ad set's DSA beneficiary/payor declaration. */
  pageName: string;
  pixelId: string;
};

export const money = (v: string): number => Math.round(parseMoney(v) * 100); // major → cents

/** conversions optimize for the pixel event; clicks for link clicks; a min-ROAS strategy
 *  REQUIRES the VALUE goal (live-probed 2026-08-11: OFFSITE_CONVERSIONS is rejected with
 *  sub 2490487 whose text itself names the recipe — floor + goal VALUE). */
export function optimizationGoal(c: Campaign): string {
  if (bidKind(c.bidStrategy) === "roas") return "VALUE";
  return c.optimization === "conversions" ? "OFFSITE_CONVERSIONS" : "LINK_CLICKS";
}

/** UI `category` values are already Meta special-ad-category enums; empty = none. */
export function specialAdCategories(c: Campaign): string[] {
  return c.category ? [c.category] : [];
}

/** Only cap strategies carry a bid_amount; lowest-cost has none, min-ROAS bids through
 *  bid_constraints instead (see adsetPayload). */
export function bidAmountCents(c: Campaign): number | undefined {
  if (bidKind(c.bidStrategy) !== "cap") return undefined;
  const cents = money(c.bidCap);
  return cents > 0 ? cents : undefined;
}

/** Bid strategies the payload builder can faithfully rebuild. Anything else must be rejected
 *  BEFORE any FB write — cloning an arbitrary live source could import one, and Meta would
 *  reject the ad set after the campaign exists, orphaning it and burning a gcm code. */
export const SUPPORTED_BID_STRATEGIES = new Set([
  "LOWEST_COST_WITHOUT_CAP",
  "LOWEST_COST_WITH_BID_CAP",
  "COST_CAP",
  "LOWEST_COST_WITH_MIN_ROAS",
]);

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
  // Any special ad category (finance/housing/employment/politics) forbids custom age & gender —
  // Meta rejects the ad set otherwise ("Custom age/gender selection is unavailable…").
  const special = c.category !== "";

  t.geo_locations = c.countries.includes("WW")
    ? { location_types: ["home", "recent"], country_groups: ["worldwide"] }
    : { location_types: ["home", "recent"], countries: c.countries };

  const ageMin = special ? 18 : parseInt(c.ageMin || "18", 10) || 18;
  t.age_min = ageMin;
  t.age_max = 65;

  const { male, female, compliance } = placementBits(c.placement);
  const gendered = !special && (male || female);
  if (gendered) t.genders = male ? [1] : [2];

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

  // Once gender or age is narrowed, Meta requires an explicit Advantage-audience decision, else it
  // rejects with "Advantage Audience Flag Required". Narrowed = respect it exactly (no expansion);
  // broad (18+, all genders) keeps Meta's default Advantage+ behaviour.
  if (gendered || ageMin > 18) {
    t.targeting_automation = { advantage_audience: 0 };
  }

  return t;
}

/** POST /act_<id>/campaigns. The DAILY BUDGET lives here (campaign budget / CBO, decision
 *  2026-08-10 — was ad-set-level before), and with a campaign budget Meta requires the
 *  bid_strategy on the campaign too (the ad set then only carries bid_amount for cap
 *  strategies). The old is_adset_budget_sharing_enabled flag applied to ad-set budgets only. */
export function campaignPayload(c: Campaign, name: string): Record<string, unknown> {
  return {
    name,
    objective: c.objective,
    // ACTIVE on creation (owner decision 2026-08-11) — waves used to launch PAUSED and get a
    // separate mass-activation pass every evening; now they go straight to review/delivery.
    status: "ACTIVE",
    special_ad_categories: specialAdCategories(c),
    daily_budget: money(c.budget),
    bid_strategy: c.bidStrategy,
  };
}

/** POST /act_<id>/adsets — bid amount + optimization + targeting + promoted pixel. The daily
 *  budget and bid strategy live on the CAMPAIGN (see campaignPayload) — an ad set under a
 *  campaign budget must not carry its own. */
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
    billing_event: "IMPRESSIONS",
    optimization_goal: optimizationGoal(c),
    status: "ACTIVE", // launches go live immediately (2026-08-11) — see campaignPayload
    targeting: targeting(c, localeIds),
  };

  const bid = bidAmountCents(c);
  if (bid !== undefined) p.bid_amount = bid;

  // Min ROAS bids through bid_constraints instead of bid_amount; the floor is ROAS × 10000
  // (1,20 → 12000). Live-probed 2026-08-11 on BR-1500: VALUE goal + floor + PURCHASE is the
  // exact combination Meta accepts (bid_amount alongside would be a different, unprobed shape).
  const roas = bidKind(c.bidStrategy) === "roas";
  if (roas) {
    p.bid_constraints = { roas_average_floor: Math.round(parseMoney(c.bidCap) * 10000) };
  }

  // The promoted pixel needs its event for BOTH conversions and clicks — LINK_CLICKS with a
  // pixel-only promoted_object is an invalid combination. optimization_goal already encodes
  // whether we optimize for conversions or clicks. Min ROAS optimizes purchase VALUE — the
  // event is pinned server-side no matter what the client sent.
  if (binds.pixelId) {
    p.promoted_object = { pixel_id: binds.pixelId, custom_event_type: roas ? "PURCHASE" : c.conversionEvent };
  }

  // Worldwide reach includes regulated locations (Taiwan, Singapore) that each require a self-
  // declared "universal ads" category, or Meta rejects the ad set with "Invalid parameter". The
  // launch route self-heals any further regions Meta may demand.
  const declarations = regionalDeclarations(c);
  if (declarations.length) p.regional_regulated_categories = declarations;

  // EU-reaching audiences (worldwide always is) demand a DSA "who is promoted / who pays"
  // declaration, or Meta rejects the ad set with "Advertiser not specified" — UNLESS the ad
  // account carries a default beneficiary. Only one of our accounts did, so launches silently
  // depended on landing there (live failure 2026-08-10). Declare the fanpage on every ad set —
  // exactly what Ads Manager pre-fills — so any token account works.
  if (binds.pageName) {
    p.dsa_beneficiary = binds.pageName;
    p.dsa_payor = binds.pageName;
  }

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

/** POST /act_<id>/adcreatives — static image creative (link_data). Field names differ from
 *  video_data: the headline is `name`, the description is `description`, and the destination
 *  `link` is mandatory on write (it also feeds the CTA). Same copy mapping as the video path. */
export function imageCreativePayload(
  c: Campaign,
  name: string,
  binds: LaunchBinds,
  media: { imageHash: string; link: string },
): Record<string, unknown> {
  const linkData: Record<string, unknown> = {
    link: media.link,
    image_hash: media.imageHash,
    message: c.copy || undefined, // primary text
    name: c.headline || c.title || undefined, // headline
  };
  if (c.title && c.headline && c.title !== c.headline) linkData.description = c.title;
  if (c.cta) {
    linkData.call_to_action = { type: c.cta, value: { link: media.link } };
  }

  return {
    name,
    object_story_spec: { page_id: binds.pageId, link_data: linkData },
  };
}

/** POST /act_<id>/ads */
export function adPayload(name: string, adsetId: string, creativeId: string): Record<string, unknown> {
  return {
    name,
    adset_id: adsetId,
    creative: { creative_id: creativeId },
    status: "ACTIVE", // launches go live immediately (2026-08-11) — see campaignPayload
  };
}
