"use client";

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
import { type Campaign, moneyLabel } from "@/lib/types";
import type { PartnerId } from "@/lib/partners";
import { AlertIcon, CheckIcon, CopyIcon, RetryIcon, RocketIcon, TasksIcon, TrashIcon, XIcon } from "./icons";

// ---------- stages ("upload" is client→Blob; the rest mirror /api/launch events) ----------

const STAGES = [
  { key: "upload", label: "Uploading video" },
  { key: "gcm", label: "Reserving code" },
  { key: "video", label: "Registering video" },
  { key: "processing", label: "Processing video" },
  { key: "campaign", label: "Creating campaign" },
  { key: "adset", label: "Creating ad set" },
  { key: "creative", label: "Building creative" },
  { key: "ad", label: "Publishing ad" },
] as const;
type StageKey = (typeof STAGES)[number]["key"];
const STAGE_INDEX: Record<string, number> = Object.fromEntries(STAGES.map((s, i) => [s.key, i]));

// ---------- task model ----------

type TaskStatus = "queued" | "running" | "done" | "error";

type LaunchInput = {
  partnerId: PartnerId;
  campaign: Campaign;
  videoUrl: string;
  videoName: string;
};

export type LaunchTask = {
  id: string;
  name: string;
  gcm: string;
  geo: string;
  budget: string;
  status: TaskStatus;
  stage: StageKey | null;
  result?: { campaignId?: string; adsetId?: string; adId?: string; gcm?: string; link?: string };
  error?: string;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Created this session (has its video → can be retried). Restored rows are false. */
  local?: boolean;
};

/** A Strapi/localStorage row → in-memory task. */
function fromRemote(r: Record<string, unknown>): LaunchTask {
  const n = (v: unknown) => (v == null || v === "" ? undefined : Number(v));
  const s = (v: unknown) => (v == null ? undefined : String(v));
  return {
    id: String(r.id ?? r.task_id ?? ""),
    name: s(r.name) ?? "",
    gcm: s(r.gcm) ?? "",
    geo: s(r.geo) ?? "",
    budget: s(r.budget) ?? "",
    status: (s(r.status) ?? "queued") as TaskStatus,
    stage: (s(r.stage) ?? null) as StageKey | null,
    result:
      r.campaign_id || r.ad_id || r.link
        ? { campaignId: s(r.campaign_id), adsetId: s(r.adset_id), adId: s(r.ad_id), gcm: s(r.gcm), link: s(r.link) }
        : undefined,
    error: s(r.error),
    queuedAt: n(r.queued_at) ?? Date.now(),
    startedAt: n(r.started_at),
    finishedAt: n(r.finished_at),
  };
}

/** On restore, anything not terminal was cut off by the reload → mark interrupted (shown as a
 *  non-retryable error). Restored tasks lose their video, so `local` is always false. */
function asRestored(t: LaunchTask): LaunchTask {
  if (t.status === "done" || t.status === "error") return { ...t, local: false };
  return {
    ...t,
    status: "error",
    error: "Interrupted by page reload — relaunch to retry",
    finishedAt: t.finishedAt ?? t.startedAt ?? t.queuedAt,
    local: false,
  };
}

const LS_KEY = "adlauncher.tasks";

export type EnqueueArgs = LaunchInput & { name: string; gcm: string; geo: string; budget: string };

type TaskManagerValue = {
  tasks: LaunchTask[];
  counts: { queued: number; running: number; done: number; error: number; active: number; total: number };
  open: boolean;
  setOpen: (v: boolean) => void;
  enqueue: (args: EnqueueArgs) => void;
  retry: (id: string) => void;
  retryAll: () => void;
  remove: (id: string) => void;
  clearDone: () => void;
  clearFinished: () => void;
};

const Ctx = createContext<TaskManagerValue | null>(null);

export function useTaskManager(): TaskManagerValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTaskManager must be used within TaskManagerProvider");
  return v;
}

// ---------- provider (single-concurrency worker) ----------

