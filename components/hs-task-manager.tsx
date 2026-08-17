"use client";

// Independent task manager for the HS (LION) partner. Deliberately NOT the MO task manager:
// an HS launch is a single submit — LION's weapon builds campaign/adset/ads on ITS side. For
// LAUNCHES the lifecycle ENDS at LION acceptance (owner call 08-14): upload → submit → done
// ("Sent to LION"), nobody polls the weapon's answer — results are checked in LION itself, and
// the tab can close the moment the row turns green. DUPLICATES keep the full submitted → poll →
// auto-activate lifecycle (their wave pump runs it server-side; the poll here finishes what the
// pump's budget didn't). TOKEN launches (kind="token", the FB Token channel, 08-17) skip LION
// entirely: /api/hs/token-launch streams NDJSON while OUR partner-side token builds the same
// tree directly on the Graph — the row finishes with the real campaign/adset/ad ids in-request,
// nothing to poll. TEAM-SHARED (2026-08-12): every row is persisted to Strapi (the shared
// launch-task collection tagged partner="br", via /api/hs-tasks + server-side stamps in
// /api/hs/{launch,duplicate} and the token-launch stream) so the whole team sees every HS launch
// and clone. Only the owner's session polls LION + auto-activates + can retry; teammates mirror
// the store. localStorage stays as an offline fallback for my own rows.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { upload } from "@vercel/blob/client";
import { type Campaign, type FileItem, moneyLabel } from "@/lib/types";
import type { SessionUser } from "./user-menu";
import { AlertIcon, CheckIcon, CopyIcon, RetryIcon, RocketIcon, TasksIcon, XIcon } from "./icons";

// ---------- model ----------

export type HsTaskStatus = "queued" | "running" | "submitted" | "done" | "error" | "unknown";

/** Which rail a launch rides: LION's create weapon, or our own FB token straight on the Graph. */
export type HsLaunchChannel = "lion" | "token";

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
   *  "submitted" and auto-activates after COMPLETED, clones are born PAUSED) or "token" (FB
   *  Token channel — the tree is built in-request by /api/hs/token-launch, no LION lifecycle). */
  kind?: "launch" | "duplicate" | "token";
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
  error?: string;
  queuedAt: number;
  startedAt?: number;
  submittedAt?: number;
  finishedAt?: number;
  /** Created in THIS session (its creative inputs are still alive → retryable before submit). */
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

const stageIndex = (stage: string): number => {
  const i = STAGES.findIndex((s) => s.key === stage);
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
  return /roas.?average.?floor|bid constraint/i.test(raw);
}

/** LION creation-status → local stage key + human label. */
const LION_STAGE: Record<string, { key: string; label: string }> = {
  PENDING: { key: "queue", label: "Queued on LION" },
  CREATING_CAMPAIGN: { key: "campaign", label: "Creating campaign" },
  CREATING_ADSET: { key: "adset", label: "Creating ad set" },
  CREATING_ADS: { key: "ads", label: "Creating ads" },
};

