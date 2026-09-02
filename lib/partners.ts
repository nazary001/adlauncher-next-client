import type { ComponentType, SVGProps } from "react";
import { BrazilFlag, IndiaFlag, UsaFlag } from "@/components/icons";
import type { Campaign } from "./types";
import { bidKind } from "./types";

export type Bound = { id: string; name: string };

export type PartnerId = "br" | "in" | "us";

export type Landing = {
  slug: string;
  title: string;
  lang: "EN" | "ES";
  /** Niche section the landing picker groups under (Cars / Loans / MK Digital / …). */
  niche: string;
};

export type PartnerConfig = {
  id: PartnerId;
  label: string;
  Flag: ComponentType<SVGProps<SVGSVGElement>>;
  /** Indians (MagicAds/MagicBid) monetize by gcm marker → show landing + gcm block. */
  usesGcm: boolean;
  /** LION anti-detect profiles (Brazilians). Indians launch straight via Graph API — no profile. */
  usesProfile: boolean;
  /** Hardcoded naming tier — when set, new campaigns get a fixed prefix "[DD.MM] - (tier) - ". */
  nameTier?: string;
  /** Base for the destination link; slug is appended as `${base}/${slug}?gcm=NN`. */
  landingBase: string;
  landings: Landing[];
  /** Label + catalog for the page-binding field. Indians call these "fanky" (fanpages). */
  pageLabel: string;
  pagePlaceholder: string;
  /** Static fanpage catalog (LION partners). Empty when fanpages come from the token instead. */
  fanpages: string[];
  /** Fanpages are the launch token's own assigned pages (GET /api/fanpages) — the buyer PICKS one
   *  per campaign/clone (stored as the page ID in `Campaign.page` / `CloneEdit.pageId`), and the
   *  server validates the id against the same token list. Indians since the system-user token. */
  fanpagesFromToken?: boolean;
  /** Ad accounts are the launch token's own ACTIVE accounts (GET /api/adaccounts) — the buyer
   *  PICKS one per campaign (`Campaign.account` stores the account_id digits); the pixel field
   *  offers that account's own pixels. Server-validated against the same token data. */
  accountsFromToken?: boolean;
  /** Prefill for token-account partners: the account new cards default to (when still on the
   *  token) and the pixel auto-picked when the chosen account carries it. */
  defaultAccount?: Bound;
  preferredPixel?: Bound;
  /** redirectType a fresh card is born with (overrides makeCampaign's global default). */
  defaultRedirect?: string;
  /** When set, the flow is pinned to a single account/pixel — fields render locked. */
  lockedAccount?: Bound;
  lockedPixel?: Bound;
  /** Caption under the launch button naming the submit channel. Indians go straight through
   *  the Graph API; LION (anti-detect profiles) is a Brazilians/Americans concept. */
  launchNote: string;
  /** Launches submit to the LION create weapon (HS): profile/account/page/pixel cascade comes
   *  from LION, the name follows LION's validated format, creatives are public URLs (one ad per
   *  URL) and an independent HS task manager tracks the LION-side creation. */
  lionLaunch?: boolean;
  /** Airfind Rewarded Web (AIF): MO-style direct Graph launch on the AIF token, but the ad link
   *  is the partner's RW page (destination = a free-typed article slug) carrying a brand marker
   *  from the test01..test700 pool (the revenue key — one brand per campaign, own registry).
   *  Conversions arrive via the postback→CAPI forwarder into the AIF pixel, so conversion
   *  launches pin that pixel + Purchase; min-ROAS rides the SAME derived pixel (enabled
   *  2026-08-21 — floors only bite once the forwarder sends real purchase values). */
  aifLaunch?: boolean;
  /** Not built out yet → the switcher renders this partner disabled ("in development"). */
  inDevelopment?: boolean;
  /** Meta's per-Page ad-limit tier for the bound fanpage. The Graph API returns the live
   *  "ads running or in review" count but not this ceiling, so it's configured. Default = 250. */
  pageAdLimit?: number;
  /** Max creatives per campaign card. Indians = 1 (one video per ad). Undefined = unlimited. */
  maxCreatives?: number;
};

