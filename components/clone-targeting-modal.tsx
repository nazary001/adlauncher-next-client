"use client";

import { useEffect, useState } from "react";
import type { CloneRow } from "@/lib/clone";
import { AGES, CATEGORIES, COUNTRIES, COUNTRY_PRESETS, LOCALES, PLACEMENTS } from "@/lib/catalog";
import { Field, Select } from "./ui";
import { MultiSelect } from "./multi-select";
import { GlobeIcon, XIcon } from "./icons";

/** The per-row targeting fields this modal edits (USER OS is a global setting, not per row). */
type Draft = Pick<CloneRow, "countries" | "locales" | "category" | "placement" | "ageMin">;

/** Mounted only while open (parent renders it conditionally), so the draft is seeded straight
 *  from the row at mount — no seeding effect, no cascading renders. */
export function CloneTargetingModal({
  row,
  onClose,
  onApply,
}: {
  row: CloneRow;
  onClose: () => void;
  onApply: (patch: Draft) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => ({
    countries: [...row.countries],
    locales: [...row.locales],
    category: row.category,
    placement: row.placement,
    ageMin: row.ageMin,
  }));

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const set = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="animate-fade-in absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={onClose} />
      <div className="animate-pop-in relative flex max-h-[85vh] w-full max-w-[560px] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_30px_80px_rgba(0,0,0,0.6)]">
        {/* header */}
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-accent/25 to-accent2/25 text-[#9db8ff]">
              <GlobeIcon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold leading-tight text-ink">Targeting</h2>
              <p className="mt-1 truncate text-[12px] text-dim">{row.name}</p>
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

        {/* body */}
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
          <Field label="Geo">
            <MultiSelect
              values={draft.countries}
              onChange={(countries) => set({ countries })}
              options={COUNTRIES.map((x) => ({ value: x.code, label: x.name }))}
              presets={COUNTRY_PRESETS}
              exclusiveValues={["WW"]}
              chipMode="code"
              placeholder="Search country"
            />
          </Field>
          <Field label="Languages">
            <MultiSelect
              values={draft.locales}
              onChange={(locales) => set({ locales })}
              options={LOCALES.map((l) => ({ value: l, label: l }))}
              placeholder="Search language"
            />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Special category">
              <Select value={draft.category} onChange={(e) => set({ category: e.target.value })} options={CATEGORIES} />
            </Field>
            <Field label="Placement">
              <Select value={draft.placement} onChange={(e) => set({ placement: e.target.value })} options={PLACEMENTS} />
            </Field>
            <Field label="Age">
              <Select value={draft.ageMin} onChange={(e) => set({ ageMin: e.target.value })} options={AGES} />
            </Field>
          </div>
        </div>

        {/* footer */}
        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-line bg-surface px-3.5 py-2 text-[13px] font-medium text-dim transition-colors hover:border-line2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              onApply(draft);
              onClose();
            }}
            className={
              "flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/15 px-3.5 py-2 text-[13px] font-semibold " +
              "text-[#9db8ff] transition-all duration-150 hover:border-accent/60 hover:bg-accent/25 active:scale-[0.98] " +
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            }
          >
            Apply targeting
          </button>
        </div>
      </div>
    </div>
  );
}
