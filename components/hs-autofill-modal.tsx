"use client";

// "Autofill all rows" for the HS clone board (owner ask 16.10: "в клонере сделай как бы автофил функцию
// чтобы можно было сменить гео, бюджет и бид во всех кампаниях сразу") — one form whose TICKED fields
// land on every row of the wave: targeting (geo + languages), strategy + bid, budget, copies. The form
// starts from a row's current values ("Start from row #N", row 1 by default); editing a value ticks its
// field, a tick alone sends the value as shown. lib/hs-autofill says what each row becomes — this file
// is only the form. Same modal grammar as the per-row Targeting / Destination editors.

import { useEffect, useState } from "react";
import { COUNTRIES, COUNTRY_PRESETS, type Option } from "@/lib/catalog";
import { type HsAutofillPatch, autofillProblem } from "@/lib/hs-autofill";
import { bidKind, limitMoneyCents, moneyLabel } from "@/lib/types";
import { CheckIcon, ChevronDownIcon, MinusIcon, PlusIcon, SparklesIcon, XIcon } from "./icons";
import { MultiSelect } from "./multi-select";

/** A board row as the form reads it (its current, EFFECTIVE values — the seed of the form). */
export type HsAutofillSeedRow = {
  id: string;
  label: string;
  /** The autofill reaches this row (readable source, not mid-submit). */
  takes: boolean;
  countries: string[];
  locales: string[];
  budget: string;
  /** The row's effective strategy (its own pick, else the source's). */
  bidStrategy: string;
  bid: string;
  copies: string;
};

type FieldKey = "targeting" | "bidding" | "budget" | "copies";

type Draft = { countries: string[]; locales: string[]; bidStrategy: string; bid: string; budget: string; copies: string };

const draftOf = (r: HsAutofillSeedRow | undefined): Draft => ({
  countries: [...(r?.countries ?? [])],
  locales: [...(r?.locales ?? [])],
  bidStrategy: r?.bidStrategy ?? "",
  bid: r?.bid ?? "",
  budget: r?.budget ?? "",
  copies: r?.copies ?? "",
});

const geoLabel = (codes: string[]): string =>
  codes.length === 0 ? "inherit the source's" : codes.includes("WW") ? "World" : codes.length <= 4 ? codes.join(", ") : `${codes.length} geos`;

