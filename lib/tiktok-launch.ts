// TikTok rail — pure decisions for the fresh / clone / JURO launches through the partner's
// tiktok-weapon API (docs/superpowers/specs/2026-09-18-tiktok-rail-design.md).
// Deliberately dependency-free (no "@/" imports, no extensionless imports) so
// `node --test tests/tiktok-launch.test.ts` runs it straight off Node's type stripping — this
// module carries the DECISIONS (mode vocabulary, money parsing, the bid plan, LION's name grammar,
// locales, the ONE fresh-launch validator, the clone / JURO wires, error wording, the row
// disposition of a partner task); the routes/boards own the I/O around them.

export type TiktokKind = "launch" | "clone" | "juro";

/** What a mode takes as its value: bid = `conversion_bid_price` (USD) · roas = `roas_bid`
 *  (multiplier) · none = no value (sending one is the partner's 400). */
export type TiktokBidKind = "bid" | "roas" | "none";

export type TiktokModeDef = { value: string; label: string; short: string; kind: TiktokBidKind; hint: string };

/** The partner's exact vocabulary (`mode`), in the order the picker shows. */
export const TIKTOK_CLONE_MODES: readonly TiktokModeDef[] = [
  { value: "NORMAL_WITH_BID", label: "Bid cap", short: "bid", kind: "bid", hint: "Conversions with a cost cap — you set the bid per conversion." },
  { value: "NORMAL_NO_BID", label: "No bid", short: "auto", kind: "none", hint: "Maximum delivery — TikTok spends the budget for the most conversions, no cap." },
  { value: "VO_HIGHEST_VALUE", label: "Highest value", short: "max value", kind: "none", hint: "Value optimisation — the most purchase value for the budget, no target." },
  { value: "VO_MIN_ROAS", label: "Min ROAS", short: "ROAS", kind: "roas", hint: "Value optimisation with a minimum return — you set the ROAS goal (1,2 = 120%)." },
  { value: "WARM_UP", label: "Warm-up", short: "warm-up", kind: "none", hint: "Clone-only: LION's warm-up preset for a fresh advertiser." },
] as const;

/** A fresh launch takes the first four — WARM_UP exists on the clone endpoint only. */
export const TIKTOK_LAUNCH_MODES: readonly TiktokModeDef[] = TIKTOK_CLONE_MODES.filter((m) => m.value !== "WARM_UP");

const MODE_BY_VALUE = new Map(TIKTOK_CLONE_MODES.map((m) => [m.value, m]));

/** Kind of a mode value; "unknown" for anything outside the partner vocabulary. */
export function tiktokModeKind(mode: string): TiktokBidKind | "unknown" {
  return MODE_BY_VALUE.get(mode)?.kind ?? "unknown";
}
export const tiktokModeLabel = (mode: string): string => MODE_BY_VALUE.get(mode)?.label ?? mode;

/** TikTok refuses a daily budget under 20.00 (partner docs: "smaller values return 400 and are
 *  never raised automatically"); 97 % of the team's book runs exactly $20. */
export const TIKTOK_DEFAULT_BUDGET = "20,00";
export const TIKTOK_BUDGET_MIN = 20;
export const TIKTOK_BUDGET_MAX = 10_000;
/** The team bids $0.10–0.90; anything near the budget is a slipped decimal, not a strategy. */
export const TIKTOK_BID_MAX = 100;
export const TIKTOK_ROAS_MIN = 0.01;
export const TIKTOK_ROAS_MAX = 1000;

/** Decimal-comma aware string → number (same rule as lib/types parseMoney, duplicated here so
 *  this module stays import-pure): a lone comma is the decimal point; a mixed "1,234.56" reads
 *  the comma as a thousands separator. Non-finite → NaN. */