// Blob uploads have no server deadline — bound them like the MO manager does.
const UPLOAD_TIMEOUT_MS = 5 * 60_000;
// Token-launch NDJSON stream cap — a hair over the route's maxDuration (300s) so the server
// always finishes (or cleanly errors) first; mirrors the MO manager's STREAM_TIMEOUT_MS.
const STREAM_TIMEOUT_MS = 330_000;
// Gap between consecutive LION submits — RANDOM 1–3s per gap (owner call 2026-08-12): a jittered
// cadence looks less bot-like and, more importantly, spacing the shots is the front-line defence
// against Facebook temporarily blocking the executor PROFILE when a whole wave fires at once.
const TASK_GAP_MIN_MS = 1_000;
const TASK_GAP_MAX_MS = 3_000;
const taskGapMs = () => TASK_GAP_MIN_MS + Math.random() * (TASK_GAP_MAX_MS - TASK_GAP_MIN_MS);
// Status polling cadence (drawer open / closed). One batched call covers every pending task.
const POLL_OPEN_MS = 8_000;
const POLL_CLOSED_MS = 20_000;
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
// teammates tell a live-but-stuck task (LION still "creating") from a dead session.
const HEARTBEAT_MS = 25_000;

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
  error: string | null;
  queued_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  updated_ms: number | null;
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
    kind: r.kind === "duplicate" ? "duplicate" : r.kind === "token" ? "token" : "launch",
    status,
    stage: r.stage || (status === "submitted" ? "queue" : "upload"),
    lionTaskId: r.lionTaskId || undefined,
    campaignId: r.campaignId || undefined,
    adsetId: r.adsetId || undefined,
    adCount: r.adCount ?? undefined,
    error:
      r.error ||
      (raw === "interrupted" ? "Interrupted — the submitting session went offline" : undefined),
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
    // A LOCAL error/unknown task with NO LION id whose remote row DOES carry one is a submit
    // whose answer got lost after landing (the server stamps the row before responding): the
    // store is the truth — adopting it resumes polling and retires any retry affordance, which
    // would double-create.
    const lostAnswer =
      !!prev?.local && (prev.status === "error" || prev.status === "unknown") && !prev.lionTaskId && !!f.lionTaskId;
    // Token twin of lostAnswer: the stream got cut client-side but the server kept building and
    // wrote its own verdict — that truth wins. An ambiguous local "unknown" adopts EITHER
    // terminal (done upgrades it, the server's error names the real failure + created ids); a
    // local clean error adopts only "done" (adopting a server error would retire a legitimate
    // pre-campaign Retry for no gain).
    const tokenSettled =
      !!prev?.local &&
      prev.kind === "token" &&
      ((prev.status === "unknown" && (f.status === "done" || f.status === "error")) ||
        (prev.status === "error" && f.status === "done"));
    byId.set(
      f.id,
      prev && prev.local && !lostAnswer && !tokenSettled ? prev : prev && prev.updatedMs === f.updatedMs ? prev : f,
    );
  }
  // Local tasks absent from the fetch stay; ids already decided above keep that decision.
  for (const c of cur) if (c.local && !byId.has(c.id)) byId.set(c.id, c);
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
  retry: (id: string) => void;
  retryAll: () => void;
  /** Owner-only removal of a terminal error/unknown row (wedged-task cleanup). */
  dismiss: (id: string) => void;
};

const Ctx = createContext<HsTaskManagerValue | null>(null);

export function useHsTaskManager(): HsTaskManagerValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useHsTaskManager must be used within HsTaskManagerProvider");
  return v;
}

type TaskInput = { campaign: Campaign; files: FileItem[]; channel: HsLaunchChannel };

// ---------- provider ----------

