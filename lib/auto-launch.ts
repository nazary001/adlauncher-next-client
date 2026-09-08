// Pure builders for the Auto-launch rail: turn a published MK Learn landing (+ its spike angle) into
// a ready MO Campaign, an ad-copy prompt and a creative-image prompt. No I/O here — the prepare-launch
// route does the Gemini calls, the Blob upload and the Strapi reads; this module is the shape/decision
// layer (unit-testable), so the campaign a launch fires can never drift from the FB payload builders.

import { type Campaign, makeCampaign } from "@/lib/types";
import { CTAS } from "@/lib/catalog";
import { namePrefixFor, partnerConfig } from "@/lib/partners";

/** Landing facts the ad copy is generated from (read from the mo-landing row + its job). */
export type LaunchLanding = {
  slug: string;
  title: string;
  subtitle: string;
  niche: string;
  lang: "en" | "es";
  /** The competitor angle the article was built on (job.notes), if any — steers copy tone. */
  angle: string;
};

/** What Gemini returns for the ad. Kept small: primary text, headline, a short secondary line, a
 *  CTA and the creative scene. */
export type AdCopy = {
  primaryText: string;
  headline: string;
  description: string;
  cta: string;
  imagePrompt: string;
};

export const AD_COPY_SCHEMA = {
  type: "object",
  properties: {
    primaryText: { type: "string" },
    headline: { type: "string" },
    description: { type: "string" },
    cta: { type: "string" },
    imagePrompt: { type: "string" },
  },
  required: ["primaryText", "headline", "description", "cta", "imagePrompt"],
} as const;

const CTA_VALUES = new Set(CTAS.map((c) => c.value).filter(Boolean));
/** Clamp a model-suggested CTA to a real Meta enum; anything unknown/blank → LEARN_MORE (a video ad
 *  MUST carry a CTA — that button is the video's only clickable destination). */
export function safeCta(raw: string): string {
  const v = String(raw ?? "").trim().toUpperCase();
  return CTA_VALUES.has(v) ? v : "LEARN_MORE";
}

const COMPLIANCE = `Facebook/TikTok ad-policy envelope — the ad points at an educational article:
- Brand-neutral: never name/imply a company, brand, product, government program/agency or public figure.
- No promises/guarantees (income, approval, results, savings, cures, weight loss). No urgency/scarcity/fear.
- No personal-attribute callouts ("your debt", "since you're over 50"). Speak of "many people"/"households".
- Hedged, curiosity-honest, NOT sensational or clickbait. It is an article, not an offer.`;

/** The prompt that turns a landing into compliant ad copy + a creative scene. */
export function buildAdCopyPrompt(l: LaunchLanding): string {
  const langLine =
    l.lang === "es"
      ? "Write primaryText, headline and description in neutral Latin-American Spanish."
      : "Write primaryText, headline and description in clear plain English.";
  const angle = l.angle ? `\nUnderlying angle: ${l.angle}` : "";
  return `You write Facebook feed ad copy that drives clicks to an independent educational guide article.
Article title: "${l.title}${l.subtitle ? " — " + l.subtitle : ""}" (niche: ${l.niche}).${angle}
${langLine}
${COMPLIANCE}

Return JSON:
- primaryText: the feed post text, 1-2 short sentences (max ~180 chars), curiosity-driven but honest, no emoji spam (0-1 emoji ok).
- headline: the bold headline under the image, max 40 chars, no ALL CAPS, no year/number guarantees.
- description: one short supporting line, max 30 chars (news-desk tone).
- cta: ONE of exactly these button values — LEARN_MORE, SEE_MORE, GET_QUOTE, SIGN_UP, APPLY_NOW, SHOP_NOW, GET_OFFER, SUBSCRIBE, DOWNLOAD, BOOK_TRAVEL, CONTACT_US, ORDER_NOW. Pick the most natural for an article (usually LEARN_MORE or SEE_MORE).
- imagePrompt: ONE vivid sentence (~30-45 words) describing a 16:9 photographic/editorial ad image whose MAIN SUBJECT literally embodies THIS article's topic. Name the medium first ("modern editorial photograph"...). Tasteful, premium, brand-safe. Health/weight topics: NO human bodies — use objects/still-life/metaphor. Never text, logos, brands, UI screens or recognizable people in the scene.`;
}

/** The full image-generation prompt (the model-written scene + the fixed full-bleed/no-text envelope). */
export function buildImagePrompt(scene: string, fallbackTopic: string): string {
  const s = scene && scene.trim().length > 20 ? scene.trim() : `A premium editorial photograph representing "${fallbackTopic}"`;
  return (
    `${s} FULL-BLEED wide 16:9 ad image: the scene fills the ENTIRE frame edge to edge, no borders, ` +
    `no letterboxing. High-end professional advertising quality, sharp focus, natural lighting, ` +
    `cohesive limited color palette, depth and atmosphere, tasteful and uncluttered. Absolutely NO ` +
    `text, words, letters, numbers, captions, logos, watermarks, brand marks, UI screenshots or ` +
    `recognizable people anywhere in the image.`
  );
}

/** Sanitize + length-clamp the model's ad copy into wire-safe values. */
export function normalizeAdCopy(a: Partial<AdCopy>): AdCopy {
  const str = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
  const primaryText = str(a.primaryText, 500);
  const headline = str(a.headline, 60);
  return {
    primaryText: primaryText || "See what many people are learning about this.",
    headline: headline || "Read the full guide",
    description: str(a.description, 60),
    cta: safeCta(String(a.cta ?? "")),
    imagePrompt: str(a.imagePrompt, 700),
  };
}

export type AutoCampaignDefaults = {
  /** DD.MM for the fixed name prefix (Kyiv "today" — the launcher's convention). */
  ddmm: string;
  /** Suffix the buyer sees after "[DD/MM] (MO) - " (soc marker is added server-side at fire). */
  nameSuffix: string;
  countries: string[];
  budget: string;
  accountId: string;
  pixelId: string;
  pageId: string;
};

/**
 * Assemble the MO Campaign a launch will fire. Field-for-field aligned with lib/fb-launch payload
 * builders and the /api/launch validators: lowest-cost + conversions + PURCHASE (so the link carries
 * &fire=click and the funnel reports Purchase on the banner click), landing = the auto slug, gcm ""
 * (the launch route claims it), one image creative attached by the route.
 */
export function buildAutoCampaign(landing: LaunchLanding, copy: AdCopy, d: AutoCampaignDefaults): Campaign {
  const mo = partnerConfig("in");
  const base = makeCampaign(`auto-${landing.slug}`.slice(0, 40), namePrefixFor(mo, d.ddmm), d.nameSuffix);
  return {
    ...base,
    account: d.accountId,
    page: d.pageId,
    pixel: d.pixelId,
    objective: "OUTCOME_SALES",
    bidStrategy: "LOWEST_COST_WITHOUT_CAP",
    conversionEvent: "PURCHASE",
    optimization: "conversions",
    budget: d.budget,
    bidCap: "",
    copy: copy.primaryText,
    headline: copy.headline,
    title: copy.description,
    cta: copy.cta,
    landing: landing.slug,
    gcm: "",
    countries: d.countries.length ? d.countries : ["US"],
    locales: [],
    category: "",
    placement: "FULL",
    ageMin: "18",
    userOs: "all",
  };
}

/** Default geo for a landing's language (the MO funnel is US-first; ES also targets US Hispanic). */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the geo may split by language later
export function defaultCountriesFor(lang: "en" | "es"): string[] {
  return ["US"];
}
