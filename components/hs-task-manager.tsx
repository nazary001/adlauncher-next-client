"use client";

// Independent task manager for the HS (LION) partner. Deliberately NOT the MO task manager:
// an HS launch is a single submit — LION's weapon builds campaign/adset/ads on ITS side — so the
// lifecycle is upload → submit → poll LION's creation-status. After the submit the durable state
// lives in LION (the task id), which localStorage carries across reloads; there is no Strapi row
// and no team-shared view here (v1, per owner brief: submit and show the result).

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
import { AlertIcon, CheckIcon, CopyIcon, RetryIcon, RocketIcon, TasksIcon, TrashIcon, XIcon } from "./icons";

// ---------- model ----------

export type HsTaskStatus = "queued" | "running" | "submitted" | "done" | "error" | "unknown";

export type HsTask = {
  id: string;
  name: string;
  profile: string;
  geo: string;
  budget: string;
  status: HsTaskStatus;
  /** Furthest stage key reached (drives the segmented bar). */
  stage: string;
  lionTaskId?: string;
  lionStatus?: string;
  /** Non-terminal error LION reported (its tasker retries) — shown as a warning, not a failure. */
  lionNote?: string;
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

const stageIndex = (stage: string): number => {
  const i = STAGES.findIndex((s) => s.key === stage);
  return i < 0 ? 0 : i;
};

/** LION creation-status → local stage key + human label. */
const LION_STAGE: Record<string, { key: string; label: string }> = {
  PENDING: { key: "queue", label: "Queued on LION" },
  CREATING_CAMPAIGN: { key: "campaign", label: "Creating campaign" },
  CREATING_ADSET: { key: "adset", label: "Creating ad set" },
  CREATING_ADS: { key: "ads", label: "Creating ads" },
};

// Blob uploads have no server deadline — bound them like the MO manager does.
const UPLOAD_TIMEOUT_MS = 5 * 60_000;
// LION queues tasks; a small gap keeps the submits polite without slowing waves down.
const TASK_GAP_MS = 2_000;
// Status polling cadence (drawer open / closed). One batched call covers every pending task.
const POLL_OPEN_MS = 8_000;
const POLL_CLOSED_MS = 20_000;
// NOT_FOUND right after submit can be replication lag — only settle it after a grace window.
const NOT_FOUND_GRACE_MS = 3 * 60_000;
// A task still not terminal after this long stops polling and asks the buyer to check LION.
const PENDING_CAP_MS = 60 * 60_000;

const LS_BASE = "adlauncher.hstasks";
const lsKeyFor = (user?: SessionUser) => (user?.username ? `${LS_BASE}.${user.username}` : LS_BASE);

export type HsEnqueueArgs = {
  campaign: Campaign;
  files: FileItem[];
  name: string;
  profile: string;
  geo: string;
  budget: string;
};

type HsTaskManagerValue = {
  tasks: HsTask[];
  counts: { active: number; done: number; failed: number; running: number; total: number };
  open: boolean;
  setOpen: (v: boolean) => void;
  enqueue: (args: HsEnqueueArgs) => void;
  retry: (id: string) => void;
  retryAll: () => void;
  remove: (id: string) => void;
  clearFinished: () => void;
};

const Ctx = createContext<HsTaskManagerValue | null>(null);

export function useHsTaskManager(): HsTaskManagerValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useHsTaskManager must be used within HsTaskManagerProvider");
  return v;
}

type TaskInput = { campaign: Campaign; files: FileItem[] };

// ---------- provider ----------

