// PURE, dependency-free builders + readers for the TOOL launch channel (owner ask 28.09: run
// adlauncher launches/clones through the HS team's Ads Manager sessions service tool.gctracking.xyz
// under EVERY partner, alongside LION and our FB token). This is the CORE unit of the channel:
// the wire types, the name marker, the Campaign→request builders, the job readers and the
// dependency-injected orchestration (so a launch/clone can be driven and unit-tested with a fake
// transport). It is the single source of truth the routes and the client name-preview share.
//
// Contract read 28.09 from tool.gctracking.xyz /api/v1 openapi.json + /capabilities (digest in the
// design spec docs/superpowers/specs/2026-09-28-tool-launch-channel-design.md §2, and
// scratchpad TOOL_LIVE_NOTES). The two invariants that make TOOL DIFFERENT from our Graph/LION
// rails and must never be forgotten here (spec §3):
//   • money is USD (major units, NOT cents) — never reuse fb-launch.money()×100 / bidAmountCents;
//   • ROAS is the coefficient (1.2 = 120%, NOT ×10000) — never reuse roas_average_floor / hsWireBid.
// TOOL multiplies both internally.
//
// PURITY: this file has TYPE-ONLY imports and NO runtime relative / "@/" imports, so
// `node --test tests/tool-launch.test.ts` can load it straight off Node's type stripping. The
// vocabularies (conversion-event map, CTA map) are therefore duplicated here as literals rather
// than imported from lib/catalog — the mapping onto TOOL's enums is the whole point.

import type { ToolJobEvent } from "./tool-sessions-model";

// ---- small dependency-free shape guards (a foreign / partial answer must never throw) ----------

const str = (v: unknown): string => (v == null ? "" : String(v));
const num = (v: unknown, d = 0): number => (Number.isFinite(Number(v)) ? Number(v) : d);
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

// ================================================================================================
// 1. TOOL wire types (spec §2.1(a)) — the JSON shapes POST /accounts/{id}/campaigns|duplicates take.
//    Kept close to the openapi component schemas; additionalProperties:false there means we only
//    ever set the fields declared below.
// ================================================================================================

export type ToolMediaRef = {
  type: "image" | "video";
  media_id?: string | null;
  image_hash?: string | null;
  video_id?: string | null;
};

export type ToolConversionEvent =
  | "PURCHASE"
  | "LEAD"
  | "COMPLETE_REGISTRATION"
  | "ADD_TO_CART"
  | "INITIATED_CHECKOUT"
  | "ADD_PAYMENT_INFO"
  | "VIEW_CONTENT"
  | "SEARCH"
  | "SUBSCRIBE"
  | "START_TRIAL"
  | "CONTACT"
  | "SUBMIT_APPLICATION"
  | "SCHEDULE"
  | "DONATE"
  | "FIND_LOCATION"
  | "CUSTOMIZE_PRODUCT"
  | "OTHER";

export type ToolCta =
  | "LEARN_MORE"
  | "SHOP_NOW"
  | "SIGN_UP"
  | "GET_OFFER"
  | "DOWNLOAD"
  | "CONTACT_US"
  | "APPLY_NOW"
  | "BOOK_TRAVEL"
  | "GET_QUOTE"
  | "SUBSCRIBE"
  | "WATCH_MORE"
  | "ORDER_NOW"
  | "PLAY_GAME"
  | "NO_BUTTON"
  | "MESSAGE_PAGE"
  | "WHATSAPP_MESSAGE"
  | "SEND_MESSAGE"
  | "CALL_NOW"
  | "BUY_NOW"
  | "GET_STARTED"
  | "SEE_MORE"
  | "INSTALL_APP"
  | "USE_APP";

export type ToolObjective =
  | "OUTCOME_SALES"
  | "OUTCOME_LEADS"
  | "OUTCOME_TRAFFIC"
  | "OUTCOME_ENGAGEMENT"
  | "OUTCOME_AWARENESS"
  | "OUTCOME_APP_PROMOTION";

export type ToolOptimizationGoal =
  | "OFFSITE_CONVERSIONS"
  | "VALUE"
  | "LINK_CLICKS"
  | "LANDING_PAGE_VIEWS"
  | "IMPRESSIONS"
  | "REACH"
  | "LEAD_GENERATION"
  | "QUALITY_LEAD"
  | "THRUPLAY"
  | "POST_ENGAGEMENT"
  | "PAGE_LIKES"
  | "CONVERSATIONS"
  | "APP_INSTALLS"
  | "AD_RECALL_LIFT"
  | "QUALITY_CALL";

export type ToolBidStrategy =
  | "LOWEST_COST_WITHOUT_CAP"
  | "LOWEST_COST_WITH_BID_CAP"
  | "COST_CAP"
  | "LOWEST_COST_WITH_MIN_ROAS";

export type ToolSpecialAdCategory =
  | "NONE"
  | "HOUSING"
  | "EMPLOYMENT"
  | "CREDIT"
  | "ISSUES_ELECTIONS_POLITICS"
  | "FINANCIAL_PRODUCTS_SERVICES";

/** Money = USD; roas = coefficient (1.2). Exactly ONE of amount / roas is ever set. */
export type ToolBidSpec = { amount?: number | null; roas?: number | null };

export type ToolTargetingSpec = {
  countries: string[];
  age_min?: number;
  age_max?: number;
  genders?: (0 | 1 | 2)[];
  user_os?: ("Android" | "iOS")[] | null;
  publisher_platforms?: string[] | null;
  facebook_positions?: string[] | null;
  instagram_positions?: string[] | null;
  advantage_audience?: boolean | null;
  custom_audiences?: string[];
  excluded_custom_audiences?: string[];
  locales?: number[] | null;
  /** Raw Marketing-API targeting fields laid over the normalized ones (INFERRED) — where WW's
   *  country_groups + excluded_geo_locations live, since TargetingSpec.countries is ISO-2 only. */
  raw?: Record<string, unknown> | null;
};

export type ToolConversionSpec = {
  destination_type?: "WEBSITE" | "ON_AD" | "MESSENGER" | "INSTAGRAM_DIRECT" | "WHATSAPP" | "APP" | "PHONE_CALL";
  pixel_id?: string | null;
  event?: ToolConversionEvent | null;
  custom_event_str?: string | null;
  page_id?: string | null;
};

export type ToolCreativeSpec = {
  primary_text?: string | null;
  headline?: string | null;
  description?: string | null;
  url?: string | null;
  display_url?: string | null;
  cta?: ToolCta | null;
  media?: ToolMediaRef | null;
  thumbnail?: ToolMediaRef | null;
  url_tags?: string | null;
  object_story_id?: string | null;
};

export type ToolAdSpec = {
  name: string;
  status?: "ACTIVE" | "PAUSED";
  page_id?: string | null;
  instagram_actor_id?: string | null;
  creative: ToolCreativeSpec;
};

