"use client";

// The TOOL jobs table (the Jobs tab and the per-session drawer share it): one row per job with
// its status / stage / outcome, expandable into the step-by-step event log, Retry for error /
// unknown jobs and Cancel for queued / retry ones (TOOL's own rules, checked again server-side).

import { useState } from "react";
import { ChevronDownIcon, RetryIcon, XIcon } from "./icons";
import { Dot, Empty, btnDanger, btnGhost, chip, mono, stamp, stampFull } from "./tool-sessions-ui";
import { type JobDetail, toolCall } from "./use-tool-sessions";
import { type ToolJobEvent, type ToolJobView, jobCanCancel, jobCanRetry, jobStatusTone } from "@/lib/tool-sessions-model";

const LEVEL_TONE: Record<string, string> = { error: "text-danger", warn: "text-warn", warning: "text-warn", info: "text-dim", debug: "text-faint" };

function EventsLog({ events, error }: { events: ToolJobEvent[]; error: string | null }) {
  if (error) return <p className="text-[11px] text-danger">Could not read the log: {error}</p>;
  if (!events.length) return <p className="text-[11px] text-faint">No events yet.</p>;
  return (
    <ol className="flex flex-col gap-0.5">
      {events.map((e) => (
        <li key={e.id} className="grid grid-cols-[62px_92px_minmax(0,1fr)] gap-2 text-[11px] leading-snug">
          <span className={`${mono} text-faint`} title={stampFull(e.ts)}>
            {stamp(e.ts).slice(6)}
          </span>
          <span className={`${mono} truncate text-dim`}>{e.step}</span>
          <span className={LEVEL_TONE[e.level] ?? "text-ink"}>
            {e.message}
            {e.meta && Object.keys(e.meta).length ? <span className="ml-1 font-mono text-[10px] text-faint">{JSON.stringify(e.meta).slice(0, 160)}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

function JobRow({ job, showSession, sessionName, canWrite, onChanged, onRefresh, onFlash }: { job: ToolJobView; showSession: boolean; sessionName?: string; canWrite: boolean; onChanged: (job: ToolJobView) => void; onRefresh: () => void; onFlash: (tone: "ok" | "danger", text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showResult, setShowResult] = useState(false);

  const load = async () => {
    setLoading(true);
    const r = await toolCall<JobDetail>(`/api/tool-sessions/jobs/${job.id}`);
    setLoading(false);
    if (r.ok) {
      setDetail(r.data);
      onChanged(r.data.job);
    } else onFlash("danger", r.message);
  };
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !detail) void load();
  };
  const act = async (op: "retry" | "cancel") => {
    setBusy(true);
    const r = await toolCall<{ job: ToolJobView }>(`/api/tool-sessions/jobs/${job.id}`, { method: "POST", body: JSON.stringify({ op }) });
    setBusy(false);
    if (!r.ok) return onFlash("danger", r.message);
    onChanged(r.data.job);
    onFlash("ok", op === "retry" ? `Job #${job.id} queued again.` : `Job #${job.id} canceled.`);
    void load();
    // The owning list re-reads its rows so its "still moving" poll sees the new status — an
    // override alone would leave a retried job frozen at "queued" until a manual refresh.
    onRefresh();
  };

  const tone = jobStatusTone(job.status);
  const live = tone === "accent";
  return (
    <>
      <tr className={"border-t border-line/60 align-top transition-colors hover:bg-raise/40 " + (open ? "bg-raise/30" : "")} data-testid={`job-row-${job.id}`}>
        <td className="px-2 py-2">
          <button type="button" onClick={toggle} aria-expanded={open} className="flex items-center gap-1.5 text-left" title="Show the step log">
            <ChevronDownIcon className={`h-3.5 w-3.5 text-faint transition-transform ${open ? "rotate-180" : ""}`} />
            <span className={`${mono} text-[12px] text-ink`}>#{job.id}</span>
          </button>
        </td>
        <td className="px-2 py-2">
          <p className="text-[12px] text-ink">{job.kind || "—"}</p>
          <p className="text-[10.5px] text-faint">
            {job.mode}
            {job.client_request_id ? <span className={`${mono} ml-1`}>· {job.client_request_id.slice(0, 28)}</span> : null}
          </p>
        </td>
        {showSession ? (
          <td className="px-2 py-2 text-[12px] text-dim">{job.session_id ? <span title={`session #${job.session_id}`}>{sessionName ?? `#${job.session_id}`}</span> : "—"}</td>
        ) : null}
        <td className={`px-2 py-2 ${mono} text-[11.5px] text-dim`}>{job.account_id ?? "—"}</td>
        <td className="px-2 py-2">
          <span className={chip(tone)}>
            <Dot tone={tone} pulse={live} />
            {job.status}
          </span>
          {job.attempts > 1 ? <p className="mt-0.5 text-[10px] text-faint">{job.attempts} attempts</p> : null}
        </td>
        <td className={`px-2 py-2 ${mono} text-[11px] text-dim`}>{job.stage || "—"}</td>
        <td className="max-w-[360px] px-2 py-2">
          <p className={"break-words text-[11.5px] leading-snug " + (job.error ? "text-danger" : "text-dim")} title={job.error ?? job.summary}>
            {job.summary || "—"}
            {job.error_code ? <span className={`${mono} ml-1 text-[10px] text-faint`}>[{job.error_code}]</span> : null}
          </p>
        </td>
        <td className="whitespace-nowrap px-2 py-2 text-[11px] text-faint">
          <p title={stampFull(job.created_at)}>{stamp(job.created_at)}</p>
          {job.finished_at ? <p title={stampFull(job.finished_at)}>→ {stamp(job.finished_at).slice(6)}</p> : job.started_at ? <p>running…</p> : null}
        </td>
        <td className="whitespace-nowrap px-2 py-2">
          <div className="flex justify-end gap-1">
            {jobCanRetry(job.status) ? (
              <button type="button" onClick={() => void act("retry")} disabled={busy || !canWrite} className={btnGhost + " h-7 px-2"} title={canWrite ? "Run this job again (error / unknown only)" : "The API key lacks jobs:write"}>
                <RetryIcon className="h-3.5 w-3.5" /> Retry
              </button>
            ) : null}
            {jobCanCancel(job.status) ? (
              <button type="button" onClick={() => void act("cancel")} disabled={busy || !canWrite} className={btnDanger + " h-7 px-2"} title={canWrite ? "Cancel before the worker takes it (queued / retry only)" : "The API key lacks jobs:write"}>
                <XIcon className="h-3.5 w-3.5" /> Cancel
              </button>
            ) : null}
          </div>
        </td>
      </tr>
      {open ? (
        <tr className="bg-surface/70">
          <td colSpan={showSession ? 9 : 8} className="px-3 pb-3 pt-1">
            {loading && !detail ? (
              <p className="text-[11px] text-faint">Loading the step log…</p>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">Step log</span>
                  <button type="button" onClick={() => void load()} disabled={loading} className={btnGhost + " h-6 px-1.5 text-[10.5px]"}>
                    <RetryIcon className="h-3 w-3" /> Refresh
                  </button>
                  {detail?.job.result && Object.keys(detail.job.result).length ? (
                    <button type="button" onClick={() => setShowResult((v) => !v)} className={btnGhost + " h-6 px-1.5 text-[10.5px]"}>
                      {showResult ? "Hide result" : "Show result"}
                    </button>
                  ) : null}
                  {detail?.job.engine ? <span className="text-[10px] text-faint">engine {detail.job.engine} · priority {detail.job.priority}</span> : null}
                </div>
                {showResult && detail?.job.result ? <pre className="max-h-[220px] overflow-auto rounded-lg border border-line bg-surface2 p-2 font-mono text-[10.5px] leading-snug text-dim">{JSON.stringify(detail.job.result, null, 1)}</pre> : null}
                <EventsLog events={detail?.events ?? []} error={detail?.eventsError ?? null} />
              </div>
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function JobsTable({ rows, showSession = true, sessionNames, canWrite = true, onChanged, onRefresh, onFlash }: { rows: ToolJobView[]; showSession?: boolean; sessionNames?: Map<number, string>; /** jobs:write on the key — Retry / Cancel stay disabled without it. */ canWrite?: boolean; onChanged: (job: ToolJobView) => void; /** Re-read the owning list after a retry / cancel. */ onRefresh: () => void; onFlash: (tone: "ok" | "danger", text: string) => void }) {
  if (!rows.length) return <Empty>No jobs here yet.</Empty>;
  const head = "px-2 py-1.5 text-left text-[9.5px] font-semibold uppercase tracking-[0.16em] text-faint";
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className={"w-full border-collapse " + (showSession ? "min-w-[860px]" : "min-w-[720px]")}>
        <thead className="bg-surface2/70">
          <tr>
            <th className={head}>#</th>
            <th className={head}>Kind</th>
            {showSession ? <th className={head}>Session</th> : null}
            <th className={head}>Account</th>
            <th className={head}>Status</th>
            <th className={head}>Stage</th>
            <th className={head}>Result / error</th>
            <th className={head}>Created</th>
            <th className={head}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((j) => (
            <JobRow key={j.id} job={j} showSession={showSession} sessionName={j.session_id ? sessionNames?.get(j.session_id) : undefined} canWrite={canWrite} onChanged={onChanged} onRefresh={onRefresh} onFlash={onFlash} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
