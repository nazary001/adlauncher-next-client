"use client";

// Snapchat KEYS · REPORT page — the 500 partner keys (100 until 23.09) as one table: who holds each (registry),
// what its campaign SPENT on the picked São Paulo day (Snapchat's own stats: spend, impressions,
// swipes + where the campaign stands with delivery and ad review), what it EARNED over the same
// 24 hours (LION's report: revenue, forecast while the day is partial, ad impressions, eCPM,
// visitors, pixel events, conversions), the difference, and, for the owner, a Release button that
// deletes the registry row (Snapchat itself is never touched here — pause/delete the campaign in
// Ads Manager). The two sides load independently: either one failing leaves the other on screen.
// Today is partial + forecast; earlier days are final.
// The days are picked with components/date-range-picker.tsx — one day or a RANGE of São Paulo days
// (both sides are then asked for the whole range: LION summed per day, Snapchat as one window), and
// the pick lives in the URL (?range=last7 · ?from=…&to=…) so a link opens the same days.

import { useEffect, useMemo, useState } from "react";
import { Header } from "./header";
import { SnapNav } from "./snap-nav";
import { DateRangePicker } from "./date-range-picker";
import { useSnapKeys, type SnapKeyRow } from "./use-snap";
import { formatDay, formatRange, presetRange, rangeDays, rangeQuery, resolveSel, type RangeSel } from "@/lib/date-range";
import { SNAP_REPORT_FIRST_DAY, SNAP_REPORT_MAX_DAYS, snapDefaultReportDay, snapReportDate, type SnapDailyRow, type SnapReportMetrics } from "@/lib/snap-report";
import { snapDeliveryNote, snapMoney as money, type SnapCampaignStats, type SnapKeyLive } from "@/lib/snap-stats";
import { CheckIcon, ChevronLeftIcon, CopyIcon, RetryIcon } from "./icons";
import type { PartnerId } from "@/lib/partners";
import type { SessionUser } from "./user-menu";

type ReportRow = { key: string; metrics: SnapReportMetrics; binding: SnapKeyRow | null; revenueBeforeClaim?: number };
type Report = { from: string; to: string; partial: boolean; affiliate: string; totals: SnapReportMetrics; rows: ReportRow[]; daily: SnapDailyRow[]; missingDays: string[]; registryError?: string };
type Live = { from: string; to: string; totals: SnapCampaignStats & { complete: boolean }; keys: SnapKeyLive[]; errors: string[] };
type StatusFilter = "all" | "free" | "active" | "retired";

