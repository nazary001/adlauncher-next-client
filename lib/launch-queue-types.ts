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

export const QUEUE_SCOPES = ["mo", "aif", "av", "hs"] as const;
/** One drawer / one task-manager instance on the client. */
export type QueueScope = (typeof QUEUE_SCOPES)[number];

export const QUEUE_KINDS = ["mo.launch", "aif.launch", "av.launch", "fb.clone", "hs.lion", "hs.token", "hs.tool"] as const;
/** Which handler runs the job:
 *   mo.launch → POST /api/launch · aif.launch → /api/aif/launch · av.launch → /api/av/launch
 *   fb.clone → /api/clone/run (MO / AIF / AV — the body's partnerId picks the rail)
 *   hs.lion → /api/hs/launch · hs.token → /api/hs/token-launch · hs.tool → /api/hs/tool-launch */
export type QueueKind = (typeof QUEUE_KINDS)[number];

export const SCOPE_KINDS: Record<QueueScope, readonly QueueKind[]> = {
  mo: ["mo.launch", "fb.clone"],
  aif: ["aif.launch", "fb.clone"],
  av: ["av.launch", "fb.clone"],
  hs: ["hs.lion", "hs.token", "hs.tool"],
};

/** The `partner` every row of a scope carries (what the drawers' list filters key on). */
export const SCOPE_PARTNER: Record<QueueScope, string> = { mo: "in", aif: "us", av: "av", hs: "br" };

/** HS rows keep their kind in the reused `gcm` column (see /api/hs-tasks). */
const HS_KIND_TAG: Partial<Record<QueueKind, string>> = { "hs.lion": "launch", "hs.token": "token", "hs.tool": "tool" };

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
};

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
};

// ---- timing ----

/** Lane lock lease / job lease: both are extended every HEARTBEAT_MS by the pump that holds them. */
export const LANE_LEASE_MS = 120_000;
export const JOB_LEASE_MS = 180_000;
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

/** The longest one run of this kind can take before its handler gives up on its own (the routes'
 *  internal deadlines: FB budget 240 s + bounded pause, TOOL 265–270 s, LION submit ≤ 60 s). The
 *  pump starts a job only while this much (+ margin) is left of its invocation. */
export function worstCaseMs(kind: QueueKind): number {
  return kind === "hs.lion" ? 75_000 : 310_000;
}

export const laneOf = (scope: QueueScope, owner: string): string => `${scope}:${owner}`;

/** The stage a row shows the moment its run starts (the handlers take over from there). */
export function firstStage(kind: QueueKind): string {
  if (kind === "fb.clone") return "source";
  if (kind === "hs.lion" || kind === "hs.token" || kind === "hs.tool") return "submit";
  return "gcm";
}

const isHs = (kind: QueueKind): boolean => kind === "hs.lion" || kind === "hs.token" || kind === "hs.tool";

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
    if (!SCOPE_KINDS[scope].includes(kind)) return { ok: false, error: `${at}: bad_kind` };
    if (!isObj(j.body)) return { ok: false, error: `${at}: bad_body` };
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

/** The row a job is born with. */
export function queuedRow(job: Pick<QueueJob, "kind" | "partner" | "row" | "queued_at">): RowPatch {
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
    stage: isHs(job.kind) ? "submit" : null,
    campaign_id: null,
    adset_id: null,
    ad_id: null,
    link: null,
    error: null,
    queued_at: job.queued_at,
    started_at: null,
    finished_at: null,
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
  return { ...SRV, retry: 0, partner: job.partner, status: isHs(job.kind) ? "interrupted" : "error", error: INTERRUPTED_MSG, finished_at: now };
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
        result: { campaign_id: s(f.campaign_id), adset_id: s(f.adset_id), ...(name ? { name } : {}) },
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
  // handler already wrote the pending row (claims kept) — nothing to add, nothing to retry.
  if (f && f.pending === true) {
    const msg = s(f.error) || "TOOL is still finishing this launch — this row updates from the server; check Ads Manager before re-firing";
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
