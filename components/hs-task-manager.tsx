"use client";

// Independent task manager for the HS (LION) partner. Deliberately NOT the MO task manager:
// an HS launch is a single submit — LION's weapon builds campaign/adset/ads on ITS side. For
// LAUNCHES this tab no longer runs anything (owner ask 08.10): pressing Launch HANDS the wave to
// the server queue (sendToQueue → /api/launch-queue), the creatives already uploaded to our S3
// bucket at attach time. A server pump then calls the very launch routes this manager used to
// call, signed as the owner, and writes the shared row itself — every such row carries srv:1 and
// is NEVER judged stale, aged out or written by this client; it is only mirrored. The hand-off
// screen (components/launch-handoff) shows uploading → sending → with the server ✓, and the tab
// may close the moment the wave is accepted. The three launch rails the queue runs for HS are the
// same ones as before — LION create (kind hs.lion), FB Token (hs.token) and TOOL (hs.tool) — only
// the server, not this tab, now calls their routes. DUPLICATES are untouched: they keep the full
// submitted → poll → auto-activate lifecycle (their wave pump runs it server-side; the poll here
// finishes what the pump's budget didn't). TEAM-SHARED (2026-08-12): every row is persisted to the
// shared launch-task collection tagged partner="br" so the whole team sees every HS launch and
// clone; only the owner's session polls LION + auto-activates + can retry/cancel its own rows;
// teammates mirror the store. localStorage stays as an offline fallback for my own rows.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ensureCreativeUploaded } from "./creative-uploads";
import { handoffBegin, handoffPatch, useHandoffItems, useHandoffPending } from "./launch-handoff";
import { cancelQueued, isHandoffUnconfirmed, retryQueued, sendToQueue } from "./launch-queue-client";
import { UploadingNotice } from "./upload-guard";
import { type Campaign, type FileItem, bidTag, moneyLabel } from "@/lib/types";
import { CANCELED_STAGE, type QueueKind } from "@/lib/launch-queue-types";
import { teamHas } from "@/lib/team";
import type { SessionUser } from "./user-menu";
import { AlertIcon, CheckIcon, CopyIcon, RetryIcon, RocketIcon, TasksIcon, XIcon } from "./icons";

// The rails this team launches HS on besides LION (lib/team) — the drawer names only the rails its
// team has, so a LION-only team is not told about a FB token or a TOOL queue it cannot use.
const DIRECT_RAILS = [teamHas("channel:token") ? "FB token" : "", teamHas("channel:tool") ? "TOOL" : ""].filter(Boolean);
const QUEUE_RAILS_LABEL = ["LION", ...DIRECT_RAILS].join(" · ");
const EMPTY_HINT =
  "HS launches land here. They hand over to our server — close this tab once a row is queued. " +
  (DIRECT_RAILS.length
    ? `LION rail: a green row means LION accepted it — the build finishes on LION's side. ${DIRECT_RAILS.join(" & ")} ${DIRECT_RAILS.length > 1 ? "rails" : "rail"}: a green row means the campaign is already live on Facebook (delivery starts 30 min after create).`
    : "A green row means LION accepted it — the build finishes on LION's side.");

// ---------- model ----------

export type HsTaskStatus = "queued" | "running" | "submitted" | "done" | "error" | "unknown";

/** Which rail a launch rides: LION's create weapon, our own FB token straight on the Graph, or
 *  the HS TOOL sessions service (tool.gctracking.xyz — owner ask 28.09). */
export type HsLaunchChannel = "lion" | "token" | "tool";

export type HsTask = {
  id: string;
  name: string;
  profile: string;
  geo: string;
  budget: string;
  /** Username that launched/duplicated this. Shared view shows everyone's; only my own rows poll
   *  LION + auto-activate, and only I can retry them. */
  owner?: string | null;
  /** Server-side updatedAt (ms) of the Strapi row — the liveness signal behind `stale`. */
  updatedMs?: number;
  /** "launch" (create weapon, default for restored rows), "duplicate" (clone weapon — enters at
   *  "submitted" and auto-activates after COMPLETED, clones are born PAUSED), "token" (FB Token
   *  channel — the server builds the tree in-request on the Graph, no LION lifecycle) or "tool"
   *  (HS TOOL sessions service — same in-request contract as token, owner ask 28.09). The queue maps
   *  these to kinds hs.lion / hs.token / hs.tool. */
  kind?: "launch" | "duplicate" | "token" | "tool";
  status: HsTaskStatus;
  /** Furthest stage key reached (drives the segmented bar). */
  stage: string;
  lionTaskId?: string;
  lionStatus?: string;
  /** Non-terminal error LION reported (its tasker retries) — shown as a warning, not a failure. */
  lionNote?: string;
  /** Consecutive polls that answered the SAME lionNote — a deterministic validation error that
   *  survives several retries is wedged for good (client-only counter, never persisted). */
  noteStreak?: number;
  campaignId?: string;
  adsetId?: string;
  adCount?: number;
  /** Display-only "what it bids on" tag (bidTag: "ROAS 0,3" / "bid $0,5" / "auto") shown on the
   *  card so a buyer sees at a glance what a launch/clone rode on. Persisted in the store's `bid`
   *  column so it survives reload and shows on the team's restored rows too. */
  bid?: string;
  error?: string;
  /** Target ad account id (client-only). No longer set by the launch flow — the hand-off store
   *  (useHandoffDemand) and the server's /api/acct-limit queued map carry a queued launch's demand
   *  now; kept for the shared launch-limit fold's structural type. */
  account?: string;
  /** 1 = this row belongs to the server launch queue (spec §4.4): never judged stale, never aged
   *  out, never written by this client — only mirrored. Set on the optimistic row and read from
   *  the store row. */
  srv?: boolean;
  /** 1 = the owner may re-queue this row with one click (an error/canceled job the server still
   *  considers safe to run again). Only meaningful on srv rows. */
  retry?: boolean;
  /** Set on the optimistic row inserted the instant the server accepts a hand-off: keeps the row
   *  visible for OPTIMISTIC_ROW_MS even if a just-before poll (the team list is ~4 s cached) hasn't
   *  returned the server's own row yet. Cleared the moment that row arrives. */
  optimisticAt?: number;
  queuedAt: number;
  startedAt?: number;
  submittedAt?: number;
  finishedAt?: number;
  /** Created in THIS session. Duplicates born here stay `local` (authoritative over the fetch
   *  until the store catches up); server-queued launch rows are NOT local — the queue owns them. */
  local: boolean;
};

const STAGES: readonly { key: string; label: string }[] = [
  { key: "upload", label: "Uploading creatives" },
  { key: "submit", label: "Submitting to LION" },
  { key: "queue", label: "Queued on LION" },
  { key: "campaign", label: "Creating campaign" },
  { key: "adset", label: "Creating ad set" },
  { key: "ads", label: "Creating ads" },
];

// Token launches ride the same stage keys (one segmented bar for every kind) but never queue on
// LION — their "submit" phase is the server registering media with Meta.
const TOKEN_STAGE_LABELS: Record<string, string> = {
  upload: "Uploading creatives",
  submit: "Uploading to Facebook",
  campaign: "Creating campaign",
  adset: "Creating ad set",
  ads: "Creating ads",
};

// TOOL launches (owner ask 28.09) ride the SAME segmented bar. The TOOL launch route reuses the
// token rail's stage keys where they overlap (submit/campaign/adset/ads) and adds the shared NDJSON
// keys of spec §2.4 (gcm/video/processing/creative/ad); label every one it can emit.
const TOOL_STAGE_LABELS: Record<string, string> = {
  upload: "Uploading creatives",
  gcm: "Preparing launch",
  video: "Registering media",
  processing: "Processing video",
  submit: "Sending to TOOL",
  campaign: "Creating campaign",
  adset: "Creating ad set",
  creative: "Building creative",
  ad: "Creating ads",
  ads: "Creating ads",
};

// The spec §2.4 NDJSON keys TOOL may emit that are NOT slots on the HS segmented bar
// (STAGES = upload/submit/queue/campaign/adset/ads) → the slot each lights. Only affects TOOL/token
// stage keys; LION statuses (queue/campaign/adset/ads) pass through unchanged.
const HS_STAGE_ALIAS: Record<string, string> = {
  gcm: "submit",
  video: "submit",
  processing: "submit",
  creative: "ads",
  ad: "ads",
};

const stageIndex = (stage: string): number => {
  const key = HS_STAGE_ALIAS[stage] ?? stage;
  const i = STAGES.findIndex((s) => s.key === key);
  return i < 0 ? 0 : i;
};

/** Turn a raw LION task error into something a buyer can act on. "Temporarily blocked" /
 *  "restricted" is Facebook blocking the executor PROFILE (playbook), not the account — the shot
 *  can't land until it lifts, so the advice is to wait or switch to another profile.
 *  "Enter the person or organization being promoted…" is Meta's EU-DSA beneficiary check on
 *  WORLD-targeted shots — transient: LION's executor fills it in on retry (verified live 08-13,
 *  self-healed in ~35s), so it reads as normal progress, not as a scary Meta error. */
function humaniseLionNote(raw: string): string {
  const s = raw.toLowerCase();
  if (/temporarily blocked|been blocked|restricted/.test(s)) {
    return "Facebook temporarily blocked this profile — pause a bit, or duplicate through another profile";
  }
  if (/person or organization being promoted/.test(s)) {
    return "LION is launching the campaign — waiting for it to finish";
  }
  return raw;
}

