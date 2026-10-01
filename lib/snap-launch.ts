// Snapchat rail — pure decisions (docs/superpowers/specs/2026-09-16-snapchat-rail-design.md).
// Deliberately dependency-free (no "@/" imports, no relative runtime imports — `import type` only)
// so `node --test` runs it straight off Node's type stripping. Part 1: the PARTNER contract — the
// fixed revenue keys, the landings, the exact link shape, the console name. Part 2: the launch
// vocabulary and `snapLaunchWire`, the ONE validator the board dry-runs and the pump runs. Part 3:
// the CLONER — the link's refs, the console name read back, and the draft a live campaign gives.

import type { SnapCloneSource } from "./snap-source";

// ---------- partner keys ----------

/** The partner tags every landing hit by this utm_source; it never changes per campaign. */
export const SNAP_UTM_SOURCE = "stone";
export const SNAP_KEY_PREFIX = "glo-snp_";
/** 500 since 23.09 — the partner extended the pool from 100 (codes stay 3-digit). Twin: lib/snap-keys.ts POOL_MAX. */
export const SNAP_KEY_POOL_MAX = 500;
export const SNAP_KEY_RE = /^glo-snp_(\d{3})$/;

/** Pool index 1..500 → the partner's fixed key ("glo-snp_007"); "" outside the pool. */
export function snapKeyCode(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > SNAP_KEY_POOL_MAX) return "";
  return `${SNAP_KEY_PREFIX}${String(n).padStart(3, "0")}`;
}

