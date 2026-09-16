"use client";

// Snapchat KEYS · REPORT page — the 100 partner keys as one table: who holds each (registry),
// what it earned on the picked São Paulo day (LION's report: revenue, forecast while the day is
// partial, impressions, eCPM, visitors, pixel events, conversions) and, for the owner, a Release
// button that deletes the registry row (Snapchat itself is never touched here — pause/delete the
// campaign in Ads Manager). Today is partial + forecast; earlier days are final.

import { useEffect, useMemo, useState } from "react";
import { Header } from "./header";
import { SnapNav } from "./snap-nav";
import { useSnapKeys, type SnapKeyRow } from "./use-snap";
import type { SnapReportMetrics } from "@/lib/snap-report";
import { CheckIcon, CopyIcon } from "./icons";
import type { PartnerId } from "@/lib/partners";
import type { SessionUser } from "./user-menu";

type ReportRow = { key: string; metrics: SnapReportMetrics; binding: SnapKeyRow | null };
type Report = { date: string; partial: boolean; affiliate: string; totals: SnapReportMetrics; rows: ReportRow[]; registryError?: string };
type StatusFilter = "all" | "free" | "active" | "retired";

const money = (v: number) => `$${v.toFixed(2)}`;
const int = (v: number) => Math.round(v).toLocaleString("en-US");
const dateLabel = (iso: string) => iso.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$3.$2.$1");
/** A registry timestamp (ms) as dd.mm.yyyy in local time — the same shape as the report label. */
const fmtDay = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
};

