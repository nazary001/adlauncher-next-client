// Snapchat rail — pure decisions (docs/superpowers/specs/2026-09-16-snapchat-rail-design.md).
// Deliberately dependency-free (no "@/" imports, no relative imports) so `node --test` runs it
// straight off Node's type stripping. Part 1 (this task): the PARTNER contract — the 100 fixed
// revenue keys, the two landings, the exact link shape, the console name. Part 2 (Task 2): the
// launch vocabulary and `snapLaunchWire`, the ONE validator the board dry-runs and the pump runs.

// ---------- partner keys ----------

/** The partner tags every landing hit by this utm_source; it never changes per campaign. */
export const SNAP_UTM_SOURCE = "stone";
export const SNAP_KEY_PREFIX = "glo-snp_";
export const SNAP_KEY_POOL_MAX = 100;
export const SNAP_KEY_RE = /^glo-snp_(\d{3})$/;

/** Pool index 1..100 → the partner's fixed key ("glo-snp_007"); "" outside the pool. */
export function snapKeyCode(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > SNAP_KEY_POOL_MAX) return "";
  return `${SNAP_KEY_PREFIX}${String(n).padStart(3, "0")}`;
}

/** Key → pool index, null for anything that isn't one of the 100 keys (strict: prefix, 3 digits). */
export function snapKeyIndex(key: string): number | null {
  const m = SNAP_KEY_RE.exec(String(key ?? "").trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= SNAP_KEY_POOL_MAX ? n : null;
}

export const isSnapKey = (key: string): boolean => snapKeyIndex(key) !== null;

/** Every key of the pool, in order (the keys page lists all 100, bound or free). */
export function snapKeyPool(): string[] {
  return Array.from({ length: SNAP_KEY_POOL_MAX }, (_, i) => snapKeyCode(i + 1));
}

// ---------- partner landings ----------

export type SnapLandingId = "dmi" | "cars";
export type SnapLanding = { id: SnapLandingId; niche: string; url: string };

/** The partner's pages (brief 16.09). Revenue is reported ONLY for hits on these. */
export const SNAP_LANDINGS: readonly SnapLanding[] = [
  { id: "dmi", niche: "Digital marketing", url: "https://azmvhs.com/v/dmi-online-marketing-course/" },
  { id: "cars", niche: "Cars", url: "https://azmvhs.com/v/auto-financing-by-ford/" },
] as const;

export const snapLandingById = (id: string): SnapLanding | null => SNAP_LANDINGS.find((l) => l.id === id) ?? null;

/**
 * The landing as the wire takes it: https only, a real hostname, and any pasted query/hash
 * DROPPED — our two utm params must be the only query (Snap appends ScCid itself; a stray
 * utm_source from a pasted link would override the partner's `stone`). Null = not an https URL.
 */
export function snapLandingBase(raw: string): { base: string; strippedQuery: boolean } | null {
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

export const isPartnerLanding = (base: string): boolean => SNAP_LANDINGS.some((l) => l.url === base);

/** The final ad URL — EXACTLY the brief's shape, static params, no Snapchat macros. */
export function snapLandingUrl(base: string, key: string): string {
  return `${base}?utm_source=${SNAP_UTM_SOURCE}&utm_campaign=${key}`;
}

/** Role-tagged segments for the card's coloured preview. The first four joined ARE the real link
 *  (snapLandingUrl); the trailing `sccid` segment is a preview-only note — Snap appends the real
 *  `&ScCid=<click id>` on every swipe, nothing to send. */
export type SnapLinkRole = "landing" | "utm" | "keyName" | "key" | "sccid";
export type SnapLinkSegment = { text: string; role: SnapLinkRole };
export function snapLandingSegments(raw: string, key: string): SnapLinkSegment[] {
  const b = snapLandingBase(raw);
  if (!b) return [];
  return [
    { text: b.base, role: "landing" },
    { text: `?utm_source=${SNAP_UTM_SOURCE}`, role: "utm" },
    { text: "&utm_campaign=", role: "keyName" },
    { text: key || "glo-snp_???", role: "key" },
    { text: "&ScCid=<appended by Snap>", role: "sccid" },
  ];
}

// ---------- naming ----------

/** Owner rule 2026-09-14: every campaign born through this console carries a hardcoded marker. */
export const SNAP_NAME_MARK = "GC-Launcher";
/** Snapchat's cap on campaign / ad squad / creative / ad names. */
export const SNAP_NAME_MAX = 375;

const squash = (s: string): string => String(s ?? "").replace(/\s+/g, " ").trim();
const noPipes = (s: string): string => s.replace(/\|/g, "/");

/**
 * The console name, used verbatim on the campaign, the ad squad, the creative and the ad:
 * `[DD.MM] (SNP) <niche> - <GEO> - <key> - <user> - GC-Launcher[ - <tail>]`. The key inside the
 * name makes LION's per-key report readable from Ads Manager; pipes are replaced so a tail can't
 * fake a segment; the tail is trimmed first when the whole thing would pass SNAP_NAME_MAX.
 */
export function snapCampaignName(args: { ddmm: string; niche: string; geoLabel: string; key: string; user: string; tail?: string }): string {
  const user = noPipes(squash(args.user)) || "buyer";
  const niche = noPipes(squash(args.niche)) || "Snap";
  const geo = squash(args.geoLabel) || "??";
  const head = `[${args.ddmm}] (SNP) ${niche} - ${geo} - ${args.key} - ${user} - ${SNAP_NAME_MARK}`;
  let tail = noPipes(squash(args.tail ?? ""));
  const room = SNAP_NAME_MAX - head.length - 3; // " - " between head and tail
  if (tail && tail.length > room) tail = room > 0 ? tail.slice(0, room).trim() : "";
  return `${head}${tail ? ` - ${tail}` : ""}`;
}

// ---------- São Paulo clock (LION's day boundary; the team's name date) ----------

function saoPauloParts(d: Date): Record<string, string> {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(d)
    .reduce<Record<string, string>>((acc, p) => ((acc[p.type] = p.value), acc), {});
}

/** Today as DD.MM in São Paulo (the name date). Injectable clock for tests. */
export function todaySaoPauloDotDDMM(now: Date = new Date()): string {
  const p = saoPauloParts(now);
  return `${p.day}.${p.month}`;
}

/** YYYY-MM-DD of (now − offsetDays) in São Paulo — LION's report day. */
export function saoPauloDateISO(offsetDays = 0, now: Date = new Date()): string {
  const p = saoPauloParts(new Date(now.getTime() - offsetDays * 86_400_000));
  return `${p.year}-${p.month}-${p.day}`;
}

// ======================================================================================
// Part 2 — launch vocabulary + the ONE validator
// ======================================================================================

// ---------- bidding ----------

/** What a Snapchat bid strategy takes: none = no bid_micro (sending one is a 400), bid = money. */
export type SnapBidKind = "none" | "bid";
export type SnapBidStrategy = { value: string; label: string; kind: SnapBidKind };

/** Snap's live vocabulary for web campaigns. MIN_ROAS is NOT offered — Snap deprecated it on
 *  10.02.2025 (docs read 16.09.2026). */
export const SNAP_BID_STRATEGIES: readonly SnapBidStrategy[] = [
  { value: "AUTO_BID", label: "Auto bid", kind: "none" },
  { value: "LOWEST_COST_WITH_MAX_BID", label: "Max bid", kind: "bid" },
  { value: "TARGET_COST", label: "Target cost", kind: "bid" },
] as const;
const STRATEGY_BY_VALUE = new Map(SNAP_BID_STRATEGIES.map((s) => [s.value, s]));
export const snapBidKind = (v: string): SnapBidKind | "unknown" => STRATEGY_BY_VALUE.get(v)?.kind ?? "unknown";
export const snapStrategyLabel = (v: string): string => STRATEGY_BY_VALUE.get(v)?.label ?? v;

/** Ad squad optimization goals the launcher offers; PIXEL_* need the account's pixel. */
export const SNAP_OPTIMIZATION_GOALS: readonly { value: string; label: string; needsPixel: boolean }[] = [
  { value: "PIXEL_PURCHASE", label: "Pixel purchase", needsPixel: true },
  { value: "PIXEL_PAGE_VIEW", label: "Pixel page view", needsPixel: true },
  { value: "LANDING_PAGE_VIEW", label: "Landing page view", needsPixel: false },
  { value: "SWIPES", label: "Swipes (clicks)", needsPixel: false },
  { value: "IMPRESSIONS", label: "Impressions", needsPixel: false },
] as const;
const GOAL_BY_VALUE = new Map(SNAP_OPTIMIZATION_GOALS.map((g) => [g.value, g]));
export const snapGoalNeedsPixel = (v: string): boolean => GOAL_BY_VALUE.get(v)?.needsPixel ?? false;
export const snapGoalLabel = (v: string): string => GOAL_BY_VALUE.get(v)?.label ?? v;

/** Calls to action Snap accepts on a WEB_VIEW creative (a curated ten of its list). */
export const SNAP_CTAS: readonly { value: string; label: string }[] = [
  { value: "MORE", label: "More" },
  { value: "SHOP_NOW", label: "Shop now" },
  { value: "SIGN_UP", label: "Sign up" },
  { value: "APPLY_NOW", label: "Apply now" },
  { value: "VIEW", label: "View" },
  { value: "READ", label: "Read" },
  { value: "GET_NOW", label: "Get now" },
  { value: "TRY", label: "Try" },
  { value: "SHOW", label: "Show" },
  { value: "WATCH", label: "Watch" },
] as const;
const CTA_SET = new Set(SNAP_CTAS.map((c) => c.value));

/** Geo presets. Snap has NO worldwide token — every ad squad names its countries. */
export const SNAP_GEO_PRESETS: readonly { label: string; codes: string[] }[] = [
  { label: "US", codes: ["US"] },
  { label: "Anglo", codes: ["US", "CA", "GB", "AU", "NZ", "IE"] },
  { label: "LATAM", codes: ["AR", "BO", "CL", "CO", "CR", "DO", "EC", "GT", "HN", "MX", "NI", "PA", "PE", "PR", "PY", "SV", "UY"] },
  { label: "Franco", codes: ["FR", "BE", "CH", "LU", "MC", "CA"] },
  {
    label: "EU",
    codes: ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"],
  },
] as const;

export const SNAP_MIN_AGES = ["18", "21", "25"] as const;

// ---------- limits ----------

export const SNAP_DEFAULT_BUDGET = "10,00";
/** Snap's own floor is USD 5/day (daily_budget_micro ≥ 5 000 000). */
export const SNAP_BUDGET_MIN = 5;
export const SNAP_BUDGET_MAX = 10_000;
/** Snap's USD bid_micro range 10 000 … 500 000 000. */
export const SNAP_BID_MIN = 0.01;
export const SNAP_BID_MAX = 500;
export const SNAP_HEADLINE_MAX = 34;
export const SNAP_BRAND_MAX = 32;
/** Single-part media upload cap (bigger needs Snap's chunked upload — not in v1). */
export const SNAP_MEDIA_MAX_BYTES = 32 * 1024 * 1024;
/** Creatives per campaign: an abuse guard on the wire, NOT a product limit — the board offers no
 *  cap, Snapchat documents none on ads per ad squad, and the pump's time budget ends an overlong
 *  list gracefully (the campaign goes live with the ads built so far). */
export const SNAP_MAX_CREATIVES = 200;
export const SNAP_MAX_SHOTS = 45;

/** Ad accounts the launcher never offers nor accepts (owner ask 17.09): Snapchat auto-creates an
 *  "<org> Self Service" account on every organization — no pixel, not a buying account — and any
 *  id listed here is hidden too. One predicate for the catalog AND the wave route, so "not shown"
 *  always means "not launchable". Name compared case-insensitively, trimmed. */
export const SNAP_HIDDEN_AD_ACCOUNT_IDS: ReadonlySet<string> = new Set(["d7defe80-abed-4109-8a8f-556619f14989"]);
export function isSnapLaunchAccount(a: { id: string; name: string }): boolean {
  if (SNAP_HIDDEN_AD_ACCOUNT_IDS.has(String(a.id ?? "").trim())) return false;
  return !/\bself service$/i.test(String(a.name ?? "").trim());
}
export const SNAP_MAX_COPIES = 20;
export const SNAP_WAVE_ID_RE = /^[a-zA-Z0-9-]{8,64}$/;

// ---------- money ----------

/** Decimal-comma aware string → number: a lone comma is the decimal point; "1,234.56" reads the
 *  comma as thousands. Byte-identical copy of lib/google-bid parseDecimal — NOT lib/types
 *  parseMoney, which follows a looser rule ("1,2,3" → 1.2, "1 000" → 1000, unparsable → 0; NaN
 *  here) — kept local because this module must load under `node --test` without imports. Keep
 *  the two copies in sync. */
export function parseDecimal(raw: string): number {
  const s = String(raw ?? "").trim();
  if (!s) return NaN;
  const normalized = s.includes(",") && s.includes(".") ? s.replace(/,/g, "") : s.replace(",", ".");
  if (!/^-?\d*(?:\.\d*)?$/.test(normalized) || normalized === "." || normalized === "-") return NaN;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : NaN;
}

/** Human money ("10,00") → Snap micro-currency (integer), null when unparsable or outside [min, max]. */
export function snapMicro(human: string, min: number, max: number): number | null {
  const n = parseDecimal(human);
  if (!Number.isFinite(n)) return null;
  const cents = Math.round(n * 100);
  if (cents < Math.round(min * 100) || cents > Math.round(max * 100)) return null;
  return cents * 10_000;
}

/** Decimal-comma money text without trailing ",00" ("0,5", "10", "1,25"). */
export function snapMoneyText(v: number): string {
  const rounded = Math.round(v * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(".", ",");
}

const CUR_SYMBOL: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", BRL: "R$" };
export const snapCurrencySymbol = (code: string): string => CUR_SYMBOL[String(code ?? "").toUpperCase()] || (code ? `${code} ` : "$");

/** Monitor tag (≤ 40 chars): "auto" / "max $0,5" / "target $1,2". */
export function snapBidLabel(strategy: string, bidMicro: number | undefined, currency: string): string {
  const kind = snapBidKind(strategy);
  if (kind !== "bid") return "auto";
  const word = strategy === "TARGET_COST" ? "target" : "max";
  if (bidMicro == null) return `${word} ?`;
  return `${word} ${snapCurrencySymbol(currency)}${snapMoneyText(bidMicro / 1_000_000)}`.slice(0, 40);
}

// ---------- geo ----------

/** Geo list → Snap targeting geos (lower-cased ISO-2, deduped) + the monitor label ("US+CA"). */
export function snapGeoWire(geo: unknown): { geos: { country_code: string }[]; label: string } | { refusal: string } {
  const codes = [...new Set((Array.isArray(geo) ? geo : []).map((g) => String(g ?? "").trim().toUpperCase()).filter(Boolean))];
  if (codes.length === 0) return { refusal: "Pick at least one country — Snapchat has no worldwide targeting" };
  if (codes.includes("WW")) return { refusal: "Snapchat has no worldwide token — pick the countries (or a preset)" };
  const bad = codes.filter((c) => !/^[A-Z]{2}$/.test(c));
  if (bad.length) return { refusal: `Unknown country code${bad.length === 1 ? "" : "s"}: ${bad.join(", ")}` };
  return { geos: codes.map((c) => ({ country_code: c.toLowerCase() })), label: codes.join("+") };
}

// ---------- task ids ----------

/** Deterministic per-shot task ids: `snl-<wave>-NN` (Snap launch). */
export function snapShotTaskId(waveId: string, index: number): string {
  return `snl-${waveId}-${String(index + 1).padStart(2, "0")}`;
}

// ---------- the wire ----------

/** One creative of a shot: the public Blob URL the board uploaded, its kind, its file name. */
export type SnapShotMedia = { url: string; kind: "video" | "image"; name?: string };

/** One shot as the board sends it (money as HUMAN strings; copies expanded client-side, one
 *  shot = one campaign = one key). `media` lists the card's creatives — each becomes its own
 *  creative + ad inside the campaign's ONE ad squad, all on the campaign's key. */
export type SnapLaunchShotIn = {
  label?: string;
  adAccount: string;
  pixel?: string;
  profileId?: string;
  optimizationGoal: string;
  bidStrategy: string;
  bid: string;
  budget: string;
  startPaused?: boolean;
  headline: string;
  brandName: string;
  cta: string;
  media: SnapShotMedia[];
  /** ISO-2 codes (Snap has no WW). */
  geo: string[];
  minAge: string;
  landingId: SnapLandingId | "custom";
  /** Custom landing (https, any query dropped); ignored for the partner landings. */
  landingUrl: string;
  /** The key the board previewed; the pump claims it or the next free one. */
  desiredKey?: string;
  suffix: string;
  /** Display material the board resolved (currency of the ad account). */
  currency?: string;
};

export type SnapCampaignWire = { name: string; ad_account_id: string; status: "PAUSED" | "ACTIVE"; start_time: string };
export type SnapAdSquadWire = {
  name: string;
  type: "SNAP_ADS";
  billing_event: "IMPRESSION";
  delivery_constraint: "DAILY_BUDGET";
  daily_budget_micro: number;
  bid_strategy: string;
  bid_micro?: number;
  optimization_goal: string;
  placement_v2: { config: "AUTOMATIC" };
  targeting: { geos: { country_code: string }[]; demographics: { min_age: string }[] };
  pixel_id?: string;
  status: "ACTIVE";
  start_time: string;
};
export type SnapCreativeWire = {
  ad_account_id: string;
  name: string;
  type: "WEB_VIEW";
  ad_product: "SNAP_AD";
  headline: string;
  brand_name: string;
  call_to_action: string;
  top_snap_media_id: string;
  shareable: true;
  web_view_properties: { url: string; block_preload: false; allow_snap_javascript_sdk: false; use_immersive_mode: false };
  profile_properties: { profile_id: string };
};
export type SnapAdWire = { name: string; type: "REMOTE_WEBPAGE"; status: "ACTIVE" };
/** One creative + its ad; `index` is the creative's place in `shot.media` (names and the row's
 *  notes number creatives by it, so "#3" is always the third file of the card). */
export type SnapAdUnitWire = { index: number; creative: SnapCreativeWire; ad: SnapAdWire };
/** The Snap bodies of one campaign — campaign, ad squad and one creative+ad unit per creative
 *  (parent ids — campaign_id, ad_squad_id, creative_id — are added by the pump as the chain
 *  proceeds) + the final landing URL for the row's `link`. */
export type SnapLaunchWire = { campaign: SnapCampaignWire; adsquad: SnapAdSquadWire; ads: SnapAdUnitWire[]; landingUrl: string };

/** What the route/pump resolved around the shot. `mediaIds` runs parallel to `shot.media`; an
 *  empty id is a creative the pump skipped (its upload failed) — no unit is built for it. The
 *  board dry-runs with placeholders (key "glo-snp_001", media ids "pending", name "preview"). */
export type SnapResolved = { adAccountId: string; pixelId?: string; profileId: string; name: string; key: string; mediaIds: string[]; startTimeIso: string };

const isHttps = (u: string): boolean => /^https:\/\/[^\s]+$/i.test(u);
/** A creative URL: public https — or a LOOPBACK http URL, which only the local e2e mock can serve
 *  (a loopback address can never be a real hosted creative on prod, so this relaxes nothing there). */
const isMediaUrl = (u: string): boolean => isHttps(u) || /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/[^\s]*$/i.test(u);
const squashText = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").trim();

/** Creative/ad name of unit `index` out of `total` creatives: the console name verbatim for a
 *  single creative, `<name> #N` otherwise — the base is trimmed so the number always fits. */
export function snapAdUnitName(name: string, index: number, total: number): string {
  if (total <= 1) return name;
  const tag = ` #${index + 1}`;
  return `${name.slice(0, SNAP_NAME_MAX - tag.length).trimEnd()}${tag}`;
}

/** Niche word for names/rows: the partner landing's niche, or "Custom". */
export function snapShotNiche(shot: SnapLaunchShotIn): string {
  return shot.landingId === "custom" ? "Custom" : (snapLandingById(shot.landingId)?.niche ?? "");
}

/**
 * Build the Snap bodies for ONE shot, refusing with the exact fix when a field can't ride.
 * Order: budget → strategy/bid → goal (+pixel) → headline → brand → CTA → creatives → geo → age →
 * landing → Public Profile → key → name. Pure and deterministic: the board's dry-run (placeholder
 * key/media/name) and the pump's real run agree on every refusal.
 */
export function snapLaunchWire(
  shot: SnapLaunchShotIn,
  resolved: SnapResolved,
): { wire: SnapLaunchWire; label: string; geoLabel: string; landingBase: string; niche: string; bidMicro?: number } | { refusal: string } {
  const budgetMicro = snapMicro(String(shot.budget ?? ""), SNAP_BUDGET_MIN, SNAP_BUDGET_MAX);
  if (budgetMicro == null) return { refusal: `Daily budget must be between ${SNAP_BUDGET_MIN} and ${SNAP_BUDGET_MAX} in the account currency` };
  const strategy = String(shot.bidStrategy ?? "").trim();
  const kind = snapBidKind(strategy);
  if (kind === "unknown") return { refusal: `Unknown bidding strategy "${strategy}"` };
  const typedBid = String(shot.bid ?? "").trim();
  let bidMicro: number | undefined;
  if (kind === "bid") {
    if (!typedBid) return { refusal: `${snapStrategyLabel(strategy)} needs a bid in the account currency (e.g. 0,50)` };
    const b = snapMicro(typedBid, SNAP_BID_MIN, SNAP_BID_MAX);
    if (b == null) return { refusal: `Bid must be between 0,01 and 500 in the account currency` };
    bidMicro = b;
  } else if (typedBid) {
    return { refusal: `${snapStrategyLabel(strategy)} takes no bid — clear the bid` };
  }
  const goal = String(shot.optimizationGoal ?? "").trim();
  if (!GOAL_BY_VALUE.has(goal)) return { refusal: `Unknown optimization goal "${goal}"` };
  if (snapGoalNeedsPixel(goal) && !resolved.pixelId) return { refusal: `${snapGoalLabel(goal)} needs a conversion pixel — pick one or choose a non-pixel goal` };
  const headline = squashText(shot.headline);
  if (!headline) return { refusal: "Headline is required" };
  if (headline.length > SNAP_HEADLINE_MAX) return { refusal: `Headline is over ${SNAP_HEADLINE_MAX} characters (${headline.length})` };
  const brand = squashText(shot.brandName);
  if (!brand) return { refusal: "Brand name is required" };
  if (brand.length > SNAP_BRAND_MAX) return { refusal: `Brand name is over ${SNAP_BRAND_MAX} characters (${brand.length})` };
  const cta = String(shot.cta ?? "").trim();
  if (!CTA_SET.has(cta)) return { refusal: `Call to action must be one of ${SNAP_CTAS.map((c) => c.label).join(" / ")}` };
  const media = Array.isArray(shot.media) ? shot.media : [];
  if (media.length === 0) return { refusal: "At least one creative (a vertical video or image) is required" };
  if (media.length > SNAP_MAX_CREATIVES) return { refusal: `One campaign carries at most ${SNAP_MAX_CREATIVES} creatives — move the rest to another card` };
  for (let i = 0; i < media.length; i++) {
    const at = media.length === 1 ? "The creative" : `Creative ${i + 1}`;
    const url = String(media[i]?.url ?? "").trim();
    if (!url) return { refusal: `${at} has no file — a vertical video or image is required` };
    if (!isMediaUrl(url)) return { refusal: `${at} must be a public https:// file` };
    if (media[i].kind !== "video" && media[i].kind !== "image") return { refusal: `${at}: kind must be video or image` };
  }
  const geo = snapGeoWire(shot.geo);
  if ("refusal" in geo) return { refusal: geo.refusal };
  const minAge = String(shot.minAge ?? "").trim();
  if (!(SNAP_MIN_AGES as readonly string[]).includes(minAge)) return { refusal: `Minimum age must be one of ${SNAP_MIN_AGES.join(" / ")}` };
  let landingBase = "";
  if (shot.landingId === "custom") {
    const b = snapLandingBase(String(shot.landingUrl ?? ""));
    if (!b) return { refusal: "Custom landing must be an https:// address" };
    landingBase = b.base;
  } else {
    const l = snapLandingById(String(shot.landingId ?? ""));
    if (!l) return { refusal: "Pick a landing (Digital marketing / Cars / Custom)" };
    landingBase = l.url;
  }
  const profileId = String(resolved.profileId ?? "").trim();
  if (!profileId) return { refusal: "A Public Profile is required on every Snapchat ad — set SNAP_PROFILE_ID or pick one" };
  const key = String(resolved.key ?? "").trim();
  if (!isSnapKey(key)) return { refusal: `Key "${key}" is not one of the partner keys glo-snp_001…${SNAP_KEY_POOL_MAX}` };
  const mediaIds = media.map((_, i) => String(resolved.mediaIds?.[i] ?? "").trim());
  if (!mediaIds.some(Boolean)) return { refusal: "Snap media id is missing — the creative was not uploaded" };
  const name = squashText(resolved.name);
  if (!name) return { refusal: "Campaign name is empty" };
  if (name.length > SNAP_NAME_MAX) return { refusal: `Campaign name is over ${SNAP_NAME_MAX} characters` };
  const adAccountId = String(resolved.adAccountId ?? "").trim();
  if (!adAccountId) return { refusal: "Ad account is required" };

  const landingUrl = snapLandingUrl(landingBase, key);
  // One creative + ad per uploaded file, all on the campaign's key; a skipped creative (empty
  // media id) builds nothing and the others keep their numbers.
  const ads: SnapAdUnitWire[] = [];
  mediaIds.forEach((mediaId, index) => {
    if (!mediaId) return;
    const unitName = snapAdUnitName(name, index, media.length);
    ads.push({
      index,
      creative: {
        ad_account_id: adAccountId,
        name: unitName,
        type: "WEB_VIEW",
        ad_product: "SNAP_AD",
        headline,
        brand_name: brand,
        call_to_action: cta,
        top_snap_media_id: mediaId,
        shareable: true,
        web_view_properties: { url: landingUrl, block_preload: false, allow_snap_javascript_sdk: false, use_immersive_mode: false },
        profile_properties: { profile_id: profileId },
      },
      ad: { name: unitName, type: "REMOTE_WEBPAGE", status: "ACTIVE" },
    });
  });
  const wire: SnapLaunchWire = {
    campaign: { name, ad_account_id: adAccountId, status: "PAUSED", start_time: resolved.startTimeIso },
    adsquad: {
      name,
      type: "SNAP_ADS",
      billing_event: "IMPRESSION",
      delivery_constraint: "DAILY_BUDGET",
      daily_budget_micro: budgetMicro,
      bid_strategy: strategy,
      ...(bidMicro != null ? { bid_micro: bidMicro } : {}),
      optimization_goal: goal,
      placement_v2: { config: "AUTOMATIC" },
      targeting: { geos: geo.geos, demographics: [{ min_age: minAge }] },
      ...(resolved.pixelId ? { pixel_id: resolved.pixelId } : {}),
      status: "ACTIVE",
      start_time: resolved.startTimeIso,
    },
    ads,
    landingUrl,
  };
  return {
    wire,
    label: snapBidLabel(strategy, bidMicro, String(shot.currency ?? "USD")),
    geoLabel: geo.label,
    landingBase,
    niche: snapShotNiche(shot),
    ...(bidMicro != null ? { bidMicro } : {}),
  };
}