/** Key → pool index, null for anything that isn't one of the 500 keys (strict: prefix, 3 digits). */
export function snapKeyIndex(key: string): number | null {
  const m = SNAP_KEY_RE.exec(String(key ?? "").trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= SNAP_KEY_POOL_MAX ? n : null;
}

export const isSnapKey = (key: string): boolean => snapKeyIndex(key) !== null;

/** Every key of the pool, in order (the keys page lists all 500, bound or free). */
export function snapKeyPool(): string[] {
  return Array.from({ length: SNAP_KEY_POOL_MAX }, (_, i) => snapKeyCode(i + 1));
}

// ---------- partner landings ----------

// The landing is the buyer's PASTED URL — the partner's quiz/captcha pages on fast-flow-like domains
// break Snapchat's in-app browser, "as on Facebook" (owner rule 22.09) — or one of the partner's two
// DIRECT articles of the 16.09 brief, back as one-click picks (owner ask 29.09: "верни по директу
// запуски на снеп чат — те 2 статьи, что они нам изначально давали; то, что есть, оставляем").
// Either way the card appends only Snap's tags.

export type SnapDirectLanding = { id: "dmi" | "cars"; niche: string; url: string };

/** The partner's direct articles (brief 16.09). The niche names the campaigns as it did then. */
export const SNAP_DIRECT_LANDINGS: readonly SnapDirectLanding[] = [
  { id: "dmi", niche: "Digital marketing", url: "https://azmvhs.com/v/dmi-online-marketing-course/" },
  { id: "cars", niche: "Cars", url: "https://azmvhs.com/v/auto-financing-by-ford/" },
];

/**
 * The landing as the wire takes it: https only, a real hostname, and any pasted query/hash
 * DROPPED — our two utm params must be the only query (Snap appends ScCid itself; a stray
 * utm_source from a pasted link would override the partner's `stone`, and the partner's own
 * examples end in `utm_campaign=glo-snp_001` — the key is the campaign's own, never the pasted
 * one). Null = not an https URL.
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

/** The direct article a landing points at (any pasted query ignored), null for every other page. */
export function snapDirectLanding(raw: string): SnapDirectLanding | null {
  const b = snapLandingBase(raw);
  return b ? (SNAP_DIRECT_LANDINGS.find((l) => l.url === b.base) ?? null) : null;
}

/** Path segments that are the partner's gate/route words, not the niche: `ht`, `htai`, `v`, `r`,
 *  `captcha-1`, `age-gate`, `quiz…`, a language code (`en`, `pt-br`). */
const LANDING_GATE_SEG = /^(?:[a-z]{1,2}|htai|[a-z]{2}-[a-z]{2}|\d+|captcha(?:-\w+)?|age-gate|quiz(?:-\w+)?|gate(?:-\w+)?)$/i;
export const SNAP_NICHE_MAX = 40;

/**
 * The niche word a pasted landing carries, for names and rows: the first path segment that is
 * not a gate/language word, hyphens → spaces, first letter up, cut at SNAP_NICHE_MAX. Partner
 * pages read live 22.09: `/ht/age-gate/digital-marketing/en/` → "Digital marketing",
 * `/ht/captcha-1/cars/en/` → "Cars", `/htai/captcha-1/simparic-trio-what-…/` → "Simparic trio
 * what …". A path with no such segment falls back to the domain's second-level word ("Fast-flow");
 * not a URL at all → "". A direct article names its own niche ("Digital marketing", "Cars").
 */
export function snapNicheFromLanding(landing: string): string {
  const b = snapLandingBase(landing);
  if (!b) return "";
  const direct = snapDirectLanding(b.base);
  if (direct) return direct.niche;
  const u = new URL(b.base);
  const seg = u.pathname.split("/").map((s) => decodeURIComponent(s).trim()).filter(Boolean).find((s) => !LANDING_GATE_SEG.test(s));
  const raw = seg ?? u.hostname.replace(/^www\./i, "").split(".").slice(-2, -1)[0] ?? "";
  const words = raw.replace(/[-_+]+/g, " ").replace(/\s+/g, " ").trim();
  if (!words) return "";
  const cased = words.charAt(0).toUpperCase() + words.slice(1);
  return cased.length > SNAP_NICHE_MAX ? `${cased.slice(0, SNAP_NICHE_MAX - 1).trimEnd()}…` : cased;
}

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

/** What a clone's name ends with: ` - CLONE_FROM=<the source's key, or the head of its campaign id>`
 *  — the same trace the Google / TikTok clones carry (`CLONE_FROM=<id>`), in Snap's " - " grammar. */
export const SNAP_CLONE_MARK = "CLONE_FROM";

/**
 * The console name, used verbatim on the campaign, the ad squad, the creative and the ad:
 * `[DD.MM] (SNP) <niche> - <GEO> - <key> - <user> - GC-Launcher[ - <tail>][ - CLONE_FROM=<source>]`.
 * The key inside the name makes LION's per-key report readable from Ads Manager; pipes are replaced
 * so a tail can't fake a segment; the tail is trimmed first when the whole thing would pass
 * SNAP_NAME_MAX (a clone's marker always stays).
 */
export function snapCampaignName(args: { ddmm: string; niche: string; geoLabel: string; key: string; user: string; tail?: string; cloneOf?: string }): string {
  const user = noPipes(squash(args.user)) || "buyer";
  const niche = noPipes(squash(args.niche)) || "Snap";
  const geo = squash(args.geoLabel) || "??";
  const head = `[${args.ddmm}] (SNP) ${niche} - ${geo} - ${args.key} - ${user} - ${SNAP_NAME_MARK}`;
  const mark = noPipes(squash(args.cloneOf ?? "")).replace(/\s+/g, "");
  const end = mark ? ` - ${SNAP_CLONE_MARK}=${mark}` : "";
  let tail = noPipes(squash(args.tail ?? ""));
  const room = SNAP_NAME_MAX - head.length - end.length - 3; // " - " between head and tail
  if (tail && tail.length > room) tail = room > 0 ? tail.slice(0, room).trim() : "";
  return `${head}${tail ? ` - ${tail}` : ""}${end}`;
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

/** Ad squad optimization goals the launcher offers — ONLY Pixel purchase and Landing page view
 *  (owner ask 23.09: Swipes/clicks, Pixel page view and Impressions are gone). Any other value on
 *  the wire is refused by snapLaunchWire, so a tab opened before the change cannot launch on
 *  clicks. PIXEL_* needs the account's pixel. */
export const SNAP_OPTIMIZATION_GOALS: readonly { value: string; label: string; needsPixel: boolean }[] = [
  { value: "PIXEL_PURCHASE", label: "Pixel purchase", needsPixel: true },
  { value: "LANDING_PAGE_VIEW", label: "Landing page view", needsPixel: false },
] as const;
/** The card's default. Pixel purchase again (the partner's Purchase events reach the pixel since
 *  17.09, so Snap's E3017 "ineligible" no longer bites); Landing page view is the no-pixel way. */
export const SNAP_DEFAULT_GOAL = "PIXEL_PURCHASE";
const GOAL_BY_VALUE = new Map(SNAP_OPTIMIZATION_GOALS.map((g) => [g.value, g]));
export const snapGoalNeedsPixel = (v: string): boolean => GOAL_BY_VALUE.get(v)?.needsPixel ?? false;
export const snapGoalLabel = (v: string): string => GOAL_BY_VALUE.get(v)?.label ?? v;
/** Campaign objective — the card picks it again (owner ask 24.09). "Awareness & Engagement" is how every
 *  campaign launched before 23.09: NOTHING on the wire, Snap stamps its own legacy default BRAND_AWARENESS →
 *  `{ objective_v2_type: AWARENESS_AND_ENGAGEMENT, is_auto_generated: true }` (read-only probe 23.09: 74/74
 *  live campaigns) and takes PIXEL_PURCHASE / LANDING_PAGE_VIEW ad squads under it regardless — the
 *  objective steers no delivery, only which goals Ads Manager offers on the campaign and on a clone.
 *  "Sales" rides explicitly in `objective_v2_properties`; Snap's SALES/web row admits both launcher goals
 *  (docs read 23.09). `wire` = what goes into objective_v2_properties (null = omitted, Snap's own default).
 *  Awareness & Engagement is deliberately NOT sent by name: named, Snap would check its own matrix for
 *  that objective (impressions / swipes / video views), which has no purchase or page-view goal. */
export const SNAP_OBJECTIVES: readonly { value: string; label: string; note: string; wire: string | null }[] = [
  { value: "AWARENESS_AND_ENGAGEMENT", label: "Awareness & Engagement", note: "As before — Snap's own default; either goal works.", wire: null },
  { value: "SALES", label: "Sales", note: "Sent explicitly — a clone in Ads Manager offers Purchase / Landing page view.", wire: "SALES" },
] as const;
/** The card's default — how the rail launched before 23.09 (owner ask 24.09: "as before"). */
export const SNAP_DEFAULT_OBJECTIVE = "AWARENESS_AND_ENGAGEMENT";
const OBJECTIVE_BY_VALUE = new Map(SNAP_OBJECTIVES.map((o) => [o.value, o]));
export const snapObjectiveLabel = (v: string): string => OBJECTIVE_BY_VALUE.get(v)?.label ?? v;
/** The shot's objective: the one sent (trimmed, upper-cased), else the default (a tab opened before the
 *  field returned, or a shot that never carried one). */
export const snapObjectiveOf = (shot: { objective?: string }): string => String(shot.objective ?? "").trim().toUpperCase() || SNAP_DEFAULT_OBJECTIVE;

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

/** Device OS targeting of the ad squad (`targeting.devices[].os_type`; Snap's own vocabulary, read
 *  live 21.09 from /v1/targeting/device/os_type: iOS / ANDROID / WEB). Partner ask 21.09: ANDROID
 *  ONLY — their "browser killer" (the hop from Snapchat's in-app browser to the phone's browser)
 *  works on Android, and their deductions are judged on that traffic. "ALL" sends no device
 *  targeting at all (what every campaign before 21.09 ran on). */
export type SnapDeviceOs = "ANDROID" | "iOS" | "ALL";
export const SNAP_DEVICE_OPTIONS: readonly { value: SnapDeviceOs; label: string; short: string }[] = [
  { value: "ANDROID", label: "Android only", short: "Android" },
  { value: "iOS", label: "iOS only", short: "iOS" },
  { value: "ALL", label: "All devices", short: "" },
] as const;
export const SNAP_DEFAULT_DEVICE_OS: SnapDeviceOs = "ANDROID";
/** The shot's device choice, normalized: nothing sent (a tab opened before the deploy, a script on
 *  the old shape) = the partner's default, Android only; an unknown word = null (refused). */
export function snapDeviceOs(raw: unknown): SnapDeviceOs | null {
  const v = String(raw ?? "").trim();
  if (!v) return SNAP_DEFAULT_DEVICE_OS;
  return SNAP_DEVICE_OPTIONS.find((o) => o.value.toLowerCase() === v.toLowerCase())?.value ?? null;
}
/** Short word for rows and the bay ("Android" / "iOS"); "" when every device is targeted. */
export const snapDeviceShort = (os: SnapDeviceOs): string => SNAP_DEVICE_OPTIONS.find((o) => o.value === os)?.short ?? "";

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

/** Deterministic per-shot task ids: `snl-<wave>-NN` (Snap launch) / `snc-<wave>-NN` (Snap clone). */
export function snapShotTaskId(waveId: string, index: number, kind: "launch" | "clone" = "launch"): string {
  return `${kind === "clone" ? "snc" : "snl"}-${waveId}-${String(index + 1).padStart(2, "0")}`;
}

// ---------- the wire ----------

/** Snap ids (campaigns, media, ad accounts) are lower-case UUIDs. */
export const SNAP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A Snap id as the wire takes it: trimmed, lower-cased, "" when it is not a UUID. */
export const snapIdIn = (v: unknown): string => {
  const s = (v == null ? "" : String(v)).trim().toLowerCase();
  return SNAP_ID_RE.test(s) ? s : "";
};
/** An opaque Snap object id where only EQUALITY matters (a clone's source media + its ad account):
 *  a UUID on the real API, any lower-case slug on the local mock. Junk is dropped. */
const snapOpaqueIdIn = (v: unknown): string => {
  const s = (v == null ? "" : String(v)).trim().toLowerCase();
  return /^[0-9a-z][0-9a-z-]{7,63}$/.test(s) ? s : "";
};

/**
 * One creative of a shot: the public file URL (the Blob upload of a launch, Snap's own download
 * link for a clone), its kind and file name. A CLONE also names the media it comes from: on that
 * same ad account the pump reuses `snapMediaId` as is (no download, no upload, no READY wait); on
 * another account it re-hosts the file from `url`.
 */
export type SnapShotMedia = { url: string; kind: "video" | "image"; name?: string; snapMediaId?: string; snapAccountId?: string };

/**
 * The creatives of a shot as it arrived on the wire, normalized (strings trimmed, kind coerced). A
 * body without a `media` list that still sends the pre-multi-creative fields (`mediaUrl` /
 * `mediaKind` / `mediaName`) is read as a one-item list, so a tab opened before the deploy — and
 * any script built on the old shape — keeps launching. Anything else is an empty list (the
 * validator then refuses with "At least one creative…"). A source media id rides only as a pair
 * with its account, both valid Snap ids — anything else is dropped (the file URL then decides).
 */
export function snapShotMediaIn(raw: unknown): SnapShotMedia[] {
  const t = (v: unknown): string => (v == null ? "" : String(v)).trim();
  const x = (raw ?? {}) as Record<string, unknown>;
  const list: unknown[] = Array.isArray(x.media) ? x.media : t(x.mediaUrl) ? [{ url: x.mediaUrl, kind: x.mediaKind, name: x.mediaName }] : [];
  return list.map((m) => {
    const r = (m ?? {}) as Record<string, unknown>;
    const name = t(r.name);
    const snapMediaId = snapOpaqueIdIn(r.snapMediaId);
    const snapAccountId = snapOpaqueIdIn(r.snapAccountId);
    return {
      url: t(r.url),
      kind: r.kind === "image" ? ("image" as const) : ("video" as const),
      ...(name ? { name } : {}),
      ...(snapMediaId && snapAccountId ? { snapMediaId, snapAccountId } : {}),
    };
  });
}

/** One shot as the board sends it (money as HUMAN strings; copies expanded client-side, one
 *  shot = one campaign = one key). `media` lists the card's creatives — each becomes its own
 *  creative + ad inside the campaign's ONE ad squad, all on the campaign's key. */
export type SnapLaunchShotIn = {
  label?: string;
  adAccount: string;
  pixel?: string;
  profileId?: string;
  /** Campaign objective (SNAP_OBJECTIVES); absent = Awareness & Engagement, as before 23.09. */
  objective?: string;
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
  /** "ANDROID" | "iOS" | "ALL"; absent = SNAP_DEFAULT_DEVICE_OS (Android only, partner ask 21.09). */
  deviceOs?: string;
  /** The pasted landing or a direct article's URL (https; any pasted query is dropped, Snap's own tags are appended). */
  landingUrl: string;
  /** The key the board previewed; the pump claims it or the next free one. */
  desiredKey?: string;
  suffix: string;
  /** Display material the board resolved (currency of the ad account). */
  currency?: string;
  /** A CLONE: the source Snapchat campaign id (registry `clone_of`, the row's tag) … */
  cloneOf?: string;
  /** … and the source's partner key, the name's `CLONE_FROM=` marker (else the head of cloneOf). */
  cloneKey?: string;
};

/** `objective_v2_properties` rides only for an objective with a `wire` value (Sales); Awareness & Engagement
 *  leaves it out and Snap stamps its own (see SNAP_OBJECTIVES). */
export type SnapCampaignWire = { name: string; ad_account_id: string; status: "PAUSED" | "ACTIVE"; start_time: string; objective_v2_properties?: { objective_v2_type: string } };
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
  targeting: { geos: { country_code: string }[]; demographics: { min_age: string }[]; devices?: { os_type: "ANDROID" | "iOS" }[] };
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

/** Niche word for names/rows: the direct article's niche or read from the pasted landing ("Custom" when it yields nothing). */
export function snapShotNiche(shot: SnapLaunchShotIn): string {
  return snapNicheFromLanding(String(shot.landingUrl ?? "")) || "Custom";
}

/**
 * Build the Snap bodies for ONE shot, refusing with the exact fix when a field can't ride.
 * Order: budget → strategy/bid → goal (+pixel) → objective → headline → brand → CTA → creatives → geo →
 * age → devices → landing → Public Profile → key → name. Pure and deterministic: the board's dry-run (placeholder
 * key/media/name) and the pump's real run agree on every refusal.
 */
export function snapLaunchWire(
  shot: SnapLaunchShotIn,
  resolved: SnapResolved,
): { wire: SnapLaunchWire; label: string; geoLabel: string; landingBase: string; niche: string; deviceOs: SnapDeviceOs; bidMicro?: number } | { refusal: string } {
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
  if (!GOAL_BY_VALUE.has(goal)) return { refusal: `Unknown optimization goal "${goal}" — only Pixel purchase or Landing page view` };
  if (snapGoalNeedsPixel(goal) && !resolved.pixelId) return { refusal: `${snapGoalLabel(goal)} needs a conversion pixel — pick one or choose Landing page view` };
  const objective = snapObjectiveOf(shot);
  const objectiveDef = OBJECTIVE_BY_VALUE.get(objective);
  if (!objectiveDef) return { refusal: `Unknown campaign objective "${objective}" — only ${SNAP_OBJECTIVES.map((o) => o.label).join(" / ")}` };
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
    // A clone's creative may carry no file URL at all when it reuses its source media id (Snap gave
    // no download link) — the pump then reuses it on its own account and refuses it elsewhere.
    const reused = String(media[i]?.snapMediaId ?? "").trim();
    if (!url && !reused) return { refusal: `${at} has no file — a vertical video or image is required` };
    if (url && !isMediaUrl(url)) return { refusal: `${at} must be a public https:// file` };
    if (media[i].kind !== "video" && media[i].kind !== "image") return { refusal: `${at}: kind must be video or image` };
  }
  const geo = snapGeoWire(shot.geo);
  if ("refusal" in geo) return { refusal: geo.refusal };
  const minAge = String(shot.minAge ?? "").trim();
  if (!(SNAP_MIN_AGES as readonly string[]).includes(minAge)) return { refusal: `Minimum age must be one of ${SNAP_MIN_AGES.join(" / ")}` };
  const deviceOs = snapDeviceOs(shot.deviceOs);
  if (!deviceOs) return { refusal: `Devices must be one of ${SNAP_DEVICE_OPTIONS.map((o) => o.label).join(" / ")}` };
  const landingIn = snapLandingBase(String(shot.landingUrl ?? ""));
  if (!landingIn) return { refusal: "Landing must be a pasted https:// address (the partner's quiz page) or one of the direct articles" };
  const landingBase = landingIn.base;
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
    campaign: {
      name,
      ad_account_id: adAccountId,
      status: "PAUSED",
      start_time: resolved.startTimeIso,
      // Sales rides by name; Awareness & Engagement = nothing here, Snap stamps its own (as before 23.09).
      ...(objectiveDef.wire ? { objective_v2_properties: { objective_v2_type: objectiveDef.wire } } : {}),
    },
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
      targeting: { geos: geo.geos, demographics: [{ min_age: minAge }], ...(deviceOs !== "ALL" ? { devices: [{ os_type: deviceOs }] } : {}) },
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
    deviceOs,
    ...(bidMicro != null ? { bidMicro } : {}),
  };
}

