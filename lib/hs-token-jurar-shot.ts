// ONE token JURO copy — the body of /api/hs/token-jurar's pump loop, moved here verbatim so the
// durable queue can run it as a job (lib/launch-queue-runners hs.tokenjurar): a small Graph tree
// (source read + campaign / adset / creatives-from-posts / ads, NO media migration) built with OUR
// partner-side token; the ads re-use the source ads' object stories on the post's own fanpage;
// targeting is the fresh jurar shape with the buyer's override. The route still validates the wave.
// The source tree and the page names a wave's copies shared in memory are cached per PROCESS.

import { bidKind } from "@/lib/types";
import { hsEnsureTokenMark, hsNormalizedConstraints, hsWireBid } from "@/lib/hs-launch";
import {
  juroBlockingError,
  juroConversionEvent,
  juroEnsureMark,
  juroSourceGeo,
  juroSourceLocaleIds,
  juroStoryPages,
  juroTokenCountries,
  juroTokenRegionalCategories,
  juroTokenTargeting,
} from "@/lib/juro";
import { hsPageRefusal, reportPagesUsed } from "@/lib/hs-pages";
import type { GeoOverride } from "@/lib/targeting-override";
import { FbError } from "@/lib/fb-graph";
import { hsDupCreateAdset, hsDupFbGet, hsDupFbPost, hsDupPauseCampaign, hsTokenStartTime } from "@/lib/hs-token-launch";
import { adPayload } from "@/lib/fb-launch";
import { launchFailureDisposition, partialFailureNote } from "@/lib/launch-guards";
import { AcctLimitedError, acctKey, claimAcctSlot, releaseAcctSlot } from "@/lib/acct-limit";
import type { ShotBinds } from "@/lib/hs-shot-binds";
import type { HsTokenShotDeps } from "@/lib/hs-token-dup-shot";

type Json = Record<string, unknown>;

/** One validated token-JURO shot as the route resolved it (JSON — stored in the job). */
export type HsTokenJuroShot = {
  campaignId: string;
  budget: number;
  budgetRaw: string;
  bid: number | null;
  /** This shot's OWN destination (no page — JURO ads live on the post's page). */
  binds: ShotBinds;
  accountName: string;
  bidStrategyOverride: string;
  bidLabel: string;
  name: string;
  geo: string;
  label: string;
  override: GeoOverride | null;
};

export type HsTokenJuroResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      family: boolean;
      accountFull: boolean;
      registryDown: boolean;
      retryable: boolean;
      /** A non-transient Meta wall: "account" kills every pending shot bound to this account. */
      wallScope: "account" | "family" | null;
    };

type JuroTree = { name: string; objective: string; specialCategories: string[]; bidStrategy: string; adset: Json; stories: string[] };

const CACHE_TTL_MS = 10 * 60_000;
const treeCache = new Map<string, { at: number; v: JuroTree }>();
const pageNameCache = new Map<string, { at: number; v: string }>();

async function readJuroTree(campaignId: string): Promise<JuroTree> {
  const fields = [
    "name",
    "objective",
    "special_ad_categories",
    "bid_strategy",
    "adsets.limit(1){targeting,bid_amount,bid_constraints,bid_strategy}",
    // effective_object_story_id resolves the REAL post even for spec-built ads.
    "ads.limit(25){creative{effective_object_story_id,object_story_id}}",
  ].join(",");
  const obj = await hsDupFbGet(`${campaignId}?fields=${encodeURIComponent(fields)}`);
  const adset = ((obj.adsets as { data?: Json[] } | undefined)?.data?.[0] ?? {}) as Json;
  const ads = ((obj.ads as { data?: Json[] } | undefined)?.data ?? []) as Json[];
  const stories = [
    ...new Set(
      ads
        .map((a) => {
          const c = (a.creative ?? {}) as Json;
          return String(c.effective_object_story_id ?? c.object_story_id ?? "");
        })
        .filter(Boolean),
    ),
  ];
  const cats = obj.special_ad_categories as string[] | undefined;
  return {
    name: String(obj.name ?? campaignId),
    objective: typeof obj.objective === "string" ? obj.objective : "OUTCOME_SALES",
    specialCategories: Array.isArray(cats) ? cats.filter((c) => c && c !== "NONE") : [],
    bidStrategy:
      typeof obj.bid_strategy === "string" ? obj.bid_strategy : typeof adset.bid_strategy === "string" ? adset.bid_strategy : "LOWEST_COST_WITHOUT_CAP",
    adset,
    stories,
  };
}

