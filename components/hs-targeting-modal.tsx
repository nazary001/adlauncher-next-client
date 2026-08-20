"use client";

import { useEffect, useState } from "react";
import { COUNTRIES, COUNTRY_PRESETS } from "@/lib/catalog";
import { Field } from "./ui";
import { MultiSelect } from "./multi-select";
import { GlobeIcon, XIcon } from "./icons";

/**
 * Per-clone Targeting override for the HS duplicator (same modal grammar as the MO clone
 * board's CloneTargetingModal, trimmed to what a duplicate can change): GEO with the launcher's
 * presets and LANGUAGES from the picked profile's own FB locale list. Empty selections INHERIT
 * the source's targeting — that's the default and the "Inherit source" reset.
 *
 * How the override lands is rail-specific (the server owns it): the FB Token rail swaps the geo
 * into the cloned ad set before creating it; the LION rail patches the born clone through the
 * Graph — which is why the wave then requires a token-visible target account.
 */
export function HsTargetingModal({
  title,
  countries,
  locales,
  localeOptions,
  onClose,
  onApply,
}: {
  title: string;
  countries: string[];
  locales: string[];
  /** The picked profile's FB locales (value = locale id). Empty = no profile picked yet. */
  localeOptions: { value: string; label: string }[];
  onClose: () => void;
  onApply: (patch: { countries: string[]; locales: string[] }) => void;
}) {
  const [draft, setDraft] = useState(() => ({ countries: [...countries], locales: [...locales] }));

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

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
              <p className="mt-1 truncate text-[12px] text-dim" title={title}>
                {title}
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

        {/* body */}
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
          <Field label="Geo" hint="Empty = inherit the source's geo. The clone's name gets the new [GEO] label too.">
            <MultiSelect
              values={draft.countries}
              onChange={(next) => setDraft((d) => ({ ...d, countries: next }))}
              options={COUNTRIES.map((x) => ({ value: x.code, label: x.name }))}
              presets={COUNTRY_PRESETS}
              exclusiveValues={["WW"]}
              chipMode="code"
              placeholder="Search country"
            />
          </Field>
          <Field
            label="Languages"
            hint={
              localeOptions.length
                ? "The profile's own FB locale list. Empty = inherit the source's languages."
                : undefined
            }
          >
            {localeOptions.length ? (
              <MultiSelect
                values={draft.locales}
                onChange={(next) => setDraft((d) => ({ ...d, locales: next }))}
                options={localeOptions}
                placeholder="Search language"
              />
            ) : (
              <p className="rounded-lg border border-dashed border-line bg-surface2 px-3 py-2.5 text-[12px] text-faint">
                Pick a Profile in Settings first — languages come from its own locale list.
              </p>
            )}
          </Field>
        </div>

        {/* footer */}
        <div className="flex items-center justify-between gap-2 border-t border-line px-5 py-3.5">
          <button
            type="button"
            onClick={() => {
              onApply({ countries: [], locales: [] });
              onClose();
            }}
            className="rounded-lg px-3 py-2 text-[12.5px] font-medium text-faint transition-colors hover:bg-raise hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            Inherit source
          </button>
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
    </div>
  );
}