// ======================================================================================
// Part 3 — the CLONER: a live Snapchat campaign → a fresh launch through the same validator
// ======================================================================================
// A clone is a NEW campaign on a NEW partner key (one campaign = one key; the source's key stays
// with the source), built by the same wave + pump as a launch. What it copies comes from the source
// read back from Snapchat (lib/snap-source.ts); what the launcher cannot carry is said in a note.

/** A Snapchat campaign id as a clone link carries it (Snap ids are lower-case UUIDs). */
export const SNAP_CAMPAIGN_ID_RE = SNAP_ID_RE;
/** Sources one clone board takes at once — the same 30 as the Google / TikTok cloners. */
export const SNAP_CLONE_MAX_SOURCES = 30;

/**
 * The refs a clone link or the board's input carries, in order: Snapchat campaign ids (UUIDs,
 * lower-cased) and partner keys (`glo-snp_NNN`, the source's own key → its campaign through the
 * registry). Any separator (comma, space, semicolon, newline), repeated params (arrays), any
 * mix; duplicates and anything else are dropped silently; at most SNAP_CLONE_MAX_SOURCES.
 */
export function snapCloneRefs(...raw: unknown[]): string[] {
  const tokens = raw
    .flatMap((r) => (Array.isArray(r) ? r : [r]))
    .flatMap((r) => (r == null ? [] : String(r).split(/[\s,;]+/)))
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const out: string[] = [];
  for (const t of tokens) {
    if (!(SNAP_ID_RE.test(t) || isSnapKey(t)) || out.includes(t)) continue;
    out.push(t);
    if (out.length >= SNAP_CLONE_MAX_SOURCES) break;
  }
  return out;
}