export type ToolAdSetSpec = {
  name: string;
  status?: "ACTIVE" | "PAUSED";
  optimization_goal: ToolOptimizationGoal;
  billing_event?: "IMPRESSIONS" | "LINK_CLICKS" | "THRUPLAY";
  targeting: ToolTargetingSpec;
  conversion?: ToolConversionSpec | null;
  bid_strategy?: ToolBidStrategy | null;
  bid?: ToolBidSpec | null;
  daily_budget?: number | null;
  lifetime_budget?: number | null;
  start_time?: string | null;
  end_time?: string | null;
  is_dynamic_creative?: boolean;
  ads: ToolAdSpec[];
};

export type ToolCampaignSpec = {
  name: string;
  objective: ToolObjective;
  status?: "ACTIVE" | "PAUSED";
  budget_type?: "CAMPAIGN" | "ADSET";
  daily_budget?: number | null;
  lifetime_budget?: number | null;
  bid_strategy?: ToolBidStrategy | null;
  special_ad_categories?: ToolSpecialAdCategory[];
  special_ad_category_country?: string[] | null;
  spend_cap?: number | null;
  start_time?: string | null;
  stop_time?: string | null;
};

export type ToolOptions = { allow_inferred?: boolean; activate?: boolean | null };

export type CampaignRequest = {
  campaign: ToolCampaignSpec;
  adsets: ToolAdSetSpec[];
  page_id?: string | null;
  mode?: "dry_run" | "validate" | "publish";
  options?: ToolOptions;
  delay_seconds?: number;
  start_at?: string | null;
  /** An explicit Ads Manager session (GET /accounts → sessions[].id; TOOL added it 30.09). Absent =
   *  TOOL picks a session that sees the account, as before. */
  session_id?: number | null;
};

export type DuplicateTarget = {
  account_id?: string | null;
  page_id?: string | null;
  name?: string | null;
  daily_budget?: number | null;
  bid?: number | null;
  status?: "ACTIVE" | "PAUSED" | "original";
  ad_status?: "ACTIVE" | "PAUSED" | "original";
  start_time?: string | null;
  user_os?: "Android" | "iOS" | null;
  bid_strategy?: string | null;
  pixel_id?: string | null;
  copies?: number;
};

export type DuplicateRequest = {
  source_campaign_id: string;
  targets: DuplicateTarget[];
  source_via?: "session" | "marketing_token";
  source_token_session_id?: number | null;
  priority?: number;
  delay_seconds?: number;
  start_at?: string | null;
  interval_seconds?: number;
};

export type ValidationProblem = { error: string; field: string; message: string; status?: string | null };
export type DryRunResult = {
  normalized: Record<string, unknown>;
  facebook_plan: Record<string, unknown>;
  problems?: ValidationProblem[];
  capabilities?: Record<string, unknown>;
};
export type MediaOut = {
  media_id: string;
  type: string;
  status: string;
  account_id: string;
  facebook?: Record<string, unknown>;
  error?: string | null;
};

// ================================================================================================
// 2. Name marker — GCL TOOL (spec §1). TOOL-born campaigns carry `GCL TOOL - ` where the FB-token
//    rail carries `TOKEN - ` (HS grammar) or after the partner prefix (MO/AIF), dropping the SOC
//    marker (SOC marks OUR social token as signer, which TOOL is not). The server re-ensures it;
//    the client name is never trusted. Idempotent.
// ================================================================================================

export const TOOL_MARK = "GCL TOOL - ";

/** Already-marked (anywhere in the name, at start or after a `- `). */
const HAS_TOOL_MARK = /(?:^|\s)GCL TOOL\s*-\s*/;

/** LION grammar prefix vs free tail — the exact regex of splitHsGrammar in lib/hs-launch.ts
 *  (kept in sync; that module owns the canonical copy). */
const HS_GRAMMAR =
  /^((?:\[\d{2}\/\d{2}\])\s*\([^)]*\)\s*API(?:\s*\(CLONE\))?(?:\s*-\s*JURO)?\s*-\s*\([^)]*\)\s*(?:-\s*\[[^\]]*\]\s*)*-\s*)([\s\S]*)$/;

/** MO/AIF partner prefix `[DD/MM] (X) - ` optionally followed by a clone segment `(CLONE) - (tier) - `
 *  (splitCloneName builds `[DD/MM] (CLONE) - (tier) - `). Group 1 is the whole fixed prefix; group 2
 *  is the tail. It never matches an HS name (those carry ` API ` after the first parenthetical). */
const PARTNER_PREFIX = /^(\[\d{2}[./]\d{2}\]\s*\([^)]*\)\s*-\s*(?:\([^)]*\)\s*-\s*)?)([\s\S]*)$/;

/** Drop a leading FB-token / SOC marker off a parsed TAIL — a token-born or soc-born source carries
 *  it right before the free text, and TOOL must not inherit it (nor let it double-apply). */
const stripChannelMark = (tail: string): string => tail.replace(/^(?:TOKEN|SOC)\s*-\s*/, "");

/** Drop a leading `GCL TOOL - ` off a parsed tail. */
export function stripToolMark(tail: string): string {
  return tail.replace(/^GCL TOOL\s*-\s*/, "");
}

/**
 * Guarantee the GCL TOOL marker on a name about to be created through TOOL (server-side truth — an
 * old/tampered client may send an unmarked, TOKEN- or SOC-marked name). HS-grammar names get it in
 * the TOKEN slot (after the fixed prefix, dropping any TOKEN-/SOC- marker); MO/AIF partner-prefixed
 * (and clone-prefixed) names get it right after the prefix (dropping SOC-); anything else is
 * prepended. Already-marked names pass through untouched. Idempotent.
 */
export function toolEnsureMark(name: string): string {
  const n = str(name);
  if (HAS_TOOL_MARK.test(n)) return n;
  const hs = HS_GRAMMAR.exec(n);
  if (hs) return `${hs[1]}${TOOL_MARK}${stripChannelMark(hs[2])}`;
  const partner = PARTNER_PREFIX.exec(n);
  if (partner) return `${partner[1]}${TOOL_MARK}${stripChannelMark(partner[2])}`;
  return `${TOOL_MARK}${n}`;
}

// ================================================================================================
// 3. Vocabulary mapping onto TOOL's enums (spec §2.1(c)) — our card values → TOOL's, refuse the rest
//    by name. Kept as literals (no runtime import from lib/catalog — this file must stay a leaf).
// ================================================================================================

/** Our CONVERSION_EVENTS values → TOOL's ConversionSpec.event. The only rename is
 *  CONTENT_VIEW→VIEW_CONTENT; ADD_TO_WISHLIST has NO TOOL event and is refused by name. */
