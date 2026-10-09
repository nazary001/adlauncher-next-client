// ONE LION duplicate shot — the body of /api/hs/duplicate's phase 1 (jittered submits), moved
// here verbatim so the durable queue can run it as a job (lib/launch-queue-runners hs.dup):
// re-read the source's bid facts, judge whose campaign it is, plan the bid, resolve the targeting
// override, claim the account's launch slot, submit to LION, read LION's resolved bidding back,
// record the task id on the row, keep the fanka ledger. The route still validates the wave
// (binds against LION's catalog, assignments, the launch-limit precheck) before anything is queued.
// The poll + activate tail (the old phase 2) is the wave's hs.dup.follow job (lib/hs-follow-core).
//
// Money rules kept exactly: a clean 4xx refusal releases the slot and is a fact of the SOURCE (the
// caller fails the queued siblings); a 5xx / transport failure after the submit is ambiguous — the
// slot stays consumed and the shot is never re-sent.

import { normalizeRoasGoal } from "@/lib/types";
import { reportPagesUsed } from "@/lib/hs-pages";
import { AcctLimitedError, acctKey, claimAcctSlot, releaseAcctSlot } from "@/lib/acct-limit";
import { LionError, lionCampaignAds, lionCampaignRefusal, lionDuplicate, lionSourceBidFacts, lionSourceTeam, type LionLocale } from "@/lib/lion";
import { dupBidPlan, dupBiddingMismatch } from "@/lib/lion-dup-bid";
import { lionDuplicateTargeting, type GeoOverride } from "@/lib/targeting-override";
import { teamMayUseCampaign } from "@/lib/team";
import type { ShotBinds } from "@/lib/hs-shot-binds";

/** One validated shot of a duplicate wave, as the route resolved it (JSON — it is stored in the job). */
export type HsDupShot = {
  campaignId: string;
  budget: number;
  budgetRaw: string;
  bid: number | null;
  bidStrategy: string;
  /** Per-row strategy switch ("" = the source's) — LION duplicate v2 takes bid_strategy. */
  bidStrategyOverride: string;
  bidLabel: string;
  /** Destination account currency (LION catalog, filled by validation). */
  currency: string;
  name: string;
  /** LION `name_suffix` for this shot. */
  suffix: string;
  geo: string;
  label: string;
  binds: ShotBinds;
  accountName: string;
  pageName: string;
  /** The profile's FB locale list (a targeting override's locale ids resolve to { name, id } from it). */
  profileLocales: LionLocale[];
  override: GeoOverride | null;
};

export type HsDupShotResult =
  | { outcome: "submitted"; lionTaskId: string; biddingMismatch: string | null }
  | {
      outcome: "refused";
      error: string;
      /** A fact of the SOURCE: its other copies would be refused identically (LION preflight, a
       *  foreign source, a 4xx). */
      family: boolean;
      /** The account's 30-min window is full — its other copies would hit it too. */
      accountFull: boolean;
      /** The launch registry could not be asked at all — nothing was sent, the whole rest waits. */
      registryDown: boolean;
      /** Nothing reached LION — a one-click retry is safe. */
      retryable: boolean;
    };

export type HsDupShotDeps = {
  user: string;
  taskId: string;
  /** Best-effort row write for THIS shot (the runner's observed writer). */
  rowWrite: (fields: Record<string, unknown>) => void;
  now: () => number;
  log?: (msg: string) => void;
};

// Per-process caches of what a wave's copies share (a source's bid facts, its ad count): the copies
// of one wave run back to back in one invocation almost always; a cold cache only costs a re-read.
const CACHE_TTL_MS = 10 * 60_000;
const factsCache = new Map<string, { at: number; v: { bidStrategy: string; currency: string; bid: number | null } }>();
const adsCountCache = new Map<string, { at: number; v: number }>();

