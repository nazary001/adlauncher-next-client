// VC (ValueClick) clones — the PURE contract of the VC cloner (first built for the owner ask of 05.11.2026:
// «нужно сделать клоны всех активных кампаний на этот новый пиксель [S-1 nik pixel 2126539511577664] …
// Бид ставь 0.5 везде … ставь все клоны на лид оптимизацию вместо пурчейс»; made a full cloner on 17.11:
// «сделай его нормальным так как у нас и на других партнерах со всем функционалом, чтобы можно было акк
// выбрать»).
//
// A VC clone is a RECREATE of a live VC campaign — the same ad link (the DE Postback tracking link: Meta
// fills its macros with the clone's own ids, so DE's revenue splits per clone, lib/vc-pb) and every
// reusable ad of the source — with what the buyer sets on the shared clone board (components/clone-board)
// on top: the cabinet it is built in (the source's own, or another VC cabinet — the media is moved there),
// the page it advertises with, the pixel and the event it optimizes (as the source, or Lead = OUTCOME_LEADS,
// or Purchase = OUTCOME_SALES — lib/catalog EVENTS_BY_OBJECTIVE: Meta refuses LEAD under Sales), the
// targeting, the bid, the budget and the name. No marker pool (VC has none). Built on the VC token (direct
// Graph) or through TOOL (one job) — lib/vc-clone-run, server.
//
// PURE: relative imports of other leaf modules only, so `node --test tests/vc-clone.test.ts` runs it
// straight off disk.

import type { Campaign } from "./types";
import { bidKind, makeCampaign, moneyLabel, normalizeRoasGoal, parseMoney } from "./types";
import type { CloneSource } from "./clone";
import { SUPPORTED_BID_STRATEGIES } from "./fb-launch";
import { LOCALE_KEYS, localeKeysOf } from "./locale-keys";
import { VC_LEAD_PIXEL, VC_LEADS_OBJECTIVE, VC_PIXEL, VC_SALES_OBJECTIVE, VC_TRAFFIC_OBJECTIVE, vcPixelName } from "./vc-link";

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
const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
/** An ad account id as digits ("act_" dropped). */
const acct = (v: unknown): string => str(v).trim().replace(/^act_/, "");

/** The Lead dataset ("S-1 nik pixel", 05.11), the Leads objective and the pixel names live with the launch
 *  contract since the launcher's own Lead mode pins the same dataset (lib/vc-link) — re-exported for the
 *  board and its tests. */
export { VC_LEAD_PIXEL, VC_LEADS_OBJECTIVE, vcPixelName };
/** The VC datasets the board knows by name, the Lead one first (the server accepts any pixel the cabinet carries). */
export const VC_CLONE_PIXELS: readonly { id: string; name: string }[] = [VC_LEAD_PIXEL, VC_PIXEL];

/** What a clone optimizes: what its SOURCE does (the cloner's default — a faithful copy), or Lead / Purchase
 *  forced on every clone of the batch (the 05.11 ask: Purchase campaigns re-born as Lead). */
export type VcCloneEvent = "LEAD" | "PURCHASE" | "SOURCE";
export const VC_CLONE_EVENTS: readonly { value: VcCloneEvent; label: string }[] = [
  { value: "SOURCE", label: "As each source" },
  { value: "LEAD", label: `Lead · ${VC_LEAD_PIXEL.name}` },
  { value: "PURCHASE", label: `Purchase · ${VC_PIXEL.name}` },
];
export const isVcCloneEvent = (v: unknown): v is VcCloneEvent => v === "LEAD" || v === "PURCHASE" || v === "SOURCE";

/** `conversionEvent` "" and `pixel` "" = a click clone (Traffic / link clicks, no promoted pixel). */
export type VcCloneDelivery = { objective: string; optimization: "conversions" | "clicks"; conversionEvent: string; pixel: string };

/**
 * What the clone optimizes and on which dataset BY DEFAULT (a picked pixel replaces `pixel`): Lead → a Leads
 * campaign optimizing LEAD on the S-1 nik pixel; Purchase → Sales optimizing PURCHASE on the VC pixel (the
 * two modes of a VC launch, lib/vc-link vcDelivery); as the source → the source's own objective, event and
 * pixel — a link-click source (or one that promotes no pixel event) stays a click clone with no pixel.
 */
