"use client";

// Owner console: the HS team's Ads Manager SESSIONS on TOOL (https://tool.gctracking.xyz) —
// owner ask 2026-09-25. Mirrors the tool's own Sessions page and drives it through its API with
// the team key that lives on our server: list + status, add a session, check it, refresh its
// cookies / token / proxy, disable / enable, delete, and — per session — the accounts it sees,
// its jobs and its history. Two more tabs read what the same API exposes team-wide: every job
// (retry / cancel) and every ad account with the sessions that see it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Header } from "./header";
import type { SessionUser } from "./user-menu";
import { AlertIcon, ChevronDownIcon, ExternalLinkIcon, PlusIcon, RetryIcon, SearchIcon, SessionsIcon, TrashIcon } from "./icons";
import { JobsTable } from "./tool-sessions-jobs";
import { AddSessionModal, UpdateSessionModal } from "./tool-sessions-forms";
import { SessionDrawer } from "./tool-sessions-drawer";
import { ConfirmButton, Dot, Empty, Flash, ago, agoMs, btnAccent, btnGhost, chip, inputCls, mono, selectInlineCls, stamp, stampFull } from "./tool-sessions-ui";
import { type JobFilters, toolCall, useToolAccounts, useToolJobs, useToolSessions, waitForJob } from "./use-tool-sessions";
import {
  type ToolJobView,
  type ToolSessionRow,
  JOB_KINDS,
  JOB_STATUSES,
  SCOPE_OF,
  SESSION_KIND_LABEL,
  accountStatusLabel,
  accountStatusTone,
  hasScope,
  isSessionKind,
  isTerminalJob,
  sessionStatusTone,
} from "@/lib/tool-sessions-model";

export type BoardTab = "sessions" | "jobs" | "accounts";
const TABS: { id: BoardTab; label: string }[] = [
  { id: "sessions", label: "Sessions" },
  { id: "jobs", label: "Jobs" },
  { id: "accounts", label: "Accounts" },
];

const JOBS_PAGE = 50;

function SetupNotice({ host }: { host: string }) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-warn/40 bg-warn/5 p-4">
      <p className="flex items-center gap-2 text-[14px] font-semibold text-warn">
        <AlertIcon className="h-4 w-4" /> TOOL Sessions is not connected on this deployment
      </p>
      <ol className="list-decimal space-y-1 pl-5 text-[12px] leading-relaxed text-dim">
        <li>
          Open{" "}
          <a href={`${host}/keys`} target="_blank" rel="noreferrer" className="text-[#9db8ff] underline-offset-2 hover:underline">
            {host.replace(/^https?:\/\//, "")}/keys
          </a>{" "}
          and issue a key with every scope (sessions:read/write, jobs:read/write, media:write, accounts:read). It is shown once.
        </li>
        <li>
          Put it into the env as <span className={mono}>TOOL_SESSIONS_API_KEY</span> (Vercel → Settings → Environment Variables, all environments) and redeploy.
        </li>
        <li>Reload this page — the sessions appear, nothing else to configure.</li>
      </ol>
    </div>
  );
}

// ---- sessions table ---------------------------------------------------------------------------------------

