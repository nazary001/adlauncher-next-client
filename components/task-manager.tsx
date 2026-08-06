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
import type { CloneEdit } from "@/lib/clone";
import type { SessionUser } from "./user-menu";
import { AlertIcon, CheckIcon, CopyIcon, RetryIcon, RocketIcon, TasksIcon, TrashIcon, XIcon } from "./icons";

// ---------- stages (per task kind) ----------

type TaskKind = "launch" | "clone";
type StageDef = { key: string; label: string };

// Launch pipeline ("upload" is client→Blob; the rest mirror /api/launch events).
const LAUNCH_STAGES: readonly StageDef[] = [
  { key: "upload", label: "Uploading video" },
  { key: "gcm", label: "Reserving code" },
  { key: "video", label: "Registering video" },
  { key: "processing", label: "Processing video" },
  { key: "campaign", label: "Creating campaign" },
  { key: "adset", label: "Creating ad set" },
  { key: "creative", label: "Building creative" },
  { key: "ad", label: "Publishing ad" },
];

// Clone pipeline — mirrors /api/clone/run events; the source video is reused, so no upload.
const CLONE_STAGES: readonly StageDef[] = [
  { key: "source", label: "Reading source" },
  { key: "gcm", label: "Reserving code" },
  { key: "campaign", label: "Creating campaign" },
  { key: "adset", label: "Creating ad set" },
  { key: "creative", label: "Building creative" },
  { key: "ad", label: "Publishing ad" },
];

function stagesFor(kind: TaskKind): readonly StageDef[] {
  return kind === "clone" ? CLONE_STAGES : LAUNCH_STAGES;
}
function stageIndexFor(kind: TaskKind, stage: string | null): number {
  if (!stage) return 0;
  const i = stagesFor(kind).findIndex((s) => s.key === stage);
  return i < 0 ? 0 : i;
}

// ---------- task model ----------

type TaskStatus = "queued" | "running" | "done" | "error";

type LaunchInput = {
  kind: "launch";
  partnerId: PartnerId;
  campaign: Campaign;
  videoUrl: string;
  videoName: string;
};

type CloneInput = {
  kind: "clone";
  partnerId: PartnerId;
  edit: CloneEdit;
};

type TaskInput = LaunchInput | CloneInput;

export type LaunchTask = {
  id: string;
  kind: TaskKind;
  /** Username that launched/cloned this. Shared view shows everyone's; mutations stay owner-scoped. */
  owner?: string | null;
  name: string;
  gcm: string;
  geo: string;
  budget: string;
  status: TaskStatus;
  stage: string | null;
  result?: { campaignId?: string; adsetId?: string; adId?: string; gcm?: string; link?: string };
  error?: string;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Created this session (has its input → can be retried). Restored rows are false. */
  local?: boolean;
};

