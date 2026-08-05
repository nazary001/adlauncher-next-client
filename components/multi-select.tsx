"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon, XIcon } from "./icons";
import type { CountryPreset } from "@/lib/catalog";

type Item = { value: string; label: string };

export function MultiSelect({
  id,
  values,
  onChange,
  options,
  presets,
  placeholder,
  chipMode = "label",
  exclusiveValues = [],
}: {
  id?: string;
  values: string[];
  onChange: (v: string[]) => void;
  options: Item[];
  presets?: CountryPreset[];
  placeholder?: string;
  /** 'code' renders the compact value in chips (geo codes); 'label' renders the full label. */
  chipMode?: "code" | "label";
  exclusiveValues?: string[];
}) {
  const [open, setOpen] = useState(false);
  const [openUp, setOpenUp] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /* flip the list above the field when the viewport below is too short for it */
  function openList() {
    const r = rootRef.current?.getBoundingClientRect();
    if (r) {
      const spaceBelow = window.innerHeight - r.bottom;
      setOpenUp(spaceBelow < 320 && r.top > spaceBelow);
    }
    setOpen(true);
    setActive(0);
  }

  const byValue = new Map(options.map((o) => [o.value, o]));
  const q = query.trim().toLowerCase();
  const filtered = q
    ? options.filter(
        (o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q),
      )
    : options;

  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  function toggle(v: string) {
    if (exclusiveValues.includes(v)) {
      onChange(values.includes(v) ? [] : [v]);
      return;
    }
    const base = values.filter((x) => !exclusiveValues.includes(x));
    onChange(base.includes(v) ? base.filter((x) => x !== v) : [...base, v]);
  }

  function applyPreset(p: CountryPreset) {
    const isExclusive = p.codes.some((c) => exclusiveValues.includes(c));
    if (isExclusive) {
      onChange(presetActive(p) ? [] : [...p.codes]);
      return;
    }
    const base = values.filter((x) => !exclusiveValues.includes(x));
    if (presetActive(p)) {
      onChange(base.filter((x) => !p.codes.includes(x)));
    } else {
      onChange([...new Set([...base, ...p.codes])]);
    }
    inputRef.current?.focus();
  }

  function presetActive(p: CountryPreset) {
    return p.codes.every((c) => values.includes(c));
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Backspace" && query === "" && values.length > 0) {
      onChange(values.slice(0, -1));
      return;
    }
    if (!open && (e.key === "ArrowDown" || e.key === "Enter")) {
      openList();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[active]) toggle(filtered[active].value);
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
    }
  }

  return (
    <div
      ref={rootRef}
      className="relative"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setOpen(false);
          setQuery("");
        }
      }}
    >
      <div
        onClick={() => inputRef.current?.focus()}
        className={
          "flex min-h-9 w-full cursor-text flex-wrap items-center gap-1 rounded-lg border border-line " +
          "bg-surface2 px-1.5 py-1 transition-[border-color,box-shadow] duration-150 hover:border-line2 " +
          "focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/15"
        }
      >
        {values.map((v) => {
          const o = byValue.get(v);
          const text = chipMode === "code" ? v : (o?.label ?? v);
          return (
            <span
              key={v}
              title={o?.label ?? v}
              className={
                "animate-pop-in inline-flex items-center gap-1 rounded-md border border-accent/25 bg-accent/10 " +
                "py-0.5 pl-1.5 pr-0.5 text-accent2 " +
                (chipMode === "code"
                  ? "font-mono text-[11px] tracking-wide"
                  : "text-[11.5px]")
              }
            >
              <span className="text-[#9db8ff]">{text}</span>
              <button
                type="button"
                aria-label={`Remove ${o?.label ?? v}`}
                tabIndex={-1}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(values.filter((x) => x !== v));
                }}
                className="rounded p-0.5 text-faint transition-colors hover:bg-accent/20 hover:text-ink"
              >
                <XIcon className="h-2.5 w-2.5" />
              </button>
            </span>
          );
        })}
        <input
          id={id}
          ref={inputRef}
          role="combobox"
          aria-expanded={open}
          autoComplete="off"
          spellCheck={false}
          placeholder={values.length === 0 ? placeholder : ""}
          value={query}
          onFocus={openList}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!open) openList();
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          className="h-6.5 min-w-[80px] flex-1 bg-transparent px-1.5 text-[13px] text-ink placeholder:text-faint outline-none"
        />
      </div>

      {open ? (
        <div
          className={
            "absolute left-0 right-0 z-30 overflow-hidden rounded-xl border border-line2 bg-surface shadow-[0_16px_40px_rgba(0,0,0,0.55)] " +
            (openUp ? "animate-drop-in-up bottom-full mb-1.5" : "animate-drop-in top-full mt-1.5")
          }
        >
          {presets && presets.length > 0 ? (
            <div className="flex flex-wrap gap-1 border-b border-line p-1.5">
              {presets.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applyPreset(p);
                  }}
                  className={
                    "rounded-md border px-2 py-1 text-[11px] font-medium transition-all duration-150 active:scale-95 " +
                    (presetActive(p)
                      ? "border-accent/50 bg-accent/15 text-[#9db8ff]"
                      : "border-line bg-surface2 text-dim hover:border-line2 hover:text-ink")
                  }
                >
                  {p.label}
                </button>
              ))}
            </div>
          ) : null}
          <div ref={listRef} className="max-h-60 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-3 text-[12px] text-faint">No matches</p>
            ) : (
              filtered.map((o, i) => {
                const selected = values.includes(o.value);
                return (
                  <div
                    key={o.value}
                    data-idx={i}
                    role="option"
                    aria-selected={selected}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      toggle(o.value);
                    }}
                    onMouseEnter={() => setActive(i)}
                    className={
                      "flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-[13px] transition-colors duration-100 " +
                      (i === active ? "bg-accent/10 text-ink" : "text-dim")
                    }
                  >
                    <span className="truncate">{o.label}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      {o.value !== o.label ? (
                        <span className="font-mono text-[11px] text-faint">{o.value}</span>
                      ) : null}
                      {selected ? <CheckIcon className="h-3.5 w-3.5 text-accent" /> : null}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
