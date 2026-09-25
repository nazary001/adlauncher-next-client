"use client";

// Data hooks + the fetch helper for the TOOL Sessions console (/sessions). Every call goes to
// our owner-only /api/tool-sessions/* routes (never to TOOL directly — the key lives on the
// server). Shapes mirror lib/tool-sessions-model.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ToolJobEvent, ToolJobView, ToolMe, ToolSession, ToolSessionEvent, ToolSessionRow, ToolTeamAccount } from "@/lib/tool-sessions-model";
import { isTerminalJob } from "@/lib/tool-sessions-model";
import type { ToolLogEntry } from "@/lib/tool-sessions-log";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string; message: string; field?: string | null; status: number };

/** Our routes answer { ok, error, message, field } on failure; `message` is the human sentence
 *  (TOOL's own wording when it came from upstream). */
export async function toolCall<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const r = await fetch(path, {
      ...init,
      headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(init?.headers ?? {}) },
      cache: "no-store",
    });
    const d = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string; field?: string | null } & T;
    if (!r.ok || !d?.ok) return { ok: false, error: d?.error || `http_${r.status}`, message: d?.message || d?.error || `HTTP ${r.status}`, field: d?.field ?? null, status: r.status };
    return { ok: true, data: d };
  } catch (e) {
    return { ok: false, error: "network", message: String((e as Error)?.message ?? e), status: 0 };
  }
}

export type SessionsView = {
  configured: boolean;
  host: string;
  me: ToolMe | null;
  meError?: string | null;
  sessions: ToolSessionRow[];
  log: ToolLogEntry[];
  now: number;
};

const LIST_POLL_MS = 30_000;
const FOCUS_MIN_MS = 10_000;

/**
 * The sessions list (+ key identity + our change log): loads on mount, re-polls every 30 s and on
 * focus (debounced), exposes `reload` for after every action. A transient failure keeps the last
 * known picture and surfaces `error`.
 */
export function useToolSessions(): { view: SessionsView | null; error: string | null; loading: boolean; reload: () => Promise<void>; patchRow: (row: ToolSessionRow) => void; dropRow: (id: number) => void } {
  const [view, setView] = useState<SessionsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const lastLoad = useRef(0);
  const alive = useRef(true);

  const reload = useCallback(async () => {
    lastLoad.current = Date.now();
    const r = await toolCall<SessionsView>("/api/tool-sessions");
    if (!alive.current) return;
    setLoading(false);
    if (!r.ok) return setError(r.message);
    setError(null);
    setView(r.data);
  }, []);

  useEffect(() => {
    alive.current = true;
    // All setState lives in the fetch continuations (after an await) — never synchronously in
    // the effect body (react-hooks/set-state-in-effect).
    const kick = setTimeout(() => void reload(), 0);
    const iv = setInterval(() => void reload(), LIST_POLL_MS);
    const onFocus = () => {
      if (Date.now() - lastLoad.current >= FOCUS_MIN_MS) void reload();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      alive.current = false;
      clearTimeout(kick);
      clearInterval(iv);
      window.removeEventListener("focus", onFocus);
    };
  }, [reload]);

  const patchRow = useCallback((row: ToolSessionRow) => {
    setView((cur) => (cur ? { ...cur, sessions: cur.sessions.some((s) => s.id === row.id) ? cur.sessions.map((s) => (s.id === row.id ? row : s)) : [row, ...cur.sessions] } : cur));
  }, []);
  const dropRow = useCallback((id: number) => {
    setView((cur) => (cur ? { ...cur, sessions: cur.sessions.filter((s) => s.id !== id) } : cur));
  }, []);

  return { view, error, loading, reload, patchRow, dropRow };
}

export type SessionDetail = { session: ToolSession; events: ToolSessionEvent[]; jobs: { rows: ToolJobView[]; total: number }; partial: string[]; now: number };

/** One session's full picture (accounts, history, jobs). Re-polls every 15 s while any of its
 *  jobs is still moving, and on demand. The state is keyed by the session id, so switching
 *  sessions never shows the previous one's data (no reset-in-effect needed). */