/** Meta VALUE-validation rejections are deterministic per payload — LION's tasker re-sends the
 *  same stored value on every retry, so the loop can never succeed (proven live 08-10/12: decimal
 *  ROAS floors wedged CREATING_ADSET indefinitely). Scoped to the bid-constraint class only:
 *  broader "invalid …" texts can be transient (e.g. the campaign-id replication race). */
function isPermanentLionError(raw: string): boolean {
  // + Meta's min-ROAS eligibility rejection (code 100 / subcode 2446671, partner docs 09-09):
  // LION keeps the task on the requested strategy forever — the server pumps settle it, and
  // this keeps the client poll from flipping that settled row back to "running" (audit 09-09).
  return /roas.?average.?floor|bid constraint|2446671|Minimum ROAS Isn.?t Available/i.test(raw);
}

/** LION creation-status → local stage key + human label. */
const LION_STAGE: Record<string, { key: string; label: string }> = {
  PENDING: { key: "queue", label: "Queued on LION" },
  CREATING_CAMPAIGN: { key: "campaign", label: "Creating campaign" },
  CREATING_ADSET: { key: "adset", label: "Creating ad set" },
  CREATING_ADS: { key: "ads", label: "Creating ads" },
};

// Submits now run on the server (one lane, jittered 1–3 s between shots — the owner-08-12 pacing
// moved into lib/launch-queue; no client pump, gap or NDJSON stream here any more).
// Status polling cadence (drawer open / closed). One batched call covers every pending task.
// Eased 2026-08-24 (8s/20s → 12s/30s) alongside the server-side short-cache + bounded fetches:
// the shared Strapi was 503→504-ing under the team's combined MO+HS polling.
const POLL_OPEN_MS = 12_000;
const POLL_CLOSED_MS = 30_000;
// NOT_FOUND right after submit can be replication lag — only settle it after a grace window.
// Generous on purpose (owner call 08-14): under congestion LION's read side lags far behind
// accepted tasks, and a false NOT_FOUND error would strand a real campaign unactivated.
const NOT_FOUND_GRACE_MS = 15 * 60_000;
// A task still not terminal after this long stops polling and asks the buyer to check LION.
// LION under load can legitimately chew on a task for HOURS (owner call 08-14) — the cap only
// exists to stop polling forever-wedged tasks, and the poll is ONE batched call per cycle, so a
// long window costs almost nothing.
const PENDING_CAP_MS = 3 * 60 * 60_000;
// A shared row still WITHOUT a LION task id can only be advanced by its own session (launch
// tab) or its wave's server pump (≤13 min window) — once both are provably gone it can never
// progress, so it ages out much sooner than the LION-side cap. ×2+ the pump window.
const NEVER_SUBMITTED_CAP_MS = 30 * 60_000;
// Reality-check window: once a pending task knows its campaignId, the poll periodically reads
// the campaign ITSELF (details/) — LION's task record is not a reliable finish signal (live
// 08-13: WORLD-create beneficiary retries kept records "creating" for 45+ min / forever while
// the ads were live within minutes, and finished records prune to NOT_FOUND).
const VERIFY_AFTER_MS = 90_000;
const VERIFY_EVERY_MS = 40_000;
// Shared-view cadence: pull the team's HS rows continuously so the drawer is truthful even for
// tasks I didn't start. Ids just deleted are ignored in merges briefly so an in-flight fetch
// can't resurrect them. An owner counts as live while any of their rows was written < STALE_MS ago.
const SHARED_POLL_OPEN_MS = 6_000;
const SHARED_POLL_CLOSED_MS = 20_000;
const TOMBSTONE_MS = 60_000;
const STALE_MS = 180_000;
// Re-upsert my in-flight tasks every 25s so the row's updatedAt keeps bumping — that's how
// teammates tell a live-but-stuck task (LION still "creating") from a dead session. DUPLICATE rows
// only now (server-queued launch rows are srv and the client never writes them).
const HEARTBEAT_MS = 25_000;
// An accepted hand-off's optimistic row survives this long absent from the polled list before the
// normal "non-local rows absent from the fetch are dropped" rule applies. The team list is ~4 s
// cached server-side; a poll taken the instant before the accept must not blink the row out.
const OPTIMISTIC_ROW_MS = 30_000;

const LS_BASE = "adlauncher.hstasks";
const lsKeyFor = (user?: SessionUser) => (user?.username ? `${LS_BASE}.${user.username}` : LS_BASE);

// ---- Strapi row (partner="br" in the shared launch-task collection) ↔ HS task mapping ----
// The store's status enum is queued|running|done|error|interrupted; HS adds "submitted" (queued
// on LION) → running, and "unknown" (gave up) → interrupted. LION fields ride in reused columns
// (link=LION task id, gcm=kind, ad_id=ad count) — see /api/hs-tasks + stampHsTaskRow.
type HsRemoteRow = {
  id: string;
  owner: string | null;
  name: string;
  geo: string;
  budget: string;
  status: string;
  stage: string | null;
  lionTaskId: string | null;
  kind: string | null;
  campaignId: string | null;
  adsetId: string | null;
  adCount: number | null;
  bid: string | null;
  error: string | null;
  queued_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  updated_ms: number | null;
  /** 1 when the server launch queue owns this row, 1 when the owner may re-queue it (package C adds
   *  both to the HS list route; absent → 0/false, which is exactly the pre-queue behaviour). */
  srv: number | null;
  retry: number | null;
};

function statusToStore(s: HsTaskStatus): string {
  if (s === "submitted") return "running";
  if (s === "unknown") return "interrupted";
  return s; // queued|running|done|error pass through
}

/** Strapi row → HS task (restore). A non-terminal row that still carries a LION id resumes at
 *  "submitted" so polling picks it back up; one that lost its id is treated as interrupted. */
function fromRemote(r: HsRemoteRow): HsTask {
  const raw = r.status;
  let status: HsTaskStatus;
  if (raw === "done") status = "done";
  else if (raw === "error") status = "error";
  else if (raw === "interrupted") status = "unknown";
  else if (raw === "queued") status = "queued";
  else status = r.lionTaskId ? "submitted" : "running"; // "running" from the store
  return {
    id: r.id,
    owner: r.owner,
    name: r.name || "",
    profile: "",
    geo: r.geo || "",
    budget: r.budget || "",
    kind:
      r.kind === "duplicate" ? "duplicate" : r.kind === "token" ? "token" : r.kind === "tool" ? "tool" : "launch",
    status,
    stage: r.stage || (status === "submitted" ? "queue" : "upload"),
    lionTaskId: r.lionTaskId || undefined,
    campaignId: r.campaignId || undefined,
    adsetId: r.adsetId || undefined,
    adCount: r.adCount ?? undefined,
    bid: r.bid || undefined,
    error:
      r.error ||
      (raw === "interrupted" ? "Interrupted — the submitting session went offline" : undefined),
    srv: !!r.srv,
    retry: !!r.retry,
    queuedAt: r.queued_at ?? Date.now(),
    startedAt: r.started_at ?? undefined,
    submittedAt: r.lionTaskId ? (r.started_at ?? r.queued_at ?? undefined) : undefined,
    finishedAt: r.finished_at ?? undefined,
    updatedMs: r.updated_ms ?? undefined,
    local: false,
  };
}

/** Merge the team's fetched rows into the in-memory list: my in-session tasks stay authoritative,
 *  every other row mirrors the fetch (present → shown, absent → gone). Newest first; array keeps
 *  its identity when nothing changed so a quiet poll re-renders nothing. */
function mergeShared(cur: HsTask[], fetched: HsTask[], tombstones: ReadonlySet<string>): HsTask[] {
  const curById = new Map(cur.map((c) => [c.id, c]));
  const byId = new Map<string, HsTask>();
  for (const f of fetched) {
    if (!f.id || tombstones.has(f.id)) continue;
    const prev = curById.get(f.id);
    // My in-session DUPLICATE rows stay authoritative over the fetch (they poll + auto-activate
    // locally); server-queued launch rows are not local, so the fetched copy — the truth the queue
    // wrote — is adopted the moment it changes. An optimistic launch row (prev with no updatedMs)
    // is replaced here by the server's own row as soon as the poll carries it.
    byId.set(f.id, prev && prev.local ? prev : prev && prev.updatedMs === f.updatedMs ? prev : f);
  }
  // Rows absent from the fetch that must NOT blink out: my local duplicates (authoritative), and a
  // freshly-accepted optimistic launch row whose server row hasn't surfaced in the ~4 s-cached list
  // yet (kept only within OPTIMISTIC_ROW_MS of the accept — after that the fetch is the only truth).
  for (const c of cur) {
    if (byId.has(c.id)) continue;
    if (c.local || (c.optimisticAt && Date.now() - c.optimisticAt < OPTIMISTIC_ROW_MS)) byId.set(c.id, c);
  }
  const next = [...byId.values()].sort((a, b) => b.queuedAt - a.queuedAt || (a.id < b.id ? 1 : -1));
  return next.length === cur.length && next.every((t, i) => t === cur[i]) ? cur : next;
}

