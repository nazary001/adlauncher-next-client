// The wiring of the server launch queue: it binds the pure pump (lib/launch-queue.ts runLane) and
// the pure verdict (lib/launch-queue-types.ts outcomeOf) to the REAL store (lib/launch-queue-store),
// the REAL launch handlers (the seven routes the browser used to call), and the real clock. Until
// now the browser orchestrated every MO/AIF/AV launch and clone and every HS launch — its task
// manager uploaded the creatives, called the route and read its NDJSON stream; close the tab and the
// wave died (components/task-manager.tsx, components/hs-task-manager.tsx). Now the tab only HANDS the
// wave over and THIS runs it: a lane pump calls the very same route handlers IN-PROCESS, as the job's
// owner, and reads the very same replies. Server-only (it imports the route modules and the store).
//
// Two rules everything here serves (see lib/launch-queue-types.ts):
//   1. A job runs AT MOST ONCE per (re)queue — claimNextJob is the atomic gate; a lost lease is
//      reaped as interrupted, never re-run.
//   2. The launch routes are untouched: every claim, gate, budget, pause-on-failure and TOOL belt
//      stays byte-for-byte where it is — the pump only feeds them a request and reads the reply.

import { SESSION_COOKIE, type Session, signSession } from "@/lib/session";
import { accountAllowedFor } from "@/lib/acct-assignments";
import { creativeKeyOf, isContentKey } from "@/lib/creative-url";
import { isTokenAccount, withFbBudget } from "@/lib/fb-graph";
import { uploadVideo } from "@/lib/fb-media";
import { resolveMoSigner } from "@/lib/mo-soc";
import { aifRail } from "@/lib/aif-launch";
import { partnerConfig, type PartnerId } from "@/lib/partners";
import {
  SCOPE_PARTNER,
  type EnqueueInput,
  type JobOutcome,
  type QueueJob,
  type QueueScope,
  type BuildBeacon,
  JOB_SCHEMA_VERSION,
  PUMP_BUDGET_MS,
  ROW_STALE_MS,
  canceledRow,
  handlerBody,
  isNewerBuild,
  isSuperseded,
  laneOf,
  outcomeOf,
  queuedRow,
  reapedRow,
  runningRow,
  worstCaseMs,
  type RunReply,
} from "@/lib/launch-queue-types";
import { type LaneDeps, reconcileOpenRows, runLane } from "@/lib/launch-queue";
import {
  type NewJob,
  acquireLane as storeAcquireLane,
  beatJob,
  cancelQueuedJobs,
  claimNextJob,
  existingJobIds,
  extendLane as storeExtendLane,
  findJobsBrief,
  finishJob,
  insertJob,
  lanesNeedingPump,
  markJobBegan,
  peekQueued,
  readBeacon,
  reapExpiredJobs,
  releaseLane as storeReleaseLane,
  requeueJobs,
  unclaimJob,
  writeBeacon,
} from "@/lib/launch-queue-store";
import { patchOpenTaskRow, staleOpenServerRows, storeConfigured, upsertTaskRow } from "@/lib/task-store";
import { computeInternalToken, computeSelfOrigin, mayAnnounceBuild, parseReplyLines, pumpBudgetMs, queueBuild, timingEqual } from "@/lib/launch-queue-wire";
import { POST as launchPOST } from "@/app/api/launch/route";
import { POST as aifLaunchPOST } from "@/app/api/aif/launch/route";
import { POST as avLaunchPOST } from "@/app/api/av/launch/route";
import { POST as clonePOST } from "@/app/api/clone/run/route";
import { POST as hsLaunchPOST } from "@/app/api/hs/launch/route";
import { POST as hsTokenPOST } from "@/app/api/hs/token-launch/route";
import { POST as hsToolPOST } from "@/app/api/hs/tool-launch/route";

// Re-export the pure helpers the routes build on, so a route imports from one module.
export { computeSelfOrigin } from "@/lib/launch-queue-wire";
import { laneNameValid as wireLaneNameValid } from "@/lib/launch-queue-wire";
export const laneNameValid = wireLaneNameValid;

