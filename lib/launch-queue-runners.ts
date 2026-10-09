// The RUNNERS of the launch queue — one per kind a wave ROUTE queues itself (09.10: every rail on the
// durable queue). Where the seven browser hand-off kinds are run by calling a route handler
// in-process (lib/launch-queue-run invokeHandler), these feed a rail's own pump core ONE shot — the
// very code the after() wave pumps ran over a whole wave — through an OBSERVED row writer, and turn
// the terminal row the core wrote into the job's verdict (lib/launch-queue-ops verdictFromRows).
// A refusal that is a fact of the SOURCE / the account's window settles the queued siblings without
// a submit (failSiblings) — the wave pumps' in-memory rules, made durable.
//
// The follow-up runners (hs.dup.follow, hs.jurar.follow, tt.follow, tool.follow) are the long tails
// AFTER a submit, in slices: each slice starts from the ROWS (a settled shot has a terminal row), so
// a slice can run again after a lost lease; between slices the job is deferred (Defer). They have no
// row of their own. Server-only.

import { withFbBudget } from "@/lib/fb-graph";
import { patchOpenTaskRow, patchTaskRowWhere, readTaskRowsBrief } from "@/lib/task-store";
import { findJobsByGroup } from "@/lib/launch-queue-store";
import { failSiblings, observeRows, verdictFromRows } from "@/lib/launch-queue-ops";
import {
  FOLLOW_DEFER_MS,
  FOLLOW_GAVE_UP_MSG,
  FOLLOW_SLICE_MS,
  SCOPE_PARTNER,
  type Defer,
  type JobOutcome,
  type JobRunner,
  type QueueJob,
  type RunnerCtx,
} from "@/lib/launch-queue-types";
import { pumpSnapWave } from "@/lib/snap-pump";
import type { SnapPumpShot } from "@/lib/snap-pump-core";
import { pumpGoogleWave, type GooglePumpShot } from "@/lib/google-pump";
import { pumpTiktokWave, type TiktokPumpShot } from "@/lib/tiktok-pump";
import { tiktokTaskOutcome } from "@/lib/tiktok-launch";
import { twTask } from "@/lib/tiktok-weapon";
import { runTtFollowSlice } from "@/lib/tt-follow-core";
import { runHsDupShot, type HsDupShot } from "@/lib/hs-dup-shot";
import { juroFamilyKey, runHsJuroShot, type HsJuroShot } from "@/lib/hs-jurar-shot";
import { runHsFollowSlice, type FollowMode, type FollowShot } from "@/lib/hs-follow-core";
import { runHsTokenDupShot, type HsTokenDupShot } from "@/lib/hs-token-dup-shot";
import { runHsTokenJuroShot, type HsTokenJuroShot } from "@/lib/hs-token-jurar-shot";
import { runHsToolDupShot, type HsToolDupShot } from "@/lib/hs-tool-dup-shot";
import { runToolFollowSlice } from "@/lib/tool-follow-core";
import { toolDeps } from "@/lib/tool-run";
import { toolFailedReason, toolJobOutcome } from "@/lib/tool-launch";
import { lionActivateWithRetry, lionCampaignAds, lionCreationStatus, lionSetCampaignStatus } from "@/lib/lion";
import { hsRenameCampaign } from "@/lib/hs-token-launch";
import { isTransientGraphError } from "@/lib/graph-retry";
import { lionRoasWall } from "@/lib/lion-dup-bid";
import { juroBlockingError } from "@/lib/juro";
import { acctKey } from "@/lib/acct-limit";
import { teamHas } from "@/lib/team";

const SRV = { srv: 1 } as const;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const hsFamily = (campaignId: string) => ({ "body.shot.campaignId": campaignId });
const hsAccount = (account: string) => ({ "body.shot.binds.account": account });

/** A follow-up's clean "nothing left to do" verdict (it owns no row — the row patch is empty). */
const followDone = (job: QueueJob): JobOutcome => ({
  status: "done",
  retryable: false,
  error: null,
  result: null,
  ambiguous: false,
  openRow: null,
  row: { ...SRV, partner: job.partner || SCOPE_PARTNER[job.scope] },
});

const again = (notBefore: number, body?: Record<string, unknown>): Defer => ({ defer: { notBefore, ...(body ? { body } : {}) } });

/** The end of a follow-up's slice: the kind's slice length, kept inside the job's own deadline. */
const sliceEnd = (ctx: RunnerCtx): number => Math.min(ctx.deadlineAt - 20_000, ctx.now() + FOLLOW_SLICE_MS);

// ---- Snapchat ----

