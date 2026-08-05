"use client";

import { PARTNERS, type PartnerId } from "@/lib/partners";

export function PartnerSwitcher({
  value,
  onChange,
}: {
  value: PartnerId;
  onChange: (id: PartnerId) => void;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="hidden select-none text-[9px] font-semibold uppercase tracking-[0.22em] text-faint lg:block">
        Partner
      </span>
      <div
        role="group"
        aria-label="Partner"
        className="flex items-center gap-1 rounded-full border border-line bg-surface p-1"
      >
        {PARTNERS.map(({ id, label, Flag, inDevelopment }) => {
          const active = id === value;

          // Not built out yet — render disabled with the same "in development" cue as the platform tabs.
          if (inDevelopment) {
            return (
              <button
                key={id}
                type="button"
                aria-disabled="true"
                tabIndex={-1}
                data-tip={`${label} — in development`}
                className={
                  "tip tip-b relative flex h-9 cursor-not-allowed items-center gap-2 rounded-full border " +
                  "border-transparent px-3 text-[13px] font-medium text-faint opacity-60 " +
                  "transition-all duration-200 hover:opacity-80 xl:px-3.5"
                }
              >
                <Flag className="h-4 w-4 shrink-0 saturate-[0.35]" />
                <span className="hidden xl:inline">{label}</span>
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
              className={
                "group flex h-9 items-center gap-2 rounded-full border px-3 text-[13px] font-medium " +
                "transition-all duration-200 active:scale-[0.96] xl:px-3.5 " +
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
              <span className="hidden xl:inline">{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