export function TaskManagerProvider({ children }: { children: React.ReactNode }) {
  const [tasks, setTasks] = useState<LaunchTask[]>([]);
  const [open, setOpen] = useState(false);
  const inputs = useRef(new Map<string, LaunchInput>());
  const queue = useRef<string[]>([]);
  const working = useRef(false);
  const tasksRef = useRef<LaunchTask[]>([]);
  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  const patch = useCallback((id: string, p: Partial<LaunchTask>) => {
    setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, ...p } : t)));
  }, []);

  // ---- persistence: Strapi (source of truth) + localStorage (offline fallback) ----
  const meta = useRef(new Map<string, Record<string, unknown>>()); // static fields per task
  const saveChains = useRef(new Map<string, Promise<unknown>>()); // serialize saves per task
  const loadedRef = useRef(false);

  /** Upsert one task's state to Strapi. Non-blocking for the caller, but chained PER TASK so
   *  queued→running→done apply in order (no racing creates that would drop fields). */
  const saveRemote = useCallback((id: string, dyn: Record<string, unknown>) => {
    const payload = { task_id: id, ...(meta.current.get(id) ?? {}), ...dyn };
    const prev = saveChains.current.get(id) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() =>
        fetch("/api/launch-tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }).catch(() => {}),
      );
    saveChains.current.set(id, next);
  }, []);

  const deleteRemote = useCallback((ids: string[]) => {
    if (!ids.length) return;
    fetch(`/api/launch-tasks?taskIds=${ids.map(encodeURIComponent).join(",")}`, { method: "DELETE" }).catch(
      () => {},
    );
  }, []);

  // Restore once on mount: Strapi wins; localStorage is the offline fallback. Snapshot local
  // synchronously first so the persist effect below can't clobber it before we read it.
  useEffect(() => {
    let localSnap: LaunchTask[] = [];
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) localSnap = JSON.parse(raw) as LaunchTask[];
    } catch {
      /* ignore */
    }
    let alive = true;
    fetch("/api/launch-tasks")
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        const rows: LaunchTask[] =
          d?.ok && Array.isArray(d.tasks) ? (d.tasks as Record<string, unknown>[]).map(fromRemote) : localSnap;
        setTasks(rows.map(asRestored));
      })
      .catch(() => {
        if (alive) setTasks(localSnap.map(asRestored));
      })
      .finally(() => {
        loadedRef.current = true;
      });
    return () => {
      alive = false;
    };
  }, []);

  // Mirror to localStorage after the initial load (guard prevents the empty first render from
  // wiping the stored snapshot before restore reads it).
  useEffect(() => {
    if (!loadedRef.current) return;
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(tasks));
    } catch {
      /* quota / disabled — Strapi still holds the durable copy */
    }
  }, [tasks]);

  const runTask = useCallback(
    async (id: string) => {
      const input = inputs.current.get(id);
      if (!input) return;
      const startedAt = Date.now();
      patch(id, { status: "running", stage: "upload", startedAt, error: undefined });
      saveRemote(id, { status: "running", stage: "upload", started_at: startedAt });
      try {
        // Recover the video bytes from the (session-lived) object URL captured at enqueue.
        const blob = await fetch(input.videoUrl).then((r) => r.blob());
        const file = new File([blob], input.videoName || "creative.mp4", {
          type: blob.type || "video/mp4",
        });

        // Upload the creative straight to Vercel Blob — this bypasses the serverless request-body
        // limit (~4.5MB) entirely. The launch route then gets just the URL and FB pulls the video
        // from it via file_url.
        const safeName = (file.name || "creative.mp4").replace(/[^\w.-]+/g, "_");
        const { url: videoUrl } = await upload(`creatives/${id}-${safeName}`, file, {
          access: "public",
          contentType: file.type || "video/mp4",
          handleUploadUrl: "/api/blob-upload",
        });

        const res = await fetch("/api/launch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ partnerId: input.partnerId, campaign: input.campaign, videoUrl }),
        });

        let final: Record<string, unknown> | null = null;
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
          if (typeof ev.stage === "string") patch(id, { stage: ev.stage as StageKey });
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

        const f = final as Record<string, unknown> | null;
        if (f && f.ok === true) {
          const finishedAt = Date.now();
          patch(id, {
            status: "done",
            stage: "ad",
            finishedAt,
            result: {
              campaignId: f.campaign_id as string,
              adsetId: f.adset_id as string,
              adId: f.ad_id as string,
              gcm: f.gcm as string,
              link: f.link as string,
            },
          });
          saveRemote(id, {
            status: "done",
            stage: "ad",
            finished_at: finishedAt,
            campaign_id: f.campaign_id,
            adset_id: f.adset_id,
            ad_id: f.ad_id,
            link: f.link,
            gcm: f.gcm,
          });
        } else {
          const finishedAt = Date.now();
          const msg = (f && ((f.error as string) || (f.stage as string))) || `HTTP ${res.status}`;
          patch(id, { status: "error", finishedAt, error: msg });
          saveRemote(id, { status: "error", finished_at: finishedAt, error: msg });
        }
      } catch (e) {
        const finishedAt = Date.now();
        patch(id, { status: "error", finishedAt, error: String(e) });
        saveRemote(id, { status: "error", finished_at: finishedAt, error: String(e) });
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
      }
    } finally {
      working.current = false;
    }
  }, [runTask]);

  const enqueue = useCallback(
    (args: EnqueueArgs) => {
      const id =
        (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)) + Date.now().toString(36);
      const queuedAt = Date.now();
      inputs.current.set(id, {
        partnerId: args.partnerId,
        campaign: args.campaign,
        videoUrl: args.videoUrl,
        videoName: args.videoName,
      });
      // static fields reused on every remote upsert for this task
      meta.current.set(id, {
        name: args.name,
        partner: args.partnerId,
        gcm: args.gcm,
        geo: args.geo,
        budget: args.budget,
        queued_at: queuedAt,
      });
      setTasks((ts) => [
        {
          id,
          name: args.name,
          gcm: args.gcm,
          geo: args.geo,
          budget: args.budget,
          status: "queued",
          stage: null,
          queuedAt,
          local: true,
        },
        ...ts,
      ]);
      saveRemote(id, { status: "queued" });
      queue.current.push(id);
      void pump();
    },
    [pump, saveRemote],
  );

  const retry = useCallback(
    (id: string) => {
      patch(id, {
        status: "queued",
        stage: null,
        error: undefined,
        result: undefined,
        startedAt: undefined,
        finishedAt: undefined,
      });
      saveRemote(id, {
        status: "queued",
        stage: null,
        error: null,
        campaign_id: null,
        adset_id: null,
        ad_id: null,
        link: null,
        started_at: null,
        finished_at: null,
      });
      queue.current.push(id);
      void pump();
    },
    [patch, pump, saveRemote],
  );

  const remove = useCallback(
    (id: string) => {
      inputs.current.delete(id);
      meta.current.delete(id);
      queue.current = queue.current.filter((q) => q !== id);
      setTasks((ts) => ts.filter((t) => t.id !== id));
      deleteRemote([id]);
    },
    [deleteRemote],
  );

  const clearDone = useCallback(() => {
    setTasks((ts) => {
      ts.filter((t) => t.status === "done").forEach((t) => inputs.current.delete(t.id));
      return ts.filter((t) => t.status !== "done");
    });
  }, []);

  const retryAll = useCallback(() => {
    for (const t of tasksRef.current) if (t.status === "error") retry(t.id);
  }, [retry]);

  /** Dismiss every finished task (done + error) in one go. */
  const clearFinished = useCallback(() => {
    // Snapshot the ids synchronously — the setTasks updater runs later, so collecting inside it
    // would leave `gone` empty when deleteRemote fires.
    const gone = tasksRef.current
      .filter((t) => t.status === "done" || t.status === "error")
      .map((t) => t.id);
    gone.forEach((id) => {
      inputs.current.delete(id);
      meta.current.delete(id);
    });
    setTasks((ts) => ts.filter((t) => t.status === "queued" || t.status === "running"));
    deleteRemote(gone);
  }, [deleteRemote]);

  const counts = useMemo(() => {
    let queued = 0,
      running = 0,
      done = 0,
      error = 0;
    for (const t of tasks) {
      if (t.status === "queued") queued++;
      else if (t.status === "running") running++;
      else if (t.status === "done") done++;
      else error++;
    }
    return { queued, running, done, error, active: queued + running, total: tasks.length };
  }, [tasks]);

  const value: TaskManagerValue = {
    tasks,
    counts,
    open,
    setOpen,
    enqueue,
    retry,
    retryAll,
    remove,
    clearDone,
    clearFinished,
  };

  return (
    <Ctx.Provider value={value}>
      {children}
      <TaskManagerPanel />
    </Ctx.Provider>
  );
}

