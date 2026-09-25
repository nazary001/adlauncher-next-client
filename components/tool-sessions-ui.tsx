"use client";

// Shared bits of the TOOL Sessions console: chips, buttons, inputs, time formatting, the modal
// shell. Same cockpit idiom as the token vault (components/token-vault-board.tsx).

import { useEffect, type ReactNode } from "react";
import { XIcon } from "./icons";
import type { SessionTone } from "@/lib/tool-sessions-model";

export type Tone = SessionTone | "accent";

export const chip = (tone: Tone): string =>
  "inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[10px] font-semibold " +
  (tone === "ok"
    ? "border-launch/30 bg-launch/10 text-launch2"
    : tone === "warn"
      ? "border-warn/40 bg-warn/10 text-warn"
      : tone === "danger"
        ? "border-danger/40 bg-danger/10 text-danger"
        : tone === "accent"
          ? "border-accent/40 bg-accent/15 text-[#9db8ff]"
          : "border-line bg-surface2 text-dim");

export const btn = "inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ";
export const btnGhost = btn + "border-line bg-surface2 text-dim hover:border-line2 hover:text-ink";
export const btnAccent = btn + "border-accent/40 bg-accent/10 text-[#9db8ff] hover:border-accent/60 hover:bg-accent/20";
export const btnDanger = btn + "border-danger/40 bg-danger/10 text-danger hover:border-danger/60 hover:bg-danger/20";
export const btnOk = btn + "border-launch/40 bg-launch/10 text-launch2 hover:border-launch/60 hover:bg-launch/20";
export const inputCls = "h-8 w-full rounded-lg border border-line bg-surface2 px-2.5 text-[12.5px] text-ink placeholder:text-faint outline-none focus:border-accent/60 disabled:opacity-50";
export const textareaCls = "w-full resize-y rounded-lg border border-line bg-surface2 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink placeholder:text-faint outline-none focus:border-accent/60 disabled:opacity-50";
export const selectCls = "h-8 w-full rounded-lg border border-line bg-surface2 px-2 text-[12.5px] text-ink outline-none focus:border-accent/60 disabled:opacity-50";
/** Same select, sized to its content (filters in a toolbar). */
export const selectInlineCls = "h-8 w-auto rounded-lg border border-line bg-surface2 px-2 pr-6 text-[12.5px] text-ink outline-none focus:border-accent/60 disabled:opacity-50";
export const labelCls = "text-[10px] font-medium uppercase tracking-[0.14em] text-faint";
export const mono = "font-mono tabular-nums";

export function Dot({ tone, pulse = false, className = "" }: { tone: Tone; pulse?: boolean; className?: string }) {
  const color = tone === "ok" ? "bg-launch2" : tone === "danger" ? "bg-danger" : tone === "warn" ? "bg-warn" : tone === "accent" ? "bg-accent" : "bg-faint";
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${color} ${pulse ? "animate-pulse-soft" : ""} ${className}`} />;
}

// ---- time ------------------------------------------------------------------------------------------

export const parseTs = (iso: string | null | undefined): number => {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

export function ago(iso: string | null | undefined, now = Date.now()): string {
  const ms = parseTs(iso);
  if (!ms) return "never";
  const d = now - ms;
  if (d < 0) return "just now";
  if (d < 45_000) return "just now";
  if (d < 3_600_000) return `${Math.max(1, Math.floor(d / 60_000))} min ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} h ago`;
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)} d ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}

/** "25.09 11:20" — the tool's own compact stamp. */
export function stamp(iso: string | null | undefined): string {
  const ms = parseTs(iso);
  if (!ms) return "—";
  const d = new Date(ms);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${dd}.${mm} ${hh}:${mi}`;
}
export function stampFull(iso: string | null | undefined): string {
  const ms = parseTs(iso);
  if (!ms) return "—";
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}
export const agoMs = (ms: number, now = Date.now()): string => ago(ms ? new Date(ms).toISOString() : null, now);

// ---- modal shell ---------------------------------------------------------------------------------------

export function Modal({ title, subtitle, onClose, children, width = "max-w-[640px]", testId }: { title: string; subtitle?: ReactNode; onClose: () => void; children: ReactNode; width?: string; testId?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm animate-fade-in sm:p-8" onMouseDown={(e) => e.target === e.currentTarget && onClose()} data-testid={testId}>
      <div role="dialog" aria-modal="true" aria-label={title} className={`my-auto w-full ${width} animate-pop-in rounded-2xl border border-line bg-surface shadow-[0_24px_80px_rgba(0,0,0,0.6)]`}>
        <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <p className="text-[14px] font-semibold text-ink">{title}</p>
            {subtitle ? <p className="text-[11px] leading-snug text-faint">{subtitle}</p> : null}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-faint transition-colors hover:bg-raise hover:text-ink">
            <XIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="px-4 py-3">{children}</div>
      </div>
    </div>
  );
}

export function Flash({ flash }: { flash: { tone: "ok" | "danger" | "warn"; text: string } | null }) {
  if (!flash) return null;
  return (
    <div
      role="status"
      data-testid="flash"
      className={
        "animate-pop-in rounded-xl border px-3 py-2 text-[12px] leading-relaxed " +
        (flash.tone === "ok" ? "border-launch/30 bg-launch/10 text-launch2" : flash.tone === "warn" ? "border-warn/40 bg-warn/10 text-warn" : "border-danger/40 bg-danger/10 text-red-300")
      }
    >
      {flash.text}
    </div>
  );
}

/** Two-step destructive button: first click arms it (6 s), second click fires. */
export function ConfirmButton({ label, title, confirmLabel, onConfirm, disabled, armed, setArmed, className = btnDanger, children, testId }: { label: string; /** Tooltip + accessible name — required when `label` is empty (icon-only). */ title?: string; confirmLabel: string; onConfirm: () => void; disabled?: boolean; armed: boolean; setArmed: (v: boolean) => void; className?: string; children?: ReactNode; testId?: string }) {
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 6000);
    return () => clearTimeout(t);
  }, [armed, setArmed]);
  return armed ? (
    <button type="button" onClick={onConfirm} disabled={disabled} className={className} title={title} data-testid={testId}>
      {children}
      {confirmLabel}
    </button>
  ) : (
    <button type="button" onClick={() => setArmed(true)} disabled={disabled} className={btnGhost + " hover:text-danger"} title={title} aria-label={label || title} data-testid={testId}>
      {children}
      {label}
    </button>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-line2 px-3 py-6 text-center text-[12px] text-faint">{children}</p>;
}

export function KeyValue({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[150px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-faint">{k}</dt>
          <dd className="min-w-0 break-words text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
