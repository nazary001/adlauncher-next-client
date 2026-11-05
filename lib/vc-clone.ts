// VC (ValueClick) clones — the PURE contract of the VC clone board (owner ask 05.11.2026: «нужно
// сделать клоны всех активных кампаний на этот новый пиксель [S-1 nik pixel 2126539511577664] …
// Бид ставь 0.5 везде, в нейминг к существующему неймингу добавь слово Lead и ставь все клоны на
// лид оптимизацию вместо пурчейс»).
//
// A VC clone is a faithful RECREATE of a live VC campaign in its own cabinet — the same ad link (the
// DE Postback tracking link: Meta fills its macros with the clone's own ids, so DE's revenue splits
// per clone, lib/vc-pb), the same page, the same targeting, every reusable ad of the source — with
// what the board sets on top: the pixel it optimizes on, the event (Lead = OUTCOME_LEADS, Purchase =
// OUTCOME_SALES — lib/catalog EVENTS_BY_OBJECTIVE: Meta refuses LEAD under Sales), the bid, the budget
// and a suffix on the name. No marker pool (VC has none); same-account only (media is account-local).
// Built on the VC token (direct Graph) or through TOOL (one job) — lib/vc-clone-run, server.
//
// PURE: relative imports of other leaf modules only, so `node --test tests/vc-clone.test.ts` runs it
// straight off disk.

import type { Campaign } from "./types";
import { bidKind, makeCampaign, moneyLabel, normalizeRoasGoal, parseMoney } from "./types";
import { SUPPORTED_BID_STRATEGIES } from "./fb-launch";
import { VC_PIXEL, VC_SALES_OBJECTIVE } from "./vc-link";
import { carriesOwnName } from "./own-name.ts";

type Json = Record<string, unknown>;
const rec = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string => (v == null ? "" : String(v));
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.map(rec) : []);
/** A Graph edge ({data: [...]}) as a list. */
const edge = (v: unknown): Json[] => list(rec(v).data);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

/** The dataset the owner named for the Lead clones (05.11): "S-1 nik pixel", BM VD Market — shared to every
 *  GC-for-VC cabinet (read 05.11 with the VC token). */
export const VC_LEAD_PIXEL = { id: "2126539511577664", name: "S-1 nik pixel" } as const;
/** Lead clones run as a Leads campaign: Meta allows LEAD only there (lib/catalog EVENTS_BY_OBJECTIVE). */
export const VC_LEADS_OBJECTIVE = "OUTCOME_LEADS";
/** The VC datasets the board offers (the server accepts any pixel the cabinet carries). */
export const VC_CLONE_PIXELS: readonly { id: string; name: string }[] = [VC_LEAD_PIXEL, VC_PIXEL];
export const vcPixelName = (id: string): string => VC_CLONE_PIXELS.find((p) => p.id === id)?.name ?? id;

export type VcCloneEvent = "LEAD" | "PURCHASE";
export const VC_CLONE_EVENTS: readonly { value: VcCloneEvent; label: string }[] = [
  { value: "LEAD", label: "Lead" },
  { value: "PURCHASE", label: "Purchase" },
];
export const isVcCloneEvent = (v: unknown): v is VcCloneEvent => v === "LEAD" || v === "PURCHASE";

export type VcCloneDelivery = { objective: string; optimization: "conversions"; conversionEvent: VcCloneEvent };

/** What the clone optimizes: Lead → a Leads campaign optimizing LEAD on the pixel; Purchase → Sales
 *  optimizing PURCHASE (the VC launch's own mode). Both are website conversions. */
export function vcCloneDelivery(event: VcCloneEvent): VcCloneDelivery {
  return event === "PURCHASE"
    ? { objective: VC_SALES_OBJECTIVE, optimization: "conversions", conversionEvent: "PURCHASE" }
    : { objective: VC_LEADS_OBJECTIVE, optimization: "conversions", conversionEvent: "LEAD" };
}

/** The board's batch settings — every selected source rides these. `budget` "" = the source's own. */
export type VcCloneSettings = {
  pixelId: string;
  event: VcCloneEvent;
  /** "" = the source's own strategy. */
  bidStrategy: string;
  /** The $ cap / ROAS goal in the board's spelling ("0,50"); "" with an inherited strategy = the source's own. */
  bidCap: string;
  budget: string;
  /** Joined to the source's name as its own " - " segment ("Lead"); "" = the name as is. */
  suffix: string;
};

