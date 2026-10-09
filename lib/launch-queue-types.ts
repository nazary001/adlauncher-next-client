// The server-side launch queue (owner ask 08.10: "нажал запустить и кампании пошли в работу сразу же …
// чтобы не нужно было держать страничку открытой"). Until now the BROWSER was the orchestrator of
// every MO / AIF / AV launch and clone and every HS launch: its task manager pumped a queue, uploaded
// the creatives, called the launch route and read its NDJSON stream — close the tab and the wave died.
// Now the tab only HANDS the wave over (job rows in `launch_jobs`), and a server pump runs it.
//
// This file is the PURE contract of that queue — vocabulary, the job shape, enqueue validation and
// the verdict a finished run turns into. The pump algorithm lives in lib/launch-queue.ts (pure,
// injected deps), the store in lib/launch-queue-store.ts, the wiring in lib/launch-queue-run.ts.
//
// Two rules everything here serves:
//   1. A job runs AT MOST ONCE per (re)queue. A run whose outcome is not known for certain is never
//      offered a one-click retry — a second run would build a second live campaign.
//   2. The launch routes stay the single source of launch behaviour: the pump calls the very same
//      handlers the browser called (in-process, as the job's owner) and reads the very same replies.
// Relative `.ts` imports only (node --test loads this straight from disk).

export const QUEUE_SCOPES = ["mo", "aif", "av", "hs", "gg", "sn", "tt"] as const;
/** One drawer / one task-manager instance on the client (gg / sn / tt = the Google / Snapchat /
 *  TikTok platform drawers — their waves are queued by their ROUTES, never by the browser). */
export type QueueScope = (typeof QUEUE_SCOPES)[number];

/** Kinds the BROWSER hands over (POST /api/launch-queue). The pump runs each by calling the launch
 *  ROUTE HANDLER in-process and reading its reply:
 *   mo.launch → POST /api/launch · aif.launch → /api/aif/launch · av.launch → /api/av/launch
 *   fb.clone → /api/clone/run (MO / AIF / AV — the body's partnerId picks the rail)
 *   hs.lion → /api/hs/launch · hs.token → /api/hs/token-launch · hs.tool → /api/hs/tool-launch */
export const HANDLER_KINDS = ["mo.launch", "aif.launch", "av.launch", "fb.clone", "hs.lion", "hs.token", "hs.tool"] as const;
/** Kinds a wave ROUTE enqueues itself, one job per validated shot (09.10: every rail on the queue).
 *  A RUNNER (lib/launch-queue-runners.ts) feeds the rail's own pump core ONE shot:
 *   sn.launch → lib/snap-pump-core (a clone is a shot with cloneOf) · gg.* → lib/google-pump
 *   tt.* → lib/tiktok-pump-core (submit only; tt.follow settles) · hs.dup / hs.jurar → the LION
 *   duplicate / JURO submit (lib/hs-dup-shot, lib/hs-jurar-shot; *.follow polls + activates)
 *   hs.tokendup / hs.tokenjurar → one Graph tree (lib/hs-token-dup-shot, lib/hs-token-jurar-shot)
 *   hs.tooldup → one TOOL duplicate submit + a first look (tool.follow finishes a pending one) */
export const RUNNER_KINDS = ["sn.launch", "gg.launch", "gg.clone", "gg.juro", "tt.launch", "tt.clone", "tt.juro", "hs.dup", "hs.jurar", "hs.tokendup", "hs.tokenjurar", "hs.tooldup"] as const;
/** The long tail AFTER a submit, as its own job: polling LION / tiktok-weapon / TOOL and finishing
 *  the rows (activating born-PAUSED clones). IDEMPOTENT by construction — it reads and repeats
 *  idempotent writes — so a lost lease re-queues it; it runs in slices (FOLLOW_SLICE_MS) in the
 *  scope's follow lane and never holds a submit lane. One per wave (hs.*.follow, tt.follow) or one
 *  per TOOL job still working past its handler's window (tool.follow). It has NO task row of its own. */
export const FOLLOW_KINDS = ["hs.dup.follow", "hs.jurar.follow", "tt.follow", "tool.follow"] as const;
export const QUEUE_KINDS = [...HANDLER_KINDS, ...RUNNER_KINDS, ...FOLLOW_KINDS] as const;
export type QueueKind = (typeof QUEUE_KINDS)[number];
export type HandlerKind = (typeof HANDLER_KINDS)[number];

export const isHandlerKind = (kind: string): kind is HandlerKind => (HANDLER_KINDS as readonly string[]).includes(kind);
export const isFollowKind = (kind: string): boolean => (FOLLOW_KINDS as readonly string[]).includes(kind);

export const SCOPE_KINDS: Record<QueueScope, readonly QueueKind[]> = {
  mo: ["mo.launch", "fb.clone", "tool.follow"],
  aif: ["aif.launch", "fb.clone", "tool.follow"],
  av: ["av.launch", "fb.clone", "tool.follow"],
  hs: ["hs.lion", "hs.token", "hs.tool", "hs.dup", "hs.jurar", "hs.tokendup", "hs.tokenjurar", "hs.tooldup", "hs.dup.follow", "hs.jurar.follow", "tool.follow"],
  gg: ["gg.launch", "gg.clone", "gg.juro"],
  sn: ["sn.launch"],
  tt: ["tt.launch", "tt.clone", "tt.juro", "tt.follow"],
};

/** The `partner` every row of a scope carries (what the drawers' list filters key on). */
export const SCOPE_PARTNER: Record<QueueScope, string> = { mo: "in", aif: "us", av: "av", hs: "br", gg: "gg", sn: "sn", tt: "tt" };

/** HS rows keep their kind in the reused `gcm` column (see /api/hs-tasks). Every clone rail is
 *  "duplicate" there — what the HS drawer polled and activated before the server follow-up did. */