const int = (v: number) => Math.round(v).toLocaleString("en-US");
const pct = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v * 100).toLocaleString("en-US")}%`;
const plTone = (v: number) => (v > 0 ? "text-launch2" : v < 0 ? "text-danger" : "text-dim");
const NOTE_TONE = { ok: "text-launch2", warn: "text-warn", bad: "text-danger" } as const;
/** Our accounts are all "GC-HS-snapchat-LA-N" — the row only needs the tail. */
const accountLabel = (name: string) => name.replace(/^GC-HS-snapchat-/i, "");
/** A registry timestamp (ms) as its São Paulo day — the report day is a São Paulo day, so a claim
 *  at 23:30 there must not read as the next date beside the report label for a UTC+ viewer. */
const SAO_PAULO_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" });
const fmtDay = (ms: number) => formatDay(SAO_PAULO_DAY.format(new Date(ms)));
const isoDay = (v: unknown, fallback: string) => (typeof v === "string" && v ? v : fallback);
/** "Sep 14 – 20" — the range label without its year, for tight spots. */
const shortRange = (r: { from: string; to: string }) => formatRange(r).replace(/, \d{4}$/, "");

const HEAD = ["Key", "Status", "Campaign", "Buyer"] as const;
const HEAD_SNAP = ["Spend", "Impr.", "Swipes"] as const;
const HEAD_LION = ["Revenue", "P/L", "Ad impr.", "eCPM", "Visitors", "Trig/Fired", "Conv."] as const;
const COLUMNS = HEAD.length + HEAD_SNAP.length + HEAD_LION.length + 1;

const PICKER_BOUNDS = { min: SNAP_REPORT_FIRST_DAY, maxDays: SNAP_REPORT_MAX_DAYS } as const;

/** The picked range's LION revenue, a bar per day (the days are read one by one anyway, so this
 *  costs nothing). A click opens that day. Spend has no such strip: Snapchat cuts days at the ad
 *  account's own midnight (Los Angeles), which is not São Paulo's. */
function DailyStrip({ daily, onPick }: { daily: SnapDailyRow[]; onPick: (day: string) => void }) {
  const top = Math.max(0, ...daily.map((d) => d.revenue + d.forecastedRevenue));
  const px = (v: number) => (top > 0 && v > 0 ? Math.max(2, Math.round((v / top) * 44)) : 0);
  return (
    <div className="rounded-lg border border-line bg-surface px-3 pb-1.5 pt-2">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[10px] uppercase tracking-[0.14em] text-faint">Revenue by day · LION</p>
        <p className="text-[10px] text-faint">click a day to open it</p>
      </div>
      <div className="mt-1.5 flex items-end gap-0.5 overflow-x-auto">
        {daily.map((d) => (
          <button
            key={d.date}
            type="button"
            onClick={() => onPick(d.date)}
            title={
              d.missing
                ? `${formatDay(d.date, { weekday: true })} — LION didn't answer for this day`
                : `${formatDay(d.date, { weekday: true })} — revenue ${money(d.revenue)}${d.forecastedRevenue ? ` (+${money(d.forecastedRevenue)} forecast)` : ""} · ${int(d.visitors)} visitors · ${int(d.conversions)} conv.`
            }
            className="group flex min-w-[42px] max-w-[88px] flex-1 flex-col items-center rounded-md px-0.5 pb-1 pt-1 outline-none transition-colors hover:bg-raise/60 focus-visible:ring-2 focus-visible:ring-[#FFFC00]/60"
          >
            <span className={"font-mono text-[10px] tabular-nums " + (d.missing ? "text-warn" : "text-dim group-hover:text-ink")}>{d.missing ? "n/a" : money(d.revenue)}</span>
            <span className="mt-1 flex h-[46px] w-full max-w-[44px] flex-col justify-end border-b border-line2">
              {d.forecastedRevenue > 0 ? <span style={{ height: px(d.forecastedRevenue) }} className="w-full rounded-t-[3px] border border-b-0 border-dashed border-[#FFFC00]/50" /> : null}
              <span style={{ height: px(d.revenue) }} className={"w-full " + (d.forecastedRevenue > 0 ? "" : "rounded-t-[3px] ") + (d.partial ? "bg-[#FFFC00]/45" : "bg-[#FFFC00]/75") + " transition-colors group-hover:bg-[#FFFC00]"} />
            </span>
            <span className="mt-1 text-[9.5px] uppercase tracking-[0.08em] text-faint">{formatDay(d.date, { weekday: true }).slice(0, 3)}</span>
            <span className="font-mono text-[10px] tabular-nums text-dim">{formatDay(d.date, { year: false })}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

type Picked = { sel: RangeSel; includeToday: boolean };