const runSnap: JobRunner = async (job, ctx) => {
  const body = job.body as { shot: SnapPumpShot["shot"]; ctx: SnapPumpShot["ctx"] };
  const obs = observeRows(job);
  await pumpSnapWave(job.owner, [{ taskId: job.job_id, shot: body.shot, ctx: body.ctx }], ctx.deadlineAt, { write: obs.write, flush: obs.flush });
  await obs.flush();
  return verdictFromRows(job, obs.seen(), ctx.now());
};

// ---- Google ----

const runGoogle: JobRunner = async (job, ctx) => {
  const body = job.body as { mode: GooglePumpShot["mode"]; campaignId: string; wire: GooglePumpShot["body"]; rowKey: string };
  const obs = observeRows(job);
  await pumpGoogleWave(job.owner, [{ taskId: job.job_id, mode: body.mode, campaignId: body.campaignId, body: body.wire, rowKey: body.rowKey }], ctx.deadlineAt, {
    write: obs.write,
    flush: obs.flush,
    onRowRefusal: (rowKey, message) => void failSiblings(job, { "body.rowKey": rowKey }, { error: message, retryable: false }, ctx.log),
  });
  await obs.flush();
  return verdictFromRows(job, obs.seen(), ctx.now());
};

// ---- TikTok ----

const runTiktok: JobRunner = async (job, ctx) => {
  const body = job.body as { kind: TiktokPumpShot["kind"]; campaignId: string; wire: unknown; rowKey: string };
  const obs = observeRows(job);
  await pumpTiktokWave(job.owner, [{ taskId: job.job_id, kind: body.kind, campaignId: body.campaignId, body: body.wire, rowKey: body.rowKey }], ctx.deadlineAt, {
    write: obs.write,
    flush: obs.flush,
    onRowRefusal: (rowKey, message) => void failSiblings(job, { "body.rowKey": rowKey }, { error: message, retryable: false }, ctx.log),
    // The settle pass is the wave's tt.follow job; a shot only submits here.
    opts: { settleMs: 0 },
  });
  await obs.flush();
  return verdictFromRows(job, obs.seen(), ctx.now());
};

/** The settle pass of a TikTok wave: upgrade "done · Sent to LION" rows to what LION built. */
const runTiktokFollow: JobRunner = async (job, ctx) => {
  const body = job.body as { waveId: string; until: number };
  const submits = await findJobsByGroup(body.waveId, ["tt.launch", "tt.clone", "tt.juro"]);
  const sent = submits.filter((j) => j.status === "done" && j.result?.link);
  const rows = await readTaskRowsBrief(sent.map((j) => j.job_id));
  const pending = sent
    .filter((j) => {
      const r = rows.get(j.job_id);
      return r && r.stage === "sent" && r.link === j.result?.link;
    })
    .map((j) => ({ taskId: j.job_id, lionTaskId: String(j.result?.link) }));
  const res = await runTtFollowSlice(
    pending,
    {
      task: (id) => twTask(id, { attempts: 1, timeoutMs: 15_000 }),
      outcome: tiktokTaskOutcome,
      write: (taskId, lionTaskId, verdict) => patchTaskRowWhere(taskId, { stage: "sent", link: lionTaskId }, { ...verdict, ...SRV, partner: "tt" }),
      now: ctx.now,
      sleep,
      log: ctx.log,
    },
    { sliceEndAt: sliceEnd(ctx) },
  );
  const stillSubmitting = submits.some((j) => j.status === "queued" || j.status === "running");
  if (res.pending.length === 0 && !stillSubmitting) return followDone(job);
  if (ctx.now() >= body.until) {
    ctx.log(`tt follow ${body.waveId}: ${res.pending.length} task(s) still building at the cap — their rows stay "Sent to LION"`);
    return followDone(job);
  }
  return again(ctx.now() + FOLLOW_DEFER_MS);
};

// ---- HS LION duplicate / JURO ----