/** Per-shot wire pieces resolved from the SOURCE tree. String = the actionable refusal (family-scoped). */
function resolveShotWire(
  s: HsTokenJuroShot,
  tree: JuroTree,
): string | { stories: string[]; pages: { pageId: string; delta: number }[]; countries: string[]; localeIds: number[]; strategy: string; bidAmount?: number; bidConstraints?: Json; roas: boolean; conversionEvent: string } {
  if (tree.stories.length === 0) return "source has no page posts (object stories) to relaunch";
  const pages = juroStoryPages(tree.stories);
  if (!pages) return "source post ids are malformed — page underivable";
  const targeting = (tree.adset.targeting ?? {}) as Json;
  const countries = juroTokenCountries(s.override, juroSourceGeo(targeting));
  if (countries.length === 0) return "source geo unreadable — set a Targeting override on this row";
  const strategy = s.bidStrategyOverride || tree.bidStrategy;
  const switched = strategy !== tree.bidStrategy;
  const kind = bidKind(strategy);
  let bidAmount: number | undefined;
  let bidConstraints: Json | undefined;
  if (s.bid != null) {
    if (kind === "none") return "the copy bids lowest-cost (no cap) — clear the Bid on this row";
    const wire = kind === "roas" && s.bid > 100 ? null : hsWireBid(s.bid, strategy, "graph");
    if (wire == null) return kind === "roas" ? "roas goal ambiguous — type the decimal goal (0,30 = 30%)" : "bid not resolvable — retype the Bid on this row";
    if (kind === "roas") bidConstraints = { roas_average_floor: wire };
    else bidAmount = wire;
  } else if (switched && kind !== "none") {
    return `strategy switched to ${strategy} — type a Bid on this row (the source's bid doesn't carry across strategies)`;
  } else if (kind !== "none") {
    if (typeof tree.adset.bid_amount === "number") bidAmount = tree.adset.bid_amount as number;
    if (tree.adset.bid_constraints) bidConstraints = hsNormalizedConstraints(tree.adset.bid_constraints as Json);
    if (kind === "cap" && bidAmount == null) return "source bid unreadable right now — type a Bid on this row";
    if (kind === "roas" && !bidConstraints) return "source ROAS floor unreadable right now — type a Bid on this row";
  }
  return {
    stories: tree.stories,
    pages,
    countries,
    localeIds: s.override && s.override.localeIds.length > 0 ? s.override.localeIds : juroSourceLocaleIds(targeting),
    strategy,
    bidAmount,
    bidConstraints,
    roas: kind === "roas",
    conversionEvent: juroConversionEvent(strategy),
  };
}

/** The name of the fanpage carrying a story — the ad's DSA beneficiary/payor and the token's
 *  page-access pre-check in one read (cached; failures re-tried per shot). */
async function juroPageName(pageId: string, now: number): Promise<string> {
  const hit = pageNameCache.get(pageId);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.v;
  let bodyName = "";
  try {
    const body = await hsDupFbGet(`${pageId}?fields=name`);
    bodyName = typeof body.name === "string" ? body.name : "";
  } catch (e) {
    if (e instanceof FbError && e.status === 429) throw e;
    throw new FamilyError(`source page ${pageId} is not usable by our FB token (${(e as Error).message ?? e}) — its posts can't be relaunched on this rail; run this source's JURO on the LION API rail`, pageId);
  }
  pageNameCache.set(pageId, { at: now, v: bodyName });
  return bodyName;
}

class FamilyError extends FbError {
  constructor(message: string, key: string) {
    super(message, { key });
    this.name = "FamilyError";
  }
}