export function parseDecimal(raw: string): number {
  const s = String(raw ?? "").trim();
  if (!s) return NaN;
  const normalized = s.includes(",") && s.includes(".") ? s.replace(/,/g, "") : s.replace(",", ".");
  if (!/^-?\d*(?:\.\d*)?$/.test(normalized) || normalized === "." || normalized === "-") return NaN;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : NaN;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Human budget ("20,00" / "20" / "20.5") → the partner's decimal STRING ("20.00"), or null when
 *  unparsable / outside [TIKTOK_BUDGET_MIN, TIKTOK_BUDGET_MAX]. */
export function tiktokBudgetWire(human: string): string | null {
  const n = parseDecimal(human);
  if (!Number.isFinite(n)) return null;
  const rounded = round2(n);
  if (rounded < TIKTOK_BUDGET_MIN || rounded > TIKTOK_BUDGET_MAX) return null;
  return rounded.toFixed(2);
}

/** A typed conversion bid: USD > 0 ≤ TIKTOK_BID_MAX, 2 places. null when it doesn't fit. */
export function parseTiktokBid(raw: string): number | null {
  const n = parseDecimal(raw);
  if (!Number.isFinite(n)) return null;
  const rounded = round2(n);
  return rounded > 0 && rounded <= TIKTOK_BID_MAX ? rounded : null;
}

/** A typed ROAS goal: a MULTIPLIER 0.01–1000 (1,2 = 120 %), 2 places. */
export function parseTiktokRoas(raw: string): number | null {
  const n = parseDecimal(raw);
  if (!Number.isFinite(n)) return null;
  const rounded = round2(n);
  return rounded >= TIKTOK_ROAS_MIN && rounded <= TIKTOK_ROAS_MAX ? rounded : null;
}

/** Decimal-comma money text without trailing ",00" ("0,46", "4"). */
export function moneyText(v: number): string {
  const rounded = round2(v);
  return Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(".", ",");
}

export type TiktokBidPlan =
  | { refusal: string }
  | {
      /** Explicit `mode` on the wire; undefined = inherit the source's (clone) / fixed (JURO). */
      wireMode?: string;
      /** `conversion_bid_price` on the wire ("0.46"); undefined = omitted. */
      conversionBidPrice?: string;
      /** `roas_bid` on the wire ("1.20"); undefined = omitted. */
      roasBid?: string;
      /** Effective kind when known ("unknown" while inheriting a mode we can't read). */
      bidKind: TiktokBidKind | "unknown";
      /** Monitor tag: "bid 0,46" / "ROAS 1,2" / "auto" / "max value" / "warm-up" / "inherit". */
      label: string;
    };

/**
 * What bidding rides the wire.
 *  - launch: the mode is REQUIRED (no source to inherit from) and carries exactly the value it
 *    takes — a value typed under a no-value mode is refused, never silently dropped.
 *  - clone + mode "" (inherit): a typed bid rides as `conversion_bid_price` — the partner never
 *    inherits a bid, and LION's metrics don't tell us the source's mode, so a missing value on a
 *    bid mode is the partner's explicit 400 to surface (the board prefills the source's bid).
 *  - clone + explicit mode: the launch rules, plus WARM_UP.
 *  - juro: the mode is always the source's (an override is a refusal); the partner takes ONE
 *    value field for both bid and ROAS sources — `conversion_bid_price`.
 * `VO_*` needs a pixel that lists it (`supportedModes`; an empty/absent list = unknown → allowed).
 * A bid at or above the daily budget is refused as a slipped decimal.
 */
export function tiktokBidPlan(a: { kind: TiktokKind; mode: string; typedBid: string; budget?: string; supportedModes?: string[] }): TiktokBidPlan {
  const mode = String(a.mode ?? "").trim();
  const typed = String(a.typedBid ?? "").trim();
  const budget = a.budget == null ? NaN : parseDecimal(a.budget);

  const bidOf = (): { bid: number } | { refusal: string } => {
    const bid = parseTiktokBid(typed);
    if (bid == null) return { refusal: `Bid must be a positive number up to ${TIKTOK_BID_MAX} USD (e.g. 0,46)` };
    if (Number.isFinite(budget) && bid >= budget) return { refusal: `A bid of $${moneyText(bid)} must stay below the daily budget of $${moneyText(budget)} — check the decimal` };
    return { bid };
  };

  if (a.kind === "juro") {
    if (mode) return { refusal: "JURO keeps the source's mode — clear the mode override" };
    if (!typed) return { bidKind: "unknown", label: "inherit" };
    const b = bidOf();
    if ("refusal" in b) return b;
    return { conversionBidPrice: b.bid.toFixed(2), bidKind: "unknown", label: `bid ${moneyText(b.bid)}` };
  }

  if (!mode) {
    if (a.kind === "launch") return { refusal: "Pick a mode — a fresh launch has no source to inherit from" };
    if (!typed) return { bidKind: "unknown", label: "inherit" };
    const b = bidOf();
    if ("refusal" in b) return b;
    return { conversionBidPrice: b.bid.toFixed(2), bidKind: "unknown", label: `bid ${moneyText(b.bid)}` };
  }

  const def = MODE_BY_VALUE.get(mode);
  if (!def) return { refusal: `Unknown mode "${mode}"` };
  if (a.kind === "launch" && mode === "WARM_UP") return { refusal: "Warm-up is a clone-only mode — pick another one for a fresh launch" };
  const supported = Array.isArray(a.supportedModes) ? a.supportedModes : [];
  if (mode.startsWith("VO_") && supported.length > 0 && !supported.includes(mode)) {
    return { refusal: `This pixel doesn't support ${def.label} (value optimisation is off for it) — pick another mode or pixel` };
  }

  if (def.kind === "none") {
    if (typed) return { refusal: `${def.label} takes no value — clear the bid` };
    return { wireMode: mode, bidKind: "none", label: def.short };
  }
  if (def.kind === "roas") {
    if (!typed) return { refusal: `${def.label} needs a ROAS goal (a multiplier, 1,2 = 120%)` };
    const roas = parseTiktokRoas(typed);
    if (roas == null) return { refusal: `ROAS goal must be between ${String(TIKTOK_ROAS_MIN).replace(".", ",")} and ${TIKTOK_ROAS_MAX} (1,2 = 120%)` };
    return { wireMode: mode, roasBid: roas.toFixed(2), bidKind: "roas", label: `ROAS ${moneyText(roas)}` };
  }
  if (!typed) return { refusal: `${def.label} needs a bid per conversion (e.g. 0,46)` };
  const b = bidOf();
  if ("refusal" in b) return b;
  return { wireMode: mode, conversionBidPrice: b.bid.toFixed(2), bidKind: "bid", label: `bid ${moneyText(b.bid)}` };
}

// ---------- naming ----------

/** Longest suffix we hand to tiktok-weapon (the FB/Google LION cap; unknown for TikTok → same). */
export const TIKTOK_NAME_SUFFIX_MAX = 80;
/** Owner rule 2026-09-14 (Google rail, carried over): every campaign born through this console
 *  carries a HARDCODED marker so console-born runs are tellable apart in any list of names. */
export const TIKTOK_NAME_MARK = "GC-Launcher";

const squash = (s: string): string => String(s ?? "").replace(/\s+/g, " ").trim();

/** Today as DD.MM in São Paulo (the team's suffix date). Injectable clock for tests. */
export function todaySaoPauloDotDDMM(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" })
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, p) => ((acc[p.type] = p.value), acc), {});
  return `${parts.day}.${parts.month}`;
}

