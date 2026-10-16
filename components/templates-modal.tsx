"use client";

// The campaign templates picker + library (owner ask 16.10: "все должны видеть темплейты всех, но свои
// должны быть … подсвечены … разбито по имени кто их создал … каждый может управлять только своими …
// овнер роли могут всех"). One modal, two ways in: from a card ("apply to THIS card", with "all cards"
// a step away) and from the board toolbar ("apply to all cards" / "new card from template"). Search,
// the buyer's own group first and marked, one group per other creator; every row shows what the
// template carries and opens to the full list. Edit / overwrite / delete for the creator and for an
// owner-role login (the server decides again on every write); "Copy to mine" for everyone else's.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Campaign } from "@/lib/types";
import type { PartnerConfig } from "@/lib/partners";
import {
  type CampaignTemplate,
  type TemplateKey,
  agoLabel,
  canManageTemplate,
  filterTemplates,
  groupTemplates,
  templateFieldCount,
  templateFieldDefsFor,
  templateFieldLabel,
  templateFieldsFrom,
  templateSummary,
} from "@/lib/templates";
import type { TemplatesApi } from "./use-templates";
import { BookmarkPlusIcon, CheckIcon, ChevronDownIcon, CopyIcon, LayersIcon, PencilIcon, PlusIcon, RetryIcon, SearchIcon, StarIcon, TrashIcon, XIcon } from "./icons";

export type TemplatePickerMode =
  /** Opened from a card: the primary action lands the template on that card. */
  | { kind: "card"; card: Campaign; cardIndex: number }
  /** Opened from the toolbar: the primary action lands it on every card. */
  | { kind: "board"; cardCount: number };

const writeError = (error: string, message?: string): string => {
  switch (error) {
    case "template_exists":
      return "You already have a template with that name — rename the copy afterwards.";
    case "template_limit":
      return "You keep the maximum number of templates on this partner — delete one first.";
    case "forbidden":
      return "Only the template's creator or an owner can change it.";
    case "not_found":
      return "This template was deleted in the meantime.";
    default:
      return `The store did not answer${message ? ` — ${message}` : ""}. Try again.`;
  }
};

const btn =
  "flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium transition-all duration-150 active:scale-[0.97] " +
  "disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ";
const btnQuiet = btn + "border-line bg-surface text-dim hover:border-line2 hover:bg-surface2 hover:text-ink";
const btnPrimary = btn + "border-accent/40 bg-accent/15 font-semibold text-[#9db8ff] hover:border-accent/60 hover:bg-accent/25";
const btnDanger = btn + "border-danger/40 bg-danger/10 font-semibold text-danger hover:bg-danger/20";

