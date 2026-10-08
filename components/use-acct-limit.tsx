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
import type { RichOption } from "@/lib/catalog";
import { useAifTaskManager, useAvTaskManager, useTaskManager } from "./task-manager";
import { useHsTaskManager } from "./hs-task-manager";
import { useHandoffDemand, useHandoffItems } from "./launch-handoff";
import { type QueueHealth, sweepLateMinutes } from "@/lib/launch-queue-types";

// Client mirror of the per-account launch limit (5 campaigns / 30 min, window anchored at the
// first launch — owner rule 2026-08-18). One provider (app layout) polls /api/acct-limit and
// every surface reads this context: the header timer widget, the account pickers' N/5 badges,
// the card/rail launch gates and the clone boards. The SERVER claim is the authority — this
// state only keeps the UI honest and stops doomed waves before they queue.

export type AcctLimitInfo = { count: number; resetAt: number; name?: string };

export type AcctLimits = {
  limit: number;
  windowMs: number;
  /** Accounts with an ACTIVE window, keyed by the canonical numeric id (act_ stripped). */
  accounts: Record<string, AcctLimitInfo>;
  /** serverNow − clientNow at the last poll — countdowns use Date.now()+skew as "server now". */
  skew: number;
  /** Launches already recorded this window + jobs still QUEUED on the server + the user's own
   *  not-yet-accepted hand-off demand (0 when idle/expired — expiry unblocks instantly). */
  countFor: (accountId: string) => number;
  /** The user's OWN not-yet-accepted hand-off demand alone (subset of countFor). */
  pendingFor: (accountId: string) => number;
  resetAtFor: (accountId: string) => number | null;
  /** Immediate re-poll (throttled) — call after a task reaches a terminal state. */
  refresh: () => void;
  /** Un-throttled re-poll that RESOLVES with the fresh server picture (null on failure) — the
   *  launch click awaits this so the wave partition never runs on a ≤30s-old cache. `queued` is the
   *  server's per-account count of jobs still QUEUED (spec §4.5), folded into the wave gate too. */
  fetchFresh: () => Promise<{ accounts: Record<string, AcctLimitInfo>; skew: number; queued: Record<string, number> } | null>;
  /** This tab runs a bundle OLDER than the deployed server — its launch gates are outdated, so
   *  every launch surface hard-blocks until the tab reloads. */
  staleBuild: boolean;
};

/** Canonical account key, client copy (the server lib is server-only): strip act_, trim. */
export function acctIdKey(raw: string): string {
  return String(raw ?? "").trim().replace(/^act_/, "");
}

const EMPTY: AcctLimits = {
  limit: 5,
  windowMs: 30 * 60_000,
  accounts: {},
  skew: 0,
  countFor: () => 0,
  pendingFor: () => 0,
  resetAtFor: () => null,
  refresh: () => {},
  fetchFresh: async () => null,
  staleBuild: false,
};

const Ctx = createContext<AcctLimits>(EMPTY);

export function useAcctLimits(): AcctLimits {
  return useContext(Ctx);
}