/**
 * Our `name_suffix`, in the team's own shape (live names 17–18.09: `… | 17.09 - Katya - CREO -
 * APRUV`): `DD.MM - <user> - GC-Launcher[ - <tail>]`. LION writes the ` | ` separator, the
 * `(CLONE_FROM=…)` marker and the `Smart+` tag itself, so the suffix carries none of them; a pipe
 * typed in the tail is replaced so it can't fake a segment. Only the tail is trimmed by the cap.
 */
export function tiktokNameSuffix(a: { user: string; ddmm: string; tail?: string }): string {
  const user = squash(a.user) || "buyer";
  const head = `${a.ddmm} - ${user} - ${TIKTOK_NAME_MARK}`;
  let tail = squash(String(a.tail ?? "").replace(/\|/g, "/"));
  const room = TIKTOK_NAME_SUFFIX_MAX - head.length - 3;
  if (tail && tail.length > room) tail = room > 0 ? tail.slice(0, room).trim() : "";
  return `${head}${tail ? ` - ${tail}` : ""}`;
}

/**
 * The landing as tiktok-weapon takes it: the partner strips the query string and the hash and
 * appends ITS tracking parameters, so a pasted link's own tail is dropped here too and the buyer
 * sees exactly what rides. `path` is what LION prints in the campaign name. null = not https.
 */
export function tiktokLandingBase(raw: string): { base: string; host: string; path: string; strippedQuery: boolean } | null {
  const v = String(raw ?? "").trim();
  if (!/^https:\/\//i.test(v)) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" || !u.hostname.includes(".")) return null;
    const strippedQuery = Boolean(u.search || u.hash);
    u.search = "";
    u.hash = "";
    return { base: u.toString(), host: u.hostname, path: u.pathname.replace(/^\/+/, ""), strippedQuery };
  } catch {
    return null;
  }
}

const geoCodes = (countries: unknown): string[] => [
  ...new Set((Array.isArray(countries) ? countries : []).map((c) => String(c ?? "").trim().toUpperCase()).filter(Boolean)),
];

/** Geo list as the monitor's geo column shows it ("US+CA", "WW"; "" when empty). */
export const tiktokGeoLabel = (countries: unknown): string => geoCodes(countries).join("+");

/**
 * The head LION builds (live names): `{HS-xxxx} (GLO-01) [<cl>|<GEO,GEO>|<LANG|ALL>] (<landing path>)`.
 * `{HS-____}` becomes a unique hash and `cl` the advertiser's cluster number at launch — neither is
 * ours to know, so the preview keeps them as placeholders.
 */
export function tiktokNameHeadPreview(a: { acr?: string; countries: unknown; language?: string; landing: string }): string {
  const acr = (a.acr || "GLO-01").toUpperCase();
  const geo = geoCodes(a.countries).join(",") || "<geo>";
  const lang = String(a.language ?? "").trim().toUpperCase() || "ALL";
  const path = tiktokLandingBase(a.landing)?.path || "<landing>";
  return `{HS-____} (${acr}) [cl|${geo}|${lang}] (${path})`;
}

/** The whole name LION will build around our suffix: the source marker sits INSIDE the head, the
 *  Smart+ tag is a locked segment before the suffix. */
