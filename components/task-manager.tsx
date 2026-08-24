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
import { readCreative, safeBlobName, uploadCreativeFile } from "./blob-uploader";
import { type Campaign, moneyLabel } from "@/lib/types";
import { type PartnerId, partnerConfig } from "@/lib/partners";
import type { CloneEdit } from "@/lib/clone";
import {
  type EffStatus,
  type LaunchTask,
  type TaskKind,
  type TaskStatus,
  type ViewTask,
  STALE_MS,
  effStatusOf,
  fromRemote,
  mergeShared,
  ownerHue,
  ownerLastWrite,
} from "@/lib/task-view";
import type { SessionUser } from "./user-menu";
import { AlertIcon, CheckIcon, CopyIcon, RetryIcon, RocketIcon, TasksIcon, XIcon } from "./icons";

export type { LaunchTask } from "@/lib/task-view";

// ---------- stages (per task kind) ----------

type StageDef = { key: string; label: string };

// Launch pipeline ("upload" is client→Blob; the rest mirror /api/launch events). Media-neutral
// labels: the "video" stage registers either kind (image launches skip "processing").
const LAUNCH_STAGES: readonly StageDef[] = [
  { key: "upload", label: "Uploading creative" },
  { key: "gcm", label: "Reserving code" },
  { key: "video", label: "Registering media" },
  { key: "processing", label: "Processing video" },
  { key: "campaign", label: "Creating campaign" },
  { key: "adset", label: "Creating ad set" },
  { key: "creative", label: "Building creative" },
  { key: "ad", label: "Publishing ad" },
];

// Clone pipeline — mirrors /api/clone/run events; the source media is reused by id, so no upload.
// "media" fires only for cross-account clones (the source video/image is re-homed in the target
// account first); same-account clones skip straight from source to gcm.
const CLONE_STAGES: readonly StageDef[] = [
  { key: "source", label: "Reading source" },
  { key: "media", label: "Migrating media" },
  { key: "gcm", label: "Reserving code" },
  { key: "campaign", label: "Creating campaign" },
  { key: "adset", label: "Creating ad set" },
  { key: "creative", label: "Building creative" },
  { key: "ad", label: "Publishing ad" },
];

// Blob-upload bounds/retries/diagnostics live in blob-uploader.ts (shared with the HS manager).
// Breather between consecutive FB-writing tasks — RANDOM 1–3s per gap (owner call 2026-08-11,
// was a fixed 8s): jittered spacing looks less bot-like to Meta and keeps waves fast; the
// server-side throttle/budget-retries absorb whatever the shorter gaps cost in (#4)/(#17).
const TASK_GAP_MIN_MS = 1_000;
const TASK_GAP_MAX_MS = 3_000;
const taskGapMs = () => TASK_GAP_MIN_MS + Math.random() * (TASK_GAP_MAX_MS - TASK_GAP_MIN_MS);
// Client-side deadline on the /api/launch|clone request+stream. The server caps itself at
// maxDuration=300s; this fires just past that so a socket held open by infra after the function
// dies can't wedge the single-threaded queue. Aborting after the server is already dead means no
// FB object is created mid-abort.
const STREAM_TIMEOUT_MS = 330_000;

// ---- shared-view cadence ----
// The whole team's queue refreshes continuously — the header badge and drawer must be truthful at
// any moment, not only while the drawer is open (drawer open polls faster for live stage motion).
// Raised 2026-08-24 (4s/12s → 8s/24s): dozens of buyers polling every 4s overloaded the shared
// Strapi (503→504 incident); the server route now also short-caches the team list, so a slightly
// slower poll costs no freshness the cache wouldn't have eaten anyway.
const POLL_OPEN_MS = 8_000;
const POLL_CLOSED_MS = 24_000;
// Re-upsert my running task every 25s: the identical PUT bumps the row's updatedAt (verified), so
// teammates can tell a live-but-slow stage (video processing) from a dead session. Hidden tabs
// throttle timers to ~60s — still comfortably inside STALE_MS (180s).
const HEARTBEAT_MS = 25_000;
// Coarse re-render tick so stale detection advances with time even with the drawer closed.
const TICK_MS = 10_000;
// Ids deleted here are ignored in merges briefly, so an in-flight fetch can't resurrect them.
const TOMBSTONE_MS = 60_000;

function stagesFor(kind: TaskKind): readonly StageDef[] {
  return kind === "clone" ? CLONE_STAGES : LAUNCH_STAGES;
}
function stageIndexFor(kind: TaskKind, stage: string | null): number {
  if (!stage) return 0;
  const i = stagesFor(kind).findIndex((s) => s.key === stage);
  return i < 0 ? 0 : i;
}

// ---------- task model ----------

/** One creative captured at enqueue (session-local object URLs). */
export type QueuedMedia = {
  url: string;
  name: string;
  kind: "video" | "image";
  /** Custom cover for a VIDEO creative — uploaded next to it and pinned as the ad's thumbnail. */
  cover?: { url: string; name: string };
};

type LaunchInput = {
  kind: "launch";
  partnerId: PartnerId;
  campaign: Campaign;
  /** All creatives of this launch (1..partner.maxCreatives). The single-media fields below stay
   *  filled with the FIRST one — legacy shape for anything still reading them. */
  medias?: QueuedMedia[];
  mediaUrl: string;
  mediaName: string;
  mediaKind: "video" | "image";
  /** Custom cover for a VIDEO creative (session-local object URL) — uploaded next to the
   *  creative and pinned as the ad's thumbnail by the launch route. */
  cover?: { url: string; name: string };
};

