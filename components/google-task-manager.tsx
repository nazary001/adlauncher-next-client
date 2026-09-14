"use client";

// Task manager for the Google platform tab. Deliberately a COMPACT sibling of the 1 800-line HS
// manager, not a fork: a Google launch has no client uploads, no token channel and no
// auto-activation. The board fires ONE wave POST (/api/google/clone|juro); the server's after()
// pump ensures each source's dataset, submits every shot to google-weapon exactly-once and writes
// the shared Strapi row at every stage — so the board can close the moment it queues. This
// provider therefore never enqueues or runs work: it MIRRORS the team's shared rows (partner="gg"
// scope via /api/google-tasks). Since 15.09 a row is DONE the moment LION accepts the shot
// ("Sent to LION", HS-launch parity — the build itself is checked in LION); the finisher that
// polls /api/google/status only remains for MY legacy rows still "running" from before that
// (LION owns the build server-side; its completed/failed answer turns such a row green or red).
// Own-row authority: a row I just
// patched locally stays until the server echoes a newer updatedMs, so a racing shared fetch can't
// flip my just-finished row back to "running". No retry/dismiss — creates are exactly-once (re-fire
// from the board) and every error is the team's permanent record.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { moneyLabel } from "@/lib/types";
import { STALE_MS, ownerHue } from "@/lib/task-view";
import { AlertIcon, CheckIcon, CopyIcon, GoogleMark, RocketIcon, TasksIcon, XIcon } from "./icons";

// ---------- model ----------

/** Google task as the drawer renders it. Mirror of the shared Strapi row (partner="gg") mapped
 *  from GoogleRemoteRow; `kind` is decoded from the `gcm` marker ("g-clone"/"g-juro"). status is
 *  the store enum — queued|running|done|error|interrupted (no "submitted": a Google row is either
 *  waiting on the pump/LION = running, or terminal). */
