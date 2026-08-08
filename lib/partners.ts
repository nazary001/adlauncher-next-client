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

export const PARTNERS: PartnerConfig[] = [
  {
    id: "br",
    label: "Бразики HS",
    Flag: BrazilFlag,
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
  {
    id: "in",
    label: "Индусы MO",
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
    label: "США - AIF",
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
} {
  return {
    landing: p.usesGcm,
    profile: p.usesProfile,
    page: Boolean(p.fanpagesFromToken),
    account: Boolean(p.accountsFromToken),
    pixel: Boolean(p.accountsFromToken),
  };
}

/** Fixed naming prefix for a new campaign, e.g. "[04.08] - (t1) - ". Empty when the partner has no tier. */
export function namePrefixFor(p: PartnerConfig, ddmm: string): string {
  return p.nameTier ? `[${ddmm}] - (${p.nameTier}) - ` : "";
}

/** FB macros must stay literal (unencoded), so the URL is built by hand, not URLSearchParams. */
const FB_MACROS = "&utm_campaign={{campaign.id}}&utm_term={{adset.id}}&utm_content={{ad.id}}";

/**
 * Full destination link the ad points to. Shape (per owner, 2026-08-04):
 * {base}/{slug}?gcm=NN&utm_source=facebook&utm_medium={tier}&utm_campaign={{campaign.id}}
 *   &utm_term={{adset.id}}&utm_content={{ad.id}}[&fire=click]
 * `fire=click` is appended for conversion campaigns (fires Purchase on the banner click).
 */
export function fullLandingUrl(
  p: PartnerConfig,
  slug: string,
  gcm: string,
  conversions: boolean,
): string {
  if (!slug) return "";
  const medium = p.nameTier ? `&utm_medium=${p.nameTier}` : "";
  const fire = conversions ? "&fire=click" : "";
  return `${p.landingBase}/${slug}?gcm=${gcm}&utm_source=facebook${medium}${FB_MACROS}${fire}`;
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

/**
 * Fill the lowest free 2-digit code (01..100) for landing-having campaigns missing a gcm.
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
    for (let n = 1; n <= 99; n++) {
      const c = String(n).padStart(2, "0");
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