/** The console name read back (the inverse of snapCampaignName); null for any other name. The
 *  tail comes without a trailing clone marker — a clone of a clone never chains two of them. */
export function snapParseCampaignName(name: string): { ddmm: string; niche: string; geo: string; key: string; user: string; tail: string; cloneOf: string } | null {
  const m = /^\[(\d{2}\.\d{2})\] \(SNP\) (.+?) - (\S+) - (glo-snp_\d{3}) - (.+?) - GC-Launcher(?: - (.*))?$/.exec(squash(name));
  if (!m) return null;
  let rest = (m[6] ?? "").trim();
  let cloneOf = "";
  const mark = new RegExp(`(?:^| - )${SNAP_CLONE_MARK}=(\\S+)$`).exec(rest);
  if (mark) {
    cloneOf = mark[1];
    rest = rest.slice(0, mark.index).trim();
  }
  return { ddmm: m[1], niche: m[2], geo: m[3], key: m[4], user: m[5], tail: rest, cloneOf };
}

/** The partner key a live ad URL carries in `utm_campaign` ("" when it carries none of ours). */
export function snapKeyOfLink(url: string): string {
  try {
    const key = (new URL(String(url ?? "").trim()).searchParams.get("utm_campaign") ?? "").trim().toLowerCase();
    return isSnapKey(key) ? key : "";
  } catch {
    return "";
  }
}

