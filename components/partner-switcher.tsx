"use client";

import { PARTNERS, type PartnerId } from "@/lib/partners";

/** Label of a NON-active partner pill: shown while the header has room for it, folded to the flag
 *  alone (a tooltip names it) from squeeze step 3 (lib/header-fit; hdr-* rules in app/globals.css).
 *  The ACTIVE partner is always named. */
const INACTIVE_LABEL = "hdr-s3 whitespace-nowrap";
/** One segment of the 40px track — 32px tall, the same in the platform tabs (components/header). */
const SEGMENT = "flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-2 text-[13px] font-medium transition-all duration-200 ";

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
      <span className="hdr-s1 select-none text-[9px] font-semibold uppercase tracking-[0.22em] text-faint">
        Partner
      </span>
      <div
        role="group"
        aria-label="Partner"
        className="flex h-10 items-center gap-0.5 rounded-full border border-line bg-surface p-[3px]"
      >
        {PARTNERS.filter((p) => !p.hidden).map(({ id, label, Flag, inDevelopment }) => {
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
                  SEGMENT +
                  "tip tip-b relative cursor-not-allowed border-transparent text-faint opacity-60 hover:opacity-80"
                }
              >
                <Flag className="h-4 w-4 shrink-0 saturate-[0.35]" />
                <span className={INACTIVE_LABEL + " pr-1"}>{label}</span>
                <span className="animate-pulse-soft absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-warn" />
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
                SEGMENT +
                "group active:scale-[0.96] " +
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
              <span className={(active ? "whitespace-nowrap" : INACTIVE_LABEL) + " pr-1"}>{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