const HS_KIND_TAG: Partial<Record<QueueKind, string>> = {
  "hs.lion": "launch",
  "hs.token": "token",
  "hs.tool": "tool",
  "hs.dup": "duplicate",
  "hs.jurar": "duplicate",
  "hs.tokendup": "duplicate",
  "hs.tokenjurar": "duplicate",
  "hs.tooldup": "duplicate",
};
/** The tag a scope's rows carry in `gcm` for a kind (HS only — the other rails put their own tags there). */
export const hsKindTag = (kind: QueueKind): string | undefined => HS_KIND_TAG[kind];

export type JobStatus = "queued" | "running" | "done" | "error" | "canceled";

/** Display statics of the task row (what the drawer shows before the run fills in the rest). */
export type JobRow = { name: string; gcm: string; geo: string; budget: string; bid: string };

export type JobResult = {
  campaign_id?: string;
  adset_id?: string;
  ad_id?: string;
  gcm?: string;
  link?: string;
  name?: string;
  /** A TOOL job still working when the handler's window closed (outcomeOf's pending branch): the
   *  pump queues a tool.follow for it, which finishes the row once TOOL is done. */
  tool_job_id?: string;
  /** Which ad account the TOOL job builds on (tool.follow needs it for the failure text). */
  account?: string;
  /** A verdict's side note the follow-up must honour (an HS duplicate's bid read-back mismatch:
   *  the clone is parked PAUSED instead of activated). */
  note?: string;
};

/** What a runner (lib/launch-queue-runners.ts) gets besides the job: the moment by which its
 *  work must be over (the smaller of the invocation's budget and the kind's worst case). */
export type RunnerCtx = { deadlineAt: number; now: () => number; log: (msg: string) => void };
export type JobRunner = (job: QueueJob, ctx: RunnerCtx) => Promise<JobOutcome | Defer>;

/** One stored job (collection `launch_jobs`). `job_id` IS the task row's `task_id`. */
export type QueueJob = {
  job_id: string;
  owner: string;
  role: string | null;
  /** The owner's session `sub` — the run is signed as exactly this user. */
  sub: string | number;
  scope: QueueScope;
  kind: QueueKind;
  /** Sequencing key: jobs of one lane run strictly one at a time, in `seq` order. */
  lane: string;
  partner: string;
  /** Numeric ad account id the job will land on (display/demand only — never an authority). */
  account: string | null;
  /** The handler's request body, exactly as the browser used to POST it (minus the task id). */
  body: Record<string, unknown>;
  row: JobRow;
  status: JobStatus;
  /** error/canceled only: may be re-queued with one click. */
  retryable: boolean;
  attempts: number;
  seq: number;
  queued_at: number;
  started_at: number | null;
  finished_at: number | null;
  /** While running: the pump extends it; a run whose lease ran out is dead (never re-run). */
  lease_until: number | null;
  /** True once the pump has RECORDED that it is about to call the handler (an atomic store write
   *  that must succeed before the call). A claimed job that never got this far — its pump tripped
   *  between the claim and the call — provably never ran, so the sweeper may put it back in the
   *  queue; a job that began and then lost its lease is closed as interrupted and never re-run. */
  began: boolean;
  runner: string | null;
  error: string | null;
  result: JobResult | null;
  /** Shape version of this document (JOB_SCHEMA_VERSION of the build that queued it). Absent on
   *  documents written before versions existed = 1. A pump never runs a job newer than it knows. */
  v?: number;
  /** Build stamp of the deployment that accepted the hand-off (diagnostics only). */
  build?: string | null;
  /** The wave (one Launch click) this job belongs to — siblings share it: a wave's follow-up finds
   *  its submits by it, and a refusal that is a fact of the SOURCE fails the queued siblings without
   *  sending them (failQueuedSiblings). Null on the browser hand-off kinds. */
  group?: string | null;
  /** True = re-running this job is SAFE (a poller / activator whose every write is idempotent): a
   *  lost lease RE-QUEUES it instead of closing it as interrupted. Never true on a job that submits. */
  idempotent?: boolean;
  /** Claimable only once the clock passes it (a follow-up's next slice). Null / absent = at once. */
  not_before?: number | null;
  /** Rail display columns stamped on the queued row beside `row` (Google: adset_id = customer,
   *  ad_id = currency; TikTok the same; Snapchat: gcm = the key the board previewed) and never
   *  nulled by the pump's own patches. */
  row_extra?: Record<string, string> | null;
};

/** What a runner answers INSTEAD of a verdict when its job is a follow-up with work still pending:
 *  the pump puts the job back in the queue for `notBefore` (lease cleared, attempts kept) and may
 *  patch its body (the follow-up's own progress note). The row is not touched. */
export type Defer = { defer: { notBefore: number; body?: Record<string, unknown> } };
export const isDefer = (x: unknown): x is Defer => !!x && typeof x === "object" && "defer" in (x as object) && !!(x as Defer).defer;

// ---- updates: jobs outlive the build that queued them ----
//
// A job handed over under one deployment is routinely RUN by another: the owner ships an update
// while a 40-campaign wave is still queued, or rolls one back. So:
//   • a job's `body` is the handler's request body — handlers must keep accepting the bodies the
//     previous builds produced (tests/queue-wire-golden.test.ts pins today's shapes: add a fixture
//     for a new shape, never edit an old one);
//   • a change that old code could MISREAD bumps JOB_SCHEMA_VERSION: a pump on an older build then
//     refuses such a job (hands the lane to the current build) instead of running it wrong;
//   • a pump whose build is no longer the newest one live finishes its job and hands its lane over
//     (isSuperseded) — after an update the new code takes every lane within one job.