/** The clone marker's value: the source's partner key, else the head of its campaign id. */
export function snapCloneMark(sourceKey: string, sourceCampaignId: string): string {
  const key = String(sourceKey ?? "").trim().toLowerCase();
  if (isSnapKey(key)) return key;
  return String(sourceCampaignId ?? "").trim().toLowerCase().slice(0, 8);
}

/** Micro-currency → the card's comma money with cents ("30,00", "0,27"); "" for none. */
export function snapMicroText(micro: number | null | undefined): string {
  if (micro == null || !Number.isFinite(micro)) return "";
  const cents = Math.round(micro / 10_000);
  return `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, "0")}`;
}

/** One ad of the source as the clone board offers it: the media it reuses (on its own account) or
 *  re-hosts (elsewhere), its moderation verdict, and whether it rides by default. */
export type SnapCloneCreative = {
  adId: string;
  /** Its number on the source card — the "#N" of the source ad's name (else its place). */
  n: number;
  /** Display name of the file. */
  name: string;
  /** The file name a re-host uploads under (always with an extension). */
  uploadName: string;
  kind: "video" | "image";
  /** Snap's public download link of the original ("" = none; then it can only stay on its account). */
  url: string;
  mediaId: string;
  /** The ad account the media lives on. */
  accountId: string;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  /** Snap's verdict on the source ad: APPROVED / PENDING / REJECTED. */
  review: string;
  reasons: string[];
  adStatus: string;
  /** Why this ad cannot be cloned at all ("" = it can). */
  issue: string;
  /** Rides by default: clonable, running in the source and not rejected by Snap's review. */
  pick: boolean;
};

