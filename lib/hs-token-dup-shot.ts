// ONE token duplicate — the body of /api/hs/token-duplicate's pump loop, moved here verbatim so
// the durable queue can run it as a job (lib/launch-queue-runners hs.tokendup): one clone = one
// full Graph tree built with OUR partner-side token — source tree read + faithful rebuild (verbatim
// targeting, all reusable ads, media migrated on cross-account), the buyer's budget / bid override,
// the binds' page / pixel, ACTIVE with start_time = +30 min. The route still validates the wave
// (LION binds, assignments, token visibility, the launch-limit precheck, the token gate).
//
// The source tree and migrated media a wave's copies shared in memory are cached per PROCESS: the
// copies of one wave run back to back in one invocation almost always; a cold cache costs a re-read
// (and, cross-account, a second migration of the same media — a library asset, never a campaign).

import { bidKind } from "@/lib/types";
import { hsEnsureTokenMark, hsNormalizedConstraints, hsWireBid } from "@/lib/hs-launch";
import { reportPagesUsed } from "@/lib/hs-pages";
import { type GeoOverride, applyGeoOverride, geoOverrideRegionalCategories } from "@/lib/targeting-override";
import { FbError } from "@/lib/fb-graph";
import { hsDupActiveToken, hsDupCreateAdset, hsDupFbGet, hsDupFbPost, hsDupPauseCampaign, hsTokenStartTime } from "@/lib/hs-token-launch";
import { type SourceMedia, adPayload, cloneCreativePayload, extractAdMedia, migrateMediaToAccount, swapPixel } from "@/lib/clone-run";
import { launchFailureDisposition, partialFailureNote } from "@/lib/launch-guards";
import { AcctLimitedError, acctKey, claimAcctSlot, releaseAcctSlot } from "@/lib/acct-limit";
import type { ShotBinds } from "@/lib/hs-shot-binds";

type Json = Record<string, unknown>;

/** One validated token-duplicate shot as the route resolved it (JSON — stored in the job). */
export type HsTokenDupShot = {
  campaignId: string;
  budget: number;
  budgetRaw: string;
  bid: number | null;
  bidStrategy: string;
  binds: ShotBinds;
  accountName: string;
  pageName: string;
  /** TARGET bid strategy (per-row ROAS ↔ cap ↔ lowest switch) — "" = inherit the source's. */
  bidStrategyOverride: string;
  bidLabel: string;
  name: string;
  geo: string;
  label: string;
  /** Geo/locales override (Targeting modal) — null = faithful clone of the source's targeting. */
  override: GeoOverride | null;
};

export type HsTokenShotResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      /** A fact of the SOURCE — its other copies would fail identically. */
      family: boolean;
      accountFull: boolean;
      registryDown: boolean;
      /** Nothing was created — a one-click retry is safe. */
      retryable: boolean;
    };

export type HsTokenShotDeps = {
  user: string;
  taskId: string;
  rowWrite: (fields: Record<string, unknown>) => void;
  now: () => number;
  log?: (msg: string) => void;
};

/** The full source read one clone needs: campaign facts + first ad set (verbatim targeting) +
 *  every ad's creative spec. Cached per campaign id across a wave's copies. */
type SourceTree = {
  name: string;
  objective: string;
  specialCategories: string[];
  bidStrategy: string;
  accountId: string;
  adset: Json;
  medias: SourceMedia[];
};

const CACHE_TTL_MS = 10 * 60_000;
const treeCache = new Map<string, { at: number; v: SourceTree }>();
const migratedCache = new Map<string, { at: number; v: SourceMedia }>();

function remember<T>(map: Map<string, { at: number; v: T }>, key: string, v: T, now: number): T {
  map.set(key, { at: now, v });
  if (map.size > 300) map.delete(map.keys().next().value as string);
  return v;
}
function recall<T>(map: Map<string, { at: number; v: T }>, key: string, now: number): T | undefined {
  const hit = map.get(key);
  return hit && now - hit.at < CACHE_TTL_MS ? hit.v : undefined;
}

