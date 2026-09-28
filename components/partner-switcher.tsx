"use client";

import { PARTNERS, type PartnerId } from "@/lib/partners";

/** Label of a NON-active partner pill: shown where the partner row has room — its own row below lg
 *  (from sm up) and the single-row header from xl up; flag-only (with a tooltip) on phones and in the
 *  tight lg band. The ACTIVE partner is always named. */
const INACTIVE_LABEL = "hidden whitespace-nowrap sm:inline lg:hidden xl:inline";

export function PartnerSwitcher({
  value,
  onChange,
  lockedNote,
}: {
  value: PartnerId;
  onChange: (id: PartnerId) => void;
  /** When set, the switcher is pinned to `value`: every OTHER partner renders as a disabled pill
   *  carrying this note as its tip (same disabled styling as an in-development partner). Used by
   *  the Google platform, whose only rail is LION (HS) — the buyer can't switch partners there. */
  lockedNote?: string;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2.5">
      <span className="hidden select-none text-[9px] font-semibold uppercase tracking-[0.22em] text-faint 2xl:block">
        Partner
      </span>
      <div
        role="group"
        aria-label="Partner"
        className="flex items-center gap-1 rounded-full border border-line bg-surface p-1"
      >
        {PARTNERS.map(({ id, label, Flag, inDevelopment }) => {
          const active = id === value;
          // Pinned by `lockedNote`: every partner but the current one is disabled (the rail can't
          // switch here). Same disabled styling as an in-development partner; only the tip differs.
          const locked = Boolean(lockedNote) && !active;

          // Not built out yet, or pinned away — render disabled with the "in development" cue.
          if (inDevelopment || locked) {
            return (
              <button
                key={id}
                type="button"
                aria-disabled="true"
                tabIndex={-1}
                data-tip={locked ? lockedNote : `${label} — in development`}
                className={
                  "tip tip-b relative flex h-9 shrink-0 cursor-not-allowed items-center gap-2 rounded-full border " +
                  "border-transparent px-2.5 text-[13px] font-medium text-faint opacity-60 " +
                  "transition-all duration-200 hover:opacity-80 sm:px-3 xl:px-3.5"
                }
              >
                <Flag className="h-4 w-4 shrink-0 saturate-[0.35]" />
                <span className={INACTIVE_LABEL}>{label}</span>
                <span className="animate-pulse-soft absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-warn" />
              </button>
            );
          }

          return (
            <button
              key={id}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(id)}
              // Icon-only inactive pills (the tight bands) still name themselves on hover/focus.
              data-tip={active ? undefined : label}
              className={
                "group flex h-9 shrink-0 items-center gap-2 rounded-full border px-2.5 text-[13px] font-medium " +
                "transition-all duration-200 active:scale-[0.96] sm:px-3 xl:px-3.5 " +
                (active ? "" : "tip tip-b ") +
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 " +
                (active
                  ? "border-accent/40 bg-accent/15 text-[#9db8ff] shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_0_18px_rgba(61,127,255,0.16)]"
                  : "border-transparent text-dim hover:bg-raise hover:text-ink")
              }
            >
              <Flag
                className={
                  "h-4 w-4 shrink-0 transition-all duration-200 " +
                  (active ? "" : "opacity-60 saturate-[0.35] group-hover:opacity-100 group-hover:saturate-100")
                }
              />
              <span className={active ? "whitespace-nowrap" : INACTIVE_LABEL}>{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
