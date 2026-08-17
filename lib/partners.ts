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
   *  launches pin that pixel + Purchase; min-ROAS is banned (CAPI value is 0). */
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
  { slug: "paying-twice-for-netflix", title: "Paying Twice for Netflix", lang: "EN", niche: "Streaming" },
  { slug: "retiree-health-coverage", title: "Retiree Health Coverage", lang: "EN", niche: "Health" },
  { slug: "never-do-this-on-a-plane", title: "Never Do This on a Plane", lang: "EN", niche: "Travel" },
  { slug: "secret-code-in-your-passport", title: "Secret Code in Your Passport", lang: "EN", niche: "Travel" },
  { slug: "hidden-rooms-on-cruise-ships", title: "Hidden Rooms on Cruise Ships", lang: "EN", niche: "Travel" },
  { slug: "never-book-this-cruise-cabin", title: "Never Book This Cruise Cabin", lang: "EN", niche: "Travel" },
  { slug: "veneers-implants-abroad", title: "Veneers & Implants Abroad", lang: "EN", niche: "Dental" },
  { slug: "flew-abroad-for-new-teeth", title: "Flew Abroad for New Teeth", lang: "EN", niche: "Dental" },
  { slug: "world-capital-of-cheap-dentistry", title: "World Capital of Cheap Dentistry", lang: "EN", niche: "Dental" },
  { slug: "paid-to-film-your-cleaning", title: "Paid to Film Your Cleaning", lang: "EN", niche: "Side Gigs" },
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
/** The AIF pixel — where the postback→CAPI forwarder (HS server) lands Purchase events. The ONLY
 *  pixel AIF conversion launches may optimize on; click launches carry no pixel at all. */
export const AIF_PIXEL: Bound = { id: "2130695154991928", name: "AIF Rewarded" };
/** Brand pool test01..test700 (partner-assigned): 1–9 keep the doc's 2-digit zero-padded shape
 *  ("test01"), 10+ are plain. One brand = one buy campaign — the registry enforces it. */
export const AIF_POOL_MAX = 700;
export const aifBrandCode = (n: number): string => `test${String(n).padStart(2, "0")}`;
/** Destination slugs are free-typed (the partner's articles are arbitrary) — keep only what a
 *  slug can be made of, so the RW link can never carry spaces, slashes or query junk. */
export const aifSlugSanitize = (raw: string): string => raw.trim().replace(/[^\w-]/g, "");

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
    maxCreatives: 1,
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
    landings: [],
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
    // MO min-ROAS is pinned to the partner's value pixel; LION partners validate pixels their own
    // way; AIF bans min-ROAS outright (its CAPI Purchases carry value 0 — nothing to optimize).
    roasPixel: p.accountsFromToken && !p.aifLaunch ? ROAS_PIXEL.id : "",
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
 *  on their derived invariants: the pixel follows the optimization (conversions → the AIF pixel,
 *  clicks → none), the objective/event are pinned to SALES/Purchase (the only event the CAPI
 *  forwarder ever sends), and min-ROAS snaps back to lowest cost (banned — CAPI value is 0).
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
      if (bidKind(r.bidStrategy) === "roas") patch.bidStrategy = "LOWEST_COST_WITHOUT_CAP";
      const pixel = r.optimization === "conversions" ? AIF_PIXEL.id : "";
      if (r.pixel !== pixel) patch.pixel = pixel;
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