export function TemplatesModal({
  mode,
  partner,
  api,
  user,
  onClose,
  onApplyToCard,
  onApplyToAll,
  onNewCard,
  onEdit,
  onSaveCard,
}: {
  mode: TemplatePickerMode;
  partner: PartnerConfig;
  api: TemplatesApi;
  /** The session (owner = the server's verdict, passed down from the page). */
  user: { username: string; owner: boolean };
  onClose: () => void;
  onApplyToCard: (t: CampaignTemplate, cardId: string) => void;
  onApplyToAll: (t: CampaignTemplate) => void;
  onNewCard: (t: CampaignTemplate) => void;
  /** Open the edit form for this template (the picker closes). */
  onEdit: (t: CampaignTemplate) => void;
  /** Card mode: open the save form for the card the picker was opened from (the picker closes). */
  onSaveCard?: () => void;
}) {
  const me = api.me || user.username;
  const owner = api.owner || user.owner;
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; what: "delete" | "overwrite" } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const all = useMemo(() => api.templates ?? [], [api.templates]);
  const shown = useMemo(() => filterTemplates(all, query), [all, query]);
  const groups = useMemo(() => groupTemplates(shown, me), [shown, me]);
  const mineCount = all.filter((t) => t.owner.trim().toLowerCase() === me.trim().toLowerCase()).length;
  const creators = new Set(all.map((t) => t.owner.trim().toLowerCase())).size;
  const defs = useMemo(() => templateFieldDefsFor(partner), [partner]);
  const cardNo = mode.kind === "card" ? String(mode.cardIndex + 1).padStart(2, "0") : "";

  async function run(id: string, work: () => Promise<{ ok: boolean; error?: string; message?: string }>) {
    setBusy(id);
    setError(null);
    try {
      const r = await work();
      if (!r.ok) setError(writeError(r.error ?? "failed", r.message));
      return r.ok;
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  }

  const fork = (t: CampaignTemplate) =>
    run(t.documentId, () => api.create({ name: `${t.name} (copy)`, description: t.description, fields: t.fields }));
  const remove = (t: CampaignTemplate) => run(t.documentId, () => api.remove(t.documentId));
  /** The template keeps its name and its keys; the values become this card's. */
  const overwrite = (t: CampaignTemplate) => {
    if (mode.kind !== "card") return;
    const keys = Object.keys(t.fields) as TemplateKey[];
    return run(t.documentId, () => api.update(t.documentId, { fields: templateFieldsFrom(mode.card, keys) }));
  };

  const title = mode.kind === "card" ? `Apply a template to campaign ${cardNo}` : "Templates";
  const subtitle =
    mode.kind === "card"
      ? `${partner.label} templates of the whole team — yours first. Apply lands the settings on this card; the creatives stay.`
      : `${partner.label} templates of the whole team — yours first. Apply lands the settings on every card (${mode.cardCount}); the creatives stay.`;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="animate-fade-in absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="animate-pop-in relative flex max-h-[88vh] w-full max-w-[760px] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_30px_80px_rgba(0,0,0,0.6)]"
      >
        {/* header */}
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-accent/25 to-accent2/25 text-[#9db8ff]">
              <LayersIcon className="h-4.5 w-4.5" />
            </span>
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold leading-tight text-ink">{title}</h2>
              <p className="mt-1 text-[12px] leading-snug text-dim">{subtitle}</p>
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

        {/* search + counts */}
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-2.5">
          <div className="relative min-w-0 flex-1">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name, description or creator"
              aria-label="Search templates"
              autoComplete="off"
              spellCheck={false}
              className="h-8 w-full rounded-lg border border-line bg-surface2 pl-8 pr-3 text-[13px] text-ink placeholder:text-faint outline-none transition-[border-color,box-shadow] duration-150 hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15"
            />
          </div>
          <span className="font-mono text-[11.5px] text-faint">
            {all.length} template{all.length === 1 ? "" : "s"} · {mineCount} yours · {creators} creator{creators === 1 ? "" : "s"}
          </span>
          {mode.kind === "card" && onSaveCard ? (
            <button type="button" onClick={onSaveCard} className={btnQuiet} title={`Save campaign ${cardNo} as a new template`}>
              <BookmarkPlusIcon className="h-3.5 w-3.5" />
              Save {cardNo} as template
            </button>
          ) : null}
        </div>

        {/* list */}
        <div className="flex-1 overflow-y-auto px-3 py-3">
          {error ? (
            <p role="alert" className="mx-2 mb-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
              {error}
            </p>
          ) : null}
          {api.error && !api.templates ? (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
              <p className="text-[13px] text-danger">The templates did not load — {api.error}</p>
              <button type="button" onClick={api.refresh} className={btnQuiet}>
                <RetryIcon className="h-3.5 w-3.5" />
                Retry
              </button>
            </div>
          ) : api.loading && !api.templates ? (
            <div className="flex flex-col gap-2 px-2" aria-busy="true" aria-label="Loading templates">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-[72px] animate-pulse rounded-xl border border-line bg-surface2/40" />
              ))}
            </div>
          ) : all.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-line bg-surface2 text-faint">
                <LayersIcon className="h-5 w-5" />
              </span>
              <p className="max-w-[420px] text-[13px] leading-relaxed text-dim">
                No {partner.label} templates yet. Set a card up the way you like and press <span className="font-medium text-ink">Save as template</span> on it — the whole team will find it here.
              </p>
              {mode.kind === "card" && onSaveCard ? (
                <button type="button" onClick={onSaveCard} className={btnPrimary}>
                  <BookmarkPlusIcon className="h-3.5 w-3.5" />
                  Save campaign {cardNo} as template
                </button>
              ) : null}
            </div>
          ) : shown.length === 0 ? (
            <p className="px-4 py-10 text-center text-[13px] text-dim">Nothing matches «{query.trim()}».</p>
          ) : (
            groups.map((g) => (
              <section key={g.owner.toLowerCase()} className="mb-3">
                <h3 className={"flex items-center gap-1.5 px-2.5 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-[0.16em] " + (g.mine ? "text-[#9db8ff]" : "text-faint")}>
                  {g.mine ? <StarIcon className="h-3.5 w-3.5" /> : null}
                  {g.mine ? "Your templates" : `By ${g.owner}`}
                  <span className="font-mono text-[10px] normal-case tracking-normal opacity-70">({g.items.length})</span>
                </h3>
                <div className="flex flex-col gap-1.5">
                  {g.items.map((t) => {
                    const manage = canManageTemplate({ username: me, owner }, t);
                    const chips = templateSummary(t.fields);
                    const open = expanded === t.documentId;
                    const isBusy = busy === t.documentId;
                    const asking = confirm?.id === t.documentId ? confirm.what : null;
                    const keys = Object.keys(t.fields) as TemplateKey[];
                    return (
                      <article
                        key={t.documentId}
                        data-template={t.documentId}
                        className={
                          "rounded-xl border px-3.5 py-2.5 transition-colors " +
                          (g.mine ? "border-accent/30 bg-accent/[0.05] hover:border-accent/50" : "border-line bg-surface2/40 hover:border-line2")
                        }
                      >
                        <div className="flex items-start gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                              <span className="truncate text-[14px] font-semibold text-ink">{t.name}</span>
                              {g.mine ? (
                                <span className="rounded border border-accent/40 bg-accent/15 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-[#9db8ff]">you</span>
                              ) : null}
                              <span className="font-mono text-[11px] text-faint">
                                {templateFieldCount(t.fields)} fields · used {t.uses}× · {t.updatedAt ? agoLabel(t.updatedAt) : ""}
                                {t.updatedBy && t.updatedBy.toLowerCase() !== t.owner.toLowerCase() ? ` by ${t.updatedBy}` : ""}
                              </span>
                            </div>
                            {t.description ? <p className="mt-0.5 truncate text-[12.5px] text-dim" title={t.description}>{t.description}</p> : null}
                            {chips.length ? (
                              <div className="mt-1.5 flex flex-wrap gap-1">
                                {chips.map((c) => (
                                  <span key={c} className="rounded-md border border-line bg-surface px-1.5 py-0.5 font-mono text-[10.5px] text-dim">
                                    {c}
                                  </span>
                                ))}
                              </div>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-1.5">
                            <div className="flex items-center gap-1.5">
                              {mode.kind === "card" ? (
                                <>
                                  <button type="button" onClick={() => onApplyToCard(t, mode.card.id)} disabled={isBusy} className={btnPrimary} data-action="apply-card">
                                    <CheckIcon className="h-3.5 w-3.5" />
                                    Apply to {cardNo}
                                  </button>
                                  <button type="button" onClick={() => onApplyToAll(t)} disabled={isBusy} className={btnQuiet} title="Apply to every card on the board" data-action="apply-all">
                                    All cards
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button type="button" onClick={() => onApplyToAll(t)} disabled={isBusy} className={btnPrimary} data-action="apply-all">
                                    <CheckIcon className="h-3.5 w-3.5" />
                                    Apply to all ({mode.cardCount})
                                  </button>
                                  <button type="button" onClick={() => onNewCard(t)} disabled={isBusy} className={btnQuiet} title="Add a card with these settings" data-action="new-card">
                                    <PlusIcon className="h-3.5 w-3.5" />
                                    New card
                                  </button>
                                </>
                              )}
                            </div>
                            <div className="flex items-center gap-0.5">
                              {manage ? (
                                <>
                                  <button type="button" onClick={() => onEdit(t)} disabled={isBusy} className="tip tip-b flex h-7 w-7 items-center justify-center rounded-md text-faint transition-colors hover:bg-raise hover:text-ink" data-tip="Edit name, description, fields" aria-label="Edit template" data-action="edit">
                                    <PencilIcon className="h-3.5 w-3.5" />
                                  </button>
                                  {mode.kind === "card" ? (
                                    <button type="button" onClick={() => setConfirm({ id: t.documentId, what: "overwrite" })} disabled={isBusy} className="tip tip-b flex h-7 w-7 items-center justify-center rounded-md text-faint transition-colors hover:bg-raise hover:text-ink" data-tip={`Overwrite with campaign ${cardNo}'s values`} aria-label="Overwrite with this card" data-action="overwrite">
                                      <BookmarkPlusIcon className="h-3.5 w-3.5" />
                                    </button>
                                  ) : null}
                                  <button type="button" onClick={() => setConfirm({ id: t.documentId, what: "delete" })} disabled={isBusy} className="tip tip-b flex h-7 w-7 items-center justify-center rounded-md text-faint transition-colors hover:bg-raise hover:text-danger" data-tip="Delete template" aria-label="Delete template" data-action="delete">
                                    <TrashIcon className="h-3.5 w-3.5" />
                                  </button>
                                </>
                              ) : (
                                <button type="button" onClick={() => fork(t)} disabled={isBusy} className="tip tip-b flex h-7 items-center gap-1 rounded-md px-1.5 text-[11.5px] text-faint transition-colors hover:bg-raise hover:text-ink" data-tip="A copy under your name — yours to edit" aria-label="Copy to my templates" data-action="fork">
                                  <CopyIcon className="h-3.5 w-3.5" />
                                  Copy to mine
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => setExpanded(open ? null : t.documentId)}
                                aria-expanded={open}
                                aria-label={open ? "Hide fields" : "Show fields"}
                                className="flex h-7 w-7 items-center justify-center rounded-md text-faint transition-colors hover:bg-raise hover:text-ink"
                                data-action="expand"
                              >
                                <ChevronDownIcon className={"h-3.5 w-3.5 transition-transform duration-200 " + (open ? "rotate-180" : "")} />
                              </button>
                            </div>
                          </div>
                        </div>

                        {asking ? (
                          <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2" role="alertdialog" aria-label={asking === "delete" ? "Delete this template?" : "Overwrite this template?"}>
                            <span className="min-w-0 flex-1 text-[12.5px] text-ink">
                              {asking === "delete" ? (
                                <>Delete «{t.name}» for everyone? This cannot be undone.</>
                              ) : (
                                <>Replace the values of «{t.name}» with campaign {cardNo}&apos;s? Its name and its {keys.length} fields stay.</>
                              )}
                            </span>
                            <button type="button" onClick={() => (asking === "delete" ? remove(t) : overwrite(t))} disabled={isBusy} className={asking === "delete" ? btnDanger : btnPrimary} data-action="confirm">
                              {isBusy ? "…" : asking === "delete" ? "Delete" : "Overwrite"}
                            </button>
                            <button type="button" onClick={() => setConfirm(null)} className="h-8 rounded-lg px-2 text-[12.5px] font-medium text-dim transition-colors hover:text-ink">
                              Cancel
                            </button>
                          </div>
                        ) : null}

                        {open ? (
                          <dl className="mt-2.5 grid grid-cols-1 gap-x-4 gap-y-1 border-t border-line pt-2.5 sm:grid-cols-2" data-template-fields>
                            {keys.map((k) => {
                              const def = defs.find((d) => d.key === k);
                              const label = def?.label ?? templateFieldLabel(partner, k);
                              const raw = (t.fields as Record<string, unknown>)[k];
                              const value = def ? def.preview(t.fields) : Array.isArray(raw) ? raw.join(", ") || "—" : String(raw ?? "") || "—";
                              return (
                                <div key={k} className="flex min-w-0 items-baseline gap-2 text-[12px]">
                                  <dt className="shrink-0 text-faint">{label}</dt>
                                  <dd className="min-w-0 truncate font-mono text-dim" title={value}>
                                    {value}
                                  </dd>
                                </div>
                              );
                            })}
                          </dl>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              </section>
            ))
          )}
        </div>

        {/* footer */}
        <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
          <p className="min-w-0 flex-1 truncate text-[11.5px] text-faint">
            {owner ? "You have the owner role: you can edit and delete anyone's template." : "You can edit and delete your own templates; copy someone else's to make it yours."}
          </p>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-lg border border-line bg-surface px-4 py-2 text-[13px] font-medium text-dim transition-colors hover:border-line2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
