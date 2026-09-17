// Google Ads rail — pure decisions for the clone / JURO launches through the partner's
// google-weapon API (docs/superpowers/specs/2026-09-14-google-clone-juro-design.md).
// Deliberately dependency-free (no "@/" imports, no extensionless imports) so
// `node --test tests/google-bid.test.ts` runs it straight off Node's type stripping — this
// module carries the DECISIONS (strategy vocabulary, bid/budget parsing, the wire plan, the
// team naming pattern, error wording); the routes/board own the I/O around them.

export type GoogleMode = "clone" | "juro" | "launch";

/** What a Google bidding strategy takes as its `bid_value`:
 *  none = no value (sending one is a 400) · cpa = money in the ACCOUNT currency · roas = percent 1–200. */
export type GoogleBidKind = "none" | "cpa" | "roas";

export type GoogleBidStrategy = { value: string; label: string; kind: GoogleBidKind };

/** The partner's exact vocabulary (google-weapon `bid_strategy`), in the order the picker shows. */
export const GOOGLE_BID_STRATEGIES: readonly GoogleBidStrategy[] = [
  { value: "maximize_conversions", label: "Maximize conversions", kind: "none" },
  { value: "maximize_conversions_cap", label: "Max conversions · CPA cap", kind: "cpa" },
  { value: "target_cpa", label: "Target CPA", kind: "cpa" },
  { value: "target_roas", label: "Target ROAS", kind: "roas" },
  { value: "maximize_conversion_value", label: "Maximize conversion value", kind: "none" },
  { value: "maximize_conversion_value_target", label: "Max conv. value · target ROAS", kind: "roas" },
  { value: "manual_cpc", label: "Manual CPC", kind: "none" },
] as const;

const STRATEGY_BY_VALUE = new Map(GOOGLE_BID_STRATEGIES.map((s) => [s.value, s]));

/** Kind of a strategy value; "unknown" for anything outside the partner vocabulary. */
export function googleBidKind(strategy: string): GoogleBidKind | "unknown" {
  return STRATEGY_BY_VALUE.get(strategy)?.kind ?? "unknown";
}

export const isGoogleBidStrategy = (s: string): boolean => STRATEGY_BY_VALUE.has(s);

export const googleStrategyLabel = (s: string): string => STRATEGY_BY_VALUE.get(s)?.label ?? s;

/** Default daily budget on the Google boards: the team clones at R$30 and Google refuses less than
 *  BRL 25,40/day on the BRL accounts (LION refusal, live 2026-09-14) — the FB "10,00" seed is unlaunchable here. */
export const GOOGLE_DEFAULT_BUDGET = "30,00";

/** Money limits mirrored from the FB rails (budget [1, 10000] per shot, bid (0, 10000]). */
export const GOOGLE_BUDGET_MIN = 1;
export const GOOGLE_BUDGET_MAX = 10_000;
export const GOOGLE_CPA_MAX = 10_000;
export const GOOGLE_ROAS_MIN = 1;
export const GOOGLE_ROAS_MAX = 200;

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

/** Human budget ("30,00" / "30" / "30.5") → the partner's decimal STRING with 2 places
 *  ("30.00"), or null when unparsable / outside [GOOGLE_BUDGET_MIN, GOOGLE_BUDGET_MAX]. */
export function googleBudgetWire(human: string): string | null {
  const n = parseDecimal(human);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n * 100) / 100;
  if (rounded < GOOGLE_BUDGET_MIN || rounded > GOOGLE_BUDGET_MAX) return null;
  return rounded.toFixed(2);
}

/** Parse a typed bid for a known kind. CPA: money > 0 ≤ 10000, 2 places. ROAS: INTEGER percent
 *  1–200 ("90" = 90 %; "0,9" is refused — the FB decimal habit would land as 1 %). Returns null
 *  when the value doesn't fit the kind. */
export function parseGoogleBid(raw: string, kind: GoogleBidKind): number | null {
  if (kind === "none") return null;
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (kind === "roas") {
    if (!/^\d{1,3}$/.test(s)) return null;
    const n = Number(s);
    return n >= GOOGLE_ROAS_MIN && n <= GOOGLE_ROAS_MAX ? n : null;
  }
  const n = parseDecimal(s);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n * 100) / 100;
  return rounded > 0 && rounded <= GOOGLE_CPA_MAX ? rounded : null;
}

/** A bid typed for an UNKNOWN kind (inherit on clone, JURO's fixed-but-unread strategy): any
 *  positive number ≤ 10000 rides as-is — LION validates it against the source's strategy and
 *  answers with an explicit sentence when it doesn't fit. */