// MK Learn guides = the landings paid traffic is sent to. Slug → /guides/<slug>.
// Funnel domain is the MagicAds-monetized host (ads.js lives there), not the SEO host.
// Ordered by niche — the picker emits a section header whenever `niche` changes.
const MKLEARN_LANDINGS: Landing[] = [
  { slug: "auto-financing-explained", title: "Auto Financing Explained", lang: "EN", niche: "Cars" },
  { slug: "financiamiento-de-auto", title: "Financiamiento de auto", lang: "ES", niche: "Cars" },
  { slug: "personal-loans", title: "Personal Loans Explained", lang: "EN", niche: "Loans" },
  { slug: "personal-lending-and-investment", title: "Personal Lending & Investment", lang: "EN", niche: "Loans" },
  { slug: "digital-marketing-skills-course", title: "Digital Marketing Skills Course", lang: "EN", niche: "MK Digital" },
  { slug: "curso-marketing-digital", title: "Curso de Marketing Digital", lang: "ES", niche: "MK Digital" },
  { slug: "affiliate-marketing-basics-course", title: "Affiliate Marketing Basics", lang: "EN", niche: "MK Digital" },
  { slug: "ai-marketing-tools-course", title: "AI Marketing Tools Course", lang: "EN", niche: "MK Digital" },
  { slug: "copywriting-content-marketing-course", title: "Copywriting & Content Marketing", lang: "EN", niche: "MK Digital" },
  { slug: "ecommerce-marketing-course", title: "E-commerce Marketing Course", lang: "EN", niche: "MK Digital" },
  { slug: "email-marketing-mastery-course", title: "Email Marketing Mastery", lang: "EN", niche: "MK Digital" },
  { slug: "freelance-digital-marketing-career", title: "Freelance Digital Marketing Career", lang: "EN", niche: "MK Digital" },
  { slug: "marketing-analytics-course", title: "Marketing Analytics Course", lang: "EN", niche: "MK Digital" },
  { slug: "paid-search-advertising-course", title: "Paid Search Advertising Course", lang: "EN", niche: "MK Digital" },
  { slug: "seo-fundamentals-course", title: "SEO Fundamentals Course", lang: "EN", niche: "MK Digital" },
  { slug: "social-media-marketing-course", title: "Social Media Marketing Course", lang: "EN", niche: "MK Digital" },
  { slug: "high-paying-jobs-short-training", title: "High-Paying Jobs, Short Training", lang: "EN", niche: "Jobs" },
  { slug: "profesiones-bien-pagadas-en-semanas", title: "Profesiones bien pagadas en semanas", lang: "ES", niche: "Jobs" },
  { slug: "jobs-30-an-hour-no-degree", title: "Jobs $30+/Hour, No Degree", lang: "EN", niche: "Jobs" },
  { slug: "empleos-30-por-hora-sin-titulo", title: "Empleos $30+/hora sin título", lang: "ES", niche: "Jobs" },
  { slug: "fastest-growing-job-in-america", title: "Fastest-Growing Job in America", lang: "EN", niche: "Jobs" },
  { slug: "profesion-que-mas-crece-en-eeuu", title: "Profesión que más crece en EE. UU.", lang: "ES", niche: "Jobs" },
  { slug: "jobs-employers-cant-fill", title: "Jobs Employers Can't Fill", lang: "EN", niche: "Jobs" },
  { slug: "empleos-que-no-logran-cubrir", title: "Empleos que no logran cubrir", lang: "ES", niche: "Jobs" },
  { slug: "no-degree-jobs-hiring-fastest", title: "No-Degree Jobs Hiring Fastest", lang: "EN", niche: "Jobs" },
  { slug: "empleos-sin-diploma-que-mas-contratan", title: "Empleos sin diploma que más contratan", lang: "ES", niche: "Jobs" },
  { slug: "paying-twice-for-netflix", title: "Paying Twice for Netflix", lang: "EN", niche: "Streaming" },
  { slug: "retiree-health-coverage", title: "Retiree Health Coverage", lang: "EN", niche: "Health" },
  { slug: "nighttime-habit-ruining-your-sleep", title: "Nighttime Habit Ruining Your Sleep", lang: "EN", niche: "Health" },
  { slug: "doctors-recommend-this-before-its-too-late", title: "Doctors Recommend Before It's Too Late", lang: "EN", niche: "Health" },
  { slug: "habito-nocturno-arruina-tu-sueno", title: "Hábito nocturno que arruina tu sueño", lang: "ES", niche: "Health" },
  { slug: "medicos-recomiendan-antes-de-que-sea-tarde", title: "Médicos recomiendan antes de que sea tarde", lang: "ES", niche: "Health" },
  { slug: "free-12-week-weight-loss-plan", title: "Free 12-Week Weight-Loss Plan", lang: "EN", niche: "Health" },
  { slug: "never-do-this-on-a-plane", title: "Never Do This on a Plane", lang: "EN", niche: "Travel" },
  { slug: "secret-code-in-your-passport", title: "Secret Code in Your Passport", lang: "EN", niche: "Travel" },
  { slug: "hidden-rooms-on-cruise-ships", title: "Hidden Rooms on Cruise Ships", lang: "EN", niche: "Travel" },
  { slug: "never-book-this-cruise-cabin", title: "Never Book This Cruise Cabin", lang: "EN", niche: "Travel" },
  { slug: "what-hotel-staff-never-tell-guests", title: "What Hotel Staff Never Tell Guests", lang: "EN", niche: "Travel" },
  { slug: "secretos-del-personal-de-hotel", title: "Secretos del personal de hotel", lang: "ES", niche: "Travel" },
  { slug: "veneers-implants-abroad", title: "Veneers & Implants Abroad", lang: "EN", niche: "Dental" },
  { slug: "flew-abroad-for-new-teeth", title: "Flew Abroad for New Teeth", lang: "EN", niche: "Dental" },
  { slug: "world-capital-of-cheap-dentistry", title: "World Capital of Cheap Dentistry", lang: "EN", niche: "Dental" },
  { slug: "paid-to-film-your-cleaning", title: "Paid to Film Your Cleaning", lang: "EN", niche: "Side Gigs" },
  { slug: "dermatologists-ditching-this-popular-product", title: "Dermatologists Ditching This Product", lang: "EN", niche: "Beauty" },
  { slug: "dermatologos-abandonan-este-producto", title: "Dermatólogos abandonan este producto", lang: "ES", niche: "Beauty" },
  { slug: "hidden-sign-your-house-has-a-problem", title: "Hidden Sign Your House Has a Problem", lang: "EN", niche: "Home" },
  { slug: "senal-oculta-problema-en-tu-casa", title: "Señal oculta de problema en tu casa", lang: "ES", niche: "Home" },
  { slug: "luggage-no-one-claims-at-the-airport", title: "Luggage No One Claims", lang: "EN", niche: "Auctions" },
  { slug: "millions-of-packages-never-claimed", title: "Packages Never Claimed", lang: "EN", niche: "Auctions" },
  { slug: "confiscated-cars-sold-at-auction", title: "Confiscated Cars at Auction", lang: "EN", niche: "Auctions" },
  { slug: "strangest-finds-in-unclaimed-luggage", title: "Strangest Unclaimed Luggage Finds", lang: "EN", niche: "Auctions" },
  { slug: "what-your-dreams-are-telling-you", title: "What Your Dreams May Be Telling You", lang: "EN", niche: "Self-Discovery" },
  { slug: "significado-de-tus-suenos", title: "Significado de tus sueños", lang: "ES", niche: "Self-Discovery" },
  { slug: "zodiac-sign-compatibility", title: "Zodiac Sign Compatibility", lang: "EN", niche: "Self-Discovery" },
  { slug: "compatibilidad-de-signos", title: "Compatibilidad de signos", lang: "ES", niche: "Self-Discovery" },
  { slug: "pick-a-tarot-card", title: "Pick a Tarot Card", lang: "EN", niche: "Self-Discovery" },
  { slug: "elige-una-carta-de-tarot", title: "Elige una carta de tarot", lang: "ES", niche: "Self-Discovery" },
  { slug: "sun-moon-rising-signs", title: "Sun, Moon & Rising Signs", lang: "EN", niche: "Self-Discovery" },
  { slug: "sol-luna-y-ascendente", title: "Sol, Luna y ascendente", lang: "ES", niche: "Self-Discovery" },
  { slug: "why-you-keep-seeing-11-11", title: "Why You Keep Seeing 11:11", lang: "EN", niche: "Self-Discovery" },
  { slug: "por-que-ves-11-11", title: "Por qué ves 11:11", lang: "ES", niche: "Self-Discovery" },
];

