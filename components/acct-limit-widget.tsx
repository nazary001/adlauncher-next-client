"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { TimerIcon } from "./icons";
import { type AcctLimits, fmtCountdown, useAcctLimits } from "./use-acct-limit";

// Header widget for the per-account launch limit: a compact pill showing the hottest account's
// N/5 + live countdown, expanding into a panel that lists every account with an active 30-min
// window — segmented 5-cell bar, name/id, mm:ss until its reset. Every user sees the same
// numbers (the registry is global), so the wave planner reads capacity here before firing.

/** 1s local tick, running only while something needs to count down. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [active]);
  return now;
}

type Row = { id: string; name?: string; count: number; resetAt: number };

function liveRows(limits: AcctLimits, now: number): Row[] {
  return Object.entries(limits.accounts)
    .map(([id, a]) => ({ id, name: a.name, count: a.count, resetAt: a.resetAt }))
    .filter((r) => r.resetAt > now + limits.skew && r.count > 0)
    .sort((a, b) => b.count - a.count || a.resetAt - b.resetAt);
}

function SlotBar({ count, limit }: { count: number; limit: number }) {
  const fill = count >= limit ? "bg-danger" : count >= limit - 1 ? "bg-warn" : "bg-accent";
  return (
    <span className="flex items-center gap-[3px]" aria-label={`${count} of ${limit} launches used`}>
      {Array.from({ length: limit }, (_, i) => (
        <span
          key={i}
          className={
            "h-1.5 w-3 rounded-full transition-colors duration-300 " +
            (i < count ? fill : "bg-line")
          }
        />
      ))}
    </span>
  );
}

export function AcctLimitWidget() {
  const limits = useAcctLimits();
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // Tick only while there is something to count down (or the panel is open).
  const hasActive = Object.keys(limits.accounts).length > 0;
  const now = useNow(hasActive || open);
  const rows = useMemo(() => liveRows(limits, now), [limits, now]);
  const hottest = rows[0];
  const fullCount = rows.filter((r) => r.count >= limits.limit).length;

  // Close on outside click / Escape (same manners as the other header popovers).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const tone = fullCount > 0
    ? "border-danger/45 bg-danger/10 text-danger hover:border-danger/60"
    : hottest && hottest.count >= limits.limit - 1
      ? "border-warn/40 bg-warn/10 text-warn hover:border-warn/60"
      : hottest
        ? "border-accent/40 bg-accent/10 text-[#9db8ff] hover:border-accent/60"
        : "border-line bg-surface text-faint hover:border-line2 hover:text-dim";

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-tip={hottest ? undefined : "Account launch limits — 5 campaigns / 30 min per account"}
        className={
          "tip tip-b flex h-9 items-center gap-2 rounded-lg border px-3 font-mono text-[12px] " +
          "font-semibold tabular-nums transition-all duration-150 active:scale-[0.97] " +
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 " +
          tone
        }
      >
        <TimerIcon className="h-4 w-4" />
        {hottest ? (
          <>
            <span>
              {hottest.count}/{limits.limit}
            </span>
            <span className="opacity-75">{fmtCountdown(hottest.resetAt, limits.skew)}</span>
            {fullCount > 0 ? (
              <span className="rounded-md bg-danger/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                {fullCount} full
              </span>
            ) : null}
          </>
        ) : (
          <span className="text-[11px] font-medium tracking-wide">5/30m</span>
        )}
      </button>

      {open ? (
        <div
          className={
            "absolute right-0 top-full z-50 mt-2 w-[340px] animate-pop-in rounded-2xl border " +
            "border-line bg-surface p-3 shadow-[0_18px_50px_rgba(0,0,0,0.5)]"
          }
        >
          <div className="flex items-center justify-between px-1 pb-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">
              Account launch windows
            </span>
            <span className="font-mono text-[10.5px] text-faint">
              {rows.length} active
            </span>
          </div>

          {rows.length === 0 ? (
            <p className="px-1 py-4 text-center text-[12px] leading-relaxed text-faint">
              No account is inside a launch window.
              <br />
              The 30-min timer starts on an account&apos;s first campaign.
            </p>
          ) : (
            <div className="flex max-h-[320px] flex-col overflow-y-auto overscroll-contain">
              {rows.map((r) => {
                const full = r.count >= limits.limit;
                return (
                  <div
                    key={r.id}
                    className="flex items-center gap-3 rounded-lg px-1.5 py-2 transition-colors hover:bg-raise/60"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium text-ink">
                        {r.name || r.id}
                      </span>
                      <span className="block truncate font-mono text-[10px] text-faint">{r.id}</span>
                    </span>
                    <SlotBar count={r.count} limit={limits.limit} />
                    <span
                      className={
                        "w-11 shrink-0 text-right font-mono text-[11.5px] tabular-nums " +
                        (full ? "font-semibold text-danger" : "text-dim")
                      }
                    >
                      {fmtCountdown(r.resetAt, limits.skew)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          <p className="border-t border-line px-1 pt-2 text-[10px] leading-relaxed text-faint">
            {limits.limit} campaigns per account / 30 min · counter resets when the window ends ·
            all users &amp; channels share it
          </p>
        </div>
      ) : null}
    </div>
  );
}