/** Bump ONLY for a change in job documents that an older build could run wrongly. */
export const JOB_SCHEMA_VERSION = 1;

/** Why THIS build must not run the job: it was queued in a newer document shape, or its kind is not
 *  one this build has a handler for (a kind added by a later build, then a rollback). Null = fine. */
export function unsupportedReason(job: Pick<QueueJob, "kind" | "v">): "version" | "kind" | null {
  if (Number(job.v ?? 1) > JOB_SCHEMA_VERSION) return "version";
  if (!(QUEUE_KINDS as readonly string[]).includes(String(job.kind))) return "kind";
  return null;
}

/** The "current build" beacon: the every-minute sweep of the PRODUCTION deployment writes its build
 *  stamp; pumps read it. Build stamps are ISO build times (next.config NEXT_PUBLIC_BUILD_STAMP), so
 *  "newer" is a plain string comparison. */
export type BuildBeacon = { build: string; at: number };
/** A beacon older than this proves nothing (the sweep is not running) — nobody yields on it. */
export const BEACON_FRESH_MS = 3 * 60_000;

/** True when a NEWER build than `mine` is the one being swept right now — this pump belongs to a
 *  deployment that has been replaced and should hand its lane over. Never true toward an OLDER
 *  build (a rollback, or the first minute of a new deployment before its own first sweep): yielding
 *  "down" would bounce the lane between two builds. */
export function isSuperseded(beacon: BuildBeacon | null, mine: string, now: number): boolean {
  if (!beacon || !mine || !beacon.build) return false;
  if (now - beacon.at > BEACON_FRESH_MS) return false;
  return isNewerBuild(beacon.build, mine);
}

/** Build stamps are ISO build times ("2026-10-08T06:36:12.345Z") — only two of THAT shape are
 *  comparable; anything else (empty, a foreign value in a shared database) is never "newer". */
const BUILD_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
export function isNewerBuild(other: string, mine: string): boolean {
  return BUILD_STAMP.test(other) && BUILD_STAMP.test(mine) && other > mine;
}

// ---- timing ----

/** Lane lock lease / job lease: both are extended every HEARTBEAT_MS by the pump that holds them.
 *  The LANE lease must outlive a job's lease plus the reap grace (review find 08.10): a lane that
 *  became free while its job was still validly "running" — the lane heartbeats failing for two
 *  minutes while the job's own lease held — let a second pump start the NEXT job beside it, two
 *  launches of one buyer at once (the pacing is the defence against profile blocks). With this order
 *  a lane can only be taken over after its last job is already dead and reaped. The cost: after a
 *  pump really dies, its lane resumes ~4.5 min later instead of 2. */
export const JOB_LEASE_MS = 180_000;
export const LANE_LEASE_MS = 260_000;
export const HEARTBEAT_MS = 30_000;
/** A pump invocation's own budget (the routes that host it export maxDuration = 800). */
export const PUMP_BUDGET_MS = 770_000;
/** Headroom kept on top of a job's worst case when deciding whether it still fits this invocation. */
export const PUMP_MARGIN_MS = 20_000;
/** The sweeper declares a running job dead this long after its lease ran out. */
export const REAP_GRACE_MS = 60_000;
/** Job documents age out after this (TTL index on expire_at). */
export const JOB_TTL_MS = 14 * 24 * 3_600_000;
/** Jittered pause between two jobs of a lane — the pacing the browser pumps kept (owner calls
 *  08-11 / 08-12: spaced, human-looking submits; it is the first defence against profile blocks). */
export const JOB_GAP_MIN_MS = 1_000;
export const JOB_GAP_MAX_MS = 3_000;

export const QUEUE_MAX_JOBS_PER_REQUEST = 40;
export const QUEUE_MAX_BODY_BYTES = 200_000;

/** A follow-up works this long per slice, then hands the lane back and asks for its next slice. */
export const FOLLOW_SLICE_MS = 4 * 60_000;
/** How long a follow-up waits between two slices while something is still pending. */
export const FOLLOW_DEFER_MS = 20_000;
/** A follow-up re-queued by the sweep after a lost lease waits this long first (the dead
 *  invocation's last writes may still be landing). */
export const FOLLOW_REQUEUE_DELAY_MS = 30_000;
/** The sweep re-queues an idempotent job at most this many times; past it the job is closed. */
export const IDEMPOTENT_MAX_ATTEMPTS = 60;
/** How long a wave's follow-up keeps asking LION about a clone before it closes the row with the
 *  drawer's old sentence ("Still not finished on LION after 3 h") — LION under load can chew on a
 *  task for hours (owner call 08-14), so the cap only exists to end a forever-wedged task. */
export const LION_FOLLOW_MAX_MS = 3 * 60 * 60_000;
/** TikTok's settle and a TOOL job past its window are over far sooner. */
export const TT_FOLLOW_MAX_MS = 40 * 60_000;
export const TOOL_FOLLOW_MAX_MS = 40 * 60_000;

/**
 * The longest one run of this kind can take before its handler / runner gives up on its own (the
 * routes' internal deadlines: FB budget 240 s + bounded pause, TOOL 265–270 s, LION 2 × 60 s a read).
 * The pump starts a job only while this much (+ margin) is left of its invocation — so a job the
 * platform could cut mid-run is never started (every error path of a run must get to run).
 *   • hs.lion used to be budgeted at 75 s — but the route runs IN-PROCESS here and reads LION's
 *     catalog first (profile data + pixels, 2 × 60 s each when the 10-minute cache is cold).
 *   • hs.token / hs.tool do those same cold reads AND THEN a full 240 s FB build / 270 s TOOL
 *     stream — a flat 310 s let the fit check start one with ~330 s left and the platform cut it
 *     mid-stream into a non-retryable "interrupted" (audit find 09.10). They reserve ~520–560 s now.
 *   • a Snapchat shot grows with its creatives (3 upload at a time, each up to 120 s of READY wait);
 *     one that no invocation could hold is admitted at the budget's edge — the core self-limits past
 *     its deadline and says what it left out, exactly as the wave pump did.
 */