export function parseGoogleBidLoose(raw: string): number | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const n = parseDecimal(s);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n * 100) / 100;
  return rounded > 0 && rounded <= GOOGLE_CPA_MAX ? rounded : null;
}

export type GoogleBidPlan =
  | { refusal: string }
  | {
      /** Explicit strategy on the wire (clone only); undefined = inherit the source's. */
      wireStrategy?: string;
      /** `bid_value` on the wire; undefined = omitted. */
      wireBid?: number;
      /** Effective kind when known ("unknown" while inheriting a strategy we can't read). */
      kind: GoogleBidKind | "unknown";
      /** Monitor tag (≤ 40 chars): "CPA 3,95" / "ROAS 90%" / "auto" / "inherit" / "bid 3,95". */
      label: string;
    };

/** Monitor/board tag for a bid. */
export function googleBidLabel(kind: GoogleBidKind | "unknown", value: number | null | undefined): string {
  if (kind === "none") return "auto";
  if (value == null) return "inherit";
  if (kind === "roas") return `ROAS ${Math.round(value)}%`;
  if (kind === "cpa") return `CPA ${moneyText(value)}`;
  return `bid ${moneyText(value)}`;
}

/** Decimal-comma money text without trailing ",00" ("3,95", "4"). */
export function moneyText(v: number): string {
  const rounded = Math.round(v * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(".", ",");
}

/**
 * What bidding rides the launch wire.
 *  - clone + override "" (inherit the source's strategy): the typed bid (if any) rides as
 *    `bid_value` — google-weapon NEVER inherits a value on clone, and we can't read the source's
 *    strategy from LION metrics, so an empty bid on a value strategy is LION's explicit 400 to
 *    surface (the board prefills the source bid when the currencies match).
 *  - clone + explicit strategy: none → the bid must be empty; cpa → money required; roas →
 *    integer percent 1–200 required.
 *  - juro: the strategy is always the source's (an override is a refusal); the bid is optional
 *    and inherits when empty.
 */
export function googleBidPlan(args: {
  mode: GoogleMode;
  /** Picked strategy ("" = inherit). */
  override: string;
  /** Typed bid, human ("" = none). */
  typedBid: string;
}): GoogleBidPlan {
  const override = String(args.override ?? "").trim();
  const typed = String(args.typedBid ?? "").trim();
  if (args.mode === "launch" && !override) return { refusal: "Pick a bidding strategy — a fresh launch has no source to inherit from" };
  if (args.mode === "juro") {
    if (override) return { refusal: "JURO keeps the source's bidding strategy — clear the strategy override" };
    if (!typed) return { kind: "unknown", label: "inherit" };
    const bid = parseGoogleBidLoose(typed);
    if (bid == null) return { refusal: "Bid must be a positive number (CPA in the account currency, or ROAS percent 1–200)" };
    return { wireBid: bid, kind: "unknown", label: googleBidLabel("unknown", bid) };
  }
  if (!override) {
    if (!typed) return { kind: "unknown", label: "inherit" };
    const bid = parseGoogleBidLoose(typed);
    if (bid == null) return { refusal: "Bid must be a positive number (CPA in the target currency, or ROAS percent 1–200)" };
    return { wireBid: bid, kind: "unknown", label: googleBidLabel("unknown", bid) };
  }
  const kind = googleBidKind(override);
  if (kind === "unknown") return { refusal: `Unknown bidding strategy "${override}"` };
  if (kind === "none") {
    if (typed) return { refusal: `${googleStrategyLabel(override)} takes no bid value — clear the bid` };
    return { wireStrategy: override, kind, label: "auto" };
  }
  const bid = parseGoogleBid(typed, kind);
  if (bid == null) {
    return {
      refusal:
        kind === "roas"
          ? `${googleStrategyLabel(override)} needs a target ROAS as a whole percent 1–200 (90 = 90%)`
          : `${googleStrategyLabel(override)} needs a target CPA in the target account currency (e.g. 3,95)`,
    };
  }
  return { wireStrategy: override, wireBid: bid, kind, label: googleBidLabel(kind, bid) };
}

// ---------- naming ----------

/** Longest suffix we hand to google-weapon (FB LION caps at 80; unknown for Google → same cap). */
export const GOOGLE_NAME_SUFFIX_MAX = 80;

const squash = (s: string): string => String(s ?? "").replace(/\s+/g, " ").trim();

/** Today as DD.MM in São Paulo (the team's suffix date). Injectable clock for tests. */
export function todaySaoPauloDotDDMM(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" })
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, p) => ((acc[p.type] = p.value), acc), {});
  return `${parts.day}.${parts.month}`;
}

