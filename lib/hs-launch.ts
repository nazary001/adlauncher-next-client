// Pure builders for HS (LION) launches — importable from both the card preview and the server
// route, so the name/payload the buyer sees is byte-identical to what LION receives. No env, no IO.

import { type Campaign, bidKind, parseMoney } from "./types";
import type { LinkSegment } from "./partners";
import { CONVERSION_EVENTS } from "./catalog";

/** LION validates the `(REDIR_LABEL)` name segment against redirect_type with this exact map. */
export const HS_REDIRECT_LABELS: Record<string, string> = {
  "HIGH ADX": "#ADX [HIGH]",
  "META ADX": "#ADX [META]",
  "#ADX": "#ADX",
};

/**
 * `cl=` value for HIGH ADX tails. Consumed server-side by the funnel's pixel service
 * (pixel.highleverage.dev gets the full landing URL) — semantics unknown; live weapon links carry
 * a near-uniform 2..20 spread with no correlation to landing/account/event/locales (probed 41
 * campaigns, 08-14). 15 = what the weapon UI issued for our buyer on 08-14; every value 2..20 is
 * live on GLO-01 money campaigns, so any is prod-safe. Bump if the partner names the real rule.
 */
export const HS_HIGH_CL = 15;

/** The conversion event the launch actually optimizes for — min-ROAS always optimizes purchase
 *  value, so it pins PURCHASE regardless of the card's dropdown. One truth for the payload's
 *  `conversion_event` and the link tail's `event=`. */
export function hsConversionEventValue(c: Pick<Campaign, "conversionEvent" | "bidStrategy">): string {
  return bidKind(c.bidStrategy) === "roas" ? "PURCHASE" : c.conversionEvent;
}

/** Meta PIXEL event name (CamelCase) for the link tail — the catalog labels ARE the pixel event
 *  names (PURCHASE→Purchase, CONTENT_VIEW→ViewContent …), matching live weapon links. */
function hsEventLabel(c: Pick<Campaign, "conversionEvent" | "bidStrategy">): string {
  const value = hsConversionEventValue(c);
  return CONVERSION_EVENTS.find((e) => e.value === value)?.label ?? "Purchase";
}

type HsLinkCampaign = Pick<Campaign, "redirectType" | "conversionEvent" | "bidStrategy">;

/**
 * Destination-link builder for HS creates (mirrors MO's segments→join one-truth pattern): the
 * pasted landing gets the team's tracking tail appended. LION passes the link to Meta verbatim
 * (its docs' "url_tags auto-build" lives only in the weapon UI — verified live 08-13), and Meta
 * substitutes the `{{…}}` URL macros at click time (braces must stay RAW).
 *
 * The tail is REDIRECT-TYPE-DEPENDENT (probed live 08-14 across GLO-01 campaigns via details/):
 *   META ADX  → `?utm_source=facebook&utm_campaign={{campaign.id}}&mb=<acr>&pixel=<id>`
 *               (10/10 live links — exactly this, nothing more)
 *   HIGH ADX  → `?utm_source=facebook&utm_campaign={{campaign.id}}&utm_content={{ad.id}}
 *               &utm_term={{placement}}&utm_id={{site_source_name}}&mb=<acr>&cl=NN&pixel=<id>
 *               &event=<PixelEvent>&pixel_mode=single&fire=click`
 *               (every live link with a visible link_url — the funnel forwards the whole query to
 *               HS's server-side pixel service, so event/pixel_mode/fire drive the actual pixel
 *               fire; omitting them starves the adset of its optimization signal)
 *   #ADX      → a different scheme entirely (`tg5=…`, utm_medium, no mb/pixel) that the weapon
 *               builds from its own links table — NOT reproduced here; plain-#ADX cards get the
 *               META tail so buyer attribution (`mb=`) at least survives.
 *
 * A base that already carries `utm_source=` is treated as fully built and goes out untouched, so
 * pasting an old campaign's complete link can't double-append the tail.
 */
export function hsLinkSegments(
  baseRaw: string,
  pixelId: string,
  acr: string,
  c: HsLinkCampaign,
): LinkSegment[] {
  const base = baseRaw.trim();
  if (!base) return [];
  if (/[?&]utm_source=/.test(base)) return [{ text: base, role: "slug" }];
  const sep = base.includes("?") ? "&" : "?";
  const mb = (acr || "GLO-01").toLowerCase();
  if (c.redirectType === "HIGH ADX") {
    return [
      { text: base, role: "slug" },
      {
        text:
          `${sep}utm_source=facebook&utm_campaign={{campaign.id}}&utm_content={{ad.id}}` +
          `&utm_term={{placement}}&utm_id={{site_source_name}}&mb=${mb}&cl=${HS_HIGH_CL}`,
        role: "params",
      },
      { text: `&pixel=${pixelId}`, role: "pixel" },
      { text: `&event=${hsEventLabel(c)}&pixel_mode=single&fire=click`, role: "fire" },
    ];
  }
  return [
    { text: base, role: "slug" },
    { text: `${sep}utm_source=facebook&utm_campaign={{campaign.id}}&mb=${mb}`, role: "params" },
    { text: `&pixel=${pixelId}`, role: "pixel" },
  ];
}

/** Full ad link = the segments joined — what the launch payload sends and Copy copies. */
export function hsFinalLink(base: string, pixelId: string, acr: string, c: HsLinkCampaign): string {
  return hsLinkSegments(base, pixelId, acr, c)
    .map((s) => s.text)
    .join("");
}

/** The board's WW pseudo-code → LION's `"WORLD"` sentinel; ISO codes pass through. */
export function hsCountryCodes(countries: string[]): string[] {
  if (countries.includes("WW")) return ["WORLD"];
  return countries;
}

