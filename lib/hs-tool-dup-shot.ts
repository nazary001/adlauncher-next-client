// ONE TOOL duplicate — the body of /api/hs/tool-duplicate's per-shot follower, moved here verbatim
// so the durable queue can run it as a job (lib/launch-queue-runners hs.tooldup): one one-target
// DuplicateRequest submitted to the HS team's Ads Manager sessions service, followed for a FIRST
// LOOK only (the job's own window); a child job still working past it leaves the row with its job
// id, and the queue's tool.follow finishes the row from TOOL's own verdict (lib/tool-follow-core).

import { normalizeRoasGoal } from "@/lib/types";
import { dupBidPlan } from "@/lib/lion-dup-bid";
import { reportPagesUsed } from "@/lib/hs-pages";
import { AcctLimitedError, acctKey, claimAcctSlot, releaseAcctSlot } from "@/lib/acct-limit";
import { lionSetCampaignStatus } from "@/lib/lion";
import { hsTokenStartTime } from "@/lib/hs-token-launch";
import { buildToolDuplicate, runToolDuplicate, toolEnsureMark } from "@/lib/tool-launch";
import { toolDeps } from "@/lib/tool-run";
import type { ShotBinds } from "@/lib/hs-shot-binds";
import type { HsTokenShotDeps } from "@/lib/hs-token-dup-shot";

/** One validated TOOL-duplicate shot as the route resolved it (JSON — stored in the job). */
export type HsToolDupShot = {
  campaignId: string;
  budget: number;
  budgetRaw: string;
  bid: number | null;
  /** The SOURCE's strategy, sent by the board — dupBidPlan's fallback when scaling a typed bid. */
  bidStrategy: string;
  bidStrategyOverride: string;
  bidLabel: string;
  name: string;
  geo: string;
  label: string;
  binds: ShotBinds;
  accountName: string;
  pageName: string;
};

export type HsToolDupResult =
  | { ok: true }
  | { ok: false; pending: true; toolJobId: number; account: string }
  | { ok: false; pending?: false; error: string; accountFull: boolean; registryDown: boolean; retryable: boolean };

/** The first look at the child job — long enough for TOOL's usual build, short enough that a
 *  slow job never holds the submit lane: tool.follow takes it from here. */
export const TOOL_DUP_FIRST_LOOK_MS = 60_000;