/**
 * Our `name_suffix`. LIVE-VERIFIED 2026-09-14 (three real shots): LION appends
 * ` | <name_suffix> | CLONE_FROM=<source>` (JURO_FROM for JURO, nothing for a fresh launch) ITSELF —
 * the team's live names `… DIRETO | 11.09 Taras | CLONE_FROM=…` are LION's separators around a
 * BARE suffix `11.09 Taras`. Sending the pipes/marker ourselves doubled them
 * (`… | | 14.09 x | CLONE_FROM=… | CLONE_FROM=…`). So: `DD.MM <user>[ <tail>]`, no pipes, no
 * marker; a pipe typed in the tail is replaced so it can't fake a segment. Capped so the whole
 * suffix stays under GOOGLE_NAME_SUFFIX_MAX. Shape: `DD.MM <user> GC-Launcher[ <tail>]`.
 */
/** Owner rule 2026-09-14: every campaign born through this console carries a HARDCODED
 *  "GC-Launcher" marker in its name (same idea as the FB auto-landing "GC-Launcher Auto-landing"),
 *  so console-born runs are tellable apart in every list that only shows names. */
export const GOOGLE_NAME_MARK = "GC-Launcher";

export function googleNameSuffix(args: { mode: GoogleMode; sourceId?: string; user: string; ddmm: string; tail?: string }): string {
  const user = squash(args.user) || "buyer";
  const head = `${args.ddmm} ${user} ${GOOGLE_NAME_MARK}`;
  let tail = squash(args.tail ?? "").replace(/\|/g, "/");
  const room = GOOGLE_NAME_SUFFIX_MAX - head.length - 1;
  if (tail && tail.length > room) tail = room > 0 ? tail.slice(0, room).trim() : "";
  return `${head}${tail ? ` ${tail}` : ""}`;
}

/** The campaign name LION will build around our suffix, for previews and provisional rows:
 *  `<head> | <suffix>[ | CLONE_FROM=<id> | JURO_FROM=<id>]`. */
export function googleNamePreview(args: { mode: GoogleMode; head: string; suffix: string; sourceId?: string }): string {
  const marker = args.mode === "clone" ? ` | CLONE_FROM=${args.sourceId ?? ""}` : args.mode === "juro" ? ` | JURO_FROM=${args.sourceId ?? ""}` : "";
  return `${args.head} | ${args.suffix}${marker}`;
}

// ---------- task lifecycle ----------

/** google-weapon task status → the monitor stage key. */
export function googleTaskStage(status: string): "queue" | "lion" | "done" | "failed" | "unknown" {
  const s = String(status ?? "").toLowerCase();
  if (s === "pending") return "queue";
  if (s === "running") return "lion";
  if (s === "completed") return "done";
  if (s === "failed") return "failed";
  return "unknown";
}

/** Human sentence for a google-weapon refusal body (`{error, available_pixels?, hint?, campaign_id?}`). */
export function googleWeaponErrorMessage(status: number | undefined, body: unknown): string {
  const rec = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  let msg = typeof rec.error === "string" && rec.error ? rec.error : typeof body === "string" && body ? body.slice(0, 300) : "";
  if (!msg) msg = status ? `google-weapon HTTP ${status}` : "google-weapon unreachable";
  if (Array.isArray(rec.available_pixels)) {
    const px = (rec.available_pixels as unknown[]).map(String).filter(Boolean);
    msg += px.length ? ` · available pixels: ${px.join(", ")}` : " · the account has no conversion pixel";
  }
  if (typeof rec.hint === "string" && rec.hint && !msg.includes(rec.hint)) msg += ` (${rec.hint})`;
  if (status === 403 && !/customer/i.test(msg)) msg += " — customer not allowed for the LION user";
  return msg;
}

/** Deterministic per-shot task ids: `ggc-<wave>-NN` (clone) / `ggj-<wave>-NN` (JURO). */
export function googleShotTaskId(mode: GoogleMode, waveId: string, index: number): string {
  const prefix = mode === "clone" ? "ggc" : mode === "juro" ? "ggj" : "ggl";
  return `${prefix}-${waveId}-${String(index + 1).padStart(2, "0")}`;
}

export const GOOGLE_WAVE_ID_RE = /^[a-zA-Z0-9-]{8,64}$/;
export const GOOGLE_CAMPAIGN_ID_RE = /^\d{5,}$/;
export const GOOGLE_CUSTOMER_ID_RE = /^\d{6,}$/;

// ---------- fresh launches (POST /api/external/campaign/launch/) ----------

/** Demand Gen copy limits from the partner docs. */
export const GOOGLE_HEADLINE_MAX = 40;
export const GOOGLE_LONG_HEADLINE_MAX = 90;
export const GOOGLE_DESCRIPTION_MAX = 90;
/** Google's Demand Gen asset caps (5 headlines / 5 long headlines / 5 descriptions per ad group). */
export const GOOGLE_TEXT_ASSETS_MAX = 5;
export const GOOGLE_VIDEOS_MAX = 5;