type CloneInput = {
  kind: "clone";
  partnerId: PartnerId;
  edit: CloneEdit;
};

type TaskInput = LaunchInput | CloneInput;

// Per-account key: several people share machines/browsers, and the fallback snapshot must not
// leak one account's queue into another. The bare legacy key predates scoping and gets dropped.
const LS_BASE = "adlauncher.tasks";
const lsKeyFor = (user: SessionUser | undefined, base: string) =>
  user?.username ? `${base}.${user.username}` : base;

export type EnqueueArgs = {
  partnerId: PartnerId;
  campaign: Campaign;
  /** All creatives (1..partner.maxCreatives); when absent the single-media fields drive alone. */
  medias?: QueuedMedia[];
  mediaUrl: string;
  mediaName: string;
  mediaKind: "video" | "image";
  /** Custom cover image for a video creative (see LaunchInput.cover). */
  cover?: { url: string; name: string };
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
  /** The shared team list, each task with its display status (`eff`) resolved. Newest first. */
  tasks: ViewTask[];
  counts: {
    queued: number;
    running: number;
    done: number;
    error: number;
    active: number;
    total: number;
    /** THIS tab's own launches still client-side (queued / running) — they die with the page. */
    inFlight: number;
  };
  /** The current user — used to label task owners and gate own-only actions in the shared view. */
  me: string | null;
  open: boolean;
  setOpen: (v: boolean) => void;
  enqueue: (args: EnqueueArgs) => void;
  enqueueClone: (args: CloneEnqueueArgs) => void;
  retry: (id: string) => void;
  retryAll: () => void;
};

const Ctx = createContext<TaskManagerValue | null>(null);

export function useTaskManager(): TaskManagerValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTaskManager must be used within TaskManagerProvider");
  return v;
}

// AIF runs an IDENTICAL queue/drawer as a fully SEPARATE instance (own context, own Strapi scope
// partner="us", own localStorage) — owner call 08-17: every partner gets its own task manager;
// the team "Tasks" drawer stays MO-only, "HS Tasks" stays LION's.
const AifCtx = createContext<TaskManagerValue | null>(null);

export function useAifTaskManager(): TaskManagerValue {
  const v = useContext(AifCtx);
  if (!v) throw new Error("useAifTaskManager must be used within AifTaskManagerProvider");
  return v;
}

/** Everything scope-specific about one task-manager instance. `api` also serves POST and the
 *  pagehide beacon — the query param only matters on GET (the server scopes the list by it). */