const runHsDup: JobRunner = async (job, ctx) => {
  const shot = (job.body as { shot: HsDupShot }).shot;
  const obs = observeRows(job);
  const r = await runHsDupShot(shot, { user: job.owner, taskId: job.job_id, rowWrite: (f) => obs.write(job.job_id, f), now: ctx.now, log: ctx.log });
  await obs.flush();
  const partner = job.partner || "br";
  const now = ctx.now();
  if (r.outcome === "submitted") {
    // Accepted by LION: the job is done, the row stays OPEN ("submitted") for the wave's follow-up
    // — unless LION's bidding read-back mismatched, where the submit parked it on the bid gate.
    const row = r.biddingMismatch
      ? { ...SRV, retry: 0, partner, link: r.lionTaskId, status: "error", stage: "bid-gate", error: `${r.biddingMismatch} — the clone will be left PAUSED; verify its bidding in LION / Ads Manager before activating`, finished_at: now }
      : { ...SRV, retry: 0, partner, status: "running", stage: "queue", link: r.lionTaskId, started_at: now, error: null };
    return { status: "done", retryable: false, error: null, result: { link: r.lionTaskId, ...(r.biddingMismatch ? { note: r.biddingMismatch } : {}) }, ambiguous: false, openRow: null, row };
  }
  if (r.family) await failSiblings(job, hsFamily(shot.campaignId), { error: r.error, retryable: false }, ctx.log);
  else if (r.accountFull) await failSiblings(job, hsAccount(shot.binds.account), { error: r.error, retryable: true }, ctx.log);
  else if (r.registryDown) await failSiblings(job, {}, { error: r.error, retryable: true }, ctx.log);
  return { status: "error", retryable: r.retryable, error: r.error, result: null, ambiguous: false, openRow: null, row: { ...SRV, retry: r.retryable ? 1 : 0, partner, status: "error", error: r.error.slice(0, 1000), finished_at: now } };
};

const runHsJurar: JobRunner = async (job, ctx) => {
  const shot = (job.body as { shot: HsJuroShot }).shot;
  const obs = observeRows(job);
  const r = await runHsJuroShot(shot, { user: job.owner, taskId: job.job_id, rowWrite: (f) => obs.write(job.job_id, f), now: ctx.now, log: ctx.log });
  await obs.flush();
  const partner = job.partner || "br";
  const now = ctx.now();
  if (r.outcome === "submitted") {
    return { status: "done", retryable: false, error: null, result: { link: r.lionTaskId }, ambiguous: false, openRow: null, row: { ...SRV, retry: 0, partner, status: "running", stage: "queue", link: r.lionTaskId, started_at: now, error: null } };
  }
  if (r.family) await failSiblings(job, { ...hsFamily(shot.campaignId), "body.shot.binds.profile": shot.binds.profile }, { error: r.error, retryable: false }, ctx.log);
  else if (r.accountFull) await failSiblings(job, hsAccount(shot.binds.account), { error: r.error, retryable: true }, ctx.log);
  else if (r.registryDown) await failSiblings(job, {}, { error: r.error, retryable: true }, ctx.log);
  void juroFamilyKey;
  return { status: "error", retryable: r.retryable, error: r.error, result: null, ambiguous: false, openRow: null, row: { ...SRV, retry: r.retryable ? 1 : 0, partner, status: "error", error: r.error.slice(0, 1000), finished_at: now } };
};

/** The follow-up of a LION duplicate / JURO wave: poll LION, rename, detect walls, activate the
 *  born-PAUSED clones, finish the rows — in slices, from the rows. */
const hsFollow =
  (mode: FollowMode): JobRunner =>
  async (job, ctx) => {
    const body = job.body as { waveId: string; until: number; renamed?: string[] };
    const kind = mode === "dup" ? "hs.dup" : "hs.jurar";
    const submits = await findJobsByGroup(body.waveId, [kind]);
    const submitted = submits.filter((j) => j.status === "done" && j.result?.link);
    const rows = await readTaskRowsBrief(submitted.map((j) => j.job_id));
    const renamed = new Set(body.renamed ?? []);
    const shots: FollowShot[] = [];
    for (const j of submitted) {
      const row = rows.get(j.job_id);
      if (!row) continue;
      const shot = (j.body as { shot: HsDupShot | HsJuroShot }).shot;
      const open = row.status === "queued" || row.status === "running";
      const gated = row.stage === "bid-gate" && !row.campaign_id;
      if (!open && !gated) continue; // settled (done / error) — or the gate already carries its clone id
      shots.push({
        taskId: j.job_id,
        lionTaskId: String(j.result?.link),
        cloneId: row.campaign_id || null,
        name: shot.name || "",
        account: shot.binds.account,
        biddingMismatch: mode === "dup" ? (j.result?.note ?? null) : null,
        campaignId: shot.campaignId,
        renamed: renamed.has(j.job_id),
      });
    }
    const res = await runHsFollowSlice(
      shots,
      {
        creationStatus: lionCreationStatus,
        campaignAds: lionCampaignAds,
        activate: lionActivateWithRetry,
        pause: (id) => lionSetCampaignStatus(id, "PAUSED").then((r) => r.ok),
        // A team without our FB tokens keeps LION's own name: nothing could sign the rename.
        rename: teamHas("channel:token") ? hsRenameCampaign : null,
        transientRenameError: isTransientGraphError,
        writeOpen: (taskId, fields) => patchOpenTaskRow(taskId, { ...fields, ...SRV, partner: "br" }),
        writeBidGate: (taskId, fields) => patchTaskRowWhere(taskId, { stage: "bid-gate" }, { ...fields, ...SRV, partner: "br" }),
        roasWall: lionRoasWall,
        blockingError: juroBlockingError,
        acctKey,
        now: ctx.now,
        sleep,
        log: ctx.log,
      },
      { sliceEndAt: sliceEnd(ctx), mode },
    );
    for (const id of res.renamed) renamed.add(id);
    const stillSubmitting = submits.some((j) => j.status === "queued" || j.status === "running");
    if (res.pending.length === 0 && !stillSubmitting) return followDone(job);
    if (ctx.now() >= body.until) {
      // Nobody is coming for these: the drawer's old 3 h sentence, with whatever ids are known.
      for (const s of res.pending) {
        await patchOpenTaskRow(s.taskId, { ...SRV, partner: "br", status: "interrupted", error: FOLLOW_GAVE_UP_MSG, ...(s.cloneId ? { campaign_id: s.cloneId } : {}), finished_at: ctx.now() }).catch(() => false);
      }
      return followDone(job);
    }
    return again(ctx.now() + FOLLOW_DEFER_MS, { ...body, renamed: [...renamed] });
  };

