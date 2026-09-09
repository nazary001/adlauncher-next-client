"use client";

import { useEffect } from "react";
import { AlertIcon } from "./icons";

/**
 * One voice for "campaigns are still uploading — do not close this window" (owner ask 09-09):
 * the visible notice every launching surface shows, and the leave-page confirm behind it.
 *
 * A CLIENT-side launch (MO / AIF launches and clones, the HS FB-Token create) streams from this
 * tab: closing or reloading the page kills the upload mid-flight and never fires the queued
 * rows. Server-side pumps (LION duplicate / JURO waves) are NOT covered on purpose — those are
 * safe to close, and the boards say so.
 */
export const UPLOAD_GUARD_MESSAGE =
  "Campaigns are still uploading — closing this window now will stop them. Wait until every row is sent.";

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
  n === 1 ? "1 campaign is still uploading" : `${n} campaigns are still uploading`;

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
        {compact ? "." : " — they upload from this page and die with it. Wait until every row reads Sent / Created before closing."}
      </span>
    </div>
  );
}