const CONVERSION_EVENT_TO_TOOL: Record<string, ToolConversionEvent> = {
  PURCHASE: "PURCHASE",
  CONTENT_VIEW: "VIEW_CONTENT",
  LEAD: "LEAD",
  SEARCH: "SEARCH",
  SUBMIT_APPLICATION: "SUBMIT_APPLICATION",
  SUBSCRIBE: "SUBSCRIBE",
  COMPLETE_REGISTRATION: "COMPLETE_REGISTRATION",
  ADD_TO_CART: "ADD_TO_CART",
  ADD_PAYMENT_INFO: "ADD_PAYMENT_INFO",
  INITIATED_CHECKOUT: "INITIATED_CHECKOUT",
  SCHEDULE: "SCHEDULE",
  START_TRIAL: "START_TRIAL",
  CONTACT: "CONTACT",
  CUSTOMIZE_PRODUCT: "CUSTOMIZE_PRODUCT",
  DONATE: "DONATE",
  FIND_LOCATION: "FIND_LOCATION",
};

/** Our CTAS values → TOOL's cta enum. Empty (No CTA) → NO_BUTTON. Values TOOL's enum lacks
 *  (BOOK_NOW, DONATE_NOW, GET_SHOWTIMES, LISTEN_NOW, MESSAGE_US, REQUEST_TIME, SEE_MENU) are
 *  refused by name — the buyer must pick a TOOL-supported CTA. */
const CTA_TO_TOOL: Record<string, ToolCta> = {
  "": "NO_BUTTON",
  LEARN_MORE: "LEARN_MORE",
  SHOP_NOW: "SHOP_NOW",
  APPLY_NOW: "APPLY_NOW",
  CONTACT_US: "CONTACT_US",
  DOWNLOAD: "DOWNLOAD",
  GET_OFFER: "GET_OFFER",
  GET_QUOTE: "GET_QUOTE",
  PLAY_GAME: "PLAY_GAME",
  SIGN_UP: "SIGN_UP",
  SUBSCRIBE: "SUBSCRIBE",
  USE_APP: "USE_APP",
  WATCH_MORE: "WATCH_MORE",
  SEND_MESSAGE: "SEND_MESSAGE",
};

const TOOL_OBJECTIVES = new Set<ToolObjective>(["OUTCOME_SALES", "OUTCOME_LEADS", "OUTCOME_TRAFFIC"]);

// ================================================================================================
// 4. buildToolCampaign — our normalized launch input → a CampaignRequest (spec §2.1(c)). Semantics
//    MIRROR lib/fb-launch.ts (targeting / optimizationGoal / campaignPayload / adsetPayload), with
//    the two unit swaps (USD, ROAS coefficient) and TOOL's INFERRED gating.
// ================================================================================================

/** The bid a launch carries — `none` (lowest cost), a $ `cap` (USD), or a min-ROAS `coefficient`
 *  (1.2 = 120%). The caller (tool-run.toolInputFromCampaign) has already run bidKind /
 *  normalizeRoasGoal / parseMoney, so the numbers here are final human units. */
export type ToolBid = { kind: "none" } | { kind: "cap"; usd: number } | { kind: "roas"; coefficient: number };

export type ToolCreativeInput = {
  name: string;
  media: ToolMediaRef;
  thumbnail?: ToolMediaRef;
  primaryText: string;
  headline: string;
  description?: string;
  url: string;
  cta: string;
};

/** NORMALIZED launch input — callers do parseMoney / normalizeRoasGoal / bidKind / locale
 *  resolution / link building; this builder never touches env, IO, cents or ×10000. */
export type ToolBuildInput = {
  name: string;
  objective: string;
  /** Daily budget, campaign-level (CBO like our Graph rails), USD. */
  budgetUsd: number;
  bidStrategy: string;
  bid: ToolBid;
  optimization: "conversions" | "clicks";
  conversionEvent: string;
  pixelId: string;
  pageId: string;
  /** ISO-2 codes, or ["WW"] for worldwide. */
  countries: string[];
  localeIds: number[];
  /** Meta special-ad-category enum, "" = none. */
  category: string;
  placement: string;
  /** Meta publisher_platforms the ad set runs on (the AV card's pick, already parsed by
   *  lib/publisher-platforms); absent / [] = automatic. */
  platforms?: readonly string[];
  ageMin: string;
  userOs: string;
  adsetStartTime?: string;
  creatives: ToolCreativeInput[];
  status: "ACTIVE" | "PAUSED";
  accountCurrency: string;
  /** The TOOL session (FB profile) to build with — the AV card's Profile pick, parsed by
   *  toolSessionPick. Absent (Auto) = TOOL picks one that sees the account. */
  sessionId?: number;
};

export type BuildResult ={ ok: true; body: CampaignRequest; inferred: string[] } | { ok: false; error: string };

/** objective|goal|bid_strategy combos TOOL's /capabilities marks CONFIRMED (read 28.09: its `rules`
 *  + `tested_scenarios`). Anything else rides with allow_inferred (TOOL refuses it otherwise). */
export const TOOL_CONFIRMED_COMBOS: ReadonlySet<string> = new Set([
  "OUTCOME_SALES|VALUE|LOWEST_COST_WITH_MIN_ROAS",
  "OUTCOME_SALES|OFFSITE_CONVERSIONS|LOWEST_COST_WITHOUT_CAP",
  "OUTCOME_LEADS|LEAD_GENERATION|LOWEST_COST_WITHOUT_CAP",
]);

/** Placement encodes a set (FULL vs COMPLIANCE) + optional gender suffix — same bits as fb-launch. */
function placementBits(placement: string) {
  const p = str(placement);
  return { male: p.endsWith("HOMEM"), female: p.endsWith("MULHER"), compliance: p.startsWith("COMPLIANCE") };
}

/** Ad-set optimization goal — mirrors fb-launch.optimizationGoal: min-ROAS optimizes purchase VALUE,
 *  conversions optimize the pixel event, clicks optimize link clicks. */
function optimizationGoalOf(input: ToolBuildInput): ToolOptimizationGoal {
  if (input.bid.kind === "roas") return "VALUE";
  return input.optimization === "conversions" ? "OFFSITE_CONVERSIONS" : "LINK_CLICKS";
}

/** Targeting spec — mirrors fb-launch.targeting semantics against TOOL's TargetingSpec (which is
 *  ISO-2-only and additionalProperties:false, so WW rides in `raw`). Pushes every INFERRED field it
 *  used into `inferred`. */