// ---- HS token duplicate / JURO ----

const runHsTokenDup: JobRunner = async (job, ctx) => {
  const shot = (job.body as { shot: HsTokenDupShot }).shot;
  const obs = observeRows(job);
  const r = await withFbBudget({ deadlineAt: ctx.deadlineAt, retries: 8 }, () =>
    runHsTokenDupShot(shot, { user: job.owner, taskId: job.job_id, rowWrite: (f) => obs.write(job.job_id, f), now: ctx.now, log: ctx.log }),
  );
  await obs.flush();
  if (!r.ok) {
    if (r.family) await failSiblings(job, hsFamily(shot.campaignId), { error: r.error, retryable: false }, ctx.log);
    else if (r.accountFull) await failSiblings(job, hsAccount(shot.binds.account), { error: r.error, retryable: true }, ctx.log);
    else if (r.registryDown) await failSiblings(job, {}, { error: r.error, retryable: true }, ctx.log);
  }
  const v = verdictFromRows(job, obs.seen(), ctx.now());
  if (!r.ok && v.status === "error") {
    v.retryable = r.retryable;
    v.row = { ...v.row, retry: r.retryable ? 1 : 0 };
  }
  return v;
};

const runHsTokenJurar: JobRunner = async (job, ctx) => {
  const shot = (job.body as { shot: HsTokenJuroShot }).shot;
  const obs = observeRows(job);
  const r = await withFbBudget({ deadlineAt: ctx.deadlineAt, retries: 8 }, () =>
    runHsTokenJuroShot(shot, { user: job.owner, taskId: job.job_id, rowWrite: (f) => obs.write(job.job_id, f), now: ctx.now, log: ctx.log }),
  );
  await obs.flush();
  if (!r.ok) {
    if (r.wallScope === "account") await failSiblings(job, hsAccount(shot.binds.account), { error: r.error, retryable: false }, ctx.log);
    else if (r.family) await failSiblings(job, hsFamily(shot.campaignId), { error: r.error, retryable: false }, ctx.log);
    else if (r.accountFull) await failSiblings(job, hsAccount(shot.binds.account), { error: r.error, retryable: true }, ctx.log);
    else if (r.registryDown) await failSiblings(job, {}, { error: r.error, retryable: true }, ctx.log);
  }
  const v = verdictFromRows(job, obs.seen(), ctx.now());
  if (!r.ok && v.status === "error") {
    v.retryable = r.retryable;
    v.row = { ...v.row, retry: r.retryable ? 1 : 0 };
  }
  return v;
};

// ---- HS TOOL duplicate ----

