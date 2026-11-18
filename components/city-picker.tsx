"use client";

// Cities picker for TOOL launches (owner ask 18.11: «запуски на конкретный город»). Searches Meta's
// cities inside the card's countries (/api/geo/cities → Graph adgeolocation, cached server-side),
// debounced and only from 2 letters — every search is a request on one of the owner's FB tokens.
// Chips = the picked cities; the radius is a separate pick on the card (CITY_RADII).

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, XIcon } from "./icons";
import { type CityPick, MAX_CITIES, cityQuery, cityShortName } from "@/lib/city-targeting";

const DEBOUNCE_MS = 400;
/** Browser-side memo of answers (per country set + query) — retyping never re-asks the server. */
const memo = new Map<string, CityPick[]>();

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "done"; cities: CityPick[] }
  | { kind: "error"; message: string };

export function CityPicker({
  id,
  values,
  onChange,
  countries,
  disabledReason,
}: {
  id?: string;
  values: CityPick[];
  onChange: (v: CityPick[]) => void;
  /** The card's Geo (ISO-2) — the search is scoped to it. */
  countries: string[];
  /** Why the field cannot search now ("pick a country first" / World); null = it can. */
  disabledReason: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; width: number; top: number; up: boolean } | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // The last server answer, tagged with the query it answers — the visible state is DERIVED from it
  // (and the memo), so the search effect only ever sets state from its async callback.
  const [answer, setAnswer] = useState<{ key: string; state: State } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const cc = countries.filter((c) => c !== "WW").slice(0, 5).join(",");
  const q = cityQuery(query);
  const memoKey = q ? `${cc}|${q.toLowerCase()}` : "";
  const memoHit = memoKey ? memo.get(memoKey) : undefined;
  const state: State = !q
    ? { kind: "idle" }
    : memoHit
      ? { kind: "done", cities: memoHit }
      : answer?.key === memoKey
        ? answer.state
        : { kind: "loading" };

  const computePos = () => {
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return;
    const spaceBelow = window.innerHeight - r.bottom;
    const up = spaceBelow < 300 && r.top > spaceBelow;
    setPos({ left: r.left, width: r.width, top: up ? r.top : r.bottom, up });
  };

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

  // Debounced search. A memo hit answers at once; otherwise one request after the typing pauses.
  useEffect(() => {
    if (!q || disabledReason || memo.has(memoKey)) return;
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/geo/cities?q=${encodeURIComponent(q)}&cc=${encodeURIComponent(cc)}`, { signal: ctl.signal, cache: "no-store" });
        const j = (await res.json().catch(() => null)) as { ok?: boolean; cities?: CityPick[]; error?: string } | null;
        if (ctl.signal.aborted) return;
        if (j?.ok && Array.isArray(j.cities)) {
          memo.set(memoKey, j.cities);
          setAnswer({ key: memoKey, state: { kind: "done", cities: j.cities } });
        } else {
          setAnswer({ key: memoKey, state: { kind: "error", message: j?.error ?? `search failed (HTTP ${res.status})` } });
        }
      } catch {
        if (!ctl.signal.aborted) setAnswer({ key: memoKey, state: { kind: "error", message: "search failed — network" } });
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [q, memoKey, cc, disabledReason]);

  const results = q && state.kind === "done" ? state.cities : [];
  const picked = new Set(values.map((v) => v.key));
  const full = values.length >= MAX_CITIES;

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  function openList() {
    computePos();
    setOpen(true);
    setActive(0);
  }

  function toggle(city: CityPick) {
    if (picked.has(city.key)) {
      onChange(values.filter((v) => v.key !== city.key));
      return;
    }
    if (full) return;
    onChange([...values, city]);
    setQuery("");
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
      setActive((a) => Math.min(a + 1, Math.max(results.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (results[active]) toggle(results[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
    }
  }

  const hint = disabledReason
    ? disabledReason
    : full
      ? `${MAX_CITIES} cities is the most a card takes`
      : !q
        ? "Type 2+ letters of a city"
        : state.kind === "loading"
          ? "Searching…"
          : state.kind === "error"
            ? state.message
            : results.length === 0
              ? "No cities found in this Geo"
              : null;

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
        {values.map((v) => (
          <span
            key={v.key}
            title={`${v.name}${v.region ? ` · ${v.region}` : ""} · ${v.country} (key ${v.key})`}
            className="animate-pop-in inline-flex items-center gap-1 rounded-md border border-accent/25 bg-accent/10 py-0.5 pl-1.5 pr-0.5 text-[11.5px]"
          >
            <span className="text-[#9db8ff]">{cityShortName(v)}</span>
            <span className="font-mono text-[10px] text-faint">{v.country}</span>
            <button
              type="button"
              aria-label={`Remove ${v.name}`}
              tabIndex={-1}
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(values.filter((x) => x.key !== v.key));
              }}
              className="rounded p-0.5 text-faint transition-colors hover:bg-accent/20 hover:text-ink"
            >
              <XIcon className="h-2.5 w-2.5" />
            </button>
          </span>
        ))}
        <input
          id={id}
          ref={inputRef}
          role="combobox"
          aria-expanded={open}
          aria-controls={id ? `${id}-listbox` : undefined}
          autoComplete="off"
          spellCheck={false}
          disabled={Boolean(disabledReason) && values.length === 0}
          placeholder={values.length === 0 ? (disabledReason ?? "Search city — empty = whole countries") : ""}
          value={query}
          onFocus={openList}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!open) openList();
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          className="h-6.5 min-w-[80px] flex-1 bg-transparent px-1.5 text-[13px] text-ink placeholder:text-faint outline-none disabled:cursor-not-allowed"
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
              <div ref={listRef} id={id ? `${id}-listbox` : undefined} role="listbox" className="max-h-60 overflow-y-auto p-1">
                {hint ? (
                  <p className={"px-3 py-2.5 text-[12px] " + (state.kind === "error" && q && !disabledReason ? "text-warn" : "text-faint")}>{hint}</p>
                ) : null}
                {!disabledReason
                  ? results.map((city, i) => {
                      const selected = picked.has(city.key);
                      return (
                        <div
                          key={city.key}
                          data-idx={i}
                          role="option"
                          aria-selected={selected}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            toggle(city);
                          }}
                          onMouseEnter={() => setActive(i)}
                          className={
                            "flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-[13px] transition-colors duration-100 " +
                            (i === active ? "bg-accent/10 text-ink" : "text-dim")
                          }
                        >
                          <span className="min-w-0 truncate">
                            {cityShortName(city)}
                            {city.region ? <span className="text-faint"> · {city.region}</span> : null}
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            <span className="font-mono text-[11px] text-faint">{city.country}</span>
                            {selected ? <CheckIcon className="h-3.5 w-3.5 text-accent" /> : null}
                          </span>
                        </div>
                      );
                    })
                  : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