function buildTargeting(input: ToolBuildInput, inferred: string[]): ToolTargetingSpec {
  const special = input.category !== "";
  const ww = input.countries.includes("WW");
  const t: ToolTargetingSpec = ww ? { countries: ["US"] } : { countries: [...input.countries] };
  if (ww) {
    // TargetingSpec has no country_groups field; the worldwide reach (minus TW/SG, owner rule
    // 2026-08-11 — carried from fb-launch) goes through raw (INFERRED, needs allow_inferred).
    t.raw = {
      geo_locations: { country_groups: ["worldwide"], location_types: ["home", "recent"] },
      excluded_geo_locations: { countries: ["TW", "SG"] },
    };
    inferred.push("WW");
  }

  const ageMin = special ? 18 : parseInt(input.ageMin || "18", 10) || 18;
  t.age_min = ageMin;
  t.age_max = 65;

  const { male, female, compliance } = placementBits(input.placement);
  const gendered = !special && (male || female);
  if (gendered) t.genders = male ? [1] : [2];

  // Platforms: the literal twin of lib/publisher-platforms.placementPlatformFields (this file stays
  // import-free; tests/av-platforms pins the two together). No pick: COMPLIANCE = FB + IG feeds (the
  // restricted-niche safe set), FULL sets nothing (Advantage+). A pick (AV, owner ask 30.09): FULL
  // runs every position of the picked platforms, COMPLIANCE only their feeds.
  const platforms = input.platforms?.length ? [...input.platforms] : null;
  if (compliance) {
    const set = platforms ?? ["facebook", "instagram"];
    t.publisher_platforms = set;
    if (set.includes("facebook")) t.facebook_positions = ["feed"];
    if (set.includes("instagram")) t.instagram_positions = ["stream"];
  } else if (platforms) {
    t.publisher_platforms = platforms;
  }

  if (input.userOs === "android") {
    // TargetingSpec has no device_platforms field (additionalProperties:false) — user_os alone,
    // per spec §2.1; fb-launch's extra device_platforms:["mobile"] is not expressible here.
    t.user_os = ["Android"];
  }

  if (input.localeIds.length) {
    t.locales = [...input.localeIds];
    inferred.push("locales");
  }

  // Narrowed audience (gender or age>18) → explicit no-Advantage decision, or Meta refuses with
  // "Advantage Audience Flag Required" (fb-launch parity). Broad 18+/all keeps TOOL's default.
  if (gendered || ageMin > 18) t.advantage_audience = false;

  return t;
}

/**
 * Build the CampaignRequest. CBO (campaign budget + bid_strategy) like our Graph rails; the ad set
 * carries the bid VALUE (roas coefficient / cap USD) but no budget. Returns the INFERRED fields it
 * used so options.allow_inferred is set truthfully. Refuses (nothing is ever sent) on any of the
 * spec §2.1 refusal conditions, naming the offending value.
 */
export function buildToolCampaign(input: ToolBuildInput): BuildResult {
  // ---- refusals (never sent) ----
  if (str(input.accountCurrency).toUpperCase() !== "USD") {
    return { ok: false, error: `account_currency_not_usd: ${str(input.accountCurrency) || "unknown"} — TOOL money is USD` };
  }
  if (!TOOL_OBJECTIVES.has(input.objective as ToolObjective)) {
    return { ok: false, error: `objective_unsupported: ${str(input.objective)} — TOOL enables OUTCOME_SALES / OUTCOME_LEADS / OUTCOME_TRAFFIC` };
  }
  if (!input.creatives.length) return { ok: false, error: "creatives_required" };
  if (!(input.budgetUsd >= 1)) return { ok: false, error: "budget_too_low — TOOL daily budget is USD, ≥ 1" };
  if (input.bid.kind === "roas" && !(input.bid.coefficient > 0 && input.bid.coefficient <= 100)) {
    return { ok: false, error: "roas_goal_invalid — the ROAS coefficient must be in (0, 100]" };
  }
  if (input.bid.kind === "cap" && !(input.bid.usd > 0)) {
    return { ok: false, error: "bid_required — a bid/cost cap needs a positive USD amount" };
  }

  // CTA — each creative's must map onto TOOL's enum; refuse the first that does not, by its value.
  for (const c of input.creatives) {
    if (!(str(c.cta) in CTA_TO_TOOL)) {
      return { ok: false, error: `cta_unsupported: ${str(c.cta)} — pick a TOOL-supported call to action` };
    }
  }

  const goal = optimizationGoalOf(input);
  const wantsConversion = goal === "VALUE" || goal === "OFFSITE_CONVERSIONS";

  // Conversion event (refuse unknowns by name). Min-ROAS pins PURCHASE (it optimizes purchase
  // value); conversions map the card's event; clicks carry no conversion object at all.
  let conversion: ToolConversionSpec | null = null;
  if (wantsConversion) {
    if (!input.pixelId) {
      // ConversionSpec requires pixel_id for WEBSITE + VALUE/OFFSITE_CONVERSIONS — refuse early with
      // a named reason (the launch route also guards this; see structured report deviation D1).
      return { ok: false, error: `pixel_required — ${goal} needs a pixel` };
    }
    let event: ToolConversionEvent;
    if (input.bid.kind === "roas") {
      event = "PURCHASE";
    } else {
      const mapped = CONVERSION_EVENT_TO_TOOL[str(input.conversionEvent)];
      if (!mapped) return { ok: false, error: `conversion_event_unsupported: ${str(input.conversionEvent)} — no TOOL event maps to it` };
      event = mapped;
    }
    conversion = { destination_type: "WEBSITE", pixel_id: input.pixelId, event };
  }

  const inferred: string[] = [];
  const targeting = buildTargeting(input, inferred);

  // Bid: min-ROAS → {roas: coefficient} (NOT ×10000); cap → {amount: usd} (NOT cents, INFERRED on
  // TOOL); lowest cost → no bid. bid_strategy lives on the CAMPAIGN (CBO).
  let bid: ToolBidSpec | null = null;
  const bidStrategy = input.bidStrategy as ToolBidStrategy;
  if (input.bid.kind === "roas") {
    bid = { roas: input.bid.coefficient };
  } else if (input.bid.kind === "cap") {
    bid = { amount: input.bid.usd };
    inferred.push(bidStrategy === "COST_CAP" ? "cost_cap" : "bid_cap");
  }
  // The objective × goal × strategy COMBINATION is gated too: TOOL refuses any combo outside its
  // CONFIRMED rules (/capabilities) without allow_inferred — live dry_run 28.09: OUTCOME_SALES +
  // LINK_CLICKS + LOWEST_COST_WITHOUT_CAP → "unsupported_combination … статус INFERRED". The cap
  // markers above already flag their own combos; name the rest so the flag is truthful.
  if (!inferred.includes("bid_cap") && !inferred.includes("cost_cap") && !TOOL_CONFIRMED_COMBOS.has(`${input.objective}|${goal}|${bidStrategy}`)) {
    inferred.push(`combo:${goal}`);
  }

  const status = input.status;
  const ads: ToolAdSpec[] = input.creatives.map((c) => {
    const creative: ToolCreativeSpec = {
      primary_text: c.primaryText || undefined,
      headline: c.headline || undefined,
      description: c.description || undefined,
      url: c.url || undefined,
      cta: CTA_TO_TOOL[str(c.cta)],
      media: c.media,
    };
    if (c.thumbnail) creative.thumbnail = c.thumbnail;
    return { name: c.name || input.name, status, creative };
  });

  const adset: ToolAdSetSpec = {
    name: input.name,
    status,
    optimization_goal: goal,
    billing_event: "IMPRESSIONS",
    targeting,
    ads,
  };
  if (conversion) adset.conversion = conversion;
  if (bid) adset.bid = bid;
  if (input.adsetStartTime) adset.start_time = input.adsetStartTime;

  const campaign: ToolCampaignSpec = {
    name: input.name,
    objective: input.objective as ToolObjective,
    status, // desired FINAL; TOOL creates PAUSED then activates last per options.activate
    budget_type: "CAMPAIGN",
    daily_budget: input.budgetUsd,
    bid_strategy: bidStrategy,
    special_ad_categories: input.category ? [input.category as ToolSpecialAdCategory] : ["NONE"],
  };

  const body: CampaignRequest = {
    campaign,
    adsets: [adset],
    page_id: input.pageId || undefined,
    mode: "publish",
    options: { allow_inferred: inferred.length > 0, activate: status === "ACTIVE" },
  };
  // The picked profile (owner ask 30.09) — only a real session id rides; Auto leaves TOOL's own pick.
  if (isToolSessionId(input.sessionId)) body.session_id = input.sessionId;

  return { ok: true, body, inferred };
}