/** The launch fields a clone starts from (the card's own names). */
export type SnapCloneFields = {
  adAccount: string;
  pixel: string;
  profileId: string;
  objective: string;
  optimizationGoal: string;
  bidStrategy: string;
  bid: string;
  budget: string;
  headline: string;
  brandName: string;
  cta: string;
  geo: string[];
  minAge: string;
  deviceOs: SnapDeviceOs;
  landingUrl: string;
  suffix: string;
};

export type SnapCloneDraft = {
  /** The source's partner key ("" for a campaign the launcher did not build). */
  key: string;
  /** What the clone's name ends with after CLONE_FROM=. */
  mark: string;
  /** The source name follows the console grammar (its tail is carried). */
  launcherName: boolean;
  fields: SnapCloneFields;
  creatives: SnapCloneCreative[];
  /** Every source setting the clone does not carry as is — shown on the row. */
  notes: string[];
};

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const adNo = (adName: string): number | null => {
  const m = /\s#(\d{1,3})$/.exec(adName);
  return m ? Number(m[1]) : null;
};

/**
 * How a live campaign maps onto the launcher's vocabulary. Same account, same goal / bid / budget
 * / countries / age / devices / texts / landing; the media are reused on their own account. A
 * setting the launcher does not offer lands on the launcher's own default and is NAMED in `notes`
 * — the board shows them, the buyer decides. Pure: the board drafts every source row with it.
 */