export function tiktokNamePreview(a: { head: string; suffix: string; kind: TiktokKind; sourceId?: string; smartPlus?: "" | "adgroup" | "campaign" }): string {
  const marker = a.kind === "clone" ? ` (CLONE_FROM=${a.sourceId ?? ""})` : a.kind === "juro" ? ` (JURO_FROM=${a.sourceId ?? ""})` : "";
  const smart = a.smartPlus === "campaign" ? " | Smart+ CBO" : a.smartPlus === "adgroup" ? " | Smart+" : "";
  return `${a.head}${marker}${smart} | ${a.suffix}`;
}

/** Role-tagged segments of the FINAL link (the FB card's coloured preview, TikTok flavour): the
 *  bare landing + LION's tracking tail as READ from the team's live campaigns 18.09. Preview only —
 *  the wire carries the bare landing and LION appends the tail itself (`cl` is LION's number). */
export type TiktokLinkSegment = { text: string; role: "slug" | "params" | "pixel" };
export function tiktokLandingSegments(raw: string, ctx: { acr?: string; pixel?: string } = {}): TiktokLinkSegment[] {
  const b = tiktokLandingBase(raw);
  if (!b) return [];
  const acr = (ctx.acr || "glo-01").toLowerCase();
  return [
    { text: b.base, role: "slug" },
    { text: `?utm_source=tiktok&utm_campaign=__CAMPAIGN_ID__&utm_content=__AID__&utm_term=__PLACEMENT__&utm_id=__SITE_ID__-__PUBLISHER_ID__&mb=${acr}`, role: "params" },
    { text: `&pixel=${ctx.pixel || "<pixel>"}`, role: "pixel" },
    { text: "&cl=NN&event=Purchase&fire=click&pixel_mode=single", role: "params" },
  ];
}

// ---------- creative vocabulary ----------

export const TIKTOK_TITLE_MAX = 100;
export const TIKTOK_IDENTITY_NAME_MAX = 100;
export const TIKTOK_VIDEOS_MAX = 20;
export const TIKTOK_AD_TEXTS_MAX = 5;
export const TIKTOK_CTAS_MAX = 3;

/** TikTok's call-to-action enum; the partner docs name the first four. */
export const TIKTOK_CTAS: readonly { value: string; label: string }[] = [
  { value: "LEARN_MORE", label: "Learn more" },
  { value: "SHOP_NOW", label: "Shop now" },
  { value: "SIGN_UP", label: "Sign up" },
  { value: "DOWNLOAD_NOW", label: "Download" },
  { value: "APPLY_NOW", label: "Apply now" },
  { value: "BOOK_NOW", label: "Book now" },
  { value: "CONTACT_US", label: "Contact us" },
  { value: "GET_QUOTE", label: "Get quote" },
  { value: "ORDER_NOW", label: "Order now" },
  { value: "READ_MORE", label: "Read more" },
  { value: "VIEW_NOW", label: "View now" },
  { value: "WATCH_NOW", label: "Watch now" },
  { value: "SUBSCRIBE", label: "Subscribe" },
  { value: "INTERESTED", label: "Interested" },
  { value: "EXPERIENCE_NOW", label: "Experience now" },
  { value: "PLAY_GAME", label: "Play game" },
  { value: "INSTALL_NOW", label: "Install now" },
  { value: "LISTEN_NOW", label: "Listen now" },
  { value: "GET_TICKETS_NOW", label: "Get tickets" },
  { value: "GET_SHOWTIMES", label: "Get showtimes" },
  { value: "PRE_ORDER_NOW", label: "Pre-order" },
  { value: "VISIT_STORE", label: "Visit store" },
] as const;
const CTA_SET = new Set(TIKTOK_CTAS.map((c) => c.value));

/** Launcher geo presets (the Google launcher's sets; the card keeps only what the advertiser's
 *  config allows). WORLD = the partner's `WW`. */
export const TIKTOK_GEO_PRESETS: readonly { label: string; codes: string[] }[] = [
  { label: "World", codes: ["WW"] },
  { label: "LATAM", codes: ["AR", "BO", "CL", "CO", "CR", "DO", "EC", "GT", "HN", "MX", "NI", "PA", "PE", "PR", "PY", "SV", "UY"] },
  { label: "Anglo", codes: ["US", "CA", "GB", "AU", "NZ", "IE"] },
  { label: "Franco", codes: ["FR", "BE", "CH", "LU", "MC", "CA"] },
] as const;

/** Country / language CODES the target advertiser's config offers. */
export type TiktokLocaleConfig = { countries: string[]; languages: string[] };

const LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?$/;

/**
 * `locales` for the wire: upper-cased, de-duplicated country codes or EXACTLY ["WW"] (which needs
 * a language); with the advertiser's config at hand every code must be one it offers, and the
 * language is sent in the config's own spelling (the partner matches case-insensitively, but
 * "zh-Hant" is not "zh-hant" to the eye that later reads the task).
 */
