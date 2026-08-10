// Pure builders for HS (LION) launches — importable from both the card preview and the server
// route, so the name/payload the buyer sees is byte-identical to what LION receives. No env, no IO.

import { type Campaign, parseMoney } from "./types";

/** LION validates the `(REDIR_LABEL)` name segment against redirect_type with this exact map. */
export const HS_REDIRECT_LABELS: Record<string, string> = {
  "HIGH ADX": "#ADX [HIGH]",
  "META ADX": "#ADX [META]",
  "#ADX": "#ADX",
};

/** Bid semantics per strategy: `cap` takes cents, `roas` takes a ROAS decimal (1.2 = 120%,
 *  conversion event forced to PURCHASE — weapon parity), `none` bids automatically. */
export function hsBidKind(strategy: string): "none" | "cap" | "roas" {
  if (strategy === "LOWEST_COST_WITH_MIN_ROAS") return "roas";
  if (strategy === "LOWEST_COST_WITH_BID_CAP" || strategy === "COST_CAP") return "cap";
  return "none";
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
  const kind = hsBidKind(c.bidStrategy);
  const bid = parseMoney(c.bidCap);
  if (kind === "cap" && bid <= 0) return "bid_required";
  if (kind === "roas" && (bid <= 0 || bid > 100)) return "roas_goal_invalid";
  return null;
}

export type HsLocale = { id: number; name: string };

/**
 * The per-campaign object of LION's `POST /api/facebook/campaigns/create/`.
 * Money: integer cents of the ad-account currency (write-side convention, verified live) — except
 * a MIN_ROAS bid, which is the ROAS decimal. `url_tags` stays empty: LION auto-builds the tracking
 * query from redirect_type (HS runs its own landings — no gcm here).
 */
export function hsCreatePayload(
  c: Campaign,
  creatives: string[],
  profileLocales: HsLocale[],
  acr: string,
  ddmm: string,
): Record<string, unknown> {
  const kind = hsBidKind(c.bidStrategy);
  const bidRaw = parseMoney(c.bidCap);
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
    link: c.link.trim(),
    daily_budget: Math.round(parseMoney(c.budget) * 100),
    ...(kind === "cap" ? { bid: Math.round(bidRaw * 100) } : {}),
    ...(kind === "roas" ? { bid: Math.round(bidRaw * 100) / 100 } : {}),
    bid_strategy: c.bidStrategy,
    objective: c.objective,
    conversion_event: kind === "roas" ? "PURCHASE" : c.conversionEvent,
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