export function HsTaskManagerProvider({ children, user }: { children: React.ReactNode; user?: SessionUser }) {
  const lsKey = lsKeyFor(user);
  const [tasks, setTasks] = useState<HsTask[]>([]);
  const [open, setOpen] = useState(false);
  const inputs = useRef(new Map<string, TaskInput>());
  const queue = useRef<string[]>([]);
  const working = useRef(false);
  const tasksRef = useRef<HsTask[]>([]);
  const openRef = useRef(false);
  const loadedRef = useRef(false);
  const lastPollRef = useRef(0);
  const pollBusyRef = useRef(false);
  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const patch = useCallback((id: string, p: Partial<HsTask>) => {
    setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, ...p } : t)));
  }, []);

  // Restore once. Submitted tasks resume polling (the LION id is the durable handle); tasks that
  // never reached LION lost their creative blobs with the old session → interrupted.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(lsKey);
      if (raw) {
        const snap = (JSON.parse(raw) as HsTask[]).map((t): HsTask => {
          if (t.status === "queued" || t.status === "running") {
            return {
              ...t,
              local: false,
              status: "error",
              error: "Interrupted — page closed before the submit reached LION",
              finishedAt: t.finishedAt ?? Date.now(),
            };
          }
          return { ...t, local: false };
        });
        // Safe setState-in-effect: one-shot mount restore from localStorage (external system) —
        // it never re-runs (lsKey is stable per session) so it cannot cascade.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setTasks(snap);
      }
    } catch {
      /* ignore */
    }
    loadedRef.current = true;
  }, [lsKey]);

  useEffect(() => {
    if (!loadedRef.current) return;
    try {
      localStorage.setItem(lsKey, JSON.stringify(tasks));
    } catch {
      /* quota/disabled */
    }
  }, [tasks, lsKey]);

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

        // 2) One submit — LION answers fast (it just enqueues a weapon task).
        patch(id, { stage: "submit" });
        const res = await fetch("/api/hs/launch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ campaign: input.campaign, creatives: urls }),
        });
        const d = (await res.json().catch(() => null)) as
          | { ok?: boolean; lionTaskId?: string; name?: string; error?: string }
          | null;
        if (!d?.ok || !d.lionTaskId) {
          throw new Error(d?.error || `HTTP ${res.status}`);
        }
        patch(id, {
          status: "submitted",
          stage: "queue",
          lionTaskId: d.lionTaskId,
          lionStatus: "PENDING",
          ...(d.name ? { name: d.name } : {}),
          submittedAt: Date.now(),
        });
        inputs.current.delete(id); // LION owns it now — nothing left to retry locally
      } catch (e) {
        patch(id, {
          status: "error",
          finishedAt: Date.now(),
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [patch],
  );

  const pump = useCallback(async () => {
    if (working.current) return;
    working.current = true;
    try {
      while (queue.current.length) {
        const id = queue.current.shift() as string;
        await runTask(id);
        if (queue.current.length) await new Promise((r) => setTimeout(r, TASK_GAP_MS));
      }
    } finally {
      working.current = false;
    }
  }, [runTask]);

  // ---- LION status polling (one batched call for every pending task) ----

  const poll = useCallback(async () => {
    if (pollBusyRef.current) return;
    const now = Date.now();
    // Age out tasks that have been "creating" for an hour — stop burning polls, tell the buyer.
    const aged = tasksRef.current.filter(
      (t) => t.status === "submitted" && t.submittedAt && now - t.submittedAt > PENDING_CAP_MS,
    );
    for (const t of aged) {
      patch(t.id, {
        status: "unknown",
        finishedAt: t.submittedAt! + PENDING_CAP_MS,
        error: "Still not finished on LION after 60 min — check the LION dashboard",
      });
    }
    const pending = tasksRef.current.filter((t) => t.status === "submitted" && t.lionTaskId);
    if (pending.length === 0) return;
    pollBusyRef.current = true;
    try {
      const res = await fetch("/api/hs/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskIds: [...new Set(pending.map((t) => t.lionTaskId as string))] }),
      });
      const d = (await res.json().catch(() => null)) as
        | {
            ok?: boolean;
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
      setTasks((ts) =>
        ts.map((t) => {
          if (t.status !== "submitted" || !t.lionTaskId) return t;
          const r = byLionId.get(t.lionTaskId);
          if (!r) return t;
          if (r.status === "COMPLETED") {
            return {
              ...t,
              status: "done",
              stage: "ads",
              lionStatus: r.status,
              lionNote: undefined,
              campaignId: r.campaignId ?? undefined,
              adsetId: r.adsetId ?? undefined,
              adCount: r.adIds.length,
              finishedAt: Date.now(),
            };
          }
          if (r.status === "NO_COUNTRIES_LEFT") {
            return {
              ...t,
              status: "error",
              lionStatus: r.status,
              error: "LION: no eligible countries left for this campaign",
              finishedAt: Date.now(),
            };
          }
          if (r.status === "NOT_FOUND") {
            if (t.submittedAt && Date.now() - t.submittedAt > NOT_FOUND_GRACE_MS) {
              return {
                ...t,
                status: "error",
                lionStatus: r.status,
                error: "LION does not know this task (NOT_FOUND)",
                finishedAt: Date.now(),
              };
            }
            return t; // replication lag right after submit — keep waiting
          }
          const mapped = LION_STAGE[r.status];
          return {
            ...t,
            lionStatus: r.status,
            stage: mapped?.key ?? t.stage,
            // ad ids fill in while CREATING_ADS runs — show the live count early
            ...(r.adIds.length ? { adCount: r.adIds.length } : {}),
            ...(r.campaignId ? { campaignId: r.campaignId } : {}),
            lionNote: r.error ?? undefined,
          };
        }),
      );
    } catch {
      /* transient — next tick retries */
    } finally {
      pollBusyRef.current = false;
    }
  }, [patch]);

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
      inputs.current.set(id, { campaign: args.campaign, files: args.files });
      setTasks((ts) => [
        {
          id,
          name: args.name,
          profile: args.profile,
          geo: args.geo,
          budget: args.budget,
          status: "queued" as const,
          stage: "upload",
          queuedAt: Date.now(),
          local: true,
        },
        ...ts,
      ]);
      queue.current.push(id);
      void pump();
    },
    [pump],
  );

  const retry = useCallback(
    (id: string) => {
      const t = tasksRef.current.find((x) => x.id === id);
      if (!t || t.status !== "error") return;
      // Only pre-submit failures are retryable: after a successful submit LION owns the task, and a
      // re-submit would create a SECOND campaign task on their side.
      if (t.lionTaskId || !inputs.current.has(id)) return;
      if (queue.current.includes(id)) return;
      patch(id, { status: "queued", stage: "upload", error: undefined, startedAt: undefined, finishedAt: undefined });
      queue.current.push(id);
      void pump();
    },
    [patch, pump],
  );

  const retryAll = useCallback(() => {
    for (const t of tasksRef.current) {
      if (t.status === "error" && !t.lionTaskId && t.local && inputs.current.has(t.id)) retry(t.id);
    }
  }, [retry]);

  const remove = useCallback((id: string) => {
    inputs.current.delete(id);
    queue.current = queue.current.filter((q) => q !== id);
    setTasks((ts) => ts.filter((t) => t.id !== id));
  }, []);

  const clearFinished = useCallback(() => {
    setTasks((ts) => {
      for (const t of ts) {
        if (t.status === "done" || t.status === "error" || t.status === "unknown") inputs.current.delete(t.id);
      }
      return ts.filter((t) => t.status !== "done" && t.status !== "error" && t.status !== "unknown");
    });
  }, []);

  const counts = useMemo(() => {
    let active = 0,
      done = 0,
      failed = 0,
      running = 0;
    for (const t of tasks) {
      if (t.status === "queued" || t.status === "running" || t.status === "submitted") active++;
      if (t.status === "running" || t.status === "submitted") running++;
      if (t.status === "done") done++;
      if (t.status === "error" || t.status === "unknown") failed++;
    }
    return { active, done, failed, running, total: tasks.length };
  }, [tasks]);

  const value: HsTaskManagerValue = {
    tasks,
    counts,
    open,
    setOpen,
    enqueue,
    retry,
    retryAll,
    remove,
    clearFinished,
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
      <span className="hidden sm:inline">HS Tasks</span>
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
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function HsTaskManagerPanel() {
  const { tasks, counts, open, setOpen, retry, retryAll, remove, clearFinished } = useHsTaskManager();
  const [filter, setFilter] = useState<Filter>("all");
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

  const inBucket = (t: HsTask): boolean =>
    filter === "all"
      ? true
      : filter === "active"
        ? t.status === "queued" || t.status === "running" || t.status === "submitted"
        : filter === "done"
          ? t.status === "done"
          : t.status === "error" || t.status === "unknown";

  const shown = tasks.filter(inBucket);
  const retryable = tasks.filter((t) => t.status === "error" && !t.lionTaskId && t.local).length;
  const clearable = counts.done + counts.failed;

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
              <p className="mt-1 text-[10px] uppercase tracking-[0.16em] text-faint">LION launch queue</p>
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
          <Stat label="On LION" n={tasks.filter((t) => t.status === "submitted").length} tone="text-launch2" />
          <Stat label="Done" n={counts.done} tone="text-launch2" />
          <Stat label="Failed" n={counts.failed} tone="text-danger" />
        </div>

        {/* filter tabs */}
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
                HS launches land here: creatives upload, the campaign is submitted to LION and its
                weapon builds it — progress streams in live.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {shown.map((t) => (
                <HsTaskRow key={t.id} task={t} now={now} onRetry={() => retry(t.id)} onRemove={() => remove(t.id)} />
              ))}
            </div>
          )}
        </div>

        {/* footer */}
        <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2.5">
          <span className="text-[10.5px] text-faint">
            {counts.running > 0 ? "Processing…" : counts.active > 0 ? "Waiting in queue" : "Idle"}
          </span>
          <div className="flex items-center gap-1.5">
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
            <button
              type="button"
              onClick={clearFinished}
              disabled={clearable === 0}
              className="rounded-md px-2 py-1 text-[11.5px] font-medium text-dim transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
            >
              Clear finished
            </button>
          </div>
        </div>
      </aside>
    </div>
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
  now,
  onRetry,
  onRemove,
}: {
  task: HsTask;
  now: number;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const done = t.status === "done";
  const error = t.status === "error";
  const unknown = t.status === "unknown";
  const running = t.status === "running" || t.status === "submitted";
  const idx = stageIndex(t.stage);
  const end = t.finishedAt ?? now;
  const elapsed = t.startedAt ? Math.max(0, end - t.startedAt) : 0;

  const statusLabel = done
    ? `Created on LION${t.adCount ? ` · ${t.adCount} ad${t.adCount === 1 ? "" : "s"}` : ""}`
    : error
      ? t.error || "Failed"
      : unknown
        ? t.error || "Check LION"
        : t.status === "queued"
          ? "Queued"
          : t.status === "running"
            ? STAGES[idx]?.label ?? "Working…"
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
          <p className="mt-0.5 truncate font-mono text-[10.5px] text-faint">
            {(t.profile || "—").replace("globecoders-", "")} · {t.geo} · ${moneyLabel(t.budget)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="font-mono text-[10.5px] tabular-nums text-faint">{fmtElapsed(elapsed)}</span>
          {error && t.local && !t.lionTaskId ? (
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
          {done || error || unknown ? (
            <button
              type="button"
              onClick={onRemove}
              data-tip="Dismiss"
              aria-label="Dismiss"
              className="tip flex h-6 w-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-raise hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <TrashIcon className="h-3.5 w-3.5" />
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

      {/* non-terminal LION error — their tasker retries; surface it as a warning, not a failure */}
      {t.status === "submitted" && t.lionNote ? (
        <p className="mt-1.5 flex items-start gap-1.5 rounded-md border border-warn/25 bg-warn/5 px-2 py-1 text-[10.5px] leading-relaxed text-warn">
          <AlertIcon className="mt-px h-3 w-3 shrink-0" />
          <span className="min-w-0 break-words">LION retrying: {t.lionNote}</span>
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