async function cached<T>(map: Map<string, { at: number; v: T }>, key: string, now: number, read: () => Promise<T>): Promise<T> {
  const hit = map.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.v;
  const v = await read();
  map.set(key, { at: now, v });
  if (map.size > 500) map.delete(map.keys().next().value as string);
  return v;
}

/** Ads one clone of a source re-creates (each copy replicates every source ad) — a details/ read
 *  for the registry ledger. Unreadable sources count as 1. */
async function sourceAdsCount(campaignId: string, now: number): Promise<number> {
  return cached(adsCountCache, campaignId, now, async () => {
    try {
      return Math.max((await lionCampaignAds([campaignId]))[campaignId]?.adsCount ?? 0, 1);
    } catch {
      return 1;
    }
  });
}

export async function runHsDupShot(s: HsDupShot, deps: HsDupShotDeps): Promise<HsDupShotResult> {
  const { user, rowWrite } = deps;
  const now = deps.now();
  const refuse = (error: string, o: { family?: boolean; accountFull?: boolean; registryDown?: boolean; retryable?: boolean } = {}): HsDupShotResult => {
    rowWrite({ status: "error", error: error.slice(0, 1000), finished_at: deps.now() });
    return { outcome: "refused", error, family: o.family === true, accountFull: o.accountFull === true, registryDown: o.registryDown === true, retryable: o.retryable === true };
  };

  let slotDoc: string | null = null;
  try {
    // ---- bidding (LION duplicate v2, partner docs 09-09) ----
    // The SOURCE's strategy + account currency are re-read from LION (authoritative; the board's
    // snapshot only covers the "source unreadable right now" lag), then the plan decides what rides:
    // a per-row switch (explicit bid_strategy + a typed value + the re-paired event), a typed value
    // alone (strategy omitted = the source's), or nothing (inherit). ROAS values ride as `roas_goal`
    // (multiplier), NEVER as starting_bid. Cap values are Meta account units of the DESTINATION.
    const facts = await cached(factsCache, s.campaignId, now, () => lionSourceBidFacts(s.campaignId));
    // LION would duplicate ANY campaign of the company (lib/lion "whose campaign is it") — a source
    // that is not this team's to work on kills its whole family here: no slot, no call.
    const sourceTeam = await lionSourceTeam(s.campaignId);
    if (!teamMayUseCampaign(sourceTeam)) {
      return refuse(lionCampaignRefusal(s.campaignId, sourceTeam), { family: sourceTeam === "foreign" });
    }
    const plan = dupBidPlan({
      sourceStrategy: facts.bidStrategy || s.bidStrategy,
      override: s.bidStrategyOverride,
      typedBid: s.bid,
      sourceBid: facts.bid,
      sourceCurrency: facts.currency,
      destCurrency: s.currency,
    });
    // A bid/currency refusal is a fact of this source × this destination — settled here without a
    // LION call or a slot (rows bound elsewhere may still be fine).
    if ("refusal" in plan) return refuse(plan.refusal);
    let startingBid: number | undefined;
    let roasGoal: number | undefined;
    if (plan.human != null) {
      if (plan.kind === "roas") {
        // Percent-form / ×10-slip entries normalize to the real goal (30 → 0,30); the ambiguous
        // 10–20 band is refused like on every other wire.
        const goal = normalizeRoasGoal(plan.human);
        if (goal == null) return refuse("roas goal ambiguous — type the decimal goal (0,30 = 30%)");
        roasGoal = goal;
      } else {
        startingBid = Math.round(plan.human * 100);
      }
    }
    // Targeting override → LION's own wire (22.09): the ISO codes (or WORLD) and the { name, id }
    // locales of the picked profile. A locale id the profile does not list settles the row here.
    const targeting = s.override ? lionDuplicateTargeting(s.override, s.profileLocales) : {};
    if ("refusal" in targeting) return refuse(targeting.refusal);

    // Account launch slot (5 campaigns / 30 min per ad account) — claimed right before the submit;
    // released on a clean preflight rejection below, KEPT on ambiguous outcomes (the clone may
    // exist on LION).
    slotDoc = (
      await claimAcctSlot(acctKey(s.binds.account), {
        user,
        partner: "br",
        channel: "hs-dup",
        name: s.name || s.label || `Clone of ${s.campaignId}`,
        accountName: s.accountName || "",
      })
    ).documentId;
    const result = await lionDuplicate({
      profile_slug: s.binds.profile,
      account_id: s.binds.account,
      page_id: s.binds.page,
      pixel_id: s.binds.pixel,
      campaign_id: s.campaignId,
      starting_budget: Math.round(s.budget * 100),
      number_of_copies: 1, // single-copy shots → controllable pacing, gentler on the profile
      // The ONLY naming input LION's duplicate/ honours (partner docs 09-08).
      name_suffix: s.suffix,
      ...(plan.wireStrategy ? { bid_strategy: plan.wireStrategy } : {}),
      ...(startingBid != null ? { starting_bid: startingBid } : {}),
      ...(roasGoal != null ? { roas_goal: roasGoal } : {}),
      ...(plan.conversionEvent ? { conversion_event: plan.conversionEvent } : {}),
      ...targeting,
    });
    const lionTaskId = (result.task_ids ?? []).map(String).filter(Boolean)[0];
    if (!lionTaskId) {
      // Preflight rejection kills the whole family (object-story creatives, dead source…).
      // No clone was created → the account slot goes back to the pool.
      await releaseAcctSlot(slotDoc);
      return refuse(result.reason || `LION rejected the duplicate (${result.result ?? "no result"})`, { family: true });
    }
    // Read back LION's RESOLVED bidding (v2): a unit slip or a strategy LION quietly changed must
    // never reach an ACTIVE clone — a mismatch parks the clone PAUSED at finalize with the
    // difference named. Advisories (value/currency on ROAS) only log.
    const mismatch = dupBiddingMismatch({ strategy: plan.wireStrategy ?? (plan.human != null ? plan.strategy : undefined), roasGoal, startingBid }, result.bidding);
    if (result.warnings?.length) deps.log?.(`LION warnings for ${s.campaignId} (${lionTaskId}): ${result.warnings.join(" | ")}`);
    // started_at = the REAL submit moment (rows are stamped minutes earlier): the drawer's elapsed
    // timer then measures time ON LION, not time in our queue.
    rowWrite({ link: lionTaskId, started_at: deps.now(), stage: "queue", status: "running" });
    if (mismatch) {
      // Park the row on the BID GATE right now: /api/hs/activate refuses a bid-gate row and the
      // follow-up re-pauses the clone at completion instead of activating it (audit 09-09).
      rowWrite({
        status: "error",
        stage: "bid-gate",
        error: `${mismatch} — the clone will be left PAUSED; verify its bidding in LION / Ads Manager before activating`,
        finished_at: deps.now(),
      });
    }
    // Registry ledger, optimistically at submit: this copy re-creates every source ad on the bind
    // fanka (fire-safe; failed LION tasks reconcile on the box's next sweep).
    const srcAds = await sourceAdsCount(s.campaignId, now);
    await reportPagesUsed("br", [{ pageId: s.binds.page, delta: srcAds }]);
    return { outcome: "submitted", lionTaskId, biddingMismatch: mismatch };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (e instanceof AcctLimitedError) return refuse(msg, { accountFull: true, retryable: true });
    if (/acct_limit_unavailable/.test(msg)) return refuse(msg, { registryDown: true, retryable: true });
    // 4xx = LION-side semantic answer (page/pixel not in account data…) — deterministic for the
    // family (and no clone was created → the slot goes back); 5xx/transport may be transient AND
    // ambiguous, so only this shot is marked and the slot stays consumed.
    if (e instanceof LionError && e.status && e.status < 500) {
      await releaseAcctSlot(slotDoc);
      return refuse(`lion_duplicate_failed: ${msg}`, { family: true });
    }
    return refuse(`lion_duplicate_failed: ${msg}`);
  }
}