// ================================================================================================
// 4b. The TOOL session (FB profile) pick — TOOL 30.09 takes an explicit `session_id` on
//     POST /accounts/{id}/campaigns and on media registration (owner ask 30.09: "добавили session id
//     и теперь можем сделать выбор профилей у нас"). The card stores the id as a string ("" = Auto).
// ================================================================================================

/** A usable TOOL session id: a positive integer (TOOL's ids are small serials). */
export const isToolSessionId = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/**
 * The card's Profile pick → a session id. Missing / "" / "auto" = Auto (`id: null` — TOOL picks the
 * session by account); a positive integer (number or digit string, ≤9 digits) = that session;
 * anything else is refused (`ok: false`) so a garbled pick is never silently widened to Auto.
 */
export function toolSessionPick(raw: unknown): { ok: true; id: number | null } | { ok: false } {
  if (raw == null) return { ok: true, id: null };
  if (typeof raw === "number") return isToolSessionId(raw) ? { ok: true, id: raw } : { ok: false };
  if (typeof raw !== "string") return { ok: false };
  const s = raw.trim();
  if (s === "" || s.toLowerCase() === "auto") return { ok: true, id: null };
  if (!/^\d{1,9}$/.test(s)) return { ok: false };
  const id = Number(s);
  return isToolSessionId(id) ? { ok: true, id } : { ok: false };
}

/** One pickable profile for an account: the TOOL session id + name, and its FB profile name ("" when
 *  GET /sessions was unreadable). */
export type ToolSessionChoice = { id: number; name: string; profile: string };

/**
 * The profiles a card may pick for one account: the sessions TOOL's GET /accounts lists as seeing it,
 * minus any the session directory (GET /sessions) knows is not `active` (expired / disabled), each
 * labelled with its FB profile name, sorted by session name (av-01, av-02, …). No directory = every
 * listed session, names only. Ids that are not real session ids are dropped.
 */
