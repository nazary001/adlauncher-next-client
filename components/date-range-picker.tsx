"use client";

// The report date picker — replaces the native <input type="date">, whose calendar the browser
// draws in the OS language, one day at a time. This one is English by construction
// (lib/date-range.ts), picks a day or a RANGE, and is built for going through days fast:
//   ‹ ›           move the picked day / range back and forward by its own length
//   presets       Today … Last month, each showing the days it means right now
//   two months    click a start, click an end (the ribbon previews it); double-click = that one day
//   From / To     typed: 2026-09-18 · 18.09 · 18/09/26 · Sep 18 · today · yesterday
//   month title   jumps across months and years
//   keyboard      arrows / PageUp·PageDown (Shift = a year) / Home·End move, Enter picks and then
//                 applies, Esc steps back; T and Y are Today and Yesterday. Letter keys are read
//                 by POSITION (event.code): the team types on Russian / Ukrainian layouts, where
//                 the same physical keys send е / н / в / х / ъ
// "Today" is whatever day the caller says it is — the picker reads no clock and no timezone.
// A preset stays a preset (relative) for the caller; hand-picked days are handed back as days.

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { CalendarIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from "./icons";
import {
  MONTH_NAMES,
  RANGE_PRESETS,
  WEEKDAY_HEADS,
  addDays,
  addMonths,
  diffDays,
  formatDay,
  formatMonth,
  formatRange,
  inRange,
  matchPreset,
  monthEnd,
  monthGrid,
  monthOf,
  monthStart,
  orderedRange,
  parseDateInput,
  presetEmpty,
  presetLabel,
  presetRange,
  rangeDays,
  resolveSel,
  shiftRange,
  startOfWeek,
  type DateRange,
  type RangePresetId,
  type RangeSel,
} from "@/lib/date-range";

export type DateRangePickerProps = {
  sel: RangeSel;
  /** Rolling presets end on today (true) or on yesterday, the last closed day. */
  includeToday: boolean;
  /** Whose "today" it is, `YYYY-MM-DD`. Nothing after it can be picked. */
  today: string;
  /** The first day there is data for. */
  min?: string;
  /** The longest range, in days. */
  maxDays?: number;
  onChange: (sel: RangeSel, includeToday: boolean) => void;
  /** A line under the calendar, e.g. whose days these are. */
  note?: string;
  /** Page-level keys while the picker is closed: `[` `]` move the range, `D` opens the calendar. */
  hotkeys?: boolean;
};

const WIDE = "(min-width: 1024px)";
const subscribeWide = (cb: () => void) => {
  const mq = window.matchMedia(WIDE);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};
const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
const dayCount = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

const ring = "outline-none focus-visible:ring-2 focus-visible:ring-[#FFFC00]/60";
const navBtn = `flex h-7 w-7 items-center justify-center rounded-md text-dim transition-colors hover:bg-raise hover:text-ink disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent ${ring}`;

export function DateRangePicker({ sel, includeToday, today, min, maxDays = 31, onChange, note, hotkeys = false }: DateRangePickerProps) {
  const range = resolveSel(sel, today, { includeToday, min, maxDays });
  const bounds = { min, max: today, maxDays };
  const back = shiftRange(range, -1, bounds);
  const forward = shiftRange(range, 1, bounds);

  const rootRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Two months side by side where there is room for them; the server render never shows the popover.
  const twoPane = useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches, () => true);

  const [open, setOpen] = useState(false);
  // The popover works on a DRAFT: nothing is asked of the server until Apply (a range is a read per day).
  const [draft, setDraft] = useState<DateRange>(range);
  /** The first click of a range, waiting for the second. */
  const [anchor, setAnchor] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  /** The month in the RIGHT pane (the only pane on a narrow screen). */
  const [view, setView] = useState(monthOf(range.to));
  const [focusDay, setFocusDay] = useState(range.to);
  const [touched, setTouched] = useState(false);
  /** The year the month menu shows; null = the menu is closed. */
  const [menuYear, setMenuYear] = useState<number | null>(null);
  const [text, setText] = useState({ from: range.from, to: range.to });
  const [textError, setTextError] = useState<"from" | "to" | null>(null);

  const firstPane = twoPane ? addMonths(view, -1) : view;
  const canPrev = !min || firstPane > monthOf(min);
  const canNext = view < monthOf(today);

  const show = (r: DateRange) => {
    setDraft(r);
    setText({ from: r.from, to: r.to });
    setTextError(null);
  };
  /** Pages the months so `day` is on screen. */
  const reveal = (day: string) => {
    const ym = monthOf(day);
    if (ym < firstPane) setView(twoPane ? addMonths(ym, 1) : ym);
    else if (ym > view) setView(ym);
  };
  const inBounds = (day: string) => (day > today ? today : min && day < min ? min : day);
  /** ‹ › over the months. The roving day follows the page, so the grid always has a Tab stop. */
  const pageMonth = (dir: -1 | 1) => {
    const next = addMonths(view, dir);
    setView(next);
    const panes = twoPane ? [addMonths(next, -1), next] : [next];
    if (panes.includes(monthOf(focusDay))) return;
    const ym = dir < 0 ? panes[0] : panes[panes.length - 1];
    const day = `${ym}-${focusDay.slice(8)}`;
    setFocusDay(inBounds(day > monthEnd(ym) ? monthEnd(ym) : day));
  };
  const openPicker = () => {
    show(range);
    setAnchor(null);
    setHover(null);
    setView(monthOf(range.to));
    setFocusDay(range.to);
    setTouched(false);
    setMenuYear(null);
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus({ preventScroll: true });
  };
  const commit = (next: RangeSel, withToday = includeToday) => {
    onChange(next, withToday);
    close();
  };
  // Untouched = the same selection stays (a preset stays a preset); touched = these exact days.
  const apply = () => (touched ? commit({ kind: "custom", ...draft }) : close());

  const dayDisabled = (day: string) => day > today || Boolean(min && day < min) || (anchor != null && Math.abs(diffDays(anchor, day)) >= maxDays);

  const clickDay = (day: string) => {
    if (dayDisabled(day)) return;
    setTouched(true);
    setFocusDay(day);
    if (anchor == null) {
      setAnchor(day);
      show({ from: day, to: day });
    } else {
      show(orderedRange(anchor, day));
      setAnchor(null);
      setHover(null);
    }
  };

  const moveFocus = (to: string) => {
    let day = inBounds(to);
    if (anchor && Math.abs(diffDays(anchor, day)) >= maxDays) day = addDays(anchor, (maxDays - 1) * Math.sign(diffDays(anchor, day)));
    setFocusDay(day);
    if (anchor) setHover(day);
    reveal(day);
  };

  const onGridKey = (e: React.KeyboardEvent) => {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key in step) moveFocus(addDays(focusDay, step[e.key]));
    else if (e.key === "PageUp" || e.key === "PageDown") {
      const ym = addMonths(monthOf(focusDay), (e.key === "PageUp" ? -1 : 1) * (e.shiftKey ? 12 : 1));
      const day = `${ym}-${focusDay.slice(8)}`;
      moveFocus(day > monthEnd(ym) ? monthEnd(ym) : day);
    } else if (e.key === "Home") moveFocus(startOfWeek(focusDay));
    else if (e.key === "End") moveFocus(addDays(startOfWeek(focusDay), 6));
    else if (e.key === "Enter") {
      // Enter on an end of a range just picked confirms it; anywhere else it picks the day. Space is
      // left to the button's own click — Firefox fires that on keyup whatever keydown prevented.
      if (anchor == null && touched && (focusDay === draft.from || focusDay === draft.to)) apply();
      else clickDay(focusDay);
    } else return;
    e.preventDefault();
  };

  /** Esc: out of the month menu, then out of a half-picked range, then out of the picker. */
  const stepBack = () => {
    if (menuYear != null) setMenuYear(null);
    else if (anchor != null) {
      setAnchor(null);
      setHover(null);
      setTouched(false);
      show(range);
    } else close();
  };

  const commitText = (which: "from" | "to", thenApply: boolean) => {
    if (text[which].trim() === draft[which] && !thenApply) return;
    const day = parseDateInput(text[which], today);
    if (!day || day > today || (min && day < min)) return setTextError(which);
    let next: DateRange = which === "from" ? { from: day, to: draft.to < day ? day : draft.to } : { from: draft.from > day ? day : draft.from, to: day };
    // Over the cap: the end just typed stays, the other one follows it.
    if (rangeDays(next) > maxDays) next = which === "from" ? { from: day, to: addDays(day, maxDays - 1) } : { from: addDays(day, -(maxDays - 1)), to: day };
    show(next);
    setAnchor(null);
    setHover(null);
    setTouched(true);
    setFocusDay(day);
    reveal(day);
    if (thenApply) commit({ kind: "custom", ...next });
  };

  // The document listeners read the latest render through a ref, so each is bound once.
  const live = useRef({ back, forward, onChange, includeToday, openPicker, stepBack, commit });
  useEffect(() => {
    live.current = { back, forward, onChange, includeToday, openPicker, stepBack, commit };
  });

  // While open: an outside click is Cancel; Esc / T / Y answer from the DOCUMENT — focus can leave
  // the popover (Tab, a button that went disabled under it) and the keys must still work.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        return live.current.stepBack();
      }
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === "KeyT") live.current.commit({ kind: "preset", id: "today" });
      else if (e.code === "KeyY") live.current.commit({ kind: "preset", id: "yesterday" });
      else return;
      e.preventDefault();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // The roving focus follows the focused day — but only when focus is in the grid already or is
  // nowhere useful (just opened, or the control under it went disabled). It never pulls focus off a
  // field being typed in or a button just pressed. No day to land on → the dialog itself.
  useEffect(() => {
    const pop = popRef.current;
    if (!open || menuYear != null || !pop) return;
    const active = document.activeElement;
    const adrift = !(active instanceof HTMLElement) || active === document.body || active === pop || !pop.contains(active) || (active as HTMLButtonElement).disabled === true;
    if (!adrift && !active.hasAttribute("data-day")) return;
    const target = pop.querySelector<HTMLButtonElement>(`[data-day="${focusDay}"]`);
    (target && !target.disabled ? target : pop).focus({ preventScroll: true });
  }, [open, focusDay, view, menuYear, twoPane]);

  // Anchored to the trigger's right edge; pulled back inside the viewport when that would cut it
  // off. Measured from the (unanimated) root and the popover's layout width — its own rect is
  // still scaled by the pop-in animation at this point.
  useLayoutEffect(() => {
    const el = popRef.current;
    const root = rootRef.current;
    if (!open || !el || !root) return;
    const left = root.getBoundingClientRect().right - el.offsetWidth;
    el.style.setProperty("--dp-shift", left < 12 ? `${Math.ceil(12 - left)}px` : "0px");
  }, [open, twoPane]);

  // Page-level keys while closed.
  useEffect(() => {
    if (!hotkeys || open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const c = live.current;
      if (e.code === "BracketLeft" && c.back) c.onChange({ kind: "custom", ...c.back }, c.includeToday);
      else if (e.code === "BracketRight" && c.forward) c.onChange({ kind: "custom", ...c.forward }, c.includeToday);
      else if (e.code === "KeyD") {
        // The toolbar is not sticky: from far down the table the calendar would open off screen.
        rootRef.current?.scrollIntoView({ block: "nearest" });
        c.openPicker();
      }
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [hotkeys, open]);

  const painted = anchor != null && hover != null && !dayDisabled(hover) ? orderedRange(anchor, hover) : draft;
  // Untouched, the picked preset is the one lit (cut to the data several presets are the same days).
  const draftPreset = anchor != null ? null : !touched && sel.kind === "preset" ? sel.id : matchPreset(draft, today, { includeToday, min });
  const n = rangeDays(range);
  const stepLabel = n === 1 ? "day" : dayCount(n);

  const pane = (ym: string) => (
    <div key={ym} className="w-[252px]">
      <div className="grid grid-cols-7" aria-hidden="true">
        {WEEKDAY_HEADS.map((h, i) => (
          <span key={h} className={"h-7 text-center text-[10px] font-medium uppercase leading-7 tracking-[0.1em] " + (i > 4 ? "text-faint/70" : "text-faint")}>
            {h}
          </span>
        ))}
      </div>
      <div role="grid" aria-label={formatMonth(ym)}>
        {monthGrid(ym).map((week) => (
          <div key={week[0]} role="row" className="grid grid-cols-7">
            {week.map((day, col) => {
              if (monthOf(day) !== ym) return <span key={day} role="gridcell" className="h-9" />;
              const isFrom = day === painted.from;
              const isTo = day === painted.to;
              const end = isFrom || isTo;
              const inside = inRange(day, painted);
              const disabled = dayDisabled(day);
              const edgeL = col === 0 || day === monthStart(ym);
              const edgeR = col === 6 || day === monthEnd(ym);
              return (
                <div key={day} role="gridcell" aria-selected={inside} className="relative h-9">
                  {inside && painted.from !== painted.to ? (
                    <span
                      aria-hidden="true"
                      className={"absolute inset-y-[3px] bg-[#FFFC00]/[0.13] " + (isFrom ? "left-1/2 right-0" : isTo ? "left-0 right-1/2" : "inset-x-0" + (edgeL ? " rounded-l-full" : "") + (edgeR ? " rounded-r-full" : ""))}
                    />
                  ) : null}
                  <button
                    type="button"
                    data-day={day}
                    tabIndex={day === focusDay ? 0 : -1}
                    disabled={disabled}
                    aria-label={formatDay(day, { weekday: true }) + (day === today ? " (today)" : "")}
                    onClick={() => clickDay(day)}
                    onDoubleClick={() => !disabled && commit({ kind: "custom", from: day, to: day })}
                    onMouseEnter={() => anchor != null && setHover(day)}
                    className={
                      `relative mx-auto mt-[3px] flex h-[30px] w-[30px] items-center justify-center rounded-lg font-mono text-[12px] tabular-nums transition-colors ${ring} ` +
                      (end
                        ? "bg-[#FFFC00] font-semibold text-[#07080b] shadow-[0_0_14px_rgba(255,252,0,0.25)]"
                        : disabled
                          ? "cursor-not-allowed text-faint/35"
                          : inside
                            ? "text-[#f3f0a3] hover:bg-[#FFFC00]/20"
                            : "text-dim hover:bg-raise hover:text-ink")
                    }
                  >
                    {Number(day.slice(8))}
                    {day === today ? <span aria-hidden="true" className={"absolute bottom-[3px] h-[3px] w-[3px] rounded-full " + (end ? "bg-[#07080b]" : "bg-[#FFFC00]")} /> : null}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );

  const monthMenu = (year: number) => {
    const minYm = min ? monthOf(min) : "0000-00";
    const maxYm = monthOf(today);
    return (
      <div className="flex w-full flex-col gap-3 py-1 lg:w-[528px]">
        <div className="flex items-center justify-center gap-3">
          <button type="button" aria-label="Previous year" disabled={`${year - 1}-12` < minYm} onClick={() => setMenuYear(year - 1)} className={navBtn}>
            <ChevronLeftIcon className="h-4 w-4" />
          </button>
          <span className="w-16 text-center font-mono text-[14px] tabular-nums text-ink">{year}</span>
          <button type="button" aria-label="Next year" disabled={`${year + 1}-01` > maxYm} onClick={() => setMenuYear(year + 1)} className={navBtn}>
            <ChevronRightIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
          {MONTH_NAMES.map((name, i) => {
            const ym = `${year}-${String(i + 1).padStart(2, "0")}`;
            const shown = ym === view || (twoPane && ym === firstPane);
            return (
              <button
                key={ym}
                type="button"
                disabled={ym < minYm || ym > maxYm}
                onClick={() => {
                  // The picked month goes to the left pane, unless it is the running month (nothing is to its right).
                  setView(twoPane && ym < maxYm ? addMonths(ym, 1) : ym);
                  const first = monthStart(ym);
                  setFocusDay(min && first < min ? min : first);
                  setMenuYear(null);
                }}
                className={`h-10 rounded-lg border text-[12.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${ring} ` + (shown ? "border-[#FFFC00]/40 bg-[#FFFC00]/10 text-[#f3f0a3]" : "border-line bg-surface2 text-dim hover:border-line2 hover:text-ink")}
              >
                {name}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  const field = (which: "from" | "to") => (
    <label className={"flex min-w-0 flex-1 items-center gap-2 rounded-lg border bg-surface2 px-2.5 transition-colors " + (textError === which ? "border-danger/70" : "border-line focus-within:border-[#FFFC00]/50")}>
      <span className="text-[10px] uppercase tracking-[0.14em] text-faint">{which}</span>
      <input
        value={text[which]}
        onChange={(e) => {
          setText((t) => ({ ...t, [which]: e.target.value }));
          setTextError(null);
        }}
        onBlur={() => commitText(which, false)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          commitText(which, true);
        }}
        spellCheck={false}
        autoComplete="off"
        placeholder="2026-09-18"
        aria-label={which === "from" ? "First day" : "Last day"}
        aria-invalid={textError === which}
        className="h-8 w-full min-w-0 bg-transparent font-mono text-[12px] tabular-nums text-ink outline-none placeholder:text-faint/60"
      />
    </label>
  );

  return (
    <div ref={rootRef} className="relative flex scroll-mt-40 items-center">
      <button
        type="button"
        disabled={!back}
        onClick={() => back && onChange({ kind: "custom", ...back }, includeToday)}
        aria-label={`Previous ${stepLabel}`}
        title={`Previous ${stepLabel}${hotkeys ? "  [" : ""}`}
        className={navBtn}
      >
        <ChevronLeftIcon className="h-4 w-4" />
      </button>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close(false) : openPicker())}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={hotkeys ? "Pick dates  D" : undefined}
        className={`flex h-7 items-center gap-2 whitespace-nowrap rounded-md border px-2.5 text-[11.5px] transition-colors ${ring} ` + (open ? "border-[#FFFC00]/50 bg-[#FFFC00]/10" : "border-line bg-surface2 hover:border-line2")}
      >
        <CalendarIcon className="h-3.5 w-3.5 text-[#f3f0a3]" />
        {sel.kind === "preset" && sel.id !== "today" && sel.id !== "yesterday" ? <span className="font-medium text-[#f3f0a3]">{presetLabel(sel.id)}</span> : null}
        <span suppressHydrationWarning className="font-mono tabular-nums text-ink">
          {formatRange(range)}
        </span>
        {n > 1 ? (
          <span suppressHydrationWarning className="rounded bg-black/30 px-1 font-mono text-[10px] tabular-nums text-dim">
            {`${n}d`}
          </span>
        ) : null}
        <ChevronDownIcon className={"h-3 w-3 text-faint transition-transform " + (open ? "rotate-180" : "")} />
      </button>
      <button
        type="button"
        disabled={!forward}
        onClick={() => forward && onChange({ kind: "custom", ...forward }, includeToday)}
        aria-label={`Next ${stepLabel}`}
        title={`Next ${stepLabel}${hotkeys ? "  ]" : ""}`}
        className={navBtn}
      >
        <ChevronRightIcon className="h-4 w-4" />
      </button>

      {open ? (
        <>
          <div className="fixed inset-0 z-40 bg-black/55 sm:hidden" aria-hidden="true" onClick={() => setOpen(false)} />
          <div
            ref={popRef}
            role="dialog"
            aria-label="Report dates"
            tabIndex={-1}
            className={
              "animate-pop-in z-50 flex flex-col border border-line2 bg-surface text-left shadow-[0_28px_90px_rgba(0,0,0,0.65)] outline-none " +
              "fixed inset-x-0 bottom-0 max-h-[90dvh] overflow-y-auto rounded-t-2xl " +
              "sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-[calc(var(--dp-shift,0px)*-1)] sm:top-full sm:mt-2 sm:max-h-none sm:overflow-visible sm:rounded-2xl"
            }
          >
            <div className="flex flex-col sm:flex-row">
              <div className="flex shrink-0 flex-col border-b border-line sm:w-[196px] sm:border-b-0 sm:border-r">
                <div className="flex gap-1 overflow-x-auto p-2 sm:flex-col sm:gap-0.5 sm:overflow-visible">
                  {RANGE_PRESETS.map((p) => {
                    const r = presetRange(p.id, today, { includeToday, min });
                    const empty = presetEmpty(p.id, today, { includeToday, min });
                    const active = draftPreset === p.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        disabled={empty}
                        onClick={() => commit({ kind: "preset", id: p.id as RangePresetId })}
                        className={
                          `flex shrink-0 items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${ring} ` +
                          (active ? "bg-[#FFFC00]/10 text-[#f3f0a3]" : "text-dim hover:bg-raise hover:text-ink")
                        }
                      >
                        <span className="whitespace-nowrap font-medium">{p.label}</span>
                        <span className={"hidden whitespace-nowrap font-mono text-[10px] tabular-nums sm:inline " + (active ? "text-[#f3f0a3]/70" : "text-faint")}>{empty ? "no data" : formatRange(r).replace(/, \d{4}$/, "")}</span>
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={includeToday}
                  onClick={() => {
                    onChange(sel, !includeToday);
                    // The draft follows a picked preset to its new days; hand-picked days stay put.
                    if (!touched && sel.kind === "preset") show(resolveSel(sel, today, { includeToday: !includeToday, min, maxDays }));
                  }}
                  className={`mx-2 mb-2 mt-auto flex items-center justify-between gap-3 rounded-lg border border-line bg-surface2 px-2.5 py-2 text-left transition-colors hover:border-line2 ${ring}`}
                >
                  <span className="min-w-0">
                    <span className="block text-[11.5px] font-medium text-ink">Include today</span>
                    <span className="block text-[10px] leading-snug text-faint">{includeToday ? "rolling ranges end today" : "rolling ranges end yesterday"}</span>
                  </span>
                  <span aria-hidden="true" className={"relative h-4 w-7 shrink-0 rounded-full transition-colors " + (includeToday ? "bg-[#FFFC00]/80" : "bg-line2")}>
                    <span className={"absolute top-0.5 h-3 w-3 rounded-full bg-[#07080b] transition-[left] " + (includeToday ? "left-3.5" : "left-0.5")} />
                  </span>
                </button>
              </div>

              <div className="flex min-w-0 flex-col gap-2 p-3">
                <div className="flex items-center gap-2">
                  {field("from")}
                  <span className="text-faint" aria-hidden="true">
                    →
                  </span>
                  {field("to")}
                </div>
                {/* Always there, at a fixed height: a line appearing on blur would shift the grid under a click already on its way. */}
                <p role={textError ? "alert" : undefined} className={"min-h-[30px] text-[10.5px] leading-[15px] lg:min-h-[15px] " + (textError ? "text-danger" : "text-faint")}>
                  {textError ? `Not a day ${min ? `between ${formatDay(min, { year: false })} and today` : "up to today"} — try 2026-09-18, 18.09 or Sep 18.` : "Type a day: 2026-09-18 · 18.09 · Sep 18 · today"}
                </p>

                <div className="flex items-center justify-between">
                  <button type="button" aria-label="Previous month" disabled={!canPrev || menuYear != null} onClick={() => pageMonth(-1)} className={navBtn}>
                    <ChevronLeftIcon className="h-4 w-4" />
                  </button>
                  <div className="flex flex-1 items-center justify-around">
                    {(twoPane ? [firstPane, view] : [view]).map((ym) => (
                      <button
                        key={ym}
                        type="button"
                        onClick={() => setMenuYear(menuYear != null ? null : Number(ym.slice(0, 4)))}
                        aria-expanded={menuYear != null}
                        title="Jump to a month"
                        className={`flex items-center gap-1 rounded-md px-2 py-1 text-[12.5px] font-semibold text-ink transition-colors hover:bg-raise ${ring}`}
                      >
                        {formatMonth(ym)}
                        <ChevronDownIcon className={"h-3 w-3 text-faint transition-transform " + (menuYear != null ? "rotate-180" : "")} />
                      </button>
                    ))}
                  </div>
                  <button type="button" aria-label="Next month" disabled={!canNext || menuYear != null} onClick={() => pageMonth(1)} className={navBtn}>
                    <ChevronRightIcon className="h-4 w-4" />
                  </button>
                </div>

                {menuYear != null ? (
                  monthMenu(menuYear)
                ) : (
                  <div className="flex justify-center gap-6" onKeyDown={onGridKey} onMouseLeave={() => setHover(null)}>
                    {(twoPane ? [firstPane, view] : [view]).map(pane)}
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line px-3 py-2.5">
              <p className="min-w-0 flex-1 text-[11px] leading-snug text-dim">
                {anchor != null ? (
                  <>
                    <span className="text-[#f3f0a3]">Pick the last day</span>
                    {` — or apply ${formatDay(anchor, { year: false })} alone. Up to ${maxDays} days.`}
                  </>
                ) : (
                  <>
                    <span className="font-mono tabular-nums text-ink">{formatRange(painted)}</span>
                    {` · ${dayCount(rangeDays(painted))}`}
                    {draftPreset ? ` · ${presetLabel(draftPreset)}` : ""}
                  </>
                )}
                {note ? <span className="block text-[10px] text-faint">{note}</span> : null}
              </p>
              <button type="button" onClick={() => close()} className={`h-8 rounded-lg border border-line bg-surface2 px-3 text-[12px] font-medium text-dim transition-colors hover:border-line2 hover:text-ink ${ring}`}>
                Cancel
              </button>
              <button type="button" onClick={apply} className={`h-8 rounded-lg bg-[#FFFC00] px-4 text-[12px] font-semibold text-[#07080b] transition-[filter] hover:brightness-95 ${ring}`}>
                Apply
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
