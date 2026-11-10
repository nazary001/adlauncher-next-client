"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, SearchIcon, XIcon } from "./icons";
import type { RichOption } from "@/lib/catalog";
import { facetBar, filterOptions } from "@/lib/option-filter";

// The faceted menu (niches + languages) in numbers. Wide enough, it is a column of niches beside the
// list — every niche one aligned line, the menu one fixed size; narrower (the dense grid pickers, a
// field at the screen's edge) the niches are a single line of chips that scrolls sideways.
const RAIL_MENU_W = 680; // a menu with a niche column opens at least this wide (viewport allowing)
const RAIL_MIN_W = 560; // …and below this there is no room for the column
const RAIL_W = 176;
const RAIL_ROW_H = 25;
const BODY_MAX_H = 384; // fifteen niches in sight without scrolling the column
const OPTION_H = 32;

/** Ref for a one-line strip: the mouse wheel scrolls it sideways (a native listener — React's wheel
 *  events are passive, and the page behind the menu must not scroll instead). */
function wheelX(el: HTMLDivElement | null) {
  if (!el) return;
  const onWheel = (e: WheelEvent) => {
    if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    e.preventDefault();
    el.scrollLeft += e.deltaY;
  };
  el.addEventListener("wheel", onWheel, { passive: false });
  return () => el.removeEventListener("wheel", onWheel);
}

/** A niche in the menu's left column: the name, and how many rows it would show right now (0 = dimmed,
 *  still in its place — the column never reshuffles under the hand). */