export function worstCaseMs(kind: QueueKind, body?: Record<string, unknown> | null): number {
  switch (kind) {
    case "hs.token":
      return 520_000;
    case "hs.tool":
      return 560_000;
    case "sn.launch":
      return snapWorstCaseMs(body);
    case "gg.launch":
      return 120_000;
    case "gg.clone":
    case "gg.juro":
      return 300_000; // dataset fetch → poll (≤ 180 s) + the submit (≤ 60 s)
    case "tt.launch":
      return 160_000; // the submit (≤ 60 s) past the pump core's own 100 s deadline margin
    case "tt.clone":
    case "tt.juro":
      return 420_000; // submit + a cold source's probe / refetch cycle (giveUpMs 270 s)
    case "hs.tooldup":
      return 180_000; // bind-free submit + a 60 s first look at the child job
    case "hs.dup.follow":
    case "hs.jurar.follow":
    case "tt.follow":
    case "tool.follow":
      return FOLLOW_SLICE_MS + 60_000;
    default:
      return 310_000; // mo / aif / av / fb.clone / hs.lion / hs.dup / hs.jurar / hs.tokendup / hs.tokenjurar
  }
}

/** One Snapchat shot: the base chain (key, campaign, ad squad, creative + ad, activate — each a
 *  bounded 60 s call) plus one upload batch (3 creatives: download + upload + READY wait ≤ 120 s)
 *  per three creatives on the card. Capped so a card of any size still fits an invocation. */
export const SNAP_SHOT_BASE_MS = 180_000;
export const SNAP_SHOT_BATCH_MS = 150_000;
export const SNAP_SHOT_MAX_MS = 740_000;
function snapWorstCaseMs(body?: Record<string, unknown> | null): number {
  const shot = body && typeof body.shot === "object" && body.shot ? (body.shot as Record<string, unknown>) : null;
  const media = shot && Array.isArray(shot.media) ? shot.media.length : 1;
  const batches = Math.max(1, Math.ceil(media / 3));
  return Math.min(SNAP_SHOT_BASE_MS + batches * SNAP_SHOT_BATCH_MS, SNAP_SHOT_MAX_MS);
}

export const laneOf = (scope: QueueScope, owner: string): string => `${scope}:${owner}`;
/** The lane a scope's follow-ups run in — apart from its submits, so a poll never holds a launch back. */
export const followLaneOf = (scope: QueueScope, owner: string): string => `${scope}-follow:${owner}`;

/** The stage a row shows the moment its run starts (the handlers / cores take over from there). */
export function firstStage(kind: QueueKind): string {
  switch (kind) {
    case "fb.clone":
      return "source";
    case "hs.lion":
    case "hs.token":
    case "hs.tool":
    case "hs.dup":
    case "hs.jurar":
      return "submit";
    case "hs.tokendup":
    case "hs.tokenjurar":
    case "hs.tooldup":
      return "queue";
    case "sn.launch":
      return "key";
    case "gg.clone":
    case "gg.juro":
      return "dataset";
    case "gg.launch":
    case "tt.launch":
    case "tt.clone":
    case "tt.juro":
      return "submit";
    default:
      return "gcm"; // mo / aif / av (a follow-up never writes a row of its own)
  }
}

const isHs = (kind: QueueKind): boolean => kind.startsWith("hs.");
/** Drawers that model a dead run as "interrupted" (HS, Google, Snapchat, TikTok); the MO/AIF/AV
 *  drawer reads it as an error anyway (lib/task-view fromRemote). */
const interruptedStatus = (kind: QueueKind): string => (isHs(kind) || kind.startsWith("sn.") || kind.startsWith("gg.") || kind.startsWith("tt.") ? "interrupted" : "error");
/** A submit of this kind is "done" when the PARTNER accepted it, while its row stays open for the
 *  wave's follow-up to finish (poll + activate): the sweep must not close such a row off the done
 *  job — the follow-up closes it, or the row check does once the follow-up's own cap has passed. */
export const hasFollowUp = (kind: QueueKind): boolean => kind === "hs.dup" || kind === "hs.jurar";
/** How long a row of a kind with a follow-up may stay open after it was queued before the row check
 *  closes it as "not finished" (the follow-up's cap plus an hour of slack). */
export const FOLLOWED_ROW_MAX_OPEN_MS = LION_FOLLOW_MAX_MS + 60 * 60_000;

// ---- enqueue validation ----

export type EnqueueJobInput = { taskId: string; kind: QueueKind; body: Record<string, unknown>; row: JobRow; account: string | null };
export type EnqueueInput = { scope: QueueScope; jobs: EnqueueJobInput[] };

const TASK_ID_RE = /^[\w-]{6,64}$/;
const str = (v: unknown, max: number): string => (v == null ? "" : String(v)).trim().slice(0, max);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Every media URL a job body carries, in the shapes the seven handlers take. */
export function jobMediaUrls(kind: QueueKind, body: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v) out.push(v);
  };
  if (kind === "mo.launch" || kind === "aif.launch" || kind === "av.launch") {
    for (const m of Array.isArray(body.medias) ? body.medias : []) {
      if (isObj(m)) {
        push(m.url);
        push(m.coverUrl);
      }
    }
    push(body.mediaUrl);
    push(body.coverUrl);
  } else if (kind === "hs.lion") {
    for (const u of Array.isArray(body.creatives) ? body.creatives : []) push(u);
  } else if (kind === "hs.token" || kind === "hs.tool") {
    for (const c of Array.isArray(body.creatives) ? body.creatives : []) {
      if (isObj(c)) {
        push(c.url);
        push(c.cover);
      }
    }
  }
  return out;
}