async function readSourceTree(campaignId: string): Promise<SourceTree> {
  const fields = [
    "name",
    "objective",
    "special_ad_categories",
    "bid_strategy",
    "account_id",
    "adsets.limit(1){targeting,optimization_goal,billing_event,promoted_object,bid_amount,bid_constraints,bid_strategy}",
    "ads.limit(10){creative{object_story_spec,asset_feed_spec}}",
  ].join(",");
  const obj = await hsDupFbGet(`${campaignId}?fields=${encodeURIComponent(fields)}`);
  const adset = ((obj.adsets as { data?: Json[] } | undefined)?.data?.[0] ?? {}) as Json;
  const ads = ((obj.ads as { data?: Json[] } | undefined)?.data ?? []) as Json[];
  const medias = ads.map((a) => extractAdMedia(a)).filter((m): m is SourceMedia => m !== null);
  const cats = obj.special_ad_categories as string[] | undefined;
  return {
    name: String(obj.name ?? campaignId),
    objective: typeof obj.objective === "string" ? obj.objective : "OUTCOME_SALES",
    specialCategories: Array.isArray(cats) ? cats.filter((c) => c && c !== "NONE") : [],
    bidStrategy:
      typeof obj.bid_strategy === "string" ? obj.bid_strategy : typeof adset.bid_strategy === "string" ? adset.bid_strategy : "LOWEST_COST_WITHOUT_CAP",
    accountId: String(obj.account_id ?? "").replace(/^act_/, ""),
    adset,
    medias,
  };
}

/** Thrown for a refusal that is a fact of the SOURCE (its other copies would fail identically). */
class FamilyError extends FbError {
  constructor(message: string, campaignId: string) {
    super(message, { campaignId });
    this.name = "FamilyError";
  }
}