export function useToolSessionDetail(id: number | null): { detail: SessionDetail | null; error: string | null; loading: boolean; reload: () => Promise<void> } {
  const [state, setState] = useState<{ id: number; detail: SessionDetail | null; error: string | null }>({ id: 0, detail: null, error: null });
  const current = useRef<number | null>(null);

  const reload = useCallback(async () => {
    const target = current.current;
    if (!target) return;
    const r = await toolCall<SessionDetail>(`/api/tool-sessions/${target}`);
    if (current.current !== target) return; // the drawer moved on
    if (!r.ok) return setState((cur) => ({ id: target, detail: cur.id === target ? cur.detail : null, error: r.message }));
    setState({ id: target, detail: r.data, error: null });
  }, []);

  useEffect(() => {
    current.current = id;
    if (!id) return;
    const kick = setTimeout(() => void reload(), 0);
    return () => {
      clearTimeout(kick);
      current.current = null;
    };
  }, [id, reload]);

  const mine = id !== null && state.id === id;
  const detail = mine ? state.detail : null;
  const error = mine ? state.error : null;
  const moving = Boolean(detail?.jobs.rows.some((j) => !isTerminalJob(j.status)));
  useEffect(() => {
    if (!id || !moving) return;
    const iv = setInterval(() => void reload(), 15_000);
    return () => clearInterval(iv);
  }, [id, moving, reload]);

  return { detail, error, loading: Boolean(id) && !detail && !error, reload };
}

export type JobsPage = { rows: ToolJobView[]; total: number; filters: Record<string, unknown>; now: number };
export type JobFilters = { session_id?: number; kind?: string; status?: string; limit?: number; offset?: number };

const jobsQuery = (f: JobFilters): string => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== "" && v !== null) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
};

/** The Jobs tab: a page of the team's TOOL jobs under the given filters (state keyed by the
 *  filter query, so a filter change never shows the previous page); re-polls every 15 s while a
 *  listed job is still moving. */
export function useToolJobs(filters: JobFilters, enabled: boolean): { page: JobsPage | null; error: string | null; loading: boolean; reload: () => Promise<void> } {
  const key = jobsQuery(filters);
  const [state, setState] = useState<{ key: string; page: JobsPage | null; error: string | null }>({ key: "", page: null, error: null });
  const latest = useRef(key);

  const reload = useCallback(async () => {
    const mine = latest.current;
    const r = await toolCall<JobsPage>(`/api/tool-sessions/jobs${mine}`);
    if (latest.current !== mine) return;
    if (!r.ok) return setState((cur) => ({ key: mine, page: cur.key === mine ? cur.page : null, error: r.message }));
    setState({ key: mine, page: r.data, error: null });
  }, []);

  useEffect(() => {
    latest.current = key;
    if (!enabled) return;
    const kick = setTimeout(() => void reload(), 0);
    return () => clearTimeout(kick);
  }, [key, enabled, reload]);

  const mine = state.key === key;
  const page = mine ? state.page : null;
  const error = mine ? state.error : null;
  const moving = Boolean(page?.rows.some((j) => !isTerminalJob(j.status)));
  useEffect(() => {
    if (!enabled || !moving) return;
    const iv = setInterval(() => void reload(), 15_000);
    return () => clearInterval(iv);
  }, [enabled, moving, reload]);

  return { page, error, loading: enabled && !page && !error, reload };
}

export type JobDetail = { job: ToolJobView; events: ToolJobEvent[]; eventsError: string | null };

/** Poll one job until it is terminal (2.5 s cadence, bounded). Resolves with the last view
 *  seen — or null when the route kept failing. */
export async function waitForJob(id: number, opts: { intervalMs?: number; maxMs?: number; onTick?: (job: ToolJobView) => void; signal?: { canceled: boolean } } = {}): Promise<ToolJobView | null> {
  const interval = opts.intervalMs ?? 2_500;
  const deadline = Date.now() + (opts.maxMs ?? 120_000);
  let last: ToolJobView | null = null;
  while (Date.now() < deadline && !opts.signal?.canceled) {
    const r = await toolCall<JobDetail>(`/api/tool-sessions/jobs/${id}`);
    if (r.ok) {
      last = r.data.job;
      opts.onTick?.(last);
      if (isTerminalJob(last.status)) return last;
    }
    await new Promise((res) => setTimeout(res, interval));
  }
  return last;
}

export type AccountsView = { accounts: ToolTeamAccount[]; now: number };

/** The Accounts tab: every ad account the team's sessions see, loaded when the tab first opens. */
export function useToolAccounts(enabled: boolean): { view: AccountsView | null; error: string | null; loading: boolean; reload: () => Promise<void> } {
  const [view, setView] = useState<AccountsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const asked = useRef(false);
  const reload = useCallback(async () => {
    const r = await toolCall<AccountsView>("/api/tool-sessions/accounts");
    setLoading(false);
    if (!r.ok) return setError(r.message);
    setError(null);
    setView(r.data);
  }, []);
  useEffect(() => {
    if (!enabled || asked.current) return;
    // `asked` flips INSIDE the timer: a cleanup that cancels the timer (StrictMode's dev
    // double-invoke, a quick tab switch) must not leave the tab marked as loaded-but-empty.
    const kick = setTimeout(() => {
      asked.current = true;
      setLoading(true);
      void reload();
    }, 0);
    return () => clearTimeout(kick);
  }, [enabled, reload]);
  return { view, error, loading, reload };
}