// Indians defaults: the token sees the ACTIVE GC-Magicoffers-BR-* accounts — the ACCOUNT is
// picked per campaign (/api/adaccounts), defaulting to BR-1500. Pixel policy (owner, 2026-08-11):
// bid/lowest launches keep a free pixel CHOICE but default to "GC for MO Pixel" (shared to every
// account; the buy link carries &pixel=<id> so the funnel fires whichever is picked), while
// min-ROAS is PINNED to ROAS_PIXEL below. HS-Pixel-FARM-1 (the funnel's original tracking pixel,
// BR-1500 only) stays selectable by hand.
const MAGICOFFERS_ACCOUNT: Bound = { id: "1297336295903991", name: "GC-Magicoffers-BR-1500" };
const MO_DEFAULT_PIXEL: Bound = { id: "3075610185982313", name: "GC for MO Pixel" };

/** The ONLY pixel min-ROAS launches may optimize on (owner rule 2026-08-11): the partner's HS
 *  value pixel — real purchase-value history, shared to every MO account and live-probed
 *  VO-eligible on 08-11. Everything else (never-fired GC-for-MO, FARM-1) is rejected for ROAS
 *  even where technically eligible. Enforced in the card (pin + readiness), /api/launch and
 *  /api/clone/run. */
export const ROAS_PIXEL: Bound = { id: "4367956310124642", name: "VD-C1-HS-1" };

