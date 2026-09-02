"use client";

// Owner console: Auto landings (MO / MK Learn). Compose a batch of article HEADLINES, pick
// "generate now" or a smart schedule (specific weekdays × times, Kyiv wall clock), and the
// gc-gemini-generator worker turns each into a full compliant guide landing on
// finance.magicoffers.shop — banners, gate funnel, interlink ring, hero image, the lot.
// Published slugs surface in the MO landing picker automatically (~1 min), no code change.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Header } from "./header";
import type { SessionUser } from "./user-menu";
import {
  AlertIcon,
  CheckIcon,
  PlusIcon,
  RetryIcon,
  SparklesIcon,
  TimerIcon,
  TrashIcon,
  XIcon,
} from "./icons";
import type { PartnerId } from "@/lib/partners";
import type { AutoLandingJob } from "@/lib/auto-landings";
import {
  MAX_BATCH,
  SCHEDULE_TZ,
  type DraftItem,
  type LandingLang,
  type ScheduleSpec,
  computeScheduleSlots,
  dayInTz,
  normalizeDraftItems,
} from "@/lib/auto-landings-plan";

const LANDING_BASE = "https://finance.magicoffers.shop/guides";

const NICHE_HINTS = [
  "Auto",
  "Health",
  "Travel",
  "Jobs",
  "Loans",
  "Self-Discovery",
  "Home",
  "Beauty",
  "Side Gigs",
  "Auctions",
  "MK Digital",
  "Cars",
  "Streaming",
  "Dental",
];

const TIME_PRESETS = ["09:00", "12:00", "15:00", "18:00", "21:00"];
// Intl weekday order Mon-first for the chips; values are JS 0=Sun..6=Sat.
const WEEKDAYS: { v: number; label: string }[] = [
  { v: 1, label: "Mon" },
  { v: 2, label: "Tue" },
  { v: 3, label: "Wed" },
  { v: 4, label: "Thu" },
  { v: 5, label: "Fri" },
  { v: 6, label: "Sat" },
  { v: 0, label: "Sun" },
];

type ComposeRow = { key: string; title: string; lang: LandingLang; niche: string };

let rowSeq = 0;
const freshRow = (title = "", lang: LandingLang = "en", niche = ""): ComposeRow => ({
  key: `r${++rowSeq}`,
  title,
  lang,
  niche,
});

// ---- time formatting (everything renders on the Kyiv wall clock, like the scheduler) ---------

function fmtKyiv(ms: number): string {
  if (!ms) return "—";
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-GB", {
    timeZone: SCHEDULE_TZ,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(ms)) {
    parts[p.type] = p.value;
  }
  return `${parts.day}.${parts.month} ${parts.hour}:${parts.minute}`;
}

function countdown(ms: number, now: number): string {
  const d = ms - now;
  if (d <= 30_000) return "due now";
  const min = Math.round(d / 60_000);
  if (min < 60) return `in ${min}m`;
  const h = Math.floor(min / 60);
  if (h < 48) return `in ${h}h ${min % 60}m`;
  return `in ${Math.round(h / 24)}d`;
}

// ---- tiny UI atoms ---------------------------------------------------------------------------

const STATUS_META: Record<
  AutoLandingJob["status"],
  { label: string; cls: string; dot: string }
> = {
  scheduled: { label: "Scheduled", cls: "border-accent/40 bg-accent/10 text-[#9db8ff]", dot: "bg-accent" },
  generating: { label: "Generating", cls: "border-warn/40 bg-warn/10 text-warn", dot: "bg-warn animate-pulse" },
  published: { label: "Published", cls: "border-launch/40 bg-launch/10 text-launch2", dot: "bg-launch" },
  failed: { label: "Failed", cls: "border-danger/40 bg-danger/10 text-danger", dot: "bg-danger" },
  canceled: { label: "Canceled", cls: "border-line bg-surface2 text-faint", dot: "bg-faint" },
};

function StatusChip({ status }: { status: AutoLandingJob["status"] }) {
  const m = STATUS_META[status];
  return (
    <span
      className={`inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-full border px-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] ${m.cls}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${m.dot}`} />
      {m.label}
    </span>
  );
}

function LangToggle({ value, onChange }: { value: LandingLang; onChange: (l: LandingLang) => void }) {
  return (
    <div className="flex h-8 shrink-0 overflow-hidden rounded-lg border border-line">
      {(["en", "es"] as const).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => onChange(l)}
          className={
            "px-2 text-[11px] font-semibold uppercase transition-colors " +
            (value === l ? "bg-accent/20 text-[#9db8ff]" : "bg-surface2 text-faint hover:text-dim")
          }
        >
          {l}
        </button>
      ))}
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[9.5px] font-semibold uppercase tracking-[0.16em] text-faint select-none">
      {children}
    </span>
  );
}