export function HsTaskManagerProvider({ children, user }: { children: React.ReactNode; user?: SessionUser }) {
  const lsKey = lsKeyFor(user);
  const me = user?.username ?? null;
  const [tasks, setTasks] = useState<HsTask[]>([]);
  const [open, setOpen] = useState(false);
  const [skew, setSkew] = useState(0);
  const skewRef = useRef(0);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const inputs = useRef(new Map<string, TaskInput>());
  const queue = useRef<string[]>([]);
  const working = useRef(false);
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
        setTasks((cur) => mergeShared(cur, fetched, tomb));
      })
      .catch(() => {});
  }, [noteSkew]);

  // Restore once: the team's Strapi rows win; localStorage is the offline fallback for my own.
  useEffect(() => {
    let localSnap: HsTask[] = [];
    try {
      const raw = localStorage.getItem(lsKey);
      if (raw) {
        localSnap = (JSON.parse(raw) as HsTask[]).map((t): HsTask =>
          t.status === "queued" || t.status === "running"
            ? {
                ...t,
                local: false,
                status: "error",
                // Token runs continue SERVER-side after the page dies — the shared row (which the
                // fetch below merges over this snapshot) is the truth; this text only survives for
                // runs that died before reaching the server.
                error:
                  t.kind === "token"
                    ? "Interrupted — page closed mid-launch; check this row / Ads Manager before re-firing"
                    : "Interrupted — page closed before the submit reached LION",
                finishedAt: t.finishedAt ?? Date.now(),
              }
            : { ...t, local: false },
        );
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
  // SERVER-MANAGED rows are skipped: batch-duplicate rows are progressed by the /api/hs/duplicate
  // pump, and ADOPTED token rows by their launch route's own beat — a heartbeat here would race
  // those writers with this tab's stale copy, and worse, keep a DEAD server run looking alive
  // (rowFresh) so the age-out cap never fires. Their liveness signal is the server's own writes;
  // only rows BORN in this tab (local) heartbeat for the token kind.
  useEffect(() => {
    const iv = window.setInterval(() => {
      if (document.hidden) return;
      for (const t of tasksRef.current) {
        const mine = t.local || (!!me && t.owner === me);
        const serverManaged = !t.local && (t.kind === "duplicate" || t.kind === "token");
        if (mine && !serverManaged && (t.status === "queued" || t.status === "running" || t.status === "submitted")) {
          saveRemote(t.id, dynOf(t));
        }
      }
    }, HEARTBEAT_MS);
    return () => window.clearInterval(iv);
  }, [me, saveRemote, dynOf]);

  // ---- worker (single-flight) ----

  const runTask = useCallback(
    async (id: string) => {
      const input = inputs.current.get(id);
      if (!input) return;
      const startedAt = Date.now();
      patch(id, { status: "running", stage: "upload", startedAt, error: undefined });
      try {
        // 1) Turn every creative into a public URL. Files dropped locally live behind blob: URLs →
        //    push them to Vercel Blob; URL-added creatives (https) pass straight through — LION
        //    downloads them itself.
        const media = input.files.filter((f) => f.kind === "video" || f.kind === "image");
        if (media.length === 0) throw new Error("no creatives on the card");
        // FB Token rail builds the whole tree inside one serverless window — cap creatives BEFORE
        // uploading anything (the server enforces the same limit; failing here saves the uploads).
        if (input.channel === "token" && media.length > 10) {
          throw new Error("the FB Token rail builds at most 10 ads per campaign — trim the creatives or use the LION rail");
        }
        const urls: string[] = [];
        for (let i = 0; i < media.length; i++) {
          const f = media[i];
          if (/^https?:\/\//i.test(f.url)) {
            urls.push(f.url);
            continue;
          }
          const fallbackType = f.kind === "image" ? "image/jpeg" : "video/mp4";
          const blob = await fetch(f.url).then((r) => r.blob());
          const file = new File([blob], f.name || `creative-${i}`, { type: blob.type || fallbackType });
          const safeName = (file.name || `creative-${i}`).replace(/[^\w.-]+/g, "_");
          const abort = new AbortController();
          const timer = window.setTimeout(() => abort.abort(), UPLOAD_TIMEOUT_MS);
          try {
            const { url } = await upload(`creatives/hs-${id}-${i}-${safeName}`, file, {
              access: "public",
              contentType: file.type || fallbackType,
              handleUploadUrl: "/api/blob-upload",
              abortSignal: abort.signal,
            });
            urls.push(url);
          } catch (e) {
            throw abort.signal.aborted
              ? new Error(`creative upload timed out after ${UPLOAD_TIMEOUT_MS / 60_000} min — retry`)
              : e;
          } finally {
            window.clearTimeout(timer);
          }
        }

        // 2a) FB Token rail: /api/hs/token-launch builds the whole tree in-request and streams
        // NDJSON stage events — consume them like the MO manager does, then settle on the final
        // ok/error event. No LION lifecycle: done here means the campaign EXISTS on Facebook.
        if (input.channel === "token") {
          patch(id, { stage: "submit" });
          const creatives = media.map((f, i) => ({
            url: urls[i],
            kind: f.kind === "image" ? "image" : "video",
            name: f.name || "",
          }));
          const streamAbort = new AbortController();
          const streamTimer = window.setTimeout(() => streamAbort.abort(), STREAM_TIMEOUT_MS);
          let final: Record<string, unknown> | null = null;
          let resStatus = 0;
          let lastStage = "submit";
          // Transport-class failure (network cut / timeout mid-stream): AMBIGUOUS — the server
          // keeps building and writes the shared row itself, so this must NOT become a retryable
          // error (a re-fire could build a second tree). Captured separately from a clean
          // `ok:false` final, which IS a real per-launch verdict.
          let transportError: string | null = null;
          try {
            const res = await fetch("/api/hs/token-launch", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ campaign: input.campaign, creatives, taskId: id }),
              signal: streamAbort.signal,
            });
            resStatus = res.status;
            const handle = (line: string) => {
              let ev: Record<string, unknown>;
              try {
                ev = JSON.parse(line);
              } catch {
                return;
              }
              if (ev.ok === true || ev.ok === false) {
                final = ev;
                return;
              }
              if (typeof ev.stage === "string") {
                lastStage = ev.stage;
                patch(id, { stage: ev.stage, ...(typeof ev.done === "number" ? { adCount: ev.done } : {}) });
              }
            };
            if (res.body) {
              const reader = res.body.getReader();
              const dec = new TextDecoder();
              let buf = "";
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                let nl: number;
                while ((nl = buf.indexOf("\n")) >= 0) {
                  const line = buf.slice(0, nl).trim();
                  buf = buf.slice(nl + 1);
                  if (line) handle(line);
                }
              }
              if (buf.trim()) handle(buf.trim());
            } else {
              final = await res.json().catch(() => null);
            }
          } catch (e) {
            transportError = streamAbort.signal.aborted
              ? `stream timed out after ${STREAM_TIMEOUT_MS / 60_000} min`
              : ((e as Error).message ?? String(e));
          } finally {
            window.clearTimeout(streamTimer);
          }

          const f = final as Record<string, unknown> | null;
          if (f && f.ok === true) {
            const finishedAt = Date.now();
            const adCount = Array.isArray(f.ad_ids) ? f.ad_ids.length : media.length;
            const nm = typeof f.name === "string" ? f.name : undefined;
            patch(id, {
              status: "done",
              stage: "ads",
              finishedAt,
              campaignId: f.campaign_id ? String(f.campaign_id) : undefined,
              adsetId: f.adset_id ? String(f.adset_id) : undefined,
              adCount,
              ...(nm ? { name: nm } : {}),
            });
            if (nm) meta.current.set(id, { ...(meta.current.get(id) ?? {}), name: nm });
            saveRemote(id, {
              status: "done",
              stage: "ads",
              started_at: startedAt,
              finished_at: finishedAt,
              campaign_id: f.campaign_id ?? null,
              adset_id: f.adset_id ?? null,
              ad_id: String(adCount), // string column — see dynOf
              error: null,
            });
            inputs.current.delete(id); // the tree exists — never re-run
          } else if (f) {
            // Clean per-launch rejection from the server — a real verdict, retryable only while
            // nothing landed on Facebook.
            const finishedAt = Date.now();
            const msg = (f.error as string) || `HTTP ${resStatus}`;
            const created = ((f.created ?? {}) as Record<string, unknown>) || {};
            const createdCampaign = created.campaign_id ? String(created.campaign_id) : undefined;
            patch(id, {
              status: "error",
              stage: lastStage,
              finishedAt,
              error: msg,
              ...(createdCampaign ? { campaignId: createdCampaign } : {}),
              ...(created.adset_id ? { adsetId: String(created.adset_id) } : {}),
            });
            saveRemote(id, {
              status: "error",
              stage: lastStage,
              started_at: startedAt,
              finished_at: finishedAt,
              error: msg,
              ...(createdCampaign ? { campaign_id: createdCampaign } : {}),
              ...(created.adset_id ? { adset_id: created.adset_id } : {}),
            });
            // A created campaign makes a blind retry a DUPLICATE tree — drop the inputs so the
            // Retry affordance disappears (same rule as the MO manager).
            if (createdCampaign) inputs.current.delete(id);
          } else {
            // No final event: the connection was cut or the stream ended without a verdict
            // (server timeout). The build may have finished server-side — the shared row is the
            // truth (the server writes it to the end, and mergeShared adopts its done/error over
            // this), so this settles as terminal-unknown with NO retry affordance. No remote
            // write either: the row (whatever the server managed to write) is already more
            // truthful than "unknown".
            const msg = `Connection lost mid-build${transportError ? ` (${transportError})` : ` (HTTP ${resStatus})`} — check this row / Ads Manager before re-firing`;
            patch(id, { status: "unknown", stage: lastStage, finishedAt: Date.now(), error: msg });
            inputs.current.delete(id); // never offer a one-click re-fire of an ambiguous outcome
          }
          return;
        }

        // 2b) One submit — LION answers fast (it just enqueues a weapon task). taskId lets the
        // server stamp the shared row the instant LION accepts it (durability).
        patch(id, { stage: "submit" });
        let res: Response;
        try {
          res = await fetch("/api/hs/launch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ campaign: input.campaign, creatives: urls, taskId: id }),
            signal: AbortSignal.timeout(90_000),
          });
        } catch (e) {
          // NETWORK-class failure (cut / timeout): ambiguous — the server may have already landed
          // this create on LION (where it is exactly-once and will NOT be re-sent). A one-click
          // Retry here could build a SECOND campaign (review 08-14), so this is terminal-unknown,
          // not a retryable error. If the submit DID land, the server-stamped shared row carries
          // the LION id and mergeShared adopts it over this task within seconds — polling then
          // finishes the story. No remote write: the row (if any) is already more truthful.
          const msg = `Connection lost mid-submit — check this row in HS Tasks / LION before re-firing (${
            (e as Error).message ?? e
          })`;
          patch(id, { status: "unknown", finishedAt: Date.now(), error: msg });
          inputs.current.delete(id); // never offer a one-click resubmit of an ambiguous outcome
          return;
        }
        const d = (await res.json().catch(() => null)) as
          | { ok?: boolean; lionTaskId?: string; name?: string; error?: string }
          | null;
        if (!d?.ok || !d.lionTaskId) {
          throw new Error(d?.error || `HTTP ${res.status}`);
        }
        // LION accepted = FINAL for launches (owner call 08-14): nobody babysits the weapon's
        // answer — the row goes green here and the result is checked in LION itself. (Duplicates
        // keep their submitted→poll lifecycle; their pump auto-activates born-PAUSED clones.)
        const submittedAt = Date.now();
        const nm = d.name ?? undefined;
        patch(id, {
          status: "done",
          stage: "queue",
          lionTaskId: d.lionTaskId,
          ...(nm ? { name: nm } : {}),
          submittedAt,
          finishedAt: submittedAt,
        });
        if (nm) meta.current.set(id, { ...(meta.current.get(id) ?? {}), name: nm });
        saveRemote(id, {
          status: "done",
          stage: "queue",
          link: d.lionTaskId,
          started_at: submittedAt,
          finished_at: submittedAt,
        });
        inputs.current.delete(id); // LION owns it now — nothing left to retry locally
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        patch(id, { status: "error", finishedAt: Date.now(), error: msg });
        saveRemote(id, { status: "error", error: msg, finished_at: Date.now() });
      }
    },
    [patch, saveRemote],
  );

  const pump = useCallback(async () => {
    if (working.current) return;
    working.current = true;
    try {
      while (queue.current.length) {
        const id = queue.current.shift() as string;
        await runTask(id);
        // Re-rolled 1–3s per gap so every next submit lands on its own jitter.
        if (queue.current.length) await new Promise((r) => setTimeout(r, taskGapMs()));
      }
    } finally {
      working.current = false;
    }
  }, [runTask]);

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
            : t.kind === "token"
              ? "Interrupted — the launching session went offline mid-build; check Ads Manager before re-firing"
              : "Interrupted — the submitting session closed before this launch reached LION; fire the card again"
          : "Still not finished on LION after 3 h — check the LION dashboard";
        const status = neverSubmitted ? ("error" as const) : ("unknown" as const);
        patch(t.id, { status, finishedAt, error });
        saveRemote(t.id, dynOf({ ...t, status, finishedAt, error }));
      }
    }
    if (pollBusyRef.current) return;
    const pending = tasksRef.current.filter((t) => mine(t) && t.status === "submitted" && t.lionTaskId);
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

  // ---- actions ----

  const enqueue = useCallback(
    (args: HsEnqueueArgs) => {
      const id =
        (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)) + Date.now().toString(36);
      const now = Date.now();
      const channel: HsLaunchChannel = args.channel === "token" ? "token" : "lion";
      const kind = channel === "token" ? ("token" as const) : ("launch" as const);
      inputs.current.set(id, { campaign: args.campaign, files: args.files, channel });
      meta.current.set(id, { name: args.name, geo: args.geo, budget: args.budget, gcm: kind });
      setTasks((ts) => [
        {
          id,
          name: args.name,
          profile: args.profile,
          geo: args.geo,
          budget: args.budget,
          owner: me,
          kind,
          status: "queued" as const,
          stage: "upload",
          queuedAt: now,
          local: true,
        },
        ...ts,
      ]);
      // Show the queued row to the team immediately; the runner's submit (LION) or the token
      // stream fills in the rest.
      saveRemote(id, { status: "queued", stage: "upload", gcm: kind, queued_at: now });
      queue.current.push(id);
      void pump();
    },
    [pump, me, saveRemote],
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
        meta.current.set(id, { name: r.name, geo: r.geo, budget: r.budget, gcm: "duplicate" });
        return {
          id,
          name: r.name,
          profile: r.profile,
          geo: r.geo,
          budget: r.budget,
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

  const retry = useCallback(
    (id: string) => {
      const t = tasksRef.current.find((x) => x.id === id);
      if (!t || t.status !== "error") return;
      // Only pre-submit failures are retryable: after a successful submit LION owns the task, and a
      // re-submit would create a SECOND campaign task on their side. Same on the token rail once a
      // campaign id exists — the tree (or part of it) is live on Facebook.
      if (t.lionTaskId || t.campaignId || !inputs.current.has(id)) return;
      if (queue.current.includes(id)) return;
      patch(id, { status: "queued", stage: "upload", error: undefined, startedAt: undefined, finishedAt: undefined });
      saveRemote(id, { status: "queued", stage: "upload", error: null, finished_at: null });
      queue.current.push(id);
      void pump();
    },
    [patch, pump, saveRemote],
  );

  const retryAll = useCallback(() => {
    for (const t of tasksRef.current) {
      if (t.status === "error" && !t.lionTaskId && !t.campaignId && t.local && inputs.current.has(t.id)) retry(t.id);
    }
  }, [retry]);

  /** Owner-only removal of a TERMINAL row (error/unknown). Order matters: tombstone the id (an
   *  in-flight shared fetch can't re-add it), drop it from state (heartbeat/poll stop writing it
   *  — THAT is what breaks the delete→resurrect ping-pong, live 08-12), then delete the Strapi
   *  row. Done rows are not dismissable — real results stay as the team record. */
  const dismiss = useCallback((id: string) => {
    tombstones.current.set(id, Date.now());
    setTasks((ts) => ts.filter((t) => t.id !== id));
    inputs.current.delete(id);
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
      inFlight = 0,
      onLion = 0;
    for (const t of tasks) {
      // A dead session's non-terminal row is INTERRUPTED, not live — the row already renders it
      // "session offline"; counting it by raw status kept the badge pulsing and Active/On-LION
      // inflated forever (header contradicting the list, review find 08-17).
      if (isStaleHsRow(t, me, estServerNow)) {
        failed++;
        continue;
      }
      if (t.status === "queued" || t.status === "running" || t.status === "submitted") active++;
      if (t.status === "running" || t.status === "submitted") running++;
      if (t.status === "submitted") onLion++;
      if (t.status === "done") done++;
      if (t.status === "error" || t.status === "unknown") failed++;
      // Launches still CLIENT-side (queued behind the pump, or running their upload/stream) die
      // with this page — unlike "submitted" (LION owns it) or terminal rows. THIS tab's own
      // tasks only: teammates' rows and restored snapshots don't hold this page hostage.
      if (t.local && (t.status === "queued" || t.status === "running")) inFlight++;
    }
    return { active, done, failed, running, total: tasks.length, inFlight, onLion };
  }, [tasks, me, estServerNow]);

  // Closing the page while launches are still client-side kills them (queued rows never fire;
  // an upload dies mid-flight) — the native leave-confirm is the hard stop behind the floating
  // banner. Registered only while something is actually in flight, so normal navigation stays
  // silent the rest of the time.
  useEffect(() => {
    if (counts.inFlight === 0) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ""; // legacy field — without it some Chromium builds skip the dialog
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [counts.inFlight]);

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
    dismiss,
  };

  return (
    <Ctx.Provider value={value}>
      {children}
      {!open && counts.inFlight > 0 ? (
        <HsLaunchingBanner n={counts.inFlight} onOpen={() => setOpen(true)} />
      ) : null}
      <HsTaskManagerPanel />
    </Ctx.Provider>
  );
}

