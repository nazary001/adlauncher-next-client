"use client";

// Task manager for the Snapchat platform tab — the compact Google-manager shape (no client
// uploads beyond the board's Blob step, no token channel, no partner finisher). The board fires
// ONE wave POST (/api/snap/launch); the server's after() pump claims a key, uploads the creative
// to Snapchat and builds campaign → ad squad → creative → ad → activate, writing the shared
// Strapi row at every stage — so this provider never runs work: it MIRRORS the team's rows
// (partner="sn" scope via /api/snap-tasks). Own-row authority as in the Google manager: a row I
// patched locally (the 3 h age-out) stays until the server echoes a newer updatedMs. No retry
// (creates are exactly-once — re-fire from the board), no dismiss (errors are the team record).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { moneyLabel } from "@/lib/types";
import { STALE_MS, ownerHue } from "@/lib/task-view";
import { snapCurrencySymbol } from "@/lib/snap-launch";
import { SNAP_ENABLED } from "@/lib/partners";
import { AlertIcon, CheckIcon, CopyIcon, RocketIcon, SnapMark, TasksIcon, XIcon } from "./icons";

// ---------- model ----------

export type SnapTask = {
  id: string;
  name: string;
  owner: string | null;
  /** The partner key (Strapi gcm column) — "" until the pump claimed one. */
  key: string;
  campaignId?: string;
  adSquadId?: string;
  adId?: string;
  /** The final landing URL with the key (Strapi link column). */
  link?: string;
  geo: string;
  budget: string;
  bid?: string;
  status: "queued" | "running" | "done" | "error" | "interrupted";
  /** key | media | campaign | adsquad | creative | ad | activate | live | paused | failed */
  stage: string | null;
  error?: string;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  updatedMs?: number;
};

/** GET /api/snap-tasks row shape (verbatim wire contract). */
type SnapRemoteRow = {
  id: string;
  owner: string | null;
  name: string;
  geo: string;
  budget: string;
  status: string;
  stage: string | null;
  key: string | null;
  campaignId: string | null;
  adSquadId: string | null;
  adId: string | null;
  link: string | null;
  bid: string | null;
  error: string | null;
  queued_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  updated_ms: number | null;
};

const SHARED_POLL_OPEN_MS = 6_000;
const SHARED_POLL_CLOSED_MS = 20_000;
/** My running row still not terminal after this long → interrupted (the pump's budget is 13 min;
 *  3 h means the row is wedged for good). */
const AGE_OUT_MS = 3 * 60 * 60_000;

// ---------- pure helpers ----------

const n = (v: unknown): number | undefined => {
  if (v == null || v === "") return undefined;
  const x = Number(v);
  return Number.isFinite(x) ? x : undefined;
};

function fromRemote(r: SnapRemoteRow): SnapTask {
  const raw = r.status;
  const status: SnapTask["status"] = raw === "done" || raw === "error" || raw === "interrupted" || raw === "running" ? raw : "queued";
  return {
    id: r.id,
    name: r.name || "",
    owner: r.owner ?? null,
    key: r.key || "",
    campaignId: r.campaignId || undefined,
    adSquadId: r.adSquadId || undefined,
    adId: r.adId || undefined,
    link: r.link || undefined,
    geo: r.geo || "",
    budget: r.budget || "",
    bid: r.bid || undefined,
    status,
    stage: r.stage || null,
    error: r.error || undefined,
    queuedAt: n(r.queued_at) ?? Date.now(),
    startedAt: n(r.started_at),
    finishedAt: n(r.finished_at),
    updatedMs: n(r.updated_ms),
  };
}

/** Same merge as the Google manager: my newer local patch outranks a stale echo; unchanged rows
 *  keep object identity; everything else mirrors the fetch. Newest first. */
function mergeShared(cur: SnapTask[], fetched: SnapTask[], tombstones: ReadonlySet<string>): SnapTask[] {
  const curById = new Map(cur.map((c) => [c.id, c]));
  const byId = new Map<string, SnapTask>();
  for (const f of fetched) {
    if (!f.id || tombstones.has(f.id)) continue;
    const prev = curById.get(f.id);
    if (prev && prev.updatedMs != null && (f.updatedMs == null || prev.updatedMs > f.updatedMs)) byId.set(f.id, prev);
    else if (prev && prev.updatedMs != null && prev.updatedMs === f.updatedMs) byId.set(f.id, prev);
    else byId.set(f.id, f);
  }
  const next = [...byId.values()].sort((a, b) => b.queuedAt - a.queuedAt || (a.id < b.id ? 1 : -1));
  return next.length === cur.length && next.every((t, i) => t === cur[i]) ? cur : next;
}

