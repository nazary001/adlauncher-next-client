"use client";

// Task manager for the TikTok platform tab — the Google manager's twin, minus everything that
// WROTE. A TikTok row is written SERVER-side only: the wave route (/api/tiktok/launch|clone|juro)
// stamps it, the after() pump submits every shot to tiktok-weapon exactly-once and moves the row,
// and /api/tiktok-tasks has no POST at all — so this provider never enqueues, saves, patches or
// ages a row out: it MIRRORS the team's shared rows (partner="tt" scope). LION's 201 makes a row
// terminal at once — "done / sent" ("Sent to LION", Google/HS parity) — but that is acceptance,
// not a campaign: the pump's settle pass upgrades it to "done / created" (real campaign id + LION's
// name) or flips it to "error / lion". A build that outlives the pump stays "sent", and the one
// active thing this provider does is FINISH such rows for their owner: it asks /api/tiktok/status
// about MY sent rows, the SERVER upgrades them, and a `settled` answer just triggers a re-pull.
// No retry/dismiss — creates are exactly-once (re-fire from the board) and every error is the
// team's permanent record.

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
import { TIKTOK_ENABLED } from "@/lib/partners";
import { AlertIcon, CheckIcon, CopyIcon, RocketIcon, TikTokMark, XIcon } from "./icons";

// ---------- model ----------

/** TikTok task as the drawer renders it. Mirror of the shared Strapi row (partner="tt") mapped
 *  from TiktokRemoteRow; `kind` is decoded from the `gcm` marker ("t-launch"/"t-clone"/"t-juro").
 *  status is the store enum — queued|running|done|error|interrupted; the wave route stamps rows
 *  "running / submit", so "queued" only ever shows for an older/foreign row. */
export type TiktokTask = {
  id: string;
  name: string;
  kind: "launch" | "clone" | "juro" | null;
  /** Username that fired this wave. Everyone sees every row; only the owner's session finishes it. */
  owner: string | null;
  /** Target TikTok advertiser id (Strapi adset_id column). */
  advertiser: string;
  /** Target account currency code — every launchable advertiser is "USD" today (Strapi ad_id column). */
  currency: string;
  geo: string;
  budget: string;
  /** Pre-formatted "what it bids on" tag ("bid 0,46" / "ROAS 1,2" / "auto" / "max value" / "warm-up" / "inherit"). */
  bid?: string;
  status: "queued" | "running" | "done" | "error" | "interrupted";
  /** running: submit | dataset · done: sent (LION accepted) | created (campaign exists) ·
   *  error: submit | dataset | lion · interrupted: submit (ambiguous — the task may exist). */
  stage: string | null;
  /** tiktok-weapon task id (Strapi link column) — the finisher asks about this. */
  lionTaskId?: string;
  campaignId?: string;
  error?: string;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Server-side updatedAt (ms) of the Strapi row — the liveness signal behind `stale` AND the
   *  row's version: a copy already on screen is never replaced by an older snapshot. */
  updatedMs?: number;
};

/** tiktok-weapon's live view of a task, as POST /api/tiktok/status answers it. */
export type TiktokLionStatus = "pending" | "running" | "completed" | "failed" | "not_found" | "unknown";

/** GET /api/tiktok-tasks row shape (verbatim wire contract). */
type TiktokRemoteRow = {
  id: string;
  owner: string | null;
  name: string;
  geo: string;
  budget: string;
  status: string;
  stage: string | null;
  lionTaskId: string | null;
  kind: string | null; // "t-launch" | "t-clone" | "t-juro"
  campaignId: string | null;
  advertiser: string | null; // adset_id
  currency: string | null; // ad_id
  bid: string | null;
  error: string | null;
  queued_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  updated_ms: number | null;
};

/** POST /api/tiktok/status answer row (verbatim wire contract). */
type TiktokStatusRow = {
  taskId: string;
  lionTaskId: string;
  status: string;
  campaignId: string | null;
  errorStep: string | null;
  errorMessage: string | null;
  settled: boolean;
};

