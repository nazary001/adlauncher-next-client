"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  metaWhenClosed,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  options: RichOption[] | string[];
  placeholder?: string;
  emptyHint?: string;
  disabled?: boolean;
  /** Closed input shows "label · meta" (fanpages: name · page id) instead of the label alone. */
  metaWhenClosed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; width: number; top: number; up: boolean } | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The list renders in a portal so it's never clipped by a modal's overflow. Position it in
  // viewport coords under the field (or above it when the space below is short).
  const computePos = () => {
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return;
    const spaceBelow = window.innerHeight - r.bottom;
    const up = spaceBelow < 280 && r.top > spaceBelow;
    setPos({ left: r.left, width: r.width, top: up ? r.top : r.bottom, up });
  };

  function openList() {
    computePos();
    setOpen(true);
    // Cursor starts on the picked option (query is empty on open → indexes match the full list),
    // so a long list opens scrolled to the current choice instead of the top.
    const selectedIdx = opts.findIndex((o) => o.value === value);
    setActive(selectedIdx >= 0 ? selectedIdx : 0);
  }

  // Keep the portaled list glued to the field while open (scroll, resize).
  useEffect(() => {
    if (!open) return;
    window.addEventListener("scroll", computePos, true);
    window.addEventListener("resize", computePos);
    const ro = new ResizeObserver(computePos);
    if (rootRef.current) ro.observe(rootRef.current);
    return () => {
      window.removeEventListener("scroll", computePos, true);
      window.removeEventListener("resize", computePos);
      ro.disconnect();
    };
  }, [open]);

  const opts: RichOption[] = options.map((o) =>
    typeof o === "string" ? { value: o, label: o } : o,
  );
  // Closed input shows the picked option's LABEL (+ its status tag) — value and label differ for
  // id-keyed options (fanpages); plain string catalogs are unaffected (value === label).
  const selected = opts.find((o) => o.value === value);
  const displayValue = selected
    ? metaWhenClosed && selected.meta
      ? `${selected.label} · ${selected.meta}`
      : selected.label
    : value;
  const q = query.trim().toLowerCase();
  // Searchable by label, meta AND value — for fanpages the value is the page id.
  const filtered = q
    ? opts.filter(
        (o) =>
          o.label.toLowerCase().includes(q) ||
          o.meta?.toLowerCase().includes(q) ||
          o.value.toLowerCase().includes(q),
      )
    : opts;

  const toneCls = (tone?: RichOption["tagTone"]) =>
    tone === "danger"
      ? "text-danger"
      : tone === "warn"
        ? "text-warn"
        : tone === "ok"
          ? "text-launch2"
          : "text-dim";

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
        value={open ? query : displayValue}
        onFocus={openList}
        onClick={() => {
          // Re-clicking an already-focused input fires no focus event — without this the list
          // only reopens after a blur+refocus, which reads as "the dropdown doesn't open".
          if (!open) openList();
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          if (!open) openList();
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        className={
          "h-9 w-full rounded-lg border border-line bg-surface2 pl-8 text-[13px] text-ink " +
          "placeholder:text-faint outline-none transition-[border-color,box-shadow] duration-150 " +
          "hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15 " +
          "disabled:opacity-40 disabled:cursor-not-allowed " +
          (!open && selected?.tag ? "pr-20" : "pr-8")
        }
      />
      {!open && selected?.tag ? (
        <span
          className={
            "pointer-events-none absolute right-8 top-1/2 -translate-y-1/2 font-mono text-[11px] tabular-nums " +
            toneCls(selected.tagTone)
          }
        >
          {selected.tag}
        </span>
      ) : null}
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

      {open && pos
        ? createPortal(
            <div
              onMouseDown={(e) => e.preventDefault()}
              style={{
                position: "fixed",
                left: pos.left,
                width: pos.width,
                ...(pos.up ? { bottom: window.innerHeight - pos.top + 6 } : { top: pos.top + 6 }),
                zIndex: 120,
              }}
              className={
                "overflow-hidden rounded-xl border border-line2 bg-surface shadow-[0_16px_40px_rgba(0,0,0,0.55)] " +
                (pos.up ? "animate-drop-in-up" : "animate-drop-in")
              }
            >
              <div ref={listRef} className="max-h-72 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-3 text-[12px] text-faint">{emptyHint}</p>
            ) : (
              filtered.map((o, i) =>
                o.subLabel ? (
                  // Two-line option: label on top; the muted sub-line (e.g. account id) + status
                  // tag below — lets long names + id + a FARM marker all fit without truncation.
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
                      "flex cursor-pointer flex-col gap-0.5 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors duration-100 " +
                      (i === active ? "bg-accent/10 text-ink" : "text-dim")
                    }
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate">{o.label}</span>
                      {o.value === value ? <CheckIcon className="h-3.5 w-3.5 shrink-0 text-accent" /> : null}
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-[11px] text-faint">{o.subLabel}</span>
                      {o.tag ? (
                        <span className={"shrink-0 font-mono text-[11px] tabular-nums " + toneCls(o.tagTone)}>
                          {o.tag}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ) : (
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
                      {o.tag ? (
                        <span className={"font-mono text-[11px] tabular-nums " + toneCls(o.tagTone)}>
                          {o.tag}
                        </span>
                      ) : null}
                      {o.value === value ? <CheckIcon className="h-3.5 w-3.5 text-accent" /> : null}
                    </span>
                  </div>
                ),
              )
            )}
          </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