export type HsEnqueueArgs = {
  campaign: Campaign;
  files: FileItem[];
  name: string;
  profile: string;
  geo: string;
  budget: string;
  /** Launch rail: "lion" (create weapon, default) or "token" (direct Graph build). */
  channel?: HsLaunchChannel;
};

/** A duplicate already submitted to LION (the duplicate POST is instant) — one row per LION task.
 *  `taskId` is the server-minted id whose Strapi row was already stamped by /api/hs/duplicate. */
export type HsSubmittedRow = {
  taskId?: string;
  name: string;
  profile: string;
  geo: string;
  budget: string;
  /** Display-only bid/ROAS tag (bidTag) for the card, when the caller knows it. */
  bid?: string;
  lionTaskId: string;
};

type HsTaskManagerValue = {
  tasks: HsTask[];
  counts: { active: number; done: number; failed: number; running: number; total: number; inFlight: number; onLion: number };
  /** Current user — labels task owners in the shared view and gates own-only actions. */
  me: string | null;
  /** Est. server clock (Date.now()+skew) at the last fetch — for owner-liveness (stale) judging. */
  estServerNow: number;
  open: boolean;
  setOpen: (v: boolean) => void;
  enqueue: (args: HsEnqueueArgs) => void;
  /** Enter duplicate tasks directly at "submitted" — polling + auto-activation take over. */
  enqueueSubmitted: (rows: HsSubmittedRow[]) => void;
  /** Re-queue one of my failed/canceled server rows (status error && srv && retry). */
  retry: (id: string) => void;
  /** Re-queue every one of my retryable server rows. */
  retryAll: () => void;
  /** Cancel one of my still-queued server rows (status queued && srv). */
  cancel: (id: string) => void;
  /** Cancel every one of my queued server rows in the HS scope. */
  cancelAll: () => void;
  /** Owner-only removal of a terminal error/unknown row (wedged-task cleanup). */
  dismiss: (id: string) => void;
  /** Inline failures of a retry/cancel call, keyed by row id (or "hs:retry-all"/"hs:cancel-all"). */
  actionErrors: Record<string, string>;
};

const Ctx = createContext<HsTaskManagerValue | null>(null);

export function useHsTaskManager(): HsTaskManagerValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useHsTaskManager must be used within HsTaskManagerProvider");
  return v;
}

// ---------- provider ----------