// Shared-store cadence: pull the team's TikTok rows continuously so the drawer stays truthful even
// for rows I did not fire (faster while the drawer is open). Matches the Google manager's cadence.
const SHARED_POLL_OPEN_MS = 6_000;
const SHARED_POLL_CLOSED_MS = 20_000;
// A failing pull (Strapi blip, network) doubles its interval up to this cap, so a fleet of open
// tabs backs off the shared store instead of hammering it while it is down.
const SHARED_POLL_MAX_MS = 120_000;
// LION finisher cadence (MY sent rows only): tiktok-weapon is the shared partner and the server
// pump is usually settling the same tasks, so one gentle batched read covers all of mine.
const FINISH_MS = 15_000;
const FINISH_MAX_MS = 120_000;
/** /api/tiktok/status takes ≤60 tasks per call. */
const FINISH_BATCH = 60;
// A sent row LION still hasn't answered for after this long stops being asked about — the drawer
// tells the buyer to check LION instead of polling a forever-wedged task.
const FINISH_WINDOW_MS = 3 * 60 * 60_000;
// LION builds a campaign in 1–3 min: a sent row this young is still IN FLIGHT (counts as active),
// after that it is just a finished hand-off whose verdict never came back.
const BUILDING_MS = 10 * 60_000;

// ---------- pure helpers ----------

const n = (v: unknown): number | undefined => {
  if (v == null || v === "") return undefined;
  const x = Number(v);
  return Number.isFinite(x) ? x : undefined;
};

/** "t-launch" → "launch", "t-clone" → "clone", "t-juro" → "juro", else null (older/foreign row). */
function kindOf(gcm: string | null): "launch" | "clone" | "juro" | null {
  if (gcm === "t-launch") return "launch";
  if (gcm === "t-clone") return "clone";
  if (gcm === "t-juro") return "juro";
  return null;
}