export const GOOGLE_CTAS: readonly { value: string; label: string }[] = [
  { value: "", label: "Automatic (Google picks)" },
  { value: "LEARN_MORE", label: "Learn more" },
  { value: "SHOP_NOW", label: "Shop now" },
  { value: "SIGN_UP", label: "Sign up" },
] as const;
const CTA_SET = new Set(GOOGLE_CTAS.map((c) => c.value).filter(Boolean));

/** Language codes the launcher offers (google-weapon takes a bare code like "en"; "" = none). */
export const GOOGLE_LANGUAGES: readonly { value: string; label: string }[] = [
  { value: "", label: "No language targeting" },
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "pt", label: "Portuguese" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "it", label: "Italian" },
  { value: "nl", label: "Dutch" },
  { value: "pl", label: "Polish" },
  { value: "ro", label: "Romanian" },
  { value: "cs", label: "Czech" },
  { value: "hu", label: "Hungarian" },
  { value: "el", label: "Greek" },
  { value: "sv", label: "Swedish" },
  { value: "da", label: "Danish" },
  { value: "no", label: "Norwegian" },
  { value: "fi", label: "Finnish" },
  { value: "tr", label: "Turkish" },
  { value: "ar", label: "Arabic" },
  { value: "hi", label: "Hindi" },
  { value: "id", label: "Indonesian" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
  { value: "zh", label: "Chinese" },
  { value: "vi", label: "Vietnamese" },
  { value: "th", label: "Thai" },
] as const;
const LANG_RE = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;

/** One ad group as the board sends it (already-hosted HTTPS assets; files ride Vercel Blob first). */
export type GoogleLaunchAdIn = {
  headlines: string[];
  longHeadlines: string[];
  descriptions: string[];
  /** "" = let Google pick. */
  callToAction?: string;
  logoUrl: string;
  youtubeUrls: string[];
  videoUrls: string[];
  channelId?: string;
};

/** One fresh-launch shot as the board sends it (money as HUMAN strings; copies expanded client-side). */
export type GoogleLaunchShotIn = {
  customer: string;
  budget: string;
  bidStrategy: string;
  bid: string;
  pixel?: string;
  suffix: string;
  landingUrl: string;
  /** ISO-2 codes; ["WW"] or [] = worldwide. */
  geo: string[];
  language?: string;
  mosh?: boolean;
  ads: GoogleLaunchAdIn[];
  /** Display material the board resolved (currency of the target account). */
  currency?: string;
  label?: string;
};

/** The partner wire of a fresh launch (`customer_id` + `name_suffix` + `pixel` are resolved by the route). */
export type GoogleLaunchWire = {
  customer_id: string;
  budget: string;
  bid_strategy: string;
  bid_value?: number;
  pixel?: string;
  name_suffix?: string;
  landing_url: string;
  geo?: string[];
  language?: string;
  mosh?: boolean;
  ads: Array<{
    headlines: string[];
    long_headlines: string[];
    descriptions: string[];
    call_to_action?: string;
    logo_url: string;
    youtube_urls?: string[];
    video_urls?: string[];
    channel_id?: string;
  }>;
};

const isHttps = (u: string): boolean => /^https:\/\/[^\s]+$/i.test(u);

/**
 * The landing as google-weapon takes it — mirror of the FB HS rail's "paste the bare landing"
 * rule. LION strips the query string and appends ITS tracking parameters (partner docs), so a
 * pasted link's own `?utm_…`/`#…` tail is dropped here too and the buyer sees exactly what will
 * ride. Returns null when the value isn't an https URL.
 */
export function googleLandingBase(raw: string): { base: string; strippedQuery: boolean } | null {
  const v = String(raw ?? "").trim();
  if (!/^https:\/\//i.test(v)) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" || !u.hostname.includes(".")) return null;
    const strippedQuery = Boolean(u.search || u.hash);
    u.search = "";
    u.hash = "";
    return { base: u.toString(), strippedQuery };
  } catch {
    return null;
  }
}

/**
 * LION's tracking tail on Google campaigns — READ BACK LIVE 2026-09-14 from two console-born
 * campaigns on GC-Vis-2 (launch 24244650168 and clone 24255820798, Google Ads API):
 *   ?utm_source=google&utm_campaign=glo-01_{campaignid}_21&utm_medium=glo-01&mb=glo-01
 *     &pixel=AW-18326906213/N6PACLqsrtEcEOXK-aJE&platform=google
 * `glo-01` = the LION user's ACR (lower-cased), `pixel` = the campaign's conversion pixel,
 * `{campaignid}` = Google's ValueTrack macro (kept raw), `_21` = a LION-side counter we don't
 * control (shown as NN). Rendered in the preview only — the wire carries the BARE landing and
 * LION appends this itself (clones get the same tail on a landing rotated through LION's map).
 */