export function tiktokLocalesWire(countries: unknown, language: unknown, cfg?: TiktokLocaleConfig): { locales: { countries: string[]; language?: string } } | { refusal: string } {
  const codes = geoCodes(countries);
  if (codes.length === 0) return { refusal: "Pick at least one country (or World)" };
  const worldwide = codes.includes("WW");
  if (worldwide && codes.length > 1) return { refusal: "Worldwide (WW) cannot be mixed with countries — pick one or the other" };
  if (!worldwide) {
    const bad = codes.filter((c) => !/^[A-Z]{2}$/.test(c));
    if (bad.length) return { refusal: `Unknown country code${bad.length === 1 ? "" : "s"}: ${bad.join(", ")}` };
    const offered = cfg?.countries ?? [];
    if (offered.length > 0) {
      const set = new Set(offered.map((c) => c.toUpperCase()));
      const missing = codes.filter((c) => !set.has(c));
      if (missing.length) return { refusal: `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not targetable on this advertiser — pick from its country list` };
    }
  }
  let lang = String(language ?? "").trim();
  if (!lang) {
    if (worldwide) return { refusal: "Worldwide needs a language — pick one" };
    return { locales: { countries: codes } };
  }
  const offeredLangs = cfg?.languages ?? [];
  if (offeredLangs.length > 0) {
    const canonical = offeredLangs.find((l) => l.toLowerCase() === lang.toLowerCase());
    if (!canonical) return { refusal: `Language "${lang}" is not offered on this advertiser — pick from its language list` };
    lang = canonical;
  } else if (!LANG_RE.test(lang)) {
    return { refusal: `Language must be a code like "en" (got "${lang}")` };
  }
  return { locales: { countries: codes, language: lang } };
}

// ---------- fresh launches (POST /api/external/campaign/launch/) ----------

/** One fresh-launch shot as the board sends it (money as HUMAN strings; files already hosted). */
export type TiktokLaunchShotIn = {
  advertiser: string;
  pixel?: string;
  mode: string;
  budget: string;
  bid: string;
  /** Buyer's free tail — the team-pattern suffix is built server-side around it. */
  suffix: string;
  landingUrl: string;
  identityName: string;
  identityImageUrl: string;
  title: string;
  callToAction: string;
  videoUrls: string[];
  /** ISO-2 codes or exactly ["WW"]. */
  countries: string[];
  language?: string;
  mosh?: boolean;
  smartPlus?: boolean;
  /** Smart+ only: "campaign" (CBO) | "adgroup" (default). */
  budgetLevel?: string;
  /** Smart+ only: texts BEYOND `title` (the wire list starts with the title). */
  adTexts?: string[];
  /** Smart+ only: CTAs BEYOND `callToAction`. */
  callToActions?: string[];
  /** Display material the board resolved. */
  label?: string;
  currency?: string;
};

/** The partner wire of a fresh launch. */
export type TiktokLaunchWire = {
  advertiser_id: string;
  mode: string;
  budget: string;
  conversion_bid_price?: string;
  roas_bid?: string;
  pixel_code: string;
  name_suffix: string;
  landing_page_url: string;
  identity: { name: string; image_url: string };
  creative_data: { title: string; call_to_action: string; video_urls: string[]; ad_texts?: string[]; call_to_actions?: string[] };
  locales: { countries: string[]; language?: string };
  mosh?: boolean;
  campaign_kind?: "smart_plus";
  budget_level?: "campaign" | "adgroup";
  client_reference?: string;
};

/** What the route resolved once for the shot (the card's dry-run passes placeholders). */
export type TiktokResolved = {
  advertiserId: string;
  pixelCode: string;
  /** The picked pixel's `supported_modes` (absent/empty = unknown → VO modes are let through). */
  supportedModes?: string[];
  nameSuffix: string;
  /** Our task id — the partner echoes it in the task status. */
  clientReference?: string;
  config?: TiktokLocaleConfig;
};

const isHttps = (u: string): boolean => /^https:\/\/[^\s]+$/i.test(u);
const cleanList = (xs: unknown): string[] => (Array.isArray(xs) ? xs : []).map((x) => squash(String(x ?? ""))).filter(Boolean);

/**
 * Build the fresh-launch wire for ONE shot, refusing with the exact fix when a field can't ride.
 * The launcher card runs THIS function on placeholder URLs for its readiness dot, so the card can
 * never disagree with the server. `targeting` and `postback_url` are never sent (the partner
 * refuses the first; the pump's settle pass covers what the second would).
 */
