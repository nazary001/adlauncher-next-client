"use client";

// Save a launcher card as a campaign template, or edit one (owner ask 16.10: "каждый может создать
// свой темплейт кампании … все поля необходимые кроме креатива"). The form lists the partner's own
// fields with the card's values; the ticked ones become the template (everything on by default
// except the name tail and whatever the card leaves empty — creatives are never offered). A name the
// buyer already uses on this partner comes back as a conflict, and the form offers to replace that
// template's settings with this card's. lib/templates says what may be saved; this file is only the
// form (same modal grammar as Copy settings / Autofill).

import { useEffect, useMemo, useState } from "react";
import type { Campaign } from "@/lib/types";
import type { PartnerConfig } from "@/lib/partners";
import {
  TEMPLATE_DESCRIPTION_MAX,
  TEMPLATE_FIELD_GROUPS,
  TEMPLATE_NAME_MAX,
  type CampaignTemplate,
  type TemplateFieldDef,
  type TemplateFields,
  type TemplateKey,
  agoLabel,
  templateFieldDefsFor,
  templateFieldsFrom,
} from "@/lib/templates";
import type { TemplatesApi } from "./use-templates";
import { BookmarkPlusIcon, CheckIcon, PencilIcon, XIcon } from "./icons";
import { TextArea, TextInput } from "./ui";

export type SaveTemplateMode =
  /** A card's settings become a new template (or replace one of the buyer's own under that name). */
  | { kind: "create"; card: Campaign; cardIndex: number }
  /** Rename / describe / trim an existing template. */
  | { kind: "edit"; template: CampaignTemplate };

/** A value the card actually carries — an empty field is not ticked by default (a template that
 *  carried "" would blank the field on every card it lands on). */
const carried = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : v !== undefined && String(v).trim() !== "");

const errorText = (error: string, message?: string, max?: number): string => {
  switch (error) {
    case "template_limit":
      return `You already keep ${max ?? "the maximum of"} templates on this partner — delete one first.`;
    case "template_exists":
      return "You already have a template with this name on this partner.";
    case "name_required":
      return "Give the template a name.";
    case "name_too_long":
      return `The name is longer than ${TEMPLATE_NAME_MAX} characters.`;
    case "description_too_long":
      return `The description is longer than ${TEMPLATE_DESCRIPTION_MAX} characters.`;
    case "fields_empty":
      return "Tick at least one field.";
    case "forbidden":
      return "Only the template's creator or an owner can change it.";
    case "not_found":
      return "This template was deleted in the meantime.";
    case "store_unavailable":
    case "network":
      return `The store did not answer${message ? ` — ${message}` : ""}. Try again.`;
    default:
      return `Could not save — ${error}${message ? ` (${message})` : ""}.`;
  }
};