function ownerLastWrite(tasks: readonly SnapTask[]): Map<string, number> {
  const last = new Map<string, number>();
  for (const t of tasks) {
    if (!t.owner || t.updatedMs == null) continue;
    if ((last.get(t.owner) ?? 0) < t.updatedMs) last.set(t.owner, t.updatedMs);
  }
  return last;
}

const isTerminal = (st: SnapTask["status"]) => st === "done" || st === "error" || st === "interrupted";

function isStaleRow(t: SnapTask, me: string | null, lastWriteByOwner: ReadonlyMap<string, number>, estServerNow: number): boolean {
  const mine = !!me && t.owner === me;
  if (mine || isTerminal(t.status)) return false;
  const last = t.owner ? lastWriteByOwner.get(t.owner) : undefined;
  if (!last) return true;
  return estServerNow - last > STALE_MS;
}

function fmtElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
  return `${m}:${String(sec % 60).padStart(2, "0")}`;
}

/** The stage/status one-liner for a row. */
export function snapStageLabel(t: SnapTask): string {
  if (t.status === "done") {
    const where = t.stage === "paused" ? "Built · PAUSED" : "Live";
    return t.error ? `${where} · ${t.error}` : `${where} on Snapchat${t.key ? ` · ${t.key}` : ""}`;
  }
  if (t.status === "error") return t.error || "Failed";
  if (t.status === "interrupted") return t.error || "Check Ads Manager";
  switch (t.stage) {
    case "key":
      return "Claiming a partner key…";
    case "media":
      return "Uploading the creative to Snapchat…";
    case "campaign":
      return "Creating the campaign (paused)…";
    case "adsquad":
      return "Creating the ad squad…";
    case "creative":
      return "Creating the creative…";
    case "ad":
      return "Creating the ad…";
    case "activate":
      return "Activating the campaign…";
    default:
      return t.status === "queued" ? "Queued — safe to close the tab" : "Working…";
  }
}

// ---------- context ----------

export type SnapTaskManagerValue = {
  tasks: SnapTask[];
  counts: { active: number; done: number; failed: number; running: number; total: number };
  me: string | null;
  open: boolean;
  setOpen: (v: boolean) => void;
  refresh: () => void;
  estServerNow: number;
};

const Ctx = createContext<SnapTaskManagerValue | null>(null);

export function useSnapTaskManager(): SnapTaskManagerValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSnapTaskManager must be used within SnapTaskManagerProvider");
  return v;
}

// ---------- provider ----------