export async function runHsTokenJuroShot(s: HsTokenJuroShot, deps: HsTokenShotDeps): Promise<HsTokenJuroResult> {
  const { user, rowWrite } = deps;
  const now = deps.now();
  const binds = { account: acctKey(s.binds.account), pixel: s.binds.pixel, accountName: s.accountName };

  let acctSlot: { documentId: string } | null = null;
  const created: Json = {};
  try {
    rowWrite({ status: "running", stage: "queue", started_at: deps.now() });
    acctSlot = await claimAcctSlot(binds.account, { user, partner: "br", channel: "hs-juro-token", name: s.name || s.label || `JURO copy of ${s.campaignId}`, accountName: binds.accountName });

    let tree = treeCache.get(s.campaignId)?.v;
    if (!tree || now - (treeCache.get(s.campaignId)?.at ?? 0) >= CACHE_TTL_MS) {
      try {
        tree = await readJuroTree(s.campaignId);
      } catch (e) {
        if (e instanceof FbError && e.status === 429) throw e;
        throw new FamilyError(`our FB token can't read source campaign ${s.campaignId} (${(e as Error).message ?? e}) — run its JURO on the LION API rail`, s.campaignId);
      }
      treeCache.set(s.campaignId, { at: now, v: tree });
    }

    const wire = resolveShotWire(s, tree);
    if (typeof wire === "string") throw new FamilyError(wire, s.campaignId);
    // Owner rule 2026-09-07: the copy lands on the source post's OWN fanka — it must be OK in hs-tools.
    const fankaRefusal = await hsPageRefusal("br", wire.pages.map((p) => ({ id: p.pageId })));
    if (fankaRefusal) throw new FamilyError(fankaRefusal.error, s.campaignId);

    // Page-access pre-check + the DSA declaration value, BEFORE anything is created.
    let pageName = "";
    for (const p of wire.pages) {
      const n = await juroPageName(p.pageId, now);
      if (!pageName) pageName = n;
    }
    const name = hsEnsureTokenMark(juroEnsureMark(s.name || tree.name));

    // creatives FIRST — a dead source post refuses the shot with ZERO shells born.
    const creativeIds: string[] = [];
    created.creative_ids = creativeIds;
    for (let m = 0; m < wire.stories.length; m++) {
      const adName = wire.stories.length > 1 ? `${name} · ${m + 1}` : name;
      try {
        const creative = await hsDupFbPost(`act_${binds.account}/adcreatives`, { name: adName, object_story_id: wire.stories[m] });
        if (!creative.id) throw new FbError("creative create returned no id", creative);
        creativeIds.push(String(creative.id));
      } catch (e) {
        if (e instanceof FbError && e.status === 429) throw e;
        throw new FamilyError(`source post ${wire.stories[m]} can't be reused (${(e as Error).message ?? e}) — the post may be deleted/expired or our token lacks rights on its page; pick a fresher source or run it on the LION API rail`, s.campaignId);
      }
    }

    const camp = await hsDupFbPost(`act_${binds.account}/campaigns`, {
      name,
      objective: tree.objective,
      status: "ACTIVE",
      special_ad_categories: tree.specialCategories,
      daily_budget: Math.round(s.budget * 100),
      bid_strategy: wire.strategy,
    });
    created.campaign_id = String(camp.id);
    rowWrite({ status: "running", stage: "adset", campaign_id: created.campaign_id });

    const adsetPayload: Json = {
      name,
      campaign_id: String(camp.id),
      status: "ACTIVE",
      billing_event: "IMPRESSIONS",
      optimization_goal: wire.roas ? "VALUE" : "OFFSITE_CONVERSIONS",
      targeting: juroTokenTargeting(wire.countries, wire.localeIds),
      start_time: hsTokenStartTime(),
      promoted_object: { pixel_id: binds.pixel, custom_event_type: wire.conversionEvent },
    };
    if (pageName) {
      adsetPayload.dsa_beneficiary = pageName;
      adsetPayload.dsa_payor = pageName;
    }
    if (wire.bidAmount != null) adsetPayload.bid_amount = wire.bidAmount;
    if (wire.bidConstraints) adsetPayload.bid_constraints = wire.bidConstraints;
    const cats = juroTokenRegionalCategories(wire.countries);
    if (cats.length) adsetPayload.regional_regulated_categories = cats;
    const adset = await hsDupCreateAdset(`act_${binds.account}/adsets`, adsetPayload);
    created.adset_id = String(adset.id);
    rowWrite({ status: "running", stage: "ads", adset_id: created.adset_id });

    const adIds: string[] = [];
    for (let m = 0; m < creativeIds.length; m++) {
      const adName = creativeIds.length > 1 ? `${name} · ${m + 1}` : name;
      const ad = await hsDupFbPost(`act_${binds.account}/ads`, adPayload(adName, String(adset.id), creativeIds[m]));
      if (!ad.id) throw new FbError("ad create returned no id", ad);
      adIds.push(String(ad.id));
      created.ad_ids = [...adIds];
    }

    rowWrite({ status: "done", stage: "ads", campaign_id: created.campaign_id, adset_id: created.adset_id, ad_id: String(adIds.length), finished_at: deps.now(), error: null });
    await reportPagesUsed("br", wire.pages);
    return { ok: true };
  } catch (e) {
    const err = e as FbError;
    const family = e instanceof FamilyError;
    if (acctSlot && !created.campaign_id) await releaseAcctSlot(acctSlot.documentId);
    const msg = String(err.message ?? e);
    if (e instanceof AcctLimitedError || /acct_limit_unavailable/.test(msg)) {
      rowWrite({ status: "error", error: msg, finished_at: deps.now() });
      return { ok: false, error: msg, family: false, accountFull: e instanceof AcctLimitedError, registryDown: !(e instanceof AcctLimitedError), retryable: true, wallScope: null };
    }
    const disposition = launchFailureDisposition(created);
    const pausedOk = disposition.pauseNeeded ? await hsDupPauseCampaign(String(created.campaign_id)) : false;
    // No ad ever referenced the pre-built story creatives → orphans; best-effort delete.
    if (disposition.adsLive === 0 && Array.isArray(created.creative_ids)) {
      for (const cid of created.creative_ids as string[]) await hsDupFbPost(String(cid), { method: "delete" }).catch(() => {});
    }
    rowWrite({
      status: "error",
      error: `${msg}${partialFailureNote(disposition, pausedOk)}`,
      finished_at: deps.now(),
      ...(created.campaign_id ? { campaign_id: created.campaign_id } : {}),
      ...(created.adset_id ? { adset_id: created.adset_id } : {}),
    });
    const wall = juroBlockingError(msg);
    return { ok: false, error: wall?.reason ?? msg, family: family || wall?.scope === "family", accountFull: false, registryDown: false, retryable: !created.campaign_id && !family && !wall, wallScope: wall?.scope ?? null };
  }
}