export function SaveTemplateModal({
  mode,
  partner,
  api,
  onClose,
  onSaved,
}: {
  mode: SaveTemplateMode;
  partner: PartnerConfig;
  api: TemplatesApi;
  onClose: () => void;
  /** The stored template, and what happened to it. */
  onSaved: (template: CampaignTemplate, what: "created" | "replaced" | "edited") => void;
}) {
  const editing = mode.kind === "edit" ? mode.template : null;
  // The fields on offer: the partner's, in card order. In edit mode only the keys the template
  // already carries (there is no card to take a new value from).
  const defs = useMemo<TemplateFieldDef[]>(() => {
    const all = templateFieldDefsFor(partner);
    if (!editing) return all;
    const has = new Set(Object.keys(editing.fields));
    return all.filter((d) => has.has(d.key));
  }, [partner, editing]);
  // The values the previews read: the card's (create) or the template's own (edit).
  const values = useMemo<TemplateFields>(
    () => (mode.kind === "create" ? templateFieldsFrom(mode.card, defs.map((d) => d.key)) : mode.template.fields),
    [mode, defs],
  );
  const [name, setName] = useState(editing?.name ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [ticked, setTicked] = useState<Set<TemplateKey>>(
    () => new Set(defs.filter((d) => (editing ? true : d.defaultOn !== false && carried((values as Record<string, unknown>)[d.key]))).map((d) => d.key)),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A template of the buyer's that already holds this name — replace it, or rename. */
  const [conflict, setConflict] = useState<CampaignTemplate | null>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const toggle = (k: TemplateKey) =>
    setTicked((s) => {
      const next = new Set(s);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const grouped = TEMPLATE_FIELD_GROUPS.map((g) => ({ g, items: defs.filter((d) => d.group === g) })).filter((x) => x.items.length > 0);
  const trimmedName = name.trim().replace(/\s+/g, " ");
  const nameProblem = !trimmedName ? "Give the template a name" : trimmedName.length > TEMPLATE_NAME_MAX ? `At most ${TEMPLATE_NAME_MAX} characters` : null;
  const canSave = !busy && !nameProblem && ticked.size > 0 && description.length <= TEMPLATE_DESCRIPTION_MAX;

  /** The fields the form would store right now. */
  const pickedFields = (): TemplateFields => {
    const keys = [...ticked];
    if (mode.kind === "create") return templateFieldsFrom(mode.card, keys);
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      const v = (mode.template.fields as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = Array.isArray(v) ? [...v] : v;
    }
    return out as TemplateFields;
  };

  async function save() {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      if (mode.kind === "create") {
        const r = await api.create({ name: trimmedName, description: description.trim(), fields: pickedFields() });
        if (r.ok) return onSaved(r.template, "created");
        if (r.error === "template_exists" && r.existing) return setConflict(r.existing);
        setError(errorText(r.error, r.message, r.max));
        return;
      }
      const patch: { name?: string; description?: string; fields?: TemplateFields } = {};
      if (trimmedName !== mode.template.name) patch.name = trimmedName;
      if (description.trim() !== mode.template.description) patch.description = description.trim();
      const before = Object.keys(mode.template.fields).sort().join(",");
      if ([...ticked].sort().join(",") !== before) patch.fields = pickedFields();
      if (Object.keys(patch).length === 0) return onSaved(mode.template, "edited");
      const r = await api.update(mode.template.documentId, patch);
      if (r.ok) return onSaved(r.template, "edited");
      setError(errorText(r.error, r.message));
    } finally {
      setBusy(false);
    }
  }

  /** The conflict's way out: that template keeps its name, takes this card's settings. */
  async function replace() {
    if (!conflict || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.update(conflict.documentId, { description: description.trim(), fields: pickedFields() });
      if (r.ok) return onSaved(r.template, "replaced");
      setError(errorText(r.error, r.message));
      setConflict(null);
    } finally {
      setBusy(false);
    }
  }

  const title = editing ? "Edit template" : "Save as template";
  const Icon = editing ? PencilIcon : BookmarkPlusIcon;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="animate-fade-in absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="animate-pop-in relative flex max-h-[88vh] w-full max-w-[640px] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_30px_80px_rgba(0,0,0,0.6)]"
      >
        {/* header */}
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-accent/25 to-accent2/25 text-[#9db8ff]">
              <Icon className="h-4.5 w-4.5" />
            </span>
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold leading-tight text-ink">{title}</h2>
              <p className="mt-1 text-[12px] leading-snug text-dim">
                {mode.kind === "create" ? (
                  <>
                    From <span className="font-medium text-ink">campaign {String(mode.cardIndex + 1).padStart(2, "0")}</span> · a{" "}
                    <span className="font-medium text-ink">{partner.label}</span> template the whole team can apply. Creatives are never saved.
                  </>
                ) : (
                  <>
                    Saved by <span className="font-medium text-ink">{mode.template.owner}</span>
                    {mode.template.updatedAt ? ` · updated ${agoLabel(mode.template.updatedAt)}` : ""} · {partner.label}. Untick a field to drop it from the template.
                  </>
                )}
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

        <div className="flex-1 overflow-y-auto">
          {/* name + description */}
          <div className="flex flex-col gap-3 border-b border-line px-5 py-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="tpl-name" className="flex items-center justify-between text-[10px] font-medium uppercase tracking-[0.14em] text-faint">
                <span>Template name</span>
                <span className={"font-mono " + (trimmedName.length > TEMPLATE_NAME_MAX ? "text-warn" : "")}>
                  {trimmedName.length}/{TEMPLATE_NAME_MAX}
                </span>
              </label>
              <TextInput
                id="tpl-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setConflict(null);
                }}
                maxLength={TEMPLATE_NAME_MAX + 20}
                placeholder="e.g. Cars · US · lowest cost"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void save();
                  }
                }}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="tpl-desc" className="flex items-center justify-between text-[10px] font-medium uppercase tracking-[0.14em] text-faint">
                <span>Description (optional)</span>
                <span className={"font-mono " + (description.length > TEMPLATE_DESCRIPTION_MAX ? "text-warn" : "")}>
                  {description.length}/{TEMPLATE_DESCRIPTION_MAX}
                </span>
              </label>
              <TextArea
                id="tpl-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={TEMPLATE_DESCRIPTION_MAX + 20}
                placeholder="What it is for — the team reads this under the name"
                className="min-h-[56px]"
                rows={2}
              />
            </div>
          </div>

          {/* conflict */}
          {conflict ? (
            <div role="alert" className="mx-5 mt-4 flex flex-col gap-2.5 rounded-xl border border-warn/40 bg-warn/10 px-4 py-3">
              <p className="text-[13px] leading-snug text-ink">
                You already have <span className="font-semibold">«{conflict.name}»</span> on {partner.label}
                {conflict.updatedAt ? ` (updated ${agoLabel(conflict.updatedAt)}` : ""}
                {conflict.updatedAt ? `, used ${conflict.uses}×)` : ""}. Replace its settings with this card&apos;s, or pick another name.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={replace}
                  disabled={busy}
                  className="flex h-8 items-center gap-1.5 rounded-lg border border-warn/50 bg-warn/15 px-3 text-[12.5px] font-semibold text-warn transition-colors hover:bg-warn/25 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warn/40"
                >
                  <CheckIcon className="h-3.5 w-3.5" />
                  Replace «{conflict.name}»
                </button>
                <button
                  type="button"
                  onClick={() => setConflict(null)}
                  className="h-8 rounded-lg px-2.5 text-[12.5px] font-medium text-dim transition-colors hover:text-ink"
                >
                  Keep both — I&apos;ll rename
                </button>
              </div>
            </div>
          ) : null}

          {/* fields */}
          <div className="flex items-center justify-between px-5 pb-1 pt-4">
            <span className="font-mono text-[12px] text-faint">
              {ticked.size}/{defs.length} fields
            </span>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => setTicked(new Set(defs.map((d) => d.key)))} className="rounded-md px-2 py-1 text-[12.5px] font-medium text-dim transition-colors hover:text-ink">
                Select all
              </button>
              <span className="text-faint">·</span>
              <button type="button" onClick={() => setTicked(new Set())} className="rounded-md px-2 py-1 text-[12.5px] font-medium text-dim transition-colors hover:text-ink">
                None
              </button>
            </div>
          </div>
          <div className="px-3 pb-3">
            {grouped.map(({ g, items }) => (
              <div key={g} className="mb-1.5">
                <p className="px-2.5 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">{g}</p>
                {items.map((d) => {
                  const on = ticked.has(d.key);
                  const preview = d.preview(values);
                  return (
                    <button
                      key={d.key}
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      onClick={() => toggle(d.key)}
                      className="flex w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left transition-colors duration-100 hover:bg-raise/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    >
                      <span
                        className={
                          "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors " +
                          (on ? "border-accent bg-accent text-white" : "border-line2 bg-surface")
                        }
                      >
                        {on ? <CheckIcon className="h-3.5 w-3.5" /> : null}
                      </span>
                      <span className={"flex-1 truncate text-[13.5px] " + (on ? "text-ink" : "text-dim")}>{d.label}</span>
                      <span className={"max-w-[50%] shrink-0 truncate text-right font-mono text-[12px] " + (preview === "—" ? "text-faint/60" : "text-faint")} title={preview}>
                        {preview}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
            {mode.kind === "create" ? (
              <p className="px-2.5 pb-1 pt-2 text-[11px] leading-snug text-faint">
                Creatives stay with the card — a template never carries them. Empty fields are unticked; tick one to make the template clear that field wherever it lands.
              </p>
            ) : null}
          </div>
        </div>

        {/* footer */}
        <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3.5">
          <p className="min-w-0 flex-1 truncate text-[12px] text-warn" aria-live="polite">
            {error ?? (ticked.size === 0 ? "Tick at least one field" : "")}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-line bg-surface px-4 py-2 text-[13.5px] font-medium text-dim transition-colors hover:border-line2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!canSave || Boolean(conflict)}
              className={
                "flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/15 px-4 py-2 text-[13.5px] font-semibold " +
                "text-[#9db8ff] transition-all duration-150 hover:border-accent/60 hover:bg-accent/25 active:scale-[0.98] " +
                "disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              }
            >
              <Icon className="h-4 w-4" />
              {busy ? "Saving…" : editing ? "Save changes" : "Save template"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
