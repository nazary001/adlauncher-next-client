"use client";

import { useEffect, useMemo, useState } from "react";
import { type Campaign, bidKind, moneyLabel } from "@/lib/types";
import type { PartnerConfig } from "@/lib/partners";
import {
  AGES,
  BID_STRATEGIES,
  CATEGORIES,
  CONVERSION_EVENTS,
  CTAS,
  OBJECTIVES,
  OPTIMIZATIONS,
  OS_OPTIONS,
  PLACEMENTS,
  REDIRECT_TYPES,
  countryName,
} from "@/lib/catalog";
import { CheckIcon, CopyIcon, XIcon } from "./icons";

type Group = "Setup" | "Delivery" | "Creative" | "Targeting";
type Field = {
  key: keyof Campaign;
  label: string;
  group: Group;
  when?: (p: PartnerConfig) => boolean;
  preview: (c: Campaign) => string;
};

const GROUPS: Group[] = ["Setup", "Delivery", "Creative", "Targeting"];

const optLabel = (arr: { value: string; label: string }[], v: string) =>
  arr.find((o) => o.value === v)?.label ?? (v || "—");

const list = (arr: string[], n = 3) =>
  arr.length ? arr.slice(0, n).join(", ") + (arr.length > n ? ` +${arr.length - n}` : "") : "—";

/** Every campaign setting the first card can push onto the others (never gcm/id — each keeps its own). */
const FIELDS: Field[] = [
  { key: "name", label: "Name", group: "Setup", preview: (c) => c.name || "—" },
  { key: "profile", label: "Profile", group: "Setup", when: (p) => p.usesProfile, preview: (c) => c.profile || "—" },
  { key: "account", label: "Account", group: "Setup", when: (p) => !p.lockedAccount, preview: (c) => c.account || "—" },
  // Token-fanpage partners (Indians) pick a fanka per card → copyable; preview shows the raw page
  // id (the modal has no page list to resolve names against).
  {
    key: "page",
    label: "Fanpage",
    group: "Setup",
    when: (p) => !p.lockedAccount || !!p.fanpagesFromToken,
    preview: (c) => c.page || "—",
  },
  { key: "pixel", label: "Pixel", group: "Setup", when: (p) => !p.lockedPixel, preview: (c) => c.pixel || "—" },

  { key: "objective", label: "Objective", group: "Delivery", preview: (c) => optLabel(OBJECTIVES, c.objective) },
  // fire=click optimization is MO-funnel-only; LION owns HS tracking.
  {
    key: "optimization",
    label: "Optimization",
    group: "Delivery",
    when: (p) => !p.lionLaunch,
    preview: (c) => optLabel(OPTIMIZATIONS, c.optimization),
  },
  { key: "bidStrategy", label: "Bid strategy", group: "Delivery", preview: (c) => optLabel(BID_STRATEGIES, c.bidStrategy) },
  { key: "conversionEvent", label: "Conversion event", group: "Delivery", preview: (c) => optLabel(CONVERSION_EVENTS, c.conversionEvent) },
  { key: "budget", label: "Daily budget", group: "Delivery", preview: (c) => `$${moneyLabel(c.budget)}` },
  {
    key: "bidCap",
    label: "Bid cap",
    group: "Delivery",
    preview: (c) =>
      c.bidCap ? (bidKind(c.bidStrategy) === "roas" ? `ROAS ${c.bidCap}` : `$${moneyLabel(c.bidCap)}`) : "—",
  },

  { key: "landing", label: "Landing", group: "Creative", when: (p) => p.usesGcm, preview: (c) => c.landing || "—" },
  { key: "link", label: "Destination link", group: "Creative", when: (p) => !p.usesGcm, preview: (c) => c.link || "—" },
  { key: "title", label: "Title", group: "Creative", preview: (c) => c.title || "—" },
  { key: "copy", label: "Primary text", group: "Creative", preview: (c) => c.copy || "—" },
  { key: "cta", label: "CTA", group: "Creative", preview: (c) => optLabel(CTAS, c.cta) },
  { key: "redirectType", label: "Redirect type", group: "Creative", preview: (c) => optLabel(REDIRECT_TYPES, c.redirectType) },
  {
    key: "headline",
    label: "Headline",
    group: "Creative",
    when: (p) => !p.lionLaunch,
    preview: (c) => c.headline || "—",
  },
  {
    key: "files",
    label: "Creatives",
    group: "Creative",
    preview: (c) => (c.files.length ? `${c.files.length} file${c.files.length > 1 ? "s" : ""}` : "—"),
  },

  {
    key: "countries",
    label: "Geo",
    group: "Targeting",
    preview: (c) => (c.countries[0] === "WW" ? "World" : list(c.countries.map(countryName))),
  },
  { key: "locales", label: "Languages", group: "Targeting", preview: (c) => list(c.locales, 2) },
  { key: "category", label: "Special category", group: "Targeting", preview: (c) => optLabel(CATEGORIES, c.category) },
  { key: "placement", label: "Placement", group: "Targeting", preview: (c) => optLabel(PLACEMENTS, c.placement) },
  { key: "ageMin", label: "Age", group: "Targeting", preview: (c) => optLabel(AGES, c.ageMin) },
  { key: "userOs", label: "Devices", group: "Targeting", preview: (c) => optLabel(OS_OPTIONS, c.userOs) },
];