/** Floating guard for launches still CLIENT-side while the drawer is hidden: the page must stay
 *  open or queued/uploading campaigns die with it (the beforeunload confirm above is the hard
 *  stop; this is the visible one). Clicking re-opens the Task Manager. Disappears by itself the
 *  moment every launch is handed off (submitted/done/error). */
function HsLaunchingBanner({ n, onOpen }: { n: number; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-live="polite"
      className={
        "animate-pop-in fixed bottom-5 left-1/2 z-[70] flex -translate-x-1/2 items-center gap-2.5 " +
        "rounded-full border border-warn/45 bg-surface/95 py-2 pl-3 pr-2 " +
        "shadow-[0_12px_40px_rgba(0,0,0,0.55)] backdrop-blur-md transition-all duration-150 " +
        "hover:border-warn/70 hover:bg-surface2 active:scale-[0.98] " +
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warn/40"
      }
    >
      <span className="relative flex h-3 w-3 shrink-0 items-center justify-center">
        <span className="z-10 h-2 w-2 rounded-full bg-warn" />
        <span className="absolute inset-0 animate-ping rounded-full bg-warn/50" />
      </span>
      <span className="whitespace-nowrap text-[12.5px] font-semibold text-warn">
        {n === 1 ? "1 campaign is still launching" : `${n} campaigns are still launching`}
        <span className="font-medium text-dim"> · keep this page open</span>
      </span>
      <span className="ml-1 shrink-0 rounded-full border border-line bg-surface2 px-2 py-0.5 text-[10.5px] font-medium text-dim">
        View
      </span>
    </button>
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
      <span className="hidden whitespace-nowrap sm:inline">HS Tasks</span>
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
  const mine = t.local || (!!me && t.owner === me);
  const terminal = t.status === "done" || t.status === "error" || t.status === "unknown";
  return !mine && !terminal && (!t.updatedMs || estServerNow - t.updatedMs > STALE_MS);
}

function HsTaskManagerPanel() {
  const { tasks, counts, me, estServerNow, open, setOpen, retry, retryAll, dismiss } = useHsTaskManager();
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
  const retryable = tasks.filter((t) => t.status === "error" && !t.lionTaskId && !t.campaignId && t.local).length;

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
              <p className="mt-1 text-[10px] uppercase tracking-[0.16em] text-faint">LION · FB token launch queue</p>
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
              <p className="max-w-[250px] text-[11.5px] leading-relaxed text-faint">
                HS launches land here. LION rail: a green row means LION accepted it — the build
                finishes on LION&apos;s side. FB token rail: a green row means the campaign is
                already live on Facebook (delivery starts 30 min after create).
              </p>
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
                  onRetry={() => retry(t.id)}
                  onDismiss={() => dismiss(t.id)}
                />
              ))}
            </div>
          )}
        </div>

        {/* footer */}
        <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2.5">
          <span className="text-[10.5px] text-faint">
            {counts.running > 0 ? "Processing…" : counts.active > 0 ? "Waiting in queue" : "Idle"}
          </span>
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
  onRetry,
  onDismiss,
}: {
  task: HsTask;
  me: string | null;
  estServerNow: number;
  now: number;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const mine = t.local || (!!me && t.owner === me);
  const done = t.status === "done";
  const error = t.status === "error";
  const unknown = t.status === "unknown";
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
    ? t.kind === "token"
      ? `Created via FB token${adsSuffix} · delivery +30 min from create`
      : t.campaignId || t.adCount
        ? `Created on LION${adsSuffix}`
        : "Sent to LION"
    : error
      ? t.error || "Failed"
      : unknown
        ? t.error || "Check LION"
        : t.status === "queued"
          ? "Queued"
          : t.status === "running"
            ? (t.kind === "token" ? TOKEN_STAGE_LABELS[t.stage] : STAGES[idx]?.label) ?? "Working…"
            : (t.lionStatus && LION_STAGE[t.lionStatus]?.label) || `On LION: ${t.lionStatus ?? "…"}`;

  return (
    <div
      className={
        "animate-row-in rounded-xl border bg-surface2/40 p-3 transition-colors " +
        (error ? "border-danger/30" : unknown ? "border-warn/30" : done ? "border-launch/25" : "border-line")
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
          {/* Retry is own-only (needs the local creative inputs) and only while nothing landed
              on the other side — no LION task, no token-rail campaign. */}
          {error && t.local && !t.lionTaskId && !t.campaignId ? (
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
          {/* Dismiss is own-only and TERMINAL-failure-only (error/unknown): wedged-task cleanup.
              It also breaks the delete→resurrect ping-pong — removing the row from state stops
              the heartbeat writing it (live 08-12). Done rows stay: results are the team record. */}
          {(error || unknown) && mine ? (
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
            : (error || unknown) && i === idx
              ? unknown
                ? "bg-warn"
                : "bg-danger"
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
            (done ? "text-launch2" : error ? "text-danger" : unknown ? "text-warn" : "text-dim")
          }
        >
          {error || unknown ? <AlertIcon className="h-3 w-3 shrink-0" /> : null}
          {done ? <CheckIcon className="h-3 w-3 shrink-0" /> : null}
          {running ? <RocketIcon className="h-3 w-3 shrink-0 text-[#9db8ff]" /> : null}
          <span className="truncate" title={statusLabel}>
            {statusLabel}
          </span>
        </span>
        {done && t.campaignId ? <CopyCampaignId id={t.campaignId} /> : null}
      </div>

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
