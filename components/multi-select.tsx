"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, XIcon } from "./icons";
import type { CountryPreset } from "@/lib/catalog";
import { type BulkPick, mergeBulk, resolveBulk } from "@/lib/bulk-pick";

type Item = { value: string; label: string };

// A pasted/typed LIST ("CI, CD, BF, MA, …") is applied as a whole (lib/bulk-pick): a paste lands
// every entry as a chip at once; a typed list shows an "Add N" row (Enter) above the matched
// entries, with the tokens nothing matched named. The confirmation line under the field lives
// this long, then fades — the chips are the real answer.
const NOTICE_MS = 6_000;
const SUMMARY_MAX = 12;

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
  const [pos, setPos] = useState<{ left: number; width: number; top: number; up: boolean } | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [notice, setNotice] = useState<{ text: string; unknown: string[] } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The list renders in a portal so it's never clipped by a modal's overflow. Position it in
  // viewport coords under the field (or above it when the space below is short).
  const computePos = () => {
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return;
    const spaceBelow = window.innerHeight - r.bottom;
    const up = spaceBelow < 320 && r.top > spaceBelow;
    setPos({ left: r.left, width: r.width, top: up ? r.top : r.bottom, up });
  };

  function openList() {
    computePos();
    setOpen(true);
    setActive(0);
  }

  // Keep the portaled list glued to the field while open (scroll, resize, chip wrap).
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

  // The notice timer must not outlive the field.
  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    [],
  );

  const byValue = new Map(options.map((o) => [o.value, o]));
  const q = query.trim().toLowerCase();
  const filtered = q
    ? options.filter(
        (o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q),
      )
    : options;
  // Bulk mode: the query reads as a list → the panel offers "Add N" plus the matched entries.
  const bulk = resolveBulk(query, options, presets ?? []);
  const bulkItems: Item[] = bulk ? bulk.matched.flatMap((v) => byValue.get(v) ?? []) : [];
  const rowCount = bulk ? 1 + bulkItems.length : filtered.length;

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

  /** Short human list of picks for the "Add N" row and the confirmation line. */
  function summarize(vals: string[]): string {
    const names = vals.map((v) => (chipMode === "code" ? v : (byValue.get(v)?.label ?? v)));
    return names.length <= SUMMARY_MAX
      ? names.join(", ")
      : `${names.slice(0, SUMMARY_MAX).join(", ")} +${names.length - SUMMARY_MAX} more`;
  }

  function showNotice(text: string, unknown: string[]) {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice({ text, unknown });
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  }

  function clearNotice() {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = null;
    setNotice(null);
  }

  /** Land a whole list: union onto the picks (World stays exclusive), clear the query, confirm. */
  function applyBulk(pick: BulkPick) {
    const next = mergeBulk(values, pick.matched, exclusiveValues);
    const added = next.filter((v) => !values.includes(v)).length;
    const already = pick.matched.length - added;
    onChange(next);
    setQuery("");
    setActive(0);
    showNotice(
      `Added ${added}${already > 0 ? ` (${already} already picked)` : ""}: ${summarize(pick.matched)}`,
      pick.unknown,
    );
    inputRef.current?.focus();
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
      setActive((a) => Math.min(a + 1, Math.max(rowCount - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (bulk) {
        if (active === 0) {
          if (bulkItems.length > 0) applyBulk(bulk);
        } else {
          const o = bulkItems[active - 1];
          if (o) toggle(o.value);
        }
      } else if (filtered[active]) {
        toggle(filtered[active].value);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
      clearNotice();
    }
  }

  function optionRow(o: Item, idx: number) {
    const selected = values.includes(o.value);
    return (
      <div
        key={o.value}
        data-idx={idx}
        role="option"
        aria-selected={selected}
        onMouseDown={(e) => {
          e.preventDefault();
          toggle(o.value);
        }}
        onMouseEnter={() => setActive(idx)}
        className={
          "flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-[13px] transition-colors duration-100 " +
          (idx === active ? "bg-accent/10 text-ink" : "text-dim")
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
  }

  return (
    <div
      ref={rootRef}
      className="relative"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setOpen(false);
          setQuery("");
          clearNotice();
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
          aria-controls={id ? `${id}-listbox` : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder={values.length === 0 ? placeholder : ""}
          value={query}
          onFocus={openList}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!open) openList();
            setActive(0);
            if (notice) clearNotice();
          }}
          onPaste={(e) => {
            // A pasted list lands as chips right away; anything else pastes as search text.
            const pick = resolveBulk(e.clipboardData.getData("text"), options, presets ?? []);
            if (!pick || pick.matched.length === 0) return;
            e.preventDefault();
            if (!open) openList();
            applyBulk(pick);
          }}
          onKeyDown={onKeyDown}
          className="h-6.5 min-w-[80px] flex-1 bg-transparent px-1.5 text-[13px] text-ink placeholder:text-faint outline-none"
        />
      </div>

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
          {notice ? (
            <div
              data-testid="bulk-notice"
              className="animate-pop-in border-b border-line px-3 py-2 text-[11.5px] text-[#9db8ff]"
            >
              <span>{notice.text}</span>
              {notice.unknown.length > 0 ? (
                <span className="text-warn"> · not found: {notice.unknown.join(", ")}</span>
              ) : null}
            </div>
          ) : null}
          <div ref={listRef} id={id ? `${id}-listbox` : undefined} role="listbox" className="max-h-60 overflow-y-auto p-1">
            {bulk ? (
              <>
                {bulkItems.length > 0 ? (
                  <div
                    data-idx={0}
                    data-testid="bulk-add"
                    role="option"
                    aria-selected={false}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      applyBulk(bulk);
                    }}
                    onMouseEnter={() => setActive(0)}
                    className={
                      "flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-[13px] transition-colors duration-100 " +
                      (active === 0 ? "bg-accent/15 text-ink" : "bg-accent/5 text-[#9db8ff]")
                    }
                  >
                    <span className="truncate">
                      <span className="font-medium">Add {bulkItems.length}</span>
                      <span className="text-dim"> · {summarize(bulk.matched)}</span>
                    </span>
                    <kbd className="shrink-0 rounded border border-line px-1 font-mono text-[10px] text-faint">Enter</kbd>
                  </div>
                ) : (
                  <p className="px-3 py-3 text-[12px] text-faint">No matches for: {bulk.unknown.join(", ")}</p>
                )}
                {bulk.unknown.length > 0 && bulkItems.length > 0 ? (
                  <p className="px-3 pb-1.5 pt-1 text-[11px] text-warn">Not found: {bulk.unknown.join(", ")}</p>
                ) : null}
                {bulkItems.map((o, i) => optionRow(o, i + 1))}
              </>
            ) : filtered.length === 0 ? (
              <p className="px-3 py-3 text-[12px] text-faint">No matches</p>
            ) : (
              filtered.map((o, i) => optionRow(o, i))
            )}
          </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
