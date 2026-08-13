"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, SearchIcon, XIcon } from "./icons";
import type { RichOption } from "@/lib/catalog";

/** Niche chip in the facet bar — glassy pill with a count badge; active = accent gradient glow. */
function NicheChip({
  active,
  onPick,
  count,
  children,
}: {
  active: boolean;
  onPick: () => void;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      onMouseDown={(e) => {
        // preventDefault keeps focus in the search input (blur would close the list).
        e.preventDefault();
        onPick();
      }}
      className={
        "group/chip flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium " +
        "transition-all duration-150 active:scale-[0.94] " +
        (active
          ? "border-accent/50 bg-gradient-to-b from-accent/25 to-accent2/15 text-[#a8bfff] " +
            "shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_0_14px_rgba(61,127,255,0.22)]"
          : "border-line/80 bg-surface/70 text-dim hover:-translate-y-[1px] hover:border-line2 hover:bg-raise/70 hover:text-ink")
      }
    >
      {children}
      {count != null ? (
        <span
          className={
            "rounded-md px-1 font-mono text-[9.5px] tabular-nums leading-[14px] transition-colors " +
            (active ? "bg-white/10 text-[#c3d2ff]" : "bg-black/25 text-faint group-hover/chip:text-dim")
          }
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

/** Language segment button — lives in the compact segmented control at the bar's right edge. */
function LangSeg({
  active,
  onPick,
  children,
}: {
  active: boolean;
  onPick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      onMouseDown={(e) => {
        e.preventDefault();
        onPick();
      }}
      className={
        "rounded-full px-2 py-[3px] font-mono text-[10px] font-semibold uppercase tracking-wide " +
        "transition-all duration-150 " +
        (active
          ? "bg-accent/25 text-[#a8bfff] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
          : "text-faint hover:text-ink")
      }
    >
      {children}
    </button>
  );
}

export function SearchSelect({
  id,
  value,
  onChange,
  options,
  placeholder,
  emptyHint = "No matches",
  disabled,
  metaWhenClosed,
  warn,
  facets,
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
  /** Amber "required" accent on the field (missing destination picks etc.). */
  warn?: boolean;
  /** Facet bar at the top of the list: clickable chips for every `group` (niche) and every
   *  distinct `tag` (language) with counts — built for catalogs that will keep growing. Chip
   *  filters compose with the typed query. */
  facets?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; width: number; top: number; up: boolean } | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [groupFilter, setGroupFilter] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  // Measured content height → the list animates its size on every filter change (height:auto
  // can't transition, so an explicit pixel height is kept in sync via ResizeObserver).
  const [listH, setListH] = useState<number | null>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const LIST_MAX_H = 288; // = max-h-72
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
  // Searchable by label, meta, value (fanpages: the page id), group (landing niche) and the
  // exact tag ("es" → Spanish landings without also matching every label containing "es").
  // Facet chips (group / tag) compose with the typed query.
  const filtered = opts.filter(
    (o) =>
      (!groupFilter || o.group === groupFilter) &&
      (!tagFilter || o.tag === tagFilter) &&
      (!q ||
        o.label.toLowerCase().includes(q) ||
        o.meta?.toLowerCase().includes(q) ||
        o.value.toLowerCase().includes(q) ||
        o.group?.toLowerCase().includes(q) ||
        o.tag?.toLowerCase() === q),
  );

  // Facet inventories with counts — stable totals so chips don't jump around while filtering.
  const groupFacets: Array<[string, number]> = [];
  const tagFacets: Array<[string, number]> = [];
  if (facets) {
    const gc = new Map<string, number>();
    const tc = new Map<string, number>();
    for (const o of opts) {
      if (o.group) gc.set(o.group, (gc.get(o.group) ?? 0) + 1);
      if (o.tag) tc.set(o.tag, (tc.get(o.tag) ?? 0) + 1);
    }
    groupFacets.push(...gc);
    tagFacets.push(...tc);
  }

  function closeList() {
    setOpen(false);
    setQuery("");
    setGroupFilter(null);
    setTagFilter(null);
    setListH(null); // reopening starts at natural size (no stale height to glide from)
  }

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

  // Follow the content's real height (chip/query filtering, remounting cascades) so the list
  // GLIDES to its new size instead of snapping. The observed wrapper is stable across the
  // cascade remounts; height resets on close so reopening starts from natural size.
  useEffect(() => {
    if (!open) return;
    const el = innerRef.current;
    if (!el) return;
    // No sync measure: ResizeObserver delivers the initial size asynchronously on observe(),
    // which also keeps setState out of the effect body (react-compiler cascade rule).
    const ro = new ResizeObserver(() => setListH(Math.min(el.offsetHeight, LIST_MAX_H)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  function pick(o: RichOption) {
    if (o.disabled) return; // unpickable row (e.g. fanka at its ad limit)
    onChange(o.value);
    closeList();
  }

  /** Next enabled index walking from `from` in `dir`; stays put when only disabled rows remain. */
  function stepActive(from: number, dir: 1 | -1) {
    let i = from + dir;
    while (i >= 0 && i < filtered.length && filtered[i].disabled) i += dir;
    return i >= 0 && i < filtered.length ? i : from;
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter")) {
      openList();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => stepActive(a, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => stepActive(a, -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[active]) pick(filtered[active]);
    } else if (e.key === "Escape") {
      closeList();
    }
  }

  return (
    <div
      ref={rootRef}
      className="relative"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          closeList();
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
          "h-9 w-full rounded-lg border bg-surface2 pl-8 text-[13px] text-ink " +
          "placeholder:text-faint outline-none transition-[border-color,box-shadow] duration-150 " +
          "disabled:opacity-40 disabled:cursor-not-allowed " +
          (warn
            ? "border-warn/60 hover:border-warn/80 focus:border-warn focus:ring-2 focus:ring-warn/15 "
            : "border-line hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15 ") +
          // Room on the right for the status tag (+ the clear button beside it) so a picked
          // option's label truncates cleanly instead of running under them.
          (!open && selected?.tag ? "pr-24" : "pr-8")
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
              {facets && (groupFacets.length > 0 || tagFacets.length > 1) ? (
                <div className="relative border-b border-line px-2.5 pb-2.5 pt-2">
                  {/* Soft cockpit backdrop: raised gradient + a faint accent bloom top-left. */}
                  <span className="pointer-events-none absolute inset-0 bg-gradient-to-b from-raise/60 to-transparent" />
                  <span className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_12%_0%,rgba(61,127,255,0.10),transparent_55%)]" />
                  <div className="relative flex items-start justify-between gap-2">
                    <div className="flex flex-1 flex-wrap gap-1.5">
                      <NicheChip
                        active={!groupFilter}
                        onPick={() => {
                          setGroupFilter(null);
                          setActive(0);
                        }}
                      >
                        All
                      </NicheChip>
                      {groupFacets.map(([g, n]) => (
                        <NicheChip
                          key={g}
                          active={groupFilter === g}
                          count={n}
                          onPick={() => {
                            setGroupFilter((cur) => (cur === g ? null : g));
                            setActive(0);
                          }}
                        >
                          {g}
                        </NicheChip>
                      ))}
                    </div>
                    {tagFacets.length > 1 ? (
                      <div className="flex shrink-0 items-center gap-0.5 self-start rounded-full border border-line bg-surface p-[3px] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                        <LangSeg
                          active={!tagFilter}
                          onPick={() => {
                            setTagFilter(null);
                            setActive(0);
                          }}
                        >
                          All
                        </LangSeg>
                        {tagFacets.map(([t]) => (
                          <LangSeg
                            key={t}
                            active={tagFilter === t}
                            onPick={() => {
                              setTagFilter((cur) => (cur === t ? null : t));
                              setActive(0);
                            }}
                          >
                            {t}
                          </LangSeg>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
              <div
                ref={listRef}
                style={listH != null ? { height: listH } : undefined}
                className="max-h-72 overflow-y-auto transition-[height] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
              >
                <div ref={innerRef}>
                  {/* Keyed by the chip filters: flipping a chip remounts the rows so the stagger
                      cascade replays; typing keeps the DOM stable (no flashing while searching). */}
                  <div key={`${groupFilter ?? ""}|${tagFilter ?? ""}`} className="p-1">
            {filtered.length === 0 ? (
              <div className="animate-pop-in flex flex-col items-start gap-1.5 px-3 py-3">
                <p className="text-[12px] text-faint">{emptyHint}</p>
                {groupFilter || tagFilter ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setGroupFilter(null);
                      setTagFilter(null);
                      setActive(0);
                    }}
                    className="text-[11.5px] font-medium text-[#9db8ff] transition-colors hover:text-ink"
                  >
                    Clear filters
                  </button>
                ) : null}
              </div>
            ) : (
              filtered.map((o, i) => (
                <Fragment key={o.value}>
                  {/* Section header whenever the (contiguous) group changes — landing niches etc.
                      Headers are decoration only: keyboard nav walks the flat filtered list.
                      Hidden while a niche chip is active (one group → the chip IS the header). */}
                  {o.group && !groupFilter && (i === 0 || filtered[i - 1].group !== o.group) ? (
                    <p
                      style={{ animationDelay: `${Math.min(i, 14) * 16}ms` }}
                      className="animate-row-in px-2.5 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-faint"
                    >
                      {o.group}
                    </p>
                  ) : null}
                  {o.subLabel ? (
                  // Two-line option: label on top; the muted sub-line (e.g. account id) + status
                  // tag below — lets long names + id + a FARM marker all fit without truncation.
                  <div
                    style={{ animationDelay: `${Math.min(i, 14) * 16}ms` }}
                    data-idx={i}
                    role="option"
                    aria-selected={o.value === value}
                    aria-disabled={o.disabled || undefined}
                    onMouseDown={(e) => {
                      e.preventDefault(); // keep focus in the search input either way
                      pick(o);
                    }}
                    onMouseEnter={() => {
                      if (!o.disabled) setActive(i);
                    }}
                    className={
                      "animate-row-in flex flex-col gap-0.5 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors duration-100 " +
                      (o.disabled
                        ? "cursor-not-allowed text-dim opacity-40"
                        : "cursor-pointer " + (i === active ? "bg-accent/10 text-ink" : "text-dim"))
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
                    style={{ animationDelay: `${Math.min(i, 14) * 16}ms` }}
                    data-idx={i}
                    role="option"
                    aria-selected={o.value === value}
                    aria-disabled={o.disabled || undefined}
                    onMouseDown={(e) => {
                      e.preventDefault(); // keep focus in the search input either way
                      pick(o);
                    }}
                    onMouseEnter={() => {
                      if (!o.disabled) setActive(i);
                    }}
                    className={
                      "animate-row-in flex items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-[13px] transition-colors duration-100 " +
                      (o.disabled
                        ? "cursor-not-allowed text-dim opacity-40"
                        : "cursor-pointer " + (i === active ? "bg-accent/10 text-ink" : "text-dim"))
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
                  )}
                </Fragment>
              ))
            )}
                  </div>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
