import type { ComponentType, SVGProps } from "react";
import { BrazilFlag, IndiaFlag, UsaFlag } from "@/components/icons";
import type { Campaign } from "./types";

export type Bound = { id: string; name: string };

export type PartnerId = "br" | "in" | "us";

export type Landing = {
  slug: string;
  title: string;
  lang: "EN" | "ES";
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
const MKLEARN_LANDINGS: Landing[] = [
  { slug: "auto-financing-explained", title: "Auto Financing Explained", lang: "EN" },
  { slug: "financiamiento-de-auto", title: "Financiamiento de auto", lang: "ES" },
  { slug: "personal-loans", title: "Personal Loans Explained", lang: "EN" },
  { slug: "personal-lending-and-investment", title: "Personal Lending & Investment", lang: "EN" },
  { slug: "digital-marketing-skills-course", title: "Digital Marketing Skills Course", lang: "EN" },
  { slug: "curso-marketing-digital", title: "Curso de Marketing Digital", lang: "ES" },
  { slug: "paying-twice-for-netflix", title: "Paying Twice for Netflix", lang: "EN" },
  { slug: "retiree-health-coverage", title: "Retiree Health Coverage", lang: "EN" },
  { slug: "never-do-this-on-a-plane", title: "Never Do This on a Plane", lang: "EN" },
  { slug: "secret-code-in-your-passport", title: "Secret Code in Your Passport", lang: "EN" },
  { slug: "hidden-rooms-on-cruise-ships", title: "Hidden Rooms on Cruise Ships", lang: "EN" },
  { slug: "never-book-this-cruise-cabin", title: "Never Book This Cruise Cabin", lang: "EN" },
  { slug: "veneers-implants-abroad", title: "Veneers & Implants Abroad", lang: "EN" },
  { slug: "flew-abroad-for-new-teeth", title: "Flew Abroad for New Teeth", lang: "EN" },
  { slug: "world-capital-of-cheap-dentistry", title: "World Capital of Cheap Dentistry", lang: "EN" },
];

// Indians defaults (verified live on the system-user token 2026-08-08): the token sees 16 ACTIVE
// GC-Magicoffers-BR-* accounts — the ACCOUNT is picked per campaign (/api/adaccounts), defaulting
// to BR-1500. ⚠️ The MK Learn tracking pixel HS-Pixel-FARM-1 (the one the landing actually fires;
// last_fired confirmed) is shared ONLY to BR-1500 today — the other 15 accounts carry just the
// never-fired "GC for MO Pixel", so conversion launches there optimize blind until the partner
// shares FARM-1 wider. The pixel field therefore offers the chosen account's own pixels and
// auto-picks FARM-1 whenever it's present.
const MAGICOFFERS_ACCOUNT: Bound = { id: "1297336295903991", name: "GC-Magicoffers-BR-1500" };
const MAGICOFFERS_PIXEL: Bound = { id: "3288799954641310", name: "HS-Pixel-FARM-1" };

/** The ONLY pixel min-ROAS launches may optimize on (owner rule 2026-08-11): the partner's HS
 *  value pixel — real purchase-value history, shared to every MO account and live-probed
 *  VO-eligible on 08-11. Everything else (never-fired GC-for-MO, FARM-1) is rejected for ROAS
 *  even where technically eligible. Enforced in the card (pin + readiness), /api/launch and
 *  /api/clone/run. */
export const ROAS_PIXEL: Bound = { id: "4367956310124642", name: "VD-C1-HS-1" };

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
    preferredPixel: MAGICOFFERS_PIXEL,
    launchNote: "Submits directly via Graph API",
    pageAdLimit: 250,
    maxCreatives: 1,
  },
  {
    id: "us",
    label: "AIF",
    Flag: UsaFlag,
    usesGcm: false,
    usesProfile: true,
    landingBase: "",
    landings: [],
    pageLabel: "Page",
    pagePlaceholder: "Search page",
    fanpages: [],
    launchNote: "Submits through LION",
    inDevelopment: true,
  },
];

export function partnerConfig(id: PartnerId): PartnerConfig {
  return PARTNERS.find((p) => p.id === id) ?? PARTNERS[0];
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
    landing: p.usesGcm,
    profile: p.usesProfile,
    page: Boolean(p.fanpagesFromToken) || Boolean(p.lionLaunch),
    account: Boolean(p.accountsFromToken) || Boolean(p.lionLaunch),
    pixel: Boolean(p.accountsFromToken) || Boolean(p.lionLaunch),
    // gcm-monetized partners need a claimed code before the card counts as ready — a landing card
    // whose code hasn't loaded (registry unreachable / pre-load window) must not look launchable,
    // and Copy must not offer a "?gcm=" link with an empty code.
    gcm: p.usesGcm,
    // LION builds ads from the typed destination link + title/copy — all hard-required by create/.
    link: Boolean(p.lionLaunch),
    adText: Boolean(p.lionLaunch),
    // MO min-ROAS is pinned to the partner's value pixel; LION partners validate pixels their own way.
    roasPixel: p.accountsFromToken ? ROAS_PIXEL.id : "",
  };
}

/** Fixed naming prefix for a new campaign, e.g. "[04.08] - (t1) - ". Empty when the partner has no tier. */
export function namePrefixFor(p: PartnerConfig, ddmm: string): string {
  return p.nameTier ? `[${ddmm}] - (${p.nameTier}) - ` : "";
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

/** Pin account/pixel/fanpage to the partner's single bound values (Indians). No-op otherwise. */
export function applyPartnerLocks(rows: Campaign[], p: PartnerConfig): Campaign[] {
  const acct = p.lockedAccount?.name;
  const px = p.lockedPixel?.id; // pixel is identified by its numeric id, not its text name
  const fan = p.fanpages.length === 1 ? p.fanpages[0] : undefined;
  if (!acct && !px && !fan) return rows;
  let changed = false;
  const next = rows.map((r) => {
    const patch: Partial<Campaign> = {};
    if (acct && r.account !== acct) patch.account = acct;
    if (px && r.pixel !== px) patch.pixel = px;
    if (fan && r.page !== fan) patch.page = fan;
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

/**
 * Fill the lowest free code (01..200) for landing-having campaigns missing a gcm.
 * `reserved` = codes already taken in the Strapi registry. While it's null (not loaded yet)
 * NOTHING is assigned — never hand out a code that might already be live. The batch also
 * avoids reusing a code across two campaigns in the same session.
 */
export function assignGcmCodes<T extends { landing: string; gcm: string }>(
  rows: T[],
  reserved: Set<string> | null,
): T[] {
  if (!reserved) return rows;
  const used = new Set<string>(reserved);
  for (const r of rows) if (r.gcm) used.add(r.gcm);
  let changed = false;
  const next = rows.map((r) => {
    if (!r.landing || r.gcm) return r;
    let code = "";
    for (let n = 1; n <= GCM_POOL_MAX; n++) {
      const c = gcmCode(n);
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