/** Today as DD/MM in LION's timezone (America/Sao_Paulo) — the name prefix must carry THEIR
 *  calendar date, not the browser's. en-GB yields DD/MM directly. */
export function todaySaoPauloDDMM(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
  }).format(now);
}

/** LION-validated name prefix: `[DD/MM] (ACR) API - (LABEL) - [CODES] - `. Placeholders keep the
 *  card preview readable while segments are still unpicked; the server never sends placeholders
 *  (validation rejects the campaign first). */
export function hsNamePrefix(
  c: Pick<Campaign, "redirectType" | "countries">,
  acr: string,
  ddmm: string,
): string {
  const label = HS_REDIRECT_LABELS[c.redirectType] ?? "…";
  const codes = c.countries.length ? hsCountryCodes(c.countries).join(", ") : "…";
  return `[${ddmm}] (${acr || "ACR"}) API - (${label}) - [${codes}] - `;
}

/** Full campaign name = LION prefix + the user's free-text suffix. */
export function hsFullName(
  c: Pick<Campaign, "redirectType" | "countries" | "name">,
  acr: string,
  ddmm: string,
): string {
  return `${hsNamePrefix(c, acr, ddmm)}${c.name.trim()}`;
}

const isHttpUrl = (v: string): boolean => /^https?:\/\/\S+$/i.test(v.trim());

/**
 * Server-side validation before anything is sent to LION. Returns the first problem as a short
 * machine-friendly string (mirrors the /api/launch guard style), or null when launchable.
 */
export function hsCampaignError(c: Campaign, creatives: string[]): string | null {
  if (!c.name.trim()) return "name_required";
  if (!HS_REDIRECT_LABELS[c.redirectType]) return "redirect_type_invalid";
  if (c.countries.length === 0) return "countries_required";
  if (!c.title.trim()) return "title_required";
  if (!c.copy.trim()) return "copy_required";
  if (!isHttpUrl(c.link)) return "link_invalid";
  if (creatives.length === 0) return "creatives_required";
  if (creatives.some((u) => !isHttpUrl(u))) return "creative_url_invalid";
  // $1 floor mirrors the MO guard — a 0-cent budget would create a task doomed at FB.
  if (parseMoney(c.budget) < 1) return "budget_too_low";
  const kind = bidKind(c.bidStrategy);
  const bid = parseMoney(c.bidCap);
  if (kind === "cap" && bid <= 0) return "bid_required";
  if (kind === "roas" && (bid <= 0 || bid > 100)) return "roas_goal_invalid";
  return null;
}

export type HsLocale = { id: number; name: string };

/**
 * LION write-side bid units are META-NATIVE minor units — LION forwards the value to the Graph
 * verbatim: cap strategies take integer CENTS (Meta bid_amount), MIN_ROAS takes the ROAS floor
 * × 10000 as an integer (Meta bid_constraints.roas_average_floor). Their own weapon UI scales the
 * human decimal client-side before POSTing. Sending the human decimal instead wedges the task at
 * CREATING_ADSET in a retry loop — Meta answers "roas_average_floor … should be larger than or
 * equal to 0.001 and smaller than or equal to 1000 … integer and scaled up 10000x" (live 08-10:
 * three GLO-01 tasks; weapon launches with identical goals sailed through the same day, so the
 * backend provably does NOT scale). Reads stay MAJOR/decimal (details 2.45 == metrics 2.45).
 *
 * `bid` here is the human decimal from the card (ROAS 1,20 = 120%; cap $ amount) → scaled to the
 * wire unit per strategy. Null = strategy takes no bid (lowest cost) or a non-positive value.
 */
export function hsWireBid(bid: number, strategy: string): number | null {
  if (!Number.isFinite(bid) || bid <= 0) return null;
  const kind = bidKind(strategy);
  if (kind === "roas") return Math.round(bid * 10000);
  if (kind === "cap") return Math.round(bid * 100);
  return null;
}

/**
 * The per-campaign object of LION's `POST /api/facebook/campaigns/create/`.
 * Money: integer cents of the ad-account currency (write-side convention, verified live); a
 * MIN_ROAS bid is the ROAS floor × 10000 (Meta-native — see hsWireBid). `url_tags` stays empty:
 * LION auto-builds the tracking query from redirect_type (HS runs its own landings — no gcm here).
 */
export function hsCreatePayload(
  c: Campaign,
  creatives: string[],
  profileLocales: HsLocale[],
  acr: string,
  ddmm: string,
): Record<string, unknown> {
  const wireBid = hsWireBid(parseMoney(c.bidCap), c.bidStrategy);
  const localeById = new Map(profileLocales.map((l) => [String(l.id), l.name]));
  // c.locales stores FB locale ids as strings; unknown ids (profile switched) are dropped.
  const locales = c.locales
    .filter((id) => localeById.has(id))
    .map((id) => ({ name: localeById.get(id) as string, id }));

  return {
    campaign_name: hsFullName(c, acr, ddmm),
    creatives,
    title: c.title.trim(),
    copy: c.copy.trim(),
    cta: c.cta,
    // The wire link is BUILT here, never pasted raw: base landing + tracking tail + the card's
    // pixel (same segments the card previews — one source of truth).
    link: hsFinalLink(c.link, c.pixel, acr, c),
    daily_budget: Math.round(parseMoney(c.budget) * 100),
    ...(wireBid != null ? { bid: wireBid } : {}),
    bid_strategy: c.bidStrategy,
    objective: c.objective,
    conversion_event: hsConversionEventValue(c),
    age_min: String(c.ageMin),
    position: c.placement,
    country_codes: hsCountryCodes(c.countries),
    locales,
    category: c.category,
    redirect_type: c.redirectType,
    url_tags: "",
    user_os: c.userOs,
    start_time: null,
  };
}