export function CopySettingsModal({
  open,
  source,
  count,
  partner,
  onClose,
  onApply,
}: {
  open: boolean;
  source: Campaign | null;
  count: number; // number of OTHER campaigns that will receive the settings
  partner: PartnerConfig;
  onClose: () => void;
  onApply: (keys: (keyof Campaign)[]) => void;
}) {
  const fields = useMemo(() => FIELDS.filter((f) => !f.when || f.when(partner)), [partner]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Default to everything checked each time the modal opens (one-click full replicate). Safe reset-
  // on-open — only fires when `open` flips to true, no cascade.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) setSelected(new Set(fields.map((f) => f.key as string)));
  }, [open, fields]);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);

  if (!open || !source) return null;

  const toggle = (k: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const grouped = GROUPS.map((g) => ({ g, items: fields.filter((f) => f.group === g) })).filter(
    (x) => x.items.length > 0,
  );

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="animate-fade-in absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={onClose} />
      <div className="animate-pop-in relative flex max-h-[85vh] w-full max-w-[520px] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_30px_80px_rgba(0,0,0,0.6)]">
        {/* header */}
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-accent/25 to-accent2/25 text-[#9db8ff]">
              <CopyIcon className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-[15px] font-semibold leading-tight text-ink">Copy settings to all campaigns</h2>
              <p className="mt-1 text-[12px] text-dim">
                From <span className="font-medium text-ink">campaign 01</span> →{" "}
                {count > 0 ? (
                  <span className="text-ink">
                    {count} other{count === 1 ? "" : "s"}
                  </span>
                ) : (
                  <span className="text-warn">no other campaigns yet</span>
                )}
                . Tick what to copy.
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

        {/* select all / none */}
        <div className="flex items-center justify-between border-b border-line px-5 py-2">
          <span className="font-mono text-[11px] text-faint">
            {selected.size}/{fields.length} selected
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setSelected(new Set(fields.map((f) => f.key as string)))}
              className="rounded-md px-2 py-1 text-[11.5px] font-medium text-dim transition-colors hover:text-ink"
            >
              Select all
            </button>
            <span className="text-faint">·</span>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="rounded-md px-2 py-1 text-[11.5px] font-medium text-dim transition-colors hover:text-ink"
            >
              None
            </button>
          </div>
        </div>

        {/* fields */}
        <div className="flex-1 overflow-y-auto px-3 py-2">
          {grouped.map(({ g, items }) => (
            <div key={g} className="mb-1">
              <p className="px-2 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">{g}</p>
              {items.map((f) => {
                const checked = selected.has(f.key as string);
                return (
                  <button
                    key={f.key as string}
                    type="button"
                    onClick={() => toggle(f.key as string)}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-100 hover:bg-raise/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    <span
                      className={
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors " +
                        (checked ? "border-accent bg-accent text-white" : "border-line2 bg-surface")
                      }
                    >
                      {checked ? <CheckIcon className="h-3 w-3" /> : null}
                    </span>
                    <span className="flex-1 truncate text-[13px] text-ink">{f.label}</span>
                    <span className="max-w-[48%] shrink-0 truncate text-right font-mono text-[11px] text-faint">
                      {f.preview(source)}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
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
            onClick={() => onApply([...selected] as (keyof Campaign)[])}
            disabled={selected.size === 0 || count === 0}
            className={
              "flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/15 px-3.5 py-2 text-[13px] font-semibold " +
              "text-[#9db8ff] transition-all duration-150 hover:border-accent/60 hover:bg-accent/25 active:scale-[0.98] " +
              "disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            }
          >
            <CopyIcon className="h-3.5 w-3.5" />
            Copy to {count} campaign{count === 1 ? "" : "s"}
          </button>
        </div>
      </div>
    </div>
  );
}