export function vcCloneDelivery(
  event: VcCloneEvent,
  src?: Pick<VcCloneSource, "objective" | "optimizationGoal" | "conversionEvent" | "pixelId">,
): VcCloneDelivery {
  if (event === "PURCHASE") return { objective: VC_SALES_OBJECTIVE, optimization: "conversions", conversionEvent: "PURCHASE", pixel: VC_PIXEL.id };
  if (event === "LEAD" || !src) return { objective: VC_LEADS_OBJECTIVE, optimization: "conversions", conversionEvent: "LEAD", pixel: VC_LEAD_PIXEL.id };
  const promoted = Boolean(src.pixelId && src.conversionEvent);
  if (src.optimizationGoal === "LINK_CLICKS" || !promoted) {
    return {
      objective: src.objective || VC_TRAFFIC_OBJECTIVE,
      optimization: "clicks",
      conversionEvent: promoted ? src.conversionEvent : "",
      pixel: promoted ? src.pixelId : "",
    };
  }
  return { objective: src.objective || VC_SALES_OBJECTIVE, optimization: "conversions", conversionEvent: src.conversionEvent, pixel: src.pixelId };
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
    accountId: acct(tree.account_id),
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

/** The language names (lib/catalog LOCALES) a source's locale ids spell — what the board's Targeting editor
 *  shows for it. A name counts when Meta's keys for it are all among the ids; ids the table has no name for
 *  are simply not shown (an untouched row still ships the source's ids as they are — vcRowEdit). */
export function vcLocaleNames(ids: readonly number[]): string[] {
  const have = new Set(ids);
  const out: string[] = [];
  for (const [name, keys] of Object.entries(LOCALE_KEYS)) {
    if (keys && keys.length > 0 && keys.every((k) => have.has(k))) out.push(name);
  }
  return out;
}

/** A VC source as the shared clone board's row source (lib/clone CloneSource) — the board seeds, shows and
 *  edits it exactly like an MO / AIF / AV one; the VC facts it also needs (the source's cabinet, page,
 *  pixel, ads) ride along under `vc`. */
export function vcBoardSource(v: VcCloneSource): CloneSource & { vc: VcCloneSource } {
  return {
    campaignId: v.campaignId,
    name: v.name,
    countries: [...v.countries],
    locales: vcLocaleNames(v.localeIds),
    category: v.category,
    placement: v.placement,
    ageMin: v.ageMin,
    userOs: v.userOs,
    originalBudget: v.budget,
    originalRoas: v.bidCap,
    bidStrategy: v.bidStrategy,
    objective: v.objective,
    optimization: v.optimizationGoal === "LINK_CLICKS" ? "clicks" : "conversions",
    conversionEvent: v.conversionEvent,
    redirectType: "",
    creatives: v.ads.filter((a) => a.kind !== "none").map((a) => ({ videoId: a.adId, thumbUrl: "" })),
    vc: v,
  };
}

/** One clone to build, as the board hands it to the queue (fb.clone, partnerId "vc") and the clone route
 *  reads it back. Client-safe (no server deps). Every optional field left out keeps the SOURCE's own value. */
export type VcCloneEdit = {
  /** The SOURCE campaign (digits). */
  campaignId: string;
  /** The cabinet the clone is BUILT in (digits). "" = the source's own. Every edit queued before 17.11
   *  names the source's own cabinet here (it was a display field then), so an older job still lands where
   *  it always did. A cabinet other than the source's = the media is moved there first. */
  accountId: string;
  name: string;
  budget: string;
  /** "" = the source's own. */
  bidStrategy: string;
  bidCap: string;
  /** The dataset the clone optimizes on. "" = the event's own (Lead → S-1 nik pixel, Purchase → VC pixel,
   *  as the source → the source's). */
  pixelId: string;
  event: VcCloneEvent;
  /** The page the clone advertises with. "" / absent = the source's. */
  pageId?: string;
  /** Targeting the buyer changed on the row — an absent field keeps the source's. */
  countries?: string[];
  /** Language NAMES (lib/catalog LOCALES; ids through lib/locale-keys). Absent = the source's locale ids as targeted. */
  locales?: string[];
  category?: string;
  placement?: string;
  ageMin?: string;
  userOs?: "all" | "android";
};

/** Where a clone lands and what it promotes, resolved against its source. */
export type VcCloneBinds = {
  /** The cabinet the clone is built in (digits). */
  accountId: string;
  pageId: string;
  /** "" for a click clone. */
  pixelId: string;
  /** Built in a cabinet other than the source's — its video / image must be moved there. */
  cross: boolean;
};

/** The edit's delivery: its event against the source (vcCloneDelivery). */
export function vcCloneDeliveryOf(edit: Pick<VcCloneEdit, "event">, src: VcCloneSource): VcCloneDelivery {
  return vcCloneDelivery(isVcCloneEvent(edit.event) ? edit.event : "SOURCE", src);
}

/** The cabinet, page and pixel a clone is built with: the edit's picks, the source's own for whatever it
 *  leaves empty; the pixel is the picked one, else the delivery's default — none for a click clone. */
export function vcCloneBinds(edit: Pick<VcCloneEdit, "accountId" | "pageId" | "pixelId" | "event">, src: VcCloneSource): VcCloneBinds {
  const accountId = acct(edit.accountId) || src.accountId;
  const d = vcCloneDeliveryOf(edit, src);
  return {
    accountId,
    pageId: str(edit.pageId).trim() || src.pageId,
    pixelId: d.conversionEvent ? str(edit.pixelId).trim() || d.pixel : "",
    cross: accountId !== src.accountId,
  };
}

/** The ad set's Meta locale ids: the source's own as targeted, or — when the buyer changed the row's
 *  languages — the keys of the picked names (`unknown` = names Meta has no ad locale for: a refusal). */
export function vcCloneLocaleIds(edit: Pick<VcCloneEdit, "locales">, src: Pick<VcCloneSource, "localeIds">): { ids: number[]; unknown: string[] } {
  if (!Array.isArray(edit.locales)) return { ids: [...src.localeIds], unknown: [] };
  return localeKeysOf(edit.locales);
}

/** The Campaign the launch payload builders (lib/fb-launch) and the TOOL normalizer (lib/tool-run) take:
 *  the clone's delivery / bid / budget / destination, the row's targeting over the source's. */
export function vcCloneCampaign(edit: VcCloneEdit, src: VcCloneSource): Campaign {
  const c = makeCampaign(edit.campaignId, "", str(edit.name).trim()); // namePrefix "" → fullName === edit.name
  const d = vcCloneDeliveryOf(edit, src);
  const b = vcCloneBinds(edit, src);
  c.objective = d.objective;
  c.optimization = d.optimization;
  c.conversionEvent = d.conversionEvent;
  c.bidStrategy = str(edit.bidStrategy).trim() || src.bidStrategy;
  c.bidCap = bidKind(c.bidStrategy) === "none" ? "" : str(edit.bidCap).trim();
  c.budget = str(edit.budget).trim() || src.budget;
  c.countries = Array.isArray(edit.countries) ? edit.countries.map((x) => str(x).trim().toUpperCase()).filter(Boolean) : [...src.countries];
  c.locales = []; // the locale IDS ride beside the Campaign (vcCloneLocaleIds → adsetPayload's localeIds)
  // The buyer's pick wins, but a source that DECLARED a special category never silently loses it (the
  // shared clone rule, lib/clone-run cloneToCampaign).
  c.category = str(edit.category) || src.category;
  c.placement = str(edit.placement) || src.placement;
  c.ageMin = str(edit.ageMin) || src.ageMin;
  c.userOs = edit.userOs === "android" || edit.userOs === "all" ? edit.userOs : src.userOs;
  c.pixel = b.pixelId;
  c.account = b.accountId;
  c.page = b.pageId;
  return c;
}

/** Why this clone must NOT be built (null = fine) — judged BEFORE any claim or write, so nothing is
 *  burned or orphaned over it. Same rules as the launch routes (supported strategy, a bid for a cap /
 *  ROAS, the ROAS band, the $1 budget floor, a geo, known languages) plus the VC clone's own (a known
 *  event, a pixel for a conversion clone, min-ROAS only on Purchase — VALUE optimizes purchase value —
 *  a page and a reusable ad on the source). */
export function vcCloneRefusal(edit: VcCloneEdit, src: VcCloneSource): string | null {
  if (!isVcCloneEvent(edit.event)) return "event_invalid — pick Lead, Purchase or as the source";
  if (!str(edit.name).trim()) return "name_required — the clone needs a name";
  if (str(edit.accountId).trim() && !/^\d{5,}$/.test(acct(edit.accountId))) return "account_invalid — pick the cabinet the clone is built in";
  const c = vcCloneCampaign(edit, src);
  const b = vcCloneBinds(edit, src);
  if (c.conversionEvent && !/^\d{10,20}$/.test(b.pixelId)) return "pixel_required — pick the pixel the clone optimizes on";
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
  if (c.countries.length === 0) return Array.isArray(edit.countries) ? "geo_required — pick at least one country" : "source has no country targeting to clone";
  const badGeo = c.countries.find((x) => x !== "WW" && !/^[A-Z]{2}$/.test(x));
  if (badGeo) return `geo_invalid — "${badGeo}" is not a country code`;
  const loc = vcCloneLocaleIds(edit, src);
  if (loc.unknown.length) return `locale_unknown — Meta has no ad locale for: ${loc.unknown.join(", ")}`;
  if (!/^\d{5,}$/.test(b.pageId)) {
    return str(edit.pageId).trim() ? "fanpage_invalid — pick the fanpage the clone advertises with" : "source page unknown — the source's ads carry no page; pick a fanpage";
  }
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
  for (const k of ["accountId", "budget", "bidStrategy", "bidCap", "pixelId", "pageId", "category", "placement", "ageMin"]) {
    if (e[k] != null && typeof e[k] !== "string") return false;
  }
  for (const k of ["countries", "locales"]) {
    if (e[k] != null && !(Array.isArray(e[k]) && (e[k] as unknown[]).every((x) => typeof x === "string"))) return false;
  }
  if (e.userOs != null && e.userOs !== "all" && e.userOs !== "android") return false;
  return true;
}

/** A row of the shared clone board, as the VC edit reads it: the buyer's values in the board's spelling and
 *  the row's EFFECTIVE destination (its own picks over the batch Settings). */
export type VcRowPick = {
  name: string;
  budget: string;
  bidStrategy: string;
  /** The row's Bid column — a $ cap or a ROAS goal, by ITS strategy. */
  bid: string;
  countries: string[];
  /** Language names, as the Targeting editor holds them. */
  locales: string[];
  category: string;
  placement: string;
  ageMin: string;
  /** Cabinet digits; "" or the board's "From each source" pick = the source's own. */
  accountId: string;
  /** Page id; "" or the "From each source" pick = the source's. */
  pageId: string;
  /** "" = the event's own dataset. */
  pixelId: string;
  event: VcCloneEvent;
  /** "" = as each source. */
  userOs: "" | "all" | "android";
};

const idOrEmpty = (v: string): string => (/^\d{5,}$/.test(acct(v)) ? acct(v) : "");

/**
 * The edit a board row ships. Only what the buyer CHANGED rides as an override — an untouched row is a
 * faithful copy (the source's geo, age, placement and its locale ids exactly as targeted, not a name round
 * trip). The cabinet is always named (the queue meters the launch limit by it): the picked one, else the
 * source's own.
 */
export function vcRowEdit(src: VcCloneSource, row: VcRowPick): VcCloneEdit {
  const bidStrategy = str(row.bidStrategy).trim() || src.bidStrategy;
  const pageId = idOrEmpty(row.pageId);
  const edit: VcCloneEdit = {
    campaignId: src.campaignId,
    accountId: idOrEmpty(row.accountId) || src.accountId,
    name: str(row.name).trim(),
    budget: str(row.budget).trim() || src.budget,
    bidStrategy,
    bidCap: bidKind(bidStrategy) === "none" ? "" : str(row.bid).trim(),
    pixelId: /^\d{10,20}$/.test(str(row.pixelId).trim()) ? str(row.pixelId).trim() : "",
    event: row.event,
  };
  if (pageId && pageId !== src.pageId) edit.pageId = pageId;
  if (!sameList(row.countries, src.countries)) edit.countries = [...row.countries];
  if (!sameList(row.locales, vcLocaleNames(src.localeIds))) edit.locales = [...row.locales];
  if (row.category !== src.category) edit.category = row.category;
  if (row.placement !== src.placement) edit.placement = row.placement;
  if (row.ageMin !== src.ageMin) edit.ageMin = row.ageMin;
  if (row.userOs && row.userOs !== src.userOs) edit.userOs = row.userOs;
  return edit;
}
