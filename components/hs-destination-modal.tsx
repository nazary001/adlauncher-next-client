"use client";

import { useEffect, useState } from "react";
import { Field } from "./ui";
import { SearchSelect } from "./search-select";
import { type AcctLimits, decorateAccountOptions } from "./use-acct-limit";
import type { HsCatalog } from "./use-hs";
import { accountLoads, leastFilledPage, leastLoadedAccount } from "@/lib/pick-defaults";
import { TargetIcon, XIcon } from "./icons";

/** One row's OWN destination picks on the HS clone board (owner ask 2026-09-08). Every field is
 *  optional: "" = ride the wave Settings for it — the board's rowBinds resolves the chain (an
 *  account belongs to a profile, a pixel to an account). The modal always applies a COMPLETE
 *  tuple; the inline row pickers override one field at a time. */
export type HsRowDest = { profile: string; account: string; page: string; pixel: string };

/**
 * Per-row Destination editor for the HS duplicator — the same profile → account → page → pixel
 * cascade as the Settings column, plus the row's own number of copies. Empty copies = the wave
 * default. The pickers read the SAME LION catalog the Settings column does (idempotent
 * ensure* loaders fetch what the draft touches), and the FB Token rails filter accounts by the
 * duplicate signer's grant exactly like the Settings picker. "Apply to all rows" stamps the
 * tuple (and copies) onto every row — the fast way to fan a wave out after tuning one row.
 */
