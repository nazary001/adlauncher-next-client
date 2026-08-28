// Pure builders for HS (LION) launches — importable from both the card preview and the server
// route, so the name/payload the buyer sees is byte-identical to what LION receives. No env, no IO.

import { type Campaign, bidKind, normalizeRoasGoal, parseMoney } from "./types";
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

/**
 * Channel marker inside the FIXED name part (owner ask 08-21): every campaign born through OUR
 * FB token — launcher's FB Token rail and the token duplicator alike — carries ` - TOKEN - `
 * right before the buyer's editable tail, so token-born and LION-born runs are tellable apart
 * in every list that only shows names. The marker means "HOW THIS RUN WAS CREATED": cloning a
 * token-born source over LION strips it (splitHsGrammar puts it in the tail; the clone board
 * drops it), and the token routes re-ensure it server-side (client names are never the truth).
 */
export const HS_TOKEN_MARK = "TOKEN - ";

/** Drop a leading channel marker from a parsed TAIL — token-born sources carry it right before
 *  the free text, and it must never leak into an editable suffix (or double-apply). */
export function stripTokenMark(tail: string): string {
  return tail.replace(/^TOKEN\s*-\s*/, "");
}

/**
 * Split a name by the LION-validated grammar: the STRUCTURED prefix
 * `[DD/MM] (ACR) API[ (CLONE)][ - JURO] - (LABEL) - [CODES] - … - ` vs the free-text TAIL after
 * it (the optional `JURO` segment is what LION's jurar — and our token JURO rail — put between
 * `API` and the redirect label). Pure split — no re-dating, no "(CLONE)" ensuring (the clone
 * board layers those on top). Null = the name doesn't follow the grammar (everything is tail).
 */
export function splitHsGrammar(name: string): { prefix: string; tail: string } | null {
  const m =
    /^((?:\[\d{2}\/\d{2}\])\s*\([^)]*\)\s*API(?:\s*\(CLONE\))?(?:\s*-\s*JURO)?\s*-\s*\([^)]*\)\s*(?:-\s*\[[^\]]*\]\s*)*-\s*)([\s\S]*)$/.exec(
      name,
    );
  return m ? { prefix: m[1], tail: m[2] } : null;
}

/** Guarantee the TOKEN marker on a name about to be created through the FB token (server-side
 *  truth — an old/tampered client may send an unmarked name). Grammar names get it between the
 *  fixed prefix and the tail; grammar-less ones (manual Ads-Manager sources) get it prepended —
 *  no grammar to preserve there. Already-marked names pass through untouched. */
export function hsEnsureTokenMark(name: string): string {
  if (/(?:^|\s)TOKEN\s*-\s*/.test(name)) return name;
  const split = splitHsGrammar(name);
  return split ? `${split.prefix}${HS_TOKEN_MARK}${split.tail}` : `${HS_TOKEN_MARK}${name}`;
}

/** LION-validated name prefix: `[DD/MM] (ACR) API - (LABEL) - [CODES] - `; the FB Token channel
 *  appends its ` TOKEN - ` marker (fixed part — the buyer's tail starts after it). Placeholders
 *  keep the card preview readable while segments are still unpicked; the server never sends
 *  placeholders (validation rejects the campaign first). */
export function hsNamePrefix(
  c: Pick<Campaign, "redirectType" | "countries">,
  acr: string,
  ddmm: string,
  channel: "lion" | "token" = "lion",
): string {
  const label = HS_REDIRECT_LABELS[c.redirectType] ?? "…";
  const codes = c.countries.length ? hsCountryCodes(c.countries).join(", ") : "…";
  return `[${ddmm}] (${acr || "ACR"}) API - (${label}) - [${codes}] - ${channel === "token" ? HS_TOKEN_MARK : ""}`;
}

/** Full campaign name = LION prefix (channel-marked for the FB Token rail) + the user's
 *  free-text suffix. */
export function hsFullName(
  c: Pick<Campaign, "redirectType" | "countries" | "name">,
  acr: string,
  ddmm: string,
  channel: "lion" | "token" = "lion",
): string {
  return `${hsNamePrefix(c, acr, ddmm, channel)}${c.name.trim()}`;
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
  // 10–20 can be a ×10 slip OR a percent — refuse instead of guessing (normalizeRoasGoal).
  if (kind === "roas" && normalizeRoasGoal(bid) == null) return "roas_goal_ambiguous — type the decimal goal (0,30 = 30%)";
  return null;
}

export type HsLocale = { id: number; name: string };

/**
 * Bid wire units are CHANNEL-SPECIFIC for MIN_ROAS and identical for cap strategies:
 *  - cap (bid cap / cost cap): integer CENTS everywhere (Meta bid_amount; LION forwards verbatim).
 *  - roas, channel "graph" (direct Meta writes — token-duplicate override, fb-launch does its
 *    own): Meta-native floor = ROAS × 10000 (bid_constraints.roas_average_floor).
 *  - roas, channel "lion" (create `bid` / duplicate `starting_bid`): ROAS × 100. LION's FB
 *    backend NOW multiplies the incoming ROAS bid ×100 before its Graph write — owner-observed
 *    live 08-21: a launch typed 0,40 (wire 4000, the ×10000 unit verified verbatim back on
 *    08-10) landed as floor 40. Cap bids and non-LION channels are unaffected ("только по Lion
 *    и только ROAS"). This ×100 backend is also what the 20–50 floors of the 08-20 mass ÷100
 *    fix really were: correctly-typed 0,2–0,5 goals, not (only) percent-form typos.
 * Reads stay MAJOR/decimal everywhere (details 2.45 == metrics 2.45; ROAS goals 0.34).
 *
 * `bid` here is the human decimal from the card (ROAS 0,30 = 30%; cap $ amount) → scaled to the
 * wire unit per strategy. Null = strategy takes no bid (lowest cost), a non-positive value, or
 * the ambiguous ROAS band.
 */
export function hsWireBid(bid: number, strategy: string, channel: "lion" | "graph"): number | null {
  if (!Number.isFinite(bid) || bid <= 0) return null;
  const kind = bidKind(strategy);
  if (kind === "roas") {
    // Percent-form / ×10-slip entries are normalized to the real decimal goal BEFORE scaling
    // (30 → 0,30) — the mis-typed floors of the 08-20 mass fix must never ship again.
    // null = the ambiguous 10–20 band, refused like any other unresolvable bid.
    const goal = normalizeRoasGoal(bid);
    return goal == null ? null : Math.round(goal * (channel === "lion" ? 100 : 10000));
  }
  if (kind === "cap") return Math.round(bid * 100);
  return null;
}

/**
 * Inherited-bid guard for clone paths that copy the SOURCE ad set's `bid_constraints` verbatim:
 * a source whose floor still carries the percent/×10 entry (pre-fix launches) must not propagate
 * it into the newborn clone. Floor is Meta-native (decimal × 10000). The ambiguous 10–20 band
 * stays verbatim — a faithful clone beats a guessed rewrite there.
 */
export function hsNormalizedConstraints<T extends { roas_average_floor?: unknown }>(constraints: T): T {
  const floor = Number(constraints?.roas_average_floor);
  if (!Number.isFinite(floor) || floor < 20000) return constraints;
  const goal = normalizeRoasGoal(floor / 10000);
  return goal == null ? constraints : { ...constraints, roas_average_floor: Math.round(goal * 10000) };
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
  const wireBid = hsWireBid(parseMoney(c.bidCap), c.bidStrategy, "lion");
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