export function tiktokLaunchWire(
  shot: TiktokLaunchShotIn,
  r: TiktokResolved,
): { wire: TiktokLaunchWire; label: string; bidKind: TiktokBidKind | "unknown" } | { refusal: string } {
  if (!TIKTOK_ADVERTISER_ID_RE.test(String(r.advertiserId ?? ""))) return { refusal: "Pick an advertiser" };
  const budget = tiktokBudgetWire(String(shot.budget ?? ""));
  if (!budget) return { refusal: `Budget must be between ${TIKTOK_BUDGET_MIN} and ${TIKTOK_BUDGET_MAX} USD a day (TikTok refuses less than $${TIKTOK_BUDGET_MIN})` };
  const plan = tiktokBidPlan({ kind: "launch", mode: String(shot.mode ?? ""), typedBid: String(shot.bid ?? ""), budget, supportedModes: r.supportedModes });
  if ("refusal" in plan) return { refusal: plan.refusal };
  if (!String(r.pixelCode ?? "").trim()) return { refusal: "Pick a pixel — every TikTok launch needs one" };
  const landing = tiktokLandingBase(String(shot.landingUrl ?? ""));
  if (!landing) return { refusal: "Landing must be an https:// address on one of LION's allowed domains" };

  const identityName = squash(shot.identityName);
  if (!identityName) return { refusal: "Identity name is required (the display name under the ad)" };
  if (identityName.length > TIKTOK_IDENTITY_NAME_MAX) return { refusal: `Identity name is ${identityName.length} characters — at most ${TIKTOK_IDENTITY_NAME_MAX}` };
  const identityImage = String(shot.identityImageUrl ?? "").trim();
  if (!isHttps(identityImage)) return { refusal: "Identity image is required — drop an avatar or paste a public https:// image URL" };

  const title = squash(shot.title);
  if (!title) return { refusal: "Ad text is required" };
  if (title.length > TIKTOK_TITLE_MAX) return { refusal: `Ad text is ${title.length} characters — at most ${TIKTOK_TITLE_MAX}` };
  const cta = String(shot.callToAction ?? "").trim();
  if (!cta) return { refusal: "Pick a call to action" };
  if (!CTA_SET.has(cta)) return { refusal: `Unknown call to action "${cta}"` };

  const videos = (Array.isArray(shot.videoUrls) ? shot.videoUrls : []).map((u) => String(u ?? "").trim()).filter(Boolean);
  if (videos.length === 0) return { refusal: "At least one video is required" };
  if (videos.length > TIKTOK_VIDEOS_MAX) return { refusal: `At most ${TIKTOK_VIDEOS_MAX} videos per campaign — this one has ${videos.length}` };
  if (videos.some((u) => !isHttps(u))) return { refusal: "Videos must be public https:// URLs" };
  if (new Set(videos).size !== videos.length) return { refusal: "The same video is listed twice — remove the duplicate" };

  const loc = tiktokLocalesWire(shot.countries, shot.language, r.config);
  if ("refusal" in loc) return { refusal: loc.refusal };

  const smart = shot.smartPlus === true;
  const budgetLevel = String(shot.budgetLevel ?? "").trim();
  const extraTexts = cleanList(shot.adTexts);
  const extraCtas = (Array.isArray(shot.callToActions) ? shot.callToActions : []).map((c) => String(c ?? "").trim()).filter(Boolean);
  if (!smart && (budgetLevel || extraTexts.length || extraCtas.length)) {
    return { refusal: "Budget level, extra ad texts and extra calls to action are Smart+ only — turn Smart+ on or clear them" };
  }
  let adTexts: string[] | undefined;
  let ctas: string[] | undefined;
  if (smart) {
    if (budgetLevel && budgetLevel !== "campaign" && budgetLevel !== "adgroup") return { refusal: 'Budget level must be "campaign" (CBO) or "adgroup"' };
    if (extraTexts.length) {
      const all = [title, ...extraTexts];
      if (all.length > TIKTOK_AD_TEXTS_MAX) return { refusal: `At most ${TIKTOK_AD_TEXTS_MAX} ad texts (the main one included) — this card has ${all.length}` };
      const over = all.find((t) => t.length > TIKTOK_TITLE_MAX);
      if (over) return { refusal: `Ad text "${over.slice(0, 30)}…" is over ${TIKTOK_TITLE_MAX} characters` };
      if (new Set(all).size !== all.length) return { refusal: "Ad texts must differ from each other (and from the main one)" };
      adTexts = all;
    }
    if (extraCtas.length) {
      const all = [cta, ...extraCtas];
      if (all.length > TIKTOK_CTAS_MAX) return { refusal: `At most ${TIKTOK_CTAS_MAX} calls to action (the main one included) — this card has ${all.length}` };
      const unknown = all.find((c) => !CTA_SET.has(c));
      if (unknown) return { refusal: `Unknown call to action "${unknown}"` };
      if (new Set(all).size !== all.length) return { refusal: "Calls to action must differ from each other (and from the main one)" };
      ctas = all;
    }
  }

  const wire: TiktokLaunchWire = {
    advertiser_id: r.advertiserId,
    mode: plan.wireMode as string,
    budget,
    ...(plan.conversionBidPrice ? { conversion_bid_price: plan.conversionBidPrice } : {}),
    ...(plan.roasBid ? { roas_bid: plan.roasBid } : {}),
    pixel_code: String(r.pixelCode).trim(),
    name_suffix: r.nameSuffix,
    landing_page_url: landing.base,
    identity: { name: identityName, image_url: identityImage },
    creative_data: {
      title,
      call_to_action: cta,
      video_urls: videos,
      ...(adTexts ? { ad_texts: adTexts } : {}),
      ...(ctas ? { call_to_actions: ctas } : {}),
    },
    locales: loc.locales,
    ...(shot.mosh ? { mosh: true } : {}),
    ...(smart ? { campaign_kind: "smart_plus" as const, budget_level: (budgetLevel || "adgroup") as "campaign" | "adgroup" } : {}),
    ...(r.clientReference ? { client_reference: r.clientReference.slice(0, 200) } : {}),
  };
  return { wire, label: plan.label, bidKind: plan.bidKind };
}

