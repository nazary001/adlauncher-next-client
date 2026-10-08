"use client";

// The hand-off screen (owner ask 08.10): "когда они нажимают запустить кампании чтобы сразу же у них
// высвечивался лоадер на начальном экране и показывало что там загружено а что не успело и … потом
// была красивая анимация и галочка что все передано в работу на наш сервер".
//
// Pressing Launch no longer starts work in the tab — it HANDS the wave to the server. This module is
// the one place that shows that hand-off, for every rail: each campaign of the wave is an item that
// goes  uploading → sending → accepted  (or failed, with the reason and a retry). The overlay opens
// the instant a wave begins; when every item is accepted it plays the "handed to the server" finish
// and tells the buyer the tab may be closed. While anything is still uploading / sending, a floating
// pill and the native leave-page confirm hold the tab open (only then — never after the hand-off).
//
// CONTRACT STUB — the exported names and types below are final (the task managers and the boards are
// written against them). The item / phase / scope / init TYPES live in ./handoff-core (the pure
// reducer the tests exercise); re-exporting them here keeps the contract's public surface identical.

import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import { isRemoteSource, useCreativeUploads } from "@/components/creative-uploads";
import type { UploadSnapshot } from "@/components/creative-uploads";
import { useTaskManager, useAifTaskManager, useAvTaskManager } from "@/components/task-manager";
import { useHsTaskManager } from "@/components/hs-task-manager";
import { useGoogleTaskManager } from "@/components/google-task-manager";
import { useSnapTaskManager } from "@/components/snap-task-manager";
import { useTiktokTaskManager } from "@/components/tiktok-task-manager";
import { useUnloadGuard } from "@/components/upload-guard";
import { CheckIcon, RetryIcon, TasksIcon, XIcon } from "@/components/icons";
import {
  demandMap,
  initialHandoffState,
  pendingCount,
  reduceBegin,
  reduceDismiss,
  reduceDropAcceptedOfWave,
  reduceDropAcceptedOutside,
  reducePatch,
  type HandoffInit,
  type HandoffItem,
  type HandoffPatch,
  type HandoffScope,
  type HandoffState,
} from "./handoff-core";

export type { HandoffScope, HandoffPhase, HandoffItem, HandoffInit } from "./handoff-core";

// ---------- module-level store (outside React: hand-offs survive navigating between boards) ----------

let state: HandoffState = initialHandoffState;
const listeners = new Set<() => void>();
const EMPTY_DEMAND: ReadonlyMap<string, number> = new Map();
let demandCache: ReadonlyMap<string, number> = EMPTY_DEMAND;