function SessionRowView({
  s,
  now,
  checking,
  busy,
  canWrite,
  armed,
  setArmed,
  onOpen,
  onCheck,
  onUpdate,
  onToggle,
  onRemove,
}: {
  s: ToolSessionRow;
  now: number;
  checking: ToolJobView | null;
  busy: boolean;
  canWrite: boolean;
  armed: boolean;
  setArmed: (v: boolean) => void;
  onOpen: () => void;
  onCheck: () => void;
  onUpdate: () => void;
  onToggle: (next: "active" | "disabled") => void;
  onRemove: () => void;
}) {
  const tone = sessionStatusTone(s.status);
  const disabled = s.status === "disabled";
  const cell = "px-2.5 py-2.5 align-top";
  return (
    <tr className={"border-t border-line/60 transition-colors hover:bg-raise/40 " + (disabled ? "opacity-70" : "")} data-testid={`session-row-${s.id}`}>
      <td className={cell}>
        <button type="button" onClick={onOpen} className="text-left" title="Open the session">
          <span className="text-[13px] font-semibold text-[#9db8ff] hover:underline">{s.name}</span>
        </button>
        <p className="text-[10.5px] leading-snug text-faint">
          {isSessionKind(s.kind) ? SESSION_KIND_LABEL[s.kind] : s.kind} · {s.token_kind ?? "—"} · <span className={mono}>{s.token_masked || "—"}</span>
          {s.profile_slug ? ` · ${s.profile_slug}` : ""}
        </p>
      </td>
      <td className={cell}>
        <span className={chip(tone)} data-testid={`session-status-${s.id}`}>
          <Dot tone={tone} />
          {s.status}
        </span>
        {checking ? (
          <p className="mt-1 flex items-center gap-1 text-[10.5px] text-[#9db8ff]">
            <Dot tone="accent" pulse /> checking · {checking.stage || checking.status}
          </p>
        ) : s.last_check_error ? (
          <p className="mt-1 max-w-[220px] text-[10.5px] leading-snug text-danger" title={s.last_check_error}>
            {s.last_check_error.length > 90 ? `${s.last_check_error.slice(0, 90)}…` : s.last_check_error}
          </p>
        ) : null}
      </td>
      <td className={cell}>
        <p className="text-[12.5px] text-ink">{s.fb_user_name ?? "—"}</p>
        <p className={`${mono} text-[10.5px] text-faint`}>{s.fb_user_id ?? ""}</p>
      </td>
      <td className={cell}>
        <button type="button" onClick={onOpen} className={`${mono} text-[13px] text-[#9db8ff] hover:underline`} title="Accounts from the last check">
          {s.accountsSummary.total}
        </button>
        <p className="text-[10.5px] text-faint">
          {s.accountsSummary.active} active{s.account_ids.length ? ` · limited to ${s.account_ids.length}` : ""}
        </p>
      </td>
      <td className={cell}>
        <p className={`${mono} text-[12px] text-ink`}>
          {s.egress_ip_browser ?? "—"} / {s.egress_ip_proxy ?? "—"}
          {s.ip_match === true ? <span className={chip("ok") + " ml-1.5"}>match</span> : s.ip_match === false ? <span className={chip("danger") + " ml-1.5"}>mismatch</span> : null}
        </p>
        <p className={`${mono} max-w-[260px] truncate text-[10.5px] text-faint`} title={s.proxy_masked ?? "no proxy"}>
          {s.proxy_masked ?? "no proxy"}
        </p>
      </td>
      <td className={cell}>
        <p className={`${mono} text-[12px] text-ink`}>{s.cookie_names.length}</p>
        <p className="text-[10.5px] text-faint" title={s.cookies_captured_at ? stampFull(s.cookies_captured_at) : undefined}>
          {s.cookies_captured_at ? stamp(s.cookies_captured_at) : "—"}
        </p>
      </td>
      <td className={cell}>
        <p className="text-[12px] text-ink" title={s.last_check_at ? stampFull(s.last_check_at) : undefined}>
          {s.last_check_at ? stamp(s.last_check_at) : "never"}
        </p>
        <p className="text-[10.5px] text-faint" title={s.last_used_at ? stampFull(s.last_used_at) : undefined}>
          {s.last_used_at ? `used ${ago(s.last_used_at, now)}` : "not used yet"}
        </p>
      </td>
      <td className={cell}>
        <div className="flex flex-wrap justify-end gap-1">
          <button type="button" onClick={onCheck} disabled={busy || !canWrite || Boolean(checking)} className={btnGhost + " h-7 px-2"} title="Queue a check: /me, accounts, egress IP" data-testid={`check-${s.id}`}>
            <RetryIcon className={"h-3.5 w-3.5 " + (checking ? "animate-spin" : "")} /> Check
          </button>
          <button type="button" onClick={onUpdate} disabled={busy || !canWrite} className={btnGhost + " h-7 px-2"} title="New cookies / token / proxy / restriction" data-testid={`update-${s.id}`}>
            Update
          </button>
          <button type="button" onClick={() => onToggle(disabled ? "active" : "disabled")} disabled={busy || !canWrite} className={btnGhost + " h-7 px-2"} title={disabled ? "Enable (a check is queued)" : "Disable — the worker stops using this session"} data-testid={`toggle-${s.id}`}>
            {disabled ? "Enable" : "Disable"}
          </button>
          <ConfirmButton label="" title="Delete this session from TOOL (asks once more)" confirmLabel="Delete?" onConfirm={onRemove} disabled={busy || !canWrite} armed={armed} setArmed={setArmed} className={"inline-flex h-7 items-center gap-1 rounded-lg border border-danger/40 bg-danger/10 px-2 text-[12px] font-medium text-danger hover:bg-danger/20 disabled:opacity-40"} testId={`delete-${s.id}`}>
            <TrashIcon className="h-3.5 w-3.5" />
          </ConfirmButton>
        </div>
      </td>
    </tr>
  );
}