export function HsAutofillModal({
  rows,
  localeOptions,
  strategyOptions,
  geoLocked,
  maxCopies,
  defaultCopies,
  onClose,
  onApply,
}: {
  /** The board's rows in table order. */
  rows: HsAutofillSeedRow[];
  /** The wave profile's FB locales (value = locale id). Empty = no profile picked yet. */
  localeOptions: Option[];
  /** Strategies the current rail takes (LION's jurar has no cost cap). */
  strategyOptions: Option[];
  /** The rail cannot change geo (TOOL) — the reason; null = targeting may be set. */
  geoLocked: string | null;
  maxCopies: number;
  defaultCopies: number;
  onClose: () => void;
  onApply: (patch: HsAutofillPatch) => void;
}) {
  const targets = rows.filter((r) => r.takes);
  const skipped = rows.length - targets.length;
  const [seedId, setSeedId] = useState(() => targets[0]?.id ?? rows[0]?.id ?? "");
  const [draft, setDraft] = useState<Draft>(() => draftOf(rows.find((r) => r.id === seedId)));
  const [ticked, setTicked] = useState<Set<FieldKey>>(() => new Set());

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const tick = (k: FieldKey) =>
    setTicked((s) => {
      if (s.has(k)) return s;
      const next = new Set(s);
      next.add(k);
      return next;
    });
  const toggle = (k: FieldKey) =>
    setTicked((s) => {
      const next = new Set(s);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  /** An edit ticks its field — what the buyer types is what they mean to send. */
  const edit = (k: FieldKey, patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    tick(k);
  };
  /** Start over from another row's current values. */
  const reseed = (id: string) => {
    setSeedId(id);
    setDraft(draftOf(rows.find((r) => r.id === id)));
    setTicked(new Set());
  };

  const kind = bidKind(draft.bidStrategy);
  const copiesN = Math.min(maxCopies, Math.max(1, Math.round(Number(draft.copies) || defaultCopies)));
  const patch: HsAutofillPatch = {
    ...(ticked.has("targeting") && !geoLocked ? { targeting: { countries: draft.countries, locales: draft.locales } } : {}),
    ...(ticked.has("bidding") ? { bidding: { bidStrategy: draft.bidStrategy, bid: kind === "none" ? "" : draft.bid } } : {}),
    ...(ticked.has("budget") ? { budget: draft.budget } : {}),
    ...(ticked.has("copies") ? { copies: draft.copies } : {}),
  };
  const problem = targets.length === 0 ? "No row takes an autofill right now" : autofillProblem(patch, maxCopies);

  const check = (k: FieldKey, on: boolean, disabled = false) => (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={`Set ${k} on every row`}
      disabled={disabled}
      onClick={() => toggle(k)}
      className={
        "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors disabled:cursor-not-allowed disabled:opacity-40 " +
        (on ? "border-accent bg-accent text-white" : "border-line2 bg-surface hover:border-accent/60")
      }
    >
      {on ? <CheckIcon className="h-3.5 w-3.5" /> : null}
    </button>
  );
  const group = (k: FieldKey, title: string, preview: string, body: React.ReactNode, disabledWhy: string | null = null) => {
    const on = ticked.has(k) && !disabledWhy;
    return (
      <section
        className={
          "flex flex-col gap-2.5 rounded-xl border px-3.5 py-3 transition-colors " +
          (on ? "border-accent/40 bg-accent/[0.06]" : "border-line bg-surface2/40") +
          (disabledWhy ? " opacity-60" : "")
        }
        title={disabledWhy ?? undefined}
      >
        <div className="flex items-center gap-2.5">
          {check(k, on, Boolean(disabledWhy))}
          <button
            type="button"
            onClick={() => (disabledWhy ? undefined : toggle(k))}
            className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left focus-visible:outline-none"
          >
            <span className={"text-[13px] font-semibold " + (on ? "text-ink" : "text-dim")}>{title}</span>
            <span className="max-w-[55%] truncate text-right font-mono text-[11px] text-faint">{disabledWhy ? "locked on this rail" : preview}</span>
          </button>
        </div>
        {disabledWhy ? <p className="text-[11px] leading-snug text-warn">{disabledWhy}</p> : body}
      </section>
    );
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="animate-fade-in absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Autofill all rows"
        className="animate-pop-in relative flex max-h-[88vh] w-full max-w-[600px] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_30px_80px_rgba(0,0,0,0.6)]"
      >
        {/* header */}
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-accent/25 to-accent2/25 text-[#9db8ff]">
              <SparklesIcon className="h-4.5 w-4.5" />
            </span>
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold leading-tight text-ink">Autofill all rows</h2>
              <p className="mt-1 text-[12px] leading-snug text-dim">
                The ticked fields land on <span className="font-medium text-ink">every row</span> of the wave — {targets.length} row{targets.length === 1 ? "" : "s"}
                {skipped > 0 ? ` (${skipped} skipped: unreadable or in flight)` : ""}. Untouched fields stay as each row has them.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-faint transition-colors hover:bg-raise hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        {/* seed */}
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-2.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Start from</span>
          <div className="relative min-w-0 flex-1 sm:max-w-[360px]">
            <select
              value={seedId}
              onChange={(e) => reseed(e.target.value)}
              aria-label="Start from row"
              className="h-8 w-full cursor-pointer appearance-none truncate rounded-md border border-line bg-surface2 px-2 pr-7 text-[12px] text-ink outline-none transition-colors hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15"
            >
              {rows.map((r, i) => (
                <option key={r.id} value={r.id} className="bg-surface text-ink">
                  #{i + 1} · {r.label.length > 60 ? `${r.label.slice(0, 60)}…` : r.label}
                  {r.takes ? "" : " (not in the wave)"}
                </option>
              ))}
            </select>
            <ChevronDownIcon className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-faint" />
          </div>
        </div>

        {/* fields */}
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
          {group(
            "targeting",
            "Targeting",
            `${geoLabel(draft.countries)}${draft.locales.length ? ` · ${draft.locales.length} lang` : ""}`,
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint">Geo</span>
                <MultiSelect
                  values={draft.countries}
                  onChange={(next) => edit("targeting", { countries: next })}
                  options={COUNTRIES.map((x) => ({ value: x.code, label: x.name }))}
                  presets={COUNTRY_PRESETS}
                  exclusiveValues={["WW"]}
                  chipMode="code"
                  placeholder="Search country"
                />
                <p className="text-[11px] leading-snug text-faint">
                  Empty = every row inherits its source&apos;s geo. The clone&apos;s name gets the new [GEO] label too.
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint">Languages</span>
                {localeOptions.length ? (
                  <MultiSelect
                    values={draft.locales}
                    onChange={(next) => edit("targeting", { locales: next })}
                    options={localeOptions}
                    placeholder="Search language"
                  />
                ) : (
                  <p className="rounded-lg border border-dashed border-line bg-surface2 px-3 py-2.5 text-[12px] text-faint">
                    Pick a Profile in Settings first — languages come from its own locale list. Geo alone can still be set.
                  </p>
                )}
              </div>
            </div>,
            geoLocked,
          )}

          {group(
            "bidding",
            "Strategy · Bid",
            draft.bidStrategy
              ? `${strategyOptions.find((o) => o.value === draft.bidStrategy)?.label ?? draft.bidStrategy}${kind === "none" ? " · auto" : draft.bid ? ` · ${kind === "roas" ? "R " : "$"}${draft.bid}` : " · bid ?"}`
              : "—",
            <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-2">
              <div className="relative">
                <select
                  value={draft.bidStrategy}
                  onChange={(e) => {
                    const bidStrategy = e.target.value;
                    // Same rule as the row's select: a kind change clears the typed bid.
                    edit("bidding", { bidStrategy, bid: bidKind(bidStrategy) === kind ? draft.bid : "" });
                  }}
                  aria-label="Strategy for every row"
                  className="h-9 w-full cursor-pointer appearance-none rounded-lg border border-line bg-surface2 px-3 pr-7 text-[12.5px] text-ink outline-none transition-colors hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15"
                >
                  {!draft.bidStrategy ? (
                    <option value="" className="bg-surface text-ink">
                      Pick a strategy…
                    </option>
                  ) : null}
                  {draft.bidStrategy && !strategyOptions.some((o) => o.value === draft.bidStrategy) ? (
                    <option value={draft.bidStrategy} className="bg-surface text-ink">
                      {draft.bidStrategy}
                    </option>
                  ) : null}
                  {strategyOptions.map((o) => (
                    <option key={o.value} value={o.value} className="bg-surface text-ink">
                      {o.label}
                    </option>
                  ))}
                </select>
                <ChevronDownIcon className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-faint" />
              </div>
              <div className="relative">
                {kind !== "none" ? (
                  <span className={"pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 font-mono text-[11.5px] " + (kind === "roas" ? "font-semibold text-[#9db8ff]" : "text-faint")}>
                    {kind === "roas" ? "R" : "$"}
                  </span>
                ) : null}
                <input
                  value={kind === "none" ? "" : draft.bid}
                  onChange={(e) => edit("bidding", { bid: limitMoneyCents(e.target.value, kind === "roas" ? 100 : 1000) })}
                  disabled={kind === "none"}
                  inputMode="decimal"
                  aria-label="Bid / ROAS goal for every row"
                  placeholder={kind === "none" ? (draft.bidStrategy ? "auto" : "—") : kind === "roas" ? "0,34" : "1,20"}
                  title={kind === "roas" ? "ROAS decimal — 34 → 0,34 (34%)" : kind === "cap" ? "Bid cap in $ — digits fill cents, 34 → $0,34" : "Lowest cost bids automatically"}
                  className={
                    "h-9 w-full rounded-lg border border-line bg-surface2 px-3 font-mono text-[12.5px] tabular-nums text-ink outline-none transition-colors hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15 disabled:cursor-not-allowed disabled:opacity-50 " +
                    (kind !== "none" ? "pl-6" : "")
                  }
                />
              </div>
              <p className="col-span-2 text-[11px] leading-snug text-faint">
                Every row gets THIS strategy and bid — a cap / ROAS strategy needs the bid (the source&apos;s own bid never carries across strategies). A row still on its default budget follows the strategy ($50 on min ROAS, $10 otherwise) unless Budget is ticked.
              </p>
            </div>,
          )}

          {group(
            "budget",
            "Budget",
            draft.budget ? `$${moneyLabel(draft.budget)}/day` : "—",
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-[12px] text-faint">$</span>
              <input
                value={draft.budget}
                onChange={(e) => edit("budget", { budget: limitMoneyCents(e.target.value, 10000) })}
                inputMode="decimal"
                placeholder="10,00"
                aria-label="Daily budget for every row"
                title="Daily budget in $ — digits fill cents, 1500 → 15,00 · min $1/day"
                className="h-9 w-full rounded-lg border border-line bg-surface2 px-3 pl-6 font-mono text-[12.5px] tabular-nums text-ink outline-none transition-colors hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15"
              />
            </div>,
          )}

          {group(
            "copies",
            "Copies",
            draft.copies ? `×${draft.copies}` : `wave default (${defaultCopies})`,
            <div className="flex items-center gap-3">
              <div className="flex h-9 items-stretch overflow-hidden rounded-lg border border-line bg-surface2 transition-colors focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/15">
                <button
                  type="button"
                  onClick={() => edit("copies", { copies: String(Math.max(1, copiesN - 1)) })}
                  disabled={copiesN <= 1}
                  aria-label="Fewer copies"
                  className="flex w-9 shrink-0 items-center justify-center text-faint transition-colors hover:bg-raise hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <MinusIcon className="h-3.5 w-3.5" />
                </button>
                <span className="pointer-events-none self-center font-mono text-[11px] text-faint">×</span>
                <input
                  value={draft.copies}
                  onChange={(e) => {
                    const raw = e.target.value.replace(/\D/g, "").slice(0, 2);
                    edit("copies", { copies: raw !== "" && Number(raw) > maxCopies ? String(maxCopies) : raw });
                  }}
                  inputMode="numeric"
                  placeholder={String(defaultCopies)}
                  aria-label="Copies for every row"
                  className="w-12 bg-transparent px-1 text-center font-mono text-[12.5px] tabular-nums text-ink outline-none placeholder:text-faint"
                />
                <button
                  type="button"
                  onClick={() => edit("copies", { copies: String(Math.min(maxCopies, copiesN + 1)) })}
                  disabled={copiesN >= maxCopies}
                  aria-label="More copies"
                  className="flex w-9 shrink-0 items-center justify-center text-faint transition-colors hover:bg-raise hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <PlusIcon className="h-3.5 w-3.5" />
                </button>
              </div>
              <p className="text-[11px] leading-snug text-faint">
                empty = the wave default ({defaultCopies}) · max {maxCopies}
              </p>
            </div>,
          )}
        </div>

        {/* footer */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-5 py-3.5">
          <p className={"min-w-0 flex-1 text-[11px] leading-snug " + (problem && ticked.size > 0 ? "text-warn" : "text-faint")}>
            {ticked.size === 0
              ? "Tick a field — or just edit it — and it lands on every row."
              : (problem ?? `Will set ${Object.keys(patch).length} field${Object.keys(patch).length === 1 ? "" : "s"} on ${targets.length} row${targets.length === 1 ? "" : "s"}. The board re-previews before the fire.`)}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-line bg-surface px-3.5 py-2 text-[13px] font-medium text-dim transition-colors hover:border-line2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={problem !== null}
              onClick={() => onApply(patch)}
              className={
                "flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/15 px-3.5 py-2 text-[13px] font-semibold " +
                "text-[#9db8ff] transition-all duration-150 hover:border-accent/60 hover:bg-accent/25 active:scale-[0.98] " +
                "disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              }
            >
              <SparklesIcon className="h-4 w-4" />
              Apply to {targets.length} row{targets.length === 1 ? "" : "s"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