/** mm:ss until an account's window resets (server-clock corrected). */
export function fmtCountdown(resetAt: number, skew: number): string {
  const left = Math.max(0, resetAt - (Date.now() + skew));
  const mm = Math.floor(left / 60_000);
  const ss = Math.floor((left % 60_000) / 1000);
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

/**
 * Account-picker decoration: a right-aligned `N/5` tag on every account that launched this
 * window, danger + UNPICKABLE at the cap (same idiom as the overfull-fanpage rows). Options
 * without launches pass through untouched (no tag noise on a quiet board).
 */
export function decorateAccountOptions<T extends RichOption>(options: T[], limits: AcctLimits): T[] {
  if (options.length === 0) return options;
  let changed = false;
  const next = options.map((o) => {
    const count = limits.countFor(o.value);
    if (count <= 0) return o;
    changed = true;
    const full = count >= limits.limit;
    return {
      ...o,
      tag: `${Math.min(count, limits.limit)}/${limits.limit}`,
      tagTone: (full ? "danger" : count >= limits.limit - 1 ? "warn" : "dim") as RichOption["tagTone"],
      disabled: o.disabled || full,
    };
  });
  return changed ? next : options;
}

type State = {
  limit: number;
  windowMs: number;
  accounts: Record<string, AcctLimitInfo>;
  skew: number;
  /** Jobs still QUEUED on the server, per ad account (spec §4.5) — accepted hand-offs the server
   *  holds but hasn't started; folded into countFor so a second wave can't over-queue an account. */
  queued: Record<string, number>;
};

const POLL_MS = 30_000;
const REFRESH_THROTTLE_MS = 2_000;
const FOCUS_THROTTLE_MS = 5_000;

export function AcctLimitProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<State>({ limit: 5, windowMs: 30 * 60_000, accounts: {}, skew: 0, queued: {} });
  const [staleBuild, setStaleBuild] = useState(false);
  // Whole minutes the server queue's sweep is late while jobs wait (null = nothing to say).
  const [sweepLate, setSweepLate] = useState<number | null>(null);
  const lastFetch = useRef(0);
  const stopped401 = useRef(false); // logged-out tab — quiet until a focus retries

  const load = useCallback(async (): Promise<{
    accounts: Record<string, AcctLimitInfo>;
    skew: number;
    queued: Record<string, number>;
  } | null> => {
    lastFetch.current = Date.now();
    try {
      const r = await fetch("/api/acct-limit");
      if (r.status === 401) {
        stopped401.current = true;
        return null;
      }
      const d = (await r.json().catch(() => null)) as {
        ok?: boolean;
        now?: number;
        limit?: number;
        windowMs?: number;
        build?: string;
        accounts?: Record<string, AcctLimitInfo>;
        queued?: Record<string, number>;
        queue?: QueueHealth | null;
      } | null;
      if (!d?.ok || typeof d.accounts !== "object") return null; // 502/registry blip — next tick retries
      stopped401.current = false;
      // Build-stamp check: this bundle vs the server answering. A mismatch means the tab
      // predates a deploy — its gates are outdated, so launching locks until a reload.
      const own = process.env.NEXT_PUBLIC_BUILD_STAMP ?? "";
      if (own && typeof d.build === "string" && d.build && d.build !== own) setStaleBuild(true);
      const next = {
        limit: Number(d.limit) || 5,
        windowMs: Number(d.windowMs) || 30 * 60_000,
        accounts: d.accounts ?? {},
        skew: (Number(d.now) || Date.now()) - Date.now(),
        // Jobs still queued on the server per account (spec §4.5) — the slot claim is still the
        // only authority; this just keeps a fresh wave from over-queuing what the queue already holds.
        queued: d.queued && typeof d.queued === "object" ? d.queued : {},
      };
      setState(next);
      // Judged on the SERVER's clock (d.now), so a wrong clock in the tab cannot raise or hide it.
      setSweepLate(sweepLateMinutes(d.queue ?? null, Number(d.now) || Date.now()));
      return { accounts: next.accounts, skew: next.skew, queued: next.queued };
    } catch {
      /* transient — the interval retries */
      return null;
    }
  }, []);

  const refresh = useCallback(() => {
    if (Date.now() - lastFetch.current > REFRESH_THROTTLE_MS) void load();
  }, [load]);

  // Own not-yet-accepted hand-off demand per account: the launches/clones whose creatives are still
  // uploading or are being handed to the server (useHandoffDemand) — accepted jobs leave the hand-off
  // and reappear in the server's `queued` picture instead, so the two never double-count. Folded into
  // countFor below so the pickers/cards/rails see capacity NET of the user's own in-flight wave.
  const team = useTaskManager();
  const aif = useAifTaskManager();
  const av = useAvTaskManager();
  const hsTm = useHsTaskManager();
  const pending = useHandoffDemand();
  const handoffItems = useHandoffItems();

  // A hand-off item moving phase (uploading → sending → accepted) or any task changing status means
  // the server picture changed within seconds — re-poll (throttled) instead of letting counts sit up
  // to 30 s stale mid-wave. (The client-only `local` flags that keyed this before are gone — the
  // server owns every row now.)
  const transitionSig = useMemo(() => {
    const phases = handoffItems.map((i) => i.phase).join(",");
    const sig = (ts: ReadonlyArray<{ status: string }>) => {
      let q = 0;
      let run = 0;
      let term = 0;
      for (const t of ts) {
        if (t.status === "queued") q++;
        else if (t.status === "running" || t.status === "submitted") run++;
        else term++;
      }
      return `${q}:${run}:${term}`;
    };
    return `${phases}|${sig(team.tasks)}|${sig(aif.tasks)}|${sig(av.tasks)}|${sig(hsTm.tasks)}`;
  }, [handoffItems, team.tasks, aif.tasks, av.tasks, hsTm.tasks]);
  const skipFirstSig = useRef(true);
  useEffect(() => {
    if (skipFirstSig.current) {
      skipFirstSig.current = false;
      return;
    }
    refresh();
  }, [transitionSig, refresh]);

  useEffect(() => {
    // Safe setState-in-effect: load() awaits the network before any setState — nothing here
    // writes state synchronously (the lint can't see past the async boundary).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const onFocus = () => {
      stopped401.current = false;
      if (Date.now() - lastFetch.current > FOCUS_THROTTLE_MS) void load();
    };
    const iv = setInterval(() => {
      if (document.visibilityState === "visible" && !stopped401.current) void load();
    }, POLL_MS);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      clearInterval(iv);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [load]);

  const value = useMemo<AcctLimits>(() => {
    const live = (id: string): AcctLimitInfo | null => {
      const a = state.accounts[acctIdKey(id)];
      // A window that ran out between polls is over NOW — the UI unblocks at 0:00, not at the
      // next 30s poll.
      return a && a.resetAt > Date.now() + state.skew ? a : null;
    };
    return {
      limit: state.limit,
      windowMs: state.windowMs,
      accounts: state.accounts,
      skew: state.skew,
      // What a NEW launch would actually face: the server's live window count + jobs it already has
      // queued for this account + the user's own not-yet-accepted hand-off demand.
      countFor: (id) => (live(id)?.count ?? 0) + (state.queued[acctIdKey(id)] ?? 0) + (pending.get(acctIdKey(id)) ?? 0),
      pendingFor: (id) => pending.get(acctIdKey(id)) ?? 0,
      resetAtFor: (id) => live(id)?.resetAt ?? null,
      refresh,
      fetchFresh: load,
      staleBuild,
    };
  }, [state, pending, refresh, load, staleBuild]);

  return (
    <Ctx.Provider value={value}>
      {staleBuild ? <StaleBuildBanner /> : null}
      {sweepLate != null ? <SweepLateNotice minutes={sweepLate} /> : null}
      {children}
    </Ctx.Provider>
  );
}