// ---------- clone / JURO ----------

/** One clone / JURO shot as the board sends it. */
export type TiktokCloneShotIn = {
  campaignId: string;
  budget: string;
  bid: string;
  /** Clone only: "" = inherit the source's mode. */
  mode: string;
  suffix: string;
  /** Clone only: target advertiser (the wave's when empty). */
  advertiser?: string;
  pixel?: string;
  /** Display material the board already read (the server re-reads what it can). */
  sourceName?: string;
  sourceAccount?: string;
  geo?: string;
  currency?: string;
};

export type TiktokCloneWire = {
  source_campaign_id: string;
  advertiser_id?: string;
  budget: string;
  pixel_code: string;
  mode?: string;
  conversion_bid_price?: string;
  roas_bid?: string;
  name_suffix: string;
};

export type TiktokJuroWire = { source_campaign_id: string; budget: string; conversion_bid_price?: string; name_suffix?: string };

const budgetRefusal = `Budget must be between ${TIKTOK_BUDGET_MIN} and ${TIKTOK_BUDGET_MAX} USD a day (TikTok refuses less than $${TIKTOK_BUDGET_MIN})`;

/** POST /clone/launch/ body. The pixel is the TARGET advertiser's (it varies between advertisers). */
export function tiktokCloneWire(
  shot: TiktokCloneShotIn,
  r: { advertiserId: string; pixelCode: string; supportedModes?: string[]; nameSuffix: string },
): { wire: TiktokCloneWire; label: string } | { refusal: string } {
  const campaignId = String(shot.campaignId ?? "").trim();
  if (!TIKTOK_CAMPAIGN_ID_RE.test(campaignId)) return { refusal: "Bad source campaign id" };
  if (!TIKTOK_ADVERTISER_ID_RE.test(String(r.advertiserId ?? ""))) return { refusal: "Pick a target advertiser" };
  const budget = tiktokBudgetWire(String(shot.budget ?? ""));
  if (!budget) return { refusal: budgetRefusal };
  const plan = tiktokBidPlan({ kind: "clone", mode: String(shot.mode ?? ""), typedBid: String(shot.bid ?? ""), budget, supportedModes: r.supportedModes });
  if ("refusal" in plan) return { refusal: plan.refusal };
  if (!String(r.pixelCode ?? "").trim()) return { refusal: "Pick a pixel of the target advertiser — a clone needs one" };
  return {
    wire: {
      source_campaign_id: campaignId,
      advertiser_id: r.advertiserId,
      budget,
      pixel_code: String(r.pixelCode).trim(),
      ...(plan.wireMode ? { mode: plan.wireMode } : {}),
      ...(plan.conversionBidPrice ? { conversion_bid_price: plan.conversionBidPrice } : {}),
      ...(plan.roasBid ? { roas_bid: plan.roasBid } : {}),
      name_suffix: r.nameSuffix,
    },
    label: plan.label,
  };
}

/** POST /juro/launch/ body — always the source's advertiser, pixel, identity and mode. */
export function tiktokJuroWire(shot: TiktokCloneShotIn, r: { nameSuffix: string }): { wire: TiktokJuroWire; label: string } | { refusal: string } {
  const campaignId = String(shot.campaignId ?? "").trim();
  if (!TIKTOK_CAMPAIGN_ID_RE.test(campaignId)) return { refusal: "Bad source campaign id" };
  const budget = tiktokBudgetWire(String(shot.budget ?? ""));
  if (!budget) return { refusal: budgetRefusal };
  const plan = tiktokBidPlan({ kind: "juro", mode: String(shot.mode ?? ""), typedBid: String(shot.bid ?? ""), budget });
  if ("refusal" in plan) return { refusal: plan.refusal };
  return {
    wire: {
      source_campaign_id: campaignId,
      budget,
      ...(plan.conversionBidPrice ? { conversion_bid_price: plan.conversionBidPrice } : {}),
      ...(r.nameSuffix ? { name_suffix: r.nameSuffix } : {}),
    },
    label: plan.label,
  };
}