/** The owner's ask of 05.11, as the board's defaults: Lead on the S-1 pixel, bid cap $0,50, " - Lead". */
export const VC_CLONE_DEFAULTS: VcCloneSettings = {
  pixelId: VC_LEAD_PIXEL.id,
  event: "LEAD",
  bidStrategy: "LOWEST_COST_WITH_BID_CAP",
  bidCap: "0,50",
  budget: "",
  suffix: "Lead",
};

/** The clone's name: the source's name with the suffix as its own " - " segment — once (a source that
 *  already ends in it, in any case, is not suffixed twice); no suffix = the source's name. */
export function vcCloneName(sourceName: string, suffix: string): string {
  const base = str(sourceName).trim();
  const tag = str(suffix).trim();
  if (!tag) return base;
  return carriesOwnName(base, tag) ? base : `${base} - ${tag}`;
}

/** One ad of the source as the board shows it: what it is (video / static image / nothing reusable), the
 *  page it advertises with and the link it points at. */
export type VcCloneAd = { adId: string; name: string; kind: "video" | "image" | "none"; pageId: string; link: string };

/** The facts of one fetched ad (creative{object_story_spec,asset_feed_spec}) — the same places
 *  lib/clone-run's media extraction reads: inline video_data (its CTA link) / link_data (its link, with an
 *  image), else the Advantage+ asset feed (first video / image + the first link url). */
export function vcAdFacts(ad: Json): VcCloneAd {
  const creative = rec(ad.creative);
  const oss = rec(creative.object_story_spec);
  const afs = rec(creative.asset_feed_spec);
  const video = rec(oss.video_data);
  const image = rec(oss.link_data);
  let kind: VcCloneAd["kind"] = "none";
  let link = "";
  if (str(video.video_id)) {
    kind = "video";
    link = str(rec(rec(video.call_to_action).value).link);
  } else if (str(image.link) && (str(image.image_hash) || str(image.picture))) {
    kind = "image";
    link = str(image.link);
  } else if (list(afs.videos).some((v) => str(v.video_id))) {
    kind = "video";
    link = str(list(afs.link_urls)[0]?.website_url);
  } else if (list(afs.images).some((i) => str(i.hash))) {
    kind = "image";
    link = str(list(afs.link_urls)[0]?.website_url);
  }
  return { adId: str(ad.id), name: str(ad.name), kind, pageId: str(oss.page_id), link };
}

/** A live VC campaign as the board lists it — read off ONE Graph tree (VC_SOURCE_FIELDS). Money in the
 *  board's $ spelling (moneyLabel); the bid follows bidStrategy (a $ cap or a ROAS goal decimal). */
export type VcCloneSource = {
  campaignId: string;
  /** Digits, no act_. */
  accountId: string;
  accountName: string;
  name: string;
  /** effective_status (ACTIVE / PAUSED / …). */
  status: string;
  objective: string;
  bidStrategy: string;
  /** Daily budget, $ ("7"). "" when the tree carries none. */
  budget: string;
  /** "2" ($ cap) / "0,3" (ROAS goal) / "" (lowest cost or unknown). */
  bidCap: string;
  optimizationGoal: string;
  /** The promoted event ("" for a click source). */
  conversionEvent: string;
  pixelId: string;
  countries: string[];
  ageMin: string;
  placement: string;
  userOs: "all" | "android";
  /** Meta locale ids as targeted (passed straight to the ad set — no name round trip). */
  localeIds: number[];
  category: string;
  /** The page the source's ads advertise with ("" when no ad carries one). */
  pageId: string;
  dsaBeneficiary: string;
  dsaPayor: string;
  ads: VcCloneAd[];
  createdTime: string;
};

/** The ONE Graph read a clone needs (lib/clone-run SRC_FIELDS + the fields the VC board shows): the
 *  campaign's facts, its first ad set (delivery, bid, targeting, DSA) and up to 10 ads with their creatives. */