export type GoogleTask = {
  id: string;
  name: string;
  kind: "clone" | "juro" | "launch" | null;
  /** Username that fired this wave. Everyone sees every row; only the owner's session finishes it. */
  owner: string | null;
  /** Target Google Ads customer id (Strapi adset_id column). */
  customer: string;
  /** Target account currency code, e.g. "BRL" (Strapi ad_id column). */
  currency: string;
  geo: string;
  budget: string;
  /** Pre-formatted "what it bids on" tag ("CPA 3,95" / "ROAS 90%" / "auto" / "inherit"). */
  bid?: string;
  status: "queued" | "running" | "done" | "error" | "interrupted";
  /** dataset | submit | sent (done at LION acceptance) | failed; legacy rows: lion | queue | done. */
  stage: string | null;
  /** google-weapon task id (Strapi link column) — the finisher polls this. */
  lionTaskId?: string;
  campaignId?: string;
  error?: string;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Server-side updatedAt (ms) of the Strapi row — the liveness signal behind `stale` AND the
   *  own-row authority key (a local patch bumps it to the est. server clock so it outranks a
   *  lagging fetch until the server's own echo catches up). */
  updatedMs?: number;
};

/** GET /api/google-tasks row shape (verbatim wire contract). */
type GoogleRemoteRow = {
  id: string;
  owner: string | null;
  name: string;
  geo: string;
  budget: string;
  status: string;
  stage: string | null;
  lionTaskId: string | null;
  kind: string | null; // "g-clone" | "g-juro" | "g-launch"
  campaignId: string | null;
  customer: string | null; // adset_id
  currency: string | null; // ad_id
  bid: string | null;
  error: string | null;
  queued_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  updated_ms: number | null;
};

// Shared-store cadence: pull the team's Google rows continuously so the drawer stays truthful even
// for rows I did not fire (faster while the drawer is open). Matches the HS manager's cadence.
const SHARED_POLL_OPEN_MS = 6_000;
const SHARED_POLL_CLOSED_MS = 20_000;
// LION finisher cadence (my running rows only): google-weapon is the shared partner, so keep the
// batched read gentle — one call covers every pending task of mine.
const FINISH_OPEN_MS = 12_000;
const FINISH_CLOSED_MS = 30_000;
// My running row still not terminal after this long stops finishing and asks the buyer to check
// google-weapon. LION can chew on a task for a while; the cap only stops polling forever-wedged rows.
const AGE_OUT_MS = 3 * 60 * 60_000;

// ---------- pure helpers ----------

const n = (v: unknown): number | undefined => {
  if (v == null || v === "") return undefined;
  const x = Number(v);
  return Number.isFinite(x) ? x : undefined;
};

/** "g-clone" → "clone", "g-juro" → "juro", "g-launch" → "launch", else null (older/foreign row). */
function kindOf(gcm: string | null): "clone" | "juro" | "launch" | null {
  if (gcm === "g-clone") return "clone";
  if (gcm === "g-juro") return "juro";
  if (gcm === "g-launch") return "launch";
  return null;
}

/** GoogleRemoteRow → GoogleTask (restore/mirror). */
function fromRemote(r: GoogleRemoteRow): GoogleTask {
  const raw = r.status;
  const status: GoogleTask["status"] =
    raw === "done" || raw === "error" || raw === "interrupted" || raw === "running" ? raw : "queued";
  return {
    id: r.id,
    name: r.name || "",
    kind: kindOf(r.kind),
    owner: r.owner ?? null,
    customer: r.customer || "",
    currency: (r.currency || "").toUpperCase(),
    geo: r.geo || "",
    budget: r.budget || "",
    bid: r.bid || undefined,
    status,
    stage: r.stage || null,
    lionTaskId: r.lionTaskId || undefined,
    campaignId: r.campaignId || undefined,
    error: r.error || undefined,
    queuedAt: n(r.queued_at) ?? Date.now(),
    startedAt: n(r.started_at),
    finishedAt: n(r.finished_at),
    updatedMs: n(r.updated_ms),
  };
}

/**
 * Merge a freshly-fetched shared list into the in-memory list.
 * - A row I locally patched (finisher/age-out) carries an updatedMs bumped to the est. server
 *   clock; it stays authoritative until the server echoes an equal-or-newer updatedMs (my POST
 *   landed), so a racing fetch that snapshotted the pre-finish row can't undo my verdict.
 * - Every other row mirrors the fetch exactly: present → shown, absent → deleted/aged-out → gone.
 * - Object identity is preserved when a row's updatedMs is unchanged (updatedAt bumps on every
 *   Strapi write, so it doubles as a version) — a quiet poll then re-renders nothing.
 * Newest first (queuedAt desc, id as the deterministic tiebreak).
 */
function mergeShared(cur: GoogleTask[], fetched: GoogleTask[], tombstones: ReadonlySet<string>): GoogleTask[] {
  const curById = new Map(cur.map((c) => [c.id, c]));
  const byId = new Map<string, GoogleTask>();
  for (const f of fetched) {
    if (!f.id || tombstones.has(f.id)) continue;
    const prev = curById.get(f.id);
    if (prev && prev.updatedMs != null && (f.updatedMs == null || prev.updatedMs > f.updatedMs)) {
      byId.set(f.id, prev); // own-row authority: my local patch outranks a stale/absent echo
    } else if (prev && prev.updatedMs != null && prev.updatedMs === f.updatedMs) {
      byId.set(f.id, prev); // unchanged — keep object identity
    } else {
      byId.set(f.id, f);
    }
  }
  const next = [...byId.values()].sort((a, b) => b.queuedAt - a.queuedAt || (a.id < b.id ? 1 : -1));
  return next.length === cur.length && next.every((t, i) => t === cur[i]) ? cur : next;
}

/** Freshest server write per owner (max updatedMs across ALL their rows — any activity counts). */
function ownerLastWrite(tasks: readonly GoogleTask[]): Map<string, number> {
  const last = new Map<string, number>();
  for (const t of tasks) {
    if (!t.owner || t.updatedMs == null) continue;
    if ((last.get(t.owner) ?? 0) < t.updatedMs) last.set(t.owner, t.updatedMs);
  }
  return last;
}

const isTerminal = (st: GoogleTask["status"]) => st === "done" || st === "error" || st === "interrupted";

/** A teammate's non-terminal row whose owner session stopped writing (> STALE_MS) — the "session
 *  offline" state. ONE predicate for the row, the counts, the tabs, so the header can never
 *  contradict the list. My own rows are never stale (this session is alive by definition). */
function isStaleRow(t: GoogleTask, me: string | null, lastWriteByOwner: ReadonlyMap<string, number>, estServerNow: number): boolean {
  const mine = !!me && t.owner === me;
  if (mine || isTerminal(t.status)) return false;
  const last = t.owner ? lastWriteByOwner.get(t.owner) : undefined;
  if (!last) return true; // no liveness signal at all
  return estServerNow - last > STALE_MS;
}

/** Currency code → the symbol the boards use. Falls back to the bare code. */
function currencySymbol(code: string): string {
  switch (code.toUpperCase()) {
    case "BRL":
      return "R$";
    case "USD":
      return "$";
    case "EUR":
      return "€";
    default:
      return code ? `${code} ` : "";
  }
}

/** "R$ 30" / "$30" — a space only after a multi-char symbol so single glyphs stay tight. */
function budgetLabel(budget: string, currency: string): string {
  const sym = currencySymbol(currency);
  const amt = moneyLabel(budget);
  return sym.trim().length > 1 ? `${sym} ${amt}` : `${sym}${amt}`;
}

/** A 10-digit Google customer id, shortened for the dense mono row: "…5678" (last 4). */
function shortCustomer(id: string): string {
  if (!id) return "—";
  return id.length > 6 ? `…${id.slice(-4)}` : id;
}

/** mm:ss, or h:mm:ss once a row has been running for an hour (the 3 h cap would read "180:00"). */
function fmtElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
  return `${m}:${String(sec % 60).padStart(2, "0")}`;
}

