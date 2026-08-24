export type FileItem = {
  id: string;
  name: string;
  size: number;
  kind: "image" | "video" | "other";
  url: string;
  /** Optional custom COVER image for a video creative (session-local object URL, like `url`).
   *  Rides to the launch as the creative's thumbnail — HS FB-Token rail only (LION's create
   *  contract takes bare creative URLs and picks its own frame). */
  cover?: { url: string; name: string };
};

export type Campaign = {
  id: string;
  collapsed: boolean;
  /** Fixed, non-editable naming prefix (e.g. "[04.08] - (t1) - "); baked at creation. */
  namePrefix: string;
  /** Editable suffix the user types after the prefix. Full name = namePrefix + name. */
  name: string;
  profile: string;
  account: string;
  /** LION partners: page name from the profile catalog. Token-fanpage partners (Indians): the
   *  PICKED fanpage ID (names duplicate across the token's pages, so the id is the value). */
  page: string;
  pixel: string;
  objective: string;
  bidStrategy: string;
  conversionEvent: string;
  /** conversions → link gets &fire=click (Purchase on click); clicks → no fire. */
  optimization: "conversions" | "clicks";
  budget: string;
  bidCap: string;
  title: string;
  copy: string;
  cta: string;
  link: string;
  landing: string;
  gcm: string;
  redirectType: string;
  paramMode: string;
  headline: string;
  countries: string[];
  locales: string[];
  category: string;
  placement: string;
  ageMin: string;
  userOs: string;
  files: FileItem[];
};

/** A fresh campaign. `name` = the editable suffix, defaulted to the launching user's username. */
export function makeCampaign(id: string, namePrefix = "", name = ""): Campaign {
  return {
    id,
    collapsed: false,
    namePrefix,
    name,
    profile: "",
    account: "",
    page: "",
    pixel: "",
    objective: "OUTCOME_SALES",
    bidStrategy: "LOWEST_COST_WITHOUT_CAP",
    conversionEvent: "PURCHASE",
    optimization: "conversions",
    budget: "7",
    bidCap: "",
    title: "",
    copy: "",
    cta: "LEARN_MORE",
    link: "",
    landing: "",
    gcm: "",
    redirectType: "META ADX",
    paramMode: "url_tags",
    headline: "",
    countries: [],
    locales: [],
    category: "",
    placement: "FULL",
    ageMin: "18",
    userOs: "all",
    files: [],
  };
}

/** Full campaign name for display and launch = fixed prefix + editable suffix. */
export function fullName(c: Campaign): string {
  return `${c.namePrefix}${c.name}`.trim();
}

export function parseMoney(v: string): number {
  const s = String(v ?? "").replace(/\s/g, "");
  // Mixed "1,234.56" reads the comma as a thousands separator; otherwise every comma is a
  // decimal point (the first one wins via parseFloat). The old single-comma replace parsed
  // "1,234.56" as 1.234 — under-parsing only, but wrong.
  const n = parseFloat(s.includes(",") && s.includes(".") ? s.replace(/,/g, "") : s.replace(/,/g, "."));
  return Number.isFinite(n) ? n : 0;
}

/** Money for display — whole amounts show as a plain integer ("10"); fractional keep their value
 *  ("0,5"). No trailing ",00" cents anywhere in the UI. */
export function moneyLabel(v: string | number): string {
  const n = typeof v === "number" ? v : parseMoney(v);
  if (!Number.isFinite(n)) return "0";
  return Number.isInteger(n) ? String(n) : String(n).replace(".", ",");
}

/** Keep a money field sane: strip junk to digits + a single decimal separator (≤2 places), and
 *  clamp to `max` so absurd amounts (e.g. $100000000) can't be entered. */
export function limitMoney(raw: string, max: number): string {
  const cleaned = raw.replace(/[^\d.,]/g, "");
  const sep = cleaned.search(/[.,]/);
  let s: string;
  if (sep === -1) {
    s = cleaned;
  } else {
    const int = cleaned.slice(0, sep).replace(/[.,]/g, "");
    const dec = cleaned.slice(sep + 1).replace(/[.,]/g, "").slice(0, 2);
    s = `${int},${dec}`;
  }
  return parseMoney(s) > max ? moneyLabel(max) : s;
}

/** Cash-register entry for decimal-heavy money fields (bid cap / ROAS goal): typed digits fill
 *  hundredths from the right — "5" → "0,05", "50" → "0,50", "120" → "1,20" — so the separator
 *  places itself and a missed comma can never inflate a bid 100× ($0,50 typed as "50" → $50).
 *  The whole string re-reads as bare digits every keystroke (separator keys are no-ops, deleting
 *  shifts right), clamped to `max` like limitMoney. Budgets stay on limitMoney — integer-first
 *  fields ("7" = $7) would be maddening in this mode. */
export function limitMoneyCents(raw: string, max: number): string {
  const digits = raw.replace(/\D/g, "").slice(0, 8);
  if (!digits) return "";
  const cents = Math.min(parseInt(digits, 10), Math.round(max * 100));
  const s = String(cents).padStart(3, "0");
  return `${s.slice(0, -2)},${s.slice(-2)}`;
}

/** Bid semantics per strategy: `cap` takes a money amount (cents at FB), `roas` takes a ROAS
 *  decimal (1,20 = 120%; event forced to PURCHASE, optimization goal VALUE), `none` bids
 *  automatically. Shared by MO (Graph API) and HS (LION) — a strategy means the same on both
 *  rails, only the submit channel differs. */