/** TiktokRemoteRow → TiktokTask (mirror). */
function fromRemote(r: TiktokRemoteRow): TiktokTask {
  const raw = r.status;
  const status: TiktokTask["status"] =
    raw === "done" || raw === "error" || raw === "interrupted" || raw === "running" ? raw : "queued";
  return {
    id: r.id,
    name: r.name || "",
    kind: kindOf(r.kind),
    owner: r.owner ?? null,
    advertiser: r.advertiser || "",
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

/** The partner's status string → the union the drawer knows; anything else reads as "unknown". */
function lionStatusOf(raw: string): TiktokLionStatus {
  return raw === "pending" || raw === "running" || raw === "completed" || raw === "failed" || raw === "not_found" ? raw : "unknown";
}

/**
 * Merge a freshly-fetched shared list into the in-memory list.
 * - A row never goes back in time: the route's list is short-cached PER warm instance, so the pull
 *   right after a settle (or any two consecutive polls) can land on an instance still holding the
 *   older copy — a row already on screen with a newer updatedMs keeps its place, so a just-created
 *   row can't flip back to "Sent to LION".
 * - Every other row mirrors the fetch exactly: present → shown, absent → deleted/aged-out → gone.
 * - Object identity is preserved when a row's updatedMs is unchanged (updatedAt bumps on every
 *   Strapi write, so it doubles as a version) — a quiet poll then re-renders nothing.
 * Newest first (queuedAt desc, id as the deterministic tiebreak).
 */
function mergeShared(cur: TiktokTask[], fetched: TiktokTask[]): TiktokTask[] {
  const curById = new Map(cur.map((c) => [c.id, c]));
  const byId = new Map<string, TiktokTask>();
  for (const f of fetched) {
    if (!f.id) continue;
    const prev = curById.get(f.id);
    if (prev && prev.updatedMs != null && (f.updatedMs == null || prev.updatedMs > f.updatedMs)) {
      byId.set(f.id, prev); // an older snapshot of a row I already hold a newer version of
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
function ownerLastWrite(tasks: readonly TiktokTask[]): Map<string, number> {
  const last = new Map<string, number>();
  for (const t of tasks) {
    if (!t.owner || t.updatedMs == null) continue;
    if ((last.get(t.owner) ?? 0) < t.updatedMs) last.set(t.owner, t.updatedMs);
  }
  return last;
}

const isTerminal = (st: TiktokTask["status"]) => st === "done" || st === "error" || st === "interrupted";

/** A non-terminal row nobody has written under its owner's name for > STALE_MS — the wave's
 *  server pump died (function killed, after() never ran). The pump writes a row on every submit
 *  and every dataset probe (≤30 s apart), so that much silence is reliably a dead run. Unlike the
 *  Google manager there is NO "my rows are never stale" carve-out: my browser drives nothing here,
 *  so a silent pump is just as dead for my rows — and with no client write path there is no 3 h
 *  age-out that would otherwise catch them. */
function isStaleRow(t: TiktokTask, lastWriteByOwner: ReadonlyMap<string, number>, estServerNow: number): boolean {
  if (isTerminal(t.status)) return false;
  const last = t.owner ? lastWriteByOwner.get(t.owner) : undefined;
  if (!last) return true; // no liveness signal at all
  return estServerNow - last > STALE_MS;
}

/** "Sent to LION": accepted by tiktok-weapon, the campaign not confirmed yet. */
const isSent = (t: TiktokTask) => t.status === "done" && t.stage === "sent";

/** When LION accepted the shot, on the SERVER clock (the pump stamps finished_at at the 201). */
const sentAt = (t: TiktokTask) => t.finishedAt ?? t.startedAt ?? t.queuedAt;

/** A sent row young enough that LION is plausibly still building it. */
const isBuilding = (t: TiktokTask, estServerNow: number) => isSent(t) && estServerNow - sentAt(t) < BUILDING_MS;

/** A sent row past the finisher's window — nobody asks LION about it any more. */
const isUnconfirmed = (t: TiktokTask, estServerNow: number) => isSent(t) && estServerNow - sentAt(t) >= FINISH_WINDOW_MS;

type Bucket = "active" | "done" | "failed";

/** Which tab a row lives under. ONE predicate for the counts, the tabs and the list, so the header
 *  can never contradict the drawer — and the three buckets always add up to "All". */
function bucketOf(t: TiktokTask, lastWriteByOwner: ReadonlyMap<string, number>, estServerNow: number): Bucket {
  if (t.status === "error" || t.status === "interrupted" || isStaleRow(t, lastWriteByOwner, estServerNow)) return "failed";
  if (t.status === "done") return isBuilding(t, estServerNow) ? "active" : "done";
  return "active";
}

/** "$20" — every launchable TikTok advertiser is USD; a foreign code is spelled out, not guessed. */
function budgetLabel(budget: string, currency: string): string {
  const amt = moneyLabel(budget);
  return currency && currency !== "USD" ? `${currency} ${amt}` : `$${amt}`;
}

/** A 19-digit TikTok advertiser id, shortened for the dense mono row: "…123456" (last 6). */
function shortAdvertiser(id: string): string {
  if (!id) return "—";
  return id.length > 8 ? `…${id.slice(-6)}` : id;
}

/** mm:ss, or h:mm:ss once a row has been running for an hour. */
function fmtElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
  return `${m}:${String(sec % 60).padStart(2, "0")}`;
}

/** The stage/status one-liner for a row. */
function stageLabel(t: TiktokTask): string {
  if (t.status === "done") {
    // Acceptance is NOT the outcome: only "created" (the settle pass / my finisher saw LION's
    // completed task) carries a campaign id and LION's real name.
    if (t.stage === "sent") return "Sent to LION";
    return t.campaignId ? `Created · cmp ${t.campaignId}` : "Created";
  }
  if (t.status === "error") {
    // error is "<step>: <message>" from LION's task — it needs the "who failed" in front; submit /
    // dataset errors are already whole sentences (the partner's refusal, or the pump's own).
    if (t.stage === "lion") return t.error ? `LION failed the build — ${t.error}` : "LION failed the build";
    if (t.stage === "dataset") return t.error || "The source is not available in LION";
    return t.error || "Refused before anything was created";
  }
  if (t.status === "interrupted") return t.error || "Ambiguous outcome — the task may exist on tiktok-weapon; check LION before re-firing";
  switch (t.stage) {
    case "submit":
      return "Sending to LION…";
    case "dataset":
      return "Waiting for LION to fetch the source…";
    default:
      return t.status === "queued" ? "Queued — safe to close the tab" : "Working…";
  }
}

/** The partner's live view of a sent row, as a short sub-label ("unknown" = the read failed → say nothing). */
function lionLiveLabel(s: TiktokLionStatus | undefined): string | null {
  switch (s) {
    case "pending":
      return "queued at LION";
    case "running":
      return "LION is building…";
    case "not_found":
      return "LION doesn't know this task";
    case "completed":
      return "LION finished";
    case "failed":
      return "LION failed the build";
    default:
      return null;
  }
}

// ---------- context ----------

export type TiktokTaskManagerValue = {
  tasks: TiktokTask[];
  /** active = running/queued rows + sent rows LION is still building (< 10 min); done = everything
   *  else that is done; failed = error / interrupted / stalled. running drives the elapsed ticker. */
  counts: { active: number; done: number; failed: number; running: number; total: number };
  /** Current user — labels owners in the shared view and gates own-only finishing. */
  me: string | null;
  open: boolean;
  setOpen: (v: boolean) => void;
  /** Force an immediate shared-store pull (the drawer's refresh button, the boards after a wave). */
  refresh: () => void;
  /** Client's estimate of the SERVER clock (local tick + measured skew) — the one clock every
   *  liveness/age judgement uses (counts, tabs, the drawer's rows), so they can never disagree. */
  estServerNow: number;
  /** tiktok-weapon's live status of MY sent rows (row id → status), from the last finisher pass. */
  lionStatus: ReadonlyMap<string, TiktokLionStatus>;
};

const Ctx = createContext<TiktokTaskManagerValue | null>(null);

export function useTiktokTaskManager(): TiktokTaskManagerValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTiktokTaskManager must be used within TiktokTaskManagerProvider");
  return v;
}

// ---------- provider ----------

// Dormant on prod (NEXT_PUBLIC_TIKTOK_ENABLED unset → TIKTOK_ENABLED is false at build time): the tab
// is the disabled pill and every /api/tiktok* answers 404, so this provider — mounted in the app
// layout for every page — must not generate traffic: every fetch, poll and listener is gated.
export function TiktokTaskManagerProvider({
  children,
  user,
}: {
  children: React.ReactNode;
  user?: { username: string; role?: string | null };
}) {
  const me = user?.username ?? null;
  const [tasks, setTasks] = useState<TiktokTask[]>([]);
  const [open, setOpen] = useState(false);
  const [skew, setSkew] = useState(0);
  const skewRef = useRef(0);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [lionStatus, setLionStatus] = useState<ReadonlyMap<string, TiktokLionStatus>>(() => new Map());

  const tasksRef = useRef<TiktokTask[]>([]);
  const openRef = useRef(false);
  const lastSharedPollRef = useRef(0);
  const lastFinishRef = useRef(0);
  const finishBusyRef = useRef(false);
  // Consecutive failures of each read — the backoff exponent (reset by the first good answer).
  const pullFailsRef = useRef(0);
  const finishFailsRef = useRef(0);
  // Pulls are numbered so an answer that lands AFTER a later-started one is dropped: the boards
  // call refresh() right after a wave, and a poll that snapshotted before the rows were stamped
  // must not land last and make them vanish until the next tick.
  const pullSeqRef = useRef(0);
  const pullLandedRef = useRef(0);

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const noteSkew = useCallback((serverNow: number) => {
    const sk = serverNow - Date.now();
    skewRef.current = sk;
    setSkew((prev) => (Math.abs(prev - sk) > 3000 ? sk : prev));
  }, []);

  /** Pull the team's TikTok rows and mirror them. */
  const loadRemote = useCallback(() => {
    if (!TIKTOK_ENABLED) return;
    const seq = ++pullSeqRef.current;
    fetch("/api/tiktok-tasks", { signal: AbortSignal.timeout(20_000) })
      .then(async (r) => {
        const d = r.ok ? ((await r.json().catch(() => null)) as { ok?: boolean; now?: number; tasks?: TiktokRemoteRow[] } | null) : null;
        if (!d?.ok || !Array.isArray(d.tasks)) {
          pullFailsRef.current++;
          return;
        }
        pullFailsRef.current = 0;
        if (seq < pullLandedRef.current) return; // a later-started pull already landed
        pullLandedRef.current = seq;
        if (typeof d.now === "number") noteSkew(d.now);
        const fetched = d.tasks.map(fromRemote);
        setTasks((cur) => mergeShared(cur, fetched));
      })
      .catch(() => {
        pullFailsRef.current++;
      });
  }, [noteSkew]);

  // Initial load.
  useEffect(() => {
    if (!TIKTOK_ENABLED) return;
    loadRemote();
  }, [loadRemote]);

  // Shared-store polling: keep the team's rows fresh (faster while the drawer is open, slower
  // while the store is failing), and drive a coarse clock so stale / "still building" judgements
  // advance even with the drawer closed.
  useEffect(() => {
    if (!TIKTOK_ENABLED) return;
    const tick = () => {
      if (document.hidden) return;
      const base = openRef.current ? SHARED_POLL_OPEN_MS : SHARED_POLL_CLOSED_MS;
      const interval = Math.min(base * 2 ** pullFailsRef.current, SHARED_POLL_MAX_MS);
      if (Date.now() - lastSharedPollRef.current < interval - 300) return;
      lastSharedPollRef.current = Date.now();
      loadRemote();
    };
    const iv = window.setInterval(tick, SHARED_POLL_OPEN_MS);
    const onVis = () => {
      // focus + visibilitychange fire together on a tab switch — one pull, not two.
      if (document.hidden || Date.now() - lastSharedPollRef.current < 2_000) return;
      lastSharedPollRef.current = Date.now();
      loadRemote();
    };
    window.addEventListener("focus", onVis);
    document.addEventListener("visibilitychange", onVis);
    // The clock stands still while the tab is hidden: polling is paused there, and judging rows
    // that old against a fresh clock would flash every running row as "stalled" on return.
    const clock = window.setInterval(() => {
      if (!document.hidden) setNowTick(Date.now());
    }, 10_000);
    return () => {
      window.clearInterval(iv);
      window.clearInterval(clock);
      window.removeEventListener("focus", onVis);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [loadRemote]);

  // ---- LION finisher: only MY "Sent to LION" rows the server pump's settle pass left behind ----

  const finish = useCallback(async () => {
    if (!TIKTOK_ENABLED || !me || document.hidden || finishBusyRef.current) return;
    const estNow = Date.now() + skewRef.current;
    const pending = tasksRef.current.filter((t) => t.owner === me && isSent(t) && !!t.lionTaskId && estNow - sentAt(t) < FINISH_WINDOW_MS);
    if (pending.length === 0) return; // nothing to finish → no traffic
    finishBusyRef.current = true;
    const seen = new Map<string, TiktokLionStatus>();
    let settled = false;
    let failed = false;
    try {
      for (let i = 0; i < pending.length && !failed; i += FINISH_BATCH) {
        const batch = pending.slice(i, i + FINISH_BATCH);
        try {
          const res = await fetch("/api/tiktok/status", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tasks: batch.map((t) => ({ taskId: t.id, lionTaskId: t.lionTaskId })) }),
            // The route reads ≤60 partner tasks and may write as many rows (maxDuration 60).
            signal: AbortSignal.timeout(45_000),
          });
          const d = (await res.json().catch(() => null)) as { ok?: boolean; tasks?: TiktokStatusRow[] } | null;
          if (!d?.ok || !Array.isArray(d.tasks)) {
            failed = true;
            break;
          }
          for (const r of d.tasks) {
            seen.set(r.taskId, lionStatusOf(r.status));
            if (r.settled) settled = true;
          }
        } catch {
          failed = true; // transient — next tick retries (later, see the backoff)
        }
      }
      finishFailsRef.current = failed ? finishFailsRef.current + 1 : 0;
      // Live status = exactly the rows this pass asked about: a row that left "sent" drops out, a
      // row the failed batch never reached keeps what the previous pass said.
      setLionStatus((prev) => {
        const next = new Map<string, TiktokLionStatus>();
        for (const t of pending) {
          const s = seen.get(t.id) ?? prev.get(t.id);
          if (s) next.set(t.id, s);
        }
        return next.size === prev.size && [...next].every(([id, s]) => prev.get(id) === s) ? prev : next;
      });
      if (settled) {
        // The SERVER just upgraded a row of mine — mirror it. The list is short-cached server-side,
        // so this pull may still serve the pre-settle copy: also make the very next tick pull again.
        loadRemote();
        lastSharedPollRef.current = 0;
      }
    } finally {
      finishBusyRef.current = false;
    }
  }, [me, loadRemote]);

  useEffect(() => {
    if (!TIKTOK_ENABLED) return;
    const tick = () => {
      if (document.hidden) return;
      const interval = Math.min(FINISH_MS * 2 ** finishFailsRef.current, FINISH_MAX_MS);
      if (Date.now() - lastFinishRef.current < interval - 500) return;
      lastFinishRef.current = Date.now();
      void finish();
    };
    const iv = window.setInterval(tick, FINISH_MS);
    const onVis = () => {
      if (document.hidden || Date.now() - lastFinishRef.current < 2_000) return;
      lastFinishRef.current = Date.now();
      void finish();
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
    if (!TIKTOK_ENABLED || !open) return;
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
      const bucket = bucketOf(t, lastWrite, estServerNow);
      if (bucket === "active") active++;
      else if (bucket === "done") done++;
      else failed++;
      if (bucket === "active" && t.status === "running") running++;
    }
    return { active, done, failed, running, total: tasks.length };
  }, [tasks, estServerNow]);

  const value: TiktokTaskManagerValue = {
    tasks,
    counts,
    me,
    open,
    setOpen,
    refresh: loadRemote,
    estServerNow,
    lionStatus,
  };

  return (
    <Ctx.Provider value={value}>
      {children}
      <TiktokTaskManagerPanel />
    </Ctx.Provider>
  );
}

// ---------- header button ----------

export function TiktokTaskManagerButton() {
  const { counts, setOpen } = useTiktokTaskManager();
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
      aria-label="Open TikTok Task Manager"
      className={
        "relative flex h-9 items-center gap-2 rounded-full border px-3 text-[13px] font-medium " +
        "transition-all duration-200 active:scale-[0.96] focus-visible:outline-none " +
        "focus-visible:ring-2 focus-visible:ring-launch/40 " +
        tone
      }
    >
      <span className="relative">
        <TikTokMark className="h-4 w-4" />
        {/* Pulses for anything in flight — a sent row LION is still building included. */}
        {counts.active > 0 ? (
          <span className="animate-pulse-soft absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-launch2" />
        ) : null}
      </span>
      <span className="hidden whitespace-nowrap sm:inline">TikTok tasks</span>
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

type Filter = "all" | Bucket;

function TiktokTaskManagerPanel() {
  const { tasks, counts, me, open, setOpen, refresh, estServerNow, lionStatus } = useTiktokTaskManager();
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
  const staleOf = (t: TiktokTask) => isStaleRow(t, lastWrite, estServerNow);
  const inBucket = (t: TiktokTask): boolean => filter === "all" || bucketOf(t, lastWrite, estServerNow) === filter;

  const isMineRow = (t: TiktokTask) => !!me && t.owner === me;
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
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#25F4EE]/15 text-[#25F4EE]">
              <TikTokMark className="h-4 w-4" />
            </span>
            <div className="leading-none">
              <h2 className="text-[14px] font-semibold text-ink">TikTok Task Manager</h2>
              <p className="mt-1 text-[10px] uppercase tracking-[0.16em] text-faint">Launches, clones &amp; JURO through LION · tiktok-weapon</p>
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
              (mineOnly ? "bg-[#25F4EE]/10 text-[#9ff3ef]" : "text-faint hover:text-dim")
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
                <TikTokMark className="h-5 w-5" />
              </span>
              <p className="text-[13px] font-medium text-dim">Nothing here yet</p>
              <p className="max-w-[250px] text-[11.5px] leading-relaxed text-faint">
                TikTok launches, clones &amp; JURO runs land here. A cyan row is sent — LION is still
                building it; a green row means the campaign exists. The wave runs server-side, so
                this tab may be closed.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {shown.map((t) => (
                <TiktokTaskRow
                  key={t.id}
                  task={t}
                  mine={isMineRow(t)}
                  stale={staleOf(t)}
                  building={isBuilding(t, estServerNow)}
                  unconfirmed={isUnconfirmed(t, estServerNow)}
                  live={lionStatus.get(t.id)}
                  now={now}
                />
              ))}
            </div>
          )}
        </div>

        {/* footer */}
        <div className="flex items-center gap-2 border-t border-line px-4 py-2.5">
          <span className="text-[10.5px] leading-relaxed text-faint">
            Rows are shared with the team; LION builds the campaigns server-side (1–3 min) — this tab may be closed.
          </span>
        </div>
      </aside>
    </div>
  );
}