/** The stage/status one-liner for a row. */
function stageLabel(t: GoogleTask): string {
  // Acceptance is the terminal outcome (15.09): a done row without a campaign id reads "Sent to
  // LION" like the HS launches; legacy rows the old pump/finisher completed keep the richer label.
  if (t.status === "done") return t.campaignId ? `Created on LION · cmp ${t.campaignId}` : "Sent to LION";
  if (t.status === "error") return t.error || "Failed";
  if (t.status === "interrupted") return t.error || "Check google-weapon";
  switch (t.stage) {
    case "dataset":
      return "Fetching source dataset…";
    case "submit":
      return "Submitting to LION…";
    case "queue":
      return "On LION: pending";
    case "lion":
      return "On LION: running";
    default:
      return t.status === "queued" ? "Queued — safe to close the tab" : "Working…";
  }
}

// ---------- context ----------

export type GoogleTaskManagerValue = {
  tasks: GoogleTask[];
  counts: { active: number; done: number; failed: number; running: number; total: number };
  /** Current user — labels owners in the shared view and gates own-only finishing. */
  me: string | null;
  open: boolean;
  setOpen: (v: boolean) => void;
  /** Force an immediate shared-store pull (the drawer's refresh button). */
  refresh: () => void;
  /** Client's estimate of the SERVER clock (local tick + measured skew) — the one clock every
   *  owner-liveness judgement uses (counts, tabs, the drawer's rows), so they can never disagree. */
  estServerNow: number;
};

const Ctx = createContext<GoogleTaskManagerValue | null>(null);

export function useGoogleTaskManager(): GoogleTaskManagerValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useGoogleTaskManager must be used within GoogleTaskManagerProvider");
  return v;
}

// ---------- provider ----------