export function bidKind(strategy: string): "none" | "cap" | "roas" {
  if (strategy === "LOWEST_COST_WITH_MIN_ROAS") return "roas";
  if (strategy === "LOWEST_COST_WITH_BID_CAP" || strategy === "COST_CAP") return "cap";
  return "none";
}

/**
 * Min-ROAS goals the team actually runs are decimals well under 2 (0,20–0,50 typical; the live
 * optimizer nudges floors ±0,01). Buyers still keep typing the PERCENT form (30 = 30%) or a ×10
 * slip (3 = 0,30) — exactly what put ×100/×10 floors on 1159 campaigns (mass ÷100 Graph fix
 * 2026-08-20). One shared rule, same bands as that fix, applied at EVERY wire point (MO create,
 * MO clones, HS token create, LION create/duplicate, token-duplicate) so a mis-entered goal can
 * never reach Meta again:
 *   goal < 2       → already the decimal → kept as typed;
 *   2 ≤ goal ≤ 10  → ×10 slip           → ÷10  (3 → 0,30);
 *   goal ≥ 20      → percent form       → ÷100 (30 → 0,30);
 *   10 < goal < 20 → ambiguous (1,2? 0,12?) → null = refuse, the buyer must retype.
 * Rounded to 4 decimals — the Meta wire unit is the floor × 10000 integer.
 */
export function normalizeRoasGoal(goal: number): number | null {
  if (!Number.isFinite(goal) || goal <= 0) return null;
  if (goal < 2) return goal;
  if (goal <= 10) return Math.round(goal * 1000) / 10000;
  if (goal >= 20) return Math.round(goal * 100) / 10000;
  return null;
}

/** Cap-based bid strategies (bid cap / cost cap) need a positive bid amount; without it Meta
 *  rejects the ad set ("Bid amount required for the bid strategy provided"). Min-ROAS equally
 *  needs its positive ROAS goal (same field). Lowest-cost bids automatically and needs none. */
export function bidAmountMissing(c: Campaign): boolean {
  if (c.bidStrategy === "LOWEST_COST_WITHOUT_CAP") return false;
  const v = parseMoney(c.bidCap);
  if (v <= 0) return true;
  // Min-ROAS: the ambiguous 10–20 band is rejected at EVERY wire point (normalizeRoasGoal →
  // null) — a card carrying it must not read "ready" while the bid field shows the band error;
  // the dot, the bay count and the launch filter must agree with the field (review find 08-24).
  return bidKind(c.bidStrategy) === "roas" && normalizeRoasGoal(v) == null;
}

type ReadyOpts = {
  landing?: boolean;
  profile?: boolean;
  page?: boolean;
  account?: boolean;
  pixel?: boolean;
  gcm?: boolean;
  /** LION partners: the typed destination link is the ad's landing — require a real http(s) URL. */
  link?: boolean;
  /** LION partners: title + primary text are hard-required by the create weapon. */
  adText?: boolean;
  /** When set (MO), a min-ROAS card is ready ONLY with this exact pixel id — the partner's HS
   *  value pixel; every other pixel fails value optimization or is banned by owner rule. */
  roasPixel?: string;
};

/** A usable ad destination — http(s) and no whitespace inside. */
export const isHttpUrl = (v: string): boolean => /^https?:\/\/\S+$/i.test((v ?? "").trim());

export function isReady(c: Campaign, opts: ReadyOpts = {}): boolean {
  // All requirements default OFF — callers pass launchReadyOpts(partner) to turn on exactly what
  // that partner needs. (profile used to default ON, which would wrongly gate the Indians partner —
  // usesProfile:false — as never-ready if ever called without opts.)
  const {
    landing = false,
    profile = false,
    page = false,
    account = false,
    pixel = false,
    gcm = false,
    link = false,
    adText = false,
    roasPixel = "",
  } = opts;
  if (!c.name.trim() || c.countries.length === 0) return false;
  if (profile && !c.profile) return false;
  if (landing && !c.landing) return false;
  if (page && !c.page) return false;
  if (account && !c.account) return false;
  if (pixel && !c.pixel) return false;
  if (link && !isHttpUrl(c.link)) return false;
  if (adText && (!c.title.trim() || !c.copy.trim())) return false;
  // gcm-monetized partners: a card without a claimed code isn't ready (its tracking link would
  // carry an empty gcm=). The server re-claims on launch, but the UI must not show "ready" without it.
  if (gcm && !c.gcm) return false;
  // A cleared/zero daily budget would create the campaign then get the ad set rejected by Meta
  // (orphan + burnt gcm) — never let such a card count as launchable. $1 = Meta's USD daily floor.
  if (parseMoney(c.budget) < 1) return false;
  if (bidAmountMissing(c)) return false;
  // Min-ROAS is pinned to the partner's value pixel (owner rule 2026-08-11) — any other pixel
  // would be rejected by the launch route anyway, so the card must not read as launchable.
  if (roasPixel && bidKind(c.bidStrategy) === "roas" && c.pixel !== roasPixel) return false;
  return true;
}

/** A campaign can actually fire only if it's ready AND carries a creative (video or image). */
export function isLaunchable(c: Campaign, opts: ReadyOpts = {}): boolean {
  return isReady(c, opts) && firstMedia(c) !== undefined;
}

/** The creative a launch will upload: the first video, else the first image (video is the
 *  launcher's native format and wins when a card carries both). */
export function firstMedia(c: Campaign): FileItem | undefined {
  return c.files.find((f) => f.kind === "video") ?? c.files.find((f) => f.kind === "image");
}