function sameMap(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

function commit(next: HandoffState): void {
  if (next === state) return;
  state = next;
  const nextDemand = demandMap(state.items);
  if (!sameMap(nextDemand, demandCache)) demandCache = nextDemand;
  for (const l of listeners) l();
}

// ---------- public store API (contract) ----------

export function handoffBegin(items: HandoffInit[]): void {
  if (!items.length) return;
  commit(reduceBegin(state, items, Date.now()));
}

export function handoffPatch(id: string, patch: HandoffPatch): void {
  commit(reducePatch(state, id, patch));
}

export function handoffSnapshot(): readonly HandoffItem[] {
  return state.items;
}

export function subscribeHandoff(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useHandoffItems(): readonly HandoffItem[] {
  return useSyncExternalStore(subscribeHandoff, handoffSnapshot, handoffSnapshot);
}

export function useHandoffPending(scope?: HandoffScope): number {
  const get = useCallback(() => pendingCount(state.items, scope), [scope]);
  return useSyncExternalStore(subscribeHandoff, get, () => 0);
}

export function useHandoffDemand(): ReadonlyMap<string, number> {
  return useSyncExternalStore(
    subscribeHandoff,
    () => demandCache,
    () => EMPTY_DEMAND,
  );
}

// Host-only mutations (not part of the contract — the overlay/pill live in this module).
function dropAcceptedOfWave(wave: number): void {
  commit(reduceDropAcceptedOfWave(state, wave));
}
function dropAcceptedOutside(keepWave: number | null): void {
  commit(reduceDropAcceptedOutside(state, keepWave));
}
function dismissItem(id: string): void {
  commit(reduceDismiss(state, id));
}

/** The files of an item that actually travel: an http(s) source (an HS "add by URL" creative, a
 *  remembered identity) is already remote — it has no upload to wait for or to show progress of. */
const uploadSources = (sources: readonly string[]): string[] => sources.filter((s) => !isRemoteSource(s));
const getBeginNonce = () => state.beginNonce;
const getZero = () => 0;

// ---------- upload-progress helpers (pure) ----------

/** Byte-weighted upload fraction 0…1 across a set of sources. A missing snapshot counts as 0;
 *  sources without a known size fall back to equal weight so the bar still moves. */
function aggFraction(snaps: ReadonlyArray<UploadSnapshot | null>): number {
  let num = 0;
  let den = 0;
  for (const s of snaps) {
    const weight = s && s.size > 0 ? s.size : 1;
    // A failed upload counts as nothing sent — its last progress tick (often 100 %: the bytes went
    // out, then the store refused them) must not read as "uploaded" on the bars.
    const p = !s || s.phase === "error" ? 0 : s.phase === "done" ? 1 : s.progress || 0;
    num += p * weight;
    den += weight;
  }
  return den > 0 ? num / den : 0;
}

/** True while at least one source has not started sending bytes yet (never queued / hashing). */
function anyPreparing(snaps: ReadonlyArray<UploadSnapshot | null>): boolean {
  return snaps.some((s) => !s || s.phase === "queued" || s.phase === "hashing");
}

const PENDING = (p: HandoffItem["phase"]) => p === "uploading" || p === "sending";

// ---------- the host ----------

/** Mounted ONCE in the (app) layout, inside every task-manager provider: renders the overlay, the
 *  floating "still handing over" pill, and registers the leave-page confirm while anything is pending. */
export function LaunchHandoffHost(): JSX.Element | null {
  const items = useHandoffItems();
  const beginNonce = useSyncExternalStore(subscribeHandoff, getBeginNonce, getZero);

  // Resolve every drawer's opener once — the host sits inside all task-manager providers.
  const mo = useTaskManager();
  const aif = useAifTaskManager();
  const av = useAvTaskManager();
  const hs = useHsTaskManager();
  const gg = useGoogleTaskManager();
  const sn = useSnapTaskManager();
  const tt = useTiktokTaskManager();
  const openDrawer = useCallback(
    (scope: HandoffScope) => {
      const open: Record<HandoffScope, (v: boolean) => void> = {
        mo: mo.setOpen,
        aif: aif.setOpen,
        av: av.setOpen,
        hs: hs.setOpen,
        gg: gg.setOpen,
        sn: sn.setOpen,
        tt: tt.setOpen,
      };
      open[scope]?.(true);
    },
    [mo.setOpen, aif.setOpen, av.setOpen, hs.setOpen, gg.setOpen, sn.setOpen, tt.setOpen],
  );

  const [overlayWave, setOverlayWave] = useState<number | null>(null);
  const handledNonce = useRef(0);

  // Every Launch click (a begin) opens the overlay on its wave — even a same-wave join, since the
  // boards enqueue a wave card by card. Driven by the nonce so re-opening after a manual hide works.
  useEffect(() => {
    if (beginNonce === 0 || beginNonce === handledNonce.current) return;
    handledNonce.current = beginNonce;
    setOverlayWave(state.wave);
  }, [beginNonce]);

  const pending = useMemo(() => items.filter((i) => PENDING(i.phase)).length, [items]);
  const failed = useMemo(() => items.filter((i) => i.phase === "failed").length, [items]);

  // The native leave-page confirm exists ONLY while something still depends on this tab (an upload /
  // a hand-off in flight). After acceptance the server runs the launches — closing is safe.
  useUnloadGuard(pending > 0);

  const waveList = useMemo(
    () => (overlayWave === null ? [] : items.filter((i) => i.wave === overlayWave)),
    [items, overlayWave],
  );
  // The overlay shows only while its wave still has items; once it drains (every item accepted and
  // dropped, or the last failed one dismissed) it falls back to the pill without a reconciling
  // setState — `overlayWave` is only the *requested* wave.
  const overlayShown = overlayWave !== null && waveList.length > 0;

  // An accepted item exists only to be seen flipping to "with the server". When no overlay shows it
  // — the screen was hidden before it finished, or a newer wave took the screen — drop it, or they
  // pile up for the life of the tab (review find 08.10). One commit, then nothing left to drop.
  useEffect(() => {
    const keep = overlayShown ? overlayWave : null;
    if (items.some((i) => i.phase === "accepted" && i.wave !== keep)) dropAcceptedOutside(keep);
  }, [items, overlayShown, overlayWave]);

  const close = useCallback(() => {
    if (overlayWave !== null) dropAcceptedOfWave(overlayWave); // hiding drops only accepted — never cancels
    setOverlayWave(null);
  }, [overlayWave]);

  const reopen = useCallback(() => {
    // Reopen on the most recent wave that still has something pending or failed.
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].phase !== "accepted") {
        setOverlayWave(items[i].wave);
        return;
      }
    }
  }, [items]);

  return (
    <>
      {overlayShown ? <HandoffOverlay items={waveList} onClose={close} openDrawer={openDrawer} /> : null}
      {!overlayShown && (pending > 0 || failed > 0) ? (
        <HandoffPill items={items} pending={pending} failed={failed} unsure={items.filter((i) => i.phase === "failed" && i.uncertain).length} onOpen={reopen} />
      ) : null}
    </>
  );
}