export function snapCloneDraft(src: SnapCloneSource): SnapCloneDraft {
  const notes: string[] = [];
  const q = src.squad;
  if (!q) notes.push("Source has no ad squad — nothing to clone");
  if (src.squadCount > 1) notes.push(`Source has ${src.squadCount} ad squads — the clone copies the one with the most ads; ${plural(src.otherSquadAds, "ad")} under the others ${src.otherSquadAds === 1 ? "is" : "are"} left out`);

  // ---- creatives: one per source ad, in its card order ----
  const creatives: SnapCloneCreative[] = src.ads.map((a, i) => {
    const m = a.media;
    const n = adNo(a.adName) ?? i + 1;
    const issue =
      a.creativeType !== "WEB_VIEW"
        ? a.creativeType
          ? `not a web-view ad (${a.creativeType}) — the launcher builds web-view ads only`
          : a.mediaError || "the creative could not be read"
        : !m
          ? a.mediaError || "the creative carries no media"
          : !m.kind
            ? "the media is not a video or an image"
            : !m.ready
              ? "the media is not ready on Snapchat"
              : "";
    const kind = m?.kind === "image" ? "image" : "video";
    const name = m?.name || `creative #${n}`;
    const ext = /\.([a-z0-9]{2,5})$/i.exec(m?.fileName ?? "")?.[1] ?? (kind === "image" ? "jpg" : "mp4");
    return {
      adId: a.adId,
      n,
      name,
      uploadName: /\.[a-z0-9]{2,5}$/i.test(name) ? name : `${name}.${ext}`,
      kind,
      url: m?.downloadUrl ?? "",
      mediaId: m?.id ?? "",
      accountId: m?.accountId || src.adAccountId,
      sizeBytes: m?.sizeBytes ?? null,
      width: m?.width ?? null,
      height: m?.height ?? null,
      durationSec: m?.durationSec ?? null,
      review: a.review,
      reasons: a.reviewReasons,
      adStatus: a.adStatus,
      issue,
      pick: !issue && a.adStatus.toUpperCase() !== "PAUSED" && a.review !== "REJECTED",
    };
  });

  // ---- texts / landing / profile: the first PICKED web-view ad leads (else the first web-view one) ----
  const adById = new Map(src.ads.map((a) => [a.adId, a]));
  const webAds = creatives.filter((c) => adById.get(c.adId)?.creativeType === "WEB_VIEW");
  const leadC = webAds.find((c) => c.pick) ?? webAds[0];
  const lead = leadC ? adById.get(leadC.adId) : undefined;
  const landingOf = (url: string) => snapLandingBase(url)?.base ?? "";
  if (lead && leadC) {
    const others = webAds.filter((c) => c.adId !== leadC.adId).map((c) => ({ c, a: adById.get(c.adId)! }));
    const differ = (pick: (a: NonNullable<typeof lead>) => string, what: string) => {
      const off = others.filter(({ a }) => pick(a) !== pick(lead)).map(({ c }) => `#${c.n}`);
      if (off.length) notes.push(`Creative${off.length === 1 ? "" : "s"} ${off.join(", ")} carr${off.length === 1 ? "ies" : "y"} another ${what} — every ad of the clone uses #${leadC.n}'s`);
    };
    differ((a) => a.headline, "headline");
    differ((a) => a.brandName, "brand name");
    differ((a) => a.cta, "call to action");
    differ((a) => landingOf(a.url), "landing");
  }
  const ctaIn = lead?.cta ?? "";
  const cta = CTA_SET.has(ctaIn) ? ctaIn : "MORE";
  if (ctaIn && cta !== ctaIn) notes.push(`Call to action ${ctaIn} is not offered — the clone uses More`);

  // ---- campaign objective ----
  const objIn = src.objective;
  const objective = OBJECTIVE_BY_VALUE.has(objIn) ? objIn : SNAP_DEFAULT_OBJECTIVE;
  if (objIn && objective !== objIn) notes.push(`Objective ${objIn} is not offered — the clone runs ${snapObjectiveLabel(objective)} (Snap's own default; either goal works under it)`);

  // ---- ad squad: goal, bid, budget, targeting ----
  let optimizationGoal = SNAP_DEFAULT_GOAL;
  let bidStrategy = "AUTO_BID";
  let bid = "";
  let budget = SNAP_DEFAULT_BUDGET;
  let geo: string[] = [];
  let minAge = "18";
  let deviceOs: SnapDeviceOs = "ALL";
  if (q) {
    if (GOAL_BY_VALUE.has(q.goal)) optimizationGoal = q.goal;
    else if (q.goal) notes.push(`Goal ${q.goal} is not offered (only Pixel purchase / Landing page view) — the clone optimizes ${snapGoalLabel(SNAP_DEFAULT_GOAL)}`);
    const kind = snapBidKind(q.bidStrategy);
    if (kind === "none") bidStrategy = q.bidStrategy;
    else if (kind === "bid" && q.bidMicro != null && q.bidMicro > 0) {
      bidStrategy = q.bidStrategy;
      bid = snapMicroText(q.bidMicro);
    } else if (kind === "bid") notes.push(`Source's ${snapStrategyLabel(q.bidStrategy)} carries no bid — the clone bids Auto`);
    else if (q.bidStrategy) notes.push(`Bidding ${q.bidStrategy} is not offered — the clone bids Auto`);
    if (q.dailyBudgetMicro != null && q.dailyBudgetMicro > 0) {
      const v = q.dailyBudgetMicro / 1_000_000;
      const clamped = Math.min(SNAP_BUDGET_MAX, Math.max(SNAP_BUDGET_MIN, v));
      budget = snapMicroText(clamped * 1_000_000);
      if (clamped !== v) notes.push(`Daily budget ${snapMicroText(q.dailyBudgetMicro)} is outside ${SNAP_BUDGET_MIN}–${SNAP_BUDGET_MAX} — the clone runs ${budget}`);
    } else if (q.lifetimeBudgetMicro != null && q.lifetimeBudgetMicro > 0) {
      notes.push(`Source runs a lifetime budget (${snapMicroText(q.lifetimeBudgetMicro)}) — the clone runs a daily budget of ${SNAP_DEFAULT_BUDGET}`);
    }
    geo = [...q.countries];
    if (q.subCountryGeo) notes.push("Source narrows countries to regions / metros / postal codes — the clone targets the whole countries");
    const age = Number.parseInt(q.minAge, 10);
    minAge = !Number.isFinite(age) || age <= 18 ? "18" : age <= 21 ? "21" : "25";
    if (q.minAge && minAge !== q.minAge) notes.push(`Minimum age ${q.minAge} → ${minAge} (the launcher offers ${SNAP_MIN_AGES.join(" / ")})`);
    if (q.maxAge) notes.push(`Source caps the age at ${q.maxAge} — the clone has no upper age`);
    if (q.gender) notes.push(`Source targets ${q.gender} only — the clone targets every gender`);
    if (q.languages.length) notes.push(`Source targets languages (${q.languages.join(", ")}) — the clone does not`);
    const os = new Set(q.deviceOs.map((o) => o.toUpperCase()));
    deviceOs = os.size === 1 && os.has("ANDROID") ? "ANDROID" : os.size === 1 && os.has("IOS") ? "iOS" : "ALL";
    if (os.size > 1) notes.push(`Source targets ${q.deviceOs.join(" + ")} — the clone targets all devices`);
    if (q.deviceDetails) notes.push("Source narrows devices by OS version / make / carrier / connection — the clone does not");
    if (q.extraTargeting.length) notes.push(`Source targeting also uses ${q.extraTargeting.join(", ")} — not carried (the clone targets countries, age and devices)`);
  }

  // ---- name ----
  const parsed = snapParseCampaignName(src.name);
  const key = parsed?.key || (lead ? snapKeyOfLink(lead.url) : "") || src.ads.map((a) => snapKeyOfLink(a.url)).find(Boolean) || "";
  return {
    key,
    mark: snapCloneMark(key, src.campaignId),
    launcherName: Boolean(parsed),
    fields: {
      adAccount: src.adAccountId,
      pixel: q?.pixelId ?? "",
      profileId: lead?.profileId ?? "",
      objective,
      optimizationGoal,
      bidStrategy,
      bid,
      budget,
      headline: lead?.headline ?? "",
      brandName: lead?.brandName ?? "",
      cta,
      geo,
      minAge,
      deviceOs,
      landingUrl: lead ? landingOf(lead.url) : "",
      suffix: parsed?.tail ?? "",
    },
    creatives,
    notes,
  };
}

