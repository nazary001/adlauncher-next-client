"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon, SearchIcon, XIcon } from "./icons";
import type { RichOption } from "@/lib/catalog";

export function SearchSelect({
  id,
  value,
  onChange,
  options,
  placeholder,
  emptyHint = "No matches",
  disabled,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  options: RichOption[] | string[];
  placeholder?: string;
  emptyHint?: string;
  disabled?: boolean;
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
      setOpenUp(spaceBelow < 280 && r.top > spaceBelow);
    }
    setOpen(true);
    setActive(0);
  }

  const opts: RichOption[] = options.map((o) =>
    typeof o === "string" ? { value: o, label: o } : o,
  );
  const q = query.trim().toLowerCase();
  const filtered = q
    ? opts.filter(
        (o) =>
          o.label.toLowerCase().includes(q) || o.meta?.toLowerCase().includes(q),
      )
    : opts;

  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  function pick(o: RichOption) {
    onChange(o.value);
    setOpen(false);
    setQuery("");
  }

  function onKeyDown(e: React.KeyboardEvent) {
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
      if (filtered[active]) pick(filtered[active]);
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
      <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
      <input
        id={id}
        ref={inputRef}
        role="combobox"
        aria-expanded={open}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        placeholder={placeholder}
        value={open ? query : value}
        onFocus={openList}
        onChange={(e) => {
          setQuery(e.target.value);
          if (!open) openList();
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        className={
          "h-9 w-full rounded-lg border border-line bg-surface2 pl-8 pr-8 text-[13px] text-ink " +
          "placeholder:text-faint outline-none transition-[border-color,box-shadow] duration-150 " +
          "hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15 " +
          "disabled:opacity-40 disabled:cursor-not-allowed"
        }
      />
      {value && !open ? (
        <button
          type="button"
          aria-label="Clear"
          tabIndex={-1}
          onMouseDown={(e) => {
            e.preventDefault();
            onChange("");
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-faint transition-colors hover:text-ink"
        >
          <XIcon className="h-3 w-3" />
        </button>
      ) : null}

      {open ? (
        <div
          className={
            "absolute left-0 right-0 z-30 overflow-hidden rounded-xl border border-line2 bg-surface shadow-[0_16px_40px_rgba(0,0,0,0.55)] " +
            (openUp ? "animate-drop-in-up bottom-full mb-1.5" : "animate-drop-in top-full mt-1.5")
          }
        >
          <div ref={listRef} className="max-h-56 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-3 text-[12px] text-faint">{emptyHint}</p>
            ) : (
              filtered.map((o, i) => (
                <div
                  key={o.value}
                  data-idx={i}
                  role="option"
                  aria-selected={o.value === value}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(o);
                  }}
                  onMouseEnter={() => setActive(i)}
                  className={
                    "flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-[13px] transition-colors duration-100 " +
                    (i === active ? "bg-accent/10 text-ink" : "text-dim")
                  }
                >
                  <span className="truncate">{o.label}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    {o.meta ? (
                      <span className="font-mono text-[11px] text-faint">{o.meta}</span>
                    ) : null}
                    {o.value === value ? <CheckIcon className="h-3.5 w-3.5 text-accent" /> : null}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