function RailItem({
  active,
  onPick,
  count,
  children,
}: {
  active: boolean;
  onPick: () => void;
  count: number;
  children: string;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      title={children}
      onMouseDown={(e) => {
        // preventDefault keeps focus in the search input (blur would close the list).
        e.preventDefault();
        onPick();
      }}
      className={
        "relative flex w-full items-center justify-between gap-2 rounded-md py-1 pl-2.5 pr-1.5 text-left " +
        "text-[11.5px] leading-[17px] transition-colors duration-100 " +
        (active
          ? "bg-accent/15 font-medium text-[#a8bfff]"
          : count === 0
            ? "text-faint/70 hover:bg-raise/50"
            : "text-dim hover:bg-raise/70 hover:text-ink")
      }
    >
      {active ? <span className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-accent" /> : null}
      <span className="truncate">{children}</span>
      <span
        className={
          "shrink-0 font-mono text-[10px] tabular-nums " +
          (active ? "text-[#c3d2ff]" : count === 0 ? "text-faint/50" : "text-faint")
        }
      >
        {count}
      </span>
    </button>
  );
}

/** Niche chip of the one-line strip (the narrow menu) — glassy pill with a count badge; active = accent
 *  gradient glow. */
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
        "group/chip flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-medium " +
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

/** Language segment button — lives in the compact segmented control above the list; the small number
 *  is how many rows that language would show under the picked niche and the typed query. */
function LangSeg({
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
        e.preventDefault();
        onPick();
      }}
      className={
        "flex shrink-0 items-baseline gap-1 whitespace-nowrap rounded-full px-2 py-[3px] font-mono text-[10px] " +
        "font-semibold uppercase tracking-wide transition-all duration-150 " +
        (active
          ? "bg-accent/25 text-[#a8bfff] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
          : count === 0
            ? "text-faint/50 hover:text-dim"
            : "text-faint hover:text-ink")
      }
    >
      {children}
      {count != null ? <span className="text-[9px] font-medium tabular-nums opacity-60">{count}</span> : null}
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
  tagQuery,
  size,
  accent,
  ariaLabel,
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
  /** Filters in the menu: every `group` (niche) as a line of the left column, every language
   *  (`segment`, else `tag`) as a segment above the list, each with the number of rows it would show —
   *  built for catalogs that keep growing (lib/option-filter). They compose with the typed query. */
  facets?: boolean;
  /** A typed query that IS a word of a tag filters by that tag alone ("pt" → the Portuguese rows).
   *  For a list whose tag is a language and whose labels would match it by accident — "Captcha"
   *  holds "pt". Off by default: every other list keeps matching such a query everywhere. */
  tagQuery?: boolean;
  /** "sm" = the dense table/grid variant (h-8, 12px) — the clone board's inline row pickers. */
  size?: "sm";
  /** Accent border: the value is the row's OWN pick (vs an inherited default). */
  accent?: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; width: number; top: number; up: boolean } | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [groupFilter, setGroupFilter] = useState<string | null>(null);
  const [segFilter, setSegFilter] = useState<string | null>(null);
  // Measured content height → the list animates its size on every filter change (height:auto
  // can't transition, so an explicit pixel height is kept in sync via ResizeObserver).
  const [listH, setListH] = useState<number | null>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const LIST_MAX_H = 288; // = max-h-72
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The list renders in a portal so it's never clipped by a modal's overflow. Position it in
  // viewport coords under the field (or above it when the space below is short — the menu with
  // niches and languages is the taller one, so it turns upward sooner).
  const computePos = useCallback(() => {
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return;
    const spaceBelow = window.innerHeight - r.bottom;
    const up = spaceBelow < (facets ? 440 : 280) && r.top > spaceBelow;
    setPos({ left: r.left, width: r.width, top: up ? r.top : r.bottom, up });
  }, [facets]);

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
  }, [open, computePos]);

  const opts: RichOption[] = options.map((o) =>
    typeof o === "string" ? { value: o, label: o } : o,
  );
  // Closed input shows the picked option's LABEL (+ its status tag) — value and label differ for
  // id-keyed options (fanpages); plain string catalogs are unaffected (value === label).
  // An unresolved pick (catalog still loading, or a stale stored id) falls back to the raw
  // value — EXCEPT bare id blobs (6+ digits): "1297336295903991" in the Account box reads as
  // noise, so id-keyed picks show the placeholder until their catalog arrives with a name.
  // String catalogs keep showing the pick instantly while their list loads (value IS the label).
  const selected = opts.find((o) => o.value === value);
  const displayValue = selected
    ? metaWhenClosed && selected.meta
      ? `${selected.label} · ${selected.meta}`
      : selected.label
    : /^\d{6,}$/.test(value)
      ? ""
      : value;
  // Searchable by label, meta, value (fanpages: the page id), group (landing niche) and the tag's
  // words ("es" → Spanish landings). The niche and the language picked in the menu compose with it.
  const filter = { query, group: groupFilter, segment: segFilter, tagQuery };
  const filtered = filterOptions(opts, filter);
  // The menu's niches and languages, each with the number of rows it would show right now.
  const bar = facets ? facetBar(opts, filter) : null;
  const groupFacets = bar && bar.groups.length > 1 ? bar.groups : [];
  const segFacets = bar && bar.segments.length > 1 ? bar.segments : [];
  const anyGroup = bar && groupFacets.length ? filterOptions(opts, { ...filter, group: null }).length : 0;

  function closeList() {
    setOpen(false);
    setQuery("");
    setGroupFilter(null);
    setSegFilter(null);
    setListH(null); // reopening starts at natural size (no stale height to glide from)
  }

  const sm = size === "sm";
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

  // The open menu's box. With niches to pick from it opens wide enough for their column (never narrower
  // than the field, never past the viewport's edge); the dense grid variant keeps its own width rule.
  let menu: { width: number; rail: boolean; bodyH: number } | null = null;
  if (open && pos) {
    const room = window.innerWidth - pos.left - 8;
    const width = sm
      ? Math.min(Math.max(pos.width, 320), room)
      : groupFacets.length
        ? Math.max(pos.width, Math.min(RAIL_MENU_W, room))
        : pos.width;
    // Room on the side the menu opens to, less its gap, a margin and the language row.
    const avail = (pos.up ? pos.top : window.innerHeight - pos.top) - 16 - (segFacets.length ? 38 : 0);
    const natural = Math.max(
      (groupFacets.length + 1) * RAIL_ROW_H + 8,
      opts.length * OPTION_H + groupFacets.length * RAIL_ROW_H + 8,
    );
    menu = {
      width,
      rail: groupFacets.length > 0 && width >= RAIL_MIN_W,
      bodyH: Math.min(natural, Math.max(160, Math.min(BODY_MAX_H, avail))),
    };
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
      <SearchIcon
        className={
          "pointer-events-none absolute top-1/2 -translate-y-1/2 text-faint " +
          (sm ? "left-2 h-3 w-3" : "left-2.5 h-3.5 w-3.5")
        }
      />
      <input
        id={id}
        ref={inputRef}
        role="combobox"
        aria-expanded={open}
        aria-controls={id ? `${id}-listbox` : undefined}
        autoComplete="off"
        spellCheck={false}
        aria-label={ariaLabel}
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
          (sm ? "h-8 rounded-md pl-7 text-[12px] " : "h-9 rounded-lg pl-8 text-[13px] ") +
          "w-full border bg-surface2 text-ink " +
          "placeholder:text-faint outline-none transition-[border-color,box-shadow] duration-150 " +
          "disabled:opacity-40 disabled:cursor-not-allowed " +
          (warn
            ? "border-warn/60 hover:border-warn/80 focus:border-warn focus:ring-2 focus:ring-warn/15 "
            : accent
              ? "border-accent/45 hover:border-accent/60 focus:border-accent/70 focus:ring-2 focus:ring-accent/15 "
              : "border-line hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15 ") +
          // Room on the right for the status tag (+ the clear button beside it) so a picked
          // option's label truncates cleanly instead of running under them.
          (!open && selected?.tag ? (sm ? "pr-[74px]" : "pr-24") : sm ? "pr-7" : "pr-8")
        }
      />
      {!open && selected?.tag ? (
        <span
          className={
            "pointer-events-none absolute top-1/2 -translate-y-1/2 font-mono tabular-nums " +
            (sm ? "right-7 text-[10.5px] " : "right-8 text-[11px] ") +
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
          className={
            "absolute top-1/2 -translate-y-1/2 rounded text-faint transition-colors hover:text-ink " +
            (sm ? "right-1.5 p-0.5" : "right-2 p-1")
          }
        >
          <XIcon className="h-3 w-3" />
        </button>
      ) : null}

      {open && pos && menu
        ? createPortal(
            <div
              onMouseDown={(e) => e.preventDefault()}
              style={{
                position: "fixed",
                left: pos.left,
                width: menu.width,
                ...(pos.up ? { bottom: window.innerHeight - pos.top + 6 } : { top: pos.top + 6 }),
                zIndex: 120,
              }}
              className={
                "overflow-hidden rounded-xl border border-line2 bg-surface shadow-[0_16px_40px_rgba(0,0,0,0.55)] " +
                (pos.up ? "animate-drop-in-up" : "animate-drop-in")
              }
            >
              {segFacets.length || (groupFacets.length && !menu.rail) ? (
                <div className="relative border-b border-line">
                  {/* Soft cockpit backdrop: raised gradient + a faint accent bloom top-left. */}
                  <span className="pointer-events-none absolute inset-0 bg-gradient-to-b from-raise/60 to-transparent" />
                  <span className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_12%_0%,rgba(61,127,255,0.10),transparent_55%)]" />
                  {segFacets.length ? (
                    // One row: the languages, and how much of the catalog the list shows now.
                    <div className="relative flex items-center gap-2 px-2 py-1.5">
                      <div
                        ref={wheelX}
                        data-facet="segments"
                        className="flex min-w-0 items-center gap-0.5 overflow-x-auto rounded-full border border-line bg-surface p-[3px] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] [scrollbar-width:none]"
                      >
                        <LangSeg
                          active={!segFilter}
                          onPick={() => {
                            setSegFilter(null);
                            setActive(0);
                          }}
                        >
                          All
                        </LangSeg>
                        {segFacets.map((f) => (
                          <LangSeg
                            key={f.name}
                            active={segFilter === f.name}
                            count={f.count}
                            onPick={() => {
                              setSegFilter((cur) => (cur === f.name ? null : f.name));
                              setActive(0);
                            }}
                          >
                            {f.name}
                          </LangSeg>
                        ))}
                      </div>
                      <span data-facet="shown" className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-faint">
                        {filtered.length === opts.length ? opts.length : `${filtered.length} / ${opts.length}`}
                      </span>
                    </div>
                  ) : null}
                  {groupFacets.length && !menu.rail ? (
                    // No room for the column: the niches on ONE line that scrolls sideways (wheel or
                    // drag) — never a cloud of wrapped chips pushing the list off the screen.
                    <div
                      ref={wheelX}
                      data-facet="strip"
                      className={
                        "relative flex gap-1.5 overflow-x-auto pl-2 pr-7 [scrollbar-width:none] " +
                        "[mask-image:linear-gradient(to_right,#000_calc(100%-28px),transparent)] " +
                        (segFacets.length ? "pb-2" : "py-2")
                      }
                    >
                      <NicheChip
                        active={!groupFilter}
                        count={anyGroup}
                        onPick={() => {
                          setGroupFilter(null);
                          setActive(0);
                        }}
                      >
                        All
                      </NicheChip>
                      {groupFacets.map((g) => (
                        <NicheChip
                          key={g.name}
                          active={groupFilter === g.name}
                          count={g.count}
                          onPick={() => {
                            setGroupFilter((cur) => (cur === g.name ? null : g.name));
                            setActive(0);
                          }}
                        >
                          {g.name}
                        </NicheChip>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {/* With the niche column the body is ONE fixed size: picking a niche never moves the
                  column under the pointer (a menu that opens upward would otherwise jump). */}
              <div className="flex" style={menu.rail ? { height: menu.bodyH } : undefined}>
                {menu.rail ? (
                  <div
                    data-facet="rail"
                    style={{ width: RAIL_W }}
                    className="shrink-0 overflow-y-auto border-r border-line bg-gradient-to-b from-raise/40 to-transparent p-1"
                  >
                    <RailItem
                      active={!groupFilter}
                      count={anyGroup}
                      onPick={() => {
                        setGroupFilter(null);
                        setActive(0);
                      }}
                    >
                      All
                    </RailItem>
                    {groupFacets.map((g) => (
                      <RailItem
                        key={g.name}
                        active={groupFilter === g.name}
                        count={g.count}
                        onPick={() => {
                          setGroupFilter((cur) => (cur === g.name ? null : g.name));
                          setActive(0);
                        }}
                      >
                        {g.name}
                      </RailItem>
                    ))}
                  </div>
                ) : null}
              <div
                ref={listRef}
                id={id ? `${id}-listbox` : undefined}
                role="listbox"
                style={menu.rail ? undefined : listH != null ? { height: listH } : undefined}
                className={
                  "min-w-0 flex-1 overflow-y-auto " +
                  (menu.rail ? "" : "max-h-72 transition-[height] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]")
                }
              >
                <div ref={innerRef}>
                  {/* Keyed by the menu's filters: picking a niche or a language remounts the rows so the
                      stagger cascade replays; typing keeps the DOM stable (no flashing while searching). */}
                  <div key={`${groupFilter ?? ""}|${segFilter ?? ""}`} className="p-1">
            {filtered.length === 0 ? (
              <div className="animate-pop-in flex flex-col items-start gap-1.5 px-3 py-3">
                <p className="text-[12px] text-faint">{emptyHint}</p>
                {groupFilter || segFilter ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setGroupFilter(null);
                      setSegFilter(null);
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
                      Headers are decoration only: keyboard nav walks the flat filtered list. It
                      sticks to the list's top while its rows scroll by, so a long list always says
                      which niche is on screen. Hidden while a niche is picked (it IS the header). */}
                  {o.group && !groupFilter && (i === 0 || filtered[i - 1].group !== o.group) ? (
                    <p
                      style={{ animationDelay: `${Math.min(i, 14) * 16}ms` }}
                      className="animate-row-in sticky top-0 z-[1] bg-surface px-2.5 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-faint"
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
                      "animate-row-in flex scroll-mt-8 flex-col gap-0.5 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors duration-100 " +
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
                      "animate-row-in flex scroll-mt-8 items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors duration-100 " +
                      (o.disabled
                        ? "cursor-not-allowed text-dim opacity-40"
                        : "cursor-pointer " + (i === active ? "bg-accent/10 text-ink" : "text-dim"))
                    }
                  >
                    <span className="truncate" title={o.label}>
                      {o.label}
                    </span>
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
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