// ---------- partner sentences ----------

const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x ?? "")).filter(Boolean) : []);

/** Human sentence for a tiktok-weapon refusal body (`{error|message, hint?, allowed_domains?,
 *  available_pixels?}`) — the partner's words first, its lists appended. */
export function tiktokWeaponErrorMessage(status: number | undefined, body: unknown): string {
  const rec = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const pick = (v: unknown): string => (typeof v === "string" && v.trim() ? v.trim() : "");
  let msg = pick(rec.error) || pick(rec.message) || pick(rec.detail) || (typeof body === "string" && body.trim() ? body.trim().slice(0, 300) : "");
  if (!msg) msg = status ? `tiktok-weapon HTTP ${status}` : "tiktok-weapon unreachable";
  const domains = listOf(rec.allowed_domains ?? rec.allowedDomains ?? rec.domains);
  if (domains.length) msg += ` · allowed domains: ${domains.join(", ")}`;
  const pixels = listOf(rec.available_pixels ?? rec.availablePixels);
  if (pixels.length) msg += ` · available pixels: ${pixels.join(", ")}`;
  const hint = pick(rec.hint);
  if (hint && !msg.includes(hint)) msg += ` (${hint})`;
  if (status === 403 && !/advertiser/i.test(msg)) msg += " — advertiser not allowed for the LION user or not launch eligible";
  return msg;
}

// ---------- task lifecycle ----------

/** The part of a partner task the row disposition reads. */
export type TiktokTaskLike = { status: string; campaignId: string | null; campaignName: string | null; errorMessage: string | null; errorStep: string | null };

/** tiktok-weapon task status → the monitor stage key. */
export function tiktokTaskStage(status: string): "queue" | "lion" | "done" | "failed" | "unknown" {
  const s = String(status ?? "").toLowerCase();
  if (s === "pending") return "queue";
  if (s === "running") return "lion";
  if (s === "completed") return "done";
  if (s === "failed") return "failed";
  return "unknown";
}

/**
 * What a partner task means for OUR row once LION is done with it: null while the task is still
 * moving (or reads "completed" without a campaign id yet); `done/created` with the real campaign;
 * `error/lion` with LION's step and sentence. A row is "Sent to LION" until this says otherwise.
 */
export function tiktokTaskOutcome(
  t: TiktokTaskLike,
): null | { status: "done"; stage: "created"; campaign_id: string; name?: string } | { status: "error"; stage: "lion"; error: string } {
  const stage = tiktokTaskStage(t.status);
  if (stage === "done") {
    if (!t.campaignId) return null;
    return { status: "done", stage: "created", campaign_id: t.campaignId, ...(t.campaignName ? { name: t.campaignName } : {}) };
  }
  if (stage === "failed") {
    const message = squash(t.errorMessage ?? "");
    const step = squash(t.errorStep ?? "");
    const error = message ? (step ? `${step}: ${message}` : message) : step ? `failed at ${step}` : "LION failed the build without a reason — check the task in LION";
    return { status: "error", stage: "lion", error: error.slice(0, 1000) };
  }
  return null;
}

/** Deterministic per-shot task ids: `ttl-<wave>-NN` (launch) / `ttc-` (clone) / `ttj-` (JURO). */
export function tiktokShotTaskId(kind: TiktokKind, waveId: string, index: number): string {
  const prefix = kind === "clone" ? "ttc" : kind === "juro" ? "ttj" : "ttl";
  return `${prefix}-${waveId}-${String(index + 1).padStart(2, "0")}`;
}

export const TIKTOK_WAVE_ID_RE = /^[a-zA-Z0-9-]{8,64}$/;
export const TIKTOK_CAMPAIGN_ID_RE = /^\d{10,22}$/;
export const TIKTOK_ADVERTISER_ID_RE = /^\d{10,22}$/;

// ---------- account predicate (owner decision 2026-09-18) ----------

/** Advertisers the owner takes out of rotation (names upper-cased, or advertiser ids): hidden from
 *  every picker AND refused as a target — one predicate, so "not shown" always means "not
 *  launchable". Empty today; the Google rail's list grew the same way. */
export const TIKTOK_HIDDEN_LAUNCH_ACCOUNTS: ReadonlySet<string> = new Set<string>([]);

/** Every advertiser the partner marks `launch_eligible` (enabled, opted in, pixel-ready) is offered
 *  and accepted — the team already runs HS campaigns across gcxunion / TT-GC-HS / GC MEDIACORE. */
export function isTiktokLaunchAccount(a: { name: string; advertiserId: string; launchEligible: boolean }): boolean {
  if (!a.launchEligible) return false;
  const name = String(a.name ?? "").trim().toUpperCase();
  return !TIKTOK_HIDDEN_LAUNCH_ACCOUNTS.has(name) && !TIKTOK_HIDDEN_LAUNCH_ACCOUNTS.has(String(a.advertiserId ?? ""));
}
