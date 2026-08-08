"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CloneEdit,
  type CloneRow,
  type CloneSettings,
  type HighOfferConfig,
  defaultSettings,
  flattenPreview,
  fullCloneName,
  loadCloneSources,
  loadSampleSources,
  makeCloneRow,
  targetById,
  targetsFor,
} from "@/lib/clone";
import { moneyLabel } from "@/lib/types";
import { OS_OPTIONS, countryName } from "@/lib/catalog";
import { type PartnerId, partnerConfig } from "@/lib/partners";
import { Field, Select } from "./ui";
import {
  AlertIcon,
  CopyIcon,
  FilmIcon,
  GlobeIcon,
  LockIcon,
  PlusIcon,
  RetryIcon,
  SlidersIcon,
  TargetIcon,
  TrashIcon,
} from "./icons";
import { Header } from "./header";
import { TaskManagerProvider, useTaskManager } from "./task-manager";
import { CloneTargetingModal } from "./clone-targeting-modal";
import { CloneHighOfferModal } from "./clone-high-offer-modal";
import { SearchSelect } from "./search-select";
import { useFanpages } from "./use-fanpages";
import type { SessionUser } from "./user-menu";

/** Today as DD.MM for clone-name date stamping (client-side). */
function todayDDMM(): string {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const cellInput =
  "h-8 w-full rounded-md border border-line bg-surface2 px-2 text-[12px] font-mono tabular-nums text-ink " +
  "outline-none transition-colors duration-150 hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15";

/** Compact geo string for the Task Manager row (mirrors the launcher's geo summary). */
function geoShort(codes: string[]): string {
  if (codes.length === 0) return "no geo";
  if (codes[0] === "WW") return "World";
  if (codes.length <= 2) return codes.join(", ");
  return `${codes.length} geos`;
}

function SectionHeading({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-line pb-2">
      <h4 className="text-[13px] font-semibold text-ink">{children}</h4>
      {right}
    </div>
  );
}

/** One locked destination bind (account / fanpage / pixel) — borderless row inside the card. */
function LockedRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 px-1.5 py-1">
      <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint">{label}</span>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate font-mono text-[11.5px] text-ink" title={value}>
          {value}
        </span>
        <LockIcon className="h-3 w-3 shrink-0 text-faint" />
      </span>
    </div>
  );
}

/** Textarea that grows to fit its content (no inner scrollbar) — for the long campaign name. */
function AutoTextarea({
  value,
  onChange,
  className = "",
  maxLength,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
  maxLength?: number;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // +2 covers the 1px top/bottom border: box-sizing:border-box excludes it from scrollHeight,
    // so without it the content is 2px too tall and a scrollbar appears.
    const fit = () => {
      el.style.height = "0px";
      el.style.height = `${el.scrollHeight + 2}px`;
    };
    fit();
    // Re-fit when the column width changes (window resize / layout shift) so a rewrap can't clip
    // the text. Guard on width to avoid a height-driven ResizeObserver loop.
    let lastW = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== lastW) {
        lastW = el.clientWidth;
        fit();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [value]);
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={1}
      maxLength={maxLength}
      spellCheck={false}
      aria-label={ariaLabel}
      className={className}
    />
  );
}

/** Compact geo chips for the table cell. */
function GeoChips({ codes }: { codes: string[] }) {
  if (codes.length === 0) return <span className="text-[12px] text-faint">— no geo</span>;
  if (codes[0] === "WW") {
    return (
      <span className="inline-flex rounded-md border border-accent/25 bg-accent/10 px-1.5 py-0.5 font-mono text-[11px] text-[#9db8ff]">
        WORLD
      </span>
    );
  }
  const shown = codes.slice(0, 4);
  return (
    <span className="flex flex-wrap gap-1">
      {shown.map((c) => (
        <span
          key={c}
          title={countryName(c)}
          className="inline-flex rounded-md border border-accent/25 bg-accent/10 px-1.5 py-0.5 font-mono text-[11px] text-[#9db8ff]"
        >
          {c}
        </span>
      ))}
      {codes.length > shown.length ? (
        <span className="inline-flex rounded-md border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[11px] text-faint">
          +{codes.length - shown.length}
        </span>
      ) : null}
    </span>
  );
}