const inputCls =
  "h-8 rounded-lg border border-line bg-surface2 px-2.5 text-[12.5px] text-ink placeholder:text-faint outline-none transition-colors focus:border-accent/60";

// ---- reschedule popover ----------------------------------------------------------------------

function ReschedulePopover({
  initialMs,
  onApply,
  onClose,
}: {
  initialMs: number;
  onApply: (ms: number) => void;
  onClose: () => void;
}) {
  const [day, setDay] = useState(() => dayInTz(Math.max(initialMs, Date.now())));
  const [time, setTime] = useState("09:00");
  const boxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const ms = useMemo(() => {
    const slots = computeScheduleSlots(1, { mode: "spread", startDay: day, days: [], times: [time] }, 0);
    return slots?.[0] ?? NaN;
  }, [day, time]);

  return (
    <div
      ref={boxRef}
      className="absolute right-0 top-full z-50 mt-2 w-[248px] animate-pop-in rounded-2xl border border-line bg-surface p-3 shadow-[0_18px_50px_rgba(0,0,0,0.5)]"
    >
      <p className="pb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">
        Reschedule · Kyiv time
      </p>
      <div className="flex gap-2">
        <input type="date" value={day} onChange={(e) => setDay(e.target.value)} className={`${inputCls} flex-1`} />
        <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={`${inputCls} w-[92px]`} />
      </div>
      <button
        type="button"
        disabled={!Number.isFinite(ms) || ms < Date.now() - 60_000}
        onClick={() => Number.isFinite(ms) && onApply(ms)}
        className="mt-2.5 h-8 w-full rounded-lg border border-accent/50 bg-accent/15 text-[12px] font-semibold text-[#9db8ff] transition-colors hover:bg-accent/25 disabled:opacity-40"
      >
        Set time
      </button>
    </div>
  );
}

// ---- delete confirm popover ------------------------------------------------------------------