export const VC_SOURCE_FIELDS = [
  "name",
  "account_id",
  "objective",
  "status",
  "effective_status",
  "special_ad_categories",
  "daily_budget",
  "bid_strategy",
  "created_time",
  "adsets.limit(1){name,daily_budget,optimization_goal,billing_event,bid_amount,bid_strategy,bid_constraints,promoted_object,targeting,dsa_beneficiary,dsa_payor}",
  "ads.limit(10){name,status,creative{id,object_story_spec,asset_feed_spec}}",
].join(",");

/** The board's source row off a fetched tree. */
export function vcCloneSourceOf(tree: Json, accountName = ""): VcCloneSource {
  const adset = edge(tree.adsets)[0] ?? {};
  const t = rec(adset.targeting);
  const geo = rec(t.geo_locations);
  const countries = strs(geo.country_groups).includes("worldwide") ? ["WW"] : strs(geo.countries);
  const fbPos = strs(t.facebook_positions);
  const base = fbPos.length === 1 && fbPos[0] === "feed" ? "COMPLIANCE" : "FULL";
  const genders = Array.isArray(t.genders) ? t.genders.map(Number) : [];
  const placement = genders.length === 1 ? (genders[0] === 1 ? `${base}_HOMEM` : `${base}_MULHER`) : base;
  const userOs: VcCloneSource["userOs"] = strs(t.user_os).includes("Android") ? "android" : "all";
  const localeIds = Array.isArray(t.locales) ? t.locales.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  const cats = strs(tree.special_ad_categories);
  const category = cats[0] && cats[0] !== "NONE" ? cats[0] : "";
  const budgetCents = num(tree.daily_budget) ?? num(adset.daily_budget);
  const bidCents = num(adset.bid_amount);
  const floor = num(rec(adset.bid_constraints).roas_average_floor);
  const bidStrategy = str(tree.bid_strategy) || str(adset.bid_strategy) || "LOWEST_COST_WITHOUT_CAP";
  const promoted = rec(adset.promoted_object);
  const ads = edge(tree.ads).map(vcAdFacts);
  return {
    campaignId: str(tree.id),
    accountId: str(tree.account_id).replace(/^act_/, ""),
    accountName: str(accountName),
    name: str(tree.name),
    status: str(tree.effective_status) || str(tree.status),
    objective: str(tree.objective) || VC_SALES_OBJECTIVE,
    bidStrategy,
    budget: budgetCents != null ? moneyLabel(budgetCents / 100) : "",
    bidCap: floor != null ? moneyLabel(floor / 10000) : bidCents != null ? moneyLabel(bidCents / 100) : "",
    optimizationGoal: str(adset.optimization_goal) || "OFFSITE_CONVERSIONS",
    conversionEvent: str(promoted.custom_event_type),
    pixelId: str(promoted.pixel_id),
    countries,
    ageMin: String(num(t.age_min) ?? 18),
    placement,
    userOs,
    localeIds,
    category,
    pageId: ads.find((a) => a.pageId)?.pageId ?? "",
    dsaBeneficiary: str(adset.dsa_beneficiary),
    dsaPayor: str(adset.dsa_payor),
    ads,
    createdTime: str(tree.created_time),
  };
}

/** One clone to build, as the board hands it to the queue (fb.clone, partnerId "vc") and the clone route
 *  reads it back. Client-safe (no server deps). */
export type VcCloneEdit = {
  /** The SOURCE campaign (digits). */
  campaignId: string;
  /** The source's own cabinet (digits) — display / launch-limit demand only; the server re-reads it. */
  accountId: string;
  name: string;
  budget: string;
  /** "" = the source's own. */
  bidStrategy: string;
  bidCap: string;
  pixelId: string;
  event: VcCloneEvent;
};

/** The board's settings applied to one source. `name` = the row's own typed name, else the suffixed
 *  source name. A lowest-cost strategy carries no bid; an inherited strategy with no typed bid keeps the
 *  source's own. */
export function vcCloneEditOf(src: VcCloneSource, s: VcCloneSettings, name?: string): VcCloneEdit {
  const bidStrategy = str(s.bidStrategy).trim() || src.bidStrategy;
  const typed = str(s.bidCap).trim();
  return {
    campaignId: src.campaignId,
    accountId: src.accountId,
    name: name ?? vcCloneName(src.name, s.suffix),
    budget: str(s.budget).trim() || src.budget,
    bidStrategy,
    bidCap: bidKind(bidStrategy) === "none" ? "" : typed || (bidStrategy === src.bidStrategy ? src.bidCap : ""),
    pixelId: str(s.pixelId).trim(),
    event: s.event,
  };
}