/** One ref of a clone link resolved to the campaign it means. A KEY means the campaign the
 *  registry binds to it NOW (a key released and claimed again points at its new campaign). */
export type SnapCloneTarget = { ref: string; campaignId: string; holder?: string; error?: string };

export function snapCloneResolve(refs: string[], registry: { key: string; campaign_id?: string; user?: string }[] | null, registryError = ""): SnapCloneTarget[] {
  const byKey = new Map((registry ?? []).map((r) => [r.key, r]));
  return refs.map((ref) => {
    if (!isSnapKey(ref)) return { ref, campaignId: ref };
    if (!registry) return { ref, campaignId: "", error: `the key registry could not be read (${registryError || "unknown error"}) — retry, or open the campaign by its id` };
    const row = byKey.get(ref);
    if (!row) return { ref, campaignId: "", error: `${ref} is free — no campaign holds this key` };
    if (!row.campaign_id) return { ref, campaignId: "", error: `${ref} has no campaign yet — its launch is still running or failed before the campaign existed` };
    return { ref, campaignId: row.campaign_id, ...(row.user ? { holder: row.user } : {}) };
  });
}

/** A failed campaign read in the buyer's words. Snap answers a DELETED campaign with HTTP 400 "not
 *  available" and an id it never issued with 404 "can not be found" or 400 "Request URL can not be
 *  correctly processed" (probed 22.09 and 01.10). */
export function snapSourceErrorText(status: number | undefined, message: string | undefined): string {
  const msg = String(message ?? "").trim();
  if (status === 400 && /not available/i.test(msg)) return "This campaign is gone from Snapchat (deleted in Ads Manager)";
  if (status === 404 || (status === 400 && /correctly processed/i.test(msg))) return "No such campaign on Snapchat — check the id";
  if (status === 401 || status === 403) return `Snapchat refused the read (${status}${msg ? `: ${msg}` : ""})`;
  return msg || "Snapchat read failed";
}

/**
 * The hard gate on a clone's creatives (the card's readiness, the same words the pump would end
 * with): at least one picked, none unclonable, and one that has to MOVE to another ad account
 * needs Snap's download link and must fit the 32 MB single upload — on its own account it is
 * reused as is, whatever its size. Null = the creatives can ride.
 */
export function snapRemoteMediaIssue(remote: { n: number; on: boolean; issue: string; url: string; sizeBytes: number | null; accountId: string }[], adAccountId: string): string | null {
  const on = remote.filter((r) => r.on);
  if (on.length === 0) return "Pick at least one creative of the source";
  for (const r of on) {
    const at = `Creative #${r.n}`;
    if (r.issue) return `${at}: ${r.issue}`;
    if (adAccountId && r.accountId !== adAccountId) {
      if (!r.url) return `${at} has no download link on Snapchat — it can only be cloned on its own ad account`;
      if (r.sizeBytes != null && r.sizeBytes > SNAP_MEDIA_MAX_BYTES) return `${at} is ${Math.round(r.sizeBytes / 1024 / 1024)} MB — moving it to another ad account takes at most 32 MB; clone it on its own account`;
    }
  }
  return null;
}
