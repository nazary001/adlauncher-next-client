"use client";

import { useEffect, useId, useRef } from "react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactElement,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { cloneElement } from "react";
import { ChevronDownIcon } from "./icons";
import type { Option } from "@/lib/catalog";
import { bidKind } from "@/lib/types";

export const controlCls =
  "w-full rounded-lg border border-line bg-surface2 px-3 text-[13px] text-ink placeholder:text-faint " +
  "outline-none transition-[border-color,box-shadow,background-color] duration-150 " +
  "hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15 " +
  "disabled:opacity-40 disabled:cursor-not-allowed aria-disabled:opacity-40";

/** Wraps a control with a cockpit-style micro label; wires label→control via useId. */
export function Field({
  label,
  children,
  className = "",
  hint,
  error,
}: {
  label: string;
  children: ReactElement<{ id?: string }>;
  className?: string;
  hint?: string;
  /** When set, shown in place of the hint in a warning tone — the reason the field blocks launch. */
  error?: string;
}) {
  const id = useId();
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <label
        htmlFor={id}
        className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint select-none"
      >
        {label}
      </label>
      {cloneElement(children, { id })}
      {error ? (
        <p className="text-[11px] leading-snug text-warn">{error}</p>
      ) : hint ? (
        <p className="text-[11px] leading-snug text-faint">{hint}</p>
      ) : null}
    </div>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className = "", ...rest } = props;
  return <input autoComplete="off" spellCheck={false} className={`h-9 ${controlCls} ${className}`} {...rest} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = "", ...rest } = props;
  return (
    <textarea
      autoComplete="off"
      className={`min-h-[84px] resize-y py-2 leading-relaxed ${controlCls} ${className}`}
      {...rest}
    />
  );
}

export function Select({
  options,
  className = "",
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { options: Option[] }) {
  return (
    <div className={`relative ${className}`}>
      <select className={`h-9 appearance-none pr-8 cursor-pointer ${controlCls}`} {...rest}>
        {options.map((o) => (
          <option key={o.value || "none"} value={o.value} className="bg-surface text-ink">
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
    </div>
  );
}

export function MoneyInput({
  className = "",
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className={`relative ${className}`}>
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[13px] text-faint">$</span>
      <input
        autoComplete="off"
        inputMode="decimal"
        className={`h-9 pl-7 font-mono tabular-nums ${controlCls}`}
        {...rest}
      />
    </div>
  );
}

/** Small icon-only action button with a CSS tooltip. */
export function IconButton({
  label,
  danger,
  className = "",
  children,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> & {
  label: string;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      data-tip={label}
      className={
        "tip inline-flex h-8 w-8 items-center justify-center rounded-lg border border-transparent " +
        "text-faint transition-all duration-150 hover:border-line2 hover:bg-raise active:scale-90 " +
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 " +
        (danger ? "hover:text-danger " : "hover:text-ink ") +
        className
      }
      {...rest}
    >
      {children}
    </button>
  );
}

/** Full label per bid strategy (the launcher picker's wording) — the tag's tooltip. Doubles as
 *  the known-strategy set: an unknown/empty strategy renders NO tag (a wrong tag is worse than
 *  none). */
const BID_STRATEGY_TITLES: Record<string, string> = {
  LOWEST_COST_WITHOUT_CAP: "Lowest cost — bids automatically",
  LOWEST_COST_WITH_BID_CAP: "Lowest cost + bid cap ($)",
  COST_CAP: "Cost cap ($)",
  LOWEST_COST_WITH_MIN_ROAS: "Lowest cost + min ROAS — the goal is a ROAS decimal (0,34 = 34%)",
};

/** Tiny per-row marker naming HOW a campaign bids — a min-ROAS goal vs a $ cap vs automatic.
 *  One shared look across the clone boards so "roas or bid?" reads the same everywhere:
 *  blue = ROAS decimal, amber = $ cap, muted = auto. */
export function BidKindTag({ strategy, className = "" }: { strategy: string; className?: string }) {
  const title = BID_STRATEGY_TITLES[strategy];
  if (!title) return null;
  const kind = bidKind(strategy);
  const label = kind === "roas" ? "ROAS" : kind === "cap" ? "CAP" : "AUTO";
  const tone =
    kind === "roas"
      ? "border-accent/40 bg-accent/10 text-[#9db8ff]"
      : kind === "cap"
        ? "border-warn/40 bg-warn/10 text-warn"
        : "border-line bg-surface2 text-faint";
  return (
    <span
      title={title}
      className={`inline-flex w-fit items-center rounded border px-1 py-px text-[9px] font-semibold uppercase tracking-wide ${tone} ${className}`}
    >
      {label}
    </span>
  );
}

/** Textarea that grows to fit its content (no inner scrollbar) — for long editable name parts.
 *  `singleLine` keeps the VALUE newline-free (Enter is swallowed, pasted breaks collapse to
 *  spaces) while the text still WRAPS visually — the adaptive alternative to a horizontally
 *  scrolling input. Extracted from clone-board (08-21) to share with the HS duplicator. */
export function AutoTextarea({
  value,
  onChange,
  className = "",
  maxLength,
  ariaLabel,
  placeholder,
  singleLine = false,
}: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
  maxLength?: number;
  ariaLabel?: string;
  placeholder?: string;
  singleLine?: boolean;
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
      onChange={(e) => onChange(singleLine ? e.target.value.replace(/[\r\n]+/g, " ") : e.target.value)}
      onKeyDown={
        singleLine
          ? (e) => {
              if (e.key === "Enter") e.preventDefault();
            }
          : undefined
      }
      rows={1}
      maxLength={maxLength}
      spellCheck={false}
      aria-label={ariaLabel}
      placeholder={placeholder}
      className={className}
    />
  );
}