export function HsTaskManagerProvider({ children, user }: { children: React.ReactNode; user?: SessionUser }) {
  const lsKey = lsKeyFor(user);
  const me = user?.username ?? null;
  const [tasks, setTasks] = useState<HsTask[]>([]);
  const [open, setOpen] = useState(false);
  const [skew, setSkew] = useState(0);
  const skewRef = useRef(0);
  const [nowTick, setNowTick] = useState(() => Date.now());
  // Inline errors for a retry/cancel call (keyed by row id, or "hs:retry-all"/"hs:cancel-all").
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  // What still depends on THIS tab: campaigns the hand-off screen has not handed over yet
  // (uploading | sending). Drives the drawer's "do not close" notice and counts.inFlight.
  const handoffPending = useHandoffPending("hs");
  const tasksRef = useRef<HsTask[]>([]);
  // Duplicate tasks whose post-COMPLETED activation has already been fired (once per task).
  const activatedRef = useRef(new Set<string>());
  const openRef = useRef(false);
  const loadedRef = useRef(false);
  const lastPollRef = useRef(0);
  const pollBusyRef = useRef(false);
  // Last time a poll piggybacked the campaign reality check (details/ is heavier than
  // creation-status — one throttled batch, not every 8s tick).
  const verifyAtRef = useRef(0);
  // Shared-store sync: static fields per task, per-task save chains, tombstones for just-fired
  // deletes, last shared fetch time, server-clock skew for stale detection.
  const meta = useRef(new Map<string, Record<string, unknown>>());
  const saveChains = useRef(new Map<string, Promise<unknown>>());
  const tombstones = useRef(new Map<string, number>());
  const lastSharedPollRef = useRef(0);
  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);
  // Long-lived tabs: the per-task bookkeeping (save chains, static meta, activation marks) grew
  // one entry per task ever seen and was never pruned (review find 08-24). Drop entries whose
  // task left the drawer entirely.
  useEffect(() => {
    const ids = new Set(tasks.map((t) => t.id));
    for (const k of [...meta.current.keys()]) if (!ids.has(k)) meta.current.delete(k);
    for (const k of [...saveChains.current.keys()]) if (!ids.has(k)) saveChains.current.delete(k);
    for (const k of [...activatedRef.current]) if (!ids.has(k)) activatedRef.current.delete(k);
  }, [tasks]);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const patch = useCallback((id: string, p: Partial<HsTask>) => {
    setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, ...p } : t)));
  }, []);

  const noteSkew = useCallback((serverNow: number) => {
    const s = serverNow - Date.now();
    skewRef.current = s; // ref mirror for non-render consumers (the poll's staleness gate)
    setSkew((prev) => (Math.abs(prev - s) > 3000 ? s : prev));
  }, []);

  /** Upsert one task's state to Strapi (partner="br"), chained PER TASK so transitions land in
   *  order. Static fields (name/geo/budget/kind) come from `meta`; `dyn` carries what changed. */
  const saveRemote = useCallback(
    (id: string, dyn: Record<string, unknown>) => {
      const payload = { task_id: id, ...(meta.current.get(id) ?? {}), ...dyn };
      const post = () =>
        fetch("/api/hs-tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          // A request left hanging by a network drop / laptop sleep would freeze this task's
          // save chain forever (writes are chained per task) — bound it instead.
          signal: AbortSignal.timeout(20_000),
        });
      const prev = saveChains.current.get(id) ?? Promise.resolve();
      const next = prev
        .catch(() => {})
        .then(async () => {
          try {
            const res = await post();
            if (res.ok || res.status === 400 || res.status === 401 || res.status === 403) return;
          } catch {
            /* network — retry once */
          }
          await new Promise((r) => setTimeout(r, 4000));
          await post().catch(() => {});
        });
      saveChains.current.set(id, next);
    },
    [],
  );

  /** Map a task's current state into the store's field set (LION fields in reused columns).
   *  The static identity (name/geo/budget) rides in EVERY save, not only in `meta` (which is
   *  empty for restored tasks): a save that races an admin row-deletion re-CREATES the row, and
   *  without these fields that resurrection is a nameless "Untitled · $0" stub (live 08-12).
   *  Empty values are skipped so a stub-restored task can never blank a good stored name. */
  const dynOf = useCallback(
    (t: HsTask): Record<string, unknown> => ({
      ...(t.name ? { name: t.name } : {}),
      ...(t.geo ? { geo: t.geo } : {}),
      ...(t.budget ? { budget: t.budget } : {}),
      status: statusToStore(t.status),
      stage: t.stage,
      link: t.lionTaskId ?? null,
      gcm: t.kind ?? "launch",
      campaign_id: t.campaignId ?? null,
      adset_id: t.adsetId ?? null,
      // ad_id is a STRING column — a numeric adCount 400s the whole Strapi write and the row
      // wedges at its previous status (live 08-17: 4/4 token launches stuck "running"; the same
      // silent 400 hit duplicate done-writes since 08-12).
      ad_id: t.adCount != null ? String(t.adCount) : null,
      ...(t.bid ? { bid: t.bid } : {}),
      error: t.error ?? t.lionNote ?? null,
      queued_at: t.queuedAt,
      started_at: t.submittedAt ?? t.startedAt ?? null,
      finished_at: t.finishedAt ?? null,
    }),
    [],
  );

  /** Pull the team's HS tasks and merge them in. Others' rows mirror the fetch; mine stay mine. */
  const loadRemote = useCallback(() => {
    // Timeout matters: while this fetch hangs, absent (deleted) rows are never merged OUT, so
    // localStorage-restored zombies survive and their polling/heartbeat resurrects them.
    fetch("/api/hs-tasks", { signal: AbortSignal.timeout(20_000) })
      .then(async (r) => {
        if (!r.ok) return;
        const d = (await r.json().catch(() => null)) as { ok?: boolean; now?: number; tasks?: HsRemoteRow[] } | null;
        if (!d?.ok || !Array.isArray(d.tasks)) return;
        if (typeof d.now === "number") noteSkew(d.now);
        const cutoff = Date.now() - TOMBSTONE_MS;
        for (const [id, ts] of tombstones.current) if (ts < cutoff) tombstones.current.delete(id);
        const fetched = d.tasks.map(fromRemote);
        const tomb = new Set(tombstones.current.keys());
        // A tombstoned id still coming back means the dismiss DELETE hasn't landed (it fires
        // once and a Strapi blip can eat it) — keep the row buried AND re-fire the delete;
        // letting the tombstone lapse after 60s resurrects the dismissed row (review find
        // 08-24). Same re-stamp loop the MO manager runs on its polls.
        for (const f of fetched) {
          if (f.id && tomb.has(f.id)) {
            tombstones.current.set(f.id, Date.now());
            void fetch(`/api/hs-tasks?taskId=${encodeURIComponent(f.id)}`, {
              method: "DELETE",
              signal: AbortSignal.timeout(20_000),
            }).catch(() => {});
          }
        }
        setTasks((cur) => mergeShared(cur, fetched, tomb));
      })
      .catch(() => {});
  }, [noteSkew]);

  // Restore once: the team's shared rows win; localStorage is the offline fallback for my own.
  useEffect(() => {
    let localSnap: HsTask[] = [];
    try {
      const raw = localStorage.getItem(lsKey);
      if (raw) {
        // A reload no longer interrupts anything: launches run on the server queue (srv rows) and
        // duplicates on their pump — both survive the page. Restore every row as-is (not `local`,
        // so the fetch below is authoritative); the shared store is merged over this snapshot a
        // moment later and carries the true, current state of each row.
        localSnap = (JSON.parse(raw) as HsTask[]).map((t): HsTask => ({ ...t, local: false }));
      }
    } catch {
      /* ignore */
    }
    fetch("/api/hs-tasks", { signal: AbortSignal.timeout(20_000) })
      .then(async (r) => (r.ok ? ((await r.json()) as { ok?: boolean; now?: number; tasks?: HsRemoteRow[] }) : null))
      .then((d) => {
        if (d?.now) noteSkew(d.now);
        const fetched = Array.isArray(d?.tasks) ? d!.tasks.map(fromRemote) : [];
        setTasks((cur) => mergeShared(mergeShared(cur, localSnap, new Set()), fetched, new Set()));
        loadedRef.current = true;
      })
      .catch(() => {
        setTasks((cur) => mergeShared(cur, localSnap, new Set()));
        loadedRef.current = true;
      });
  }, [lsKey, noteSkew]);

  // Shared-store polling: keep the team's rows fresh (faster while the drawer is open).
  useEffect(() => {
    const tick = () => {
      if (document.hidden) return;
      const interval = openRef.current ? SHARED_POLL_OPEN_MS : SHARED_POLL_CLOSED_MS;
      if (Date.now() - lastSharedPollRef.current < interval - 300) return;
      lastSharedPollRef.current = Date.now();
      loadRemote();
    };
    const iv = window.setInterval(tick, SHARED_POLL_OPEN_MS);
    const onVis = () => {
      if (!document.hidden) {
        lastSharedPollRef.current = Date.now();
        loadRemote();
      }
    };
    window.addEventListener("focus", onVis);
    document.addEventListener("visibilitychange", onVis);
    // Coarse tick so stale detection advances even with the drawer closed.
    const clock = window.setInterval(() => setNowTick(Date.now()), 10_000);
    return () => {
      window.clearInterval(iv);
      window.clearInterval(clock);
      window.removeEventListener("focus", onVis);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [loadRemote]);

  useEffect(() => {
    if (!loadedRef.current) return;
    try {
      // Persist only MY tasks (offline fallback for my own rows) — teammates' rows come from
      // Strapi, so localStorage never mirrors the whole team.
      localStorage.setItem(lsKey, JSON.stringify(tasks.filter((t) => t.local || (!!me && t.owner === me))));
    } catch {
      /* quota/disabled */
    }
  }, [tasks, lsKey, me]);

  // Heartbeat: bump my in-flight rows' updatedAt so a live-but-stuck task doesn't read as offline.
  // SERVER-MANAGED rows are skipped: every row the launch queue owns (srv — launches), batch-
  // duplicate rows progressed by the /api/hs/duplicate pump, and ADOPTED token rows written by
  // their launch route's own beat. A heartbeat here would race those writers with this tab's stale
  // copy and, worse, keep a DEAD server run looking alive (rowFresh) so the age-out cap never fires.
  // Their liveness signal is the server's own writes; only DUPLICATE rows born in this tab (local)
  // still heartbeat.
  useEffect(() => {
    const iv = window.setInterval(() => {
      if (document.hidden) return;
      for (const t of tasksRef.current) {
        const mine = t.local || (!!me && t.owner === me);
        const serverManaged = t.srv || (!t.local && (t.kind === "duplicate" || t.kind === "token" || t.kind === "tool"));
        if (mine && !serverManaged && (t.status === "queued" || t.status === "running" || t.status === "submitted")) {
          saveRemote(t.id, dynOf(t));
        }
      }
    }, HEARTBEAT_MS);
    return () => window.clearInterval(iv);
  }, [me, saveRemote, dynOf]);

  // ---- LION status polling (one batched call for every pending task) ----

  const poll = useCallback(async () => {
    // Only MY tasks poll LION + auto-activate; teammates' rows come from the shared store instead.
    const mine = (t: HsTask) => t.local || (!!me && t.owner === me);
    const now = Date.now();
    // Age out MY tasks stuck "creating" for an hour — stop burning polls, tell the buyer. This
    // runs BEFORE the busy latch: pure state work that must fire even if a status fetch is stuck
    // (live 08-12: a request hung overnight kept the latch closed, so a wedged task ticked for
    // 400+ minutes with the cap never firing).
    for (const t of tasksRef.current) {
      // The launch queue owns srv rows — it reaps its own dead jobs; the client never ages out or
      // writes them (spec §4.4). Only duplicate / adopted rows reach the caps below.
      if (t.srv) continue;
      // Two stranded classes age out here (both caught ticking forever by reviews 08-14):
      // 1) submitted rows LION never finished — generous 3h cap (LION can be slow, not dead);
      // 2) ADOPTED "running" rows with NO LION id — a dead launch tab (closed before its submit)
      //    or a dead wave pump left them; nothing can ever advance them, so a short cap.
      //    Live sessions are excluded by !local: a tab's own in-flight tasks are `local` there.
      // A row whose updatedAt is still being bumped belongs to a LIVE session (another of my
      // tabs mid-upload heartbeats it) — never short-cap those; only provably dead rows age out.
      const rowFresh = !!t.updatedMs && Date.now() + skewRef.current - t.updatedMs < STALE_MS;
      const neverSubmitted =
        !t.local && (t.status === "running" || t.status === "queued") && !t.lionTaskId && !rowFresh;
      const capFrom = t.submittedAt ?? t.queuedAt;
      const capMs = neverSubmitted ? NEVER_SUBMITTED_CAP_MS : PENDING_CAP_MS;
      if (mine(t) && (t.status === "submitted" || neverSubmitted) && capFrom && now - capFrom > capMs) {
        const finishedAt = capFrom + capMs;
        const error = neverSubmitted
          ? t.kind === "duplicate"
            ? "Never reached LION — the wave's server window closed before this shot; re-fire it in the duplicator"
            : t.kind === "token" || t.kind === "tool"
              ? "Interrupted — the launching session went offline mid-build; check Ads Manager before re-firing"
              : "Interrupted — the submitting session closed before this launch reached LION; fire the card again"
          : "Still not finished on LION after 3 h — check the LION dashboard";
        const status = neverSubmitted ? ("error" as const) : ("unknown" as const);
        patch(t.id, { status, finishedAt, error });
        saveRemote(t.id, dynOf({ ...t, status, finishedAt, error }));
      }
    }
    if (pollBusyRef.current) return;
    // Only duplicates ever reach "submitted" + a LION id; srv launch rows settle done/error on the
    // server and are never polled or written here (defensive !t.srv — it is a no-op for duplicates).
    const pending = tasksRef.current.filter((t) => mine(t) && t.status === "submitted" && t.lionTaskId && !t.srv);
    if (pending.length === 0) return;
    const pendingById = new Map(pending.map((t) => [t.lionTaskId as string, t]));
    // Campaign-known tasks past the verify window get their campaign read directly this round
    // (throttled — details/ is heavier than creation-status); NOT_FOUND records verify every
    // round: the record is gone, reality is the only signal left.
    const dueForVerify = now - verifyAtRef.current > VERIFY_EVERY_MS;
    const verifyIds = [
      ...new Set(
        pending
          .filter((t) => t.campaignId && t.submittedAt && now - t.submittedAt > VERIFY_AFTER_MS)
          .filter((t) => dueForVerify || t.lionStatus === "NOT_FOUND")
          .map((t) => t.campaignId as string),
      ),
    ];
    if (verifyIds.length && dueForVerify) verifyAtRef.current = now;
    pollBusyRef.current = true;
    try {
      const res = await fetch("/api/hs/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskIds: [...new Set(pending.map((t) => t.lionTaskId as string))],
          ...(verifyIds.length ? { verifyCampaignIds: verifyIds } : {}),
        }),
        // Unbounded fetches freeze the whole poller: the busy latch above only reopens in the
        // `finally`, which a hung request never reaches. 20s >> the route's LION reads.
        signal: AbortSignal.timeout(20_000),
      });
      const d = (await res.json().catch(() => null)) as
        | {
            ok?: boolean;
            campaigns?: Record<string, { status: string; adsCount: number }>;
            tasks?: {
              taskId: string;
              status: string;
              campaignId: string | null;
              adsetId: string | null;
              adIds: string[];
              error: string | null;
            }[];
          }
        | null;
      if (!d?.ok || !Array.isArray(d.tasks)) return;
      const byLionId = new Map(d.tasks.map((t) => [t.taskId, t]));
      // Duplicate clones are born PAUSED (birth status unpredictable — playbook) → activate the
      // moment a duplicate finishes, whether the task record said so or the reality check did.
      // Once per task; a failed flip is a note, not a failure.
      const activateDuplicate = (taskId: string, campaignId: string) => {
        // Geo-override clones are activated EXCLUSIVELY by the server pump's patch gate: the row
        // rides stage "geo-gate" until the Graph patch is verified in ("patched"), and flipping
        // it from here would put spend on the SOURCE geo (review find 08-24). The guard sits
        // BEFORE the once-marker so the task can still activate later, once the stage changes.
        const gated = tasksRef.current.find((x) => x.id === taskId);
        // Any "*-gate" stage is a server verdict: geo-gate (override patch pending) and bid-gate
        // (LION resolved other bidding than requested — duplicate v2 read-back, audit 09-09).
        if (gated?.stage && /-gate$/.test(gated.stage)) return;
        if (activatedRef.current.has(taskId)) return;
        activatedRef.current.add(taskId);
        void fetch("/api/hs/activate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ campaignId }),
        })
          .then(async (res) => {
            const a = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
            if (!a?.ok) {
              const lionNote = `activation failed — flip it ACTIVE in LION (${a?.error ?? res.status})`;
              patch(taskId, { lionNote });
              const base = tasksRef.current.find((x) => x.id === taskId);
              if (base) saveRemote(taskId, dynOf({ ...base, lionNote }));
            }
          })
          .catch(() => patch(taskId, { lionNote: "activation failed — flip it ACTIVE in LION" }));
      };
      for (const r of d.tasks) {
        const t = pendingById.get(r.taskId);
        if (!t || t.kind !== "duplicate") continue;
        if (r.status !== "COMPLETED" || !r.campaignId) continue;
        activateDuplicate(t.id, r.campaignId);
      }
      // Compute each pending task's new fields once, apply to state, then persist MY updates.
      const updates = new Map<string, Partial<HsTask>>();
      for (const t of pending) {
        const r = byLionId.get(t.lionTaskId as string);
        if (!r) continue;
        // Reality wins over the task record: the campaign exists and carries ads → the launch
        // happened, however wedged (beneficiary retry loop) or pruned (NOT_FOUND) the record is.
        // Same done shape as the COMPLETED branch below.
        const camp = t.campaignId ? d.campaigns?.[t.campaignId] : undefined;
        if (r.status !== "COMPLETED" && camp && camp.adsCount > 0) {
          if (t.kind === "duplicate") activateDuplicate(t.id, t.campaignId as string);
          updates.set(t.id, {
            status: "done",
            stage: "ads",
            lionStatus: "COMPLETED",
            lionNote: undefined,
            noteStreak: 0,
            adCount: camp.adsCount,
            finishedAt: Date.now(),
          });
          continue;
        }
        if (r.status === "COMPLETED") {
          updates.set(t.id, {
            status: "done",
            stage: "ads",
            lionStatus: r.status,
            lionNote: undefined,
            campaignId: r.campaignId ?? undefined,
            adsetId: r.adsetId ?? undefined,
            adCount: r.adIds.length,
            finishedAt: Date.now(),
          });
        } else if (r.status === "NO_COUNTRIES_LEFT") {
          updates.set(t.id, {
            status: "error",
            lionStatus: r.status,
            error: "LION: no eligible countries left for this campaign",
            finishedAt: Date.now(),
          });
        } else if (r.status === "NOT_FOUND") {
          // A known campaignId means LION accepted the shot and built the campaign — its pruned
          // record is not a failure. The reality check above settles it (details/ lags on fresh
          // campaigns), the 60-min cap backstops. Only never-got-anywhere tasks error here.
          if (!t.campaignId && t.submittedAt && Date.now() - t.submittedAt > NOT_FOUND_GRACE_MS) {
            updates.set(t.id, {
              status: "error",
              lionStatus: r.status,
              error: "LION does not know this task (NOT_FOUND)",
              finishedAt: Date.now(),
            });
          } else if (t.lionStatus !== r.status) {
            updates.set(t.id, { lionStatus: r.status }); // remember NOT_FOUND → verify every round
          }
        } else {
          const mapped = LION_STAGE[r.status];
          const note = r.error ? humaniseLionNote(r.error) : undefined;
          // Same note answered by N consecutive polls; a fresh/changed note restarts the count.
          const noteStreak = note ? (note === t.lionNote ? (t.noteStreak ?? 1) + 1 : 1) : 0;
          if (note && r.error && noteStreak >= 3 && isPermanentLionError(r.error)) {
            // Deterministic validation error surviving 3 polls (~0.5–1 min) = wedged for good —
            // fail the task now instead of ticking "creating" until the 60-min cap.
            updates.set(t.id, {
              status: "error",
              lionStatus: r.status,
              stage: mapped?.key ?? t.stage,
              lionNote: undefined,
              noteStreak: 0,
              error: `Wedged on LION — its retry re-sends the same rejected value: ${note}`,
              finishedAt: Date.now(),
              ...(r.campaignId ? { campaignId: r.campaignId } : {}),
            });
          } else {
            updates.set(t.id, {
              lionStatus: r.status,
              stage: mapped?.key ?? t.stage,
              ...(r.adIds.length ? { adCount: r.adIds.length } : {}),
              ...(r.campaignId ? { campaignId: r.campaignId } : {}),
              lionNote: note,
              noteStreak,
            });
          }
        }
      }
      if (updates.size) {
        setTasks((ts) => ts.map((t) => (updates.has(t.id) ? { ...t, ...updates.get(t.id) } : t)));
        for (const t of pending) {
          const p = updates.get(t.id);
          if (p) saveRemote(t.id, dynOf({ ...t, ...p }));
        }
      }
    } catch {
      /* transient — next tick retries */
    } finally {
      pollBusyRef.current = false;
    }
  }, [patch, me, saveRemote, dynOf]);

  useEffect(() => {
    const tick = () => {
      if (document.hidden) return;
      const interval = openRef.current ? POLL_OPEN_MS : POLL_CLOSED_MS;
      if (Date.now() - lastPollRef.current < interval - 500) return;
      lastPollRef.current = Date.now();
      void poll();
    };
    const iv = window.setInterval(tick, POLL_OPEN_MS);
    const onVis = () => {
      if (!document.hidden) {
        lastPollRef.current = Date.now();
        void poll();
      }
    };
    window.addEventListener("focus", onVis);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(iv);
      window.removeEventListener("focus", onVis);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [poll]);

  // Immediate poll when the drawer opens — live stages without waiting a tick.
  useEffect(() => {
    if (open) {
      lastPollRef.current = Date.now();
      void poll();
    }
  }, [open, poll]);

  // A hand-off this tab marked FAILED whose row the server nevertheless holds: the reply was lost on
  // the way back, not the campaign. The server has it — clear the alarm (same rule as the MO / AIF /
  // AV manager), or the buyer is left looking at "not confirmed" for a launch that is in fact running.
  // An optimistic row never counts: only a row the poll brought from the server proves anything.
  const handoffItems = useHandoffItems();
  useEffect(() => {
    for (const it of handoffItems) {
      if (it.scope !== "hs" || it.phase !== "failed") continue;
      const row = tasks.find((t) => t.id === it.id);
      if (row?.srv && !row.optimisticAt && !(row.status === "error" && /^Not accepted by the queue/.test(row.error ?? ""))) {
        handoffPatch(it.id, { phase: "accepted", error: null, retry: null });
      }
    }
  }, [handoffItems, tasks]);

  // ---- actions ----

  // Launch no longer runs here (owner ask 08.10): it HANDS the wave over. Register the campaign on
  // the hand-off screen, await its already-started creative uploads, POST the job to the server
  // queue, and leave an optimistic row — a server pump then runs the very launch route this manager
  // used to call. The tab may close the instant the hand-off is accepted.
  const enqueue = useCallback(
    (args: HsEnqueueArgs) => {
      const id =
        (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)) + Date.now().toString(36);
      const now = Date.now();
      const channel: HsLaunchChannel =
        args.channel === "token" ? "token" : args.channel === "tool" ? "tool" : "lion";
      const kind: QueueKind = channel === "tool" ? "hs.tool" : channel === "token" ? "hs.token" : "hs.lion";
      const taskKind = channel === "tool" ? ("tool" as const) : channel === "token" ? ("token" as const) : ("launch" as const);
      // What this launch bids on — shown on the card and carried to the server row via the job `row`.
      const bid = bidTag(args.campaign.bidStrategy, args.campaign.bidCap) || undefined;
      const account = (args.campaign.account || "").replace(/^act_/, "") || undefined;
      const sub = `${args.geo} · $${moneyLabel(args.budget)}`;
      const media = args.files.filter((f) => f.kind === "video" || f.kind === "image");
      // Custom video covers ride only the FB-Token / TOOL rails — LION's create contract takes bare
      // URLs and picks its own frame.
      const coverOf = (f: FileItem) =>
        (channel === "token" || channel === "tool") && f.kind === "video" ? f.cover : undefined;

      // Refuse, BEFORE anything is handed over, exactly what the old client runner refused before it
      // uploaded: an empty card, and more than 10 creatives on the FB-Token rail (the rail builds at
      // most 10 ads per window; the server enforces it again). A refusal is shown as a FAILED hand-off
      // item — never thrown: the board fires this in a loop and must keep going.
      const refuse = (msg: string) => {
        handoffBegin([{ id, scope: "hs", label: args.name, sub, sources: [], account, phase: "failed" }]);
        handoffPatch(id, { error: msg });
      };
      if (media.length === 0) {
        refuse("no creatives on the card");
        return;
      }
      if (channel === "token" && media.length > 10) {
        refuse("the FB Token rail builds at most 10 ads per campaign — trim the creatives or use the LION rail");
        return;
      }

      // Every file this campaign waits on — creatives and (token/tool) covers — so the hand-off
      // screen shows each one's live upload progress.
      const sources = [
        ...media.map((f) => f.url),
        ...media
          .map(coverOf)
          .filter((c): c is NonNullable<typeof c> => !!c)
          .map((c) => c.url),
      ];
      handoffBegin([{ id, scope: "hs", label: args.name, sub, sources, account }]);

      // One full-bodied async function (never a thin wrapper — Turbopack would const-fold a null
      // return): resolve the uploads (usually already done), build the exact body the route takes
      // minus the task id, hand it to the queue, then stamp the optimistic row.
      const run = async (): Promise<void> => {
        const urls = await Promise.all(
          media.map((f) =>
            ensureCreativeUploaded(f.url, { name: f.name || "", kind: f.kind === "image" ? "image" : "video" }),
          ),
        );
        const coverUrls = new Map<number, string>();
        for (let i = 0; i < media.length; i++) {
          const cov = coverOf(media[i]);
          if (cov) coverUrls.set(i, await ensureCreativeUploaded(cov.url, { name: cov.name || `cover-${i}.jpg`, kind: "image" }));
        }
        const body: Record<string, unknown> =
          channel === "lion"
            ? { campaign: args.campaign, creatives: urls }
            : {
                campaign: args.campaign,
                creatives: media.map((f, i) => ({
                  url: urls[i],
                  kind: f.kind === "image" ? "image" : "video",
                  name: f.name || "",
                  ...(coverUrls.has(i) ? { cover: coverUrls.get(i) } : {}),
                })),
              };
        handoffPatch(id, { phase: "sending" });
        await sendToQueue("hs", {
          taskId: id,
          kind,
          body,
          row: { name: args.name, geo: args.geo, budget: args.budget, ...(bid ? { bid } : {}) },
          account,
        });
        handoffPatch(id, { phase: "accepted" });
        // Optimistic row so the drawer shows the launch at once. The server stamped its own srv row
        // before answering, so the next poll adopts it; until then this row survives (mergeShared,
        // OPTIMISTIC_ROW_MS) so a just-before poll can't blink it. srv → never heartbeat/age/write it.
        setTasks((ts) => {
          const row: HsTask = {
            id,
            name: args.name,
            profile: args.profile,
            geo: args.geo,
            budget: args.budget,
            owner: me,
            kind: taskKind,
            status: "queued",
            stage: "submit",
            srv: true,
            retry: false,
            ...(bid ? { bid } : {}),
            queuedAt: now,
            optimisticAt: Date.now(),
            local: false,
          };
          const i = ts.findIndex((t) => t.id === id);
          if (i < 0) return [row, ...ts];
          const next = ts.slice();
          next[i] = { ...ts[i], ...row };
          return next;
        });
        loadRemote();
      };

      const attempt = () => {
        run().catch((e) => {
          const error = e instanceof Error ? e.message : String(e);
          // No verdict came back (the reply was lost): the server may hold the job — say "not
          // confirmed", and look for its row now and once the short list cache has turned over.
          const unsure = isHandoffUnconfirmed(e);
          handoffPatch(id, {
            phase: "failed",
            error,
            uncertain: unsure,
            retry: () => {
              handoffPatch(id, { phase: "uploading", error: null, retry: null });
              attempt();
            },
          });
          if (unsure) {
            loadRemote();
            window.setTimeout(loadRemote, 6_000);
          }
        });
      };
      attempt();
    },
    [me, loadRemote],
  );

  const enqueueSubmitted = useCallback(
    (rows: HsSubmittedRow[]) => {
      if (rows.length === 0) return;
      const now = Date.now();
      const fresh: HsTask[] = rows.map((r, i) => {
        // Use the server-minted id when present (the duplicate route already stamped the row);
        // otherwise generate one and stamp it here.
        const id =
          r.taskId ??
          (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)) + now.toString(36) + i.toString(36);
        meta.current.set(id, { name: r.name, geo: r.geo, budget: r.budget, gcm: "duplicate", ...(r.bid ? { bid: r.bid } : {}) });
        return {
          id,
          name: r.name,
          profile: r.profile,
          geo: r.geo,
          budget: r.budget,
          ...(r.bid ? { bid: r.bid } : {}),
          owner: me,
          kind: "duplicate" as const,
          status: "submitted" as const,
          stage: "queue",
          lionTaskId: r.lionTaskId,
          queuedAt: now,
          startedAt: now,
          submittedAt: now,
          local: true,
        };
      });
      setTasks((ts) => [...fresh, ...ts]);
      // Belt over the server stamp (harmless idempotent upsert) — guarantees the row exists.
      for (const t of fresh) {
        saveRemote(t.id, {
          status: "running",
          stage: "queue",
          link: t.lionTaskId ?? null,
          gcm: "duplicate",
          queued_at: now,
          started_at: now,
        });
      }
    },
    [me, saveRemote],
  );

  const isMineTask = useCallback((t: HsTask) => t.local || (!!me && t.owner === me), [me]);

  // Retry / Cancel are SERVER actions now — the job's body and creatives live on the server, so any
  // of the owner's sessions can re-queue a failed/canceled job or cancel a still-queued one. A
  // failure surfaces inline in the drawer (keyed by row id, or the bulk key); a success kicks one
  // loadRemote so the mirrored row flips without waiting a poll.
  const runQueueAction = useCallback(
    (key: string, fn: () => Promise<string[]>) => {
      setActionErrors((e) => {
        if (!e[key]) return e;
        const n = { ...e };
        delete n[key];
        return n;
      });
      fn()
        .then(() => loadRemote())
        .catch((err) => setActionErrors((e) => ({ ...e, [key]: err instanceof Error ? err.message : String(err) })));
    },
    [loadRemote],
  );

  const retry = useCallback(
    (id: string) => {
      const t = tasksRef.current.find((x) => x.id === id);
      if (!t || !isMineTask(t) || t.status !== "error" || !t.srv || !t.retry) return;
      runQueueAction(id, () => retryQueued([id]));
    },
    [isMineTask, runQueueAction],
  );

  const retryAll = useCallback(() => {
    const ids = tasksRef.current
      .filter((t) => isMineTask(t) && t.status === "error" && !!t.srv && !!t.retry)
      .map((t) => t.id);
    if (ids.length) runQueueAction("hs:retry-all", () => retryQueued(ids));
  }, [isMineTask, runQueueAction]);

  const cancel = useCallback(
    (id: string) => {
      const t = tasksRef.current.find((x) => x.id === id);
      if (!t || !isMineTask(t) || t.status !== "queued" || !t.srv) return;
      runQueueAction(id, () => cancelQueued({ taskIds: [id] }));
    },
    [isMineTask, runQueueAction],
  );

  const cancelAll = useCallback(() => {
    runQueueAction("hs:cancel-all", () => cancelQueued({ scope: "hs" }));
  }, [runQueueAction]);

  /** Owner-only removal of a TERMINAL row (error/unknown). Order matters: tombstone the id (an
   *  in-flight shared fetch can't re-add it), drop it from state (heartbeat/poll stop writing it
   *  — THAT is what breaks the delete→resurrect ping-pong, live 08-12), then delete the Strapi
   *  row. Done rows are not dismissable — real results stay as the team record. */
  const dismiss = useCallback((id: string) => {
    tombstones.current.set(id, Date.now());
    setTasks((ts) => ts.filter((t) => t.id !== id));
    setActionErrors((e) => {
      if (!e[id]) return e;
      const n = { ...e };
      delete n[id];
      return n;
    });
    void fetch(`/api/hs-tasks?taskId=${encodeURIComponent(id)}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(20_000),
    }).catch(() => {});
  }, []);

  // Est. server clock at last fetch — teammates' liveness is judged on it, not the local clock.
  const estServerNow = nowTick + skew;

  const counts = useMemo(() => {
    let active = 0,
      done = 0,
      failed = 0,
      running = 0,
      onLion = 0;
    for (const t of tasks) {
      // A dead session's non-terminal row is INTERRUPTED, not live — the row already renders it
      // "session offline"; counting it by raw status kept the badge pulsing and Active/On-LION
      // inflated forever (header contradicting the list, review find 08-17). srv rows are never
      // judged stale (the queue owns them), so they count by their real status.
      if (isStaleHsRow(t, me, estServerNow)) {
        failed++;
        continue;
      }
      if (t.status === "queued" || t.status === "running" || t.status === "submitted") active++;
      if (t.status === "running" || t.status === "submitted") running++;
      if (t.status === "submitted") onLion++;
      if (t.status === "done") done++;
      if (t.status === "error" || t.status === "unknown") failed++;
    }
    // inFlight = what still depends on THIS tab: hand-off items not yet with the server (uploading |
    // sending). A server-queued launch no longer holds the page hostage — it is not counted here.
    return { active, done, failed, running, total: tasks.length, inFlight: handoffPending, onLion };
  }, [tasks, me, estServerNow, handoffPending]);

  // The leave-page confirm while a hand-off is pending is owned by <LaunchHandoffHost/> (the one
  // surface that still needs the tab open); this manager no longer registers its own.

  const value: HsTaskManagerValue = {
    tasks,
    counts,
    me,
    estServerNow,
    open,
    setOpen,
    enqueue,
    enqueueSubmitted,
    retry,
    retryAll,
    cancel,
    cancelAll,
    dismiss,
    actionErrors,
  };

  return (
    <Ctx.Provider value={value}>
      {children}
      <HsTaskManagerPanel />
    </Ctx.Provider>
  );
}

// ---------- header button ----------

export function HsTaskManagerButton() {
  const { counts, setOpen } = useHsTaskManager();
  const badge = counts.active > 0 ? counts.active : counts.failed > 0 ? counts.failed : 0;
  const tone =
    counts.active > 0
      ? "border-launch/40 bg-launch/10 text-launch2"
      : counts.failed > 0
        ? "border-danger/40 bg-danger/10 text-danger"
        : "border-line bg-surface text-dim hover:border-line2 hover:bg-surface2 hover:text-ink";

  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label="Open HS Task Manager"
      className={
        "relative flex h-9 items-center gap-2 rounded-full border px-3 text-[13px] font-medium " +
        "transition-all duration-200 active:scale-[0.96] focus-visible:outline-none " +
        "focus-visible:ring-2 focus-visible:ring-launch/40 " +
        tone
      }
    >
      <span className="relative">
        <TasksIcon className="h-4 w-4" />
        {counts.running > 0 ? (
          <span className="animate-pulse-soft absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-launch2" />
        ) : null}
      </span>
      <span className="hidden whitespace-nowrap md:max-lg:inline min-[1360px]:inline">HS Tasks</span>
      {badge > 0 ? (
        <span
          key={badge}
          className={
            "animate-badge-pop grid h-4 min-w-4 place-items-center rounded-full px-1 font-mono text-[10px] font-semibold " +
            (counts.active > 0 ? "bg-launch text-[#032e20]" : "bg-danger text-white")
          }
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
}

// ---------- drawer ----------

type Filter = "all" | "active" | "done" | "failed";

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  // Hours show as h:mm:ss — with the 3h pending cap a wedged row would otherwise read "180:00".
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** A teammate's non-terminal row whose session stopped writing (> STALE_MS) — the "session
 *  offline" state the row renders. ONE predicate for the row, the counts, the tabs and the
 *  summary strip, so the header can never contradict the list again. */
function isStaleHsRow(t: HsTask, me: string | null, estServerNow: number): boolean {
  // The launch queue owns srv rows and reaps its own dead jobs — they are never "session offline"
  // however long between its writes (spec §4.4).
  if (t.srv) return false;
  const mine = t.local || (!!me && t.owner === me);
  const terminal = t.status === "done" || t.status === "error" || t.status === "unknown";
  return !mine && !terminal && (!t.updatedMs || estServerNow - t.updatedMs > STALE_MS);
}

function HsTaskManagerPanel() {
  const { tasks, counts, me, estServerNow, open, setOpen, retry, retryAll, cancel, cancelAll, dismiss, actionErrors } =
    useHsTaskManager();
  const [filter, setFilter] = useState<Filter>("all");
  const [mineOnly, setMineOnly] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!open || counts.running === 0) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [open, counts.running]);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, setOpen]);

  if (!open) return null;

  const staleOf = (t: HsTask) => isStaleHsRow(t, me, estServerNow);
  const inBucket = (t: HsTask): boolean =>
    filter === "all"
      ? true
      : filter === "active"
        ? (t.status === "queued" || t.status === "running" || t.status === "submitted") && !staleOf(t)
        : filter === "done"
          ? t.status === "done"
          : t.status === "error" || t.status === "unknown" || staleOf(t);

  const isMine = (t: HsTask) => t.local || (!!me && t.owner === me);
  const scoped = mineOnly ? tasks.filter(isMine) : tasks;
  const shown = scoped.filter(inBucket);
  // Retry / Cancel are server actions on MY srv rows: retryable = failed/canceled jobs the server
  // will take again; cancelable = jobs still queued on the server that I can pull.
  const retryable = tasks.filter((t) => isMine(t) && t.status === "error" && !!t.srv && !!t.retry).length;
  const cancelable = tasks.filter((t) => isMine(t) && t.status === "queued" && !!t.srv).length;

  const tabs: { key: Filter; label: string; n: number }[] = [
    { key: "all", label: "All", n: tasks.length },
    { key: "active", label: "Active", n: counts.active },
    { key: "done", label: "Done", n: counts.done },
    { key: "failed", label: "Failed", n: counts.failed },
  ];

  return (
    <div className="fixed inset-0 z-[80]">
      <div className="animate-fade-in absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={() => setOpen(false)} />
      <aside className="animate-drawer-in absolute right-0 top-0 flex h-full w-full max-w-[440px] flex-col border-l border-line bg-surface shadow-[-20px_0_60px_rgba(0,0,0,0.5)]">
        {/* header */}
        <div className="flex items-center justify-between border-b border-line px-4 py-3.5">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-launch/25 to-accent/25 text-launch2">
              <TasksIcon className="h-4 w-4" />
            </span>
            <div className="leading-none">
              <h2 className="text-[14px] font-semibold text-ink">HS Task Manager</h2>
              <p className="mt-1 text-[10px] uppercase tracking-[0.16em] text-faint">{QUEUE_RAILS_LABEL} launch queue</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-faint transition-colors hover:bg-raise hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        {/* While a wave is still handing over (creatives uploading / job being sent — useHandoffPending),
            this tab must stay open; the hand-off overlay says so and this echoes it inside the drawer.
            Once the server accepts, launches continue without this tab and the notice clears. */}
        {counts.inFlight > 0 ? (
          <div className="border-b border-line px-3 py-2">
            <UploadingNotice n={counts.inFlight} />
          </div>
        ) : null}

        {/* summary strip */}
        <div className="flex items-center gap-1.5 border-b border-line px-4 py-2.5">
          <Stat label="Active" n={counts.active} tone="text-[#9db8ff]" />
          <Stat label="On LION" n={counts.onLion} tone="text-launch2" />
          <Stat label="Done" n={counts.done} tone="text-launch2" />
          <Stat label="Failed" n={counts.failed} tone="text-danger" />
        </div>

        {/* filter tabs + mine toggle */}
        <div className="flex items-center gap-1 px-3 pt-3">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setFilter(tab.key)}
              className={
                "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors duration-150 " +
                (filter === tab.key ? "bg-raise text-ink" : "text-faint hover:text-dim")
              }
            >
              {tab.label}
              <span className="font-mono text-[10.5px] text-faint">{tab.n}</span>
            </button>
          ))}
          <button
            type="button"
            aria-pressed={mineOnly}
            onClick={() => setMineOnly((v) => !v)}
            className={
              "ml-auto rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors duration-150 " +
              (mineOnly ? "bg-accent/15 text-[#9db8ff]" : "text-faint hover:text-dim")
            }
          >
            Mine
          </button>
        </div>

        {/* list */}
        <div className="flex-1 overflow-y-auto px-3 py-3">
          {shown.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 py-16 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-surface2 text-faint">
                <TasksIcon className="h-5 w-5" />
              </span>
              <p className="text-[13px] font-medium text-dim">Nothing here yet</p>
              <p className="max-w-[250px] text-[11.5px] leading-relaxed text-faint">{EMPTY_HINT}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {shown.map((t) => (
                <HsTaskRow
                  key={t.id}
                  task={t}
                  me={me}
                  estServerNow={estServerNow}
                  now={now}
                  actionError={actionErrors[t.id]}
                  onRetry={() => retry(t.id)}
                  onCancel={() => cancel(t.id)}
                  onDismiss={() => dismiss(t.id)}
                />
              ))}
            </div>
          )}
        </div>

        {/* footer */}
        <div className="flex flex-col gap-1.5 border-t border-line px-4 py-2.5">
          {actionErrors["hs:retry-all"] || actionErrors["hs:cancel-all"] ? (
            <p className="flex items-start gap-1.5 text-[10.5px] leading-relaxed text-danger">
              <AlertIcon className="mt-px h-3 w-3 shrink-0" />
              <span className="min-w-0 break-words">{actionErrors["hs:retry-all"] || actionErrors["hs:cancel-all"]}</span>
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10.5px] text-faint">
              {counts.running > 0 ? "Processing…" : counts.active > 0 ? "Waiting in queue" : "Idle"}
            </span>
            <div className="flex items-center gap-1.5">
              {cancelable > 0 ? (
                <button
                  type="button"
                  onClick={cancelAll}
                  className="flex items-center gap-1.5 rounded-md border border-warn/30 px-2 py-1 text-[11.5px] font-medium text-warn transition-colors hover:bg-warn/10"
                >
                  <XIcon className="h-3.5 w-3.5" />
                  Cancel queued ({cancelable})
                </button>
              ) : null}
              {retryable > 0 ? (
                <button
                  type="button"
                  onClick={retryAll}
                  className="flex items-center gap-1.5 rounded-md border border-danger/30 px-2 py-1 text-[11.5px] font-medium text-danger transition-colors hover:bg-danger/10"
                >
                  <RetryIcon className="h-3.5 w-3.5" />
                  Retry failed ({retryable})
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}

/** Owner label in the shared drawer — "you" for my rows, a colour-tagged name for teammates'. */
function HsOwnerChip({ owner, mine }: { owner: string | null | undefined; mine: boolean }) {
  if (mine) return <span className="shrink-0 text-dim">you</span>;
  const name = owner || "—";
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-[1px]"
      style={{ color: `hsl(${h} 75% 72%)`, background: `hsl(${h} 70% 60% / 0.14)` }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: `hsl(${h} 75% 62%)` }} />
      {name}
    </span>
  );
}

function Stat({ label, n, tone }: { label: string; n: number; tone: string }) {
  return (
    <div className="flex flex-1 flex-col items-center rounded-lg bg-surface2/50 py-1.5">
      <span className={"font-mono text-[15px] font-semibold tabular-nums " + tone}>{n}</span>
      <span className="text-[9px] uppercase tracking-[0.14em] text-faint">{label}</span>
    </div>
  );
}

function HsTaskRow({
  task: t,
  me,
  estServerNow,
  now,
  actionError,
  onRetry,
  onCancel,
  onDismiss,
}: {
  task: HsTask;
  me: string | null;
  estServerNow: number;
  now: number;
  actionError?: string;
  onRetry: () => void;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const mine = t.local || (!!me && t.owner === me);
  const done = t.status === "done";
  // A canceled job rides back as status:"error", stage:"canceled" (spec §4.4) — show it as a neutral
  // "Canceled", not a scary failure, and let its retry flag drive the Retry affordance.
  const canceled = t.status === "error" && t.stage === CANCELED_STAGE;
  const error = t.status === "error" && !canceled;
  const unknown = t.status === "unknown";
  // Server-owned rows this user may act on.
  const canRetry = mine && !!t.srv && !!t.retry && t.status === "error";
  const canCancel = mine && !!t.srv && t.status === "queued";
  // A teammate's non-terminal task whose session stopped writing (> STALE_MS) reads as "stale" —
  // same predicate the counts/tabs use (isStaleHsRow), so header and list always agree.
  const stale = isStaleHsRow(t, me, estServerNow);
  const running = (t.status === "running" || t.status === "submitted") && !stale;
  const idx = stageIndex(t.stage);
  const end = t.finishedAt ?? now;
  const elapsed = t.startedAt ? Math.max(0, end - t.startedAt) : 0;

  // A done row that never learned its campaign (launches finalize at LION acceptance, 08-14)
  // reads "Sent to LION"; rows the pollers/pump finished keep the richer label. Token rows are
  // done only when the tree is REAL on Facebook, so they always name it.
  const adsSuffix = t.adCount ? ` · ${t.adCount} ad${t.adCount === 1 ? "" : "s"}` : "";
  const statusLabel = done
    ? t.kind === "tool"
      ? `Created via TOOL${adsSuffix} · delivery +30 min from create`
      : t.kind === "token"
        ? `Created via FB token${adsSuffix} · delivery +30 min from create`
        : t.campaignId || t.adCount
          ? `Created on LION${adsSuffix}`
          : "Sent to LION"
    : canceled
      ? "Canceled"
      : error
        ? t.error || "Failed"
        : unknown
          ? t.error || "Check LION"
          : t.status === "queued"
            ? // srv rows wait in the server lane; a plain (non-srv) queued row only exists on the
              // transient optimistic path, so still read it as queued.
              t.srv
              ? "Queued on the server"
              : "Queued"
            : t.status === "running"
              ? (t.kind === "tool"
                  ? TOOL_STAGE_LABELS[t.stage]
                  : t.kind === "token"
                    ? TOKEN_STAGE_LABELS[t.stage]
                    : STAGES[idx]?.label) ?? "Working…"
              : (t.lionStatus && LION_STAGE[t.lionStatus]?.label) || `On LION: ${t.lionStatus ?? "…"}`;

  return (
    <div
      className={
        "animate-row-in rounded-xl border bg-surface2/40 p-3 transition-colors " +
        (error ? "border-danger/30" : unknown || canceled ? "border-warn/30" : done ? "border-launch/25" : "border-line")
      }
    >
      <div className="flex items-start gap-2.5">
        <HsStatusDot status={t.status} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-medium text-ink" title={t.name}>
            {t.name || "Untitled campaign"}
          </p>
          <p className="mt-0.5 flex items-center gap-1.5 truncate font-mono text-[10.5px] text-faint">
            <HsOwnerChip owner={t.owner} mine={mine} />
            <span className="truncate">
              {(t.profile || "—").replace("globecoders-", "")} · {t.geo} · ${moneyLabel(t.budget)}
              {t.bid ? ` · ${t.bid}` : ""}
            </span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {stale ? (
            <span className="rounded-md border border-warn/25 bg-warn/5 px-1.5 py-0.5 text-[9.5px] font-medium text-warn">
              session offline
            </span>
          ) : null}
          <span className="font-mono text-[10.5px] tabular-nums text-faint">{fmtElapsed(elapsed)}</span>
          {/* Cancel is own-only and only for a job the server still has QUEUED — pull it before it
              starts (cancelQueued; a started job is never touched). */}
          {canCancel ? (
            <button
              type="button"
              onClick={onCancel}
              data-tip="Cancel queued launch"
              aria-label="Cancel queued launch"
              className="tip flex h-6 w-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-raise hover:text-warn focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {/* Retry is own-only and server-side: the job's body + creatives live on the server, so any
              of the owner's sessions re-queues it — but only a job the server still marks retryable
              (a clean error with nothing created, or a cancel). */}
          {canRetry ? (
            <button
              type="button"
              onClick={onRetry}
              data-tip="Retry"
              aria-label="Retry"
              className="tip flex h-6 w-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-raise hover:text-[#9db8ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <RetryIcon className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {/* Dismiss is own-only and TERMINAL-only (error/unknown/canceled): wedged-task cleanup.
              It also breaks the delete→resurrect ping-pong — removing the row from state stops
              the heartbeat writing it (live 08-12). Done rows stay: results are the team record. */}
          {(error || unknown || canceled) && mine ? (
            <button
              type="button"
              onClick={onDismiss}
              data-tip="Remove from list"
              aria-label="Remove from list"
              className="tip flex h-6 w-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-raise hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      {/* segmented stage bar */}
      <div className="mt-2.5 flex gap-1">
        {STAGES.map((s, i) => {
          const cls = done
            ? "bg-launch"
            : (error || unknown || canceled) && i === idx
              ? error
                ? "bg-danger"
                : "bg-warn"
              : i < idx
                ? "bg-accent"
                : running && i === idx
                  ? "bg-accent/70 animate-pulse"
                  : "bg-line2";
          return <span key={s.key} className={"h-1 flex-1 rounded-full transition-colors duration-300 " + cls} />;
        })}
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <span
          className={
            "flex items-center gap-1.5 truncate text-[11px] " +
            (done ? "text-launch2" : error ? "text-danger" : unknown || canceled ? "text-warn" : "text-dim")
          }
        >
          {error || unknown || canceled ? <AlertIcon className="h-3 w-3 shrink-0" /> : null}
          {done ? <CheckIcon className="h-3 w-3 shrink-0" /> : null}
          {running ? <RocketIcon className="h-3 w-3 shrink-0 text-[#9db8ff]" /> : null}
          <span className="truncate" title={statusLabel}>
            {statusLabel}
          </span>
        </span>
        {done && t.campaignId ? <CopyCampaignId id={t.campaignId} /> : null}
      </div>

      {/* Inline failure of a Retry / Cancel call on this row (retryQueued / cancelQueued). */}
      {actionError ? (
        <p className="mt-1.5 flex items-start gap-1.5 rounded-md border border-danger/25 bg-danger/5 px-2 py-1 text-[10.5px] leading-relaxed text-danger">
          <AlertIcon className="mt-px h-3 w-3 shrink-0" />
          <span className="min-w-0 break-words">{actionError}</span>
        </p>
      ) : null}

      {/* non-terminal LION note — their tasker keeps trying; surface as a warning, not a failure.
          Humanised notes (profile block, beneficiary wait) already read as full sentences, so
          they skip the "LION retrying" prefix. */}
      {t.status === "submitted" && t.lionNote ? (
        <p className="mt-1.5 flex items-start gap-1.5 rounded-md border border-warn/25 bg-warn/5 px-2 py-1 text-[10.5px] leading-relaxed text-warn">
          <AlertIcon className="mt-px h-3 w-3 shrink-0" />
          <span className="min-w-0 break-words">
            {/blocked this profile|launching the campaign/.test(t.lionNote)
              ? t.lionNote
              : `LION retrying: ${t.lionNote}`}
          </span>
        </p>
      ) : null}
    </div>
  );
}

function HsStatusDot({ status }: { status: HsTaskStatus }) {
  if (status === "running" || status === "submitted")
    return (
      <span className="relative mt-1 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <span className="z-10 h-2 w-2 rounded-full bg-[#9db8ff]" />
        <span className="absolute inset-0 animate-ping rounded-full bg-accent/40" />
      </span>
    );
  const color =
    status === "done" ? "bg-launch2" : status === "error" ? "bg-danger" : "bg-warn"; // queued + unknown → warn
  return <span className={"mt-1.5 h-2 w-2 shrink-0 rounded-full " + color} />;
}

function CopyCampaignId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(id);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="flex shrink-0 items-center gap-1 rounded-md border border-line bg-surface2/60 px-1.5 py-0.5 font-mono text-[10px] text-dim transition-colors hover:border-line2 hover:text-ink"
      title="Copy campaign id"
    >
      {copied ? <CheckIcon className="h-3 w-3 text-launch2" /> : <CopyIcon className="h-3 w-3" />}
      cmp {id}
    </button>
  );
}