// ---- board ----------------------------------------------------------------------------------------------------

export function ToolSessionsBoard({ user, initialTab = "sessions", initialId = null }: { user: SessionUser; initialTab?: BoardTab; initialId?: number | null }) {
  const { view, error, loading, reload, patchRow, dropRow } = useToolSessions();
  const [tab, setTab] = useState<BoardTab>(initialTab);
  const [openId, setOpenId] = useState<number | null>(initialId);
  const [addOpen, setAddOpen] = useState(false);
  const [updateId, setUpdateId] = useState<number | null>(null);
  const [armed, setArmed] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [checking, setChecking] = useState<Record<number, ToolJobView>>({});
  const [flash, setFlash] = useState<{ tone: "ok" | "danger" | "warn"; text: string } | null>(null);
  const [refreshKey, setRefreshKey] = useState<Record<number, number>>({});
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "expired" | "disabled">("all");
  const [logOpen, setLogOpen] = useState(false);
  const [jobFilters, setJobFilters] = useState<JobFilters>({ limit: JOBS_PAGE, offset: 0 });
  // Per-job overrides (a retry / cancel / refresh answered a fresher row than the page holds);
  // the rendered list = the page's rows with these applied. Cleared when the page changes.
  const [jobOverrides, setJobOverrides] = useState<{ pageNow: number; rows: Record<number, ToolJobView> }>({ pageNow: 0, rows: {} });
  const [acctQuery, setAcctQuery] = useState("");
  const [acctStatus, setAcctStatus] = useState<"all" | "active" | "other">("all");
  const alive = useRef(true);
  // Newest session.check id per session BEFORE an action that queues a check (update / enable):
  // the follow-up then waits for a NEWER job, never mistakes a finished earlier check for it.
  const checkBaseline = useRef<Record<number, number>>({});

  const jobs = useToolJobs(jobFilters, tab === "jobs" && Boolean(view?.configured));
  const accounts = useToolAccounts(tab === "accounts" && Boolean(view?.configured));

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 7000);
    return () => clearTimeout(t);
  }, [flash]);

  // The tab and the open session ride in the URL so a refresh (or a shared link) lands in the
  // same place — replaceState, no navigation.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (tab === "sessions") url.searchParams.delete("tab");
    else url.searchParams.set("tab", tab);
    if (openId) url.searchParams.set("id", String(openId));
    else url.searchParams.delete("id");
    window.history.replaceState(null, "", url.toString());
  }, [tab, openId]);

  const sessions = useMemo(() => view?.sessions ?? [], [view]);
  const jobRows = useMemo(() => {
    const rows = jobs.page?.rows ?? [];
    if (!jobs.page || jobOverrides.pageNow !== jobs.page.now) return rows;
    return rows.map((r) => jobOverrides.rows[r.id] ?? r);
  }, [jobs.page, jobOverrides]);
  const pageNow = jobs.page?.now ?? 0;
  const overrideJob = useCallback(
    (j: ToolJobView) => setJobOverrides((cur) => ({ pageNow, rows: { ...(cur.pageNow === pageNow ? cur.rows : {}), [j.id]: j } })),
    [pageNow],
  );
  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  const names = useMemo(() => new Map(sessions.map((s) => [s.id, s.name])), [sessions]);
  const canWrite = hasScope(view?.me, SCOPE_OF.write);
  const canJobsWrite = hasScope(view?.me, SCOPE_OF.jobsWrite);
  const bump = useCallback((id: number) => setRefreshKey((cur) => ({ ...cur, [id]: (cur[id] ?? 0) + 1 })), []);

  /** Follow a check job to its end, then refresh the row (its status may have flipped). */
  const followCheck = useCallback(
    async (sessionId: number, job: ToolJobView) => {
      setChecking((cur) => ({ ...cur, [sessionId]: job }));
      const gone = { get canceled() { return !alive.current; } };
      const last = await waitForJob(job.id, { signal: gone, onTick: (j) => alive.current && setChecking((cur) => ({ ...cur, [sessionId]: j })) });
      if (!alive.current) return;
      setChecking((cur) => {
        const next = { ...cur };
        delete next[sessionId];
        return next;
      });
      await reload();
      bump(sessionId);
      const name = names.get(sessionId) ?? `#${sessionId}`;
      if (!last || !isTerminalJob(last.status)) setFlash({ tone: "warn", text: `Check of "${name}" is still running on TOOL — the row updates on the next refresh.` });
      else if (last.status === "done") setFlash({ tone: "ok", text: `"${name}" checked — ${last.summary || "ok"}.` });
      else setFlash({ tone: "danger", text: `Check of "${name}" ended ${last.status}${last.summary ? ` — ${last.summary}` : ""}.` });
    },
    [reload, bump, names],
  );

  /** The newest session.check id of a session right now (0 = none) — the baseline a later
   *  follow-up compares against. Called when the Update modal opens and before an enable. */
  const noteCheckBaseline = useCallback(async (sessionId: number) => {
    const r = await toolCall<{ rows: ToolJobView[] }>(`/api/tool-sessions/jobs?session_id=${sessionId}&kind=session.check&limit=1`);
    if (r.ok) checkBaseline.current[sessionId] = r.data.rows[0]?.id ?? 0;
  }, []);

  /** A create / update / enable with check_now queues a check TOOL-side without telling us the
   *  job id: wait for a session.check NEWER than the baseline (a few tries — the queue may lag);
   *  a job id never depends on clocks, so an earlier finished check can't be mistaken for it. */
  const watchQueuedCheck = useCallback(
    async (sessionId: number) => {
      const baseline = checkBaseline.current[sessionId] ?? 0;
      for (let i = 0; i < 6 && alive.current; i++) {
        const r = await toolCall<{ rows: ToolJobView[] }>(`/api/tool-sessions/jobs?session_id=${sessionId}&kind=session.check&limit=1`);
        const job = r.ok ? r.data.rows[0] : undefined;
        if (job && job.id > baseline) return followCheck(sessionId, job);
        await new Promise((res) => setTimeout(res, 2000));
      }
      await reload();
    },
    [followCheck, reload],
  );

  const check = useCallback(
    async (id: number) => {
      if (checking[id]) return;
      setBusy(id);
      const r = await toolCall<{ job: ToolJobView }>(`/api/tool-sessions/${id}/check`, { method: "POST" });
      setBusy(null);
      if (!r.ok) return setFlash({ tone: "danger", text: r.message });
      void followCheck(id, r.data.job);
    },
    [checking, followCheck],
  );

  const toggle = useCallback(
    async (id: number, next: "active" | "disabled") => {
      setBusy(id);
      if (next === "active") await noteCheckBaseline(id);
      const r = await toolCall<{ session: ToolSessionRow }>(`/api/tool-sessions/${id}`, { method: "PATCH", body: JSON.stringify({ status: next, check_now: next === "active" }) });
      setBusy(null);
      if (!r.ok) return setFlash({ tone: "danger", text: r.message });
      patchRow(r.data.session);
      bump(id);
      setFlash({ tone: "ok", text: next === "disabled" ? `"${r.data.session.name}" disabled — the worker will not use it.` : `"${r.data.session.name}" enabled — a check is queued.` });
      if (next === "active") void watchQueuedCheck(id);
    },
    [patchRow, bump, watchQueuedCheck, noteCheckBaseline],
  );

  const remove = useCallback(
    async (id: number) => {
      setBusy(id);
      const r = await toolCall<{ name: string }>(`/api/tool-sessions/${id}`, { method: "DELETE" });
      setBusy(null);
      setArmed(null);
      if (!r.ok) return setFlash({ tone: "danger", text: r.message });
      dropRow(id);
      if (openId === id) setOpenId(null);
      setFlash({ tone: "ok", text: `"${r.data.name}" deleted from TOOL.` });
    },
    [dropRow, openId],
  );

  const openUpdate = useCallback(
    (id: number) => {
      setUpdateId(id);
      void noteCheckBaseline(id);
    },
    [noteCheckBaseline],
  );

  const onCreated = (row: ToolSessionRow, warnings: string[], checkQueued: boolean) => {
    setAddOpen(false);
    patchRow(row);
    setFlash({ tone: warnings.length ? "warn" : "ok", text: `"${row.name}" added${checkQueued ? " — TOOL is checking it" : ""}.${warnings.length ? ` ${warnings.join(" ")}` : ""}` });
    if (checkQueued) void watchQueuedCheck(row.id);
    else void reload();
  };
  const onUpdated = (row: ToolSessionRow, changed: string[], checkQueued: boolean) => {
    setUpdateId(null);
    patchRow(row);
    bump(row.id);
    setFlash({ tone: "ok", text: `"${row.name}" updated (${changed.join(", ")})${checkQueued ? " — a check is queued" : ""}.` });
    if (checkQueued) void watchQueuedCheck(row.id);
  };

  // (A) The drawer confirms its own Delete (two-step inside the drawer) and then calls `remove`
  // straight — no hand-off to a row button that a filter may be hiding.
  const actions = useMemo(
    () => ({
      check: (id: number) => void check(id),
      update: openUpdate,
      toggle: (id: number, next: "active" | "disabled") => void toggle(id, next),
      remove: (id: number) => void remove(id),
    }),
    [check, toggle, remove, openUpdate],
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter((s) => (statusFilter === "all" ? true : s.status === statusFilter)).filter((s) => !q || s.name.toLowerCase().includes(q) || (s.fb_user_name ?? "").toLowerCase().includes(q) || (s.fb_user_id ?? "").includes(q) || (s.profile_slug ?? "").toLowerCase().includes(q) || (s.egress_ip_proxy ?? "").includes(q));
  }, [sessions, query, statusFilter]);
  const counts = useMemo(() => {
    const c = { active: 0, expired: 0, disabled: 0, other: 0 };
    for (const s of sessions) {
      if (s.status === "active") c.active++;
      else if (s.status === "expired") c.expired++;
      else if (s.status === "disabled") c.disabled++;
      else c.other++;
    }
    return c;
  }, [sessions]);

  const shownAccounts = useMemo(() => {
    const list = accounts.view?.accounts ?? [];
    const q = acctQuery.trim().toLowerCase();
    return list.filter((a) => (acctStatus === "all" ? true : acctStatus === "active" ? a.status === 1 : a.status !== 1)).filter((a) => !q || a.account_id.includes(q) || a.name.toLowerCase().includes(q) || a.sessions.some((s) => s.name.toLowerCase().includes(q)));
  }, [accounts.view, acctQuery, acctStatus]);

  const host = view?.host ?? "https://tool.gctracking.xyz";
  const me = view?.me ?? null;
  const head = "px-2.5 py-2 text-left text-[9.5px] font-semibold uppercase tracking-[0.16em] text-faint";

  return (
    <>
      <Header
        partner="br"
        onPartnerChange={() => undefined}
        user={user}
        platform="console"
        consoleLabel={
          <>
            <SessionsIcon className="h-3.5 w-3.5" /> TOOL Sessions · HS team
          </>
        }
      />
      <main className="flex-1">
        <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-4 px-4 pb-28 pt-6 sm:px-6">
          {/* ---- title + key ---- */}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex flex-col gap-1.5">
              <Link href="/" className="w-fit text-[11px] font-medium text-faint transition-colors hover:text-[#9db8ff]">
                ← Back to launcher
              </Link>
              <h1 className="flex items-center gap-2 text-[19px] font-semibold tracking-tight text-ink">
                <SessionsIcon className="h-5 w-5 text-[#9db8ff]" />
                Ads Manager sessions
              </h1>
              <p className="max-w-[760px] text-[11.5px] leading-relaxed text-faint">
                The HS team&apos;s Ads Manager sessions on TOOL (token + cookies + User-Agent + proxy from one profile, or a Marketing API token). The tool&apos;s worker
                creates and duplicates campaigns through them. Everything here goes through TOOL&apos;s API with the team key — secrets are never shown back.
              </p>
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <span className={chip("dim")}>{sessions.length} session{sessions.length === 1 ? "" : "s"}</span>
                {counts.active ? <span className={chip("ok")}>{counts.active} active</span> : null}
                {counts.expired ? <span className={chip("danger")}>{counts.expired} expired</span> : null}
                {counts.disabled ? <span className={chip("dim")}>{counts.disabled} disabled</span> : null}
                {counts.other ? <span className={chip("warn")}>{counts.other} other</span> : null}
                {me ? (
                  <span className={chip(canWrite ? "accent" : "warn")} title={`scopes: ${me.scopes.join(", ") || "none"}`}>
                    key {me.actor.replace(/^key:/, "")} · team {me.team_id} · {me.scopes.length} scope{me.scopes.length === 1 ? "" : "s"}
                    {!canWrite ? " · READ-ONLY" : ""}
                  </span>
                ) : view?.meError ? (
                  <span className={chip("danger")} title={view.meError}>
                    key check failed
                  </span>
                ) : null}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <a href={`${host}/sessions`} target="_blank" rel="noreferrer" className={btnGhost} title="Open TOOL Sessions itself">
                <ExternalLinkIcon className="h-3.5 w-3.5" /> Open TOOL
              </a>
              <button type="button" onClick={() => void reload()} disabled={loading} className={btnGhost} title="Reload from TOOL" data-testid="reload">
                <RetryIcon className={"h-3.5 w-3.5 " + (loading ? "animate-spin" : "")} /> Refresh
              </button>
              <button type="button" onClick={() => setAddOpen(true)} disabled={!view?.configured || !canWrite} className={btnAccent + " h-9"} data-testid="add-session">
                <PlusIcon className="h-4 w-4" /> Add session
              </button>
            </div>
          </div>

          <Flash flash={flash} />
          {error ? (
            <div className="flex items-center gap-2 rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-red-300" data-testid="load-error">
              <AlertIcon className="h-4 w-4 shrink-0" />
              Could not reach TOOL: {error}
              <button type="button" onClick={() => void reload()} className={btnGhost + " ml-auto"}>
                <RetryIcon className="h-3.5 w-3.5" /> Retry
              </button>
            </div>
          ) : null}

          {view && !view.configured ? <SetupNotice host={host} /> : null}

          {/* ---- tabs ---- */}
          <div className="flex flex-wrap items-center gap-2">
            <nav className="flex items-center gap-1 rounded-full border border-line bg-surface p-1" aria-label="Sections">
              {TABS.map((t) => (
                <button key={t.id} type="button" onClick={() => setTab(t.id)} aria-current={tab === t.id ? "page" : undefined} className={"h-8 rounded-full px-3.5 text-[12.5px] font-medium transition-colors " + (tab === t.id ? "bg-accent/15 text-[#9db8ff]" : "text-dim hover:bg-raise hover:text-ink")} data-testid={`tab-${t.id}`}>
                  {t.label}
                </button>
              ))}
            </nav>
            {tab === "sessions" ? (
              <>
                <div className="relative min-w-[220px]">
                  <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, FB user, slug, IP" className={inputCls + " pl-8"} data-testid="session-search" />
                </div>
                <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)} className={selectInlineCls} data-testid="session-status-filter">
                  <option value="all">all statuses</option>
                  <option value="active">active</option>
                  <option value="expired">expired</option>
                  <option value="disabled">disabled</option>
                </select>
                <span className="text-[11px] text-faint">auto-refresh every 30 s{view ? ` · ${agoMs(view.now)}` : ""}</span>
              </>
            ) : null}
          </div>

          {/* ---- sessions ---- */}
          {tab === "sessions" ? (
            !view ? (
              <div className="flex h-40 items-center justify-center rounded-2xl border border-dashed border-line2 text-[13px] text-faint">{error ? "TOOL unavailable." : "Loading the sessions…"}</div>
            ) : shown.length === 0 ? (
              <Empty>{sessions.length ? "No session matches the filter." : view.configured ? "No sessions yet — add the first one." : "Connect TOOL first."}</Empty>
            ) : (
              <div className="overflow-x-auto rounded-2xl border border-line bg-surface/50">
                <table className="w-full min-w-[1120px] border-collapse" data-testid="sessions-table">
                  <thead className="bg-surface2/70">
                    <tr>
                      <th className={head}>Session</th>
                      <th className={head}>Status</th>
                      <th className={head}>FB user</th>
                      <th className={head}>Accounts</th>
                      <th className={head}>IP browser / proxy</th>
                      <th className={head}>Cookies</th>
                      <th className={head}>Checked</th>
                      <th className={head}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((s) => (
                      <SessionRowView
                        key={s.id}
                        s={s}
                        now={view.now}
                        checking={checking[s.id] ?? null}
                        busy={busy === s.id}
                        canWrite={canWrite}
                        armed={armed === s.id}
                        setArmed={(v) => setArmed(v ? s.id : null)}
                        onOpen={() => setOpenId(s.id)}
                        onCheck={() => void check(s.id)}
                        onUpdate={() => openUpdate(s.id)}
                        onToggle={(next) => void toggle(s.id, next)}
                        onRemove={() => void remove(s.id)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : null}

          {/* ---- jobs ---- */}
          {tab === "jobs" ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <select value={jobFilters.session_id ?? ""} onChange={(e) => setJobFilters((f) => ({ ...f, session_id: e.target.value ? Number(e.target.value) : undefined, offset: 0 }))} className={selectInlineCls} data-testid="jobs-session">
                  <option value="">every session</option>
                  {sessions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <select value={jobFilters.kind ?? ""} onChange={(e) => setJobFilters((f) => ({ ...f, kind: e.target.value || undefined, offset: 0 }))} className={selectInlineCls} data-testid="jobs-kind">
                  <option value="">every kind</option>
                  {JOB_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
                <select value={jobFilters.status ?? ""} onChange={(e) => setJobFilters((f) => ({ ...f, status: e.target.value || undefined, offset: 0 }))} className={selectInlineCls} data-testid="jobs-status">
                  <option value="">every status</option>
                  {JOB_STATUSES.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={() => void jobs.reload()} disabled={jobs.loading} className={btnGhost}>
                  <RetryIcon className={"h-3.5 w-3.5 " + (jobs.loading ? "animate-spin" : "")} /> Refresh
                </button>
                {jobs.page ? (
                  <span className="ml-auto flex items-center gap-1.5 text-[11px] text-faint">
                    {jobs.page.total} job{jobs.page.total === 1 ? "" : "s"}
                    {jobs.page.total ? ` · showing ${(jobFilters.offset ?? 0) + 1}–${Math.min((jobFilters.offset ?? 0) + JOBS_PAGE, jobs.page.total)}` : ""}
                    <button type="button" disabled={(jobFilters.offset ?? 0) === 0} onClick={() => setJobFilters((f) => ({ ...f, offset: Math.max(0, (f.offset ?? 0) - JOBS_PAGE) }))} className={btnGhost + " h-7 px-2"}>
                      ‹
                    </button>
                    <button type="button" disabled={(jobFilters.offset ?? 0) + JOBS_PAGE >= jobs.page.total} onClick={() => setJobFilters((f) => ({ ...f, offset: (f.offset ?? 0) + JOBS_PAGE }))} className={btnGhost + " h-7 px-2"}>
                      ›
                    </button>
                  </span>
                ) : null}
                {!canJobsWrite && me ? <span className={chip("warn")}>key cannot retry / cancel (jobs:write)</span> : null}
              </div>
              {jobs.error ? <p className="text-[12px] text-danger">{jobs.error}</p> : null}
              {!jobs.page && jobs.loading ? <p className="py-8 text-center text-[12px] text-faint">Loading the jobs…</p> : jobs.page ? <JobsTable rows={jobRows} showSession sessionNames={names} canWrite={canJobsWrite} onChanged={overrideJob} onRefresh={() => void jobs.reload()} onFlash={(tone, text) => setFlash({ tone, text })} /> : null}
            </div>
          ) : null}

          {/* ---- accounts ---- */}
          {tab === "accounts" ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-[240px]">
                  <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
                  <input value={acctQuery} onChange={(e) => setAcctQuery(e.target.value)} placeholder="Search id, name or session" className={inputCls + " pl-8"} data-testid="accounts-search" />
                </div>
                <select value={acctStatus} onChange={(e) => setAcctStatus(e.target.value as typeof acctStatus)} className={selectInlineCls}>
                  <option value="all">all statuses</option>
                  <option value="active">active</option>
                  <option value="other">not active</option>
                </select>
                <button type="button" onClick={() => void accounts.reload()} disabled={accounts.loading} className={btnGhost}>
                  <RetryIcon className={"h-3.5 w-3.5 " + (accounts.loading ? "animate-spin" : "")} /> Refresh
                </button>
                {accounts.view ? (
                  <span className="ml-auto text-[11px] text-faint">
                    {shownAccounts.length} of {accounts.view.accounts.length} accounts · from the sessions&apos; last checks
                  </span>
                ) : null}
              </div>
              {accounts.error ? <p className="text-[12px] text-danger">{accounts.error}</p> : null}
              {!accounts.view ? (
                <p className="py-8 text-center text-[12px] text-faint">{accounts.loading ? "Loading the accounts…" : ""}</p>
              ) : shownAccounts.length === 0 ? (
                <Empty>No account matches.</Empty>
              ) : (
                <div className="overflow-x-auto rounded-2xl border border-line bg-surface/50">
                  <table className="w-full min-w-[720px] border-collapse text-[12px]" data-testid="accounts-table">
                    <thead className="bg-surface2/70">
                      <tr>
                        <th className={head}>Account id</th>
                        <th className={head}>Name</th>
                        <th className={head}>Currency</th>
                        <th className={head}>Status</th>
                        <th className={head}>Seen by</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shownAccounts.map((a) => (
                        <tr key={a.account_id} className="border-t border-line/60 hover:bg-raise/40">
                          <td className={`px-2.5 py-1.5 ${mono} text-dim`}>{a.account_id}</td>
                          <td className="px-2.5 py-1.5 text-ink">{a.name}</td>
                          <td className={`px-2.5 py-1.5 ${mono} text-dim`}>{a.currency}</td>
                          <td className="px-2.5 py-1.5">
                            <span className={chip(accountStatusTone(a.status))}>{accountStatusLabel(a.status)}</span>
                          </td>
                          <td className="px-2.5 py-1.5">
                            <div className="flex flex-wrap gap-1">
                              {a.sessions.map((s) => (
                                <button key={s.id} type="button" onClick={() => setOpenId(s.id)} className={chip(byId.get(s.id)?.status === "active" ? "accent" : "dim") + " hover:border-accent/60"} title="Open the session">
                                  {s.name}
                                </button>
                              ))}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : null}

          {/* ---- our change log ---- */}
          {view?.configured ? (
            <div className="rounded-2xl border border-line bg-surface/40">
              <button type="button" onClick={() => setLogOpen((v) => !v)} className="flex w-full items-center gap-2 px-3 py-2 text-left" aria-expanded={logOpen}>
                <ChevronDownIcon className={`h-3.5 w-3.5 text-faint transition-transform ${logOpen ? "rotate-180" : ""}`} />
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">Changes made from Ad Launcher</span>
                <span className="text-[10.5px] text-faint">· {view.log.length} recorded · TOOL&apos;s own history names the key, this names the owner</span>
              </button>
              {logOpen ? (
                <div className="flex max-h-[40vh] flex-col overflow-y-auto border-t border-line px-3 py-1">
                  {view.log.length === 0 ? (
                    <p className="py-2 text-[11px] text-faint">Nothing yet.</p>
                  ) : (
                    view.log.map((e, i) => (
                      <div key={`${e.at}-${i}`} className="border-b border-line/60 py-1.5 last:border-b-0">
                        <p className="text-[11.5px] leading-snug text-dim">
                          {e.sessionId ? (
                            <button type="button" onClick={() => setOpenId(e.sessionId)} className="text-[#9db8ff] hover:underline">
                              {e.text}
                            </button>
                          ) : (
                            e.text
                          )}
                        </p>
                        <p className="text-[10px] text-faint">
                          {e.by || "?"} · {agoMs(e.at)}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </main>

      {addOpen ? <AddSessionModal onClose={() => setAddOpen(false)} onCreated={onCreated} /> : null}
      {updateId && byId.get(updateId) ? <UpdateSessionModal session={byId.get(updateId)!} onClose={() => setUpdateId(null)} onUpdated={onUpdated} /> : null}
      {openId ? <SessionDrawer id={openId} host={host} actions={actions} busy={busy === openId} checking={checking[openId] ?? null} canWrite={canWrite} canJobsWrite={canJobsWrite} modalOpen={addOpen || updateId !== null} onClose={() => setOpenId(null)} refreshKey={refreshKey[openId] ?? 0} /> : null}
    </>
  );
}