// ---- AIF (Airfind "Google Rewarded Web") ----------------------------------------------------
// Link contract from the partner's implementation guide (GC-coding/AIF, 2026-08): traffic goes to
// the RW page with our clientId, a brand marker for revenue segmentation and the article slug in
// `destination`. `ppid={{campaign.id}}` is ours: the RW page echoes every query param into the
// postback (→ our CAPI forwarder), so the macro auto-ties each conversion to its campaign and
// feeds the partner's click-spam report. FB appends fbclid itself.
export const AIF_RW_BASE = "https://content.honeyandhues.com/rewarded";
export const AIF_CLIENT_ID = "52105";
/** Derive the AIF conversion pixel from an ACCOUNT'S OWN pixel list (pulled via the AIF token —
 *  owner ask 2026-09-02: no hardcoded pixel id anywhere; the id and even the pixel's name have
 *  already drifted once). Every AIF cabinet carries exactly the one postback pixel the CAPI
 *  forwarder lands Purchases on; should extras ever get shared, a unique AIF-named one still
 *  wins. null = underivable (no pixels, or several with no single AIF name) — conversion
 *  launches must refuse rather than guess where Purchase optimization lands. Pure and shared:
 *  the card derives its display from the picker catalog, the server re-derives from the same
 *  token data at launch (lib/aif-launch aifDerivedPixel — the truth). */
export function pickAifPixel(pixels: Bound[]): Bound | null {
  if (pixels.length === 1) return pixels[0];
  const aifNamed = pixels.filter((p) => /aif/i.test(p.name));
  return aifNamed.length === 1 ? aifNamed[0] : null;
}
/** Brand pool test01..test700 (partner-assigned): 1–9 keep the doc's 2-digit zero-padded shape
 *  ("test01"), 10+ are plain. One brand = one buy campaign — the registry enforces it. */
export const AIF_POOL_MAX = 700;
export const aifBrandCode = (n: number): string => `test${String(n).padStart(2, "0")}`;
/** Normalize a pasted article reference to the bare slug the RW `destination` param takes
 *  (doc example: `destination=best-family-pets`): a full path/URL like
 *  "https://content.honeyandhues.com/article/foo" or "/article/foo" reduces to "foo", then
 *  everything a slug can't carry (spaces, slashes, query junk) is stripped. */
export const aifSlugSanitize = (raw: string): string =>
  raw
    .trim()
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/^\/?article\//i, "")
    .replace(/^\/+/, "")
    .replace(/[^\w-]/g, "");

