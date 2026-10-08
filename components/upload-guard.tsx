"use client";

import { useEffect } from "react";
import { AlertIcon } from "./icons";

/**
 * One voice for "the hand-off isn't finished — do not close this window" (owner ask 09-09, updated
 * for the server queue 08.10): the visible notice every launching surface shows, and the leave-page
 * confirm behind it.
 *
 * The tab is needed ONLY until the wave is handed over: creatives upload from here and the hand-off
 * POST runs from here. The moment every campaign reaches the server ("accepted"), the launches
 * continue on our server — the tab is safe to close. So the guard is live only while something is
 * still uploading / sending; once the hand-off screen shows the emerald check, nothing holds the
 * tab. (The hand-off host — components/launch-handoff.tsx — owns the one guard that remains.)
 */
export const UPLOAD_GUARD_MESSAGE =
  "The hand-off to our server isn't finished — closing this window now will stop it. Wait until every campaign reads “with the server”.";

/** Registers the native leave-page confirm while `active`. Browsers show their own generic
 *  text (custom messages are ignored since Chrome 51 / Firefox 44), but the dialog itself is
 *  the hard stop — the visible notice carries the words. */
export function useUnloadGuard(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = UPLOAD_GUARD_MESSAGE; // legacy field — without it some Chromium builds skip the dialog
      return UPLOAD_GUARD_MESSAGE;
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [active]);
}

export const uploadingLabel = (n: number): string =>
  n === 1 ? "1 campaign is still being handed over" : `${n} campaigns are still being handed over`;

/** The visible warning strip. Renders nothing when nothing is in flight, so callers can mount it
 *  unconditionally. `compact` = one line for tight rails. */
export function UploadingNotice({ n, compact = false, className = "" }: { n: number; compact?: boolean; className?: string }) {
  if (n <= 0) return null;
  return (
    <div
      role="alert"
      aria-live="assertive"
      className={
        "animate-pop-in flex items-start gap-2 rounded-lg border border-warn/50 bg-warn/10 px-3 py-2 text-left " +
        (compact ? "text-[11px] " : "text-[11.5px] ") +
        "leading-relaxed text-warn " +
        className
      }
    >
      <AlertIcon className="mt-[1px] h-3.5 w-3.5 shrink-0" />
      <span>
        <span className="font-semibold">Do not close this window or tab.</span> {uploadingLabel(n)}
        {compact
          ? "."
          : " — the hand-off runs from this page. Once every campaign reads “with the server”, the launches continue on our server and you can close it."}
      </span>
    </div>
  );
}
