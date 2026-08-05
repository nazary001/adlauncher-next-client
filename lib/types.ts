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

/** Team default: LION FB launches run at $10/day unless told otherwise. */
export function makeCampaign(id: string, namePrefix = ""): Campaign {
  return {
    id,
    collapsed: false,
    namePrefix,
    name: "",
    profile: "",
    account: "",
    page: "",
    pixel: "",
    objective: "OUTCOME_SALES",
    bidStrategy: "LOWEST_COST_WITHOUT_CAP",
    conversionEvent: "PURCHASE",
    optimization: "conversions",
    budget: "10",
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
  const n = parseFloat(v.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

/** Money for display — whole amounts show as a plain integer ("10"); fractional keep their value
 *  ("0,5"). No trailing ",00" cents anywhere in the UI. */
export function moneyLabel(v: string | number): string {
  const n = typeof v === "number" ? v : parseMoney(v);
  if (!Number.isFinite(n)) return "0";
  return Number.isInteger(n) ? String(n) : String(n).replace(".", ",");
}

/** Cap-based bid strategies (bid cap / cost cap) need a positive bid amount; without it Meta
 *  rejects the ad set ("Bid amount required for the bid strategy provided"). Lowest-cost bids
 *  automatically and needs none. */
export function bidAmountMissing(c: Campaign): boolean {
  return c.bidStrategy !== "LOWEST_COST_WITHOUT_CAP" && parseMoney(c.bidCap) <= 0;
}

export function isReady(
  c: Campaign,
  opts: { landing?: boolean; profile?: boolean } = {},
): boolean {
  const { landing = false, profile = true } = opts;
  if (!c.name.trim() || c.countries.length === 0) return false;
  if (profile && !c.profile) return false;
  if (landing && !c.landing) return false;
  if (bidAmountMissing(c)) return false;
  return true;
}

/** A campaign can actually fire only if it's ready AND carries a video creative. */
export function isLaunchable(
  c: Campaign,
  opts: { landing?: boolean; profile?: boolean } = {},
): boolean {
  return isReady(c, opts) && c.files.some((f) => f.kind === "video");
}

/** The video creative a launch will upload (first video file). */
export function firstVideo(c: Campaign) {
  return c.files.find((f) => f.kind === "video");
}