// ---------- header button ----------

export function TaskManagerButton() {
  const { counts, setOpen } = useTaskManager();
  const badge = counts.active > 0 ? counts.active : counts.error > 0 ? counts.error : 0;
  const tone =
    counts.active > 0
      ? "border-accent/40 bg-accent/15 text-[#9db8ff]"
      : counts.error > 0
        ? "border-danger/40 bg-danger/10 text-danger"
        : "border-line bg-surface text-dim hover:border-line2 hover:bg-surface2 hover:text-ink";

  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label="Open Task Manager"
      className={
        "relative flex h-9 items-center gap-2 rounded-full border px-3 text-[13px] font-medium " +
        "transition-all duration-200 active:scale-[0.96] focus-visible:outline-none " +
        "focus-visible:ring-2 focus-visible:ring-accent/40 " +
        tone
      }
    >
      <span className="relative">
        <TasksIcon className="h-4 w-4" />
        {counts.running > 0 ? (
          <span className="animate-pulse-soft absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-launch2" />
        ) : null}
      </span>
      <span className="hidden sm:inline">Tasks</span>
      {badge > 0 ? (
        <span
          key={badge}
          className={
            "animate-badge-pop grid h-4 min-w-4 place-items-center rounded-full px-1 font-mono text-[10px] font-semibold " +
            (counts.active > 0 ? "bg-accent text-white" : "bg-danger text-white")
          }
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
}

// ---------- drawer panel ----------

type Filter = "all" | "active" | "done" | "error";

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function TaskManagerPanel() {
  const { tasks, counts, open, setOpen, retry, retryAll, remove, clearFinished } = useTaskManager();
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

  const shown = tasks.filter((t) =>
    filter === "all"
      ? true
      : filter === "active"
        ? t.status === "queued" || t.status === "running"
        : t.status === filter,
  );

  const tabs: { key: Filter; label: string; n: number }[] = [
    { key: "all", label: "All", n: counts.total },
    { key: "active", label: "Active", n: counts.active },
    { key: "done", label: "Done", n: counts.done },
    { key: "error", label: "Failed", n: counts.error },
  ];

  return (
    <div className="fixed inset-0 z-[80]">
      <div className="animate-fade-in absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={() => setOpen(false)} />
      <aside className="animate-drawer-in absolute right-0 top-0 flex h-full w-full max-w-[440px] flex-col border-l border-line bg-surface shadow-[-20px_0_60px_rgba(0,0,0,0.5)]">
        {/* header */}
        <div className="flex items-center justify-between border-b border-line px-4 py-3.5">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-accent/25 to-accent2/25 text-[#9db8ff]">
              <TasksIcon className="h-4 w-4" />
            </span>
            <div className="leading-none">
              <h2 className="text-[14px] font-semibold text-ink">Task Manager</h2>
              <p className="mt-1 text-[10px] uppercase tracking-[0.16em] text-faint">Launch queue</p>
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
          <Stat label="Queued" n={counts.queued} tone="text-dim" />
          <Stat label="Running" n={counts.running} tone="text-[#9db8ff]" />
          <Stat label="Done" n={counts.done} tone="text-launch2" />
          <Stat label="Failed" n={counts.error} tone="text-danger" />
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
              <p className="max-w-[240px] text-[11.5px] leading-relaxed text-faint">
                Launched campaigns land here and build one at a time. Keep working — the queue runs on its own.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {shown.map((t) => (
                <TaskRow key={t.id} task={t} now={now} onRetry={() => retry(t.id)} onRemove={() => remove(t.id)} />
              ))}
            </div>
          )}
        </div>

        {/* footer — bulk actions */}
        <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2.5">
          <span className="text-[10.5px] text-faint">
            {counts.running > 0 ? "Processing…" : counts.active > 0 ? "Waiting in queue" : "Idle"}
          </span>
          <div className="flex items-center gap-1.5">
            {counts.error > 0 ? (
              <button
                type="button"
                onClick={retryAll}
                className="flex items-center gap-1.5 rounded-md border border-danger/30 px-2 py-1 text-[11.5px] font-medium text-danger transition-colors hover:bg-danger/10"
              >
                <RetryIcon className="h-3.5 w-3.5" />
                Retry failed ({counts.error})
              </button>
            ) : null}
            <button
              type="button"
              onClick={clearFinished}
              disabled={counts.done + counts.error === 0}
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

function TaskRow({
  task,
  now,
  onRetry,
  onRemove,
}: {
  task: LaunchTask;
  now: number;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const idx = task.stage ? STAGE_INDEX[task.stage] ?? 0 : 0;
  const done = task.status === "done";
  const error = task.status === "error";
  const running = task.status === "running";
  const elapsed = task.startedAt ? (task.finishedAt ?? now) - task.startedAt : 0;

  const statusLabel = done
    ? "Launched · paused"
    : error
      ? task.error || "Failed"
      : running
        ? STAGES[idx]?.label ?? "Working…"
        : "Queued";

  return (
    <div
      className={
        "animate-row-in rounded-xl border bg-surface2/40 p-3 transition-colors " +
        (error ? "border-danger/30" : done ? "border-launch/25" : "border-line")
      }
    >
      <div className="flex items-start gap-2.5">
        <StatusDot status={task.status} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-medium text-ink" title={task.name}>
            {task.name || "Untitled campaign"}
          </p>
          <p className="mt-0.5 truncate font-mono text-[10.5px] text-faint">
            gcm {task.gcm || "—"} · {task.geo} · ${moneyLabel(task.budget)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="font-mono text-[10.5px] tabular-nums text-faint">{fmtElapsed(elapsed)}</span>
          {error && task.local ? (
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
          {!running && task.status !== "queued" ? (
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
            : error && i === idx
              ? "bg-danger"
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
            (done ? "text-launch2" : error ? "text-danger" : "text-dim")
          }
        >
          {error ? <AlertIcon className="h-3 w-3 shrink-0" /> : null}
          {done ? <CheckIcon className="h-3 w-3 shrink-0" /> : null}
          {running ? <RocketIcon className="h-3 w-3 shrink-0 text-[#9db8ff]" /> : null}
          <span className="truncate" title={statusLabel}>
            {statusLabel}
          </span>
        </span>
        {done && task.result?.adId ? <CopyId id={task.result.adId} /> : null}
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: TaskStatus }) {
  if (status === "running")
    return (
      <span className="relative mt-1 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <span className="z-10 h-2 w-2 rounded-full bg-[#9db8ff]" />
        <span className="absolute inset-0 animate-ping rounded-full bg-accent/40" />
      </span>
    );
  const color =
    status === "done" ? "bg-launch2" : status === "error" ? "bg-danger" : "bg-warn";
  return <span className={"mt-1.5 h-2 w-2 shrink-0 rounded-full " + color} />;
}

function CopyId({ id }: { id: string }) {
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
      title="Copy ad id"
    >
      {copied ? <CheckIcon className="h-3 w-3 text-launch2" /> : <CopyIcon className="h-3 w-3" />}
      ad {id}
    </button>
  );
}
