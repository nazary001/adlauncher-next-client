"use client";

import { useEffect, useState } from "react";
import { type CloneRowDest, MAX_CLONE_COPIES, SOURCE_ACCOUNT } from "@/lib/clone";
import { AIF_VALUE_PIXEL, type PartnerConfig, aifOfferablePixels, pickAifPixel } from "@/lib/partners";
import { Field } from "./ui";
import { SearchSelect } from "./search-select";
import type { FanpageOption } from "./use-fanpages";
import { type AdAccountOption, defaultPixelFor, pixelOptionsOf } from "./use-adaccounts";
import { type AcctLimits, decorateAccountOptions } from "./use-acct-limit";
import { LockIcon, TargetIcon, XIcon } from "./icons";

/**
 * Per-row Destination editor for the MO/AIF clone board (owner ask 2026-09-08): the same
 * fanpage / account / pixel picks the batch Settings carry, for ONE row — plus the row's own
 * number of copies (empty = the batch default). "From each source" keeps the row's clones in
 * their source campaign's own account with the source's pixel; a concrete account re-builds
 * them there and needs a pixel of that account (auto-picked like the Settings picker does).
 * "Apply to all rows" fans the tuple (and copies) onto every row.
 */
export function CloneDestinationModal({
  title,
  partner,
  aifMode,
  fanpages,
  adAccounts,
  limits,
  initial,
  initialCopies,
  defaultCopies,
  hasOverride,
  rowCount,
  onClose,
  onApply,
  onApplyAll,
  onUseDefaults,
}: {
  title: string;
  partner: PartnerConfig;
  aifMode: boolean;
  fanpages: FanpageOption[] | null;
  adAccounts: AdAccountOption[] | null;
  limits: AcctLimits;
  /** Seed — the row's own tuple when it has one, else the batch settings. */
  initial: CloneRowDest;
  /** The row's own copies (null = batch default). */
  initialCopies: number | null;
  defaultCopies: number;
  hasOverride: boolean;
  rowCount: number;
  onClose: () => void;
  onApply: (dest: CloneRowDest, copies: number | null) => void;
  onApplyAll: (dest: CloneRowDest, copies: number | null) => void;
  onUseDefaults: () => void;
}) {
  const [draft, setDraft] = useState<CloneRowDest>(() => ({ ...initial }));
  const [copies, setCopies] = useState(initialCopies != null ? String(initialCopies) : "");

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const isTarget = Boolean(draft.accountId) && draft.accountId !== SOURCE_ACCOUNT;
  const pixelsAll = isTarget ? pixelOptionsOf(adAccounts, draft.accountId) : [];
  const pixels = aifMode ? aifOfferablePixels(pixelsAll) : pixelsAll;
  const fanpageOk = !partner.fanpagesFromToken || Boolean(draft.pageId);
  const accountOk = !partner.accountsFromToken || Boolean(draft.accountId);
  const pixelOk = !isTarget || Boolean(draft.pixelId);
  const complete = fanpageOk && accountOk && pixelOk;
  const copiesN = Number(copies);
  const copiesOk = copies === "" || (Number.isFinite(copiesN) && copiesN >= 1 && copiesN <= MAX_CLONE_COPIES);
  const result = (): CloneRowDest => ({ ...draft, pixelId: isTarget ? draft.pixelId : "" });
  const copiesOut = (): number | null => (copies === "" ? null : Math.max(1, Math.min(MAX_CLONE_COPIES, copiesN)));

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="animate-fade-in absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={onClose} />
      <div className="animate-pop-in relative flex max-h-[85vh] w-full max-w-[560px] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_30px_80px_rgba(0,0,0,0.6)]">
        {/* header */}
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-accent/25 to-accent2/25 text-[#9db8ff]">
              <TargetIcon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold leading-tight text-ink">Destination for this row</h2>
              <p className="mt-1 truncate text-[12px] text-dim" title={title}>
                {title}
              </p>
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
          <p className="rounded-lg border border-dashed border-line bg-surface2/50 px-3 py-2 text-[11px] leading-relaxed text-faint">
            This row&apos;s clones land HERE instead of the batch Destination in Settings — mix fankas,
            accounts and copies across rows in one batch.
          </p>
          {partner.fanpagesFromToken ? (
            <Field label="Fanpage" error={!draft.pageId ? "required" : undefined}>
              <SearchSelect
                value={draft.pageId}
                onChange={(v) => setDraft((d) => ({ ...d, pageId: v }))}
                options={fanpages ?? []}
                placeholder={partner.pagePlaceholder}
                emptyHint={fanpages ? "No fanpages on the token" : "Loading fanpages…"}
                metaWhenClosed
                warn={!draft.pageId}
              />
            </Field>
          ) : null}
          {partner.accountsFromToken ? (
            <>
              <Field label="Account" error={!draft.accountId ? "required" : undefined}>
                <SearchSelect
                  value={draft.accountId}
                  onChange={(v) =>
                    setDraft((d) => ({
                      ...d,
                      accountId: v,
                      // Same auto-pick as the Settings picker: the target's preferred pixel
                      // (AIF: the value pixel) when the account carries it; none in source mode.
                      pixelId:
                        v && v !== SOURCE_ACCOUNT
                          ? aifMode
                            ? (pickAifPixel(pixelOptionsOf(adAccounts, v))?.id ?? "")
                            : defaultPixelFor(adAccounts, v, partner.preferredPixel)
                          : "",
                    }))
                  }
                  options={[
                    { value: SOURCE_ACCOUNT, label: "From each source" },
                    ...decorateAccountOptions(adAccounts ?? [], limits),
                  ]}
                  placeholder="Select account"
                  emptyHint={adAccounts ? "No accounts on the token" : "Loading accounts…"}
                  warn={!draft.accountId}
                />
              </Field>
              {isTarget ? (
                <Field label="Pixel" error={!draft.pixelId ? "required" : undefined}>
                  <SearchSelect
                    value={draft.pixelId}
                    onChange={(v) => setDraft((d) => ({ ...d, pixelId: v }))}
                    options={pixels.map((p) => ({ value: p.id, label: p.name, meta: p.id }))}
                    placeholder="Search pixel"
                    emptyHint={
                      adAccounts
                        ? aifMode
                          ? `Share ${AIF_VALUE_PIXEL.name} to this cabinet in BM`
                          : "No pixels on this account"
                        : "Loading pixels…"
                    }
                    metaWhenClosed
                    warn={!draft.pixelId}
                  />
                </Field>
              ) : (
                <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface2/40 px-3 py-2">
                  <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint">Pixel</span>
                  <span className="flex items-center gap-1.5 font-mono text-[11.5px] text-ink">
                    From each source
                    <LockIcon className="h-3 w-3 text-faint" />
                  </span>
                </div>
              )}
            </>
          ) : null}
          <Field
            label="Copies for this row"
            hint={`empty = the batch default (${defaultCopies}) · max ${MAX_CLONE_COPIES}`}
            error={copiesOk ? undefined : `1–${MAX_CLONE_COPIES}`}
          >
            <input
              value={copies}
              onChange={(e) => setCopies(e.target.value.replace(/\D/g, "").slice(0, 3))}
              inputMode="numeric"
              placeholder={String(defaultCopies)}
              aria-label="Copies for this row"
              className="h-9 w-full rounded-lg border border-line bg-surface2 px-3 text-[13px] font-mono tabular-nums text-ink outline-none transition-colors hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15"
            />
          </Field>
        </div>

        {/* footer */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-5 py-3.5">
          <button
            type="button"
            onClick={() => {
              onUseDefaults();
              onClose();
            }}
            disabled={!hasOverride && initialCopies == null}
            className="rounded-lg px-3 py-2 text-[12.5px] font-medium text-faint transition-colors hover:bg-raise hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            Use batch defaults
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-line bg-surface px-3.5 py-2 text-[13px] font-medium text-dim transition-colors hover:border-line2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!complete || !copiesOk || rowCount < 2}
              title={rowCount < 2 ? "Add more rows to fan this destination out" : undefined}
              onClick={() => {
                onApplyAll(result(), copiesOut());
                onClose();
              }}
              className="rounded-lg border border-line bg-surface px-3.5 py-2 text-[13px] font-medium text-dim transition-colors hover:border-accent/50 hover:text-[#9db8ff] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              Apply to all {rowCount} rows
            </button>
            <button
              type="button"
              disabled={!complete || !copiesOk}
              onClick={() => {
                onApply(result(), copiesOut());
                onClose();
              }}
              className={
                "flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/15 px-3.5 py-2 text-[13px] font-semibold " +
                "text-[#9db8ff] transition-all duration-150 hover:border-accent/60 hover:bg-accent/25 active:scale-[0.98] " +
                "disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              }
            >
              Apply to this row
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
