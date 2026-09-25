"use client";

// The per-session slide-over of the TOOL Sessions console: everything TOOL knows about one
// session — identity, browser / proxy, cookies, the accounts it sees (searchable), its jobs
// (checks, creates, duplicates, media) and its history — plus the same actions as the row.

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRightIcon, ExternalLinkIcon, RetryIcon, SearchIcon, TrashIcon, XIcon } from "./icons";
import { JobsTable } from "./tool-sessions-jobs";
import { ConfirmButton, Dot, Empty, KeyValue, ago, btnGhost, chip, inputCls, mono, selectInlineCls, stamp, stampFull } from "./tool-sessions-ui";
import { useToolSessionDetail } from "./use-tool-sessions";
import {
  type ToolAccount,
  type ToolJobView,
  type ToolSession,
  SESSION_KIND_LABEL,
  accountStatusLabel,
  accountStatusTone,
  describeActor,
  describeSessionEvent,
  isSessionKind,
  sessionStatusTone,
} from "@/lib/tool-sessions-model";

export type SessionActions = {
  check: (id: number) => void;
  update: (id: number) => void;
  toggle: (id: number, next: "active" | "disabled") => void;
  remove: (id: number) => void;
};

function AccountsList({ accounts, restriction }: { accounts: ToolAccount[]; restriction: string[] }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "other">("all");
  const restricted = useMemo(() => new Set(restriction), [restriction]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return accounts.filter((a) => (status === "all" ? true : status === "active" ? a.status === 1 : a.status !== 1)).filter((a) => !needle || a.account_id.includes(needle) || a.name.toLowerCase().includes(needle));
  }, [accounts, q, status]);
  const active = accounts.filter((a) => a.status === 1).length;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search id or name" className={inputCls + " pl-8"} data-testid="drawer-acct-search" />
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value as "all" | "active" | "other")} className={selectInlineCls}>
          <option value="all">all ({accounts.length})</option>
          <option value="active">active ({active})</option>
          <option value="other">not active ({accounts.length - active})</option>
        </select>
        {restriction.length ? <span className={chip("warn")}>restricted to {restriction.length}</span> : <span className={chip("dim")}>unrestricted</span>}
      </div>
      {shown.length === 0 ? (
        <Empty>{accounts.length ? "No account matches." : "No accounts from the last check yet — run a check."}</Empty>
      ) : (
        <div className="max-h-[48vh] overflow-auto rounded-xl border border-line">
          <table className="w-full border-collapse text-[12px]">
            <thead className="sticky top-0 bg-surface2">
              <tr>
                {["Account id", "Name", "Currency", "Status"].map((h) => (
                  <th key={h} className="px-2 py-1.5 text-left text-[9.5px] font-semibold uppercase tracking-[0.16em] text-faint">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((a) => (
                <tr key={a.account_id} className="border-t border-line/60">
                  <td className={`px-2 py-1.5 ${mono} text-dim`}>
                    {a.account_id}
                    {restricted.has(a.account_id) ? <span className={chip("warn") + " ml-1.5"}>allowed</span> : null}
                  </td>
                  <td className="px-2 py-1.5 text-ink">{a.name}</td>
                  <td className={`px-2 py-1.5 ${mono} text-dim`}>{a.currency}</td>
                  <td className="px-2 py-1.5">
                    <span className={chip(accountStatusTone(a.status))}>{accountStatusLabel(a.status)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Overview({ s }: { s: ToolSession }) {
  const tone = sessionStatusTone(s.status);
  return (
    <KeyValue
      rows={[
        ["Kind / token", <span key="k">{isSessionKind(s.kind) ? SESSION_KIND_LABEL[s.kind] : s.kind} · {s.token_kind ?? "—"} · <span className={mono}>{s.token_masked || "—"}</span></span>],
        ["FB user", <span key="u">{s.fb_user_name ?? "—"} {s.fb_user_id ? <span className={`${mono} text-faint`}>{s.fb_user_id}</span> : null}</span>],
        ["Status", <span key="s" className={chip(tone)}><Dot tone={tone} />{s.status}{s.last_check_error ? <span className="ml-1 font-normal normal-case">— {s.last_check_error}</span> : null}</span>],
        ["Profile slug", s.profile_slug ?? "—"],
        ["Proxy", <span key="p" className={mono}>{s.proxy_masked ?? "no proxy"}</span>],
        ["IP browser / proxy", <span key="ip" className={mono}>{s.egress_ip_browser ?? "—"} / {s.egress_ip_proxy ?? "—"}{s.ip_match === true ? <span className={chip("ok") + " ml-1.5"}>match</span> : s.ip_match === false ? <span className={chip("danger") + " ml-1.5"}>mismatch</span> : null}</span>],
        ["User-Agent", <span key="ua" className={`${mono} text-[11px]`}>{s.user_agent ?? "—"}</span>],
        ["Cookies", <span key="c">{s.cookie_names.length ? s.cookie_names.join(", ") : "none"}{s.cookies_captured_at ? <span className="text-faint"> · captured {stampFull(s.cookies_captured_at)}</span> : null}</span>],
        ["Checked", <span key="ch">{s.last_check_at ? `${stampFull(s.last_check_at)} (${ago(s.last_check_at)})` : "never"}</span>],
        ["Last used", <span key="lu">{s.last_used_at ? `${stampFull(s.last_used_at)} (${ago(s.last_used_at)})` : "never"}</span>],
        ["Account restriction", s.account_ids.length ? `${s.account_ids.length} account${s.account_ids.length === 1 ? "" : "s"}: ${s.account_ids.join(", ")}` : "none — every account the session sees"],
        ["Graph version", s.graph_version || "—"],
        ["Source", <span key="src">{s.source || "—"} · created {stampFull(s.created_at)} · updated {stampFull(s.updated_at)}</span>],
        ["TOOL id", <span key="id" className={mono}>#{s.id} · team {s.team_id}</span>],
      ]}
    />
  );
}

export function SessionDrawer({ id, host, actions, busy, checking, canWrite, canJobsWrite = true, modalOpen = false, onClose, refreshKey }: { id: number; host: string; actions: SessionActions; busy: boolean; checking: ToolJobView | null; canWrite: boolean; /** jobs:write on the key (Retry / Cancel in the Jobs tab). */ canJobsWrite?: boolean; /** A modal sits above the drawer — Escape belongs to it, not to us. */ modalOpen?: boolean; onClose: () => void; refreshKey: number }) {
  const { detail, error, loading, reload } = useToolSessionDetail(id);
  const [tab, setTab] = useState<"overview" | "accounts" | "jobs" | "history">("overview");
  const [armed, setArmed] = useState(false);
  // Per-job overrides on top of the detail's job rows (a retry / cancel answered a fresher row).
  const [jobOverrides, setJobOverrides] = useState<{ at: number; rows: Record<number, ToolJobView> }>({ at: 0, rows: {} });
  const [flash, setFlash] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);

  // The board bumps refreshKey after an action on this session (check finished, update, status):
  // reload on a CHANGE only — the detail hook already loads on mount, whatever the key's value.
  const seenKey = useRef(refreshKey);
  useEffect(() => {
    if (seenKey.current === refreshKey) return;
    seenKey.current = refreshKey;
    void reload();
  }, [refreshKey, reload]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 4000);
    return () => clearTimeout(t);
  }, [flash]);
  useEffect(() => {
    if (modalOpen) return; // the modal above us owns Escape
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, modalOpen]);

  const s = detail?.session ?? null;
  const detailNow = detail?.now ?? 0;
  const jobs = useMemo(() => {
    const rows = detail?.jobs.rows ?? [];
    if (!detail || jobOverrides.at !== detail.now) return rows;
    return rows.map((r) => jobOverrides.rows[r.id] ?? r);
  }, [detail, jobOverrides]);
  const overrideJob = (j: ToolJobView) => setJobOverrides((cur) => ({ at: detailNow, rows: { ...(cur.at === detailNow ? cur.rows : {}), [j.id]: j } }));
  const tone = s ? sessionStatusTone(s.status) : "dim";
  const tabBtn = (key: typeof tab, label: string, count?: number) => (
    <button type="button" onClick={() => setTab(key)} className={"h-8 rounded-lg px-3 text-[12px] font-medium transition-colors " + (tab === key ? "bg-accent/15 text-[#9db8ff]" : "text-dim hover:bg-raise hover:text-ink")} data-testid={`drawer-tab-${key}`}>
      {label}
      {count !== undefined ? <span className={`${mono} ml-1 text-[10.5px] text-faint`}>{count}</span> : null}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-end" data-testid="session-drawer">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px] animate-fade-in" onClick={onClose} aria-hidden="true" />
      <aside className="relative flex h-full w-full max-w-[960px] flex-col border-l border-line bg-surface shadow-[-24px_0_80px_rgba(0,0,0,0.55)] animate-drawer-in" role="dialog" aria-modal="true" aria-label={s ? `Session ${s.name}` : "Session"}>
        <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[16px] font-semibold tracking-tight text-ink">{s ? s.name : `Session #${id}`}</h2>
              {s ? (
                <span className={chip(tone)}>
                  <Dot tone={tone} />
                  {s.status}
                </span>
              ) : null}
              {checking ? (
                <span className={chip("accent")}>
                  <Dot tone="accent" pulse /> checking · {checking.stage || checking.status}
                </span>
              ) : null}
            </div>
            {s ? (
              <p className="text-[11px] text-faint">
                {s.fb_user_name ?? "—"} · {detail?.session.accounts.length ?? 0} accounts · checked {ago(s.last_check_at)}
              </p>
            ) : null}
          </div>
          <div className="flex items-center gap-1.5">
            <a href={`${host}/sessions/${id}`} target="_blank" rel="noreferrer" className={btnGhost} title="Open this session in TOOL">
              <ExternalLinkIcon className="h-3.5 w-3.5" /> TOOL
            </a>
            <button type="button" onClick={() => void reload()} disabled={loading} className={btnGhost} title="Reload" aria-label="Reload">
              <RetryIcon className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={onClose} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-lg text-faint transition-colors hover:bg-raise hover:text-ink">
              <XIcon className="h-4 w-4" />
            </button>
          </div>
        </div>

        {s ? (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-4 py-2">
            <button type="button" onClick={() => actions.check(id)} disabled={busy || !canWrite || Boolean(checking)} className={btnGhost} data-testid="drawer-check">
              <RetryIcon className="h-3.5 w-3.5" /> {checking ? "Checking…" : "Check now"}
            </button>
            <button type="button" onClick={() => actions.update(id)} disabled={busy || !canWrite} className={btnGhost} data-testid="drawer-update">
              Update…
            </button>
            {s.status === "disabled" ? (
              <button type="button" onClick={() => actions.toggle(id, "active")} disabled={busy || !canWrite} className={btnGhost}>
                Enable
              </button>
            ) : (
              <button type="button" onClick={() => actions.toggle(id, "disabled")} disabled={busy || !canWrite} className={btnGhost}>
                Disable
              </button>
            )}
            <ConfirmButton label="Delete…" title="Delete this session from TOOL (asks once more)" confirmLabel="Delete from TOOL?" onConfirm={() => actions.remove(id)} disabled={busy || !canWrite} armed={armed} setArmed={setArmed} testId="drawer-delete">
              <TrashIcon className="h-3.5 w-3.5" />
            </ConfirmButton>
            <span className="ml-auto flex items-center gap-1">
              {tabBtn("overview", "Overview")}
              {tabBtn("accounts", "Accounts", detail?.session.accounts.length)}
              {tabBtn("jobs", "Jobs", detail?.jobs.total)}
              {tabBtn("history", "History", detail?.events.length)}
            </span>
          </div>
        ) : null}

        <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-3">
          {flash ? <p className={"mb-2 rounded-lg border px-2.5 py-1.5 text-[11.5px] " + (flash.tone === "ok" ? "border-launch/30 bg-launch/10 text-launch2" : "border-danger/40 bg-danger/10 text-red-300")}>{flash.text}</p> : null}
          {error ? (
            <div className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-red-300">
              Could not load the session: {error}
              <button type="button" onClick={() => void reload()} className={btnGhost + " ml-2"}>
                Retry
              </button>
            </div>
          ) : !detail ? (
            <p className="py-10 text-center text-[12px] text-faint">Loading…</p>
          ) : (
            <>
              {detail.partial.length ? <p className="mb-2 text-[11px] text-warn">Partly loaded — {detail.partial.join("; ")}</p> : null}
              {tab === "overview" ? <Overview s={detail.session} /> : null}
              {tab === "accounts" ? <AccountsList accounts={detail.session.accounts} restriction={detail.session.account_ids} /> : null}
              {tab === "jobs" ? (
                <div className="flex flex-col gap-2">
                  <p className="text-[11px] text-faint">
                    {detail.jobs.total} job{detail.jobs.total === 1 ? "" : "s"} ran through this session (newest 50 shown).
                  </p>
                  <JobsTable rows={jobs} showSession={false} canWrite={canJobsWrite} onChanged={overrideJob} onRefresh={() => void reload()} onFlash={(tone, text) => setFlash({ tone, text })} />
                </div>
              ) : null}
              {tab === "history" ? (
                detail.events.length === 0 ? (
                  <Empty>No history yet.</Empty>
                ) : (
                  <ol className="flex flex-col">
                    {detail.events.map((e) => {
                      const bad = e.kind === "check_failed" || e.kind === "expired";
                      return (
                        <li key={e.id} className="flex items-start gap-3 border-b border-line/60 py-2 last:border-b-0">
                          <ChevronRightIcon className={"mt-1 h-3 w-3 shrink-0 " + (bad ? "text-danger" : e.kind === "checked" ? "text-launch2" : "text-faint")} />
                          <div className="min-w-0 flex-1">
                            <p className={"text-[12px] leading-snug " + (bad ? "text-danger" : "text-ink")}>{describeSessionEvent(e)}</p>
                            <p className="text-[10.5px] text-faint">
                              {describeActor(e.actor)} · <span title={stampFull(e.ts)}>{stamp(e.ts)}</span> · {ago(e.ts)}
                            </p>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )
              ) : null}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
