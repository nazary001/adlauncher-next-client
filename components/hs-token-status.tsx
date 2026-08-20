"use client";

import { useEffect, useRef, useState } from "react";
import { FacebookMark } from "./icons";

// Header widget for the HS launch-token POOL (T1 → T2 failover): a compact pill showing each
// token as a status dot, expanding into a panel with the full picture — which FB app the bearer
// belongs to (the (#4) limit is app-level), who's "in use" vs "standby", and the cooldown left
// on a burned one. The status endpoint's probe also STEERS the failover server-side, so keeping
// this widget on screen keeps the pool state fresh for the whole team.

export type HsTokenRow = {
  index: number;
  fp: string;
  user: string;
  app: string;
  state: "ok" | "limited" | "dead";
  active: boolean;
  limitedUntil: number;
  reason: string;
};
type TokenRow = HsTokenRow;

const POLL_MS = 60_000;

/** Every configured launch bearer is burned right now → the boards must not fire token-rail
 *  work (the server gate refuses it anyway — this powers the friendly UI block). */
export const hsTokensAllDown = (tokens: HsTokenRow[], loaded: boolean): boolean =>
  loaded && tokens.length > 0 && tokens.every((t) => t.state !== "ok");

export function useHsTokenStatus(enabled = true): { tokens: TokenRow[]; loaded: boolean } {
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    async function load() {
      try {
        const r = await fetch("/api/hs/token-status");
        const d = (await r.json().catch(() => ({}))) as { ok?: boolean; tokens?: TokenRow[] };
        if (!alive) return;
        if (r.ok && d?.ok && Array.isArray(d.tokens)) {
          setTokens(d.tokens);
          setLoaded(true);
        }
      } catch {
        /* transient — keep the last known state */
      }
    }
    void load();
    const iv = setInterval(() => void load(), POLL_MS);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      clearInterval(iv);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled]);
  return { tokens, loaded };
}

const dotTone = (t: TokenRow): string =>
  t.state === "ok" ? "bg-launch2" : t.state === "limited" ? "bg-warn" : "bg-danger";

const minutesLeft = (until: number): string => {
  const m = Math.max(0, Math.ceil((until - Date.now()) / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};

function stateChip(t: TokenRow): { text: string; cls: string } {
  if (t.state === "dead") return { text: "dead", cls: "border-danger/40 bg-danger/10 text-danger" };
  if (t.state === "limited")
    return { text: `limit · ${minutesLeft(t.limitedUntil)}`, cls: "border-warn/40 bg-warn/10 text-warn" };
  if (t.active) return { text: "in use", cls: "border-accent/40 bg-accent/15 text-[#9db8ff]" };
  return { text: "standby", cls: "border-line bg-surface2 text-dim" };
}

export function HsTokenStatusWidget() {
  const { tokens, loaded } = useHsTokenStatus();
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

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

  if (!loaded || tokens.length === 0) return null;

  const troubled = tokens.some((t) => t.state !== "ok");
  const failedOver = tokens.some((t) => t.active && t.index !== 1);
  const pillTone = tokens.every((t) => t.state !== "ok")
    ? "border-danger/45 bg-danger/10 text-danger hover:border-danger/60"
    : troubled || failedOver
      ? "border-warn/45 bg-warn/10 text-warn hover:border-warn/60"
      : "border-line bg-surface text-dim hover:border-line2 hover:text-ink";

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="HS launch tokens — health & failover"
        className={
          "flex h-9 items-center gap-2 rounded-full border px-3 text-[12px] font-medium transition-colors duration-150 " +
          pillTone
        }
      >
        <FacebookMark className="h-3.5 w-3.5 text-[#5f9bf0]" />
        <span className="hidden md:inline">Tokens</span>
        <span className="flex items-center gap-1">
          {tokens.map((t) => (
            <span
              key={t.fp}
              className={
                "h-2 w-2 rounded-full transition-colors " +
                dotTone(t) +
                (t.active ? " ring-2 ring-accent/50" : "")
              }
            />
          ))}
        </span>
        {failedOver ? <span className="hidden font-semibold sm:inline">T2</span> : null}
      </button>

      {open ? (
        <div className="animate-pop-in absolute right-0 top-11 z-50 w-[320px] rounded-2xl border border-line bg-surface p-3 shadow-[0_24px_60px_rgba(0,0,0,0.55)]">
          <p className="px-1 pb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">
            HS launch tokens
          </p>
          <div className="flex flex-col gap-2">
            {tokens.map((t) => {
              const chip = stateChip(t);
              return (
                <div
                  key={t.fp}
                  className={
                    "flex items-center justify-between gap-2 rounded-xl border px-2.5 py-2 " +
                    (t.active ? "border-accent/35 bg-accent/[0.07]" : "border-line bg-surface2")
                  }
                  title={t.reason || undefined}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${dotTone(t)}`} />
                    <div className="min-w-0">
                      <p className="truncate text-[12px] font-medium text-ink">
                        T{t.index}
                        {t.app ? ` · ${t.app}` : ""}
                      </p>
                      <p className="truncate font-mono text-[10px] text-faint">
                        {t.user || t.fp}
                      </p>
                    </div>
                  </div>
                  <span
                    className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10.5px] font-semibold ${chip.cls}`}
                  >
                    {chip.text}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="px-1 pt-2 text-[10.5px] leading-snug text-faint">
            Launches use the first healthy token; a rate-limited or dead one is skipped
            automatically and retried after its cooldown.
          </p>
        </div>
      ) : null}
    </div>
  );
}