export function toolSessionChoices(
  sessions: readonly { id: number; name: string }[],
  directory: ReadonlyMap<number, { name: string; profile: string; status: string }> | null,
): ToolSessionChoice[] {
  const out: ToolSessionChoice[] = [];
  const seen = new Set<number>();
  for (const s of sessions) {
    if (!isToolSessionId(s.id) || seen.has(s.id)) continue;
    const known = directory?.get(s.id);
    if (known && known.status !== "active") continue;
    seen.add(s.id);
    out.push({ id: s.id, name: str(s.name) || str(known?.name) || `#${s.id}`, profile: str(known?.profile) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
}

// ================================================================================================
// 5. buildToolDuplicate — one-target DuplicateRequest (spec §2.1(d)). copies:1; status/ad_status =
//    the desired status. Money USD, bid a coefficient or cap by the target strategy.
// ================================================================================================

export type ToolDuplicateInput = {
  sourceCampaignId: string;
  /** Target account digits (SOURCE_ACCOUNT already resolved to the real id by the caller). */
  accountId: string;
  pageId: string;
  /** REQUIRED cross-account when the source has a pixel — the caller supplies it. */
  pixelId: string;
  name: string;
  budgetUsd: number;
  /** USD (cap) or ROAS coefficient (min-ROAS), by the target strategy. Omit for lowest cost. */
  bid?: number;
  bidStrategy?: string;
  status: "ACTIVE" | "PAUSED";
  startTime?: string;
};

export type DuplicateBuildResult = { ok: true; body: DuplicateRequest } | { ok: false; error: string };

export function buildToolDuplicate(input: ToolDuplicateInput): DuplicateBuildResult {
  if (str(input.sourceCampaignId).length < 5) return { ok: false, error: "source_campaign_id_invalid" };
  if (!(input.budgetUsd >= 1)) return { ok: false, error: "budget_too_low — TOOL daily budget is USD, ≥ 1" };

  const target: DuplicateTarget = {
    account_id: input.accountId || null,
    status: input.status,
    ad_status: input.status,
    daily_budget: input.budgetUsd,
    copies: 1,
  };
  if (input.pageId) target.page_id = input.pageId;
  if (input.name) target.name = input.name;
  if (input.bid != null && input.bid > 0) target.bid = input.bid;
  if (input.bidStrategy) target.bid_strategy = input.bidStrategy;
  if (input.pixelId) target.pixel_id = input.pixelId;
  if (input.startTime) target.start_time = input.startTime;

  return { ok: true, body: { source_campaign_id: input.sourceCampaignId, targets: [target] } };
}

// ================================================================================================
// 6. Job reading (spec §2.1(e), §2.4). Terminal set is reimplemented locally (consistent with
//    lib/tool-sessions-model.isTerminalJob) so this file imports only TYPES.
// ================================================================================================

const TERMINAL = new Set(["done", "partial", "error", "unknown", "canceled"]);
/** A TOOL job that will not move again on its own. Kept in lock-step with isTerminalJob. */
export const isToolJobTerminal = (status: string): boolean => TERMINAL.has(str(status).toLowerCase());

export type ToolCreated = { campaignId?: string; adsetIds: string[]; adIds: string[] };

function readCreated(result: unknown): ToolCreated {
  const created = rec(rec(result).created);
  return {
    campaignId: str(created.campaign_id) || undefined,
    adsetIds: strList(created.adset_ids),
    adIds: strList(created.ad_ids),
  };
}

export type ToolJobOutcome =
  | { state: "pending" }
  | { state: "done"; campaignId: string; adsetIds: string[]; adIds: string[]; activated: boolean }
  | { state: "failed"; error: string; created?: ToolCreated };

/**
 * What a polled job means (spec §1 line 75). Not terminal → pending. done → the created ids +
 * whether TOOL reported activating (read defensively from result.activated — TOOL has NOT confirmed
 * an `activated` flag on publish, so it defaults to false and NOBODY acts on it: the server asks TOOL
 * to activate through options.activate, and a done job with a campaign id is settled as a launch.
 * A park-on-mismatch over this flag would mislabel every successful live launch as PAUSED should
 * TOOL simply omit it — it is only recorded here until TOOL documents the flag; risk in spec §4).
 * partial/error/unknown/canceled → failed, carrying whatever result.created holds.
 */
export function toolJobOutcome(job: unknown): ToolJobOutcome {
  const j = rec(job);
  const status = str(j.status).toLowerCase();
  if (!isToolJobTerminal(status)) return { state: "pending" };
  if (status === "done") {
    const created = readCreated(j.result);
    const activated = rec(j.result).activated === true;
    return { state: "done", campaignId: created.campaignId ?? "", adsetIds: created.adsetIds, adIds: created.adIds, activated };
  }
  const created = readCreated(j.result);
  const error = str(j.error) || `TOOL job ${status}`;
  const out: ToolJobOutcome = { state: "failed", error };
  if (created.campaignId || created.adsetIds.length || created.adIds.length) out.created = created;
  return out;
}

/** Meta's error_message is HTML: tags, entities and a "See <a …>link</a> for details" tail whose
 *  URL is a tracking redirect — none of it belongs in a task row. */
function plainFbText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\s*See\s*<a\b[\s\S]*$/i, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/, "")
    .slice(0, 300);
}

/**
 * Facebook's own reason behind a failed / partial TOOL job, read from the job's events. A partial
 * publish names every object Meta refused in its error event (`meta.failed[]`: type, error_code,
 * error_message), while the job itself usually carries no `error` at all — which surfaced as a bare
 * "TOOL job partial" (owner, live 08.10: "а что тут за ошибка?" — the page was restricted from
 * advertising). Newest event first; "" when the events name nothing.
 */
export function toolFailedReason(events: unknown): string {
  if (!Array.isArray(events)) return "";
  for (let i = events.length - 1; i >= 0; i--) {
    const failed = rec(rec(events[i]).meta).failed;
    if (!Array.isArray(failed) || failed.length === 0) continue;
    const first = rec(failed[0]);
    const text = plainFbText(str(first.error_message) || str(first.message) || str(first.error));
    if (!text) continue;
    const code = str(first.error_code);
    const more = failed.length > 1 ? ` (+${failed.length - 1} more)` : "";
    return `Facebook refused the ${str(first.type) || "object"}: ${text}${code ? ` (code ${code})` : ""}${more}`;
  }
  return "";
}

/** Our NDJSON stage vocabulary (spec §2.4) — reused so task managers render a TOOL run unchanged. */
export type ToolNdjsonStage = "gcm" | "video" | "processing" | "campaign" | "adset" | "creative" | "ad" | "done" | "error";

/** TOOL event step → our stage. `publish` appears twice live (accepted, then with ids) — the ids
 *  variant is told apart by its meta. */
const STEP_STAGE: Record<string, ToolNdjsonStage> = {
  queued: "campaign",
  draft: "campaign",
  fragments: "adset",
  close: "ad",
  activate: "ad",
};

function latestEvent(events: unknown): ToolJobEvent | null {
  if (!Array.isArray(events) || !events.length) return null;
  // Events arrive oldest-first; the last with a recognised step drives the stage.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = rec(events[i]);
    if (str(e.step)) return e as unknown as ToolJobEvent;
  }
  return null;
}

/**
 * The current NDJSON stage of a campaign.create / duplicate / media job (spec §2.4). Terminal jobs
 * map to done / error; a media job maps to video (registered) / processing (still uploading);
 * otherwise the latest event step (with the job's own draft/fragment ids as a fallback) drives it.
 */
export function toolStageOf(job: unknown, events?: unknown): ToolNdjsonStage {
  const j = rec(job);
  const status = str(j.status).toLowerCase();
  if (isToolJobTerminal(status)) return status === "done" ? "done" : "error";

  const kind = str(j.kind);
  if (kind.startsWith("media")) return status === "running" ? "processing" : "video";

  const ev = latestEvent(events);
  if (ev) {
    const step = str(ev.step);
    if (step === "publish") {
      const meta = rec(ev.meta);
      const hasIds = Boolean(str(meta.campaign_id)) || strList(meta.ad_ids).length > 0;
      return hasIds ? "ad" : "creative";
    }
    const mapped = STEP_STAGE[step];
    if (mapped) return mapped;
  }

  const stage = str(j.stage).toUpperCase();
  if (stage === "SUCCEEDED") return "ad";
  if (strList(j.fragment_ids).length) return "adset";
  if (str(j.draft_id)) return "campaign";
  return "campaign";
}

/**
 * One human sentence for a TOOL failure — from a ToolFailure / ErrorOut ({error,message,problems}),
 * a ValidationProblem[], or a plain job.error string. The `missing_context` problem TOOL answers
 * when no live session sees the account gets the actionable session sentence (spec §1 / §2.1(e)).
 */
export function toolFailureText(input: unknown, accountId?: string): string {
  const problemList = (v: unknown): Array<Record<string, unknown>> => {
    if (Array.isArray(v)) return v.map(rec);
    const r = rec(v);
    if (Array.isArray(r.problems)) return r.problems.map(rec);
    return [];
  };
  const problems = problemList(input);
  const missing = problems.find((p) => str(p.error) === "missing_context") || (rec(input).error === "missing_context" ? rec(input) : null);
  if (missing) {
    const acct = accountId ? ` account ${accountId}` : "";
    return `No live TOOL session sees${acct} — an owner refreshes it on Ads Manager sessions`;
  }

  if (typeof input === "string" && input.trim()) return input.trim();
  const r = rec(input);
  if (str(r.message)) return str(r.message);
  if (problems.length) {
    const p = problems[0];
    return str(p.message) || str(p.error) || "TOOL rejected the request";
  }
  if (str(r.error)) return str(r.error);
  return "TOOL rejected the request";
}

// ================================================================================================
// 7. Dependency-injected orchestration (spec §2.1(f)). ToolDeps is bound to the real transport by
//    lib/tool-run; the tests bind a fake. Result shapes match lib/tool-sessions' functions.
// ================================================================================================

export type ToolCallFailure = { ok: false; status: number; error: string; message: string; field?: string; problems?: unknown[] };
export type ToolCallResult<T = unknown> = { ok: true; status: number; data: T } | ToolCallFailure;