/** A Strapi/localStorage row → in-memory task. */
function fromRemote(r: Record<string, unknown>): LaunchTask {
  const n = (v: unknown) => (v == null || v === "" ? undefined : Number(v));
  const s = (v: unknown) => (v == null ? undefined : String(v));
  const name = s(r.name) ?? "";
  return {
    id: String(r.id ?? r.task_id ?? ""),
    // Strapi doesn't store the kind; infer it from the "(CLONE)" name stamp for restore rendering.
    kind: /\(clone\)/i.test(name) ? "clone" : "launch",
    owner: s(r.owner) ?? null,
    name,
    gcm: s(r.gcm) ?? "",
    geo: s(r.geo) ?? "",
    budget: s(r.budget) ?? "",
    status: (s(r.status) ?? "queued") as TaskStatus,
    stage: s(r.stage) ?? null,
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

/** On restore, my own non-terminal task was cut off by this reload → mark interrupted (non-retryable
 *  after restore, since the input is gone). Another user's still-active task is live on their
 *  machine, so keep its state. Restored rows are never `local`. */
function asRestored(t: LaunchTask, me: string | null): LaunchTask {
  if (t.status === "done" || t.status === "error") return { ...t, local: false };
  if (me && t.owner && t.owner !== me) return { ...t, local: false };
  return {
    ...t,
    status: "error",
    error: "Interrupted by page reload — relaunch to retry",
    finishedAt: t.finishedAt ?? t.startedAt ?? t.queuedAt,
    local: false,
  };
}

/** Merge a freshly-fetched shared list into the current in-memory list. My own in-flight tasks stay
 *  authoritative (never clobbered by a stale Strapi row); everyone else's come from the fetch.
 *  Newest first. */
function mergeShared(cur: LaunchTask[], fetched: LaunchTask[], me: string | null): LaunchTask[] {
  const byId = new Map<string, LaunchTask>();
  for (const f of fetched) byId.set(f.id, f);
  for (const c of cur) {
    const mine = c.local || (!!me && c.owner === me);
    if (mine && (c.local || c.status === "running" || c.status === "queued")) byId.set(c.id, c);
    else if (!byId.has(c.id)) byId.set(c.id, c);
  }
  return [...byId.values()].sort((a, b) => b.queuedAt - a.queuedAt);
}

// Per-account key: several people share machines/browsers, and the fallback snapshot must not
// leak one account's queue into another. The bare legacy key predates scoping and gets dropped.
const LS_BASE = "adlauncher.tasks";
const lsKeyFor = (user?: SessionUser) => (user?.username ? `${LS_BASE}.${user.username}` : LS_BASE);

export type EnqueueArgs = {
  partnerId: PartnerId;
  campaign: Campaign;
  videoUrl: string;
  videoName: string;
  name: string;
  gcm: string;
  geo: string;
  budget: string;
};

export type CloneEnqueueArgs = {
  partnerId: PartnerId;
  edit: CloneEdit;
  name: string;
  geo: string;
  budget: string;
};

type TaskManagerValue = {
  tasks: LaunchTask[];
  counts: { queued: number; running: number; done: number; error: number; active: number; total: number };
  /** The current user — used to label task owners and gate own-only actions in the shared view. */
  me: string | null;
  open: boolean;
  setOpen: (v: boolean) => void;
  enqueue: (args: EnqueueArgs) => void;
  enqueueClone: (args: CloneEnqueueArgs) => void;
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

export function TaskManagerProvider({ children, user }: { children: React.ReactNode; user?: SessionUser }) {
  const lsKey = lsKeyFor(user);
  const me = user?.username ?? null;
  const [tasks, setTasks] = useState<LaunchTask[]>([]);
  const [open, setOpen] = useState(false);
  const inputs = useRef(new Map<string, TaskInput>());
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

  // Pull the whole team's tasks and merge them in (my in-flight tasks stay authoritative). Used for
  // the live refreshes on window focus and while the drawer is open.
  const loadRemote = useCallback(() => {
    fetch("/api/launch-tasks")
      .then((r) => r.json())
      .then((d) => {
        if (!d?.ok || !Array.isArray(d.tasks)) return;
        const fetched = (d.tasks as Record<string, unknown>[]).map(fromRemote).map((t) => asRestored(t, me));
        setTasks((cur) => mergeShared(cur, fetched, me));
      })
      .catch(() => {});
  }, [me]);

  // Restore once on mount: the team's Strapi list wins; localStorage is the offline fallback.
  useEffect(() => {
    let localSnap: LaunchTask[] = [];
    try {
      const raw = localStorage.getItem(lsKey);
      if (raw) localSnap = JSON.parse(raw) as LaunchTask[];
      // Pre-scoping snapshot was account-agnostic — drop it so it can't surface for the wrong user.
      if (lsKey !== LS_BASE) localStorage.removeItem(LS_BASE);
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
        setTasks((cur) => mergeShared(cur, rows.map((t) => asRestored(t, me)), me));
      })
      .catch(() => {
        if (alive) setTasks((cur) => mergeShared(cur, localSnap.map((t) => asRestored(t, me)), me));
      })
      .finally(() => {
        loadedRef.current = true;
      });
    return () => {
      alive = false;
    };
  }, [lsKey, me]);

  // Live shared view: refresh on window focus, and — while the drawer is open — on open + every 15s.
  useEffect(() => {
    const onFocus = () => loadRemote();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadRemote]);

  useEffect(() => {
    if (!open) return;
    loadRemote();
    const iv = window.setInterval(loadRemote, 15000);
    return () => window.clearInterval(iv);
  }, [open, loadRemote]);

  // Mirror to localStorage after the initial load (guard prevents the empty first render from
  // wiping the stored snapshot before restore reads it).
  useEffect(() => {
    if (!loadedRef.current) return;
    try {
      localStorage.setItem(lsKey, JSON.stringify(tasks));
    } catch {
      /* quota / disabled — Strapi still holds the durable copy */
    }
  }, [tasks, lsKey]);

  const runLaunchTask = useCallback(
    async (id: string, input: LaunchInput) => {
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
          if (typeof ev.stage === "string") patch(id, { stage: ev.stage });
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
            // The server may have claimed a different code than the optimistic preview (it walks
            // forward on conflict — routine when several users launch at once): show the real one.
            ...(typeof f.gcm === "string" && f.gcm ? { gcm: f.gcm } : {}),
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

  const runCloneTask = useCallback(
    async (id: string, input: CloneInput) => {
      const startedAt = Date.now();
      patch(id, { status: "running", stage: "source", startedAt, error: undefined });
      saveRemote(id, { status: "running", stage: "source", started_at: startedAt });
      try {
        const res = await fetch("/api/clone/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ partnerId: input.partnerId, edits: [input.edit] }),
        });

        // Stream mirrors /api/clone/run: per-clone {idx,stage} progress, a per-clone {ok,...} final,
        // then a {stage:"batch-done"} summary we ignore (this task carries a single clone).
        let final: Record<string, unknown> | null = null;
        const handle = (line: string) => {
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(line);
          } catch {
            return;
          }
          if (ev.stage === "batch-done") return;
          if (ev.ok === true || ev.ok === false) {
            final = ev;
            return;
          }
          if (typeof ev.stage === "string" && ev.stage !== "start") patch(id, { stage: ev.stage });
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
            ...(typeof f.gcm === "string" && f.gcm ? { gcm: f.gcm } : {}),
            result: {
              campaignId: f.campaign_id as string,
              adsetId: f.adset_id as string,
              adId: f.ad_id as string,
              gcm: f.gcm as string,
            },
          });
          saveRemote(id, {
            status: "done",
            stage: "ad",
            finished_at: finishedAt,
            campaign_id: f.campaign_id,
            adset_id: f.adset_id,
            ad_id: f.ad_id,
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

  const runTask = useCallback(
    async (id: string) => {
      const input = inputs.current.get(id);
      if (!input) return;
      if (input.kind === "clone") await runCloneTask(id, input);
      else await runLaunchTask(id, input);
    },
    [runLaunchTask, runCloneTask],
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
        kind: "launch",
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
          kind: "launch",
          owner: me,
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
    [pump, saveRemote, me],
  );

  const enqueueClone = useCallback(
    (args: CloneEnqueueArgs) => {
      const id =
        (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)) + Date.now().toString(36);
      const queuedAt = Date.now();
      // No video upload — the clone reuses the source's video by id (server-side). gcm is assigned
      // by the run and filled in on completion.
      inputs.current.set(id, { kind: "clone", partnerId: args.partnerId, edit: args.edit });
      meta.current.set(id, {
        name: args.name,
        partner: args.partnerId,
        gcm: "",
        geo: args.geo,
        budget: args.budget,
        queued_at: queuedAt,
      });
      setTasks((ts) => [
        {
          id,
          kind: "clone",
          owner: me,
          name: args.name,
          gcm: "",
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
    [pump, saveRemote, me],
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
    // Only local tasks (created this session) can retry — restored ones lost their video and would
    // otherwise get stuck in "queued" forever (runTask bails without an input).
    for (const t of tasksRef.current) if (t.status === "error" && t.local) retry(t.id);
  }, [retry]);

  /** Dismiss every finished task (done + error) I own — others' rows aren't mine to delete (the API
   *  refuses them and they'd reappear on the next shared refresh anyway). */
  const clearFinished = useCallback(() => {
    const gone = new Set(
      tasksRef.current
        .filter((t) => (t.status === "done" || t.status === "error") && (t.local || (!!me && t.owner === me)))
        .map((t) => t.id),
    );
    gone.forEach((id) => {
      inputs.current.delete(id);
      meta.current.delete(id);
    });
    setTasks((ts) => ts.filter((t) => !gone.has(t.id)));
    deleteRemote([...gone]);
  }, [deleteRemote, me]);

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
    me,
    open,
    setOpen,
    enqueue,
    enqueueClone,
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
type KindFilter = "all" | "launch" | "clone";

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function TaskManagerPanel() {
  const { tasks, counts, me, open, setOpen, retry, retryAll, remove, clearFinished } = useTaskManager();
  const [filter, setFilter] = useState<Filter>("all");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
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

  // Only local errors can actually retry (restored tasks lost their input); match retryAll.
  const retryable = tasks.filter((t) => t.status === "error" && t.local).length;

  // Split by kind first (New launches vs Duplicates), then filter by status within that split.
  const kindTasks = kindFilter === "all" ? tasks : tasks.filter((t) => t.kind === kindFilter);
  const kc = { queued: 0, running: 0, done: 0, error: 0 };
  for (const t of kindTasks) {
    if (t.status === "queued") kc.queued++;
    else if (t.status === "running") kc.running++;
    else if (t.status === "done") kc.done++;
    else kc.error++;
  }

  const shown = kindTasks.filter((t) =>
    filter === "all"
      ? true
      : filter === "active"
        ? t.status === "queued" || t.status === "running"
        : t.status === filter,
  );

  const kinds: { key: KindFilter; label: string; icon: React.ReactNode; n: number }[] = [
    { key: "all", label: "All", icon: null, n: tasks.length },
    { key: "launch", label: "Launches", icon: <RocketIcon className="h-3.5 w-3.5" />, n: tasks.filter((t) => t.kind === "launch").length },
    { key: "clone", label: "Duplicates", icon: <CopyIcon className="h-3.5 w-3.5" />, n: tasks.filter((t) => t.kind === "clone").length },
  ];

  const tabs: { key: Filter; label: string; n: number }[] = [
    { key: "all", label: "All", n: kindTasks.length },
    { key: "active", label: "Active", n: kc.queued + kc.running },
    { key: "done", label: "Done", n: kc.done },
    { key: "error", label: "Failed", n: kc.error },
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
              <p className="mt-1 text-[10px] uppercase tracking-[0.16em] text-faint">Launch &amp; clone queue</p>
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

        {/* split — New launches vs Duplicates */}
        <div className="flex items-center gap-1 border-b border-line px-3 py-2.5">
          {kinds.map((k) => (
            <button
              key={k.key}
              type="button"
              onClick={() => setKindFilter(k.key)}
              className={
                "flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-1.5 py-1.5 text-[12px] font-medium transition-colors duration-150 " +
                (kindFilter === k.key
                  ? "border-accent/40 bg-accent/15 text-[#9db8ff]"
                  : "border-line bg-surface2/40 text-faint hover:border-line2 hover:text-dim")
              }
            >
              {k.icon}
              <span>{k.label}</span>
              <span className="font-mono text-[10.5px] opacity-70">{k.n}</span>
            </button>
          ))}
        </div>

        {/* summary strip — reflects the selected split */}
        <div className="flex items-center gap-1.5 border-b border-line px-4 py-2.5">
          <Stat label="Queued" n={kc.queued} tone="text-dim" />
          <Stat label="Running" n={kc.running} tone="text-[#9db8ff]" />
          <Stat label="Done" n={kc.done} tone="text-launch2" />
          <Stat label="Failed" n={kc.error} tone="text-danger" />
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
                Launched and cloned campaigns land here and build one at a time. Keep working — the queue runs on its own.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {shown.map((t) => (
                <TaskRow key={t.id} task={t} me={me} now={now} onRetry={() => retry(t.id)} onRemove={() => remove(t.id)} />
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
  me,
  now,
  onRetry,
  onRemove,
}: {
  task: LaunchTask;
  me: string | null;
  now: number;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const mine = task.local || (!!me && task.owner === me);
  const owner = mine ? "you" : task.owner || "—";
  const stages = stagesFor(task.kind);
  const idx = stageIndexFor(task.kind, task.stage);
  const done = task.status === "done";
  const error = task.status === "error";
  const running = task.status === "running";
  const elapsed = task.startedAt ? (task.finishedAt ?? now) - task.startedAt : 0;

  const statusLabel = done
    ? task.kind === "clone"
      ? "Duplicated · paused"
      : "Launched · paused"
    : error
      ? task.error || "Failed"
      : running
        ? stages[idx]?.label ?? "Working…"
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
            gcm {task.gcm || "—"} · {task.geo} · ${moneyLabel(task.budget)} ·{" "}
            <span className={mine ? "text-dim" : "text-[#9db8ff]"}>{owner}</span>
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
          {mine && !running && task.status !== "queued" ? (
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
        {stages.map((s, i) => {
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