export function SnapKeysBoard({ user, initialSel, initialIncludeToday = true }: { user?: SessionUser; initialSel?: RangeSel | null; initialIncludeToday?: boolean }) {
  const { keys, error: keysError, refresh: refreshKeys } = useSnapKeys();
  // Opens on the day that has the numbers (lib/snap-report.ts): the report day is a São Paulo day,
  // and a fixed "yesterday" used to open the page on the day BEFORE a same-day launch — all zeros.
  // A link that names its days (?range= / ?from=&to=) opens on those instead.
  const [picked, setPicked] = useState<Picked>(() => ({ sel: initialSel ?? { kind: "preset", id: snapDefaultReportDay() }, includeToday: initialIncludeToday }));
  /** The range a day of the daily strip was opened from — one click back. */
  const [backTo, setBackTo] = useState<Picked | null>(null);
  // Today in São Paulo — the picker's "today". Re-read every minute so an open page rolls over with the day.
  const [today, setToday] = useState(() => snapReportDate("today") ?? "");
  useEffect(() => {
    const tick = () => setToday((prev) => snapReportDate("today") ?? prev);
    const id = setInterval(tick, 60_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);
  const { sel, includeToday } = picked;
  const range = useMemo(() => resolveSel(sel, today, { includeToday, ...PICKER_BOUNDS }), [sel, includeToday, today]);
  // Today / Yesterday go to the server by NAME (it resolves them on its own clock — no race around
  // São Paulo's midnight); everything else goes as the days it is.
  const query = sel.kind === "preset" && (sel.id === "today" || sel.id === "yesterday") ? `date=${sel.id}` : range.from === range.to ? `from=${range.from}` : `from=${range.from}&to=${range.to}`;

  const pick = (next: Picked, from?: Picked) => {
    setPicked(next);
    setBackTo(from ?? null);
    // The pick lives in the URL: a reload or a shared link opens the same days.
    window.history.replaceState(null, "", `${window.location.pathname}?${rangeQuery(next.sel, next.includeToday)}`);
  };
  const [report, setReport] = useState<Report | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState<Live | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [liveLoading, setLiveLoading] = useState(true);
  // Bumped by a release / the Refresh button → the effects re-read the same day. A re-read is a new
  // effect run, so the request before it is cancelled exactly like on a date change — never a call
  // from a stale closure.
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
        const res = await fetch(`/api/snap/report?${query}`, { signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(60_000)]) });
        const d = (await res.json().catch(() => ({}))) as Partial<Report> & { ok?: boolean; error?: string };
        if (!res.ok || !d.ok || !Array.isArray(d.rows)) throw new Error(d.error || `HTTP ${res.status}`);
        if (!d.totals || typeof d.totals !== "object") throw new Error("malformed report");
        if (ctrl.signal.aborted) return;
        const missing = (d as { missingDays?: { date?: unknown }[] }).missingDays;
        setReport({
          from: isoDay(d.from, range.from),
          to: isoDay(d.to, range.to),
          partial: Boolean(d.partial),
          affiliate: String(d.affiliate ?? ""),
          totals: d.totals,
          rows: d.rows as ReportRow[],
          daily: Array.isArray(d.daily) ? d.daily : [],
          missingDays: Array.isArray(missing) ? missing.map((m) => String(m?.date ?? "")).filter(Boolean) : [],
          ...(d.registryError ? { registryError: String(d.registryError) } : {}),
        });
      } catch (e) {
        // Our own cancel (superseded / unmounted) is the AbortError to ignore; the 60 s TimeoutError is a real failure.
        if (ctrl.signal.aborted) return;
        setReportError(e instanceof DOMException && e.name === "TimeoutError" ? "LION didn't answer in 60 s" : e instanceof Error ? e.message : String(e));
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    })();
    return () => ctrl.abort();
    // `range` rides along so a page left open on "today" re-reads when São Paulo's day rolls over.
  }, [query, range.from, range.to, reportTick]);

  // The Snapchat side — same discipline, its own request: LION's money must not wait for (or fall
  // with) a dozen Marketing API reads, and the other way round.
  useEffect(() => {
    const ctrl = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLiveLoading(true);
    setLiveError(null);
    void (async () => {
      try {
        const res = await fetch(`/api/snap/stats?${query}`, { signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(60_000)]) });
        const d = (await res.json().catch(() => ({}))) as Partial<Live> & { ok?: boolean; error?: string };
        if (!res.ok || !d.ok || !Array.isArray(d.keys) || !d.totals) throw new Error(d.error || `HTTP ${res.status}`);
        if (ctrl.signal.aborted) return;
        setLive({ from: isoDay(d.from, range.from), to: isoDay(d.to, range.to), totals: d.totals, keys: d.keys, errors: Array.isArray(d.errors) ? d.errors.map(String) : [] });
      } catch (e) {
        if (ctrl.signal.aborted) return;
        setLiveError(e instanceof DOMException && e.name === "TimeoutError" ? "Snapchat didn't answer in 60 s" : e instanceof Error ? e.message : String(e));
      } finally {
        if (!ctrl.signal.aborted) setLiveLoading(false);
      }
    })();
    return () => ctrl.abort();
  }, [query, range.from, range.to, reportTick]);

  // Once the registry view has loaded it is the ONLY source of bindings — a just-released key must
  // not keep showing bound while the report reload is in flight or failed. The report's own binding
  // is only the fallback before the registry answers; the report brings the money either way.
  const bindingByKey = useMemo(() => new Map((keys?.used ?? []).map((r) => [r.key, r])), [keys]);
  const rows = useMemo(() => {
    const base: { key: string; metrics: SnapReportMetrics | null; binding: SnapKeyRow | null; revenueBeforeClaim?: number }[] = report?.rows ?? (keys ? keys.free.concat(keys.used.map((r) => r.key)).sort().map((key) => ({ key, metrics: null, binding: null })) : []);
    return base.map((r) => {
      const binding = keys ? (bindingByKey.get(r.key) ?? null) : (r.binding ?? null);
      // What the key earned in the range before its holder claimed it (an earlier campaign's money) —
      // only while the row is still about the claim the report counted it for.
      const before = r.revenueBeforeClaim && binding && binding.claimed_at === r.binding?.claimed_at ? r.revenueBeforeClaim : 0;
      return { key: r.key, metrics: r.metrics, binding, before };
    });
  }, [report, keys, bindingByKey]);
  // Snapchat numbers are shown only beside LION numbers of the SAME days: after a date change the two
  // answers land at different moments, and a row must never pair one day's spend with another's revenue.
  const liveNow = live && (!report || (live.from === report.from && live.to === report.to)) ? live : null;
  const liveByKey = useMemo(() => new Map((liveNow?.keys ?? []).map((k) => [k.key, k])), [liveNow]);
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

  // The money line of the day. Profit is on CONFIRMED revenue; while the day is partial the partner's
  // forecast is shown beside it, never folded in.
  const spend = liveNow ? liveNow.totals.spend : null;
  const profit = report && spend != null ? report.totals.revenue - spend : null;
  const pending = liveLoading ? "…" : "—";
  const tiles: { label: string; value: string; tone?: string; sub?: string; subTone?: string }[] = report
    ? [
        { label: "Spend · Snapchat", value: spend != null ? money(spend) : pending, ...(liveNow && !liveNow.totals.complete ? { sub: "some accounts unread", subTone: "text-warn" } : report.from !== report.to ? { sub: "campaigns bound now" } : {}) },
        { label: "Revenue · LION", value: money(report.totals.revenue) },
        { label: "Forecast", value: report.partial ? money(report.totals.forecastedRevenue) : "—" },
        {
          label: "Profit",
          value: profit != null ? money(profit) : pending,
          ...(profit != null ? { tone: plTone(profit) } : {}),
          ...(profit != null && report.partial && report.totals.forecastedRevenue ? { sub: `with forecast ${money(profit + report.totals.forecastedRevenue)}` } : {}),
        },
        { label: "ROI", value: profit != null && spend ? pct(profit / spend) : profit != null ? "—" : pending, ...(profit != null && spend ? { tone: plTone(profit) } : {}) },
        { label: "eCPM", value: money(report.totals.ecpm) },
        { label: "Snap impressions", value: liveNow ? int(liveNow.totals.impressions) : pending },
        { label: "Swipes", value: liveNow ? int(liveNow.totals.swipes) : pending },
        { label: "Visitors", value: int(report.totals.visitors) },
        { label: "Ad impressions", value: int(report.totals.impressions) },
        { label: "Pixel trig / fired", value: `${int(report.totals.triggered)} / ${int(report.totals.fired)}` },
        { label: "Conversions", value: int(report.totals.conversions) },
      ]
    : [];

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
              {backTo ? (
                <button type="button" onClick={() => pick(backTo)} className={chip + " " + off} title="Back to the range this day was opened from">
                  <ChevronLeftIcon className="mr-0.5 inline h-3 w-3" />
                  <span suppressHydrationWarning>{`Back to ${shortRange(resolveSel(backTo.sel, today, { includeToday: backTo.includeToday, ...PICKER_BOUNDS }))}`}</span>
                </button>
              ) : null}
              <div className="flex flex-wrap items-center gap-1 rounded-lg border border-line bg-surface p-0.5">
                {(["yesterday", "today"] as const).map((p) => {
                  const day = presetRange(p, today).from;
                  const active = range.from === day && range.to === day;
                  return (
                    <button key={p} type="button" onClick={() => pick({ sel: { kind: "preset", id: p }, includeToday })} aria-pressed={active} className={"h-7 whitespace-nowrap rounded-md px-2.5 text-[11.5px] font-medium " + (active ? "bg-[#FFFC00]/15 text-[#f3f0a3]" : "text-dim hover:text-ink")}>
                      {p === "today" ? "Today" : "Yesterday"}
                      {/* The date itself: "yesterday" is São Paulo's, which is not the viewer's for a good part of the day. */}
                      <span suppressHydrationWarning className="font-mono opacity-80">{` · ${formatDay(day, { year: false })}`}</span>
                      {p === "today" ? " (partial)" : ""}
                    </button>
                  );
                })}
                <DateRangePicker sel={sel} includeToday={includeToday} today={today} {...PICKER_BOUNDS} onChange={(nextSel, nextToday) => pick({ sel: nextSel, includeToday: nextToday })} note="Days are São Paulo days (UTC−3) — LION's day." hotkeys />
              </div>
              <button type="button" onClick={() => setReportTick((t) => t + 1)} disabled={loading || liveLoading} className={chip + " " + off + " disabled:opacity-50"}>
                <RetryIcon className="mr-1 inline h-3 w-3" />
                Refresh
              </button>
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
              {loading || liveLoading ? "Loading… " : ""}
              {reportError ? <span className="text-warn">{`Report: ${reportError}${report ? " · " : ""}`}</span> : null}
              {report ? `${formatRange(report)} · ${rangeDays(report) === 1 ? "São Paulo day" : `${rangeDays(report)} São Paulo days`} · ${report.partial ? (rangeDays(report) === 1 ? "partial — includes the partner's forecast" : "today is partial — its forecast is shown beside revenue") : "final"}` : ""}
              {report?.registryError ? ` · registry: ${report.registryError}` : ""}
            </span>
          </div>

          {report ? (
            <div className={"grid grid-cols-2 gap-2 transition-opacity sm:grid-cols-4 lg:grid-cols-6" + (loading ? " opacity-60" : "")}>
              {tiles.map((t) => (
                <div key={t.label} className="rounded-lg border border-line bg-surface px-3 py-2">
                  <p className="text-[10px] uppercase tracking-[0.14em] text-faint">{t.label}</p>
                  <p className={"font-mono text-[14px] tabular-nums " + (t.tone ?? "text-ink")}>{t.value}</p>
                  {t.sub ? <p className={"font-mono text-[10px] tabular-nums " + (t.subTone ?? "text-faint")}>{t.sub}</p> : null}
                </div>
              ))}
            </div>
          ) : null}

          {report && report.daily.length > 1 ? (
            <div className={"transition-opacity" + (loading ? " opacity-60" : "")}>
              <DailyStrip daily={report.daily} onPick={(day) => pick({ sel: { kind: "custom", from: day, to: day }, includeToday }, picked)} />
            </div>
          ) : null}

          {liveError || liveNow?.errors.length || report?.missingDays.length ? (
            <div className="rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-[11px] leading-relaxed text-warn">
              {report?.missingDays.length ? <p>{`LION didn't answer for ${report.missingDays.map((d) => formatDay(d, { year: false })).join(", ")} — revenue, P/L and ROI leave ${report.missingDays.length === 1 ? "that day" : "those days"} out while spend covers the whole range. Refresh asks again.`}</p> : null}
              {liveError ? <p>{`Snapchat stats unavailable — ${liveError}. Revenue below is unaffected.`}</p> : null}
              {liveNow?.errors.map((e) => <p key={e}>{`Snapchat · ${e}`}</p>)}
            </div>
          ) : null}

          <div className={"overflow-x-auto rounded-2xl border border-line bg-surface transition-opacity" + (loading ? " opacity-60" : "")}>
            <table className="w-full text-[12px]">
              <thead className="bg-surface2/50 text-[10px] uppercase tracking-[0.12em] text-faint">
                <tr>
                  <th colSpan={HEAD.length} />
                  <th colSpan={HEAD_SNAP.length} className="border-l border-line/60 px-3 pt-2 text-left font-semibold text-[#f3f0a3]/80">
                    Snapchat
                  </th>
                  <th colSpan={HEAD_LION.length} className="border-l border-line/60 px-3 pt-2 text-left font-semibold text-dim">
                    Partner · LION
                  </th>
                  <th />
                </tr>
                <tr>
                  {[...HEAD, ...HEAD_SNAP, ...HEAD_LION, ""].map((h, i) => (
                    <th key={h || "release"} className={"whitespace-nowrap py-2 text-left font-semibold " + (i === HEAD.length || i === HEAD.length + HEAD_SNAP.length ? "border-l border-line/60 pl-3 pr-2" : i > HEAD.length ? "px-2" : "px-3")}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const b = r.binding;
                  const m = r.metrics;
                  // The live row must be about the campaign the registry names NOW (a key released and re-claimed between the two reads).
                  const hit = b ? liveByKey.get(r.key) : undefined;
                  const l = hit && hit.campaignId === b?.campaign_id ? hit : null;
                  const note = l ? snapDeliveryNote(l) : null;
                  const s = l?.stats ?? null;
                  // A bound campaign whose numbers are still on the way reads "…"; one whose account could not be read reads "n/a".
                  const snapCell = (v: (st: SnapCampaignStats) => string) => (s ? v(s) : !b?.campaign_id ? "—" : l ? "n/a" : liveLoading ? "…" : "—");
                  const pl = s && m ? m.revenue - r.before - s.spend : null;
                  return (
                    <tr key={r.key} className="border-t border-line/60 hover:bg-raise/40">
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-[#f3f0a3]">{r.key}</td>
                      <td className="px-3 py-2">
                        <span className={"rounded px-1.5 py-[1px] text-[10px] font-semibold uppercase " + (!b ? "bg-surface2 text-faint" : b.status === "active" ? "bg-launch/15 text-launch2" : "bg-warn/15 text-warn")}>{b ? b.status : "free"}</span>
                      </td>
                      <td className="max-w-[300px] px-3 py-2">
                        {b ? (
                          <div className="min-w-0">
                            <p className="truncate text-ink" title={b.name || ""}>
                              {b.name || b.niche || "—"}
                            </p>
                            {note ? <p className={"truncate text-[10.5px] " + NOTE_TONE[note.tone]}>{note.text}</p> : null}
                            <p className="truncate font-mono text-[10px] text-faint">
                              {l?.adAccountName ? `${accountLabel(l.adAccountName)} · ` : ""}
                              {b.campaign_id ? `cmp ${b.campaign_id}` : "no campaign id"}
                              {b.notes ? ` · ${b.notes}` : ""}
                            </p>
                          </div>
                        ) : (
                          <span className="text-faint">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-dim">
                        {b?.user || "—"}
                        {b?.claimed_at ? <p className="font-mono text-[10px] text-faint" title="claimed (São Paulo date)">{fmtDay(b.claimed_at)}</p> : null}
                      </td>
                      <td className="border-l border-line/60 py-2 pl-3 pr-2 font-mono tabular-nums text-ink">{snapCell((st) => money(st.spend))}</td>
                      <td className="px-2 py-2 font-mono tabular-nums text-dim">{snapCell((st) => int(st.impressions))}</td>
                      <td className="px-2 py-2 font-mono tabular-nums text-dim">{snapCell((st) => int(st.swipes))}</td>
                      <td className="whitespace-nowrap border-l border-line/60 py-2 pl-3 pr-2 font-mono tabular-nums text-ink">
                        {m ? money(m.revenue) : "—"}
                        {m && report?.partial && m.forecastedRevenue ? <span className="text-faint" title="the partner's forecast for the rest of the day">{` +${money(m.forecastedRevenue)}`}</span> : null}
                      </td>
                      <td className={"whitespace-nowrap px-2 py-2 font-mono tabular-nums " + (pl != null ? plTone(pl) : "text-dim")} title={pl != null && r.before > 0 && b ? `Leaves out ${money(r.before)} this key earned before it was claimed on ${fmtDay(b.claimed_at)} — an earlier campaign's revenue, not this one's.` : undefined}>
                        {pl != null ? money(pl) : "—"}
                        {pl != null && r.before > 0 ? <span className="text-faint">*</span> : null}
                      </td>
                      <td className="px-2 py-2 font-mono tabular-nums text-dim">{m ? int(m.impressions) : "—"}</td>
                      <td className="px-2 py-2 font-mono tabular-nums text-dim">{m ? money(m.ecpm) : "—"}</td>
                      <td className="px-2 py-2 font-mono tabular-nums text-dim">{m ? int(m.visitors) : "—"}</td>
                      <td className="px-2 py-2 font-mono tabular-nums text-dim">{m ? `${int(m.triggered)}/${int(m.fired)}` : "—"}</td>
                      <td className="px-2 py-2 font-mono tabular-nums text-dim">{m ? int(m.conversions) : "—"}</td>
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
                    <td colSpan={COLUMNS} className="px-3 py-8 text-center text-[12px] text-faint">
                      {keysError ? `Registry unavailable — ${keysError}` : "Nothing to show"}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <p className="text-[10.5px] leading-relaxed text-faint">
            Both sides cover the same São Paulo days (UTC−3, LION&apos;s day) — one day or the whole picked range, up to {SNAP_REPORT_MAX_DAYS} days: spend, impressions and swipes come from Snapchat for the campaign bound to the key, revenue is reported per key by the partner through LION. Today is partial and carries the partner&apos;s forecast; a day is final the next morning, and Snapchat keeps settling its own numbers for a few hours. P/L is confirmed revenue minus spend. Spend is always what the campaigns bound to the keys NOW spent in those days — a campaign whose key was released since is not in it — so over a range a key claimed part-way leaves what it earned before that day out of its P/L (marked *). Over a range the eCPM is revenue per 1000 ad impressions of the whole range, and the campaign status and ad review always show how things stand now. Keys (by position, so any keyboard layout): [ and ] step through the days, D opens the calendar, T / Y inside it jump to today / yesterday. Release deletes the registry row only. A retired key still owns a campaign shell on Snapchat (PAUSED) — clean it in Ads Manager, then release.
          </p>
        </div>
      </main>
    </>
  );
}