export function GoogleTaskManagerProvider({
  children,
  user,
}: {
  children: React.ReactNode;
  user?: { username: string; role?: string | null };
}) {
  const me = user?.username ?? null;
  const [tasks, setTasks] = useState<GoogleTask[]>([]);
  const [open, setOpen] = useState(false);
  const [skew, setSkew] = useState(0);
  const skewRef = useRef(0);
  const [nowTick, setNowTick] = useState(() => Date.now());

  const tasksRef = useRef<GoogleTask[]>([]);
  const openRef = useRef(false);
  const lastSharedPollRef = useRef(0);
  const lastFinishRef = useRef(0);
  const finishBusyRef = useRef(false);
  // Per-task save chains so a row's transitions land on Strapi in order; tombstones for ids that a
  // just-fired write should not be undone by (unused here — no dismiss — but kept for symmetry with
  // mergeShared's signature and any future delete path).
  const saveChains = useRef(new Map<string, Promise<unknown>>());
  const tombstones = useRef<Set<string>>(new Set());

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  // Long-lived tabs: drop save chains whose task left the drawer so the map can't grow forever.
  useEffect(() => {
    const ids = new Set(tasks.map((t) => t.id));
    for (const k of [...saveChains.current.keys()]) if (!ids.has(k)) saveChains.current.delete(k);
  }, [tasks]);

  const isMine = useCallback((t: GoogleTask) => !!me && t.owner === me, [me]);

  const noteSkew = useCallback((serverNow: number) => {
    const sk = serverNow - Date.now();
    skewRef.current = sk;
    setSkew((prev) => (Math.abs(prev - sk) > 3000 ? sk : prev));
  }, []);

  /** Locally patch a row AND stamp its updatedMs to the est. server clock so mergeShared keeps my
   *  copy authoritative until the server echoes my persisted write back. */
  const patch = useCallback((id: string, p: Partial<GoogleTask>) => {
    const stamp = Date.now() + skewRef.current;
    setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, ...p, updatedMs: Math.max(t.updatedMs ?? 0, stamp) } : t)));
  }, []);

  /** Upsert one Google row's dynamic fields to Strapi (partner="gg" is forced server-side),
   *  chained PER TASK so transitions land in order. 20 s timeout; one retry on network failure. */
  const saveRemote = useCallback((id: string, dyn: Record<string, unknown>) => {
    const body = JSON.stringify({ tasks: [{ task_id: id, ...dyn }] });
    const post = () =>
      fetch("/api/google-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(20_000),
      });
    const prev = saveChains.current.get(id) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        try {
          const res = await post();
          // 4xx = the server rejected the write deterministically (guard hit) — no point retrying.
          if (res.ok || (res.status >= 400 && res.status < 500)) return;
        } catch {
          /* network — retry once */
        }
        await new Promise((r) => setTimeout(r, 4000));
        await post().catch(() => {});
      });
    saveChains.current.set(id, next);
  }, []);

  /** Pull the team's Google rows and merge them in (mine stay mine while my patch is newer). */
  const loadRemote = useCallback(() => {
    fetch("/api/google-tasks", { signal: AbortSignal.timeout(20_000) })
      .then(async (r) => {
        if (!r.ok) return;
        const d = (await r.json().catch(() => null)) as { ok?: boolean; now?: number; tasks?: GoogleRemoteRow[] } | null;
        if (!d?.ok || !Array.isArray(d.tasks)) return;
        if (typeof d.now === "number") noteSkew(d.now);
        const fetched = d.tasks.map(fromRemote);
        setTasks((cur) => mergeShared(cur, fetched, tombstones.current));
      })
      .catch(() => {});
  }, [noteSkew]);

  // Initial load.
  useEffect(() => {
    loadRemote();
  }, [loadRemote]);

  // Shared-store polling: keep the team's rows fresh (faster while the drawer is open), and drive
  // a coarse clock so stale detection advances even with the drawer closed.
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
    const clock = window.setInterval(() => setNowTick(Date.now()), 10_000);
    return () => {
      window.clearInterval(iv);
      window.clearInterval(clock);
      window.removeEventListener("focus", onVis);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [loadRemote]);

  // ---- LION finisher: only MY LEGACY running rows (stamped before 15.09) with a google-weapon task id ----

  const finish = useCallback(async () => {
    const now = Date.now();
    // Age out MY running rows stuck for 3 h — stop burning polls, tell the buyer. Runs BEFORE the
    // busy latch so it fires even if a status fetch is wedged.
    for (const t of tasksRef.current) {
      if (!isMine(t) || t.status !== "running") continue;
      const from = t.startedAt ?? t.queuedAt;
      if (from && now - from > AGE_OUT_MS) {
        const error = "Still not finished after 3 h — check google-weapon";
        const finishedAt = from + AGE_OUT_MS;
        patch(t.id, { status: "interrupted", error, finishedAt });
        saveRemote(t.id, { status: "interrupted", stage: t.stage ?? "lion", error, finished_at: finishedAt });
      }
    }
    if (finishBusyRef.current) return;
    const pending = tasksRef.current.filter((t) => isMine(t) && t.status === "running" && t.lionTaskId);
    if (pending.length === 0) return;
    finishBusyRef.current = true;
    try {
      const res = await fetch("/api/google/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskIds: [...new Set(pending.map((t) => t.lionTaskId as string))] }),
        signal: AbortSignal.timeout(20_000),
      });
      const d = (await res.json().catch(() => null)) as
        | {
            ok?: boolean;
            tasks?: { taskId: string; status: string; campaignId: string | null; campaignName: string | null; error: string | null }[];
          }
        | null;
      if (!d?.ok || !Array.isArray(d.tasks)) return;
      const byLionId = new Map(d.tasks.map((t) => [t.taskId, t]));
      for (const t of pending) {
        const r = byLionId.get(t.lionTaskId as string);
        if (!r) continue;
        const finishedAt = Date.now();
        if (r.status === "completed") {
          const p: Partial<GoogleTask> = {
            status: "done",
            stage: "done",
            finishedAt,
            ...(r.campaignId ? { campaignId: r.campaignId } : {}),
            ...(r.campaignName ? { name: r.campaignName } : {}),
          };
          patch(t.id, p);
          saveRemote(t.id, {
            status: "done",
            stage: "done",
            finished_at: finishedAt,
            ...(r.campaignId ? { campaign_id: r.campaignId } : {}),
            ...(r.campaignName ? { name: r.campaignName } : {}),
          });
        } else if (r.status === "failed") {
          const error = r.error || "google-weapon reported the task failed";
          patch(t.id, { status: "error", stage: "failed", error, finishedAt });
          saveRemote(t.id, { status: "error", stage: "failed", error, finished_at: finishedAt });
        } else if (r.status === "not_found") {
          const error = r.error || "google-weapon does not know this task (not_found)";
          patch(t.id, { status: "interrupted", stage: "failed", error, finishedAt });
          saveRemote(t.id, { status: "interrupted", stage: "failed", error, finished_at: finishedAt });
        } else if (r.status === "pending" || r.status === "running") {
          // Non-terminal progress: keep the row running, only advance the stage. Persist only when
          // the stage actually moved so a steady poll doesn't storm Strapi.
          const stage = r.status === "pending" ? "queue" : "lion";
          if (t.stage !== stage) {
            patch(t.id, { stage });
            saveRemote(t.id, { status: "running", stage });
          }
        }
        // status "unknown" (the read itself failed): leave the row alone — next tick retries.
      }
    } catch {
      /* transient — next tick retries */
    } finally {
      finishBusyRef.current = false;
    }
  }, [isMine, patch, saveRemote]);

  useEffect(() => {
    const tick = () => {
      if (document.hidden) return;
      const interval = openRef.current ? FINISH_OPEN_MS : FINISH_CLOSED_MS;
      if (Date.now() - lastFinishRef.current < interval - 500) return;
      lastFinishRef.current = Date.now();
      void finish();
    };
    const iv = window.setInterval(tick, FINISH_OPEN_MS);
    const onVis = () => {
      if (!document.hidden) {
        lastFinishRef.current = Date.now();
        void finish();
      }
    };
    window.addEventListener("focus", onVis);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(iv);
      window.removeEventListener("focus", onVis);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [finish]);

  // Immediate shared + finisher pull when the drawer opens — live rows without waiting a tick.
  useEffect(() => {
    if (!open) return;
    lastSharedPollRef.current = Date.now();
    lastFinishRef.current = Date.now();
    loadRemote();
    void finish();
  }, [open, loadRemote, finish]);

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

  const value: GoogleTaskManagerValue = {
    tasks,
    counts,
    me,
    open,
    setOpen,
    refresh: loadRemote,
    estServerNow,
  };

  return (
    <Ctx.Provider value={value}>
      {children}
      <GoogleTaskManagerPanel />
    </Ctx.Provider>
  );
}