/** Small amber card (bottom-left, clear of the hand-off pill) while launches wait in the server
 *  queue and its every-minute check has gone silent — the one failure that could leave a queued
 *  launch waiting with nobody told. Running launches are not affected; it clears itself. */
function SweepLateNotice({ minutes }: { minutes: number }) {
  return (
    <div
      role="status"
      className={
        "fixed bottom-5 left-5 z-[80] flex max-w-[360px] items-start gap-2.5 rounded-xl border border-warn/40 " +
        "bg-surface/95 px-3.5 py-3 text-[12px] leading-relaxed text-warn shadow-[0_12px_40px_rgba(0,0,0,0.55)] backdrop-blur-md"
      }
    >
      <span className="mt-1 h-2 w-2 shrink-0 animate-pulse rounded-full bg-warn" />
      <span>
        <span className="font-semibold">The server queue&apos;s check is {minutes} min late.</span> Launches that are
        already running continue; queued ones may not start on their own. If this stays, tell the owner.
      </span>
    </div>
  );
}

/** Full-width red banner pinned under the header once the deployed build outruns this tab.
 *  Launching is hard-blocked everywhere while it shows — reload is the only way forward. */
function StaleBuildBanner() {
  return (
    <div className="fixed inset-x-0 top-[var(--hdr-h,4rem)] z-[90] flex justify-center px-4">
      <div
        role="alert"
        className={
          "pointer-events-auto flex w-full max-w-[1440px] items-center gap-3 rounded-xl border " +
          "border-danger/50 bg-[#2a0f14] px-4 py-3 text-[13px] font-semibold text-danger " +
          "shadow-[0_12px_40px_rgba(0,0,0,0.55)]"
        }
      >
        <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-danger" />
        A newer version of Ad Launcher is live — this tab&apos;s launch limits are outdated, so
        launching is paused here.
        <button
          type="button"
          onClick={() => window.location.reload()}
          className={
            "ml-auto shrink-0 rounded-lg border border-danger/50 bg-danger/15 px-3 py-1.5 " +
            "text-[12px] font-bold text-danger transition-colors hover:bg-danger/25 " +
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/50"
          }
        >
          Reload now
        </button>
      </div>
    </div>
  );
}