export function HsDestinationModal({
  title,
  hs,
  limits,
  needsPage,
  tokenRail,
  maxCopies,
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
  hs: HsCatalog;
  limits: AcctLimits;
  /** Cloner rails bind a page; JURO rails don't (the ads live on the source post's page). */
  needsPage: boolean;
  /** FB Token rails: offer only accounts the duplicate signer can act on. */
  tokenRail: boolean;
  maxCopies: number;
  /** Seed — the row's own tuple when it has one, else the wave defaults. */
  initial: HsRowDest;
  /** The row's own copies ("" = wave default). */
  initialCopies: string;
  defaultCopies: number;
  /** The row currently carries its own tuple (offers the "Use wave defaults" reset). */
  hasOverride: boolean;
  /** Fireable rows on the board — the "Apply to all" caption. */
  rowCount: number;
  onClose: () => void;
  onApply: (dest: HsRowDest, copies: string) => void;
  onApplyAll: (dest: HsRowDest, copies: string) => void;
  onUseDefaults: () => void;
}) {
  const [draft, setDraft] = useState<HsRowDest>(() => ({ ...initial }));
  const [copies, setCopies] = useState(initialCopies);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const data = draft.profile ? hs.dataFor(draft.profile) : undefined;
  // Same account filter as the Settings column: on the FB Token rails only the signer's own
  // grant is offered (null sweep → no filtering, fail open).
  const tokenVisible = tokenRail ? (data?.dupTokenAccounts ?? data?.tokenAccounts ?? null) : null;
  const accountOptions =
    tokenVisible !== null ? (data?.accounts ?? []).filter((a) => tokenVisible.has(a.value)) : (data?.accounts ?? []);
  // Default binds (owner rule 09-08), same as the Settings column: an empty account/page pick
  // shows and applies the least-loaded account / least-filled fanka; a real pick wins.
  const autoAccount = leastLoadedAccount(
    accountLoads(
      accountOptions.map((a) => ({ id: a.value, disabled: a.disabled })),
      limits,
    ),
    limits.limit,
  );
  const autoPage = needsPage
    ? leastFilledPage(
        (data?.pages ?? []).map((p) => {
          const st = hs.pageStats(p.value);
          return { id: p.value, used: st?.used ?? null, limit: st?.limit ?? null, disabled: p.disabled };
        }),
      )
    : "";
  const effAccount = draft.account || autoAccount;
  const effPage = needsPage ? draft.page || autoPage : "";
  const accountIsAuto = !draft.account && Boolean(autoAccount);
  const pageIsAuto = needsPage && !draft.page && Boolean(autoPage);

  // The seeded picks may name a profile/account the board never loaded (a row applied from
  // another row) — the idempotent loaders fetch what the draft shows (the auto account too).
  useEffect(() => {
    if (draft.profile) hs.ensureProfile(draft.profile);
    if (draft.profile && effAccount) hs.ensurePixels(draft.profile, effAccount);
  }, [hs, draft.profile, effAccount]);

  const pixels = draft.profile && effAccount ? hs.pixelsFor(draft.profile, effAccount) : undefined;
  // A one-pixel account derives its pixel once the page step is done (owner ask 08-13 — the
  // pixel belongs at the fanka step); the board re-derives the same way at render time.
  const onlyPixel = Array.isArray(pixels) && pixels.length === 1 ? pixels[0].id : "";
  const effectivePixel = draft.pixel || (effPage || !needsPage ? onlyPixel : "");
  const complete = Boolean(draft.profile && effAccount && (effPage || !needsPage) && effectivePixel);
  const copiesN = Number(copies);
  const copiesOk = copies === "" || (Number.isFinite(copiesN) && copiesN >= 1 && copiesN <= maxCopies);
  const pageStatsLine = (id: string): string => {
    const st = hs.pageStats(id);
    return st ? `${st.approx ? "~" : ""}${st.used}/${st.limit} ads · ${st.approx ? "~" : ""}${st.free} free` : "";
  };
  // Apply stores the EFFECTIVE tuple — a row's own destination is always concrete.
  const result = (): HsRowDest => ({ profile: draft.profile, account: effAccount, page: effPage, pixel: effectivePixel });

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
            This row&apos;s clones land HERE instead of the wave defaults in Settings — mix accounts, pages
            and copies across rows in one wave.
          </p>
          <Field label="Profile">
            <SearchSelect
              value={draft.profile}
              onChange={(v) => {
                // A new profile is a new bind space — every dependent pick resets.
                setDraft({ profile: v, account: "", page: "", pixel: "" });
                if (v) hs.ensureProfile(v);
              }}
              options={hs.profiles ?? []}
              placeholder="Search profile"
              emptyHint={hs.profiles?.length ? "No matches" : "Loading profiles…"}
              metaWhenClosed
            />
          </Field>
          <Field
            label="Account"
            hint={
              accountIsAuto
                ? `auto · least loaded (${limits.countFor(effAccount)}/${limits.limit} launches in its 30-min window) — pick another to override`
                : undefined
            }
          >
            <SearchSelect
              value={effAccount}
              onChange={(v) => {
                setDraft((d) => ({ ...d, account: v, pixel: "" }));
                if (draft.profile && v) hs.ensurePixels(draft.profile, v);
              }}
              options={decorateAccountOptions(accountOptions, limits)}
              placeholder="Search account"
              emptyHint={
                !draft.profile
                  ? "Pick a profile first"
                  : !data
                    ? "Loading…"
                    : tokenVisible !== null && (data.accounts?.length ?? 0) > 0 && accountOptions.length === 0
                      ? "No accounts here are visible to our FB token — use the LION API rail (or another profile)"
                      : "No enabled accounts"
              }
              metaWhenClosed
            />
          </Field>
          {needsPage ? (
            <Field
              label="Page"
              hint={
                pageIsAuto
                  ? `auto · least filled${pageStatsLine(effPage) ? ` (${pageStatsLine(effPage)})` : ""} — pick another to override`
                  : effPage
                    ? pageStatsLine(effPage) || undefined
                    : undefined
              }
            >
              <SearchSelect
                value={effPage}
                onChange={(v) => setDraft((d) => ({ ...d, page: v }))}
                options={data?.pages ?? []}
                placeholder="Search page"
                emptyHint={!draft.profile ? "Pick a profile first" : data ? "No pages" : "Loading…"}
                metaWhenClosed
              />
            </Field>
          ) : (
            <p className="px-0.5 text-[11px] leading-snug text-faint">
              JURO copies land on the source post&apos;s own fanpage — no page bind on this row.
            </p>
          )}
          <Field label="Pixel">
            <SearchSelect
              value={effectivePixel}
              onChange={(v) => setDraft((d) => ({ ...d, pixel: v }))}
              options={(pixels ?? []).map((p) => ({ value: p.id, label: p.name, meta: p.id }))}
              placeholder="Search pixel"
              emptyHint={!draft.account ? "Pick an account first" : pixels ? "No pixels on this account" : "Loading…"}
            />
          </Field>
          <Field
            label="Copies for this row"
            hint={`empty = the wave default (${defaultCopies}) · max ${maxCopies}`}
            error={copiesOk ? undefined : `1–${maxCopies}`}
          >
            <input
              value={copies}
              onChange={(e) => setCopies(e.target.value.replace(/\D/g, "").slice(0, 2))}
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
            disabled={!hasOverride && !initialCopies}
            className="rounded-lg px-3 py-2 text-[12.5px] font-medium text-faint transition-colors hover:bg-raise hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            Use wave defaults
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
                onApplyAll(result(), copies);
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
                onApply(result(), copies);
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