/**
 * Shape-check one hand-off request. Deliberately NOT the launch validation — every rule about
 * accounts, pixels, landings, bids and the own-creative fence stays in the handlers, which run it
 * again at fire time. This only refuses what could never run: an unknown scope/kind, a malformed
 * task id, a body that is not an object, or a creative that never left the browser (a `blob:`
 * object URL, a `pending.local` placeholder) — the tab must finish its uploads before handing over.
 */
export function parseEnqueue(raw: unknown): { ok: true; value: EnqueueInput } | { ok: false; error: string } {
  if (!isObj(raw)) return { ok: false, error: "bad_request" };
  const scope = raw.scope as QueueScope;
  if (!QUEUE_SCOPES.includes(scope)) return { ok: false, error: "bad_scope" };
  const list = Array.isArray(raw.jobs) ? raw.jobs : [];
  if (list.length === 0) return { ok: false, error: "no_jobs" };
  if (list.length > QUEUE_MAX_JOBS_PER_REQUEST) return { ok: false, error: `too_many_jobs (max ${QUEUE_MAX_JOBS_PER_REQUEST})` };
  const seen = new Set<string>();
  const jobs: EnqueueJobInput[] = [];
  for (let i = 0; i < list.length; i++) {
    const j = list[i];
    const at = `job ${i + 1}`;
    if (!isObj(j)) return { ok: false, error: `${at}: bad_job` };
    const taskId = typeof j.taskId === "string" ? j.taskId : "";
    if (!TASK_ID_RE.test(taskId)) return { ok: false, error: `${at}: bad_task_id` };
    if (seen.has(taskId)) return { ok: false, error: `${at}: duplicate_task_id` };
    seen.add(taskId);
    const kind = j.kind as QueueKind;
    // A browser hands over handler kinds only: the wave routes queue their own kinds themselves
    // (after validating the wave), and a follow-up is never anybody's to hand over.
    if (!isHandlerKind(kind) || !SCOPE_KINDS[scope].includes(kind)) return { ok: false, error: `${at}: bad_kind` };
    if (!isObj(j.body)) return { ok: false, error: `${at}: bad_body` };
    // One clone per job: the pump aligns the job's task id with edits[0] (handlerBody), so a body
    // carrying more edits would create every clone on Facebook and record only the first one's row.
    if (kind === "fb.clone" && (!Array.isArray(j.body.edits) || j.body.edits.length !== 1)) return { ok: false, error: `${at}: clone_one_edit_per_job` };
    // The pump stamps the task id itself — a body may not bring its own (or another task's).
    const { taskId: _t, taskIds: _ts, ...body } = j.body;
    void _t;
    void _ts;
    let size = 0;
    try {
      size = JSON.stringify(body).length;
    } catch {
      return { ok: false, error: `${at}: bad_body` };
    }
    if (size > QUEUE_MAX_BODY_BYTES) return { ok: false, error: `${at}: body_too_large` };
    const urls = jobMediaUrls(kind, body);
    if (kind !== "fb.clone" && urls.length === 0) return { ok: false, error: `${at}: media_required` };
    for (const u of urls) {
      if (!/^https?:\/\//i.test(u) || /\/\/pending\.local\b/i.test(u)) return { ok: false, error: `${at}: creative_not_uploaded` };
    }
    const r = isObj(j.row) ? j.row : {};
    const account = str(j.account, 40).replace(/^act_/, "");
    jobs.push({
      taskId,
      kind,
      body,
      row: {
        name: str(r.name, 300),
        // HS rows carry their kind here; MO/AIF/AV the previewed marker code ("" for clones).
        gcm: HS_KIND_TAG[kind] ?? str(r.gcm, 40),
        geo: str(r.geo, 200),
        budget: str(r.budget, 40),
        bid: str(r.bid, 40),
      },
      account: /^\d{5,}$/.test(account) ? account : null,
    });
  }
  return { ok: true, value: { scope, jobs } };
}

// ---- task-row writes (the drawer's view of a job) ----

type RowPatch = Record<string, unknown>;

/** Every write the QUEUE makes to a task row marks it server-managed: the client then never judges
 *  it stale, never "settles" it, and its own writes to it are ignored (lib/task-store). */
const SRV = { srv: 1 } as const;

/** The row a job is born with. A rail's display columns (`row_extra`) land on top of the nulls. */
export function queuedRow(job: Pick<QueueJob, "kind" | "partner" | "row" | "queued_at"> & Pick<QueueJob, "row_extra">): RowPatch {
  return {
    ...SRV,
    retry: 0,
    partner: job.partner,
    name: job.row.name,
    gcm: job.row.gcm,
    geo: job.row.geo,
    budget: job.row.budget,
    ...(job.row.bid ? { bid: job.row.bid } : {}),
    status: "queued",
    stage: isHs(job.kind) ? firstStage(job.kind) : null,
    campaign_id: null,
    adset_id: null,
    ad_id: null,
    link: null,
    error: null,
    queued_at: job.queued_at,
    started_at: null,
    finished_at: null,
    ...(job.row_extra ?? {}),
  };
}

/** The row the moment the pump claims the job. */
export function runningRow(job: Pick<QueueJob, "kind" | "partner">, now: number): RowPatch {
  return { ...SRV, retry: 0, partner: job.partner, status: "running", stage: firstStage(job.kind), started_at: now, error: null };
}

export const CANCELED_STAGE = "canceled";

export function canceledRow(job: Pick<QueueJob, "partner">, now: number): RowPatch {
  return { ...SRV, retry: 1, partner: job.partner, status: "error", stage: CANCELED_STAGE, error: "Canceled before it started", finished_at: now };
}

export const INTERRUPTED_MSG =
  "Interrupted on the server mid-run — the campaign may have been partly created; check Ads Manager before launching it again";

/** A run that died with its function (lease ran out). Written only over a row that is still open. */
export function reapedRow(job: Pick<QueueJob, "kind" | "partner">, now: number): RowPatch {
  return { ...SRV, retry: 0, partner: job.partner, status: interruptedStatus(job.kind), error: INTERRUPTED_MSG, finished_at: now };
}

/** What the row check needs to know of a job. */
export type JobForRow = Pick<QueueJob, "kind" | "partner" | "status" | "retryable" | "error" | "result" | "finished_at">;

/** The stage a finished row shows — the one each rail's own terminal write uses. */
export function doneStage(kind: QueueKind): string {
  switch (kind) {
    case "hs.lion":
    case "hs.dup":
    case "hs.jurar":
      return "queue"; // accepted by LION (the follow-up moves a clone on to "ads")
    case "sn.launch":
      return "live";
    case "gg.launch":
    case "gg.clone":
    case "gg.juro":
    case "tt.launch":
    case "tt.clone":
    case "tt.juro":
      return "sent";
    default:
      return isHs(kind) ? "ads" : "ad";
  }
}

/** The sentence the row check writes over a followed row nobody finished inside the cap. */
export const FOLLOW_GAVE_UP_MSG = "Still not finished on LION after 3 h — check the LION dashboard";

/** A server-owned row untouched for this long is checked against its job by the sweep. Longer than
 *  any run's quietest stretch (a handler may sit in one stage for minutes) plus the pump's margin. */
export const ROW_STALE_MS = 7 * 60_000;

/**
 * What a still-OPEN row (queued / running) should become, given its job document — or null when it
 * is right to leave it open (the job itself is still queued or running). The sweep applies it with
 * an atomic write-over-open-row, so it can never bury a verdict that arrives at the same moment.
 *   • job done     → done at the rail's own final stage, with whatever ids the job recorded;
 *   • job error    → error (or "interrupted" on the HS drawer when it is not retryable), the job's
 *                    own message, its retry flag;
 *   • job canceled → the canceled row;
 *   • no job at all → the hand-off never reached the queue (the row is stamped first): not accepted.
 */
export function closingRowFor(
  job: JobForRow | null,
  rowPartner: string,
  now: number,
  /** When the row was queued — a row of a kind with a follow-up is the follow-up's to close until
   *  its cap has passed; only then does the row check step in. */
  rowQueuedAt?: number | null,
): RowPatch | null {
  if (!job) {
    return { ...SRV, retry: 0, partner: rowPartner, status: "error", stage: "queue", error: "Not accepted by the queue — nothing was sent; launch this campaign again", finished_at: now };
  }
  if (job.status === "queued" || job.status === "running") return null;
  const at = job.finished_at ?? now;
  const ids: RowPatch = {};
  for (const k of ["campaign_id", "adset_id", "ad_id", "link", "gcm", "name"] as const) {
    const v = job.result?.[k];
    if (v) ids[k] = v;
  }
  if (job.status === "done" && hasFollowUp(job.kind)) {
    // Accepted by the partner; the wave's follow-up polls it to the end and closes the row. Left
    // alone until the follow-up's own cap (plus slack) has passed — then nobody is coming for it.
    const since = rowQueuedAt ?? at;
    if (now - since < FOLLOWED_ROW_MAX_OPEN_MS) return null;
    return { ...SRV, retry: 0, partner: job.partner, status: interruptedStatus(job.kind), error: FOLLOW_GAVE_UP_MSG, finished_at: now, ...ids };
  }
  if (job.status === "done") return { ...SRV, retry: 0, partner: job.partner, status: "done", stage: doneStage(job.kind), error: null, finished_at: at, ...ids };
  if (job.status === "canceled") return canceledRow(job, at);
  const retry = job.retryable ? 1 : 0;
  return {
    ...SRV,
    retry,
    partner: job.partner,
    status: !retry ? interruptedStatus(job.kind) : "error",
    error: job.error || INTERRUPTED_MSG,
    finished_at: at,
    ...ids,
  };
}

/** What the launch-limit poll tells every tab about the queue's sweep: when it last ran, since when
 *  the oldest job waits, and since when the oldest RUNNING job has been overdue for reaping (a run
 *  whose pump died and whose lease nobody reaps — the one stranded job no queued backlog shows). */
export type QueueHealth = { sweptAt: number | null; oldestQueuedAt: number | null; oldestOverdueRunningAt?: number | null };
/** Jobs waiting this long while the sweep has been silent this long = worth telling the buyers. */
export const SWEEP_LATE_MS = 3 * 60_000;

/**
 * How late the every-minute sweep is, in whole minutes — or null when there is nothing to say: no
 * job is waiting or overdue, the oldest one only just arrived, or the sweep ran recently. A job that
 * is waiting behind a busy lane does not need the sweep, but a sweep that has stopped is the one
 * failure that leaves a stranded lane (or a dead run) waiting forever with nobody told — so it is
 * said out loud.
 */
export function sweepLateMinutes(h: QueueHealth | null | undefined, now: number): number | null {
  if (!h) return null;
  const waits = [h.oldestQueuedAt, h.oldestOverdueRunningAt].filter((v): v is number => typeof v === "number" && v > 0);
  if (waits.length === 0) return null;
  const oldest = Math.min(...waits);
  if (now - oldest < SWEEP_LATE_MS) return null;
  const since = h.sweptAt == null ? oldest : h.sweptAt;
  const late = now - since;
  return late >= SWEEP_LATE_MS ? Math.floor(late / 60_000) : null;
}

/** The verdict of a job the CURRENT build cannot run at all (unsupportedReason) — nothing was sent
 *  anywhere, so it is a clean, retryable refusal: the buyer presses Retry once the right version is
 *  live again. (A build that has been replaced never settles such a job — it hands the lane over.) */
export function unsupportedOutcome(job: Pick<QueueJob, "partner">, why: "version" | "kind", now: number): JobOutcome {
  const error =
    why === "version"
      ? "Queued by a newer version of Ad Launcher than the one running now — nothing was sent; press Retry after the update is back"
      : "This kind of launch is not supported by the version running now — nothing was sent; press Retry after the update is back";
  return {
    status: "error",
    retryable: true,
    error,
    result: null,
    ambiguous: false,
    openRow: null,
    row: { ...SRV, retry: 1, partner: job.partner, status: "error", stage: "queued", error, finished_at: now },
  };
}

/** The verdict of a job this TEAM's launcher does not have at all (lib/team teamAllowsJob) — the
 *  hand-off refuses such a job, so this only ever settles one that reached the store some other way.
 *  Nothing was sent; not retryable, because no later run of this launcher could run it either. */
export function refusedOutcome(job: Pick<QueueJob, "partner">, error: string, now: number): JobOutcome {
  return {
    status: "error",
    retryable: false,
    error,
    result: null,
    ambiguous: false,
    openRow: null,
    row: { ...SRV, retry: 0, partner: job.partner, status: "error", stage: "queued", error, finished_at: now },
  };
}

// ---- the verdict of one run ----

export type JobOutcome = {
  status: "done" | "error";
  /** error only — see QueueJob.retryable. */
  retryable: boolean;
  error: string | null;
  result: JobResult | null;
  /** Row fields the pump writes now. The handlers write their own progress and terminal rows as
   *  they go; this is the same terminal write the browser's task manager used to add on top — it
   *  can only repeat or complete what the server already recorded. */
  row: RowPatch;
  /** True when the outcome is NOT known for certain (a run still finishing elsewhere, a reply
   *  without a verdict): `row` then carries ONLY the flags, and `openRow` is written — by the
   *  caller — only if the row is still non-terminal (never over a done/error the server wrote). */
  ambiguous: boolean;
  openRow: RowPatch | null;
};

/** What the pump saw of one handler call. */
export type RunReply = {
  /** The handler threw before it produced any reply. */
  thrown?: string;
  httpStatus: number;
  /** The reply was the NDJSON run (vs one plain JSON object — a pre-run rejection). */
  streamed: boolean;
  /** The last event carrying `ok` (NDJSON), or the JSON body (plain reply); null when there is none. */
  final: Record<string, unknown> | null;
  /** The last `{stage}` event seen. */
  lastStage: string | null;
};

const s = (v: unknown): string | undefined => (v == null || v === "" ? undefined : String(v));

/**
 * Reply → verdict. A faithful port of what the browser task managers did with the same replies
 * (components/task-manager.tsx runLaunchTask / runCloneTask, components/hs-task-manager.tsx runTask)
 * with one tightening: an HS LION create that failed AMBIGUOUSLY (`lion_create_failed` — network /
 * 5xx after the submit was sent) is no longer retryable; the create may have landed.
 */
export function outcomeOf(job: Pick<QueueJob, "kind" | "partner" | "body">, reply: RunReply, now: number): JobOutcome {
  const kind = job.kind;
  const base = { ...SRV, partner: job.partner };
  const hs = isHs(kind);
  const stage = reply.lastStage ?? firstStage(kind);
  const f = reply.final;

  // The handler threw before answering. For the streaming rails that is always BEFORE the run
  // (every create sits inside the stream's own try) — nothing exists, retry is safe. A LION submit
  // has no such guarantee, so it settles as unknown.
  if (reply.thrown !== undefined) {
    const msg = `launch failed to start: ${reply.thrown}`;
    if (kind === "hs.lion") {
      return {
        status: "error",
        retryable: false,
        error: msg,
        result: null,
        ambiguous: true,
        row: { ...base, retry: 0 },
        openRow: { ...base, retry: 0, status: "interrupted", stage, error: `${msg} — check HS Tasks / LION before re-firing`, finished_at: now },
      };
    }
    return { status: "error", retryable: true, error: msg, result: null, ambiguous: false, openRow: null, row: { ...base, retry: 1, status: "error", stage, error: msg, finished_at: now } };
  }

  // ---- HS LION: one JSON answer; acceptance IS the terminal outcome (owner call 08-14) ----
  if (kind === "hs.lion") {
    if (f && f.ok === true && s(f.lionTaskId)) {
      const name = s(f.name);
      return {
        status: "done",
        retryable: false,
        error: null,
        result: { link: s(f.lionTaskId), ...(name ? { name } : {}) },
        ambiguous: false,
        openRow: null,
        row: { ...base, retry: 0, status: "done", stage: "queue", link: s(f.lionTaskId), started_at: now, finished_at: now, error: null, ...(name ? { name } : {}) },
      };
    }
    const msg = (f && s(f.error)) || `HTTP ${reply.httpStatus}`;
    // Sent to LION but the answer never came back clean: the create may exist — never re-send.
    if (!f || /^lion_create_failed/i.test(msg)) {
      const text = `${msg} — the submit may have reached LION; check HS Tasks / LION before re-firing`;
      return {
        status: "error",
        retryable: false,
        error: text,
        result: null,
        ambiguous: true,
        row: { ...base, retry: 0 },
        openRow: { ...base, retry: 0, status: "interrupted", stage, error: text, finished_at: now },
      };
    }
    return { status: "error", retryable: true, error: msg, result: null, ambiguous: false, openRow: null, row: { ...base, retry: 1, status: "error", stage, error: msg, finished_at: now } };
  }

  // ---- the streaming rails ----
  if (f && f.ok === true) {
    if (hs) {
      const creatives = Array.isArray(job.body.creatives) ? job.body.creatives.length : 0;
      const adCount = Array.isArray(f.ad_ids) ? f.ad_ids.length : creatives;
      const name = s(f.name);
      return {
        status: "done",
        retryable: false,
        error: null,
        // ad_id = the ad COUNT here, as on the row — recorded so the sweep's row check can restore it.
        result: { campaign_id: s(f.campaign_id), adset_id: s(f.adset_id), ad_id: String(adCount), ...(name ? { name } : {}) },
        ambiguous: false,
        openRow: null,
        row: {
          ...base,
          retry: 0,
          status: "done",
          stage: "ads",
          finished_at: now,
          campaign_id: s(f.campaign_id) ?? null,
          adset_id: s(f.adset_id) ?? null,
          ad_id: String(adCount), // string column — a number 400'd the whole write once (live 08-17)
          error: null,
          ...(name ? { name } : {}),
        },
      };
    }
    const link = kind === "fb.clone" ? undefined : s(f.link);
    return {
      status: "done",
      retryable: false,
      error: null,
      result: { campaign_id: s(f.campaign_id), adset_id: s(f.adset_id), ad_id: s(f.ad_id), gcm: s(f.gcm), ...(link ? { link } : {}) },
      ambiguous: false,
      openRow: null,
      row: {
        ...base,
        retry: 0,
        status: "done",
        stage: "ad",
        finished_at: now,
        campaign_id: s(f.campaign_id) ?? null,
        adset_id: s(f.adset_id) ?? null,
        ad_id: s(f.ad_id) ?? null,
        ...(link ? { link } : {}),
        ...(s(f.gcm) ? { gcm: s(f.gcm) } : {}),
        error: null,
      },
    };
  }

  // TOOL is still finishing the job past the handler's window: the campaign may yet be born. The
  // handler already wrote the pending row (claims kept) — nothing to retry. The TOOL job id rides
  // in the result: the pump queues a tool.follow for it, which finishes the row from TOOL's own
  // verdict (done → the campaign ids; failed → the reason) once TOOL is through.
  if (f && f.pending === true) {
    const msg = s(f.error) || "TOOL is still finishing this launch — this row updates from the server; check Ads Manager before re-firing";
    const toolJob = s(f.tool_job_id);
    const created = isObj(f.created) ? f.created : {};
    const campaign = s(created.campaign_id) ?? s(f.campaign_id);
    return {
      status: "error",
      retryable: false,
      error: msg,
      result: toolJob ? { tool_job_id: toolJob, ...(campaign ? { campaign_id: campaign } : {}) } : null,
      ambiguous: true,
      row: { ...base, retry: 0 },
      openRow: { ...base, retry: 0, status: hs ? "interrupted" : "error", stage, error: msg, finished_at: now },
    };
  }

  // A clean per-launch verdict. Retry is offered only while nothing landed on Facebook: a created
  // campaign makes a blind re-run a SECOND full tree under a fresh marker.
  if (f) {
    const msg = s(f.error) || (hs ? undefined : s(f.stage)) || `HTTP ${reply.httpStatus}`;
    const created = isObj(f.created) ? f.created : {};
    const campaign = s(created.campaign_id);
    const adset = s(created.adset_id);
    return {
      status: "error",
      retryable: !campaign,
      error: msg,
      result: campaign ? { campaign_id: campaign, ...(adset ? { adset_id: adset } : {}) } : null,
      ambiguous: false,
      openRow: null,
      row: {
        ...base,
        retry: campaign ? 0 : 1,
        status: "error",
        stage,
        finished_at: now,
        error: msg,
        ...(campaign ? { campaign_id: campaign } : {}),
        ...(adset ? { adset_id: adset } : {}),
      },
    };
  }

  // No verdict at all: the run ended without its final event. Whatever the handler managed to write
  // to the row is the truth; only a row it left open is settled, and never as retryable.
  const msg = `the run ended without a verdict (HTTP ${reply.httpStatus}) — it may still have finished; check Ads Manager before re-firing`;
  return {
    status: "error",
    retryable: false,
    error: msg,
    result: null,
    ambiguous: true,
    row: { ...base, retry: 0 },
    openRow: { ...base, retry: 0, status: hs ? "interrupted" : "error", stage, error: msg, finished_at: now },
  };
}

/** The request body the pump hands a handler: the stored body + the task id in the field that
 *  handler reads (the clone route takes a list aligned with its `edits`). */
export function handlerBody(job: Pick<QueueJob, "kind" | "body" | "job_id">): Record<string, unknown> {
  return job.kind === "fb.clone" ? { ...job.body, taskIds: [job.job_id] } : { ...job.body, taskId: job.job_id };
}

// ---- wire contract of POST /api/launch-queue (shared by the route and the browser) ----

export type QueueEnqueueRequest = { action?: "enqueue"; scope: QueueScope; jobs: Array<{ taskId: string; kind: QueueKind; body: Record<string, unknown>; row: Partial<JobRow>; account?: string | null }> };
export type QueueRetryRequest = { action: "retry"; taskIds: string[] };
/** Cancel the caller's own QUEUED jobs: the listed ones, or every queued job of a scope. */
export type QueueCancelRequest = { action: "cancel"; taskIds?: string[]; scope?: QueueScope };
export type QueueRequest = QueueEnqueueRequest | QueueRetryRequest | QueueCancelRequest;

export type QueueEnqueueResponse =
  | { ok: true; accepted: string[]; failed: Array<{ taskId: string; error: string }> }
  | { ok: false; error: string };
export type QueueActionResponse = { ok: true; taskIds: string[] } | { ok: false; error: string };
