import { NextResponse } from "next/server";
import { FbError, fbGet, hasFbToken } from "@/lib/fb-graph";
import { moneyLabel } from "@/lib/types";
import { sessionFromCookieHeader } from "@/lib/session";
import type { CloneCreative, CloneSource } from "@/lib/clone";

export const runtime = "nodejs";

// One batched multi-id read pulls every campaign + its ad sets + its ads' creatives in a single
// Graph call — the account is throttled hard during launch waves, so we never fan out per id.
const FIELDS = [
  "name",
  "objective",
  "special_ad_categories",
  // Campaign-budget (CBO) sources carry daily_budget + bid_strategy on the CAMPAIGN; legacy
  // sources on the ad set. Both are read — mapCampaign prefers the campaign's values.
  "daily_budget",
  "bid_strategy",
  "bid_constraints",
  "adsets.limit(5){name,daily_budget,bid_strategy,bid_amount,bid_constraints,billing_event,optimization_goal,promoted_object,targeting}",
  "ads.limit(15){name,creative{id,video_id,thumbnail_url}}",
].join(",");

type Json = Record<string, unknown>;

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function firstAdset(obj: Json): Json {
  const adsets = (obj.adsets as { data?: Json[] } | undefined)?.data;
  return adsets && adsets.length ? adsets[0] : {};
}

/** Geo: worldwide reach → our sentinel "WW"; otherwise the explicit country list. */
function targetingCountries(t: Json): string[] {
  const geo = (t.geo_locations ?? {}) as Json;
  const groups = geo.country_groups as string[] | undefined;
  if (Array.isArray(groups) && groups.includes("worldwide")) return ["WW"];
  const countries = geo.countries as string[] | undefined;
  return Array.isArray(countries) ? [...countries] : [];
}

/** Inverse of fb-launch placementBits: rebuild the FULL/COMPLIANCE + gender code from targeting. */
function targetingPlacement(t: Json): string {
  const fbPos = t.facebook_positions as string[] | undefined;
  const base = Array.isArray(fbPos) && fbPos.length === 1 && fbPos[0] === "feed" ? "COMPLIANCE" : "FULL";
  const genders = t.genders as number[] | undefined;
  if (Array.isArray(genders) && genders.length === 1) return genders[0] === 1 ? `${base}_HOMEM` : `${base}_MULHER`;
  return base;
}

/** Our redirect type isn't a Meta field — recover it from the name's markers, default META ADX. */
function redirectFromName(name: string): string {
  if (/\[HIGH\]|HIGH ADX/i.test(name)) return "HIGH ADX";
  if (/#ADX/.test(name)) return "#ADX";
  return "META ADX";
}

function mapCampaign(id: string, obj: Json): CloneSource {
  const name = String(obj.name ?? id);
  const adset = firstAdset(obj);
  const t = (adset.targeting ?? {}) as Json;

  const cats = obj.special_ad_categories as string[] | undefined;
  const category = Array.isArray(cats) && cats[0] && cats[0] !== "NONE" ? cats[0] : "";

  // Prefer the campaign's own budget/strategy (CBO source), fall back to the ad set (legacy).
  const budgetCents = num(obj.daily_budget) ?? num(adset.daily_budget);
  const bidCents = num(adset.bid_amount);
  // Min-ROAS sources bid through bid_constraints (adset under CBO — probed 08-11; campaign as a
  // fallback), not bid_amount: the ROAS column shows the floor / 10000 ("12000" → "1,2").
  const constraints = (adset.bid_constraints ?? obj.bid_constraints ?? {}) as Json;
  const roasFloor = num(constraints.roas_average_floor);
  const bidStrategy =
    typeof obj.bid_strategy === "string"
      ? obj.bid_strategy
      : typeof adset.bid_strategy === "string"
        ? adset.bid_strategy
        : "LOWEST_COST_WITHOUT_CAP";
  const optimization = adset.optimization_goal === "LINK_CLICKS" ? "clicks" : "conversions";
  const promoted = (adset.promoted_object ?? {}) as Json;
  const conversionEvent = typeof promoted.custom_event_type === "string" ? promoted.custom_event_type : "PURCHASE";

  const ads = (obj.ads as { data?: Json[] } | undefined)?.data ?? [];
  const creatives: CloneCreative[] = ads.map((a) => {
    const cr = (a.creative ?? {}) as Json;
    return { videoId: String(cr.video_id ?? ""), thumbUrl: String(cr.thumbnail_url ?? "") };
  });

  const userOs: "all" | "android" =
    Array.isArray(t.user_os) && (t.user_os as string[]).includes("Android") ? "android" : "all";

  return {
    campaignId: id,
    name,
    countries: targetingCountries(t),
    locales: [], // Meta returns numeric locale ids; not round-tripped to display names in phase 2a.
    category,
    placement: targetingPlacement(t),
    ageMin: String(num(t.age_min) ?? 18),
    userOs,
    originalBudget: budgetCents != null ? moneyLabel(budgetCents / 100) : "",
    originalRoas:
      roasFloor != null ? moneyLabel(roasFloor / 10000) : bidCents != null ? moneyLabel(bidCents / 100) : "",
    bidStrategy,
    objective: typeof obj.objective === "string" ? obj.objective : "OUTCOME_SALES",
    optimization,
    conversionEvent,
    redirectType: redirectFromName(name),
    creatives,
  };
}

/**
 * GET /api/clone/sources?partner=in&ids=<fbCampaignId>,...
 *
 * Pulls the real campaigns (name, geo, budget, bid, creatives, targeting) from Facebook by id so
 * the duplicator shows live data. Gated by the proxy (session required). Read-only.
 */
export async function GET(req: Request) {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!hasFbToken()) {
    return NextResponse.json({ ok: false, error: "no_fb_token" }, { status: 500 });
  }

  const ids = [
    ...new Set(
      (new URL(req.url).searchParams.get("ids") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => /^\d{5,}$/.test(s)),
    ),
  ];
  if (ids.length === 0) {
    return NextResponse.json({ ok: false, error: "no_ids" }, { status: 400 });
  }
  if (ids.length > 50) {
    return NextResponse.json({ ok: false, error: "too_many_ids", max: 50 }, { status: 400 });
  }

  // Per-campaign field-expansion reads (the multi-id `?ids=` batch param is deprecated in v26+).
  // Sequential + backoff (fbGet) keeps us under the account's rate limit; a not-found/no-access id
  // is skipped, but a rate-limit error aborts so the buyer retries rather than sees a partial list.
  try {
    const sources: CloneSource[] = [];
    const failed: string[] = [];
    for (const id of ids) {
      try {
        const obj = await fbGet(`${id}?fields=${encodeURIComponent(FIELDS)}`);
        sources.push(mapCampaign(id, obj));
      } catch (e) {
        const err = e as FbError;
        if (err.status === 429) throw err; // rate-limited → abort the whole batch
        failed.push(id); // not found / no access — skip this one
      }
    }
    return NextResponse.json({ ok: true, sources, failed });
  } catch (e) {
    const err = e as FbError;
    return NextResponse.json(
      { ok: false, error: err.message ?? String(e), detail: (err.detail as Json)?.error ?? null },
      { status: err.status ?? 502 },
    );
  }
}