// The partner's standard article catalog (owner list 2026-08-18, pasted as /article/<slug>
// paths — `destination` takes the BARE slug per the implementation guide). Ordered by niche:
// the picker emits a section header whenever `niche` changes, so groups must stay contiguous.
const AIF_LANDINGS: Landing[] = [
  { slug: "daily-mobile-game-reward-tips", title: "Daily Mobile Game Reward Tips", lang: "EN", niche: "Mobile Games" },
  { slug: "mobile-games-how-to-earn-more-gems-for-free", title: "How to Earn More Gems for Free", lang: "EN", niche: "Mobile Games" },
  { slug: "how-to-get-more-free-rewards-on-mobile-games", title: "Get More Free Rewards on Mobile Games", lang: "EN", niche: "Mobile Games" },
  { slug: "free-daily-mobile-games-reward-tips", title: "Free Daily Mobile Games Reward Tips", lang: "EN", niche: "Mobile Games" },
  { slug: "watch-ads-to-earn-free-rewards-on-mobile-games", title: "Watch Ads to Earn Free Rewards", lang: "EN", niche: "Mobile Games" },
  { slug: "daily-mobile-games-free-reward-tips", title: "Daily Mobile Games Free Reward Tips", lang: "EN", niche: "Mobile Games" },
  { slug: "watch-free-videos-to-make-money-online", title: "Watch Free Videos to Make Money Online", lang: "EN", niche: "Make Money" },
  { slug: "best-apps-that-pay-you-for-your-opinion", title: "Best Apps That Pay for Your Opinion", lang: "EN", niche: "Make Money" },
  { slug: "make-money-online", title: "Make Money Online", lang: "EN", niche: "Make Money" },
  { slug: "credit-card-point-transfer-partner-sweet-spots", title: "Credit Card Point Transfer Sweet Spots", lang: "EN", niche: "Finance" },
  { slug: "pre-approval-tool-stacking-and-instant-virtual-card-access", title: "Pre-Approval Stacking & Instant Virtual Cards", lang: "EN", niche: "Finance" },
  { slug: "the-anti-budget-method-and-cash-flow-automation", title: "The Anti-Budget Method & Cash Flow Automation", lang: "EN", niche: "Finance" },
  { slug: "automated-lifestyle-creep-protection-and-low-cost-index-funds", title: "Lifestyle Creep Protection & Index Funds", lang: "EN", niche: "Finance" },
  // "habbits" [sic] — the slug is the partner's live URL, typo included.
  { slug: "wealth-building-habbits", title: "Wealth Building Habits", lang: "EN", niche: "Finance" },
  { slug: "no-code-web-integration-and-client-site-building", title: "No-Code Web Integration & Client Sites", lang: "EN", niche: "AI & Tech" },
  { slug: "ai-workflow-automation-for-small-businesses", title: "AI Workflow Automation for Small Businesses", lang: "EN", niche: "AI & Tech" },
  { slug: "the-multi-agent-economy-and-running-local-llms", title: "The Multi-Agent Economy & Local LLMs", lang: "EN", niche: "AI & Tech" },
  { slug: "skill-verification-and-micro-credentials-vs-traditional-degrees", title: "Micro-Credentials vs Traditional Degrees", lang: "EN", niche: "Education" },
  { slug: "assisted-living-for-seniors", title: "Assisted Living for Seniors", lang: "EN", niche: "Lifestyle" },
  { slug: "these-2026-bathroom-design-features-are-getting-attention", title: "2026 Bathroom Design Features", lang: "EN", niche: "Lifestyle" },
];