// Dormant on prod (NEXT_PUBLIC_SNAP_ENABLED unset → SNAP_ENABLED is false at build time): the tab is hidden and
// /api/snap-tasks answers 404, so this provider must not generate traffic — every fetch, poll and save is gated.
export function SnapTaskManagerProvider({ children, user }: { children: React.ReactNode; user?: { username: string; role?: string | null } }) {
  const me = user?.username ?? null;
  const [tasks, setTasks] = useState<SnapTask[]>([]);
  const [open, setOpen] = useState(false);
  const [skew, setSkew] = useState(0);
  const skewRef = useRef(0);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const tasksRef = useRef<SnapTask[]>([]);
  const openRef = useRef(false);
  const lastSharedPollRef = useRef(0);
  const saveChains = useRef(new Map<string, Promise<unknown>>());
  const tombstones = useRef<Set<string>>(new Set());

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  useEffect(() => {
    const ids = new Set(tasks.map((t) => t.id));
    for (const k of [...saveChains.current.keys()]) if (!ids.has(k)) saveChains.current.delete(k);
  }, [tasks]);

  const isMine = useCallback((t: SnapTask) => !!me && t.owner === me, [me]);

  const noteSkew = useCallback((serverNow: number) => {
    const sk = serverNow - Date.now();
    skewRef.current = sk;
    setSkew((prev) => (Math.abs(prev - sk) > 3000 ? sk : prev));
  }, []);

  const patch = useCallback((id: string, p: Partial<SnapTask>) => {
    const stamp = Date.now() + skewRef.current;
    setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, ...p, updatedMs: Math.max(t.updatedMs ?? 0, stamp) } : t)));
  }, []);

  const saveRemote = useCallback((id: string, dyn: Record<string, unknown>) => {
    if (!SNAP_ENABLED) return;
    const body = JSON.stringify({ tasks: [{ task_id: id, ...dyn }] });
    const post = () => fetch("/api/snap-tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(20_000) });
    const prev = saveChains.current.get(id) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        try {
          const res = await post();
          if (res.ok || (res.status >= 400 && res.status < 500)) return;
        } catch {
          /* network — retry once */
        }
        await new Promise((r) => setTimeout(r, 4000));
        await post().catch(() => {});
      });
    saveChains.current.set(id, next);
  }, []);

  const loadRemote = useCallback(() => {
    if (!SNAP_ENABLED) return;
    fetch("/api/snap-tasks", { signal: AbortSignal.timeout(20_000) })
      .then(async (r) => {
        if (!r.ok) return;
        const d = (await r.json().catch(() => null)) as { ok?: boolean; now?: number; tasks?: SnapRemoteRow[] } | null;
        if (!d?.ok || !Array.isArray(d.tasks)) return;
        if (typeof d.now === "number") noteSkew(d.now);
        const fetched = d.tasks.map(fromRemote);
        setTasks((cur) => mergeShared(cur, fetched, tombstones.current));
      })
      .catch(() => {});
  }, [noteSkew]);

  useEffect(() => {
    if (!SNAP_ENABLED) return;
    loadRemote();
  }, [loadRemote]);

  // Shared-store polling (faster while open) + a coarse clock for stale detection + the age-out
  // of MY wedged running rows (the pump's budget is 13 min; 3 h of "running" is a dead row).
  useEffect(() => {
    if (!SNAP_ENABLED) return;
    const tick = () => {
      if (document.hidden) return;
      const interval = openRef.current ? SHARED_POLL_OPEN_MS : SHARED_POLL_CLOSED_MS;
      if (Date.now() - lastSharedPollRef.current < interval - 300) return;
      lastSharedPollRef.current = Date.now();
      loadRemote();
      const now = Date.now();
      for (const t of tasksRef.current) {
        if (!isMine(t) || t.status !== "running") continue;
        const from = t.startedAt ?? t.queuedAt;
        if (from && now - from > AGE_OUT_MS) {
          const error = "Still not finished after 3 h — check Ads Manager and the key registry";
          const finishedAt = from + AGE_OUT_MS;
          patch(t.id, { status: "interrupted", error, finishedAt });
          saveRemote(t.id, { status: "interrupted", stage: t.stage ?? "failed", error, finished_at: finishedAt });
        }
      }
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
    const clock = window.setInterval(() => setNowTick(Date.now()), 10_000);
    return () => {
      window.clearInterval(iv);
      window.clearInterval(clock);
      window.removeEventListener("focus", onVis);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [loadRemote, isMine, patch, saveRemote]);

  useEffect(() => {
    if (!SNAP_ENABLED || !open) return;
    lastSharedPollRef.current = Date.now();
    loadRemote();
  }, [open, loadRemote]);

  const estServerNow = nowTick + skew;

  const counts = useMemo(() => {
    const lastWrite = ownerLastWrite(tasks);
    let active = 0,
      done = 0,
      failed = 0,
      running = 0;
    for (const t of tasks) {
      if (isStaleRow(t, me, lastWrite, estServerNow)) {
        failed++;
        continue;
      }
      if (t.status === "queued" || t.status === "running") active++;
      if (t.status === "running") running++;
      if (t.status === "done") done++;
      if (t.status === "error" || t.status === "interrupted") failed++;
    }
    return { active, done, failed, running, total: tasks.length };
  }, [tasks, me, estServerNow]);

  const value: SnapTaskManagerValue = { tasks, counts, me, open, setOpen, refresh: loadRemote, estServerNow };
  return (
    <Ctx.Provider value={value}>
      {children}
      <SnapTaskManagerPanel />
    </Ctx.Provider>
  );
}

// ---------- header button ----------

export function SnapTaskManagerButton() {
  const { counts, setOpen } = useSnapTaskManager();
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
      aria-label="Open Snapchat Task Manager"
      className={"relative flex h-9 items-center gap-2 rounded-full border px-3 text-[13px] font-medium transition-all duration-200 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-launch/40 " + tone}
    >
      <span className="relative">
        <TasksIcon className="h-4 w-4" />
        {counts.running > 0 ? <span className="animate-pulse-soft absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-launch2" /> : null}
      </span>
      <span className="hidden whitespace-nowrap sm:inline">Snap tasks</span>
      {badge > 0 ? (
        <span key={badge} className={"animate-badge-pop grid h-4 min-w-4 place-items-center rounded-full px-1 font-mono text-[10px] font-semibold " + (counts.active > 0 ? "bg-launch text-[#032e20]" : "bg-danger text-white")}>
          {badge}
        </span>
      ) : null}
    </button>
  );
}

// ---------- drawer ----------

type Filter = "all" | "active" | "done" | "failed";

function SnapTaskManagerPanel() {
  const { tasks, counts, me, open, setOpen, refresh, estServerNow } = useSnapTaskManager();
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

  const lastWrite = useMemo(() => ownerLastWrite(tasks), [tasks]);
  if (!open) return null;

  const staleOf = (t: SnapTask) => isStaleRow(t, me, lastWrite, estServerNow);
  const inBucket = (t: SnapTask): boolean =>
    filter === "all" ? true : filter === "active" ? (t.status === "queued" || t.status === "running") && !staleOf(t) : filter === "done" ? t.status === "done" : t.status === "error" || t.status === "interrupted" || staleOf(t);
  const isMineRow = (t: SnapTask) => !!me && t.owner === me;
  const shown = (mineOnly ? tasks.filter(isMineRow) : tasks).filter(inBucket);
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
        <div className="flex items-center justify-between border-b border-line px-4 py-3.5">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#FFFC00]/15">
              <SnapMark className="h-4 w-4" />
            </span>
            <div className="leading-none">
              <h2 className="text-[14px] font-semibold text-ink">Snapchat Task Manager</h2>
              <p className="mt-1 text-[10px] uppercase tracking-[0.16em] text-faint">Launches on our ad account · one key per campaign</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button type="button" onClick={refresh} aria-label="Refresh" data-tip="Refresh" className="tip flex h-8 w-8 items-center justify-center rounded-lg text-faint transition-colors hover:bg-raise hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
              <RocketIcon className="h-4 w-4" />
            </button>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-lg text-faint transition-colors hover:bg-raise hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
              <XIcon className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="flex items-center gap-1.5 border-b border-line px-4 py-2.5">
          <Stat label="Active" n={counts.active} tone="text-[#9db8ff]" />
          <Stat label="Done" n={counts.done} tone="text-launch2" />
          <Stat label="Failed" n={counts.failed} tone="text-danger" />
        </div>
        <div className="flex items-center gap-1 px-3 pt-3">
          {tabs.map((tab) => (
            <button key={tab.key} type="button" onClick={() => setFilter(tab.key)} className={"flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors duration-150 " + (filter === tab.key ? "bg-raise text-ink" : "text-faint hover:text-dim")}>
              {tab.label}
              <span className="font-mono text-[10.5px] text-faint">{tab.n}</span>
            </button>
          ))}
          <button type="button" aria-pressed={mineOnly} onClick={() => setMineOnly((v) => !v)} className={"ml-auto rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors duration-150 " + (mineOnly ? "bg-accent/15 text-[#9db8ff]" : "text-faint hover:text-dim")}>
            Mine
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-3">
          {shown.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 py-16 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-surface2 text-faint">
                <SnapMark className="h-5 w-5" mono />
              </span>
              <p className="text-[13px] font-medium text-dim">Nothing here yet</p>
              <p className="max-w-[250px] text-[11.5px] leading-relaxed text-faint">Snapchat launches land here. A green row means the campaign is built on Snapchat — the wave runs server-side, so this tab may be closed.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {shown.map((t) => (
                <SnapTaskRow key={t.id} task={t} mine={isMineRow(t)} stale={staleOf(t)} now={now} />
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-line px-4 py-2.5">
          <span className="text-[10.5px] leading-relaxed text-faint">Rows are shared with the team; campaigns are born PAUSED and activated once the ad exists.</span>
        </div>
      </aside>
    </div>
  );
}

function Stat({ label, n, tone }: { label: string; n: number; tone: string }) {
  return (
    <span className="flex items-center gap-1.5 rounded-md border border-line bg-surface2/50 px-2 py-1 text-[11px]">
      <span className="text-faint">{label}</span>
      <span className={"font-mono text-[11.5px] font-semibold tabular-nums " + tone}>{n}</span>
    </span>
  );
}

function SnapTaskRow({ task: t, mine, stale, now }: { task: SnapTask; mine: boolean; stale: boolean; now: number }) {
  const done = t.status === "done";
  const error = t.status === "error";
  const interrupted = t.status === "interrupted";
  const running = t.status === "running" && !stale;
  const end = t.finishedAt ?? now;
  const elapsed = t.startedAt ? Math.max(0, end - t.startedAt) : 0;
  const label = stale ? (t.error ?? "Session went offline before this run finished") : snapStageLabel(t);
  const budget = `${snapCurrencySymbol("USD")}${moneyLabel(t.budget)}`;
  return (
    <div className={"animate-row-in rounded-xl border bg-surface2/40 p-3 transition-colors " + (error ? "border-danger/30" : interrupted || stale ? "border-warn/30" : done ? "border-launch/25" : "border-line")}>
      <div className="flex items-start gap-2.5">
        <SnapStatusDot status={t.status} stale={stale} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-medium text-ink" title={t.name}>
            {t.name || "Untitled campaign"}
          </p>
          <p className="mt-0.5 flex items-center gap-1.5 truncate font-mono text-[10.5px] text-faint">
            <OwnerChip owner={t.owner} mine={mine} />
            {t.key ? <span className="shrink-0 rounded bg-[#FFFC00]/15 px-1 py-[1px] text-[9.5px] font-semibold text-[#f3f0a3]">{t.key}</span> : null}
            <span className="truncate">
              {t.geo || "—"} · {budget}
              {t.bid ? ` · ${t.bid}` : ""}
            </span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {stale ? <span className="rounded-md border border-warn/25 bg-warn/5 px-1.5 py-0.5 text-[9.5px] font-medium text-warn">session offline</span> : null}
          <span className="font-mono text-[10.5px] tabular-nums text-faint">{fmtElapsed(elapsed)}</span>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className={"flex min-w-0 items-center gap-1.5 truncate text-[11px] " + (done ? "text-launch2" : error ? "text-danger" : interrupted || stale ? "text-warn" : "text-dim")}>
          {error || interrupted || stale ? <AlertIcon className="h-3 w-3 shrink-0" /> : null}
          {done ? <CheckIcon className="h-3 w-3 shrink-0" /> : null}
          {running ? <RocketIcon className="h-3 w-3 shrink-0 text-[#9db8ff]" /> : null}
          <span className="truncate" title={label}>
            {label}
          </span>
        </span>
      </div>
      {t.campaignId || t.adSquadId || t.adId || t.link ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {t.campaignId ? <CopyId prefix="cmp" id={t.campaignId} /> : null}
          {t.adSquadId ? <CopyId prefix="squad" id={t.adSquadId} /> : null}
          {t.adId ? <CopyId prefix="ad" id={t.adId} /> : null}
          {t.link ? <CopyId prefix="link" id={t.link} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function SnapStatusDot({ status, stale }: { status: SnapTask["status"]; stale: boolean }) {
  if (status === "running" && !stale)
    return (
      <span className="relative mt-1 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <span className="z-10 h-2 w-2 rounded-full bg-[#9db8ff]" />
        <span className="absolute inset-0 animate-ping rounded-full bg-accent/40" />
      </span>
    );
  const color = stale ? "bg-warn" : status === "done" ? "bg-launch2" : status === "error" ? "bg-danger" : status === "interrupted" ? "bg-warn" : "bg-line2";
  return <span className={"mt-1.5 h-2 w-2 shrink-0 rounded-full " + color} />;
}

function OwnerChip({ owner, mine }: { owner: string | null; mine: boolean }) {
  if (mine) return <span className="shrink-0 text-dim">you</span>;
  const name = owner || "—";
  const h = ownerHue(name);
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-[1px]" style={{ color: `hsl(${h} 75% 72%)`, background: `hsl(${h} 70% 60% / 0.14)` }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: `hsl(${h} 75% 62%)` }} />
      {name}
    </span>
  );
}

function CopyId({ prefix, id }: { prefix: string; id: string }) {
  const [copied, setCopied] = useState(false);
  const short = id.length > 28 ? `${id.slice(0, 26)}…` : id;
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(id);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="flex max-w-full shrink-0 items-center gap-1 rounded-md border border-line bg-surface2/60 px-1.5 py-0.5 font-mono text-[10px] text-dim transition-colors hover:border-line2 hover:text-ink"
      title={`Copy ${prefix}: ${id}`}
    >
      {copied ? <CheckIcon className="h-3 w-3 text-launch2" /> : <CopyIcon className="h-3 w-3" />}
      <span className="truncate">
        {prefix} {short}
      </span>
    </button>
  );
}