export function SnapKeysBoard({ user }: { user?: SessionUser }) {
  const { keys, error: keysError, refresh: refreshKeys } = useSnapKeys();
  const [dateParam, setDateParam] = useState<"today" | "yesterday" | string>("yesterday");
  const [report, setReport] = useState<Report | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Bumped by a release → the effect re-reads the same day. A re-read is a new effect run, so the
  // request before it is cancelled exactly like on a date change — never a call from a stale closure.
  const [reportTick, setReportTick] = useState(0);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [releasing, setReleasing] = useState<string | null>(null);
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);

  // The report load lives IN the effect so every date change / re-read / unmount aborts the request
  // before it: no last-response-wins race, an abort touches no state, nothing lands on an unmounted
  // board. The previous day's numbers stay on screen (dimmed) until the new day answers.
  useEffect(() => {
    const ctrl = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setReportError(null);
    void (async () => {
      try {
        const res = await fetch(`/api/snap/report?date=${encodeURIComponent(dateParam)}`, { signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(60_000)]) });
        const d = (await res.json().catch(() => ({}))) as Partial<Report> & { ok?: boolean; error?: string };
        if (!res.ok || !d.ok || !Array.isArray(d.rows)) throw new Error(d.error || `HTTP ${res.status}`);
        if (!d.totals || typeof d.totals !== "object") throw new Error("malformed report");
        if (ctrl.signal.aborted) return;
        setReport({ date: String(d.date), partial: Boolean(d.partial), affiliate: String(d.affiliate ?? ""), totals: d.totals, rows: d.rows as ReportRow[], ...(d.registryError ? { registryError: String(d.registryError) } : {}) });
      } catch (e) {
        // Our own cancel (superseded / unmounted) is the AbortError to ignore; the 60 s TimeoutError is a real failure.
        if (ctrl.signal.aborted) return;
        setReportError(e instanceof DOMException && e.name === "TimeoutError" ? "LION didn't answer in 60 s" : e instanceof Error ? e.message : String(e));
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    })();
    return () => ctrl.abort();
  }, [dateParam, reportTick]);

  // Once the registry view has loaded it is the ONLY source of bindings — a just-released key must
  // not keep showing bound while the report reload is in flight or failed. The report's own binding
  // is only the fallback before the registry answers; the report brings the money either way.
  const bindingByKey = useMemo(() => new Map((keys?.used ?? []).map((r) => [r.key, r])), [keys]);
  const rows = useMemo(() => {
    const base = report?.rows ?? (keys ? keys.free.concat(keys.used.map((r) => r.key)).sort().map((key) => ({ key, metrics: null as SnapReportMetrics | null, binding: null })) : []);
    return base.map((r) => ({ key: r.key, metrics: r.metrics, binding: keys ? (bindingByKey.get(r.key) ?? null) : (r.binding ?? null) }));
  }, [report, keys, bindingByKey]);
  const shown = rows.filter((r) => (filter === "all" ? true : filter === "free" ? !r.binding : r.binding?.status === filter));
  const freeCount = rows.filter((r) => !r.binding).length;
  const activeCount = rows.filter((r) => r.binding?.status === "active").length;
  const retiredCount = rows.filter((r) => r.binding?.status === "retired").length;

  const release = async (key: string) => {
    if (!window.confirm(`Release ${key}? The registry row is deleted and the key returns to the pool. The Snapchat campaign is NOT touched — pause it in Ads Manager if it still runs.`)) return;
    setReleasing(key);
    try {
      const res = await fetch(`/api/snap/keys?key=${encodeURIComponent(key)}`, { method: "DELETE" });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !d.ok) throw new Error(d.error || `HTTP ${res.status}`);
      refreshKeys();
      setReportTick((t) => t + 1);
    } catch (e) {
      window.alert(`Release failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setReleasing(null);
    }
  };

  const copyFree = () => {
    const free = rows.filter((r) => !r.binding).map((r) => r.key).join("\n");
    const flash = (s: "ok" | "fail") => {
      setCopied(s);
      setTimeout(() => setCopied(null), 1400);
    };
    if (!navigator.clipboard) return flash("fail");
    void navigator.clipboard.writeText(free).then(() => flash("ok")).catch(() => flash("fail"));
  };

  const changePartner = (id: PartnerId) =>
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign(`/?partner=${id}`);

  const chip = "rounded-md border px-2 py-1 text-[11px] font-medium transition-colors";
  const on = "border-[#FFFC00]/50 bg-[#FFFC00]/10 text-[#f3f0a3]";
  const off = "border-line bg-surface2 text-dim hover:text-ink";

  return (
    <>
      <Header partner="in" onPartnerChange={changePartner} user={user} platform="snapchat" />
      <SnapNav active="keys" />
      <main className="flex-1">
        <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-4 px-4 pb-24 pt-6 sm:px-5 xl:px-6">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-sm font-semibold text-ink">Partner keys</h1>
            <span className="rounded-md border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[11px] text-dim">{keys ? `${freeCount} free · ${activeCount} active · ${retiredCount} retired` : keysError ? "registry unavailable" : "…"}</span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1 rounded-lg border border-line bg-surface p-0.5">
                {(["yesterday", "today"] as const).map((p) => (
                  <button key={p} type="button" onClick={() => setDateParam(p)} className={"h-7 rounded-md px-2.5 text-[11.5px] font-medium " + (dateParam === p ? "bg-[#FFFC00]/15 text-[#f3f0a3]" : "text-dim hover:text-ink")}>
                    {p === "today" ? "Today (partial)" : "Yesterday"}
                  </button>
                ))}
                <input type="date" value={/^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : ""} onChange={(e) => e.target.value && setDateParam(e.target.value)} aria-label="Report date" className="h-7 rounded-md border border-line bg-surface2 px-2 text-[11.5px] text-ink" />
              </div>
              <button type="button" onClick={copyFree} className={chip + " " + off}>
                {copied === "ok" ? <CheckIcon className="mr-1 inline h-3 w-3 text-launch2" /> : <CopyIcon className="mr-1 inline h-3 w-3" />}
                {copied === "ok" ? "Copied" : copied === "fail" ? "Copy failed" : "Copy free keys"}
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {(["all", "free", "active", "retired"] as StatusFilter[]).map((f) => (
              <button key={f} type="button" onClick={() => setFilter(f)} aria-pressed={filter === f} className={chip + " " + (filter === f ? on : off)}>
                {f[0].toUpperCase() + f.slice(1)}
              </button>
            ))}
            <span className="ml-auto text-[11px] text-faint">
              {loading ? "Loading… " : ""}
              {reportError ? <span className="text-warn">{`Report: ${reportError}${report ? " · " : ""}`}</span> : null}
              {report ? `${dateLabel(report.date)} · ${report.partial ? "partial day — includes the partner's forecast" : "final"} · LION` : ""}
              {report?.registryError ? ` · registry: ${report.registryError}` : ""}
            </span>
          </div>

          {report ? (
            <div className={"grid gap-2 transition-opacity sm:grid-cols-4 lg:grid-cols-8" + (loading ? " opacity-60" : "")}>
              {[
                ["Revenue", money(report.totals.revenue)],
                ["Forecast", report.partial ? money(report.totals.forecastedRevenue) : "—"],
                ["Impressions", int(report.totals.impressions)],
                ["eCPM", money(report.totals.ecpm)],
                ["Visitors", int(report.totals.visitors)],
                ["Triggered", int(report.totals.triggered)],
                ["Fired", int(report.totals.fired)],
                ["Conversions", int(report.totals.conversions)],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-line bg-surface px-3 py-2">
                  <p className="text-[10px] uppercase tracking-[0.14em] text-faint">{label}</p>
                  <p className="font-mono text-[14px] tabular-nums text-ink">{value}</p>
                </div>
              ))}
            </div>
          ) : null}

          <div className={"overflow-x-auto rounded-2xl border border-line bg-surface transition-opacity" + (loading ? " opacity-60" : "")}>
            <table className="w-full text-[12px]">
              <thead className="bg-surface2/50 text-[10px] uppercase tracking-[0.12em] text-faint">
                <tr>
                  {["Key", "Status", "Campaign", "Buyer", "Claimed", "Revenue", "Impr.", "eCPM", "Visitors", "Trig/Fired", "Conv.", ""].map((h) => (
                    <th key={h} className="px-3 py-2 text-left font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const b = r.binding;
                  const m = r.metrics;
                  return (
                    <tr key={r.key} className="border-t border-line/60 hover:bg-raise/40">
                      <td className="px-3 py-2 font-mono text-[#f3f0a3]">{r.key}</td>
                      <td className="px-3 py-2">
                        <span className={"rounded px-1.5 py-[1px] text-[10px] font-semibold uppercase " + (!b ? "bg-surface2 text-faint" : b.status === "active" ? "bg-launch/15 text-launch2" : "bg-warn/15 text-warn")}>{b ? b.status : "free"}</span>
                      </td>
                      <td className="max-w-[360px] px-3 py-2">
                        {b ? (
                          <div className="min-w-0">
                            <p className="truncate text-ink" title={b.name || ""}>
                              {b.name || b.niche || "—"}
                            </p>
                            <p className="truncate font-mono text-[10px] text-faint">
                              {b.campaign_id ? `cmp ${b.campaign_id}` : "no campaign id"}
                              {b.notes ? ` · ${b.notes}` : ""}
                            </p>
                          </div>
                        ) : (
                          <span className="text-faint">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-dim">{b?.user || "—"}</td>
                      <td className="px-3 py-2 font-mono text-[10.5px] text-faint">{b?.claimed_at ? fmtDay(b.claimed_at) : "—"}</td>
                      <td className="px-3 py-2 font-mono tabular-nums text-ink">
                        {m ? money(m.revenue) : "—"}
                        {m && report?.partial && m.forecastedRevenue ? <span className="text-faint"> / {money(m.forecastedRevenue)}</span> : null}
                      </td>
                      <td className="px-3 py-2 font-mono tabular-nums text-dim">{m ? int(m.impressions) : "—"}</td>
                      <td className="px-3 py-2 font-mono tabular-nums text-dim">{m ? money(m.ecpm) : "—"}</td>
                      <td className="px-3 py-2 font-mono tabular-nums text-dim">{m ? int(m.visitors) : "—"}</td>
                      <td className="px-3 py-2 font-mono tabular-nums text-dim">{m ? `${int(m.triggered)}/${int(m.fired)}` : "—"}</td>
                      <td className="px-3 py-2 font-mono tabular-nums text-dim">{m ? int(m.conversions) : "—"}</td>
                      <td className="px-3 py-2 text-right">
                        {b && user?.owner ? (
                          <button type="button" onClick={() => void release(r.key)} disabled={releasing === r.key} className="rounded-md border border-danger/30 px-2 py-1 text-[10.5px] font-medium text-danger transition-colors hover:bg-danger/10 disabled:opacity-50">
                            {releasing === r.key ? "Releasing…" : "Release"}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
                {shown.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="px-3 py-8 text-center text-[12px] text-faint">
                      {keysError ? `Registry unavailable — ${keysError}` : "Nothing to show"}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <p className="text-[10.5px] leading-relaxed text-faint">Release deletes the registry row only. A retired key still owns a campaign shell on Snapchat (PAUSED) — clean it in Ads Manager, then release. Revenue is reported per key by the partner through LION; today is partial and carries the partner&apos;s forecast, a day is final the next morning.</p>
        </div>
      </main>
    </>
  );
}