type TmScope = {
  api: string;
  lsBase: string;
  /** Header button caption. */
  label: string;
  title: string;
  subtitle: string;
  /** Bottom offset of the still-launching pill — the two instances must never overlap when both
   *  queues are mid-wave (MO wave running while an AIF wave fires, or vice versa). */
  bannerBottom: string;
};
const MO_SCOPE: TmScope = {
  api: "/api/launch-tasks",
  lsBase: LS_BASE,
  label: "Tasks",
  title: "Task Manager",
  subtitle: "Team launch & clone queue",
  bannerBottom: "bottom-5",
};
const AIF_SCOPE: TmScope = {
  api: "/api/launch-tasks?scope=aif",
  lsBase: "adlauncher.aiftasks",
  label: "AIF Tasks",
  title: "AIF Task Manager",
  subtitle: "AIF launch queue · team view",
  bannerBottom: "bottom-[4.75rem]",
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------- provider (single-concurrency worker) ----------
// Mounted ONCE in the (app) layout, above both boards — the queue, worker and drawer survive
// navigating between the launcher and the clone board.

export function TaskManagerProvider({ children, user }: { children: React.ReactNode; user?: SessionUser }) {
  return (
    <TaskManagerCore user={user} scope={MO_SCOPE} ctx={Ctx}>
      {children}
    </TaskManagerCore>
  );
}

/** The AIF twin — mounted alongside in the (app) layout; boards pick the instance by partner. */
export function AifTaskManagerProvider({ children, user }: { children: React.ReactNode; user?: SessionUser }) {
  return (
    <TaskManagerCore user={user} scope={AIF_SCOPE} ctx={AifCtx}>
      {children}
    </TaskManagerCore>
  );
}

function TaskManagerCore({
  children,
  user,
  scope,
  ctx,
}: {
  children: React.ReactNode;
  user?: SessionUser;
  scope: TmScope;
  ctx: React.Context<TaskManagerValue | null>;
}) {
  const lsKey = lsKeyFor(user, scope.lsBase);
  const me = user?.username ?? null;
  const [tasks, setTasks] = useState<LaunchTask[]>([]);
  const [open, setOpen] = useState(false);
  // Coarse clock for staleness re-evaluation (stale is derived, so it must advance with time).
  const [nowTick, setNowTick] = useState(() => Date.now());
  const inputs = useRef(new Map<string, TaskInput>());
  const queue = useRef<string[]>([]);
  const working = useRef(false);
  const tasksRef = useRef<LaunchTask[]>([]);
  const openRef = useRef(false);
  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  const patch = useCallback((id: string, p: Partial<LaunchTask>) => {
    setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, ...p } : t)));
  }, []);

  // ---- persistence: Strapi (source of truth) + localStorage (offline fallback) ----
  const meta = useRef(new Map<string, Record<string, unknown>>()); // static fields per task
  const saveChains = useRef(new Map<string, Promise<unknown>>()); // serialize saves per task
  // Tasks whose terminal state was already chained — the heartbeat must never write "running"
  // after it (the interval reads tasksRef, which lags one render behind the done/error patch).
  const terminalSaved = useRef(new Set<string>());
  const loadedRef = useRef(false);
  // Server-clock skew measured at fetch time (server `now` − client now): owner liveness is judged
  // on the server clock so wrong local clocks can't fake or mask a dead session. State (not a ref)
  // because the render-time `view` memo needs it; the guarded setter only fires on a real shift,
  // so routine polls don't re-render anything.
  const [skew, setSkew] = useState(0);
  const noteSkew = useCallback((serverNow: number) => {
    const s = serverNow - Date.now();
    setSkew((prev) => (Math.abs(prev - s) > 3000 ? s : prev));
  }, []);
  const tombstones = useRef(new Map<string, number>());
  const interruptsPersisted = useRef(new Set<string>());
  const authDeadRef = useRef(false);
  const lastPollRef = useRef(0);
  // Last SUCCESSFUL fetch — gates any terminal write derived from staleness: a session whose view
  // is frozen (hidden tab, network loss) must never "settle" rows off stale data.
  const lastPollOkRef = useRef(0);

  /** Upsert one task's state to Strapi. Non-blocking for the caller, but chained PER TASK so
   *  queued→running→done apply in order (no racing creates that would drop fields). One retry on
   *  failure — a dropped terminal save would leave the team a forever-"running" ghost. */
  const saveRemote = useCallback((id: string, dyn: Record<string, unknown>) => {
    if (dyn.status === "done" || dyn.status === "error") terminalSaved.current.add(id);
    const payload = { task_id: id, ...(meta.current.get(id) ?? {}), ...dyn };
    const post = () =>
      fetch(scope.api, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    const prev = saveChains.current.get(id) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        try {
          const res = await post();
          if (res.ok || res.status === 400 || res.status === 401 || res.status === 403) return;
        } catch {
          /* network — retry below */
        }
        await sleep(4000);
        await post().catch(() => {});
      });
    saveChains.current.set(id, next);
  }, [scope.api]);

  // deleteRemote is gone with UI deletion (owner call 08-11): tasks leave Strapi only via
  // admin cleanup, never from a buyer's drawer. The tombstone map stays — it still suppresses
  // just-transitioned rows against a racing poll.

  /** Pull the whole team's tasks and merge them in. My in-session tasks stay authoritative; every
   *  other row mirrors the fetch (so a teammate's dismiss disappears here too). */
  const loadRemote = useCallback(() => {
    fetch(scope.api)
      .then(async (r) => {
        if (r.status === 401) {
          // Session died — stop hammering; the next focus/visibility re-arms polling.
          authDeadRef.current = true;
          return;
        }
        const d = (await r.json().catch(() => null)) as
          | { ok?: boolean; now?: number; tasks?: Record<string, unknown>[] }
          | null;
        if (!d?.ok || !Array.isArray(d.tasks)) return;
        lastPollOkRef.current = Date.now();
        if (typeof d.now === "number") noteSkew(d.now);
        const cutoff = Date.now() - TOMBSTONE_MS;
        for (const [id, ts] of tombstones.current) if (ts < cutoff) tombstones.current.delete(id);
        const fetched = d.tasks.map(fromRemote);
        const tomb = new Set(tombstones.current.keys());
        // A tombstoned id still coming back means the DELETE hasn't landed — keep it buried
        // (deleteRemote retries) instead of letting the tombstone lapse and resurrect it.
        for (const f of fetched) if (f.id && tomb.has(f.id)) tombstones.current.set(f.id, Date.now());
        setTasks((cur) => mergeShared(cur, fetched, tomb));
      })
      .catch(() => {});
  }, [noteSkew, scope.api]);

  // Restore once on mount: the team's Strapi list wins; localStorage is the offline fallback.
  useEffect(() => {
    let localSnap: LaunchTask[] = [];
    try {
      const raw = localStorage.getItem(lsKey);
      // A snapshot task can never be `local` again — its input (video blob) died with the session.
      if (raw) localSnap = (JSON.parse(raw) as LaunchTask[]).map((t) => ({ ...t, local: false }));
      // Pre-scoping snapshot was account-agnostic — drop it so it can't surface for the wrong user.
      if (lsKey !== scope.lsBase) localStorage.removeItem(scope.lsBase);
    } catch {
      /* ignore */
    }
    let alive = true;
    fetch(scope.api)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d?.ok && Array.isArray(d.tasks)) {
          lastPollOkRef.current = Date.now();
          if (typeof d.now === "number") noteSkew(d.now);
          const fetched = (d.tasks as Record<string, unknown>[]).map(fromRemote);
          setTasks((cur) => mergeShared(cur, fetched));
        } else {
          setTasks((cur) => mergeShared(cur, localSnap));
        }
      })
      .catch(() => {
        if (alive) setTasks((cur) => mergeShared(cur, localSnap));
      })
      .finally(() => {
        loadedRef.current = true;
        lastPollRef.current = Date.now();
      });
    return () => {
      alive = false;
    };
  }, [lsKey, noteSkew, scope.api, scope.lsBase]);

  // Live shared view: poll continuously (faster with the drawer open), pause while the tab is
  // hidden, refresh immediately on focus/visible — the badge is truthful at any moment.
  useEffect(() => {
    const tick = () => {
      if (document.hidden || authDeadRef.current) return;
      const interval = openRef.current ? POLL_OPEN_MS : POLL_CLOSED_MS;
      if (Date.now() - lastPollRef.current < interval - 500) return;
      lastPollRef.current = Date.now();
      loadRemote();
    };
    const iv = window.setInterval(tick, POLL_OPEN_MS);
    const wake = () => {
      authDeadRef.current = false;
      lastPollRef.current = Date.now();
      loadRemote();
    };
    const onVis = () => {
      if (!document.hidden) wake();
    };
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(iv);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [loadRemote]);

  useEffect(() => {
    openRef.current = open;
    if (open) {
      lastPollRef.current = Date.now();
      loadRemote();
    }
  }, [open, loadRemote]);

  // Staleness advances with time even when nothing refetches.
  useEffect(() => {
    const iv = window.setInterval(() => setNowTick(Date.now()), TICK_MS);
    return () => window.clearInterval(iv);
  }, []);

  // Heartbeat: keep my running task's row fresh through long silent stages (upload, video
  // processing, rate-limit backoff) so the team never mistakes a live run for a dead one.
  useEffect(() => {
    const iv = window.setInterval(() => {
      const t = tasksRef.current.find((x) => x.local && x.status === "running");
      if (t && !terminalSaved.current.has(t.id)) saveRemote(t.id, { status: "running", stage: t.stage });
    }, HEARTBEAT_MS);
    return () => window.clearInterval(iv);
  }, [saveRemote]);

  // Leaving the page kills this session's worker: batch-mark my in-flight rows interrupted right
  // now (beacon survives unload). If the server is in fact still finishing the run, its own writer
  // overwrites this moments later — either way the row converges to the truth.
  useEffect(() => {
    const onPageHide = () => {
      // terminalSaved is the synchronous truth — tasksRef lags one commit behind the done/error
      // patch, and a beacon fired in that window would clobber a just-completed task with "error"
      // (the beacon survives unload while the client's own done-save fetch may be cancelled).
      const mine = tasksRef.current.filter(
        (t) => t.local && (t.status === "queued" || t.status === "running") && !terminalSaved.current.has(t.id),
      );
      if (mine.length === 0) return;
      const rows = mine.map((t) => ({
        task_id: t.id,
        // If this beacon CREATES the row (the queued-save never landed), a missing partner would
        // drop it out of every drawer scope — local tasks always know theirs.
        ...(t.partner ? { partner: t.partner } : {}),
        status: "error",
        stage: t.stage,
        error: "Interrupted — page closed mid-run",
        finished_at: Date.now(),
      }));
      // Chunked to the API's batch cap — a big wave can leave 100+ queued tasks behind.
      for (let i = 0; i < rows.length; i += 25) {
        try {
          navigator.sendBeacon?.(
            scope.api,
            new Blob([JSON.stringify({ tasks: rows.slice(i, i + 25) })], { type: "application/json" }),
          );
        } catch {
          /* best-effort */
        }
      }
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [scope.api]);

  // Convergence: persist the interrupt for MY OWN stale rows (a crashed session can't beacon).
  // Owner-scoped writes mean only my sessions can settle my rows; others' dead rows stay derived-
  // stale for everyone until their owner's next session settles them.
  useEffect(() => {
    if (!loadedRef.current || !me) return;
    // NEVER settle rows off a frozen view: a hidden tab pauses polling, so its `tasks` stop
    // refreshing while the clock advances — judging staleness there would let a background second
    // tab of the SAME user falsely bury (even done→error overwrite) rows another tab is running.
    // Only a visible session that fetched successfully within the stale window may write.
    if (document.hidden || Date.now() - lastPollOkRef.current > STALE_MS) return;
    const estNow = nowTick + skew; // same render-safe clock as `view` — lags ≤10s, only ever delays
    const lastWrite = ownerLastWrite(tasks);
    for (const t of tasks) {
      if (t.local || t.owner !== me) continue;
      if (t.status !== "queued" && t.status !== "running") continue;
      if (effStatusOf(t, lastWrite, estNow) !== "stale") continue;
      if (interruptsPersisted.current.has(t.id)) continue;
      interruptsPersisted.current.add(t.id);
      saveRemote(t.id, {
        status: "error",
        stage: t.stage,
        error: "Interrupted — session went offline",
        finished_at: t.finishedAt ?? t.startedAt ?? t.queuedAt,
      });
    }
  }, [tasks, nowTick, me, skew, saveRemote]);

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
      // Track the furthest stage actually reached so an error is recorded against the stage that
      // failed (previously Strapi kept the initial "upload" even for FB-side failures).
      let lastStage = "upload";
      try {
        // Everything this launch ships (1..maxCreatives): the multi shape when present, else the
        // legacy single-media fields (restored tasks / older enqueues).
        const queued: QueuedMedia[] =
          input.medias && input.medias.length > 0
            ? input.medias
            : [{ url: input.mediaUrl, name: input.mediaName, kind: input.mediaKind, cover: input.cover }];

        // 1) Read + PROBE every creative (and cover) up front — a dead file handle (moved/edited
        // on disk, cloud-sync offload, attach from before a reload) fails here in seconds with
        // its NAME and the re-attach remedy, before a single byte is uploaded or anything
        // happens server-side. Previously this class surfaced minutes in as a bare
        // "TypeError: Failed to fetch" (live 08-21). Probes read 64KB — cheap even for 5×500MB.
        const preparedAll: { file: File; kind: "video" | "image"; tag: string; cover?: File }[] = [];
        for (let i = 0; i < queued.length; i++) {
          const m = queued[i];
          const tag = queued.length > 1 ? `${i + 1}-` : "";
          const file = await readCreative(m.url, m.name, m.kind, `creative "${m.name || i + 1}"`);
          const cover =
            m.cover && m.kind === "video"
              ? await readCreative(m.cover.url, m.cover.name || "cover.jpg", "image", `cover "${m.cover.name || i + 1}"`)
              : undefined;
          preparedAll.push({ file, kind: m.kind, tag, ...(cover ? { cover } : {}) });
        }

        // 2) Upload every creative (+ its video cover) in order — sequential on purpose: parallel
        // multi-hundred-MB uploads would fight for the same uplink and all crawl into the
        // timeout. uploadCreativeFile bounds each attempt, retries the transient network class,
        // rides multipart for big videos and names the creative in every failure (blob-uploader).
        const medias: { url: string; kind: "video" | "image"; coverUrl?: string }[] = [];
        for (const p of preparedAll) {
          const url = await uploadCreativeFile(
            `creatives/${id}-${p.tag}${safeBlobName(p.file.name, p.kind === "image" ? "creative.jpg" : "creative.mp4")}`,
            p.file,
            `creative "${p.file.name}"`,
          );
          let coverUrl: string | undefined;
          if (p.cover) {
            coverUrl = await uploadCreativeFile(
              `creatives/${id}-${p.tag}cover-${safeBlobName(p.cover.name, "cover.jpg")}`,
              p.cover,
              `cover "${p.cover.name}"`,
            );
          }
          medias.push({ url, kind: p.kind, ...(coverUrl ? { coverUrl } : {}) });
        }
        const first = medias[0];

        const streamAbort = new AbortController();
        const streamTimer = window.setTimeout(() => streamAbort.abort(), STREAM_TIMEOUT_MS);
        let final: Record<string, unknown> | null = null;
        let resStatus = 0;
        try {
          // taskId lets the server mirror progress + the terminal state into the shared row —
          // the team keeps seeing the truth even if this browser dies mid-run. AIF rides its own
          // route (own token, brand registry, RW link) with the same stages/NDJSON contract.
          const launchApi = partnerConfig(input.partnerId).aifLaunch ? "/api/aif/launch" : "/api/launch";
          const res = await fetch(launchApi, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              partnerId: input.partnerId,
              campaign: input.campaign,
              // Multi-creative shape + the legacy single-media fields (first creative) so a
              // mid-deploy server on either side of the wire keeps working.
              medias,
              mediaUrl: first.url,
              mediaKind: first.kind,
              ...(first.coverUrl ? { coverUrl: first.coverUrl } : {}),
              taskId: id,
            }),
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
              patch(id, { stage: ev.stage });
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
        } finally {
          window.clearTimeout(streamTimer);
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
            error: null,
          });
          inputs.current.delete(id); // done → never re-run; free the captured Campaign/video url
        } else {
          const finishedAt = Date.now();
          const msg = f
            ? (f.error as string) || (f.stage as string) || `HTTP ${resStatus}`
            : `stream ended unexpectedly (HTTP ${resStatus}) — the server may have timed out mid-launch; check Ads Manager before retrying`;
          // Record which stage failed + whatever FB objects were created before the failure. A
          // created campaign means a blind retry would DUPLICATE it (fresh gcm, second full tree),
          // so we surface the campaign id on the task (result.campaignId) → the UI hides Retry and
          // we drop the input so it can never re-run.
          const created = ((f?.created ?? {}) as Record<string, unknown>) || {};
          const createdCampaign = created.campaign_id ? String(created.campaign_id) : undefined;
          const createdAdset = created.adset_id ? String(created.adset_id) : undefined;
          patch(id, {
            status: "error",
            stage: lastStage,
            finishedAt,
            error: msg,
            ...(createdCampaign ? { result: { campaignId: createdCampaign, adsetId: createdAdset } } : {}),
          });
          saveRemote(id, {
            status: "error",
            stage: lastStage,
            finished_at: finishedAt,
            error: msg,
            ...(createdCampaign ? { campaign_id: createdCampaign } : {}),
            ...(createdAdset ? { adset_id: createdAdset } : {}),
          });
          if (createdCampaign) inputs.current.delete(id); // partial success is not safely retryable
        }
      } catch (e) {
        const finishedAt = Date.now();
        patch(id, { status: "error", stage: lastStage, finishedAt, error: String(e) });
        saveRemote(id, { status: "error", stage: lastStage, finished_at: finishedAt, error: String(e) });
      }
    },
    [patch, saveRemote],
  );

  const runCloneTask = useCallback(
    async (id: string, input: CloneInput) => {
      const startedAt = Date.now();
      patch(id, { status: "running", stage: "source", startedAt, error: undefined });
      saveRemote(id, { status: "running", stage: "source", started_at: startedAt });
      let lastStage = "source";
      try {
        const streamAbort = new AbortController();
        const streamTimer = window.setTimeout(() => streamAbort.abort(), STREAM_TIMEOUT_MS);
        // Stream mirrors /api/clone/run: per-clone {idx,stage} progress, a per-clone {ok,...} final,
        // then a {stage:"batch-done"} summary we ignore (this task carries a single clone).
        let final: Record<string, unknown> | null = null;
        let resStatus = 0;
        try {
          const res = await fetch("/api/clone/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ partnerId: input.partnerId, edits: [input.edit], taskIds: [id] }),
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
            if (ev.stage === "batch-done") return;
            if (ev.ok === true || ev.ok === false) {
              final = ev;
              return;
            }
            if (typeof ev.stage === "string" && ev.stage !== "start") {
              lastStage = ev.stage;
              patch(id, { stage: ev.stage });
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
        } finally {
          window.clearTimeout(streamTimer);
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
            error: null,
          });
          inputs.current.delete(id); // done → never re-run
        } else {
          const finishedAt = Date.now();
          const msg = f
            ? (f.error as string) || (f.stage as string) || `HTTP ${resStatus}`
            : `stream ended unexpectedly (HTTP ${resStatus}) — the server may have timed out mid-clone; check Ads Manager before retrying`;
          // Same partial-success guard as launch: a created campaign means a blind retry duplicates it.
          const created = ((f?.created ?? {}) as Record<string, unknown>) || {};
          const createdCampaign = created.campaign_id ? String(created.campaign_id) : undefined;
          const createdAdset = created.adset_id ? String(created.adset_id) : undefined;
          patch(id, {
            status: "error",
            stage: lastStage,
            finishedAt,
            error: msg,
            ...(createdCampaign ? { result: { campaignId: createdCampaign, adsetId: createdAdset } } : {}),
          });
          saveRemote(id, {
            status: "error",
            stage: lastStage,
            finished_at: finishedAt,
            error: msg,
            ...(createdCampaign ? { campaign_id: createdCampaign } : {}),
            ...(createdAdset ? { adset_id: createdAdset } : {}),
          });
          if (createdCampaign) inputs.current.delete(id);
        }
      } catch (e) {
        const finishedAt = Date.now();
        patch(id, { status: "error", stage: lastStage, finishedAt, error: String(e) });
        saveRemote(id, { status: "error", stage: lastStage, finished_at: finishedAt, error: String(e) });
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
        // Gap between tasks, not after the last one — `working` stays held through the sleep, so a
        // concurrent enqueue()'s pump() no-ops and the queue stays strictly one-at-a-time. The
        // duration re-rolls per gap (1–3s) so every next launch/clone lands on its own jitter.
        if (queue.current.length) await new Promise((r) => setTimeout(r, taskGapMs()));
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
        ...(args.medias && args.medias.length > 0 ? { medias: args.medias } : {}),
        mediaUrl: args.mediaUrl,
        mediaName: args.mediaName,
        mediaKind: args.mediaKind,
        ...(args.cover ? { cover: args.cover } : {}),
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
          kind: "launch" as const,
          owner: me,
          name: args.name,
          partner: args.partnerId,
          gcm: args.gcm,
          geo: args.geo,
          budget: args.budget,
          status: "queued" as const,
          stage: null,
          // Client-only: the launch-limit's optimistic demand (never persisted).
          account: args.campaign.account || undefined,
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
          kind: "clone" as const,
          owner: me,
          name: args.name,
          partner: args.partnerId,
          gcm: "",
          geo: args.geo,
          budget: args.budget,
          status: "queued" as const,
          stage: null,
          // Client-only demand key: the TARGET account when picked; from-each-source clones have
          // none (their accounts differ per source — the server claim meters those).
          account: args.edit.accountId?.trim() ? args.edit.accountId : undefined,
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
      const t = tasksRef.current.find((x) => x.id === id);
      if (!t) return;
      // A partial failure already created a campaign on FB — re-running would build a SECOND full
      // tree under a fresh gcm. Never auto-retry those (the button is hidden too).
      if (t.result?.campaignId) return;
      // No input (restored task / already cleaned) → runTask would bail; and don't double-submit an
      // id that is already queued or running.
      if (!inputs.current.has(id) || queue.current.includes(id) || t.status === "queued" || t.status === "running") return;
      terminalSaved.current.delete(id); // re-armed — the heartbeat may keep it fresh again
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

  // No user-facing deletion: neither done tasks NOR errors are removable from the UI (owner
  // call 2026-08-11 — failures stay visible to the whole team; cleanup is an admin action in
  // Strapi, not a buyer button).

  const retryAll = useCallback(() => {
    // Retry only local errored tasks (restored ones lost their video) that did NOT create a
    // campaign — a partial success is not safely retryable (retry() also guards this).
    for (const t of tasksRef.current) if (t.status === "error" && t.local && !t.result?.campaignId) retry(t.id);
  }, [retry]);

  // Display statuses resolved against owner liveness — a non-terminal row of a dead session shows
  // as "stale"/interrupted instead of running forever. nowTick is the render-safe clock: it lags
  // real time by ≤10s, which only ever DELAYS a stale verdict (never fakes one).
  const view = useMemo<ViewTask[]>(() => {
    const estNow = nowTick + skew;
    const lastWrite = ownerLastWrite(tasks);
    return tasks.map((t) => ({ ...t, eff: effStatusOf(t, lastWrite, estNow) }));
  }, [tasks, nowTick, skew]);

  const counts = useMemo(() => {
    let queued = 0,
      running = 0,
      done = 0,
      error = 0,
      inFlight = 0;
    for (const t of view) {
      if (t.eff === "queued") queued++;
      else if (t.eff === "running") running++;
      else if (t.eff === "done") done++;
      else error++; // real errors + stale/interrupted
      // Launches still CLIENT-side (queued behind this tab's worker, or running their
      // upload/stream) die with the page — the leave guard below holds it open. THIS tab's own
      // tasks only (raw status: our own live rows are never stale); teammates' rows and
      // restored snapshots don't hold the page hostage.
      if (t.local && (t.status === "queued" || t.status === "running")) inFlight++;
    }
    return { queued, running, done, error, active: queued + running, total: view.length, inFlight };
  }, [view]);

  // Closing the page while launches are still client-side kills them (queued rows never fire;
  // an upload dies mid-flight) — the native leave-confirm is the hard stop behind the floating
  // pill. Registered only while something is actually in flight, so normal navigation stays
  // silent the rest of the time. (Same guard the HS Task Manager ships — owner ask 08-18:
  // every partner's queue holds the page.)
  useEffect(() => {
    if (counts.inFlight === 0) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ""; // legacy field — without it some Chromium builds skip the dialog
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [counts.inFlight]);

  const value: TaskManagerValue = {
    tasks: view,
    counts,
    me,
    open,
    setOpen,
    enqueue,
    enqueueClone,
    retry,
    retryAll,
  };

  return (
    <ctx.Provider value={value}>
      {children}
      {!open && counts.inFlight > 0 ? (
        <LaunchingBanner n={counts.inFlight} bottom={scope.bannerBottom} onOpen={() => setOpen(true)} />
      ) : null}
      <TaskManagerPanel tm={value} scope={scope} />
    </ctx.Provider>
  );
}

/** Floating guard for launches still CLIENT-side while the drawer is hidden: the page must stay
 *  open or queued/uploading campaigns die with it (the beforeunload confirm above is the hard
 *  stop; this is the visible one). Clicking re-opens the drawer. Disappears by itself the moment
 *  every launch reaches the server or a terminal state. Mirrors the HS pill. */
function LaunchingBanner({ n, bottom, onOpen }: { n: number; bottom: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-live="polite"
      className={
        `animate-pop-in fixed ${bottom} left-1/2 z-[70] flex -translate-x-1/2 items-center gap-2.5 ` +
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

export function TaskManagerButton() {
  return <TasksButtonCore tm={useTaskManager()} label={MO_SCOPE.label} />;
}

export function AifTaskManagerButton() {
  return <TasksButtonCore tm={useAifTaskManager()} label={AIF_SCOPE.label} />;
}

function TasksButtonCore({ tm, label }: { tm: TaskManagerValue; label: string }) {
  const { counts, setOpen } = tm;
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
      aria-label={`Open ${label}`}
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
      <span className="hidden whitespace-nowrap sm:inline">{label}</span>
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

const inBucket = (eff: EffStatus, f: Filter): boolean =>
  f === "all"
    ? true
    : f === "active"
      ? eff === "queued" || eff === "running"
      : f === "error"
        ? eff === "error" || eff === "stale"
        : eff === f;

function TaskManagerPanel({ tm, scope }: { tm: TaskManagerValue; scope: TmScope }) {
  const { tasks, counts, me, open, setOpen, retry, retryAll } = tm;
  const [filter, setFilter] = useState<Filter>("all");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
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

  const isMine = (t: ViewTask) => t.local || (!!me && t.owner === me);

  // Only local errors can actually retry (restored tasks lost their input); match retryAll.
  const retryable = tasks.filter((t) => t.status === "error" && t.local && !t.result?.campaignId).length;

  // Mine toggle → kind split (New launches vs Duplicates) → status filter within that split.
  const scoped = mineOnly ? tasks.filter(isMine) : tasks;
  const kindTasks = kindFilter === "all" ? scoped : scoped.filter((t) => t.kind === kindFilter);
  const kc = { queued: 0, running: 0, done: 0, error: 0 };
  for (const t of kindTasks) {
    if (t.eff === "queued") kc.queued++;
    else if (t.eff === "running") kc.running++;
    else if (t.eff === "done") kc.done++;
    else kc.error++;
  }

  const shown = kindTasks.filter((t) => inBucket(t.eff, filter));

  const kinds: { key: KindFilter; label: string; icon: React.ReactNode; n: number }[] = [
    { key: "all", label: "All", icon: null, n: scoped.length },
    { key: "launch", label: "Launches", icon: <RocketIcon className="h-3.5 w-3.5" />, n: scoped.filter((t) => t.kind === "launch").length },
    { key: "clone", label: "Duplicates", icon: <CopyIcon className="h-3.5 w-3.5" />, n: scoped.filter((t) => t.kind === "clone").length },
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
              <h2 className="text-[14px] font-semibold text-ink">{scope.title}</h2>
              <p className="mt-1 text-[10px] uppercase tracking-[0.16em] text-faint">{scope.subtitle}</p>
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
            onClick={() => setMineOnly((v) => !v)}
            aria-pressed={mineOnly}
            data-tip={mineOnly ? "Showing only your tasks" : "Show only your tasks"}
            className={
              "tip ml-auto flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] font-medium transition-colors duration-150 " +
              (mineOnly
                ? "border-accent/40 bg-accent/15 text-[#9db8ff]"
                : "border-line text-faint hover:border-line2 hover:text-dim")
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
              <p className="max-w-[240px] text-[11.5px] leading-relaxed text-faint">
                Launches and duplicates from every account land here live, building one at a time per
                session. Keep working — the queue runs on its own.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {shown.map((t) => (
                <TaskRow key={t.id} task={t} me={me} now={now} onRetry={() => retry(t.id)} />
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

/** Colored chip naming who launched a task — stable hue per username across all sessions. */
function OwnerChip({ owner, mine }: { owner: string | null | undefined; mine: boolean }) {
  if (mine) return <span className="text-dim">you</span>;
  const name = owner || "—";
  const h = ownerHue(name);
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-1.5 py-[1px] align-middle"
      style={{ color: `hsl(${h} 75% 72%)`, background: `hsl(${h} 70% 60% / 0.14)` }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: `hsl(${h} 75% 62%)` }} />
      {name}
    </span>
  );
}

function TaskRow({
  task,
  me,
  now,
  onRetry,
}: {
  task: ViewTask;
  me: string | null;
  now: number;
  onRetry: () => void;
}) {
  const mine = task.local || (!!me && task.owner === me);
  const stages = stagesFor(task.kind);
  const idx = stageIndexFor(task.kind, task.stage);
  const done = task.eff === "done";
  const error = task.eff === "error";
  const stale = task.eff === "stale";
  const running = task.eff === "running";
  // A stale task's clock froze at its owner's last sign of life — never tick a dead run.
  const end = task.finishedAt ?? (stale ? task.updatedMs ?? task.startedAt : now);
  const elapsed = task.startedAt ? Math.max(0, (end ?? now) - task.startedAt) : 0;

  const statusLabel = done
    ? task.kind === "clone"
      ? "Duplicated · live"
      : "Launched · live"
    : error
      ? task.error || "Failed"
      : stale
        ? task.status === "queued"
          ? "Interrupted — queued in a session that went offline"
          : "Interrupted — session went offline"
        : running
          ? stages[idx]?.label ?? "Working…"
          : "Queued";

  return (
    <div
      className={
        "animate-row-in rounded-xl border bg-surface2/40 p-3 transition-colors " +
        (error ? "border-danger/30" : stale ? "border-warn/30" : done ? "border-launch/25" : "border-line")
      }
    >
      <div className="flex items-start gap-2.5">
        <StatusDot eff={task.eff} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-medium text-ink" title={task.name}>
            {task.name || "Untitled campaign"}
          </p>
          <p className="mt-0.5 truncate font-mono text-[10.5px] text-faint">
            {task.partner === "us" ? "brand" : "gcm"} {task.gcm || "—"} · {task.geo} · ${moneyLabel(task.budget)} ·{" "}
            <OwnerChip owner={task.owner} mine={mine} />
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="font-mono text-[10.5px] tabular-nums text-faint">{fmtElapsed(elapsed)}</span>
          {error && task.local && !task.result?.campaignId ? (
            <button
              type="button"
              onClick={onRetry}
              data-tip="Retry"
              aria-label="Retry"
              className="tip flex h-6 w-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-raise hover:text-[#9db8ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <RetryIcon className="h-3.5 w-3.5" />
            </button>
          ) : error && task.result?.campaignId ? (
            // Partial failure — a campaign was created. Retrying would duplicate it, so show a
            // non-retryable marker pointing the buyer at Ads Manager instead of a Retry button.
            <span
              data-tip="Campaign was partially created — review/delete it in Ads Manager, don't retry"
              className="tip font-mono text-[9px] font-semibold uppercase tracking-wide text-warn"
            >
              partial
            </span>
          ) : null}
          {/* No Dismiss: error rows are a team-visible record (owner call 08-11) — failures
              can't be quietly swept from the drawer. */}
        </div>
      </div>

      {/* segmented stage bar */}
      <div className="mt-2.5 flex gap-1">
        {stages.map((s, i) => {
          const cls = done
            ? "bg-launch"
            : error && i === idx
              ? "bg-danger"
              : stale && i === idx
                ? "bg-warn"
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
            (done ? "text-launch2" : error ? "text-danger" : stale ? "text-warn" : "text-dim")
          }
        >
          {error || stale ? <AlertIcon className="h-3 w-3 shrink-0" /> : null}
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

function StatusDot({ eff }: { eff: EffStatus }) {
  if (eff === "running")
    return (
      <span className="relative mt-1 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <span className="z-10 h-2 w-2 rounded-full bg-[#9db8ff]" />
        <span className="absolute inset-0 animate-ping rounded-full bg-accent/40" />
      </span>
    );
  const color =
    eff === "done" ? "bg-launch2" : eff === "error" ? "bg-danger" : "bg-warn"; // queued + stale → warn
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

// Keep TaskStatus referenced for consumers that narrow on it (type-only re-export below).
export type { TaskStatus, ViewTask };