const runHsToolDup: JobRunner = async (job, ctx) => {
  const shot = (job.body as { shot: HsToolDupShot }).shot;
  const obs = observeRows(job);
  const r = await runHsToolDupShot(shot, { user: job.owner, taskId: job.job_id, rowWrite: (f) => obs.write(job.job_id, f), now: ctx.now, log: ctx.log, deadlineAt: ctx.deadlineAt });
  await obs.flush();
  const partner = job.partner || "br";
  if (!r.ok && "pending" in r && r.pending) {
    // TOOL is still working: the row names the job; the pump queues a tool.follow for it (the
    // tool_job_id in the result) — never retried, the Idempotency-Key aside.
    return {
      status: "error",
      retryable: false,
      error: `TOOL is still finishing this clone (tool job #${r.toolJobId})`,
      result: { tool_job_id: String(r.toolJobId), account: r.account },
      ambiguous: false,
      openRow: null,
      row: { ...SRV, retry: 0, partner },
    };
  }
  if (!r.ok) {
    if (r.accountFull) await failSiblings(job, hsAccount(shot.binds.account), { error: r.error, retryable: true }, ctx.log);
    else if (r.registryDown) await failSiblings(job, {}, { error: r.error, retryable: true }, ctx.log);
  }
  const v = verdictFromRows(job, obs.seen(), ctx.now());
  if (!r.ok && v.status === "error") {
    v.retryable = r.retryable;
    v.row = { ...v.row, retry: r.retryable ? 1 : 0 };
  }
  return v;
};

// ---- TOOL job follow (a launch / clone / duplicate TOOL was still building past its window) ----

const runToolFollow: JobRunner = async (job, ctx) => {
  const body = job.body as { taskId: string; toolJobId: number; account: string; until: number; hs: boolean };
  const jobId = Number(body.toolJobId);
  const partner = job.partner || SCOPE_PARTNER[job.scope];
  // The row that still names THIS TOOL job (the submit wrote the id into `link` or into the note).
  const where = { $or: [{ link: String(jobId) }, { error: { $regex: `tool job #${jobId}(\\D|$)` } }] };
  const res = await runToolFollowSlice(
    jobId,
    {
      getJob: async (id) => {
        const r = await toolDeps.getJob(id);
        return r.ok ? { ok: true, data: r.data } : { ok: false, status: r.status };
      },
      outcome: toolJobOutcome,
      failedReason: async (id) => {
        const ev = await toolDeps.jobEvents(id);
        return ev.ok ? toolFailedReason(ev.data) : "";
      },
      now: ctx.now,
      sleep,
      log: ctx.log,
    },
    { sliceEndAt: sliceEnd(ctx) },
  );
  const now = ctx.now();
  if (res.state === "done") {
    await patchTaskRowWhere(body.taskId, where, {
      ...SRV,
      partner,
      status: "done",
      stage: body.hs ? "ads" : "ad",
      campaign_id: res.campaignId,
      adset_id: res.adsetId,
      // HS rows carry the ad COUNT in ad_id; the Graph partners' rows the first ad's id.
      ad_id: body.hs ? String(res.adIds.length) : (res.adIds[0] ?? null),
      error: null,
      finished_at: now,
    }).catch((e) => ctx.log(`tool follow ${jobId}: row ${body.taskId} not updated: ${String(e)}`));
    ctx.log(`tool follow ${jobId}: done — campaign ${res.campaignId}`);
    return followDone(job);
  }
  if (res.state === "failed") {
    const created = res.created;
    await patchTaskRowWhere(body.taskId, where, {
      ...SRV,
      partner,
      status: "error",
      error: `${res.error} — TOOL job #${jobId} ended after our window; its claims were kept, verify in Ads Manager`.slice(0, 1000),
      ...(created?.campaignId ? { campaign_id: created.campaignId } : {}),
      ...(created?.adsetIds[0] ? { adset_id: created.adsetIds[0] } : {}),
      finished_at: now,
    }).catch((e) => ctx.log(`tool follow ${jobId}: row ${body.taskId} not updated: ${String(e)}`));
    return followDone(job);
  }
  if (now >= body.until) {
    await patchTaskRowWhere(body.taskId, where, { ...SRV, partner, error: `TOOL job #${jobId} still not finished after 40 min — check Ads Manager sessions → Jobs`, finished_at: now }).catch(() => false);
    return followDone(job);
  }
  return again(now + FOLLOW_DEFER_MS);
};

export const RUNNERS: Partial<Record<QueueJob["kind"], JobRunner>> = {
  "sn.launch": runSnap,
  "gg.launch": runGoogle,
  "gg.clone": runGoogle,
  "gg.juro": runGoogle,
  "tt.launch": runTiktok,
  "tt.clone": runTiktok,
  "tt.juro": runTiktok,
  "tt.follow": runTiktokFollow,
  "hs.dup": runHsDup,
  "hs.jurar": runHsJurar,
  "hs.dup.follow": hsFollow("dup"),
  "hs.jurar.follow": hsFollow("jurar"),
  "hs.tokendup": runHsTokenDup,
  "hs.tokenjurar": runHsTokenJurar,
  "hs.tooldup": runHsToolDup,
  "tool.follow": runToolFollow,
};