const log = (msg: string): void => console.log(`[queue] ${msg}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** How long a pump that found its lane busy waits before its one second look (see pumpLane). */
const BUSY_RECHECK_MS = 2_500;
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---- running one job: feed the handler, read its reply, turn it into a verdict ----

/** kind → the exported route handler the browser used to POST to (spec §4.1). NextResponse (hs.lion)
 *  is a Response subclass, so a Promise<NextResponse> handler fits Promise<Response>. */
const HANDLERS: Record<QueueJob["kind"], (req: Request) => Promise<Response>> = {
  "mo.launch": launchPOST,
  "aif.launch": aifLaunchPOST,
  "av.launch": avLaunchPOST,
  "fb.clone": clonePOST,
  "hs.lion": hsLaunchPOST,
  "hs.token": hsTokenPOST,
  "hs.tool": hsToolPOST,
};

/** The reply read must never hold the lane forever: bound it to the handler's own worst case plus a
 *  wide margin. On the bound a wedged stream is treated as "no verdict" (ambiguous, never retried). */
const replyBudgetMs = (kind: QueueJob["kind"]): number => worstCaseMs(kind) + 30_000;

/** Read a single-JSON reply (a pre-run rejection, or the HS LION one-shot answer), bounded. */
async function readJsonBounded(res: Response, budgetMs: number): Promise<Record<string, unknown> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
  });
  const parse = res
    .json()
    .then((v) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null))
    .catch(() => null);
  try {
    return await Promise.race([parse, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Read an NDJSON reply line by line (the exact loop the browser ran), bounded — on the bound we
 *  cancel the reader and parse whatever arrived (no final event ⇒ "no verdict"). Cancelling the
 *  CONSUMER never cancels the handler's own work: it keeps running under its own budget and settles
 *  its own row, exactly as it did when a browser tab disconnected mid-stream. */
async function readStreamBounded(
  res: Response,
  kind: QueueJob["kind"],
  budgetMs: number,
): Promise<{ lastStage: string | null; final: Record<string, unknown> | null }> {
  const body = res.body;
  if (!body) return { lastStage: null, final: null };
  const reader = body.getReader();
  const dec = new TextDecoder();
  const lines: string[] = [];
  let buf = "";
  const timer = setTimeout(() => void reader.cancel().catch(() => {}), budgetMs);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) lines.push(line);
      }
    }
    if (buf.trim()) lines.push(buf.trim());
  } catch {
    /* reader cancelled on the bound, or a stream error — parse what we have */
  } finally {
    clearTimeout(timer);
  }
  return parseReplyLines(lines, kind);
}

/** Call one handler in-process as the job's owner and read its reply into a RunReply. Never throws:
 *  a handler that throws before answering becomes RunReply.thrown (outcomeOf settles it). */
async function invokeHandler(job: QueueJob): Promise<RunReply> {
  // A short-lived cookie minted for the owner — the handlers (excluded from the proxy) authenticate
  // themselves from it, so the whole run is signed as exactly this user (spec §4.1).
  const cookie = `${SESSION_COOKIE}=${signSession({ sub: job.sub, username: job.owner, role: job.role ?? null }, 900)}`;
  let req: Request;
  try {
    req = new Request("http://queue.internal/api/launch-queue/run", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(handlerBody(job)),
    });
  } catch (e) {
    return { thrown: errMsg(e), httpStatus: 0, streamed: false, final: null, lastStage: null };
  }
  let res: Response;
  try {
    res = await HANDLERS[job.kind](req);
  } catch (e) {
    return { thrown: errMsg(e), httpStatus: 0, streamed: false, final: null, lastStage: null };
  }
  const httpStatus = res.status;
  const streamed = (res.headers.get("content-type") ?? "").toLowerCase().includes("ndjson");
  const budgetMs = replyBudgetMs(job.kind);
  if (!streamed) {
    const final = await readJsonBounded(res, budgetMs);
    return { httpStatus, streamed: false, final, lastStage: null };
  }
  const { lastStage, final } = await readStreamBounded(res, job.kind, budgetMs);
  return { httpStatus, streamed: true, final, lastStage };
}

/** Run a job to its verdict. Must never throw (runLane treats a throw as a crash). */
export async function runJob(job: QueueJob): Promise<JobOutcome> {
  const reply = await invokeHandler(job);
  return outcomeOf(job, reply, Date.now());
}

// ---- head start: register a soon-to-run job's videos so Meta processes them early (spec §4.6) ----

const PREWARM_BUDGET_MS = 120_000;

/** The content-addressed video URLs of a launch body (images / covers never prewarm — a video is the
 *  only asset with a processing wait; cover is an image). Mirrors the route's media parsing. */
function prewarmVideoUrls(body: Record<string, unknown>): string[] {
  const out: string[] = [];
  const medias = Array.isArray(body.medias) ? body.medias : [];
  if (medias.length > 0) {
    for (const m of medias) {
      if (m && typeof m === "object" && (m as { kind?: unknown }).kind !== "image") {
        const u = (m as { url?: unknown }).url;
        if (typeof u === "string" && u) out.push(u);
      }
    }
  } else {
    const kind = body.mediaKind === "image" ? "image" : "video";
    const u = typeof body.mediaUrl === "string" ? body.mediaUrl : typeof body.videoUrl === "string" ? body.videoUrl : "";
    if (kind !== "image" && u) out.push(u);
  }
  // Only OUR bucket objects with a content-addressed key are safe to pre-register + cache by account.
  return out.filter((u) => {
    const key = creativeKeyOf(u);
    return key !== null && isContentKey(key);
  });
}

/** Resolve the rail's signer + build account exactly the way the route does (MO / AIF only, never
 *  `via:"tool"`). Null = skip (unassigned signer, unknown account, not the token's) — a head start
 *  never fails or delays a job. */
async function prewarmRail(
  job: QueueJob,
): Promise<{ account: string; token: string; visible: (a: string) => Promise<boolean> } | null> {
  const body = job.body as Record<string, unknown>;
  const campaign = (body.campaign ?? {}) as Record<string, unknown>;
  if (job.kind === "mo.launch") {
    const partner = partnerConfig(String(body.partnerId ?? "in") as PartnerId);
    const account = (partner.accountsFromToken ? String(campaign.account ?? "") : String(partner.lockedAccount?.id ?? ""))
      .trim()
      .replace(/^act_/, "");
    const signerRes = await resolveMoSigner("launch");
    if (!signerRes.ok) return null;
    const cat = signerRes.signer.cat;
    return { account, token: signerRes.signer.token, visible: (a) => isTokenAccount(a, cat) };
  }
  // aif.launch
  const account = String(campaign.account ?? "").trim().replace(/^act_/, "");
  const railRes = await aifRail("launch");
  if (!railRes.ok) return null;
  return { account, token: railRes.rail.token, visible: (a) => railRes.rail.isTokenAccount(a) };
}

async function prewarmVideos(job: QueueJob): Promise<void> {
  const urls = prewarmVideoUrls(job.body as Record<string, unknown>);
  if (urls.length === 0) return;
  const rail = await prewarmRail(job);
  if (!rail || !/^\d{5,}$/.test(rail.account)) return;
  // The cheap gates the route runs before any write — never register into an account this owner / this
  // token may not use.
  const sess: Session = { sub: job.sub, username: job.owner, role: job.role ?? null, exp: Math.floor(Date.now() / 1000) + 900 };
  if (!(await accountAllowedFor(sess, rail.account))) return;
  if (!(await rail.visible(rail.account))) return;
  const name = job.row?.name || "launch";
  // uploadVideo is cache-aware for content-addressed creatives (lib/fb-media, package D): the job and
  // this head start share ONE registration per (account, key), and the id is reused when the job runs.
  await withFbBudget({ deadlineAt: Date.now() + PREWARM_BUDGET_MS, retries: 2 }, async () => {
    for (const url of urls) await uploadVideo(rail.account, url, name, rail.token).catch(() => {});
  });
}

/** Best-effort head start, at most once per pump per job (the Set is owned by the pump invocation).
 *  Fire-and-forget: it can never throw or delay the job that peeked it. */
export function prewarm(job: QueueJob, seen?: Set<string>): void {
  try {
    if (job.kind !== "mo.launch" && job.kind !== "aif.launch") return;
    if ((job.body as { via?: unknown }).via === "tool") return;
    if (seen) {
      if (seen.has(job.job_id)) return;
      seen.add(job.job_id);
    }
    void prewarmVideos(job).catch((e) => log(`prewarm ${job.job_id} failed: ${errMsg(e)}`));
  } catch (e) {
    log(`prewarm ${job.job_id} error: ${errMsg(e)}`);
  }
}

// ---- persisting a verdict (job document + task row) ----

async function settleJob(job: QueueJob, outcome: JobOutcome, holder: string): Promise<void> {
  const now = Date.now();
  // The job document first: finishJob flips running → done/error under our lease (false = the sweeper
  // already closed it — then nothing is written, and the row is handled below either way). A store
  // failure HERE must not skip the row: the row is what the buyer sees, and a job left "running" is
  // closed by the sweeper as interrupted (never re-run) once its lease runs out.
  const ours = await finishJob(job.job_id, holder, {
    status: outcome.status,
    retryable: outcome.retryable,
    error: outcome.error,
    result: outcome.result,
    finished_at: now,
  }).catch((e) => {
    log(`finishJob ${job.job_id} failed: ${errMsg(e)}`);
    return false;
  });
  // The terminal row ALWAYS (the handler already wrote its own; this repeats/completes it — the same
  // write the browser's task manager added on top). srv:1 rides via the patch. One exception to the
  // patch as computed: when the job document was NOT ours to finish (the sweeper closed it under a
  // run that was still alive, or the write failed) the document says "not retryable" — the row must
  // say the same, or it would show a Retry button the server then refuses (review find 08.10).
  await upsertTaskRow(job.owner, job.job_id, ours ? outcome.row : { ...outcome.row, retry: 0 });
  // An AMBIGUOUS verdict's openRow is written only OVER a still-open row (queued/running) — never over
  // a done/error/interrupted the handler itself already wrote. One atomic conditional update (no read
  // to go wrong), tried a few times: the job document is terminal by now, so nothing would ever come
  // back for a row left "running" here.
  if (outcome.ambiguous && outcome.openRow) await writeOverOpenRow(job.job_id, outcome.openRow);
}

/** patchOpenTaskRow with a short retry — the last word on a row whose job is already closed. */
async function writeOverOpenRow(taskId: string, row: Record<string, unknown>): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await patchOpenTaskRow(taskId, row);
      return;
    } catch (e) {
      if (attempt >= 3) {
        log(`row ${taskId} could not be closed: ${errMsg(e)}`);
        return;
      }
      await sleep(800 * attempt);
    }
  }
}

// ---- the lane pump (binds runLane to the real store, handlers and clock) ----

/** Work one lane as far as this invocation's budget allows. Never rejects (everything is caught and
 *  logged): a lane that trips here is restarted by the cron within a minute. The budget is anchored at
 *  `startedAt` (the route captured it FIRST, before after()) so runLane's fit check uses the real
 *  invocation deadline, not the moment the after() callback happened to start. */
export async function pumpLane(lane: string, opts: { origin: string; startedAt: number }): Promise<void> {
  const holder = crypto.randomUUID();
  const prewarmed = new Set<string>();
  const build = thisBuild();
  // The beacon is re-read at most every BEACON_RECHECK_MS — one small read per job at worst.
  let beacon: BuildBeacon | null = null;
  let beaconReadAt = 0;
  let confirmed = false;
  const deps: LaneDeps = {
    now: () => Date.now(),
    deadlineAt: opts.startedAt + pumpBudgetMs(process.env, PUMP_BUDGET_MS),
    acquireLane: () => storeAcquireLane(lane, holder, Date.now()),
    extendLane: () => storeExtendLane(lane, holder, Date.now()),
    releaseLane: () => storeReleaseLane(lane, holder),
    claim: () => claimNextJob(lane, holder, Date.now()),
    unclaim: (job) => unclaimJob(job.job_id, holder),
    begin: (job) => markJobBegan(job.job_id, holder, Date.now()),
    peek: (n) => peekQueued(lane, n),
    beat: (job) => beatJob(job.job_id, holder, Date.now()),
    start: async (job) => {
      await upsertTaskRow(job.owner, job.job_id, runningRow(job, Date.now()));
    },
    run: (job) => runJob(job),
    settle: (job, outcome) => settleJob(job, outcome, holder),
    prewarm: (job) => prewarm(job, prewarmed),
    kick: async () => void (await kickLane(opts.origin, lane)),
    build,
    superseded: async () => {
      if (!build) return false;
      const now = Date.now();
      if (now - beaconReadAt >= BEACON_RECHECK_MS) {
        beaconReadAt = now;
        try {
          beacon = await readBeacon();
        } catch {
          /* a store blip: keep the last picture — yielding is an optimisation, never a duty */
        }
        // The beacon only RAISES the question. A pump steps aside only when the production address
        // itself answers with a newer build — i.e. when the kick it is about to send will land on
        // code that takes the lane, not on this same build (the beacon is a shared document; it
        // must never be able to make production pumps bounce a lane between themselves).
        confirmed = isSuperseded(beacon, build, now) && isNewerBuild(await liveBuild(opts.origin), build);
      }
      return confirmed;
    },
    sleep,
    every: (ms, fn) => {
      const iv = setInterval(fn, ms);
      return () => clearInterval(iv);
    },
    random: Math.random,
    log,
  };
  try {
    let exit = await runLane(deps);
    // "busy" right after a hand-off is usually the lane's OWN pump in its last moments: it saw the
    // lane empty just before these jobs landed and is about to release. One short second look closes
    // that window at once instead of leaving the new jobs to the every-minute sweep. (A pump that is
    // genuinely mid-wave stays busy — it will pick the new jobs up itself.)
    if (exit === "busy") {
      await sleep(BUSY_RECHECK_MS);
      exit = await runLane(deps);
    }
    log(`lane ${lane} → ${exit}`);
  } catch (e) {
    // runLane is designed never to reject, but acquireLane() is called before its own try — so a store
    // failure there would surface here. Swallow + log: the cron restarts the lane.
    log(`pumpLane ${lane} crashed: ${errMsg(e)}`);
  }
}

// ---- the hand-off (enqueue), retry, cancel, sweep ----

export type AcceptResult =
  | { ok: true; accepted: string[]; failed: Array<{ taskId: string; error: string }>; lanes: string[] }
  | { ok: false; error: string; status: number };

/** The row a job gets when the queue could not accept it (its insert failed). srv:1 + retry:0 — the
 *  buyer re-runs the hand-off from the launch screen (a re-send re-stamps the same task id). */
function notAcceptedRow(partner: string, now: number): Record<string, unknown> {
  return {
    srv: 1,
    retry: 0,
    partner,
    status: "error",
    stage: "queue",
    error: "Not accepted by the queue — it may be briefly unavailable; press Retry on the launch screen",
    finished_at: now,
  };
}

/**
 * Accept a hand-off (spec §4.2 #7 + #8): check which ids already exist (NOT re-stamped — the
 * idempotency key is the task id), then per new job stamp the queued row BEFORE inserting the job
 * ("rows first", every wave route). A "duplicate" insert = we lost a race with the SAME request = the
 * job is already queued = accepted. A job whose insert fails gets an error row and is listed failed.
 * Fail closed: the store being unconfigured / unreachable refuses the whole hand-off (503) — nothing
 * half-accepted.
 */
export async function acceptEnqueue(session: Session, input: EnqueueInput, origin: string): Promise<AcceptResult> {
  void origin; // the route schedules the pump; acceptEnqueue only reports the lanes to pump
  if (!storeConfigured()) return { ok: false, error: "queue_store_not_configured", status: 503 };
  const scope = input.scope;
  const owner = String(session.username);
  const role = session.role ?? null;
  const sub = session.sub;
  const partner = SCOPE_PARTNER[scope];
  const lane = laneOf(scope, owner);
  const now = Date.now();

  let existing: Set<string>;
  try {
    existing = await existingJobIds(input.jobs.map((j) => j.taskId));
  } catch (e) {
    return { ok: false, error: `queue_store_unavailable: ${errMsg(e)}`, status: 503 };
  }

  const accepted: string[] = [];
  const failed: Array<{ taskId: string; error: string }> = [];
  for (let i = 0; i < input.jobs.length; i++) {
    const j = input.jobs[i];
    if (existing.has(j.taskId)) {
      // Already known (a re-sent request, or an earlier job of this same batch): report accepted,
      // never re-stamp the row of a job that may already be running or done (spec §4.2 #5).
      accepted.push(j.taskId);
      continue;
    }
    // Stamp the queued row BEFORE the insert — the team sees it even if this function dies now, and a
    // crash before the insert re-stamps the SAME task id on the re-send (idempotent). A job is only
    // accepted WITH its row: a stamp the store refused (a task id that is another buyer's row, or a
    // store blip) fails that job here — a job without a row would run invisibly.
    const stamped = await upsertTaskRow(owner, j.taskId, queuedRow({ kind: j.kind, partner, row: j.row, queued_at: now }));
    if (!stamped.ok) {
      failed.push({ taskId: j.taskId, error: stamped.reason === "forbidden" ? "task_id_in_use" : `not_accepted: ${stamped.detail ?? stamped.reason}` });
      continue;
    }
    const job: NewJob = {
      v: JOB_SCHEMA_VERSION,
      build: thisBuild() || null,
      job_id: j.taskId,
      owner,
      role,
      sub,
      scope,
      kind: j.kind,
      lane,
      partner,
      account: j.account,
      body: j.body,
      row: j.row,
      seq: now * 1000 + i,
      queued_at: now,
    };
    try {
      await insertJob(job); // "inserted" | "duplicate" — a duplicate lost a race with the same request = accepted
      accepted.push(j.taskId);
    } catch (e) {
      await upsertTaskRow(owner, j.taskId, notAcceptedRow(partner, now));
      failed.push({ taskId: j.taskId, error: `not_accepted: ${errMsg(e)}` });
    }
  }
  return { ok: true, accepted, failed, lanes: accepted.length > 0 ? [lane] : [] };
}

/** Re-queue the owner's retryable jobs and write each row back to queued (keeping the fresh queued_at
 *  the store stamped). Returns the ids actually re-queued and the lanes to pump. */
export async function retryJobs(session: Session, taskIds: string[]): Promise<{ taskIds: string[]; lanes: string[] }> {
  const owner = String(session.username);
  const jobs = await requeueJobs(owner, taskIds, Date.now());
  for (const job of jobs) {
    await upsertTaskRow(owner, job.job_id, queuedRow({ kind: job.kind, partner: job.partner, row: job.row, queued_at: job.queued_at }));
  }
  return { taskIds: jobs.map((j) => j.job_id), lanes: [...new Set(jobs.map((j) => j.lane))] };
}

/** Cancel the owner's queued jobs (listed ids, or every queued job of a scope) and mark each row
 *  canceled. Returns the ids actually canceled and the lanes they belonged to. */
export async function cancelJobs(
  session: Session,
  sel: { jobIds?: string[]; scope?: QueueScope },
): Promise<{ taskIds: string[]; lanes: string[] }> {
  const owner = String(session.username);
  const now = Date.now();
  const jobs = await cancelQueuedJobs(owner, sel, now);
  for (const job of jobs) {
    await upsertTaskRow(owner, job.job_id, canceledRow({ partner: job.partner }, now));
  }
  return { taskIds: jobs.map((j) => j.job_id), lanes: [...new Set(jobs.map((j) => j.lane))] };
}

/** The cron's sweep: reap dead leases (write the interrupted row only OVER a still-open row), kick
 *  every lane with queued work and no live lock (in parallel, at most 20), then close the rows that
 *  stayed open although their job is not. Never throws. */
export async function sweepQueue(
  origin: string,
  opts: { announce?: boolean } = {},
): Promise<{ reaped: number; requeued: number; rowsClosed: number; kicked: number; lanesQueued: number; unkicked: string[] }> {
  const now = Date.now();
  // Tell every pump which build is being swept (= which build is production right now): pumps of an
  // OLDER build then hand their lanes over, so an update takes the queue over within one job. Only a
  // real cron tick of the production deployment announces (the route decides) — never a preview.
  if (opts.announce) {
    const build = thisBuild();
    if (build && mayAnnounceBuild(process.env)) {
      try {
        await writeBeacon(build, now);
      } catch (e) {
        log(`beacon write failed: ${errMsg(e)}`);
      }
    }
  }
  let reaped = 0;
  let requeued = 0;
  try {
    const swept = await reapExpiredJobs(now);
    // Jobs that were claimed but never begun simply went back to the queue (their rows are still
    // "queued"; the lane scan below restarts their lane) — nothing to write.
    requeued = swept.requeued.length;
    if (requeued) log(`re-queued ${requeued} claimed-but-never-run job(s): ${swept.requeued.map((j) => j.job_id).join(", ")}`);
    for (const job of swept.interrupted) {
      reaped++;
      await writeOverOpenRow(job.job_id, reapedRow({ kind: job.kind, partner: job.partner }, now));
    }
  } catch (e) {
    log(`reapExpiredJobs failed: ${errMsg(e)}`);
  }
  let lanes: string[] = [];
  try {
    lanes = await lanesNeedingPump(now);
  } catch (e) {
    log(`lanesNeedingPump failed: ${errMsg(e)}`);
  }
  const toKick = lanes.slice(0, 20);
  const answers = await Promise.all(toKick.map((lane) => kickLane(origin, lane)));
  // A lane whose kick was NOT accepted (the deployment could not reach itself over HTTP) is handed
  // back to the caller: the cron route pumps it in its own invocation, so a wave never depends on the
  // self-call working. `kicked` counts only the kicks a pump really accepted.
  const unkicked = toKick.filter((_, i) => !answers[i]);
  // Last, the rows: a server-owned row that stayed open although its job is not gets the row its job
  // calls for (lib/launch-queue.ts reconcileOpenRows). After the kicks — a slow read here must never
  // hold a lane back.
  let rowsClosed = 0;
  try {
    rowsClosed = await reconcileOpenRows(
      {
        staleRows: () => staleOpenServerRows(now, ROW_STALE_MS, RECONCILE_SCAN),
        jobs: findJobsBrief,
        patchOpen: patchOpenTaskRow,
        max: RECONCILE_MAX,
        log,
      },
      now,
    );
  } catch (e) {
    log(`row check failed: ${errMsg(e)}`);
  }
  return { reaped, requeued, rowsClosed, kicked: toKick.length - unkicked.length, lanesQueued: lanes.length, unkicked };
}

// ---- rows that outlived their job (the check itself: lib/launch-queue.ts reconcileOpenRows) ----

/** How many stale open rows one sweep looks at (their jobs are read in ONE query), and how many it
 *  may close. A long wave that is legitimately queued is only looked at — it costs no writes. */
const RECONCILE_SCAN = 1000;
const RECONCILE_MAX = 40;

// ---- which build is this ----

/** How often a pump re-reads the beacon. */
const BEACON_RECHECK_MS = 15_000;

/** This deployment's build stamp (ISO build time). The env read is LITERAL on purpose: next.config
 *  `env` values are build-time replacements, a dynamic lookup would find nothing at runtime. */
export function thisBuild(): string {
  return queueBuild(process.env.NEXT_PUBLIC_BUILD_STAMP, process.env);
}

/** Which build answers at `origin` right now (GET /api/launch-queue/pump) — "" when it cannot be
 *  asked (no origin, refused, slow): then nobody yields. Never throws. */
async function liveBuild(origin: string): Promise<string> {
  if (!origin) return "";
  try {
    const res = await fetch(`${origin.replace(/\/+$/, "")}/api/launch-queue/pump`, {
      headers: { authorization: `Bearer ${internalToken()}` },
      signal: AbortSignal.timeout(5_000),
      redirect: "manual",
      cache: "no-store",
    });
    if (!res.ok) return "";
    const body = (await res.json().catch(() => null)) as { build?: unknown } | null;
    return typeof body?.build === "string" ? body.build : "";
  } catch {
    return "";
  }
}

// ---- the continuation kick + internal auth ----

/** Ask a fresh invocation to continue (or start) a lane. 10 s bound, never throws. Resolves true only
 *  when the pump route ACCEPTED the kick (2xx) — a refusal (a protection page, a proxy in front of
 *  the domain, a wrong origin) is logged with its status instead of passing for a kick: the cron then
 *  pumps the lane itself within a minute. */
export async function kickLane(origin: string, lane: string): Promise<boolean> {
  if (!origin) {
    log(`kickLane ${lane} skipped: no self origin (set ADL_SELF_ORIGIN)`);
    return false;
  }
  try {
    const url = `${origin.replace(/\/+$/, "")}/api/launch-queue/pump`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${internalToken()}` },
      body: JSON.stringify({ lane }),
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });
    if (res.ok) return true;
    log(`kickLane ${lane} refused: HTTP ${res.status} from ${new URL(url).host}`);
    return false;
  } catch (e) {
    log(`kickLane ${lane} failed: ${errMsg(e)}`);
    return false;
  }
}

/** HMAC-SHA256 of AUTH_SECRET over the fixed label (hex) — "" when the secret is unset. */
export function internalToken(): string {
  return computeInternalToken(process.env.AUTH_SECRET ?? "");
}

/** The pump route's gate: the bearer equals the internal token OR CRON_SECRET (constant-time). Never
 *  true when the matched secret is empty (fail closed). */
export function isInternalRequest(req: Request): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
  const token = m ? m[1].trim() : "";
  if (!token) return false;
  const it = internalToken();
  if (it && timingEqual(token, it)) return true;
  const cron = process.env.CRON_SECRET ?? "";
  if (cron && timingEqual(token, cron)) return true;
  return false;
}

/** The origin this deployment reaches itself on, for the continuation kick (spec §4.3). */
export function selfOrigin(req: Request): string {
  return computeSelfOrigin(process.env, req.url);
}
