"use client";

import { useId } from "react";
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
}: {
  label: string;
  children: ReactElement<{ id?: string }>;
  className?: string;
  hint?: string;
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
      {hint ? <p className="text-[11px] leading-snug text-faint">{hint}</p> : null}
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