export type ToolDeps = {
  createCampaign: (accountId: string, body: CampaignRequest, opts?: { idempotencyKey?: string }) => Promise<ToolCallResult>;
  createDuplicates: (accountId: string, body: DuplicateRequest, opts?: { idempotencyKey?: string }) => Promise<ToolCallResult>;
  mediaFromUrl: (
    accountId: string,
    kind: "image" | "video",
    body: { url: string; filename?: string; session_id?: number },
    opts?: { idempotencyKey?: string },
  ) => Promise<ToolCallResult>;
  getMedia: (mediaId: string) => Promise<ToolCallResult>;
  getJob: (id: number) => Promise<ToolCallResult>;
  jobEvents: (id: number) => Promise<ToolCallResult>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

const MEDIA_POLL_MS = 2500;
const JOB_POLL_MS = 2500;
/** Ceiling for the status-poll backoff on a 429 (review find 28.09) — the shared glo-01 session is
 *  rate-limited under load; the interval doubles up to this so a 429 storm never spins. */
const MAX_JOB_POLL_MS = 10_000;

export type ToolMediaItem = { url: string; kind: "image" | "video"; name?: string; coverUrl?: string };
export type ToolMediaRefOut = { media: ToolMediaRef; thumbnail?: ToolMediaRef };
export type ToolMediaRun =
  | { ok: true; refs: ToolMediaRefOut[] }
  | { ok: false; error: string; index?: number };

type StageCb = (stage: ToolNdjsonStage) => void;

/** Register ONE media by URL and poll it to `ready`. Transient (5xx / network) getMedia failures
 *  are retried until the deadline; a 4xx is a hard failure. */
async function awaitOneMedia(
  deps: ToolDeps,
  accountId: string,
  kind: "image" | "video",
  url: string,
  filename: string | undefined,
  idempotencyKey: string | undefined,
  deadlineAt: number,
  onStage?: StageCb,
  sessionId?: number,
): Promise<{ ok: true; mediaId: string } | { ok: false; error: string }> {
  const body: { url: string; filename?: string; session_id?: number } = { url };
  if (filename) body.filename = filename;
  // The picked profile uploads the media too (owner ask 30.09) — Auto leaves TOOL's own pick.
  if (isToolSessionId(sessionId)) body.session_id = sessionId;
  const reg = await deps.mediaFromUrl(accountId, kind, body, { idempotencyKey });
  if (!reg.ok) return { ok: false, error: toolFailureText(reg, accountId) };
  const first = rec(reg.data);
  const mediaId = str(first.media_id);
  if (!mediaId) return { ok: false, error: "TOOL did not return a media id" };
  onStage?.("video");
  let status = str(first.status).toLowerCase();
  let error = str(first.error);
  for (;;) {
    if (status === "ready") return { ok: true, mediaId };
    if (status === "error" || status === "failed") return { ok: false, error: error || "TOOL media processing failed" };
    if (deps.now() >= deadlineAt) return { ok: false, error: "TOOL media was not ready before the deadline" };
    onStage?.("processing");
    await deps.sleep(MEDIA_POLL_MS);
    const g = await deps.getMedia(mediaId);
    if (!g.ok) {
      // A definite 4xx (e.g. 404 — the media vanished) is fatal; 5xx / network is transient.
      if (g.status >= 400 && g.status < 500) return { ok: false, error: toolFailureText(g, accountId) };
      continue;
    }
    const go = rec(g.data);
    status = str(go.status).toLowerCase();
    error = str(go.error) || error;
  }
}

/**
 * Register every creative's media through TOOL (media/{images|videos}/from-url with our public
 * URL) and wait for each to be `ready`, returning a MediaRef per item — plus a `thumbnail` MediaRef
 * for a video that carries a custom coverUrl. The first failure short-circuits with its index.
 * `sessionId` (the card's Profile pick) rides every registration; absent = TOOL picks the session.
 */
export async function runToolMedia(
  deps: ToolDeps,
  accountId: string,
  items: ToolMediaItem[],
  opts: { deadlineAt: number; onStage?: StageCb; idempotencyKey?: string; sessionId?: number },
): Promise<ToolMediaRun> {
  const refs: ToolMediaRefOut[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const m = await awaitOneMedia(deps, accountId, it.kind, it.url, it.name, opts.idempotencyKey, opts.deadlineAt, opts.onStage, opts.sessionId);
    if (!m.ok) return { ok: false, error: m.error, index: i };
    const out: ToolMediaRefOut = { media: { type: it.kind, media_id: m.mediaId } };
    if (it.kind === "video" && it.coverUrl) {
      const cover = await awaitOneMedia(
        deps,
        accountId,
        "image",
        it.coverUrl,
        it.name ? `${it.name}-cover` : undefined,
        opts.idempotencyKey,
        opts.deadlineAt,
        opts.onStage,
        opts.sessionId,
      );
      if (!cover.ok) return { ok: false, error: cover.error, index: i };
      out.thumbnail = { type: "image", media_id: cover.mediaId };
    }
    refs.push(out);
  }
  return { ok: true, refs };
}

export type ToolPublishRun =
  | { ok: true; jobId: number; campaignId: string; adsetId: string; adIds: string[] }
  | { ok: false; error: string; jobId?: number; created?: ToolCreated; pending?: boolean };

/**
 * Poll ONE job (campaign.create or a duplicate child) to a terminal state (spec §2.1(f)). Reads
 * events only while the job is still running, and at most every other poll, to feed onStage.
 *
 * review find 28.09: the submit already succeeded, so the job is REAL — a FAILED *status* read is
 * NEVER a clean "nothing created". Every 4xx (incl. 401/403/404/408/429), 5xx and network error on
 * getJob is transient: we keep polling until the deadline, then return `pending:true` with the jobId
 * (the caller keeps its acct-slot + gcm and reconciles). Treating a 429 / post-submit 404 as a hard
 * failure here would free the code + slot while TOOL finishes creating a live ACTIVE campaign that
 * carries that gcm's link. Only a 4xx on the SUBMIT call (runToolPublish/runToolDuplicate) is a safe
 * refusal. A 429 backs the interval off (double up to ~10 s) so the shared glo-01 session's
 * rate-limiting never spins.
 */
async function pollJob(
  deps: ToolDeps,
  jobId: number,
  accountId: string,
  opts: { deadlineAt: number; onStage?: StageCb; pollMs?: number },
): Promise<ToolPublishRun> {
  const basePollMs = opts.pollMs ?? JOB_POLL_MS;
  let pollMs = basePollMs;
  let tick = 0;
  let events: unknown;
  let readOk = false; // did the LATEST status read succeed? drives the deadline sentence (review find 28.09)
  for (;;) {
    const jr = await deps.getJob(jobId);
    readOk = jr.ok;
    if (jr.ok) {
      pollMs = basePollMs; // recovered — drop any 429 backoff
      const job = jr.data;
      const status = str(rec(job).status).toLowerCase();
      if (isToolJobTerminal(status)) {
        const outcome = toolJobOutcome(job);
        if (outcome.state === "done") {
          // review find 28.09: a "done" that names no campaign cannot be settled either way — the
          // tree may exist without ids we can backfill. PENDING (keep slot + marker), never success.
          if (!outcome.campaignId) {
            return { ok: false, error: `TOOL job #${jobId} finished without reporting a campaign id — check Ads Manager sessions → Jobs`, jobId, pending: true };
          }
          opts.onStage?.("done");
          return { ok: true, jobId, campaignId: outcome.campaignId, adsetId: outcome.adsetIds[0] ?? "", adIds: outcome.adIds };
        }
        // failed (or, defensively, an outcome that never reached done)
        const failedError = outcome.state === "failed" ? outcome.error : "TOOL job ended without a campaign";
        const created = outcome.state === "failed" ? outcome.created : undefined;
        // A partial publish usually leaves the job's own `error` empty — Facebook's reason (which
        // object it refused, and why) lives in the events. One extra read, only on a failure.
        let reason = str(rec(job).error);
        if (!reason) {
          try {
            const ev = await deps.jobEvents(jobId);
            if (ev.ok) reason = toolFailedReason(ev.data);
          } catch {
            /* the generic sentence below stands */
          }
        }
        const error = toolFailureText(reason || failedError, accountId);
        // review find 28.09: only error / canceled WITHOUT created ids prove nothing landed (the
        // caller then frees slot + marker). partial / unknown without ids are ambiguous — TOOL may
        // have built part of the tree — so they settle as PENDING, never as a freed marker.
        if (!created && (status === "partial" || status === "unknown")) return { ok: false, error, jobId, pending: true };
        return { ok: false, error, jobId, created };
      }
      if (opts.onStage) {
        if (tick % 2 === 0) {
          const ev = await deps.jobEvents(jobId);
          if (ev.ok && Array.isArray(ev.data)) events = ev.data;
        }
        opts.onStage(toolStageOf(job, events));
      }
    } else if (jr.status === 429) {
      // review find 28.09: rate-limited on the shared session — back off (double up to ~10 s), still
      // transient (keep polling), never a refusal.
      pollMs = Math.min(pollMs * 2, MAX_JOB_POLL_MS);
    }
    // review find 28.09: a failed read (any 4xx/5xx/network) is transient after a good submit — keep
    // polling until the deadline, then PENDING (jobId kept so the caller keeps its slot + gcm).
    if (deps.now() >= opts.deadlineAt) {
      const error = readOk
        ? "TOOL is still working past the deadline"
        : `TOOL could not be read for job #${jobId} before the deadline — the campaign may still appear`;
      return { ok: false, error, jobId, pending: true };
    }
    await deps.sleep(pollMs);
    tick++;
  }
}

/** The parsed JobOut id of a create/duplicate submit answer (TOOL's job primary key). */
const jobIdOf = (data: unknown): number => num(rec(data).id);

/**
 * Submit a campaign create and follow its job to a terminal state. Refusal / ambiguity rule
 * (spec §2.1(f)): a 4xx on submit — or a 2xx that carries `problems` and no job id (the
 * missing_context shape TOOL answers with) — is a clean REFUSAL, nothing created. A network / 5xx
 * on submit gives no job id and no proof either way, so it is PENDING (the caller keeps its claim
 * and reconciles), never silently called a refusal.
 *
 * review find 28.09: `onSubmitted(jobId)` fires exactly once, synchronously, the instant TOOL
 * accepted the submit and returned a real job id — BEFORE any polling, and NEVER on a refused submit.
 * The route records the id right then, so a client-disconnect enqueue-throw mid-poll cannot make its
 * cleanup catch free the gcm/slot while the already-submitted job creates the live campaign.
 */
export async function runToolPublish(
  deps: ToolDeps,
  accountId: string,
  body: CampaignRequest,
  opts: { idempotencyKey?: string; deadlineAt: number; onStage?: StageCb; pollMs?: number; onSubmitted?: (jobId: number) => void },
): Promise<ToolPublishRun> {
  const sub = await deps.createCampaign(accountId, body, { idempotencyKey: opts.idempotencyKey });
  if (!sub.ok) {
    if (sub.status >= 400 && sub.status < 500) return { ok: false, error: toolFailureText(sub, accountId) };
    return { ok: false, error: toolFailureText(sub, accountId), pending: true };
  }
  const jobId = jobIdOf(sub.data);
  if (!jobId) {
    const problems = Array.isArray(rec(sub.data).problems) ? (rec(sub.data).problems as unknown[]) : [];
    if (problems.length) return { ok: false, error: toolFailureText(problems, accountId) };
    return { ok: false, error: "TOOL accepted the request but returned no job id", pending: true };
  }
  opts.onSubmitted?.(jobId); // accepted with a real job id — tell the caller BEFORE polling (review find 28.09)
  return pollJob(deps, jobId, accountId, opts);
}

/**
 * Submit a one-target duplicate batch and follow its single child job. Same refusal / ambiguity
 * rule as runToolPublish; the child result.created shape is read defensively (no duplicate job has
 * ever run live — spec §4). `onSubmitted(jobId)` fires exactly once before polling, and never on a
 * refused submit — same disconnect-safety contract as runToolPublish (review find 28.09).
 */
export async function runToolDuplicate(
  deps: ToolDeps,
  accountId: string,
  body: DuplicateRequest,
  opts: { idempotencyKey?: string; deadlineAt: number; onStage?: StageCb; pollMs?: number; onSubmitted?: (jobId: number) => void },
): Promise<ToolPublishRun> {
  const sub = await deps.createDuplicates(accountId, body, { idempotencyKey: opts.idempotencyKey });
  if (!sub.ok) {
    if (sub.status >= 400 && sub.status < 500) return { ok: false, error: toolFailureText(sub, accountId) };
    return { ok: false, error: toolFailureText(sub, accountId), pending: true };
  }
  const jobs = Array.isArray(rec(sub.data).jobs) ? (rec(sub.data).jobs as unknown[]) : [];
  const jobId = jobs.length ? num(rec(jobs[0]).id) : 0;
  if (!jobId) {
    const problems = Array.isArray(rec(sub.data).problems) ? (rec(sub.data).problems as unknown[]) : [];
    if (problems.length) return { ok: false, error: toolFailureText(problems, accountId) };
    return { ok: false, error: "TOOL accepted the duplicate but returned no child job", pending: true };
  }
  opts.onSubmitted?.(jobId); // accepted with a real child job id — tell the caller BEFORE polling (review find 28.09)
  return pollJob(deps, jobId, accountId, opts);
}
