"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { UpdateState } from "@/lib/build-update";
import { useHandoffPending } from "./launch-handoff";
import { uploadingLabel } from "./upload-guard";
import { AlertIcon, RetryIcon, SparklesIcon } from "./icons";

// "A new version is live" — the small card under the header's right edge and the chip in the header
// it folds into (owner ask 10.11: «не такая огромная плашка а аккуратная … сверху справа на экране,
// при этом должна быть возможность работать и на старой версии … а уже после перезагрузки вступала
// в силу новая версия»). Until 10.11 this was a full-width red banner and every launch button was
// locked until the reload — and a reload empties the board.
//
// Two states (lib/build-update):
//   available — an offer. Nothing is locked: the tab keeps launching against the new server.
//   required  — the deploy changed the wire this tab speaks. Launch buttons lock (the boards read
//               useAcctLimits().reloadRequired).
// The card never leaves by itself and it breathes a glow until it is answered (owner 10.11, after
// the first live deploy: «чтобы эта плашка со временем сама по себе не закрывалась а чтобы просто
// было кнопка релоад и лейтер … чтобы она подсвечивалась мигала чтобы привлекала внимание»): two
// buttons — Reload, asked twice because the board is not kept through it, and Later, which folds the
// card into the header chip (that keeps pulsing, and opens the card again).

type Notice = {
  state: UpdateState;
  /** The card is on screen (false = folded into the header chip). */
  open: boolean;
  show: () => void;
  fold: () => void;
};

const Ctx = createContext<Notice>({ state: "current", open: false, show: () => {}, fold: () => {} });

function useUpdateNotice(): Notice {
  return useContext(Ctx);
}

/** How long the Reload button stays armed after the first press. */
const ARMED_MS = 6_000;

/**
 * Mounted by AcctLimitProvider (the poll that learns the live release lives there) — so above every
 * board, and the fold survives going from one board to another. `build` is the live build's stamp:
 * the card comes up once per live release; a second deploy, or an offer turning into a must, brings
 * it up again.
 */
export function UpdateNoticeProvider({ state, build, children }: { state: UpdateState; build: string; children: React.ReactNode }) {
  const key = `${state}:${build}`;
  const [foldedKey, setFoldedKey] = useState<string | null>(null);
  const open = state !== "current" && foldedKey !== key;
  const show = useCallback(() => setFoldedKey(null), []);
  const fold = useCallback(() => setFoldedKey(key), [key]);
  const value = useMemo<Notice>(() => ({ state, open, show, fold }), [state, open, show, fold]);
  return (
    <Ctx.Provider value={value}>
      {open ? <UpdateCard key={key} required={state === "required"} onFold={fold} /> : null}
      {/* Phones: the header row has no room for the chip, so the folded card waits in its own corner. */}
      {state !== "current" && !open ? (
        <div className="fixed right-3 top-[calc(var(--hdr-h,4rem)+0.5rem)] z-[35] rounded-full bg-surface/95 backdrop-blur-md sm:hidden">
          <ChipButton state={state} open={false} onClick={show} className="flex" />
        </div>
      ) : null}
      {children}
    </Ctx.Provider>
  );
}

/** The header's chip: there from the moment another build is live until the tab reloads. Opens and
 *  folds the card. Renders nothing on a current tab, so the header mounts it unconditionally. */
export function UpdateChip() {
  const { state, open, show, fold } = useUpdateNotice();
  if (state === "current") return null;
  return <ChipButton state={state} open={open} onClick={open ? fold : show} className="hidden sm:flex" />;
}

function ChipButton({ state, open, onClick, className }: { state: UpdateState; open: boolean; onClick: () => void; className: string }) {
  const required = state === "required";
  const name = required ? "Reload needed" : "Update available";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      aria-label={`${name} — ${open ? "hide" : "show"}`}
      data-tip={open ? undefined : name}
      className={
        // update-chip (globals.css): pops in, then — while the card is folded — rings out a pulse so
        // the waiting update is not forgotten.
        "tip tip-b update-chip h-9 w-9 shrink-0 items-center justify-center rounded-full border " +
        "transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 " +
        (open ? "" : "is-waiting ") +
        (required
          ? "is-required border-danger/40 bg-danger/10 text-danger hover:border-danger/60 hover:bg-danger/20 focus-visible:ring-danger/40 "
          : "border-accent/40 bg-accent/10 text-[#9db8ff] hover:border-accent/60 hover:bg-accent/20 focus-visible:ring-accent/40 ") +
        className
      }
    >
      <RetryIcon className="h-4 w-4" />
      <span className={"animate-pulse-soft absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full " + (required ? "bg-danger" : "bg-accent")} />
    </button>
  );
}