// ---------- header button ----------

export function GoogleTaskManagerButton() {
  const { counts, setOpen } = useGoogleTaskManager();
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
      aria-label="Open Google Task Manager"
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
      <span className="hidden whitespace-nowrap sm:inline">Google tasks</span>
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

function GoogleTaskManagerPanel() {
  const { tasks, counts, me, open, setOpen, refresh, estServerNow } = useGoogleTaskManager();
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

  // Same skew-corrected server clock the provider judges counts with — header and list agree.
  const staleOf = (t: GoogleTask) => isStaleRow(t, me, lastWrite, estServerNow);
  const inBucket = (t: GoogleTask): boolean =>
    filter === "all"
      ? true
      : filter === "active"
        ? (t.status === "queued" || t.status === "running") && !staleOf(t)
        : filter === "done"
          ? t.status === "done"
          : t.status === "error" || t.status === "interrupted" || staleOf(t);

  const isMineRow = (t: GoogleTask) => !!me && t.owner === me;
  const scoped = mineOnly ? tasks.filter(isMineRow) : tasks;
  const shown = scoped.filter(inBucket);

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
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-launch/25 to-accent/25">
              <GoogleMark className="h-4 w-4" />
            </span>
            <div className="leading-none">
              <h2 className="text-[14px] font-semibold text-ink">Google Task Manager</h2>
              <p className="mt-1 text-[10px] uppercase tracking-[0.16em] text-faint">Clones &amp; JURO through LION · google-weapon</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={refresh}
              aria-label="Refresh"
              data-tip="Refresh"
              className="tip flex h-8 w-8 items-center justify-center rounded-lg text-faint transition-colors hover:bg-raise hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <RocketIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-faint transition-colors hover:bg-raise hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <XIcon className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* summary strip */}
        <div className="flex items-center gap-1.5 border-b border-line px-4 py-2.5">
          <Stat label="Active" n={counts.active} tone="text-[#9db8ff]" />
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
                <GoogleMark className="h-5 w-5" mono />
              </span>
              <p className="text-[13px] font-medium text-dim">Nothing here yet</p>
              <p className="max-w-[250px] text-[11.5px] leading-relaxed text-faint">
                Google clones &amp; JURO runs land here. A green row means LION created the campaign
                on Google&apos;s side — the wave builds server-side, so this tab may be closed.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {shown.map((t) => (
                <GoogleTaskRow key={t.id} task={t} mine={isMineRow(t)} stale={staleOf(t)} now={now} />
              ))}
            </div>
          )}
        </div>

        {/* footer */}
        <div className="flex items-center gap-2 border-t border-line px-4 py-2.5">
          <span className="text-[10.5px] leading-relaxed text-faint">
            Rows are shared with the team; LION builds the campaigns server-side — this tab may be closed.
          </span>
        </div>
      </aside>
    </div>
  );
}