function DeletePopover({
  job,
  onConfirm,
  onClose,
}: {
  job: AutoLandingJob;
  onConfirm: (withLanding: boolean) => void;
  onClose: () => void;
}) {
  const [withLanding, setWithLanding] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const published = job.status === "published" && Boolean(job.slug);
  return (
    <div
      ref={boxRef}
      className="absolute right-0 top-full z-50 mt-2 w-[268px] animate-pop-in rounded-2xl border border-line bg-surface p-3 shadow-[0_18px_50px_rgba(0,0,0,0.5)]"
    >
      <p className="pb-1.5 text-[12.5px] font-semibold text-ink">Delete this row?</p>
      <p className="text-[11px] leading-snug text-faint">
        Removes the queue entry from this list{published ? " — the live page stays up" : ""}.
      </p>
      {published ? (
        <label className="mt-2.5 flex cursor-pointer items-start gap-2 rounded-lg border border-danger/30 bg-danger/5 p-2">
          <input
            type="checkbox"
            checked={withLanding}
            onChange={(e) => setWithLanding(e.target.checked)}
            className="mt-0.5 accent-[#f87171]"
          />
          <span className="text-[11px] leading-snug text-dim">
            <span className="font-semibold text-danger">Also unpublish the page.</span> The live URL
            starts returning 404 — any campaign still pointing at it burns spend on a dead link.
          </span>
        </label>
      ) : null}
      <div className="mt-2.5 flex gap-2">
        <button
          type="button"
          onClick={onClose}
          className="h-8 flex-1 rounded-lg border border-line bg-surface2 text-[12px] font-medium text-dim transition-colors hover:text-ink"
        >
          Keep
        </button>
        <button
          type="button"
          onClick={() => onConfirm(withLanding)}
          className="h-8 flex-1 rounded-lg border border-danger/50 bg-danger/15 text-[12px] font-semibold text-danger transition-colors hover:bg-danger/25"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

// ---- the board -------------------------------------------------------------------------------

export function AutoLandingsBoard({ user }: { user: SessionUser }) {
  // The header's partner switcher navigates back to the launcher on the picked rail — this
  // console is MO-only, so "switching partner" here means "go launch there".
  const goPartner = (id: PartnerId) => {
    window.location.href = `/?partner=${id}`;
  };

  // ---- queue data ----------------------------------------------------------------------------
  const [jobs, setJobs] = useState<AutoLandingJob[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/auto-landings");
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; jobs?: AutoLandingJob[]; error?: string };
      if (r.ok && d.ok && Array.isArray(d.jobs)) {
        setJobs(d.jobs);
        setLoadError(null);
        setRefreshedAt(Date.now());
      } else {
        setLoadError(d.error || `HTTP ${r.status}`);
      }
    } catch {
      setLoadError("network");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live poll while anything is pending: scheduled jobs count down, generating ones resolve.
  const hasActive = useMemo(
    () => (jobs ?? []).some((j) => j.status === "scheduled" || j.status === "generating"),
    [jobs],
  );
  useEffect(() => {
    if (!hasActive) return;
    const t = setInterval(() => void refresh(), 20_000);
    return () => clearInterval(t);
  }, [hasActive, refresh]);

  // 30s "now" tick keeps countdowns honest without re-fetching.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // ---- compose state -------------------------------------------------------------------------
  const [rows, setRows] = useState<ComposeRow[]>([freshRow()]);
  const [batchNotes, setBatchNotes] = useState("");
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");

  const patchRow = (key: string, patch: Partial<ComposeRow>) =>
    setRows((cur) => cur.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const removeRow = (key: string) => setRows((cur) => (cur.length > 1 ? cur.filter((r) => r.key !== key) : cur));
  const addRow = () => setRows((cur) => (cur.length < MAX_BATCH ? [...cur, freshRow("", cur[cur.length - 1]?.lang ?? "en", cur[cur.length - 1]?.niche ?? "")] : cur));

  const importBulk = () => {
    const lines = bulkText
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*[-•*\d.)]+\s*/, "").trim())
      .filter(Boolean);
    if (lines.length === 0) return;
    setRows((cur) => {
      const keep = cur.filter((r) => r.title.trim());
      const lang = keep[keep.length - 1]?.lang ?? "en";
      const niche = keep[keep.length - 1]?.niche ?? "";
      return [...keep, ...lines.map((t) => freshRow(t, lang, niche))].slice(0, MAX_BATCH);
    });
    setBulkText("");
    setBulkOpen(false);
  };

  // ---- schedule state ------------------------------------------------------------------------
  const [mode, setMode] = useState<"now" | "at" | "spread">("now");
  const [atDay, setAtDay] = useState(() => dayInTz(Date.now()));
  const [atTime, setAtTime] = useState("09:00");
  const [spreadStart, setSpreadStart] = useState(() => dayInTz(Date.now()));
  const [spreadDays, setSpreadDays] = useState<number[]>([]);
  const [spreadTimes, setSpreadTimes] = useState<string[]>(["09:00", "15:00"]);
  const [newTime, setNewTime] = useState("");

  const toggleDay = (v: number) =>
    setSpreadDays((cur) => (cur.includes(v) ? cur.filter((d) => d !== v) : [...cur, v]));
  const addTime = (t: string) => {
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(t)) return;
    setSpreadTimes((cur) => (cur.includes(t) ? cur : [...cur, t].sort()));
    setNewTime("");
  };

  const draftItems: DraftItem[] = useMemo(
    () =>
      rows
        .filter((r) => r.title.trim())
        .map((r) => ({
          title: r.title,
          lang: r.lang,
          niche: r.niche.trim() || "Auto",
          ...(batchNotes.trim() ? { notes: batchNotes.trim() } : {}),
        })),
    [rows, batchNotes],
  );

  const spec: ScheduleSpec | null = useMemo(() => {
    if (mode === "now") return { mode: "now" };
    if (mode === "at") {
      const slots = computeScheduleSlots(1, { mode: "spread", startDay: atDay, days: [], times: [atTime] }, 0);
      return slots ? { mode: "at", at: slots[0] } : null;
    }
    return { mode: "spread", startDay: spreadStart, days: spreadDays, times: spreadTimes };
  }, [mode, atDay, atTime, spreadStart, spreadDays, spreadTimes]);

  const previewSlots = useMemo(() => {
    if (!spec || draftItems.length === 0) return null;
    return computeScheduleSlots(draftItems.length, spec, now);
  }, [spec, draftItems.length, now]);

  const validation = useMemo(() => normalizeDraftItems(draftItems), [draftItems]);

  // ---- submit --------------------------------------------------------------------------------
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitOkAt, setSubmitOkAt] = useState(0);

  const canSubmit =
    !submitting && draftItems.length > 0 && validation.ok && spec !== null && previewSlots !== null;

  async function submit() {
    if (!canSubmit || !spec) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const r = await fetch("/api/auto-landings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: draftItems, schedule: spec }),
      });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; createdCount?: number };
      if (!r.ok || !d.ok) {
        const partial = typeof d.createdCount === "number" && d.createdCount > 0 ? ` (${d.createdCount} queued before the failure)` : "";
        throw new Error((d.error || `HTTP ${r.status}`) + partial);
      }
      setRows([freshRow()]);
      setBatchNotes("");
      setSubmitOkAt(Date.now());
      void refresh();
    } catch (e) {
      setSubmitError(String((e as Error).message ?? e));
    } finally {
      setSubmitting(false);
    }
  }

  useEffect(() => {
    if (!submitOkAt) return;
    const t = setTimeout(() => setSubmitOkAt(0), 3000);
    return () => clearTimeout(t);
  }, [submitOkAt]);

  // ---- row actions ---------------------------------------------------------------------------
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [reschedFor, setReschedFor] = useState<string | null>(null);
  const [deleteFor, setDeleteFor] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const withBusy = useCallback(
    async (id: string, run: () => Promise<Response>) => {
      setActionError(null);
      setBusyIds((cur) => new Set(cur).add(id));
      try {
        const r = await run();
        const d = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
        await refresh();
      } catch (e) {
        setActionError(String((e as Error).message ?? e));
      } finally {
        setBusyIds((cur) => {
          const next = new Set(cur);
          next.delete(id);
          return next;
        });
      }
    },
    [refresh],
  );

  const act = (id: string, action: string, extra: Record<string, unknown> = {}) =>
    withBusy(id, () =>
      fetch(`/api/auto-landings/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      }),
    );
  const del = (id: string, withLanding: boolean) =>
    withBusy(id, () =>
      fetch(`/api/auto-landings/${id}${withLanding ? "?landing=1" : ""}`, { method: "DELETE" }),
    );

  // ---- queue filtering -----------------------------------------------------------------------
  const [filter, setFilter] = useState<"all" | AutoLandingJob["status"]>("all");
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: jobs?.length ?? 0 };
    for (const j of jobs ?? []) c[j.status] = (c[j.status] ?? 0) + 1;
    return c;
  }, [jobs]);
  const shown = useMemo(
    () => (jobs ?? []).filter((j) => filter === "all" || j.status === filter),
    [jobs, filter],
  );

  const publishedCount = counts.published ?? 0;

  return (
    <>
      <Header partner="in" onPartnerChange={goPartner} user={user} />
      <main className="flex-1">
        <div className="mx-auto grid w-full max-w-[1440px] items-start gap-6 px-4 pb-28 pt-6 sm:px-6 lg:grid-cols-[300px_minmax(0,1fr)]">
          {/* ---- left: intro + compliance ---- */}
          <section className="flex flex-col gap-4 lg:sticky lg:top-[88px] lg:max-h-[calc(100vh-112px)] lg:overflow-y-auto">
            <div className="flex shrink-0 flex-col gap-1.5">
              <Link href="/" className="w-fit text-[11px] font-medium text-faint transition-colors hover:text-[#9db8ff]">
                ← Back to launcher
              </Link>
              <h1 className="flex items-center gap-2 text-[19px] font-semibold tracking-tight text-ink">
                <SparklesIcon className="h-4.5 w-4.5 text-[#9db8ff]" />
                Auto landings
              </h1>
              <p className="text-[11.5px] leading-relaxed text-faint">
                Type headlines — the AI writer publishes full MK Learn guide articles for the MO
                partner: both MagicAds banner slots, the entry gate, the interlink ring, an
                AI hero image, FAQ and compliance notes. Generate now or put them on a timer.
              </p>
            </div>

            <div className="flex flex-col gap-2.5 rounded-2xl border border-line bg-surface/60 p-3.5">
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">How it works</p>
              {[
                "Each headline becomes one queue job below.",
                "The generator picks jobs up every minute once due; writing one page takes ~1–3 min.",
                `The page goes live at ${LANDING_BASE.replace("https://", "")}/<slug>.`,
                "It appears in the MO landing picker automatically — gcm claims on launch as usual.",
              ].map((t, i) => (
                <p key={i} className="flex items-start gap-2 text-[11.5px] leading-snug text-dim">
                  <span className="mt-px grid h-4.5 w-4.5 shrink-0 place-items-center rounded-full bg-accent/15 font-mono text-[9.5px] font-semibold text-[#9db8ff]">
                    {i + 1}
                  </span>
                  {t}
                </p>
              ))}
            </div>

            <div className="flex flex-col gap-2 rounded-2xl border border-line bg-surface/60 p-3.5">
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">
                Compliance guard · FB & TikTok
              </p>
              {[
                "Brand-neutral: no company, program or government names",
                "No income / result promises — public medians with “varies” only",
                "No personal-attribute callouts, no urgency or scarcity",
                "Health & finance framed as education, never advice; disclaimers on-page",
                "Balanced sections: benefits AND considerations",
                "Hero image: no text, no logos, no body imagery",
              ].map((t) => (
                <p key={t} className="flex items-start gap-2 text-[11px] leading-snug text-dim">
                  <CheckIcon className="mt-0.5 h-3 w-3 shrink-0 text-launch2" />
                  {t}
                </p>
              ))}
              <p className="mt-1 text-[10.5px] leading-snug text-faint">
                Baked into the writer prompt — every generated page follows the same template as the
                hand-built guides.
              </p>
            </div>

            {publishedCount > 0 ? (
              <div className="rounded-2xl border border-launch/25 bg-launch/5 p-3.5">
                <p className="text-[11.5px] font-medium text-launch2">
                  {publishedCount} auto landing{publishedCount === 1 ? "" : "s"} live
                </p>
                <p className="mt-1 text-[10.5px] leading-snug text-faint">
                  Find them in the MO landing picker under “Auto · …” sections.
                </p>
              </div>
            ) : null}
          </section>

          {/* ---- right: compose + schedule + queue ---- */}
          <section className="flex min-w-0 flex-col gap-5">
            {/* Compose */}
            <div className="rounded-2xl border border-line bg-surface/60">
              <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">
                  1 · Article headlines
                </p>
                <button
                  type="button"
                  onClick={() => setBulkOpen((v) => !v)}
                  className={
                    "h-7 rounded-lg border px-2.5 text-[11.5px] font-medium transition-colors " +
                    (bulkOpen
                      ? "border-accent/50 bg-accent/15 text-[#9db8ff]"
                      : "border-line bg-surface2 text-dim hover:text-[#9db8ff]")
                  }
                >
                  Paste many
                </button>
              </div>
              <div className="flex flex-col gap-2 p-4">
                {bulkOpen ? (
                  <div className="flex flex-col gap-2 rounded-xl border border-dashed border-line2 bg-surface2/40 p-3">
                    <FieldLabel>One headline per line — bullets and numbering are stripped</FieldLabel>
                    <textarea
                      value={bulkText}
                      onChange={(e) => setBulkText(e.target.value)}
                      rows={5}
                      placeholder={"What Hotel Staff Never Tell Guests\nThe Secret Code in Your Boarding Pass\n…"}
                      className="rounded-lg border border-line bg-surface2 p-2.5 text-[12.5px] leading-relaxed text-ink placeholder:text-faint outline-none focus:border-accent/60"
                    />
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setBulkOpen(false)}
                        className="h-7 rounded-lg border border-line bg-surface2 px-2.5 text-[11.5px] text-dim hover:text-ink"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={importBulk}
                        className="h-7 rounded-lg border border-accent/50 bg-accent/15 px-2.5 text-[11.5px] font-semibold text-[#9db8ff] hover:bg-accent/25"
                      >
                        Add lines
                      </button>
                    </div>
                  </div>
                ) : null}

                {rows.map((r, i) => (
                  <div key={r.key} className="flex items-center gap-2">
                    <span className="w-6 shrink-0 text-right font-mono text-[10.5px] text-faint">{i + 1}</span>
                    <input
                      value={r.title}
                      onChange={(e) => patchRow(r.key, { title: e.target.value })}
                      placeholder="Article headline (what the H1 leads with)"
                      className={`${inputCls} min-w-0 flex-1`}
                    />
                    <LangToggle value={r.lang} onChange={(lang) => patchRow(r.key, { lang })} />
                    <input
                      value={r.niche}
                      onChange={(e) => patchRow(r.key, { niche: e.target.value })}
                      placeholder="Niche"
                      list="auto-landing-niches"
                      className={`${inputCls} w-[110px] shrink-0`}
                    />
                    <button
                      type="button"
                      onClick={() => removeRow(r.key)}
                      disabled={rows.length === 1}
                      aria-label="Remove row"
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line bg-surface2 text-faint transition-colors hover:text-danger disabled:opacity-30"
                    >
                      <XIcon className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
                <datalist id="auto-landing-niches">
                  {NICHE_HINTS.map((n) => (
                    <option key={n} value={n} />
                  ))}
                </datalist>

                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    onClick={addRow}
                    disabled={rows.length >= MAX_BATCH}
                    className="flex h-7 items-center gap-1.5 rounded-lg border border-line bg-surface2 px-2.5 text-[11.5px] font-medium text-dim transition-colors hover:text-[#9db8ff] disabled:opacity-40"
                  >
                    <PlusIcon className="h-3.5 w-3.5" />
                    Add headline
                  </button>
                  <span className="text-[10.5px] text-faint">
                    {draftItems.length}/{MAX_BATCH}
                  </span>
                </div>

                <div className="mt-1 flex flex-col gap-1.5">
                  <FieldLabel>Guidance for the writer · optional, applies to this batch</FieldLabel>
                  <textarea
                    value={batchNotes}
                    onChange={(e) => setBatchNotes(e.target.value)}
                    rows={2}
                    maxLength={600}
                    placeholder="e.g. angle it at people 45+, mention seasonal timing, keep examples US-based…"
                    className="rounded-lg border border-line bg-surface2 p-2.5 text-[12px] leading-relaxed text-ink placeholder:text-faint outline-none focus:border-accent/60"
                  />
                </div>
              </div>
            </div>

            {/* Schedule */}
            <div className="rounded-2xl border border-line bg-surface/60">
              <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">2 · When</p>
                <span className="text-[10.5px] text-faint">Kyiv time · {SCHEDULE_TZ}</span>
              </div>
              <div className="flex flex-col gap-3 p-4">
                <div className="flex w-fit overflow-hidden rounded-xl border border-line">
                  {(
                    [
                      ["now", "Generate now"],
                      ["at", "One moment"],
                      ["spread", "Spread over days"],
                    ] as const
                  ).map(([m, label]) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setMode(m)}
                      className={
                        "flex h-9 items-center gap-1.5 px-3.5 text-[12px] font-medium transition-colors " +
                        (mode === m ? "bg-accent/20 text-[#9db8ff]" : "bg-surface2 text-faint hover:text-dim")
                      }
                    >
                      {m === "now" ? <SparklesIcon className="h-3.5 w-3.5" /> : <TimerIcon className="h-3.5 w-3.5" />}
                      {label}
                    </button>
                  ))}
                </div>

                {mode === "now" ? (
                  <p className="text-[11.5px] leading-snug text-dim">
                    Every headline queues immediately — the worker picks them up within a minute and
                    publishes one after another.
                  </p>
                ) : null}

                {mode === "at" ? (
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="flex flex-col gap-1.5">
                      <FieldLabel>Date</FieldLabel>
                      <input type="date" value={atDay} onChange={(e) => setAtDay(e.target.value)} className={inputCls} />
                    </label>
                    <label className="flex flex-col gap-1.5">
                      <FieldLabel>Time</FieldLabel>
                      <input type="time" value={atTime} onChange={(e) => setAtTime(e.target.value)} className={inputCls} />
                    </label>
                    <p className="pb-1.5 text-[11px] text-faint">all headlines fire at this moment</p>
                  </div>
                ) : null}

                {mode === "spread" ? (
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-end gap-4">
                      <label className="flex flex-col gap-1.5">
                        <FieldLabel>Start from</FieldLabel>
                        <input
                          type="date"
                          value={spreadStart}
                          onChange={(e) => setSpreadStart(e.target.value)}
                          className={inputCls}
                        />
                      </label>
                      <div className="flex flex-col gap-1.5">
                        <FieldLabel>Days · none picked = every day</FieldLabel>
                        <div className="flex gap-1">
                          {WEEKDAYS.map((d) => (
                            <button
                              key={d.v}
                              type="button"
                              onClick={() => toggleDay(d.v)}
                              className={
                                "h-8 rounded-lg border px-2 text-[11px] font-semibold transition-colors " +
                                (spreadDays.includes(d.v)
                                  ? "border-accent/50 bg-accent/20 text-[#9db8ff]"
                                  : "border-line bg-surface2 text-faint hover:text-dim")
                              }
                            >
                              {d.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <FieldLabel>Time slots per day — one article per slot, in headline order</FieldLabel>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {spreadTimes.map((t) => (
                          <span
                            key={t}
                            className="flex h-8 items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 pl-2.5 pr-1.5 font-mono text-[12px] text-[#9db8ff]"
                          >
                            {t}
                            <button
                              type="button"
                              onClick={() => setSpreadTimes((cur) => cur.filter((x) => x !== t))}
                              aria-label={`Remove ${t}`}
                              className="grid h-5 w-5 place-items-center rounded-md text-faint hover:text-danger"
                            >
                              <XIcon className="h-3 w-3" />
                            </button>
                          </span>
                        ))}
                        <input
                          type="time"
                          value={newTime}
                          onChange={(e) => e.target.value && addTime(e.target.value)}
                          className={`${inputCls} w-[92px]`}
                        />
                        {TIME_PRESETS.filter((t) => !spreadTimes.includes(t)).map((t) => (
                          <button
                            key={t}
                            type="button"
                            onClick={() => addTime(t)}
                            className="h-7 rounded-lg border border-dashed border-line2 px-2 font-mono text-[11px] text-faint transition-colors hover:border-accent/40 hover:text-[#9db8ff]"
                          >
                            +{t}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : null}

                {/* live plan preview */}
                {draftItems.length > 0 ? (
                  previewSlots ? (
                    mode !== "now" ? (
                      <div className="rounded-xl border border-line bg-surface2/40 p-3">
                        <FieldLabel>Plan preview</FieldLabel>
                        <div className="mt-2 flex flex-col gap-1">
                          {previewSlots.slice(0, 6).map((ms, i) => (
                            <p key={i} className="flex items-baseline gap-2 text-[11.5px]">
                              <span className="font-mono text-[10.5px] text-faint">{fmtKyiv(ms)}</span>
                              <span className="truncate text-dim">{draftItems[i]?.title}</span>
                            </p>
                          ))}
                          {previewSlots.length > 6 ? (
                            <p className="text-[10.5px] text-faint">
                              … +{previewSlots.length - 6} more, last {fmtKyiv(previewSlots[previewSlots.length - 1])}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    ) : null
                  ) : (
                    <p className="flex items-center gap-1.5 text-[11.5px] text-warn">
                      <AlertIcon className="h-3.5 w-3.5" />
                      This schedule can’t place every headline — add time slots or pick more days.
                    </p>
                  )
                ) : null}

                <div className="flex items-center gap-3 border-t border-line pt-3">
                  <button
                    type="button"
                    onClick={submit}
                    disabled={!canSubmit}
                    className={
                      "flex h-10 items-center gap-2 rounded-xl border px-4 text-[13px] font-semibold transition-all " +
                      (canSubmit
                        ? "border-launch/50 bg-launch/15 text-launch2 hover:bg-launch/25"
                        : "border-line bg-surface2 text-faint")
                    }
                  >
                    {submitting ? (
                      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-launch2/30 border-t-launch2" />
                    ) : (
                      <SparklesIcon className="h-4 w-4" />
                    )}
                    {mode === "now"
                      ? `Generate ${draftItems.length || ""} now`.replace("  ", " ")
                      : `Queue ${draftItems.length || ""} article${draftItems.length === 1 ? "" : "s"}`.replace("  ", " ")}
                  </button>
                  {submitOkAt ? (
                    <span className="flex items-center gap-1.5 text-[12px] font-medium text-launch2">
                      <CheckIcon className="h-3.5 w-3.5" /> Queued
                    </span>
                  ) : null}
                  {submitError ? (
                    <span className="flex items-center gap-1.5 text-[11.5px] text-danger">
                      <AlertIcon className="h-3.5 w-3.5" /> {submitError}
                    </span>
                  ) : null}
                  {!validation.ok && draftItems.length > 0 ? (
                    <span className="text-[11px] text-warn">
                      {validation.problems[0]?.index >= 0
                        ? `Row ${validation.problems[0].index + 1}: ${validation.problems[0].error}`
                        : validation.problems[0]?.error}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>

            {/* Queue */}
            <div className="rounded-2xl border border-line bg-surface/60">
              <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">3 · Queue</p>
                <div className="ml-2 flex flex-wrap gap-1">
                  {(["all", "scheduled", "generating", "published", "failed", "canceled"] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setFilter(f)}
                      className={
                        "h-6.5 rounded-full border px-2.5 text-[10.5px] font-medium capitalize transition-colors " +
                        (filter === f
                          ? "border-accent/50 bg-accent/15 text-[#9db8ff]"
                          : "border-line bg-surface2 text-faint hover:text-dim")
                      }
                    >
                      {f} {counts[f] ? `· ${counts[f]}` : ""}
                    </button>
                  ))}
                </div>
                <div className="ml-auto flex items-center gap-2">
                  {refreshedAt ? (
                    <span className="text-[10px] text-faint">upd {fmtKyiv(refreshedAt)}</span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void refresh()}
                    className="flex h-7 items-center gap-1.5 rounded-lg border border-line bg-surface2 px-2.5 text-[11.5px] text-dim transition-colors hover:text-[#9db8ff]"
                  >
                    <RetryIcon className="h-3.5 w-3.5" />
                    Refresh
                  </button>
                </div>
              </div>

              {actionError ? (
                <p className="flex items-center gap-1.5 border-b border-line px-4 py-2 text-[11.5px] text-danger">
                  <AlertIcon className="h-3.5 w-3.5" /> {actionError}
                </p>
              ) : null}

              {jobs === null ? (
                <div className="flex flex-col">
                  {Array.from({ length: 4 }, (_, i) => (
                    <div key={i} className="flex animate-pulse items-center gap-3 border-b border-line/60 px-4 py-3.5 last:border-b-0">
                      <span className="h-5 w-20 rounded-full bg-surface2" />
                      <span className="h-3.5 w-1/3 rounded bg-surface2" />
                      <span className="ml-auto h-3.5 w-24 rounded bg-surface2" />
                    </div>
                  ))}
                </div>
              ) : loadError && jobs === null ? (
                <p className="px-4 py-6 text-center text-[12px] text-danger">Queue unavailable: {loadError}</p>
              ) : shown.length === 0 ? (
                <p className="px-4 py-8 text-center text-[12px] text-faint">
                  {jobs.length === 0
                    ? "Nothing queued yet — add headlines above and hit Generate."
                    : "Nothing matches this filter."}
                </p>
              ) : (
                <div className="flex flex-col">
                  {shown.map((j) => {
                    const busy = busyIds.has(j.documentId);
                    const url = j.landingUrl || (j.slug ? `${LANDING_BASE}/${j.slug}` : "");
                    return (
                      <div
                        key={j.documentId}
                        className="group relative flex items-center gap-3 border-b border-line/60 px-4 py-3 last:border-b-0 hover:bg-raise/30"
                      >
                        <StatusChip status={j.status} />
                        <div className="min-w-0 flex-1">
                          <p className="flex items-center gap-2 truncate text-[13px] font-medium text-ink">
                            <span className="truncate">{j.title}</span>
                            <span className="shrink-0 rounded border border-line bg-surface2 px-1 text-[9.5px] font-semibold uppercase text-faint">
                              {j.lang}
                            </span>
                            <span className="shrink-0 text-[10.5px] text-faint">{j.niche}</span>
                          </p>
                          <p className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10.5px] text-faint">
                            {j.status === "scheduled" ? (
                              <>
                                <span className="font-mono">{fmtKyiv(j.scheduledAt)}</span>
                                <span className="text-[#9db8ff]">{countdown(j.scheduledAt, now)}</span>
                              </>
                            ) : null}
                            {j.status === "generating" ? <span>writing since {fmtKyiv(j.startedAt || j.scheduledAt)}…</span> : null}
                            {j.status === "published" && url ? (
                              <a
                                href={url}
                                target="_blank"
                                rel="noreferrer"
                                className="truncate text-launch2 hover:underline"
                              >
                                {url.replace("https://", "")}
                              </a>
                            ) : null}
                            {j.status === "failed" ? (
                              <span className="truncate text-danger" title={j.error}>
                                {j.error || "failed"}
                              </span>
                            ) : null}
                            {j.attempts > 1 ? <span>attempt {j.attempts}</span> : null}
                            {j.createdBy ? <span>by {j.createdBy}</span> : null}
                          </p>
                        </div>

                        <div className="flex shrink-0 items-center gap-1.5">
                          {busy ? (
                            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
                          ) : null}
                          {j.status === "scheduled" && !busy ? (
                            <>
                              <div className="relative">
                                <button
                                  type="button"
                                  onClick={() => setReschedFor((cur) => (cur === j.documentId ? null : j.documentId))}
                                  className="flex h-7 items-center gap-1 rounded-lg border border-line bg-surface2 px-2 text-[11px] text-dim transition-colors hover:text-[#9db8ff]"
                                >
                                  <TimerIcon className="h-3 w-3" />
                                  Move
                                </button>
                                {reschedFor === j.documentId ? (
                                  <ReschedulePopover
                                    initialMs={j.scheduledAt}
                                    onApply={(ms) => {
                                      setReschedFor(null);
                                      void act(j.documentId, "reschedule", { at: ms });
                                    }}
                                    onClose={() => setReschedFor(null)}
                                  />
                                ) : null}
                              </div>
                              <button
                                type="button"
                                onClick={() => void act(j.documentId, "cancel")}
                                className="h-7 rounded-lg border border-line bg-surface2 px-2 text-[11px] text-dim transition-colors hover:text-danger"
                              >
                                Cancel
                              </button>
                            </>
                          ) : null}
                          {(j.status === "failed" || j.status === "canceled") && !busy ? (
                            <button
                              type="button"
                              onClick={() => void act(j.documentId, "retry")}
                              className="flex h-7 items-center gap-1 rounded-lg border border-accent/40 bg-accent/10 px-2 text-[11px] font-medium text-[#9db8ff] transition-colors hover:bg-accent/20"
                            >
                              <RetryIcon className="h-3 w-3" />
                              Retry
                            </button>
                          ) : null}
                          {(j.status === "published" || j.status === "failed" || j.status === "canceled") && !busy ? (
                            <div className="relative">
                              <button
                                type="button"
                                onClick={() => setDeleteFor((cur) => (cur === j.documentId ? null : j.documentId))}
                                aria-label="Delete row"
                                className="grid h-7 w-7 place-items-center rounded-lg border border-line bg-surface2 text-faint transition-colors hover:text-danger"
                              >
                                <TrashIcon className="h-3.5 w-3.5" />
                              </button>
                              {deleteFor === j.documentId ? (
                                <DeletePopover
                                  job={j}
                                  onConfirm={(withLanding) => {
                                    setDeleteFor(null);
                                    void del(j.documentId, withLanding);
                                  }}
                                  onClose={() => setDeleteFor(null)}
                                />
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        </div>
      </main>
    </>
  );
}