export function googleTrackingTail(ctx: { acr?: string; pixel?: string } = {}): string {
  const acr = (ctx.acr || "glo-01").toLowerCase();
  const pixel = ctx.pixel || "<pixel>";
  return `utm_source=google&utm_campaign=${acr}_{campaignid}_NN&utm_medium=${acr}&mb=${acr}&pixel=${pixel}&platform=google`;
}

/** Role-tagged segments of the FINAL link LION will send the click to (the FB card's coloured
 *  preview, Google flavour): the bare landing + LION's own tracking tail. */
export type GoogleLinkSegment = { text: string; role: "slug" | "params" | "pixel" };
export function googleLandingSegments(raw: string, ctx: { acr?: string; pixel?: string } = {}): GoogleLinkSegment[] {
  const b = googleLandingBase(raw);
  if (!b) return [];
  const acr = (ctx.acr || "glo-01").toLowerCase();
  return [
    { text: b.base, role: "slug" },
    { text: `?utm_source=google&utm_campaign=${acr}_{campaignid}_NN&utm_medium=${acr}&mb=${acr}`, role: "params" },
    { text: `&pixel=${ctx.pixel || "<pixel>"}`, role: "pixel" },
    { text: "&platform=google", role: "params" },
  ];
}

/** Logo URL sanity for the URL mode: google-weapon wants a public HTTPS image (square PNG/JPG/
 *  GIF). An https URL whose path doesn't end in an image extension is only a WARNING (a CDN
 *  image URL may carry no extension) — the wire still goes out and LION has the final word. */