// ---------- row ----------

function TiktokTaskRow({
  task: t,
  mine,
  stale,
  building,
  unconfirmed,
  live,
  now,
}: {
  task: TiktokTask;
  mine: boolean;
  stale: boolean;
  building: boolean;
  unconfirmed: boolean;
  live: TiktokLionStatus | undefined;
  now: number;
}) {
  const sent = isSent(t);
  const created = t.status === "done" && !sent;
  const error = t.status === "error";
  const interrupted = t.status === "interrupted";
  const running = t.status === "running" && !stale;
  const end = t.finishedAt ?? now;
  const elapsed = t.startedAt ? Math.max(0, end - t.startedAt) : 0;
  const label = stale ? "The server run stopped before this shot finished — check LION before re-firing" : stageLabel(t);
  // Sent rows only: what LION says right now (my rows, from the finisher) — or, past the 3 h
  // window, that nobody is asking any more.
  const sub = !sent ? null : unconfirmed ? "not confirmed after 3 h — check LION" : lionLiveLabel(live);
  const subWarn = unconfirmed || live === "not_found" || live === "failed";

  return (
    <div
      className={
        "animate-row-in rounded-xl border bg-surface2/40 p-3 transition-colors " +
        (error
          ? "border-danger/30"
          : interrupted || stale
            ? "border-warn/30"
            : created
              ? "border-launch/25"
              : sent
                ? "border-[#25F4EE]/25"
                : "border-line")
      }
    >
      <div className="flex items-start gap-2.5">
        <TiktokStatusDot status={t.status} stale={stale} sent={sent} building={building} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-medium text-ink" title={t.name}>
            {t.name || "Untitled campaign"}
          </p>
          <p className="mt-0.5 flex items-center gap-1.5 truncate font-mono text-[10.5px] text-faint">
            <TiktokOwnerChip owner={t.owner} mine={mine} />
            {t.kind ? <KindChip kind={t.kind} /> : null}
            <span className="truncate" title={t.advertiser ? `advertiser ${t.advertiser}` : undefined}>
              {shortAdvertiser(t.advertiser)}
              {t.geo ? ` · ${t.geo}` : ""} · {budgetLabel(t.budget, t.currency)}
              {t.bid ? ` · ${t.bid}` : ""}
            </span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {stale ? (
            <span className="rounded-md border border-warn/25 bg-warn/5 px-1.5 py-0.5 text-[9.5px] font-medium text-warn">
              stalled
            </span>
          ) : null}
          <span className="font-mono text-[10.5px] tabular-nums text-faint">{fmtElapsed(elapsed)}</span>
        </div>
      </div>

      {/* stage/status line — "Sent to LION" is acceptance, not success: the platform cyan, never the green */}
      <div className="mt-2 flex items-center justify-between gap-2">
        <span
          className={
            "flex min-w-0 items-center gap-1.5 truncate text-[11px] " +
            (created ? "text-launch2" : sent ? "text-[#9ff3ef]" : error ? "text-danger" : interrupted || stale ? "text-warn" : "text-dim")
          }
        >
          {error || interrupted || stale ? <AlertIcon className="h-3 w-3 shrink-0" /> : null}
          {created ? <CheckIcon className="h-3 w-3 shrink-0" /> : null}
          {sent ? <RocketIcon className="h-3 w-3 shrink-0" /> : null}
          {running ? <RocketIcon className="h-3 w-3 shrink-0 text-[#9db8ff]" /> : null}
          <span className="truncate" title={label}>
            {label}
          </span>
        </span>
        {sub ? <span className={"shrink-0 text-[10px] " + (subWarn ? "text-warn" : "text-faint")}>{sub}</span> : null}
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

function TiktokStatusDot({ status, stale, sent, building }: { status: TiktokTask["status"]; stale: boolean; sent: boolean; building: boolean }) {
  if (status === "running" && !stale)
    return (
      <span className="relative mt-1 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <span className="z-10 h-2 w-2 rounded-full bg-[#9db8ff]" />
        <span className="absolute inset-0 animate-ping rounded-full bg-accent/40" />
      </span>
    );
  const color = stale
    ? "bg-warn"
    : sent
      ? "bg-[#25F4EE]" + (building ? " animate-pulse-soft" : "") // LION is (plausibly) still building it
      : status === "done"
        ? "bg-launch2"
        : status === "error"
          ? "bg-danger"
          : status === "interrupted"
            ? "bg-warn"
            : "bg-line2"; // queued → muted
  return <span className={"mt-1.5 h-2 w-2 shrink-0 rounded-full " + color} />;
}

/** LAUNCH / CLONE / JURO chip — the Google manager's three tones. */
function KindChip({ kind }: { kind: "launch" | "clone" | "juro" }) {
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
function TiktokOwnerChip({ owner, mine }: { owner: string | null; mine: boolean }) {
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
        // A denied clipboard rejects — swallowed; the "copied" flash is a best-effort hint.
        void navigator.clipboard?.writeText(id).catch(() => {});
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