export const PARTNERS: PartnerConfig[] = [
  {
    id: "br",
    label: "HS",
    Flag: BrazilFlag,
    usesGcm: false,
    usesProfile: true,
    lionLaunch: true,
    landingBase: "",
    landings: [],
    pageLabel: "Page",
    pagePlaceholder: "Search page",
    fanpages: [],
    launchNote: "Submits through LION",
    pageAdLimit: 250,
    // HS launches default to the HIGH-ADX redirect (owner call 08-13) — META ADX stays pickable.
    defaultRedirect: "HIGH ADX",
    // HS ships DORMANT on prod: the switcher unlocks only where NEXT_PUBLIC_HS_ENABLED=1 is
    // baked into the build (.env.local locally; NOT set on Vercel until the LION_* env and a
    // battle smoke land). NEXT_PUBLIC_* is inlined at build time — enabling HS on prod means
    // setting the env var and redeploying, no code change.
    inDevelopment: process.env.NEXT_PUBLIC_HS_ENABLED !== "1",
  },
  {
    id: "in",
    label: "MO",
    Flag: IndiaFlag,
    usesGcm: true,
    usesProfile: false,
    nameTier: "t1",
    landingBase: "https://finance.magicoffers.shop/guides",
    landings: MKLEARN_LANDINGS,
    pageLabel: "Fanpage",
    pagePlaceholder: "Search fanpage",
    fanpages: [],
    fanpagesFromToken: true,
    accountsFromToken: true,
    defaultAccount: MAGICOFFERS_ACCOUNT,
    preferredPixel: MO_DEFAULT_PIXEL,
    launchNote: "Submits directly via Graph API",
    pageAdLimit: 250,
    // Up to 5 creatives per campaign (owner ask 08-20): one campaign → one ad set → one ad per
    // creative, same tree shape as the HS token rail. Files ride through the Blob broker
    // (500MB/video ceiling, images pre-validated ≤8MB) — never through a function body.
    maxCreatives: 5,
  },
  {
    id: "us",
    label: "AIF",
    Flag: UsaFlag,
    usesGcm: false,
    aifLaunch: true,
    usesProfile: false,
    nameTier: "aif",
    landingBase: AIF_RW_BASE,
    landings: AIF_LANDINGS,
    pageLabel: "Fanpage",
    pagePlaceholder: "Search fanpage",
    fanpages: [],
    fanpagesFromToken: true,
    accountsFromToken: true,
    launchNote: "Submits via the AIF token",
    pageAdLimit: 250,
    maxCreatives: 1,
    // AIF ships DORMANT on prod, same pattern as HS: the switcher unlocks only where
    // NEXT_PUBLIC_AIF_ENABLED=1 is baked into the build (.env.local locally; not set on Vercel
    // until the FB_AIF_LAUNCH_TOKEN env and a battle smoke land).
    inDevelopment: process.env.NEXT_PUBLIC_AIF_ENABLED !== "1",
  },
];

export function partnerConfig(id: PartnerId): PartnerConfig {
  return PARTNERS.find((p) => p.id === id) ?? PARTNERS[0];
}

/** URL ?partner= → a partner id the switcher can actually be on: unknown values and
 *  in-development partners fall back to MO. Shared by the launcher and clone pages so a
 *  refresh keeps the picked partner instead of snapping back to MO. */
export function sanitizePartnerId(raw: unknown): PartnerId {
  const id = Array.isArray(raw) ? raw[0] : raw;
  const p = PARTNERS.find((x) => x.id === String(id ?? ""));
  return p && !p.inDevelopment ? p.id : "in";
}

/** Readiness requirements for a partner — single source for the card dot, the Launch bay and the
 *  launch filter, so a campaign can never count as "ready" while missing a required fanka,
 *  account or pixel. */
export function launchReadyOpts(p: PartnerConfig): {
  landing: boolean;
  profile: boolean;
  page: boolean;
  account: boolean;
  pixel: boolean;
  gcm: boolean;
  link: boolean;
  adText: boolean;
  roasPixel: string;
} {
  return {
    // AIF reuses the landing slot for its free-typed destination slug — required all the same.
    landing: p.usesGcm || Boolean(p.aifLaunch),
    profile: p.usesProfile,
    page: Boolean(p.fanpagesFromToken) || Boolean(p.lionLaunch),
    account: Boolean(p.accountsFromToken) || Boolean(p.lionLaunch),
    // AIF's pixel is DERIVED (conversions → pinned AIF pixel, clicks → none), never picked —
    // requiring it would dead-lock click cards whose pixel is legitimately empty.
    pixel: (Boolean(p.accountsFromToken) && !p.aifLaunch) || Boolean(p.lionLaunch),
    // Marker-pool partners (MO gcm / AIF brand) need a claimed code before the card counts as
    // ready — a card whose code hasn't loaded (registry unreachable / pre-load window) must not
    // look launchable, and Copy must not offer a link with an empty marker.
    gcm: p.usesGcm || Boolean(p.aifLaunch),
    // LION builds ads from the typed destination link + title/copy — all hard-required by create/.
    link: Boolean(p.lionLaunch),
    adText: Boolean(p.lionLaunch),
    // Min-ROAS pins the partner's value pixel: MO → VD-C1-HS-1. AIF's pixel is DERIVED from the
    // token's account data at launch (aifDerivedPixel) — no id to pin here; LION partners
    // validate pixels their own way.
    roasPixel: p.accountsFromToken && !p.aifLaunch ? ROAS_PIXEL.id : "",
  };
}