export const GOOGLE_LOGO_EXT_RE = /\.(png|jpe?g|gif)(?:$|[?#])/i;
export function googleLogoUrlNote(url: string): string | null {
  const u = String(url ?? "").trim();
  if (!u) return null;
  if (!/^https:\/\//i.test(u)) return "Logo must be a public https:// image URL";
  return GOOGLE_LOGO_EXT_RE.test(u) ? null : "Doesn't look like an image URL (.png / .jpg / .gif) — LION will refuse a non-image";
}

/** Google's logo rules for Demand Gen (docs: square PNG/JPG/GIF): 1:1, at least 128×128. */
export const GOOGLE_LOGO_MIN_PX = 128;
export function googleLogoDimsIssue(dims: { w: number; h: number } | null | undefined): string | null {
  if (!dims) return null;
  if (dims.w !== dims.h) return `Logo must be square — this one is ${dims.w}×${dims.h}`;
  if (dims.w < GOOGLE_LOGO_MIN_PX) return `Logo must be at least ${GOOGLE_LOGO_MIN_PX}×${GOOGLE_LOGO_MIN_PX} — this one is ${dims.w}×${dims.h}`;
  return null;
}
const YT_RE = /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)[\w-]{6,}/i;
export const isYoutubeUrl = (u: string): boolean => YT_RE.test(String(u ?? "").trim());

const cleanList = (xs: unknown, max: number): string[] =>
  (Array.isArray(xs) ? xs : []).map((x) => squash(String(x ?? ""))).filter(Boolean).slice(0, max + 1);

/** Geo list → wire: [] / ["WW"] → worldwide (omitted); else upper-cased ISO-2 codes. */
export function googleGeoWire(geo: unknown): { geo?: string[] } | { refusal: string } {
  const codes = [...new Set((Array.isArray(geo) ? geo : []).map((g) => String(g ?? "").trim().toUpperCase()).filter(Boolean))];
  if (codes.length === 0 || (codes.length === 1 && codes[0] === "WW")) return {};
  if (codes.includes("WW")) return { refusal: "Worldwide (WW) cannot be mixed with countries — pick one or the other" };
  const bad = codes.filter((c) => !/^[A-Z]{2}$/.test(c));
  if (bad.length) return { refusal: `Unknown country code${bad.length === 1 ? "" : "s"}: ${bad.join(", ")}` };
  return { geo: codes };
}

/**
 * Build the fresh-launch wire for ONE shot, refusing with the exact fix when a field can't ride:
 * copy limits (40/90/90, 1–5 each), CTA vocabulary, HTTPS logo, EXACTLY ONE of YouTube links /
 * hosted video files (1–5), HTTPS landing, geo/language shapes, budget, and an EXPLICIT bidding
 * strategy with the bid the strategy takes (googleBidPlan mode "launch").
 * `customerId`/`pixel`/`nameSuffix` are the route's resolved values.
 */
export function googleLaunchWire(
  shot: GoogleLaunchShotIn,
  resolved: { customerId: string; pixel?: string; nameSuffix: string },
): { wire: GoogleLaunchWire; label: string; kind: GoogleBidKind | "unknown" } | { refusal: string } {
  const budget = googleBudgetWire(String(shot.budget ?? ""));
  if (!budget) return { refusal: "budget must be between 1 and 10000 in the target account currency" };
  const plan = googleBidPlan({ mode: "launch", override: String(shot.bidStrategy ?? ""), typedBid: String(shot.bid ?? "") });
  if ("refusal" in plan) return { refusal: plan.refusal };
  const landingBase = googleLandingBase(String(shot.landingUrl ?? ""));
  if (!landingBase) return { refusal: "landing URL must be an https:// address on LION's allowed URL map" };
  const landing = landingBase.base; // bare — LION strips the query and appends its own tracking
  const geo = googleGeoWire(shot.geo);
  if ("refusal" in geo) return { refusal: geo.refusal };
  const language = String(shot.language ?? "").trim();
  if (language && !LANG_RE.test(language)) return { refusal: `language must be a code like "en" (got "${language}")` };
  const adsIn = Array.isArray(shot.ads) ? shot.ads : [];
  if (adsIn.length === 0) return { refusal: "at least one ad group (headlines, descriptions, logo and a video) is required" };
  const ads: GoogleLaunchWire["ads"] = [];
  for (let i = 0; i < adsIn.length; i++) {
    const a = adsIn[i];
    const at = adsIn.length === 1 ? "" : ` (ad group ${i + 1})`;
    const headlines = cleanList(a.headlines, GOOGLE_TEXT_ASSETS_MAX);
    const longHeadlines = cleanList(a.longHeadlines, GOOGLE_TEXT_ASSETS_MAX);
    const descriptions = cleanList(a.descriptions, GOOGLE_TEXT_ASSETS_MAX);
    const check = (name: string, xs: string[], max: number): string | null => {
      if (xs.length === 0) return `${name}: at least one is required${at}`;
      if (xs.length > GOOGLE_TEXT_ASSETS_MAX) return `${name}: at most ${GOOGLE_TEXT_ASSETS_MAX}${at}`;
      const over = xs.find((x) => x.length > max);
      return over ? `${name}: "${over.slice(0, 30)}…" is over ${max} characters${at}` : null;
    };
    const bad =
      check("Headlines", headlines, GOOGLE_HEADLINE_MAX) ??
      check("Long headlines", longHeadlines, GOOGLE_LONG_HEADLINE_MAX) ??
      check("Descriptions", descriptions, GOOGLE_DESCRIPTION_MAX);
    if (bad) return { refusal: bad };
    const cta = String(a.callToAction ?? "").trim();
    if (cta && !CTA_SET.has(cta)) return { refusal: `Call to action must be one of Learn more / Shop now / Sign up${at}` };
    const logo = String(a.logoUrl ?? "").trim();
    if (!isHttps(logo)) return { refusal: `Logo: a public https:// image URL (square PNG/JPG) is required${at}` };
    const yt = cleanList(a.youtubeUrls, GOOGLE_VIDEOS_MAX);
    const vids = cleanList(a.videoUrls, GOOGLE_VIDEOS_MAX);
    if (yt.length > 0 && vids.length > 0) return { refusal: `Use either YouTube links or uploaded videos, not both${at}` };
    if (yt.length === 0 && vids.length === 0) return { refusal: `At least one video (a YouTube link or an uploaded file) is required${at}` };
    if (yt.length > GOOGLE_VIDEOS_MAX || vids.length > GOOGLE_VIDEOS_MAX) return { refusal: `At most ${GOOGLE_VIDEOS_MAX} videos${at}` };
    const badYt = yt.find((u) => !isYoutubeUrl(u));
    if (badYt) return { refusal: `Not a YouTube link: ${badYt.slice(0, 60)}${at}` };
    const badVid = vids.find((u) => !isHttps(u));
    if (badVid) return { refusal: `Video files must be public https:// URLs${at}` };
    const channelId = String(a.channelId ?? "").trim();
    if (channelId && yt.length > 0) return { refusal: `channel id applies to uploaded videos only${at}` };
    ads.push({
      headlines,
      long_headlines: longHeadlines,
      descriptions,
      ...(cta ? { call_to_action: cta } : {}),
      logo_url: logo,
      ...(yt.length ? { youtube_urls: yt } : { video_urls: vids }),
      ...(channelId && vids.length ? { channel_id: channelId } : {}),
    });
  }
  const wire: GoogleLaunchWire = {
    customer_id: resolved.customerId,
    budget,
    bid_strategy: plan.wireStrategy as string,
    ...(plan.wireBid != null ? { bid_value: plan.wireBid } : {}),
    ...(resolved.pixel ? { pixel: resolved.pixel } : {}),
    ...(resolved.nameSuffix ? { name_suffix: resolved.nameSuffix } : {}),
    landing_url: landing,
    ...("geo" in geo && geo.geo ? { geo: geo.geo } : {}),
    ...(language ? { language } : {}),
    ...(shot.mosh ? { mosh: true } : {}),
    ads,
  };
  return { wire, label: plan.label, kind: plan.kind };
}

/** Geo list as the monitor's geo column shows it ("BE+CA", "WW"). */
export const googleGeoLabel = (geo: unknown): string => {
  const g = googleGeoWire(geo);
  return "refusal" in g ? "" : g.geo ? g.geo.join("+") : "WW";
};

// ---------- launcher texture (mirrors LION's own Demand Gen launcher UI, owner ask 14.09) ----------

/** The 5 strategies LION's launcher UI offers (its external API also takes the two "_cap" /
 *  "_target" variants, kept in GOOGLE_BID_STRATEGIES for the clone board's inherit-and-switch). */
export const GOOGLE_LAUNCH_BID_STRATEGIES: readonly GoogleBidStrategy[] = GOOGLE_BID_STRATEGIES.filter((s) =>
  ["maximize_conversions", "target_cpa", "target_roas", "maximize_conversion_value", "manual_cpc"].includes(s.value),
);

/** LION launcher geo presets. ANGLO = the six English markets the team's names carry
 *  ("AU+CA+IE+NZ+GB+US"); FRANCO = the French-speaking set; WORLD = worldwide (no geo on the wire). */
export const GOOGLE_GEO_PRESETS: readonly { label: string; codes: string[] }[] = [
  { label: "World", codes: ["WW"] },
  { label: "LATAM", codes: ["AR", "BO", "CL", "CO", "CR", "DO", "EC", "GT", "HN", "MX", "NI", "PA", "PE", "PR", "PY", "SV", "UY"] },
  { label: "Anglo", codes: ["US", "CA", "GB", "AU", "NZ", "IE"] },
  { label: "Franco", codes: ["FR", "BE", "CH", "LU", "MC", "CA"] },
] as const;

/** LION's language list (its launcher offers these 52; the external API takes ONE code). */
export const GOOGLE_LANGUAGES_FULL: readonly { value: string; label: string }[] = [
  { value: "", label: "No language targeting" },
  { value: "ar", label: "Arabic" },
  { value: "bn", label: "Bengali" },
  { value: "bg", label: "Bulgarian" },
  { value: "ca", label: "Catalan" },
  { value: "zh_CN", label: "Chinese (simplified)" },
  { value: "zh_TW", label: "Chinese (traditional)" },
  { value: "hr", label: "Croatian" },
  { value: "cs", label: "Czech" },
  { value: "da", label: "Danish" },
  { value: "nl", label: "Dutch" },
  { value: "en", label: "English" },
  { value: "et", label: "Estonian" },
  { value: "tl", label: "Filipino" },
  { value: "fi", label: "Finnish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "el", label: "Greek" },
  { value: "gu", label: "Gujarati" },
  { value: "iw", label: "Hebrew" },
  { value: "hi", label: "Hindi" },
  { value: "hu", label: "Hungarian" },
  { value: "is", label: "Icelandic" },
  { value: "id", label: "Indonesian" },
  { value: "it", label: "Italian" },
  { value: "ja", label: "Japanese" },
  { value: "kn", label: "Kannada" },
  { value: "ko", label: "Korean" },
  { value: "lv", label: "Latvian" },
  { value: "lt", label: "Lithuanian" },
  { value: "ms", label: "Malay" },
  { value: "ml", label: "Malayalam" },
  { value: "mr", label: "Marathi" },
  { value: "no", label: "Norwegian" },
  { value: "fa", label: "Persian" },
  { value: "pl", label: "Polish" },
  { value: "pt", label: "Portuguese" },
  { value: "pa", label: "Punjabi" },
  { value: "ro", label: "Romanian" },
  { value: "ru", label: "Russian" },
  { value: "sr", label: "Serbian" },
  { value: "sk", label: "Slovak" },
  { value: "sl", label: "Slovenian" },
  { value: "es", label: "Spanish" },
  { value: "sv", label: "Swedish" },
  { value: "ta", label: "Tamil" },
  { value: "te", label: "Telugu" },
  { value: "th", label: "Thai" },
  { value: "tr", label: "Turkish" },
  { value: "uk", label: "Ukrainian" },
  { value: "ur", label: "Urdu" },
  { value: "vi", label: "Vietnamese" },
] as const;

/** LION's launcher takes copy as ONE pipe-separated field ("H1 | H2 | H3"): split, trim, drop empties. */
export function splitPipes(raw: string): string[] {
  return String(raw ?? "")
    .split("|")
    .map((s) => squash(s))
    .filter(Boolean);
}
export const joinPipes = (xs: readonly string[]): string => xs.map((x) => squash(x)).filter(Boolean).join(" | ");

/** LION's launcher takes YouTube links one per line (also tolerates commas/spaces): split, dedupe. */
export function splitLines(raw: string): string[] {
  return [...new Set(String(raw ?? "").split(/[\n,\s]+/).map((s) => s.trim()).filter(Boolean))];
}

/** Bulk mode: N videos → ad groups of at most GOOGLE_VIDEOS_MAX each, every group carrying the
 *  same copy/CTA/logo (LION: "Up to 50 videos — auto-split into ad groups of 5, duplicating all
 *  fields"). Returns [] for no videos. */
export const GOOGLE_BULK_VIDEOS_MAX = 50;
export function chunkVideosIntoAdGroups<T extends Record<string, unknown>>(videos: string[], template: T, key: "youtubeUrls" | "videoUrls"): Array<T & { youtubeUrls: string[]; videoUrls: string[] }> {
  const list = videos.filter(Boolean).slice(0, GOOGLE_BULK_VIDEOS_MAX);
  const out: Array<T & { youtubeUrls: string[]; videoUrls: string[] }> = [];
  for (let i = 0; i < list.length; i += GOOGLE_VIDEOS_MAX) {
    const chunk = list.slice(i, i + GOOGLE_VIDEOS_MAX);
    out.push({ ...template, youtubeUrls: key === "youtubeUrls" ? chunk : [], videoUrls: key === "videoUrls" ? chunk : [] });
  }
  return out;
}

/** The offer word LION derives from the landing's domain ("corquieu.com" → "CORQUIEU"). */
export function googleOfferFromLanding(landing: string): string {
  const b = googleLandingBase(landing);
  if (!b) return "";
  const host = new URL(b.base).hostname.replace(/^www\./i, "");
  const sld = host.split(".").length >= 2 ? host.split(".").slice(-2, -1)[0] : host;
  return sld.toUpperCase();
}

/**
 * The read-only campaign-name PREFIX LION's launcher shows (its tooltip:
 * `{HS-____} ({buyer}) #ADX [META] - DEMANDA (YTB) - {geo} - {offer}`; live names read
 * `{HS-xxxx} <ACCOUNT> - (GLO-01) #ADX [HIGH] - DEMANDA (YTB) - <GEO> - <OFFER> DIRETO`).
 * `{HS-____}` becomes a unique 4-char hash at launch; everything after ` | ` is ours.
 */
export function googleNameHeadPreview(args: { accountName: string; acr: string; geo: unknown; landing: string }): string {
  const acr = (args.acr || "GLO-01").toUpperCase();
  const geo = googleGeoLabel(args.geo) || "WW";
  const offer = googleOfferFromLanding(args.landing);
  return `{HS-____} ${args.accountName || "<account>"} - (${acr}) #ADX [HIGH] - DEMANDA (YTB) - ${geo} - ${offer || "<offer>"} DIRETO`;
}

// ---------- account allowlist (owner rule 2026-09-14) ----------

/** The LION MCC our Google launches live on (GLO-HS-00N accounts, BRL). */
export const GOOGLE_LAUNCH_MCC = "2678500976";
export const GOOGLE_LAUNCH_ACCOUNT_RE = /^GLO-HS-\d{3}$/i;

/** Only the GLO-HS-001…010 accounts are offered and accepted for Google launches (owner rule
 *  14.09: the suspended "Ads N" book, GC-Vis and the pixel-less GC-HS-Lion-BR-N stay hidden).
 *  Name pattern + MCC, so a future GLO-HS-011 appears by itself. */
/** GLO-HS accounts the owner took out of rotation (owner ask 17.09): hidden from every picker
 *  and refused as a launch/clone/JURO target — one predicate, so "not shown" always means
 *  "not launchable". Names compared case-insensitively, trimmed. */
export const GOOGLE_HIDDEN_LAUNCH_ACCOUNTS: ReadonlySet<string> = new Set(["GLO-HS-001", "GLO-HS-003"]);

export function isGoogleLaunchAccount(c: { name: string; mccId?: string }): boolean {
  const name = String(c.name ?? "").trim();
  if (GOOGLE_HIDDEN_LAUNCH_ACCOUNTS.has(name.toUpperCase())) return false;
  return GOOGLE_LAUNCH_ACCOUNT_RE.test(name) && (!c.mccId || c.mccId === GOOGLE_LAUNCH_MCC);
}