export function CloneBoard({
  user,
  initialIds,
  partner = "in",
}: {
  user?: SessionUser;
  initialIds: string[];
  partner?: PartnerId;
}) {
  return (
    <TaskManagerProvider user={user}>
      <CloneInner user={user} initialIds={initialIds} partner={partner} />
    </TaskManagerProvider>
  );
}

function CloneInner({
  user,
  initialIds,
  partner: initialPartner,
}: {
  user?: SessionUser;
  initialIds: string[];
  partner: PartnerId;
}) {
  const { enqueueClone, setOpen } = useTaskManager();
  const [partnerId, setPartnerId] = useState<PartnerId>(initialPartner);
  const [settings, setSettings] = useState<CloneSettings>(() => defaultSettings(initialPartner));
  const [rows, setRows] = useState<CloneRow[]>([]);
  const [loading, setLoading] = useState<boolean>(initialIds.length > 0);
  const [error, setError] = useState<string | null>(null);
  const [previewed, setPreviewed] = useState(false);
  const [targetingRowId, setTargetingRowId] = useState<string | null>(null);
  const [highOfferRowId, setHighOfferRowId] = useState<string | null>(null);
  const [justQueued, setJustQueued] = useState(0);
  const nextRowId = useRef(1);
  const queuedTimer = useRef<number | null>(null);

  const partner = partnerConfig(partnerId);
  const target = targetById(settings.targetId);
  const targets = targetsFor(partnerId);
  // Token fanpages for the batch fanka picker (with live N/limit fill tags). null while loading.
  const fanpages = useFanpages(Boolean(partner.fanpagesFromToken), partner.pageAdLimit ?? 250);
  const fanpageMissing = Boolean(partner.fanpagesFromToken) && !settings.pageId;
  // Whoever is signed in — clone names default to end with " - <Username>".
  const me = user?.username ?? null;

  /** (Re)load real sources for a set of ids from Facebook. Used by the Retry button — an event
   *  handler, so the synchronous loading/error flips are fine here. */
  const loadIds = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) {
        setRows([]);
        setError(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      const ddmm = todayDDMM();
      loadCloneSources(ids, partnerId)
        .then((sources) => {
          setRows(sources.map((s) => makeCloneRow(s, ddmm, `r${nextRowId.current++}`, me)));
          setPreviewed(false);
        })
        .catch((e) => {
          setRows([]);
          setError(e instanceof Error ? e.message : "Failed to load campaigns");
        })
        .finally(() => setLoading(false));
    },
    [partnerId, me],
  );

  /** Load local mock sources for the "Load sample" button — no Facebook call. */
  const loadSample = () => {
    setLoading(true);
    setError(null);
    const ddmm = todayDDMM();
    loadSampleSources()
      .then((sources) => {
        setRows(sources.map((s) => makeCloneRow(s, ddmm, `r${nextRowId.current++}`, me)));
        setPreviewed(false);
      })
      .finally(() => setLoading(false));
  };

  // Initial load from the ids handed over in the link. Async-only (all setState lives in the
  // promise callbacks) so it never sets state synchronously inside the effect; `loading` is
  // already seeded true when ids are present.
  useEffect(() => {
    if (initialIds.length === 0) return;
    let alive = true;
    const ddmm = todayDDMM();
    loadCloneSources(initialIds, partnerId)
      .then((sources) => {
        if (!alive) return;
        setRows(sources.map((s) => makeCloneRow(s, ddmm, `r${nextRowId.current++}`, me)));
        setPreviewed(false);
      })
      .catch((e) => {
        if (!alive) return;
        setRows([]);
        setError(e instanceof Error ? e.message : "Failed to load campaigns");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patchRow = (id: string, patch: Partial<CloneRow>) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    setPreviewed(false);
  };
  const patchSettings = (patch: Partial<CloneSettings>) => {
    setSettings((s) => ({ ...s, ...patch }));
    setPreviewed(false);
  };
  const removeRow = (id: string) => {
    setRows((rs) => rs.filter((r) => r.id !== id));
    setPreviewed(false);
  };

  const changePartner = (id: PartnerId) => {
    setPartnerId(id);
    setSettings(defaultSettings(id));
    setPreviewed(false);
  };

  const preview = flattenPreview(rows, settings.copies);

  /** Queue each clone (rows × copies) into the Task Manager, which builds them one at a time
   *  (PAUSED) with live stages / errors / retry — the same queue and pipeline as launches. */
  const duplicate = () => {
    if (fanpageMissing) return; // the button is disabled too — belt and suspenders
    const total = Math.max(1, Math.floor(settings.copies) || 1);
    let queued = 0;
    for (const r of rows) {
      for (let k = 1; k <= total; k++) {
        const full = fullCloneName(r);
        const name = total > 1 ? `${full} (${k})` : full;
        const edit: CloneEdit = {
          campaignId: r.source.campaignId,
          name,
          budget: r.budget,
          roasGoal: r.roasGoal,
          countries: r.countries,
          locales: r.locales,
          category: r.category,
          placement: r.placement,
          ageMin: r.ageMin,
          userOs: settings.userOs,
          pageId: settings.pageId,
        };
        enqueueClone({ partnerId, edit, name, geo: geoShort(r.countries), budget: r.budget });
        queued++;
      }
    }
    if (queued === 0) return;
    setOpen(true); // reveal the Task Manager so the clones are visible building right away
    setPreviewed(false); // re-arm — a fresh preview is required before queuing again
    setJustQueued(queued);
    if (queuedTimer.current) window.clearTimeout(queuedTimer.current);
    queuedTimer.current = window.setTimeout(() => setJustQueued(0), 4500);
  };

  const targetingRow = rows.find((r) => r.id === targetingRowId) ?? null;
  const highOfferRow = rows.find((r) => r.id === highOfferRowId) ?? null;

  return (
    <>
      <Header partner={partnerId} onPartnerChange={changePartner} user={user} />
      <main className="flex-1">
        <div className="mx-auto grid w-full max-w-[1440px] items-start gap-6 px-4 pb-24 pt-6 sm:px-6 lg:grid-cols-[300px_minmax(0,1fr)]">
          {/* ---- Settings (left) ---- */}
          <section className="flex flex-col gap-4 lg:sticky lg:top-[88px]">
            <SectionHeading>Settings</SectionHeading>

            {/* destination — locked to one account today, multi-account ready */}
            <div className="flex flex-col gap-2">
              <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint">Destination</span>
              <div className="flex flex-col gap-0.5 rounded-xl border border-line bg-surface2/40 p-1.5">
                {targets.length > 1 ? (
                  <div className="p-0.5">
                    <Select
                      value={settings.targetId}
                      onChange={(e) => patchSettings({ targetId: e.target.value })}
                      options={targets.map((t) => ({ value: t.id, label: t.label }))}
                    />
                  </div>
                ) : (
                  <LockedRow label="Account" value={target?.accountName ?? "—"} />
                )}
                {partner.fanpagesFromToken ? (
                  <div className="flex flex-col gap-1 px-1.5 py-1">
                    <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint">Fanpage</span>
                    <SearchSelect
                      value={settings.pageId}
                      onChange={(v) => patchSettings({ pageId: v })}
                      options={fanpages ?? []}
                      placeholder={partner.pagePlaceholder}
                      emptyHint={fanpages ? "No fanpages on the token" : "Loading fanpages…"}
                      metaWhenClosed
                    />
                  </div>
                ) : null}
                <LockedRow label="Pixel" value={target?.pixelName ?? "—"} />
              </div>
              <p className="px-0.5 text-[10.5px] leading-relaxed text-faint">
                Clones are created on the {partner.label} account
                {partner.fanpagesFromToken ? " with the fanpage picked above (applies to every clone in the batch)" : ""}.
                More accounts unlock the selector automatically.
              </p>
            </div>

            <Field label="User OS">
              <Select
                value={settings.userOs}
                onChange={(e) => patchSettings({ userOs: e.target.value as CloneSettings["userOs"] })}
                options={OS_OPTIONS}
              />
            </Field>

            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint">Copies per campaign</span>
              <div className="flex h-9 items-stretch overflow-hidden rounded-lg border border-line bg-surface2">
                <button
                  type="button"
                  aria-label="Fewer copies"
                  onClick={() => patchSettings({ copies: Math.max(1, settings.copies - 1) })}
                  disabled={settings.copies <= 1}
                  className="flex w-9 shrink-0 items-center justify-center text-[17px] leading-none text-dim transition-colors hover:bg-raise hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  −
                </button>
                <input
                  type="number"
                  min={1}
                  max={100}
                  aria-label="Copies per campaign"
                  value={settings.copies}
                  onChange={(e) => patchSettings({ copies: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })}
                  className="w-full min-w-0 border-x border-line bg-transparent text-center font-mono text-[13px] tabular-nums text-ink outline-none [appearance:textfield] focus:bg-surface2/60 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
                <button
                  type="button"
                  aria-label="More copies"
                  onClick={() => patchSettings({ copies: Math.min(100, settings.copies + 1) })}
                  disabled={settings.copies >= 100}
                  className="flex w-9 shrink-0 items-center justify-center text-[17px] leading-none text-dim transition-colors hover:bg-raise hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  +
                </button>
              </div>
              <p className="text-[11px] leading-snug text-faint">Each campaign is duplicated this many times.</p>
            </div>

            <div className="flex flex-col gap-2 pt-1">
              <button
                type="button"
                onClick={() => setPreviewed(true)}
                disabled={rows.length === 0}
                className={
                  "flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-accent/40 bg-accent/15 " +
                  "text-[13px] font-semibold text-[#9db8ff] transition-all duration-150 hover:border-accent/60 " +
                  "hover:bg-accent/25 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 " +
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                }
              >
                <TargetIcon className="h-4 w-4" />
                Generate Preview
              </button>

              {previewed && rows.length > 0 ? (
                <button
                  type="button"
                  onClick={duplicate}
                  disabled={fanpageMissing}
                  className={
                    "animate-pop-in flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-launch/50 " +
                    "bg-launch/15 text-[14px] font-semibold text-launch2 transition-all duration-150 hover:border-launch/70 " +
                    "hover:bg-launch/25 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 " +
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-launch/40"
                  }
                >
                  <CopyIcon className="h-4 w-4" />
                  {`Duplicate ${preview.length} ${preview.length === 1 ? "clone" : "clones"} · PAUSED`}
                </button>
              ) : null}

              {previewed && rows.length > 0 && fanpageMissing ? (
                <p className="text-center text-[11px] text-warn">Pick a fanpage in Destination first.</p>
              ) : null}

              {previewed ? (
                <p className="text-center text-[11px] text-faint">
                  {rows.length} {rows.length === 1 ? "campaign" : "campaigns"} × {settings.copies} ={" "}
                  <span className="font-mono text-dim">{preview.length}</span> clones · created paused
                </p>
              ) : null}

              {justQueued > 0 ? (
                <p className="animate-pop-in rounded-lg border border-launch/30 bg-launch/10 px-3 py-2 text-center text-[11.5px] leading-relaxed text-launch2">
                  {justQueued} {justQueued === 1 ? "clone" : "clones"} queued — building in the Task Manager.
                </p>
              ) : null}
            </div>
          </section>

          {/* ---- Selected campaigns (right) ---- */}
          <section className="flex min-w-0 flex-col gap-4">
            <SectionHeading
              right={
                <span className="rounded-md border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[11px] text-dim">
                  {rows.length}
                </span>
              }
            >
              Selected Campaigns
            </SectionHeading>

            {loading ? (
              <div className="flex h-40 items-center justify-center rounded-2xl border border-dashed border-line2 text-[13px] text-faint">
                Loading campaigns from Facebook…
              </div>
            ) : error ? (
              <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-danger/30 bg-danger/5 px-6 py-12 text-center">
                <AlertIcon className="h-7 w-7 text-danger" />
                <div>
                  <p className="text-[14px] font-medium text-ink">Couldn&apos;t load campaigns</p>
                  <p className="mx-auto mt-1 max-w-[440px] break-words font-mono text-[11.5px] leading-relaxed text-dim">
                    {error}
                  </p>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => loadIds(initialIds)}
                    disabled={initialIds.length === 0}
                    className="flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/15 px-3.5 py-2 text-[12.5px] font-semibold text-[#9db8ff] transition-colors hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    <RetryIcon className="h-3.5 w-3.5" />
                    Retry
                  </button>
                  <button
                    type="button"
                    onClick={loadSample}
                    className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3.5 py-2 text-[12.5px] font-medium text-dim transition-colors hover:border-line2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    <PlusIcon className="h-3.5 w-3.5" />
                    Load sample
                  </button>
                </div>
              </div>
            ) : rows.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line2 px-6 py-14 text-center">
                <TargetIcon className="h-7 w-7 text-faint" />
                <div>
                  <p className="text-[14px] font-medium text-ink">No campaigns received</p>
                  <p className="mt-1 text-[12px] text-dim">
                    Open this page from the <span className="text-ink">Clone</span> button in the stats tool —
                    the campaigns to duplicate arrive by id in the link.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={loadSample}
                  className="mt-1 flex items-center gap-2 rounded-lg border border-line bg-surface px-3.5 py-2 text-[12.5px] font-medium text-dim transition-colors hover:border-accent/40 hover:text-[#9db8ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  <PlusIcon className="h-3.5 w-3.5" />
                  Load sample campaigns
                </button>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-2xl border border-line">
                <table className="w-full min-w-[900px] table-fixed border-collapse text-left">
                  <thead>
                    <tr className="border-b border-line bg-surface2/40 text-[9.5px] font-semibold uppercase tracking-[0.05em] text-faint">
                      <th className="w-[30px] px-1.5 py-2.5 text-center">#</th>
                      <th className="px-3 py-2.5">Campaign name</th>
                      <th className="w-[110px] px-2 py-2.5">Geo</th>
                      <th className="w-[58px] px-2 py-2.5 text-right">Orig $</th>
                      <th className="w-[84px] px-2 py-2.5 text-right">Orig ROAS</th>
                      <th className="w-[54px] px-2 py-2.5 text-center">Videos</th>
                      <th className="w-[86px] border-l border-line px-2 py-2.5">ROAS goal</th>
                      <th className="w-[86px] px-2 py-2.5">Budget</th>
                      <th className="w-[112px] px-2 py-2.5">Config</th>
                      <th className="w-[44px] px-1 py-2.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr
                        key={r.id}
                        className="border-b border-line align-middle transition-colors last:border-b-0 hover:bg-raise/25"
                      >
                        <td className="px-1.5 py-3.5 text-center">
                          <span className="flex h-8 items-center justify-center font-mono text-[12px] text-faint">
                            {i + 1}
                          </span>
                        </td>

                        {/* name — fixed prefix (locked) + editable remainder */}
                        <td className="px-3 py-3.5">
                          <span
                            className="mb-1 flex items-center gap-1 truncate font-mono text-[10.5px] text-faint"
                            title={`${r.namePrefix.trim()} — fixed, not editable`}
                          >
                            <LockIcon className="h-2.5 w-2.5 shrink-0" />
                            {r.namePrefix.trim()}
                          </span>
                          <AutoTextarea
                            value={r.name}
                            onChange={(v) => patchRow(r.id, { name: v })}
                            maxLength={400}
                            ariaLabel="Campaign name (editable part)"
                            className="block w-full resize-none overflow-hidden rounded-lg border border-line bg-surface2 px-2.5 py-2 text-[12.5px] leading-relaxed text-ink outline-none transition-colors duration-150 hover:border-line2 focus:border-accent/60 focus:bg-surface2/80 focus:ring-2 focus:ring-accent/15"
                          />
                          <div className="mt-1.5">
                            <span className="inline-flex items-center rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[10px] text-faint">
                              #{r.source.campaignId}
                            </span>
                          </div>
                        </td>

                        {/* geo + targeting */}
                        <td className="px-2 py-3.5">
                          <div className="flex flex-col gap-2">
                            <GeoChips codes={r.countries} />
                            <button
                              type="button"
                              onClick={() => setTargetingRowId(r.id)}
                              className="inline-flex w-fit items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] font-medium text-dim transition-colors hover:bg-accent/10 hover:text-[#9db8ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                            >
                              <GlobeIcon className="h-3 w-3" />
                              Targeting
                            </button>
                          </div>
                        </td>

                        {/* original values (read-only) */}
                        <td className="px-2 py-3.5 text-right">
                          <span className="flex h-8 items-center justify-end font-mono text-[12px] text-faint">
                            ${moneyLabel(r.source.originalBudget)}
                          </span>
                        </td>
                        <td className="px-2 py-3.5 text-right">
                          <span className="flex h-8 items-center justify-end font-mono text-[12px] text-faint">
                            {r.source.originalRoas || "—"}
                          </span>
                        </td>
                        <td className="px-2 py-3.5 text-center">
                          <span className="flex h-8 items-center justify-center gap-1 font-mono text-[12px] text-dim">
                            <FilmIcon className="h-3.5 w-3.5 text-faint" />
                            {r.source.creatives.length}
                          </span>
                        </td>

                        {/* clone settings (editable) */}
                        <td className="border-l border-line px-2 py-3.5">
                          <input
                            value={r.roasGoal}
                            onChange={(e) => patchRow(r.id, { roasGoal: e.target.value })}
                            inputMode="decimal"
                            placeholder="1,20"
                            aria-label="ROAS goal"
                            className={cellInput}
                          />
                        </td>
                        <td className="px-2 py-3.5">
                          <div className="relative">
                            <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 font-mono text-[12px] text-faint">
                              $
                            </span>
                            <input
                              value={r.budget}
                              onChange={(e) => patchRow(r.id, { budget: e.target.value })}
                              inputMode="decimal"
                              aria-label="Daily budget"
                              className={`${cellInput} pl-5`}
                            />
                          </div>
                        </td>

                        {/* config */}
                        <td className="px-2 py-3.5">
                          <div className="flex h-8 items-center">
                            {r.redirectType === "HIGH ADX" ? (
                              <button
                                type="button"
                                onClick={() => setHighOfferRowId(r.id)}
                                className={
                                  "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors " +
                                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warn/40 " +
                                  (r.highOffer.enabled
                                    ? "border-warn/50 bg-warn/15 text-warn"
                                    : "border-warn/40 bg-warn/5 text-warn hover:bg-warn/10")
                                }
                              >
                                <SlidersIcon className="h-3 w-3" />
                                High Offer
                              </button>
                            ) : (
                              <span className="inline-flex rounded-md border border-line bg-surface2 px-2 py-1 font-mono text-[10.5px] text-faint">
                                {r.redirectType}
                              </span>
                            )}
                          </div>
                        </td>

                        {/* remove */}
                        <td className="px-1 py-3.5">
                          <div className="flex h-8 items-center justify-center">
                            <button
                              type="button"
                              onClick={() => removeRow(r.id)}
                              aria-label="Remove campaign"
                              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-faint transition-colors hover:bg-danger/10 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
                            >
                              <TrashIcon className="h-[18px] w-[18px]" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* preview */}
            {previewed && rows.length > 0 ? (
              <div className="animate-pop-in mt-2 flex flex-col gap-2">
                <SectionHeading
                  right={
                    <span className="rounded-md border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[11px] text-dim">
                      {preview.length}
                    </span>
                  }
                >
                  Preview · clones to create
                </SectionHeading>
                <div className="flex flex-col gap-1.5">
                  {preview.map((p) => (
                    <div
                      key={p.key}
                      className="flex items-center gap-3 rounded-lg border border-line bg-surface2/40 px-3 py-2"
                    >
                      <span className="min-w-0 flex-1 truncate text-[12px] text-ink" title={p.name}>
                        {p.name}
                      </span>
                      <GeoChips codes={p.countries} />
                      <span className="shrink-0 font-mono text-[11px] text-faint">ROAS {p.roasGoal}</span>
                      <span className="shrink-0 font-mono text-[11px] text-dim">${moneyLabel(p.budget)}/day</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

          </section>
        </div>
      </main>

      {targetingRow ? (
        <CloneTargetingModal
          row={targetingRow}
          onClose={() => setTargetingRowId(null)}
          onApply={(patch) => patchRow(targetingRow.id, patch)}
        />
      ) : null}
      {highOfferRow ? (
        <CloneHighOfferModal
          row={highOfferRow}
          onClose={() => setHighOfferRowId(null)}
          onApply={(highOffer: HighOfferConfig) => patchRow(highOfferRow.id, { highOffer })}
        />
      ) : null}
    </>
  );
}
