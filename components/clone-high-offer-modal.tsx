"use client";

import { useEffect, useState } from "react";
import type { CloneRow, HighOfferConfig } from "@/lib/clone";
import { Field, TextInput } from "./ui";
import { SlidersIcon, XIcon } from "./icons";

/**
 * High Offer config editor. Phase-1 shell: the exact fields (offer routing, payout split) are
 * finalized in phase 2 — this frames the modal and holds placeholder inputs so the flow is
 * complete end-to-end in the UI. Mounted only while open (parent renders it conditionally), so
 * the draft is seeded straight from the row at mount.
 */
export function CloneHighOfferModal({
  row,
  onClose,
  onApply,
}: {
  row: CloneRow;
  onClose: () => void;
  onApply: (patch: HighOfferConfig) => void;
}) {
  const [draft, setDraft] = useState<HighOfferConfig>(() => ({ ...row.highOffer }));

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const set = (p: Partial<HighOfferConfig>) => setDraft((d) => ({ ...d, ...p }));

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="animate-fade-in absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={onClose} />
      <div className="animate-pop-in relative flex max-h-[85vh] w-full max-w-[460px] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_30px_80px_rgba(0,0,0,0.6)]">
        {/* header */}
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-warn/15 text-warn">
              <SlidersIcon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold leading-tight text-ink">High Offer config</h2>
              <p className="mt-1 truncate text-[12px] text-dim">{row.name}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-faint transition-colors hover:bg-raise hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        {/* body */}
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
          <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2.5">
            <span className="flex flex-col">
              <span className="text-[13px] font-medium text-ink">Enable high offer</span>
              <span className="text-[11px] text-dim">Route this clone to the high-payout ADX offer.</span>
            </span>
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => set({ enabled: e.target.checked })}
              className="h-4 w-4 accent-[#f5a623]"
            />
          </label>

          <Field label="Offer ID / link" hint="Placeholder — wired to the offer registry in phase 2.">
            <TextInput
              value={draft.offerId}
              onChange={(e) => set({ offerId: e.target.value })}
              placeholder="e.g. HGH-1042 or a full offer URL"
              disabled={!draft.enabled}
            />
          </Field>
          <Field label="Payout share" hint="e.g. 70% — placeholder for phase 2.">
            <TextInput
              value={draft.share}
              onChange={(e) => set({ share: e.target.value })}
              placeholder="70%"
              disabled={!draft.enabled}
            />
          </Field>

          <p className="rounded-lg border border-line bg-surface2/50 px-3 py-2 text-[11.5px] leading-relaxed text-faint">
            These fields are a UI placeholder. The real high-offer routing is defined when we wire the
            duplicate run (phase 2); nothing here is sent to Facebook yet.
          </p>
        </div>

        {/* footer */}
        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-line bg-surface px-3.5 py-2 text-[13px] font-medium text-dim transition-colors hover:border-line2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              onApply(draft);
              onClose();
            }}
            className={
              "flex items-center gap-2 rounded-lg border border-warn/50 bg-warn/15 px-3.5 py-2 text-[13px] font-semibold " +
              "text-warn transition-all duration-150 hover:border-warn/70 hover:bg-warn/25 active:scale-[0.98] " +
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warn/40"
            }
          >
            Save config
          </button>
        </div>
      </div>
    </div>
  );
}