/** Fixed naming prefix for a new campaign — non-editable in the card; the buyer types only the
 *  suffix (defaulting to their username). Owner format 2026-08-18: `[DD/MM] (MO) - ` /
 *  `[DD/MM] (AIF) - ` — LION-style slash date + the partner LABEL. nameTier stays a link
 *  concern only (MO's `utm_medium=t1`). Empty when the partner has no tier (HS builds its own
 *  LION-grammar prefix). */
export function namePrefixFor(p: PartnerConfig, ddmm: string): string {
  return p.nameTier ? `[${ddmm.replace(".", "/")}] (${p.label}) - ` : "";
}

/** FB macros must stay literal (unencoded), so the URL is built by hand, not URLSearchParams. */
const FB_MACROS = "&utm_campaign={{campaign.id}}&utm_term={{adset.id}}&utm_content={{ad.id}}";

/** A plausible Meta pixel id (matches the funnel's own guard). */
const isPixelId = (v?: string): v is string => !!v && /^\d{10,20}$/.test(v);

/** Role of a link segment — drives the color in the tracking-link preview. */
export type LinkRole = "base" | "slug" | "gcmKey" | "gcm" | "params" | "fire" | "pixel";
export type LinkSegment = { text: string; role: LinkRole };

/**
 * The destination link as ORDERED, role-tagged segments — the single source of truth for both the
 * launched URL (fullLandingUrl joins them) and the card's colored preview (colors each role), so
 * the preview can never drift from the real link again. Shape (per owner, 2026-08-04):
 *   {base}/{slug}?gcm=NN&utm_source=facebook&utm_medium={tier}&utm_campaign={{campaign.id}}
 *     &utm_term={{adset.id}}&utm_content={{ad.id}}[&fire=click][&pixel=<id>]
 * `fire=click` is appended for conversion campaigns (Purchase on the banner click). `pixel=<id>`
 * tells the funnel which Meta pixel to fire — the campaign's chosen pixel, so the conversion lands
 * on the same pixel the adset optimizes for (funnel defaults to its original pixel when omitted).
 */
export function landingUrlSegments(
  p: PartnerConfig,
  slug: string,
  gcm: string,
  conversions: boolean,
  pixel?: string,
): LinkSegment[] {
  if (!slug) return [];
  // AIF: the partner's RW page with the doc's exact params — destination slug, our clientId, the
  // brand marker (revenue key, rides the shared `gcm` slot) and the campaign.id macro the page
  // echoes into the postback. No fire/pixel params: the conversion side lives in the postback→
  // CAPI forwarder, not on the landing.
  if (p.aifLaunch) {
    return [
      { text: `${p.landingBase}?destination=`, role: "base" },
      { text: slug, role: "slug" },
      { text: `&clientId=${AIF_CLIENT_ID}`, role: "params" },
      { text: "&brand=", role: "gcmKey" },
      { text: gcm, role: "gcm" },
      { text: "&ppid={{campaign.id}}", role: "params" },
    ];
  }
  const medium = p.nameTier ? `&utm_medium=${p.nameTier}` : "";
  const segs: LinkSegment[] = [
    { text: `${p.landingBase}/`, role: "base" },
    { text: slug, role: "slug" },
    { text: "?gcm=", role: "gcmKey" },
    { text: gcm, role: "gcm" },
    { text: `&utm_source=facebook${medium}${FB_MACROS}`, role: "params" },
  ];
  if (conversions) segs.push({ text: "&fire=click", role: "fire" });
  if (isPixelId(pixel)) segs.push({ text: `&pixel=${pixel}`, role: "pixel" });
  return segs;
}

/** Full destination link the ad points to — assembled from the segments (one source of truth). */
export function fullLandingUrl(
  p: PartnerConfig,
  slug: string,
  gcm: string,
  conversions: boolean,
  pixel?: string,
): string {
  const segs = landingUrlSegments(p, slug, gcm, conversions, pixel);
  return segs.length ? segs.map((s) => s.text).join("") : "";
}

/** Pin account/pixel/fanpage to the partner's single bound values (Indians), and keep AIF cards
 *  on their derived invariants: the pixel is derived server-side from the token's account data
 *  at launch (never stored on the card), the objective/event are pinned to SALES/Purchase (the
 *  only event the CAPI forwarder ever sends), and min-ROAS pins conversions (purchase-value
 *  optimization — same recipe as MO, enabled 2026-08-21).
 *  Pure and idempotent; covers fresh, duplicated, copy-to-all'ed and restored cards alike. */