/** The Campaign the launch payload builders (lib/fb-launch) and the TOOL normalizer (lib/tool-run) take:
 *  the clone's delivery / bid / budget over the source's targeting, page and cabinet. */
export function vcCloneCampaign(edit: VcCloneEdit, src: VcCloneSource): Campaign {
  const c = makeCampaign(edit.campaignId, "", str(edit.name).trim()); // namePrefix "" → fullName === edit.name
  const d = vcCloneDelivery(edit.event);
  c.objective = d.objective;
  c.optimization = d.optimization;
  c.conversionEvent = d.conversionEvent;
  c.bidStrategy = str(edit.bidStrategy).trim() || src.bidStrategy;
  c.bidCap = bidKind(c.bidStrategy) === "none" ? "" : str(edit.bidCap).trim();
  c.budget = str(edit.budget).trim() || src.budget;
  c.countries = [...src.countries];
  c.locales = []; // the source's locale IDS ride beside the Campaign (adsetPayload's localeIds)
  c.category = src.category;
  c.placement = src.placement;
  c.ageMin = src.ageMin;
  c.userOs = src.userOs;
  c.pixel = str(edit.pixelId).trim();
  c.account = src.accountId;
  c.page = src.pageId;
  return c;
}

/** Why this clone must NOT be built (null = fine) — judged BEFORE any claim or write, so nothing is
 *  burned or orphaned over it. Same rules as the launch routes (supported strategy, a bid for a cap /
 *  ROAS, the ROAS band, the $1 budget floor, a geo) plus the VC clone's own (a known event, a pixel,
 *  Lead never on min-ROAS — VALUE optimizes purchase value — a page and a reusable ad on the source). */
export function vcCloneRefusal(edit: VcCloneEdit, src: VcCloneSource): string | null {
  if (!isVcCloneEvent(edit.event)) return "event_invalid — pick Lead or Purchase";
  if (!/^\d{10,20}$/.test(str(edit.pixelId).trim())) return "pixel_required — pick the pixel the clones optimize on";
  if (!str(edit.name).trim()) return "name_required — the clone needs a name";
  const c = vcCloneCampaign(edit, src);
  if (!SUPPORTED_BID_STRATEGIES.has(c.bidStrategy)) {
    return `bid_strategy_invalid — ${c.bidStrategy} can't be rebuilt; switch the row's bid strategy`;
  }
  const kind = bidKind(c.bidStrategy);
  if (kind === "roas") {
    if (c.conversionEvent !== "PURCHASE") return "roas_needs_purchase — min-ROAS optimizes purchase value; pick Purchase or a bid cap";
    const goal = parseMoney(c.bidCap);
    if (!(goal > 0)) return "bid_required — a min-ROAS clone needs the ROAS goal";
    if (goal > 100) return "roas_goal_invalid — ROAS goal must be 0–100";
    if (normalizeRoasGoal(goal) == null) return "roas_goal_ambiguous — type the decimal goal (0,30 = 30%)";
  } else if (kind === "cap" && !(parseMoney(c.bidCap) > 0)) {
    return "bid_required — a bid / cost cap needs an amount (0,50 = $0.50)";
  }
  if (parseMoney(c.budget) < 1) return "budget_too_low — daily budget must be at least $1";
  if (c.countries.length === 0) return "source has no country targeting to clone";
  if (!src.pageId) return "source page unknown — the source's ads carry no page";
  if (!src.ads.some((a) => a.kind !== "none")) return "source has no reusable video or image ad";
  return null;
}

/** The wire shape /api/clone/run accepts for partnerId "vc" (every value is re-validated against the
 *  source at build time — this only refuses what could never be an edit). */
export function isVcCloneEdit(raw: unknown): raw is VcCloneEdit {
  const e = rec(raw);
  if (!Object.keys(e).length) return false;
  if (!/^\d{5,}$/.test(str(e.campaignId))) return false;
  if (typeof e.name !== "string") return false;
  if (!isVcCloneEvent(e.event)) return false;
  for (const k of ["accountId", "budget", "bidStrategy", "bidCap", "pixelId"]) if (e[k] != null && typeof e[k] !== "string") return false;
  return true;
}
