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
import { useAifTaskManager, useTaskManager } from "./task-manager";
import { useHsTaskManager } from "./hs-task-manager";

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
  /** Launches already recorded this window (0 when idle/expired — expiry unblocks instantly). */
  countFor: (accountId: string) => number;
  resetAtFor: (accountId: string) => number | null;
  /** Immediate re-poll (throttled) — call after a task reaches a terminal state. */
  refresh: () => void;
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
  resetAtFor: () => null,
  refresh: () => {},
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
};

const POLL_MS = 30_000;
const REFRESH_THROTTLE_MS = 2_000;
const FOCUS_THROTTLE_MS = 5_000;

export function AcctLimitProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<State>({ limit: 5, windowMs: 30 * 60_000, accounts: {}, skew: 0 });
  const lastFetch = useRef(0);
  const stopped401 = useRef(false); // logged-out tab — quiet until a focus retries

  const load = useCallback(async () => {
    lastFetch.current = Date.now();
    try {
      const r = await fetch("/api/acct-limit");
      if (r.status === 401) {
        stopped401.current = true;
        return;
      }
      const d = (await r.json().catch(() => null)) as {
        ok?: boolean;
        now?: number;
        limit?: number;
        windowMs?: number;
        accounts?: Record<string, AcctLimitInfo>;
      } | null;
      if (!d?.ok || typeof d.accounts !== "object") return; // 502/registry blip — next tick retries
      stopped401.current = false;
      setState({
        limit: Number(d.limit) || 5,
        windowMs: Number(d.windowMs) || 30 * 60_000,
        accounts: d.accounts ?? {},
        skew: (Number(d.now) || Date.now()) - Date.now(),
      });
    } catch {
      /* transient — the interval retries */
    }
  }, []);

  const refresh = useCallback(() => {
    if (Date.now() - lastFetch.current > REFRESH_THROTTLE_MS) void load();
  }, [load]);

  // Own queued-but-not-started launches per account (the client-only `account` on local task
  // rows): folded into countFor below, so the pickers/cards/rails see capacity NET of the
  // user's own queue. Running tasks are excluded — their server-side claim lands within seconds
  // of starting, and the transition effect below re-polls the registry right then.
  const team = useTaskManager();
  const aif = useAifTaskManager();
  const hsTm = useHsTaskManager();
  const pending = useMemo(() => {
    const m = new Map<string, number>();
    const fold = (ts: ReadonlyArray<{ local?: boolean; status: string; account?: string }>) => {
      for (const t of ts) {
        if (!t.local || t.status !== "queued") continue;
        const k = acctIdKey(t.account ?? "");
        if (k) m.set(k, (m.get(k) ?? 0) + 1);
      }
    };
    fold(team.tasks);
    fold(aif.tasks);
    fold(hsTm.tasks);
    return m;
  }, [team.tasks, aif.tasks, hsTm.tasks]);

  // A local task starting or finishing means the server registry changed within seconds —
  // re-poll (throttled) instead of letting counts sit up to 30 s stale mid-wave.
  const transitionSig = useMemo(() => {
    const sig = (ts: ReadonlyArray<{ local?: boolean; status: string }>) => {
      let q = 0;
      let run = 0;
      let done = 0;
      for (const t of ts) {
        if (!t.local) continue;
        if (t.status === "queued") q++;
        else if (t.status === "running" || t.status === "submitted") run++;
        else done++;
      }
      return `${q}:${run}:${done}`;
    };
    return `${sig(team.tasks)}|${sig(aif.tasks)}|${sig(hsTm.tasks)}`;
  }, [team.tasks, aif.tasks, hsTm.tasks]);
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
      // Server truth + the user's own queued demand: what a NEW launch would actually face.
      countFor: (id) => (live(id)?.count ?? 0) + (pending.get(acctIdKey(id)) ?? 0),
      resetAtFor: (id) => live(id)?.resetAt ?? null,
      refresh,
    };
  }, [state, pending, refresh]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