function UpdateCard({ required, onFold }: { required: boolean; onFold: () => void }) {
  // A hand-off still running FROM this tab (creatives uploading, the request not yet answered) dies
  // with a reload — the new build takes it as it is. So while one is in flight the reload waits.
  const inFlight = useHandoffPending();
  // Reload is asked twice: the card appears on its own, possibly under a cursor on its way to the
  // Launch bay, and a reload costs the whole board (cards and creatives live in the tab only).
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), ARMED_MS);
    return () => clearTimeout(t);
  }, [armed]);

  const waiting = inFlight > 0;
  const reload = () => {
    if (waiting) return;
    if (!armed) return setArmed(true);
    window.location.reload();
  };

  return (
    <div
      role={required ? "alert" : "status"}
      aria-live={required ? "assertive" : "polite"}
      data-update-notice={required ? "required" : "available"}
      className={
        // update-card (globals.css): drops in, then breathes its glow — accent for an offer, red for
        // a must — until Reload or Later answers it.
        // z-[35]: over the boards and the sticky sub-navs, under the header's own popovers (user menu,
        // limit panel — the header is z-40) and under every drawer / modal / the hand-off screen.
        "update-card fixed right-3 top-[calc(var(--hdr-h,4rem)+0.625rem)] z-[35] w-[min(330px,calc(100vw-1.5rem))] " +
        "rounded-2xl border bg-surface/95 p-3.5 backdrop-blur-md " +
        // Under the header's right edge at every width: the header row is max-w-[1440px] px-3 / sm:px-6.
        "sm:right-[max(1.5rem,calc((100%_-_1440px)_/_2_+_1.5rem))] " +
        (required ? "is-required" : "")
      }
    >
      <div className="flex items-start gap-3">
        <span
          className={
            "update-card-tile flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border " +
            (required ? "border-danger/30 bg-danger/10 text-danger" : "border-accent/30 bg-gradient-to-br from-accent/25 to-accent2/25 text-[#9db8ff]")
          }
        >
          {required ? <AlertIcon className="h-4 w-4" /> : <SparklesIcon className="h-4 w-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold leading-tight text-ink">{required ? "Reload to keep launching" : "Update available"}</p>
          <p className="mt-1 text-[11.5px] leading-relaxed text-dim">
            {required
              ? "This update changed how launches are sent, so this tab can no longer launch. Launches already with the server keep running."
              : "Keep working — this tab stays on its version. Reload when your board is launched: a reload clears it."}
          </p>
        </div>
      </div>

      {waiting ? (
        <p className="mt-2.5 rounded-lg border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-warn">
          <span className="font-semibold">Do NOT reload yet</span> — {uploadingLabel(inFlight)} from this tab; reload once{" "}
          {inFlight === 1 ? "it reads" : "every one of them reads"} “with the server”.
        </p>
      ) : armed ? (
        <p className="animate-pop-in mt-2.5 rounded-lg border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-warn">
          Cards and creatives on this board are not kept through a reload. Press again to reload.
        </p>
      ) : null}

      <div className="mt-3 flex items-center gap-2 pl-11">
        <button
          type="button"
          onClick={reload}
          disabled={waiting}
          className={
            "flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[12px] font-semibold transition-all duration-150 " +
            "active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 " +
            (armed
              ? "border-warn/50 bg-warn/15 text-warn hover:bg-warn/25 focus-visible:ring-warn/40"
              : required
                ? "border-danger/50 bg-danger/15 text-danger hover:bg-danger/25 focus-visible:ring-danger/40"
                : "border-accent/40 bg-accent/10 text-[#9db8ff] hover:border-accent/60 hover:bg-accent/20 focus-visible:ring-accent/40")
          }
        >
          <RetryIcon className="h-3.5 w-3.5" />
          {waiting ? "Wait…" : armed ? "Reload now" : "Reload"}
        </button>
        <button
          type="button"
          onClick={onFold}
          className={
            "h-8 rounded-lg border border-line2 px-3 text-[12px] font-medium text-dim transition-colors hover:bg-raise hover:text-ink " +
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          }
        >
          Later
        </button>
      </div>
    </div>
  );
}
