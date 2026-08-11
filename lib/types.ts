export type FileItem = {
  id: string;
  name: string;
  size: number;
  kind: "image" | "video" | "other";
  url: string;
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
  const n = parseFloat(String(v ?? "").replace(/\s/g, "").replace(",", "."));
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

/** Cap-based bid strategies (bid cap / cost cap) need a positive bid amount; without it Meta
 *  rejects the ad set ("Bid amount required for the bid strategy provided"). Min-ROAS equally
 *  needs its positive ROAS goal (same field). Lowest-cost bids automatically and needs none. */
export function bidAmountMissing(c: Campaign): boolean {
  return c.bidStrategy !== "LOWEST_COST_WITHOUT_CAP" && parseMoney(c.bidCap) <= 0;
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