// ---------- row ----------

function GoogleTaskRow({ task: t, mine, stale, now }: { task: GoogleTask; mine: boolean; stale: boolean; now: number }) {
  const done = t.status === "done";
  const error = t.status === "error";
  const interrupted = t.status === "interrupted";
  const running = t.status === "running" && !stale;
  const end = t.finishedAt ?? now;
  const elapsed = t.startedAt ? Math.max(0, end - t.startedAt) : 0;
  const label = stale ? (t.error ?? "Session went offline before this run finished") : stageLabel(t);

  return (
    <div
      className={
        "animate-row-in rounded-xl border bg-surface2/40 p-3 transition-colors " +
        (error ? "border-danger/30" : interrupted || stale ? "border-warn/30" : done ? "border-launch/25" : "border-line")
      }
    >
      <div className="flex items-start gap-2.5">
        <GoogleStatusDot status={t.status} stale={stale} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-medium text-ink" title={t.name}>
            {t.name || "Untitled campaign"}
          </p>
          <p className="mt-0.5 flex items-center gap-1.5 truncate font-mono text-[10.5px] text-faint">
            <GoogleOwnerChip owner={t.owner} mine={mine} />
            {t.kind ? <KindChip kind={t.kind} /> : null}
            <span className="truncate">
              {shortCustomer(t.customer)}
              {t.currency ? ` · ${t.currency}` : ""}
              {t.geo ? ` · ${t.geo}` : ""} · {budgetLabel(t.budget, t.currency)}
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
        </div>
      </div>

      {/* stage/status line */}
      <div className="mt-2 flex items-center justify-between gap-2">
        <span
          className={
            "flex min-w-0 items-center gap-1.5 truncate text-[11px] " +
            (done ? "text-launch2" : error ? "text-danger" : interrupted || stale ? "text-warn" : "text-dim")
          }
        >
          {error ? <AlertIcon className="h-3 w-3 shrink-0" /> : null}
          {interrupted || stale ? <AlertIcon className="h-3 w-3 shrink-0" /> : null}
          {done ? <CheckIcon className="h-3 w-3 shrink-0" /> : null}
          {running ? <RocketIcon className="h-3 w-3 shrink-0 text-[#9db8ff]" /> : null}
          <span className="truncate" title={label}>
            {label}
          </span>
        </span>
      </div>

      {/* id copy buttons — the LION task id (every submitted row) and the campaign id (once created) */}
      {t.lionTaskId || t.campaignId ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {t.lionTaskId ? <CopyId prefix="task" id={t.lionTaskId} /> : null}
          {t.campaignId ? <CopyId prefix="cmp" id={t.campaignId} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function GoogleStatusDot({ status, stale }: { status: GoogleTask["status"]; stale: boolean }) {
  if (status === "running" && !stale)
    return (
      <span className="relative mt-1 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <span className="z-10 h-2 w-2 rounded-full bg-[#9db8ff]" />
        <span className="absolute inset-0 animate-ping rounded-full bg-accent/40" />
      </span>
    );
  const color = stale
    ? "bg-warn"
    : status === "done"
      ? "bg-launch2"
      : status === "error"
        ? "bg-danger"
        : status === "interrupted"
          ? "bg-warn"
          : "bg-line2"; // queued → muted
  return <span className={"mt-1.5 h-2 w-2 shrink-0 rounded-full " + color} />;
}

/** CLONE / JURO / LAUNCH chip — a third tone (violet) for fresh launches. */
function KindChip({ kind }: { kind: "clone" | "juro" | "launch" }) {
  const tone =
    kind === "clone"
      ? "bg-accent/15 text-[#9db8ff]"
      : kind === "juro"
        ? "bg-launch/15 text-launch2"
        : "bg-accent2/20 text-[#c7b0ff]";
  const label = kind === "clone" ? "Clone" : kind === "juro" ? "JURO" : "Launch";
  return (
    <span className={"shrink-0 rounded px-1 py-[1px] text-[9px] font-semibold uppercase tracking-[0.08em] " + tone}>{label}</span>
  );
}

/** Owner label — "you" for my rows, a colour-tagged name for teammates' (deterministic hue). */
function GoogleOwnerChip({ owner, mine }: { owner: string | null; mine: boolean }) {
  if (mine) return <span className="shrink-0 text-dim">you</span>;
  const name = owner || "—";
  const h = ownerHue(name);
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

function CopyId({ prefix, id }: { prefix: string; id: string }) {
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
      title={`Copy ${prefix === "task" ? "LION task" : "campaign"} id`}
    >
      {copied ? <CheckIcon className="h-3 w-3 text-launch2" /> : <CopyIcon className="h-3 w-3" />}
      {prefix} {id}
    </button>
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