export async function runHsToolDupShot(s: HsToolDupShot, deps: HsTokenShotDeps & { deadlineAt: number }): Promise<HsToolDupResult> {
  const { user, taskId, rowWrite } = deps;
  const fail = (error: string, o: { accountFull?: boolean; registryDown?: boolean; retryable?: boolean } = {}): HsToolDupResult => {
    rowWrite({ status: "error", error: error.slice(0, 1000), finished_at: deps.now() });
    return { ok: false, error, accountFull: o.accountFull === true, registryDown: o.registryDown === true, retryable: o.retryable === true };
  };

  // ---- bidding (LION duplicate-v2 rules, reused): the buyer's per-row switch wins, else the
  // source's; a switched capped/ROAS row needs a typed value, a lowest-cost row refuses a typed bid,
  // an unswitched row inherits (no bid/strategy on the wire → TOOL keeps the source's). ----
  const plan = dupBidPlan({ sourceStrategy: s.bidStrategy, override: s.bidStrategyOverride, typedBid: s.bid, sourceCurrency: "", destCurrency: "USD" });
  if ("refusal" in plan) return fail(plan.refusal);
  let bidValue: number | undefined;
  if (plan.human != null) {
    if (plan.kind === "roas") {
      // ROAS rides as the COEFFICIENT (1.2 = 120%), never ×10000 — TOOL scales internally.
      const goal = normalizeRoasGoal(plan.human);
      if (goal == null) return fail("roas goal ambiguous — type the decimal goal (0,30 = 30%)");
      bidValue = goal;
    } else {
      bidValue = plan.human; // cap / cost cap: USD amount as typed (NOT cents — TOOL money is USD).
    }
  }

  const target = acctKey(s.binds.account);
  const name = toolEnsureMark(s.name || `Clone of ${s.campaignId}`);
  const built = buildToolDuplicate({
    sourceCampaignId: s.campaignId,
    accountId: target,
    pageId: s.binds.page,
    pixelId: s.binds.pixel,
    name,
    budgetUsd: s.budget,
    ...(bidValue != null ? { bid: bidValue } : {}),
    ...(plan.wireStrategy ? { bidStrategy: plan.wireStrategy } : {}),
    status: "ACTIVE",
    startTime: hsTokenStartTime(),
  });
  if (!built.ok) return fail(built.error);

  let slot: { documentId: string } | null = null;
  try {
    rowWrite({ status: "running", stage: "queue", started_at: deps.now() });
    // Account launch slot (5/30min) — right before the submit; released below on a clean refusal
    // that created nothing.
    slot = await claimAcctSlot(target, { user, partner: "br", channel: "hs-tool-dup", name, accountName: s.accountName });

    const run = await runToolDuplicate(toolDeps, target, built.body, {
      idempotencyKey: taskId,
      deadlineAt: Math.min(deps.deadlineAt, deps.now() + TOOL_DUP_FIRST_LOOK_MS),
    });

    if (run.ok) {
      rowWrite({ status: "done", stage: "ads", campaign_id: run.campaignId, adset_id: run.adsetId, ad_id: String(run.adIds.length), finished_at: deps.now(), error: null });
      if (run.adIds.length) await reportPagesUsed("br", [{ pageId: s.binds.page, delta: run.adIds.length }]);
      return { ok: true };
    }

    if (run.pending) {
      // The first look ended while TOOL still works — keep the slot (a campaign may exist), name the
      // job on the row; the queue's tool.follow finishes it from TOOL's own verdict.
      const jobId = run.jobId ?? 0;
      rowWrite({
        status: "error",
        error: `TOOL is still finishing this clone past our window — the row updates from the server; verify in Ads Manager before re-firing (tool job #${jobId || "?"})`,
        ...(run.created?.campaignId ? { campaign_id: run.created.campaignId } : {}),
        ...(jobId ? { link: String(jobId) } : {}),
        finished_at: deps.now(),
      });
      if (jobId) return { ok: false, pending: true, toolJobId: jobId, account: target };
      return { ok: false, error: run.error, accountFull: false, registryDown: false, retryable: false };
    }

    // Clean failure. A partial that reports a created campaign id may be a LIVE clone — pause it
    // best-effort through LION before settling; release the slot ONLY when TOOL proved nothing landed.
    const created = run.created;
    const landed = created?.adIds ?? [];
    if (slot && !created?.campaignId && landed.length === 0) {
      await releaseAcctSlot(slot.documentId);
      slot = null;
    }
    let pauseNote = "";
    if (created?.campaignId) {
      const paused = await lionSetCampaignStatus(created.campaignId, "PAUSED").then(
        (r) => r.ok,
        () => false,
      );
      pauseNote = paused ? " — partial clone was PAUSED; verify it in Ads Manager before re-firing" : " — WARNING: partial clone may be LIVE (LION pause failed); pause it by hand in Ads Manager";
    }
    rowWrite({
      status: "error",
      error: `${run.error}${pauseNote}`,
      ...(created?.campaignId ? { campaign_id: created.campaignId } : {}),
      ...(created?.adsetIds[0] ? { adset_id: created.adsetIds[0] } : {}),
      ...(landed.length ? { ad_id: String(landed.length) } : {}),
      finished_at: deps.now(),
    });
    if (landed.length) await reportPagesUsed("br", [{ pageId: s.binds.page, delta: landed.length }]);
    return { ok: false, error: run.error, accountFull: false, registryDown: false, retryable: !created?.campaignId && landed.length === 0 };
  } catch (e) {
    const msg = e instanceof AcctLimitedError ? e.message : ((e as Error).message ?? String(e));
    const registryDown = !(e instanceof AcctLimitedError) && /acct_limit_unavailable/.test(msg);
    return fail(msg, { accountFull: e instanceof AcctLimitedError, registryDown, retryable: e instanceof AcctLimitedError || registryDown });
  }
}