export async function runHsTokenDupShot(s: HsTokenDupShot, deps: HsTokenShotDeps): Promise<HsTokenShotResult> {
  const { user, rowWrite } = deps;
  const now = deps.now();
  // THIS shot's destination (per-row binds, 09-08) — every Graph path below builds here.
  const binds = { account: acctKey(s.binds.account), page: s.binds.page, pixel: s.binds.pixel, pageName: s.pageName, accountName: s.accountName };

  let acctSlot: { documentId: string } | null = null;
  const created: Json = {};
  let family = false;
  try {
    rowWrite({ status: "running", stage: "queue", started_at: deps.now() });

    // Account launch slot (5/30min) — right before the build; released on pre-campaign failure.
    acctSlot = await claimAcctSlot(binds.account, { user, partner: "br", channel: "hs-token-dup", name: s.name || s.label || `Clone of ${s.campaignId}`, accountName: binds.accountName });

    let tree = recall(treeCache, s.campaignId, now);
    if (!tree) tree = remember(treeCache, s.campaignId, await readSourceTree(s.campaignId), now);
    if (tree.medias.length === 0) throw new FamilyError("source has no reusable video/image creatives — duplicate it on the LION rail", s.campaignId);

    // The clone's EFFECTIVE strategy: the buyer's per-row switch wins (owner ask 09-01 — this rail
    // rebuilds the ad set from scratch, so ROAS ↔ cap ↔ lowest are all reachable); "" inherits the
    // source's verbatim. A typed bid is scaled by the EFFECTIVE strategy; with the strategy
    // unchanged an empty bid inherits the source ad set's own fields, but a SWITCHED cap/ROAS clone
    // has nothing to inherit — the row must type one.
    const strategy = s.bidStrategyOverride || tree.bidStrategy;
    const switched = strategy !== tree.bidStrategy;
    const kind = bidKind(strategy);
    if (switched && kind === "roas" && !((tree.adset.promoted_object ?? {}) as Json).pixel_id) {
      throw new FamilyError("source isn't conversion-optimized (no promoted pixel) — it can't switch to min-ROAS; pick cap/lowest instead", s.campaignId);
    }
    let bidAmount: number | undefined;
    let bidConstraints: Json | undefined;
    if (s.bid != null) {
      // "graph": this rail writes bid_constraints straight to Meta — floor stays ×10000.
      const wire = kind !== "none" && !(kind === "roas" && s.bid > 100) ? hsWireBid(s.bid, strategy, "graph") : null;
      if (wire == null) {
        throw new FamilyError(kind === "none" ? "the clone bids lowest-cost — clear the Bid on this row" : "bid not applicable/resolvable for this clone — retype the Bid", s.campaignId);
      }
      if (kind === "roas") bidConstraints = { roas_average_floor: wire };
      else bidAmount = wire;
    } else if (!switched) {
      // No override → inherit the source ad set's own bid, normalizing a percent/×10 ROAS floor a
      // pre-fix source may still carry (hsNormalizedConstraints).
      if (typeof tree.adset.bid_amount === "number") bidAmount = tree.adset.bid_amount as number;
      if (tree.adset.bid_constraints) bidConstraints = hsNormalizedConstraints(tree.adset.bid_constraints as Json);
    } else if (kind !== "none") {
      throw new FamilyError(`strategy switched to ${strategy} — type a Bid on this row (the source's bid doesn't carry across strategies)`, s.campaignId);
    }

    // Cross-account: re-home EVERY reusable media in the target before any write (cached per
    // source×index×target — copies of one source migrate once while the cache is warm).
    const cross = binds.account !== tree.accountId;
    let medias = tree.medias;
    if (cross) {
      rowWrite({ status: "running", stage: "queue" });
      const migrated: SourceMedia[] = [];
      for (let m = 0; m < tree.medias.length; m++) {
        const mKey = `${s.campaignId}:${m}→${binds.account}`;
        let done = recall(migratedCache, mKey, now);
        if (!done) {
          done = remember(migratedCache, mKey, await migrateMediaToAccount(tree.medias[m], tree.accountId, binds.account, `${s.name || tree.name} · media ${m + 1}`, await hsDupActiveToken()), now);
        }
        migrated.push(done);
      }
      medias = migrated;
    }

    // Server-side truth for the channel marker: a token-born clone ALWAYS carries TOKEN in its fixed part.
    const name = hsEnsureTokenMark(s.name || `${tree.name} (copy)`);

    // campaign — CBO with the buyer's budget, the source's objective, the EFFECTIVE bid strategy, ACTIVE.
    const camp = await hsDupFbPost(`act_${binds.account}/campaigns`, {
      name,
      objective: tree.objective,
      status: "ACTIVE",
      special_ad_categories: tree.specialCategories,
      daily_budget: Math.round(s.budget * 100),
      bid_strategy: strategy,
    });
    created.campaign_id = String(camp.id);
    rowWrite({ status: "running", stage: "adset", campaign_id: created.campaign_id });

    // adset — the source's targeting VERBATIM unless the buyer set a Targeting override (geo/locales
    // swapped in, everything else stays the source's), the binds' pixel, the partner's +30 min
    // start gap; regional declarations self-heal inside hsDupCreateAdset.
    let targeting = JSON.parse(JSON.stringify(tree.adset.targeting ?? {})) as Json;
    delete targeting.age_range; // read-only echo field
    if (s.override) targeting = applyGeoOverride(targeting, s.override);
    const srcPromoted = (tree.adset.promoted_object ?? {}) as Json;
    const adsetPayload: Json = {
      name,
      campaign_id: String(camp.id),
      status: "ACTIVE",
      billing_event: tree.adset.billing_event ?? "IMPRESSIONS",
      // Min-ROAS optimizes purchase VALUE; a clone switched OFF roas maps the source's VALUE goal
      // back to conversions. Unswitched clones keep the source's verbatim.
      optimization_goal: switched
        ? kind === "roas"
          ? "VALUE"
          : tree.adset.optimization_goal === "VALUE"
            ? "OFFSITE_CONVERSIONS"
            : (tree.adset.optimization_goal ?? "OFFSITE_CONVERSIONS")
        : (tree.adset.optimization_goal ?? "OFFSITE_CONVERSIONS"),
      targeting,
      start_time: hsTokenStartTime(),
      dsa_beneficiary: binds.pageName,
      dsa_payor: binds.pageName,
    };
    if (srcPromoted.pixel_id) {
      adsetPayload.promoted_object = {
        ...srcPromoted,
        pixel_id: binds.pixel,
        // A ROAS-switched clone value-optimizes PURCHASE regardless of the source's event.
        ...(switched && kind === "roas" ? { custom_event_type: "PURCHASE" } : {}),
      };
    }
    if (bidAmount != null) adsetPayload.bid_amount = bidAmount;
    if (bidConstraints) adsetPayload.bid_constraints = bidConstraints;
    // A WW override needs the TW/SG universal-ads declarations up front (further regions self-heal).
    if (s.override) {
      const cats = geoOverrideRegionalCategories(s.override);
      if (cats.length) adsetPayload.regional_regulated_categories = cats;
    }
    const adset = await hsDupCreateAdset(`act_${binds.account}/adsets`, adsetPayload);
    created.adset_id = String(adset.id);
    rowWrite({ status: "running", stage: "ads", adset_id: created.adset_id });

    // creatives + ads — one per reusable source ad; the `pixel=` param of the link is swapped to the
    // BIND pixel (the ad set optimizes on it — review find 08-24).
    const adIds: string[] = [];
    for (let m = 0; m < medias.length; m++) {
      const adName = medias.length > 1 ? `${name} · ${m + 1}` : name;
      const creative = await hsDupFbPost(`act_${binds.account}/adcreatives`, cloneCreativePayload(adName, binds.page, medias[m], "", "", (l) => swapPixel(l, binds.pixel)));
      const ad = await hsDupFbPost(`act_${binds.account}/ads`, adPayload(adName, String(adset.id), String(creative.id)));
      if (!ad.id) throw new FbError("ad create returned no id", ad);
      adIds.push(String(ad.id));
      // Progress lands on `created` AS ads are born — the catch below reads it to know whether the
      // ACTIVE tree already carries deliverable ads when a later ad throws.
      created.ad_ids = [...adIds];
    }

    rowWrite({ status: "done", stage: "ads", campaign_id: created.campaign_id, adset_id: created.adset_id, ad_id: String(adIds.length), finished_at: deps.now(), error: null });
    // Registry ledger: every ad this clone landed occupies a slot on the bind fanka.
    await reportPagesUsed("br", [{ pageId: binds.page, delta: adIds.length }]);
    return { ok: true };
  } catch (e) {
    const err = e as FbError;
    family = e instanceof FamilyError;
    if (acctSlot && !created.campaign_id) await releaseAcctSlot(acctSlot.documentId);
    const msg = String(err.message ?? e);
    if (e instanceof AcctLimitedError || /acct_limit_unavailable/.test(msg)) {
      rowWrite({ status: "error", error: msg, finished_at: deps.now() });
      return { ok: false, error: msg, family: false, accountFull: e instanceof AcctLimitedError, registryDown: !(e instanceof AcctLimitedError), retryable: true };
    }
    // The clone tree is born ACTIVE with only the +30 min start gap between a partial failure and
    // unattended delivery — pause the campaign (bounded) and put the confirmed state into the row.
    const disposition = launchFailureDisposition(created);
    const pausedOk = disposition.pauseNeeded ? await hsDupPauseCampaign(String(created.campaign_id)) : false;
    rowWrite({
      status: "error",
      error: `${msg}${partialFailureNote(disposition, pausedOk)}`,
      finished_at: deps.now(),
      ...(created.campaign_id ? { campaign_id: created.campaign_id } : {}),
      ...(created.adset_id ? { adset_id: created.adset_id } : {}),
    });
    return { ok: false, error: msg, family, accountFull: false, registryDown: false, retryable: !created.campaign_id && !family };
  }
}