export function applyPartnerLocks(rows: Campaign[], p: PartnerConfig): Campaign[] {
  const acct = p.lockedAccount?.name;
  const px = p.lockedPixel?.id; // pixel is identified by its numeric id, not its text name
  const fan = p.fanpages.length === 1 ? p.fanpages[0] : undefined;
  if (!acct && !px && !fan && !p.aifLaunch) return rows;
  let changed = false;
  const next = rows.map((r) => {
    const patch: Partial<Campaign> = {};
    if (acct && r.account !== acct) patch.account = acct;
    if (px && r.pixel !== px) patch.pixel = px;
    if (fan && r.page !== fan) patch.page = fan;
    if (p.aifLaunch) {
      // Min-ROAS always optimizes purchase VALUE — the optimization pins to conversions (the
      // card disables the select; this converges restored/copied drafts too).
      const roas = bidKind(r.bidStrategy) === "roas";
      if (roas && r.optimization !== "conversions") patch.optimization = "conversions";
      // The pixel is DERIVED server-side from the token's account data at launch — never stored
      // on the card. Clearing converges old drafts that carried the once-hardcoded id.
      if (r.pixel !== "") patch.pixel = "";
      if (r.objective !== "OUTCOME_SALES") patch.objective = "OUTCOME_SALES";
      if (r.conversionEvent !== "PURCHASE") patch.conversionEvent = "PURCHASE";
    }
    if (Object.keys(patch).length === 0) return r;
    changed = true;
    return { ...r, ...patch };
  });
  return changed ? next : rows;
}

/** The MagicAds gcm marker pool: codes 1..200 (widened from 99 per partner, 2026-08-10). */
export const GCM_POOL_MAX = 200;

/** Canonical form of a pool code: 1–99 stay 2-digit zero-padded ("01".."99" — every live link and
 *  registry row uses that shape), 100–200 are plain 3-digit. */
export const gcmCode = (n: number): string => String(n).padStart(2, "0");

/** A partner's revenue-marker pool: the codes that segment partner revenue per campaign, claimed
 *  atomically from a Strapi registry. MO = gcm 01..200, AIF = brand test01..test700. The two code
 *  shapes can never collide, but each partner previews/claims strictly from its own registry. */
export type MarkerPool = {
  /** What the code is called in UI copy ("gcm" / "brand"). */
  label: string;
  max: number;
  code: (n: number) => string;
  /** Board preview endpoint answering { used, next, poolMax }. */
  api: string;
};
export const GCM_POOL: MarkerPool = { label: "gcm", max: GCM_POOL_MAX, code: gcmCode, api: "/api/gcm" };
export const AIF_POOL: MarkerPool = { label: "brand", max: AIF_POOL_MAX, code: aifBrandCode, api: "/api/aif/brand" };

/** The marker pool a partner assigns from (null = partner has no marker concept, e.g. HS). */
export function markerPool(p: PartnerConfig): MarkerPool | null {
  return p.usesGcm ? GCM_POOL : p.aifLaunch ? AIF_POOL : null;
}

/**
 * Fill the lowest free pool code for landing-having campaigns missing one (the shared `gcm` slot
 * carries the marker for both MO codes and AIF brands). `reserved` = codes already taken in that
 * partner's Strapi registry. While it's null (not loaded yet) NOTHING is assigned — never hand
 * out a code that might already be live. The batch also avoids reusing a code across two
 * campaigns in the same session.
 */
export function assignPoolCodes<T extends { landing: string; gcm: string }>(
  rows: T[],
  reserved: Set<string> | null,
  pool: MarkerPool = GCM_POOL,
): T[] {
  if (!reserved) return rows;
  const used = new Set<string>(reserved);
  for (const r of rows) if (r.gcm) used.add(r.gcm);
  let changed = false;
  const next = rows.map((r) => {
    if (!r.landing || r.gcm) return r;
    let code = "";
    for (let n = 1; n <= pool.max; n++) {
      const c = pool.code(n);
      if (!used.has(c)) {
        code = c;
        break;
      }
    }
    if (!code) return r;
    used.add(code);
    changed = true;
    return { ...r, gcm: code };
  });
  return changed ? next : rows;
}