// ---------- overlay ----------

function focusables(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => el.offsetParent !== null || el === document.activeElement);
}

function HandoffOverlay({
  items,
  onClose,
  openDrawer,
}: {
  items: readonly HandoffItem[];
  onClose: () => void;
  openDrawer: (scope: HandoffScope) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);

  // Wave-level upload progress for the ring + the thin bar — ONE subscription for the whole wave
  // (each row subscribes to its own sources separately). `waveSources` only changes when the wave's
  // membership changes, not on byte progress, so this memo stays stable while uploads tick.
  const waveSources = useMemo(() => Array.from(new Set(items.flatMap((i) => uploadSources(i.sources)))), [items]);
  const snaps = useCreativeUploads(waveSources);
  const snapBySrc = useMemo(() => {
    const m = new Map<string, UploadSnapshot | null>();
    waveSources.forEach((s, i) => m.set(s, snaps[i] ?? null));
    return m;
  }, [waveSources, snaps]);

  const total = items.length;
  const accepted = items.filter((i) => i.phase === "accepted").length;
  const anyPending = items.some((i) => PENDING(i.phase));
  const done = total > 0 && accepted === total; // clean finish: everything with the server (no failures)
  // Nothing is moving any more, yet not everything arrived: the screen must say so in its header —
  // a spinner over "Handing over…" would read as "still working" while it waits for the buyer.
  const notHanded = items.filter((i) => i.phase === "failed").length;
  const stalled = !anyPending && notHanded > 0;
  // Failed items the server may in fact hold (no verdict came back) — never worded as "not handed over".
  const unsure = items.filter((i) => i.phase === "failed" && i.uncertain).length;
  const allUnsure = notHanded > 0 && unsure === notHanded;

  const bytesFraction = aggFraction(snaps);

  // Ring arc blends upload bytes with the hand-off phase so it fills smoothly and only completes at
  // "all accepted". A sliver (0.1) shows the moment an item is in play.
  const ringFraction = useMemo(() => {
    if (total === 0) return 0;
    let sum = 0;
    for (const it of items) {
      if (it.phase === "accepted") sum += 1;
      else if (it.phase === "sending") sum += 0.95;
      else {
        const srcs = uploadSources(it.sources);
        const f = srcs.length === 0 ? 1 : aggFraction(srcs.map((s) => snapBySrc.get(s) ?? null));
        sum += 0.1 + 0.8 * f;
      }
    }
    return Math.min(1, sum / total);
  }, [items, snapBySrc, total]);

  // Focus into the panel on open; restore the previously focused element on close.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => prev?.focus?.();
  }, []);

  // Escape closes / hides.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Clean finish auto-dismisses after ~4 s; a hover / focus inside the panel pauses it, and any
  // failure cancels it entirely (anyFailed ⇒ never `done`). The JS timer is the source of truth —
  // the shrinking bar is only its visual, so reduced-motion can't dismiss early.
  useEffect(() => {
    if (!done || paused) return;
    const t = setTimeout(onClose, 4000);
    return () => clearTimeout(t);
  }, [done, paused, onClose]);

  const onTrapTab = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const f = focusables(panelRef.current);
    if (f.length === 0) return;
    const first = f[0];
    const last = f[f.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  const onDismiss = useCallback((id: string) => dismissItem(id), []);
  const scope = items[0]?.scope;

  return (
    <div className="fixed inset-0 z-[95]" role="presentation">
      <div className="animate-fade-in absolute inset-0 bg-black/60 backdrop-blur-[3px]" onClick={onClose} />
      <div className="absolute inset-0 flex items-center justify-center p-4">
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label="Handing campaigns to the server"
          tabIndex={-1}
          onKeyDown={onTrapTab}
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          // Only a focus the BUYER moved onto a control pauses the countdown. The panel itself is
          // focused programmatically on open (focus management) — counting that as "the buyer is
          // here" paused the auto-dismiss for good in the common hands-off case (review find 08.10).
          onFocusCapture={(e) => {
            if (e.target !== panelRef.current) setPaused(true);
          }}
          onBlurCapture={(e) => {
            if (!panelRef.current?.contains(e.relatedTarget as Node)) setPaused(false);
          }}
          className={
            "animate-pop-in relative flex max-h-[88vh] w-full max-w-[560px] flex-col overflow-hidden " +
            "rounded-2xl border border-line bg-surface shadow-[0_28px_90px_rgba(0,0,0,0.6)] outline-none"
          }
        >
          {/* header: ring + title + counter */}
          <div className="flex items-start gap-4 border-b border-line px-5 py-5">
            <HandoffRing fraction={ringFraction} done={done} stalled={stalled} />
            <div className="min-w-0 flex-1 pt-1">
              <h2
                key={done ? "done" : stalled ? "stalled" : "live"}
                className={"animate-fade-in text-[15px] font-semibold " + (stalled ? "text-danger" : "text-ink")}
                aria-live="polite"
              >
                {done
                  ? "Handed to the server"
                  : stalled
                    ? allUnsure
                      ? notHanded === 1
                        ? "1 campaign is not confirmed"
                        : `${notHanded} campaigns are not confirmed`
                      : notHanded === 1
                        ? "1 campaign was not handed over"
                        : `${notHanded} campaigns were not handed over`
                    : "Handing over to the server…"}
              </h2>
              <p className="mt-1 font-mono text-[12px] tabular-nums text-dim" aria-live="polite">
                {accepted} / {total} {total === 1 ? "campaign" : "campaigns"} with the server
              </p>
              {/* the wave's uploaded bytes */}
              <div className="mt-2.5 h-1 w-full overflow-hidden rounded-full bg-surface2">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-accent to-accent2 transition-[width] duration-500 ease-out"
                  style={{ width: `${Math.round((done ? 1 : bytesFraction) * 100)}%` }}
                />
              </div>
            </div>
          </div>

          {/* list */}
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            <ul className="flex flex-col gap-1.5">
              {items.map((it, i) => (
                <HandoffRow key={it.id} item={it} index={i} onDismiss={onDismiss} />
              ))}
            </ul>
          </div>

          {/* footer */}
          <div className="relative border-t border-line px-5 py-4">
            {anyPending ? (
              <p className="mb-3 flex items-center gap-2 text-[12px] font-medium text-warn">
                <span className="relative flex h-2 w-2 shrink-0">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warn/60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-warn" />
                </span>
                Keep this tab open until everything is handed over.
              </p>
            ) : done ? (
              <p className="mb-3 flex items-center gap-2 text-[12px] font-medium text-launch2">
                <CheckIcon className="h-3.5 w-3.5 shrink-0" />
                All set — launches continue on our server. You can close this tab.
              </p>
            ) : (
              <p className="mb-3 text-[12px] font-medium text-danger">
                {allUnsure
                  ? "The server did not confirm these. Where a row offers Retry, press it (safe — it cannot double a campaign); a row that is being checked clears by itself. Do not launch them again from the board."
                  : "Some campaigns were not handed over — retry or dismiss them (each row says what it needs)."}
              </p>
            )}

            <div className="flex items-center justify-end gap-2">
              {scope ? (
                <button
                  type="button"
                  onClick={() => {
                    openDrawer(scope);
                    onClose();
                  }}
                  className={
                    "inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface2 px-3.5 text-[13px] " +
                    "font-medium text-dim transition-colors hover:border-line2 hover:text-ink " +
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  }
                >
                  <TasksIcon className="h-4 w-4" />
                  Open tasks
                </button>
              ) : null}
              <button
                type="button"
                onClick={onClose}
                className={
                  "inline-flex h-9 items-center rounded-lg border px-4 text-[13px] font-semibold transition-colors " +
                  "focus-visible:outline-none focus-visible:ring-2 " +
                  (done
                    ? "border-launch/40 bg-launch/15 text-launch2 hover:bg-launch/25 focus-visible:ring-launch/40"
                    : "border-line bg-surface2 text-ink hover:bg-raise focus-visible:ring-accent/40")
                }
              >
                {anyPending ? "Hide" : "Close"}
              </button>
            </div>

            {/* auto-dismiss countdown (clean finish only; frozen while hovered / focused) */}
            {done && !paused ? (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden">
                <div className="handoff-countdown h-full w-full origin-left bg-launch2/70" />
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- the header ring ----------

const R = 28;
const C = 2 * Math.PI * R;

function HandoffRing({ fraction, done, stalled }: { fraction: number; done: boolean; stalled: boolean }) {
  return (
    <div className="relative h-16 w-16 shrink-0">
      {stalled ? (
        <>
          {/* stalled on a failure: a still, red ring with the arc that DID arrive and a "!" — no spin */}
          <div className="absolute inset-0 rounded-full bg-danger/10" />
          <svg viewBox="0 0 64 64" className="absolute inset-0 h-full w-full text-danger">
            <circle cx="32" cy="32" r={R} fill="none" stroke="currentColor" strokeWidth="4" opacity="0.25" />
            <circle
              cx="32"
              cy="32"
              r={R}
              fill="none"
              stroke="currentColor"
              strokeWidth="4"
              strokeLinecap="round"
              transform="rotate(-90 32 32)"
              strokeDasharray={C}
              strokeDashoffset={C * (1 - Math.max(0, Math.min(1, fraction)))}
            />
            <path d="M32 21 L32 35" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" />
            <circle cx="32" cy="42.5" r="2.2" fill="currentColor" />
          </svg>
        </>
      ) : done ? (
        <>
          {/* resolved: emerald disc, a ring pulse and the check stroking itself in */}
          <div className="handoff-ring-pulse absolute inset-0 rounded-full border-2 border-launch2" />
          <div className="absolute inset-0 rounded-full bg-launch/15 shadow-[0_0_28px_rgba(16,185,129,0.45)]" />
          <svg viewBox="0 0 64 64" className="absolute inset-0 h-full w-full text-launch2">
            <circle cx="32" cy="32" r={R} fill="none" stroke="currentColor" strokeWidth="3" opacity="0.4" />
            <path
              d="M20 33 L28.5 41 L44 24"
              className="handoff-check-draw"
              fill="none"
              stroke="currentColor"
              strokeWidth="3.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              pathLength={1}
            />
          </svg>
        </>
      ) : (
        <>
          <svg viewBox="0 0 64 64" className="absolute inset-0 h-full w-full">
            <defs>
              <linearGradient id="handoff-arc" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="var(--color-accent)" />
                <stop offset="1" stopColor="var(--color-accent2)" />
              </linearGradient>
            </defs>
            <circle cx="32" cy="32" r={R} fill="none" stroke="var(--color-surface2)" strokeWidth="4" />
            <circle
              cx="32"
              cy="32"
              r={R}
              fill="none"
              stroke="url(#handoff-arc)"
              strokeWidth="4"
              strokeLinecap="round"
              transform="rotate(-90 32 32)"
              strokeDasharray={C}
              strokeDashoffset={C * (1 - Math.max(0, Math.min(1, fraction)))}
              style={{ transition: "stroke-dashoffset 0.5s cubic-bezier(0.16,1,0.3,1)" }}
            />
          </svg>
          {/* slow rotating accent highlight over the arc */}
          <svg viewBox="0 0 64 64" className="handoff-spin absolute inset-0 h-full w-full">
            <circle
              cx="32"
              cy="32"
              r={R}
              fill="none"
              stroke="var(--color-accent2)"
              strokeWidth="4"
              strokeLinecap="round"
              transform="rotate(-90 32 32)"
              strokeDasharray={`${C * 0.12} ${C}`}
              opacity="0.9"
            />
          </svg>
        </>
      )}
    </div>
  );
}

// ---------- one row ----------

const HandoffRow = memo(function HandoffRow({
  item,
  index,
  onDismiss,
}: {
  item: HandoffItem;
  index: number;
  onDismiss: (id: string) => void;
}) {
  // Each row subscribes ONLY to its own sources — a 40-row wave stays smooth because a byte tick on
  // one campaign never re-renders its neighbours (rows are memoized).
  const snaps = useCreativeUploads(useMemo(() => uploadSources(item.sources), [item.sources]));
  // Nothing to upload (every source is already remote) reads as fully uploaded, not as 0 %.
  const pct = snaps.length === 0 ? 100 : Math.round(aggFraction(snaps) * 100);
  const preparing = item.phase === "uploading" && pct === 0 && anyPreparing(snaps);

  return (
    <li
      className="animate-row-in overflow-hidden rounded-lg border border-line/70 bg-surface2/40"
      style={{ animationDelay: `${Math.min(index, 12) * 22}ms` }}
    >
      <div className="flex items-center gap-3 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-ink">{item.label}</p>
          {item.sub ? <p className="mt-0.5 truncate text-[11px] text-faint">{item.sub}</p> : null}
          {item.phase === "failed" && item.error ? (
            <p className="mt-1 text-[11px] leading-snug text-danger">{item.error}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {item.phase === "failed" ? (
            <>
              {item.retry ? (
                <button
                  type="button"
                  onClick={() => item.retry?.()}
                  className={
                    "inline-flex h-7 items-center gap-1 rounded-md border border-line bg-surface px-2 text-[11px] font-medium " +
                    "text-dim transition-colors hover:border-accent/50 hover:text-ink " +
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  }
                >
                  <RetryIcon className="h-3.5 w-3.5" />
                  Retry
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => onDismiss(item.id)}
                aria-label="Dismiss"
                className={
                  "inline-flex h-7 w-7 items-center justify-center rounded-md text-faint transition-colors " +
                  "hover:bg-raise hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                }
              >
                <XIcon className="h-3.5 w-3.5" />
              </button>
            </>
          ) : (
            <StateChip phase={item.phase} pct={pct} preparing={preparing} />
          )}
        </div>
      </div>
      {/* inline upload progress line while bytes are going out */}
      {item.phase === "uploading" && !preparing ? (
        <div className="h-0.5 w-full bg-surface2">
          <div
            className="h-full bg-gradient-to-r from-accent to-accent2 transition-[width] duration-300 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : null}
    </li>
  );
});

function StateChip({ phase, pct, preparing }: { phase: HandoffItem["phase"]; pct: number; preparing: boolean }) {
  if (phase === "accepted") {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] font-medium text-launch2">
        <svg key="ok" viewBox="0 0 24 24" className="handoff-check-draw h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" pathLength={1} />
        </svg>
        With the server
      </span>
    );
  }
  if (phase === "sending") {
    return (
      <span className="animate-pulse-soft inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] font-medium text-[#9db8ff]">
        Sending…
      </span>
    );
  }
  // uploading
  if (preparing) {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] font-medium text-dim">Preparing…</span>
    );
  }
  return (
    <span className="whitespace-nowrap font-mono text-[11px] tabular-nums font-medium text-[#9db8ff]">Uploading {pct}%</span>
  );
}

// ---------- the floating pill (overlay closed, something still pending or failed) ----------

function HandoffPill({
  items,
  pending,
  failed,
  unsure,
  onOpen,
}: {
  items: readonly HandoffItem[];
  pending: number;
  failed: number;
  /** How many of the failed ones got no verdict (the server may hold them). */
  unsure: number;
  onOpen: () => void;
}) {
  // A failed item owns the pill (red) until it is retried or dismissed; otherwise show hand-off
  // progress. Progress is read from the pending items' own sources.
  const pendingSources = useMemo(
    () => (failed > 0 ? [] : Array.from(new Set(items.filter((i) => PENDING(i.phase)).flatMap((i) => uploadSources(i.sources))))),
    [items, failed],
  );
  const snaps = useCreativeUploads(pendingSources);
  const pct = failed > 0 ? 0 : Math.round(aggFraction(snaps) * 100);

  if (failed > 0) {
    return (
      <button
        type="button"
        onClick={onOpen}
        aria-live="polite"
        className={
          "animate-pop-in fixed bottom-5 left-1/2 z-[85] flex -translate-x-1/2 items-center gap-2.5 rounded-full " +
          "border border-danger/50 bg-surface/95 py-2 pl-3.5 pr-3 shadow-[0_12px_40px_rgba(0,0,0,0.55)] " +
          "backdrop-blur-md transition-all duration-150 hover:border-danger/70 hover:bg-surface2 active:scale-[0.98] " +
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
        }
      >
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-danger" />
        </span>
        <span className="whitespace-nowrap text-[12.5px] font-semibold text-danger">
          {unsure === failed
            ? failed === 1
              ? "1 campaign is NOT confirmed"
              : `${failed} campaigns are NOT confirmed`
            : failed === 1
              ? "1 campaign was NOT handed over"
              : `${failed} campaigns were NOT handed over`}
          <span className="font-medium text-dim"> — open</span>
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-live="polite"
      className={
        "animate-pop-in fixed bottom-5 left-1/2 z-[85] flex -translate-x-1/2 items-center gap-2.5 rounded-full " +
        "border border-accent/40 bg-surface/95 py-2 pl-2.5 pr-3.5 shadow-[0_12px_40px_rgba(0,0,0,0.55)] " +
        "backdrop-blur-md transition-all duration-150 hover:border-accent/70 hover:bg-surface2 active:scale-[0.98] " +
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      }
    >
      <PillRing pct={pct} />
      <span className="whitespace-nowrap text-[12.5px] font-semibold text-ink">
        Handing over {pending} {pending === 1 ? "campaign" : "campaigns"}
        <span className="ml-1 font-mono tabular-nums font-medium text-dim">· {pct}%</span>
      </span>
    </button>
  );
}

function PillRing({ pct }: { pct: number }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 20 20" className="h-5 w-5 shrink-0">
      <circle cx="10" cy="10" r={r} fill="none" stroke="var(--color-surface2)" strokeWidth="2.5" />
      <circle
        cx="10"
        cy="10"
        r={r}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="2.5"
        strokeLinecap="round"
        transform="rotate(-90 10 10)"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.max(0, Math.min(1, pct / 100)))}
        style={{ transition: "stroke-dashoffset 0.3s ease-out" }}
      />
    </svg>
  );
}
