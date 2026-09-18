"use client";

// Autofill modal for the TikTok launcher — LION's "make N copies of card 1" (one shot = one card,
// so copies are whole cards, not a per-card multiplier). The buyer picks how many copies and which
// fields carry over from the FIRST card; each new card starts from the launcher defaults and takes
// only the ticked fields. Files copy with their ids (cloneTiktokCard), so twenty copies of one card
// upload their avatar and videos a single time.

import { useEffect, useState } from "react";
import { CheckIcon, MinusIcon, PlusIcon, SparklesIcon, XIcon } from "./icons";
import { TIKTOK_MAX_COPIES, tiktokCopies } from "@/lib/tiktok-launch";
import { cloneTiktokCard, freshTiktokCard, type TiktokCard } from "./tiktok-launch-card";

/** The fields the first card can push onto its copies — LION's Autofill list, in the card's order. */
type FieldKey = "advertiser" | "budget" | "mode" | "landing" | "name" | "mosh" | "smartPlus" | "adText" | "cta" | "identity" | "videos" | "countries" | "language";
const FIELDS: { key: FieldKey; label: string; preview: (c: TiktokCard) => string }[] = [
  { key: "advertiser", label: "Advertiser + Pixel", preview: (c) => (c.advertiser ? `${c.advertiser}${c.pixel ? ` · ${c.pixel}` : ""}` : "—") },
  { key: "budget", label: "Budget", preview: (c) => c.budget || "—" },
  { key: "mode", label: "Mode", preview: (c) => (c.bid ? `${c.mode} · ${c.bid}` : c.mode) },
  { key: "landing", label: "Landing URL", preview: (c) => c.landingUrl || "—" },
  { key: "name", label: "Campaign Name", preview: (c) => c.suffix || "(no custom tail)" },
  { key: "mosh", label: "MOSH", preview: (c) => String(c.mosh) },
  { key: "smartPlus", label: "Smart+", preview: (c) => (c.smartPlus ? (c.cbo ? "on · CBO" : "on") : "off") },
  { key: "adText", label: "Ad Text", preview: (c) => c.adText || "—" },
  { key: "cta", label: "CTA", preview: (c) => c.ctas.join(", ") || "—" },
  { key: "identity", label: "Identity", preview: (c) => c.identityName || "—" },
  { key: "videos", label: "Creatives", preview: (c) => `${c.videoFiles.length} video${c.videoFiles.length === 1 ? "" : "s"}` },
  { key: "countries", label: "Countries", preview: (c) => (c.countries[0] === "WW" ? "Worldwide" : c.countries.join("+") || "—") },
  { key: "language", label: "Language", preview: (c) => c.language || "none" },
];

/** Apply the ticked fields of `source` onto a fresh card. */
function copyFields(source: TiktokCard, selected: Set<FieldKey>): TiktokCard {
  const src = cloneTiktokCard(source); // fresh arrays + file objects, files keep their ids
  const card = freshTiktokCard();
  if (selected.has("advertiser")) {
    card.advertiser = src.advertiser;
    card.pixel = src.pixel;
  }
  if (selected.has("budget")) card.budget = src.budget;
  if (selected.has("mode")) {
    card.mode = src.mode;
    card.bid = src.bid;
  }
  if (selected.has("landing")) card.landingUrl = src.landingUrl;
  if (selected.has("name")) card.suffix = src.suffix;
  if (selected.has("mosh")) card.mosh = src.mosh;
  if (selected.has("smartPlus")) {
    card.smartPlus = src.smartPlus;
    card.cbo = src.cbo;
  }
  if (selected.has("adText")) card.adText = src.adText;
  // A classic card holds exactly ONE CTA — Smart+ left unticked must not smuggle three in.
  if (selected.has("cta")) card.ctas = card.smartPlus ? src.ctas : src.ctas.slice(0, 1);
  if (selected.has("identity")) {
    card.identityName = src.identityName;
    card.identityFiles = src.identityFiles;
    card.identityUrl = src.identityUrl;
  }
  if (selected.has("videos")) card.videoFiles = src.videoFiles;
  // Countries and languages are the ADVERTISER's own lists — without it they would point nowhere.
  if (selected.has("countries") && selected.has("advertiser")) card.countries = src.countries;
  if (selected.has("language") && selected.has("advertiser")) card.language = src.language;
  if (card.ctas.length === 0) card.ctas = ["LEARN_MORE"];
  return card;
}

export function TiktokAutofillModal({
  open,
  source,
  room,
  onClose,
  onCreate,
}: {
  open: boolean;
  source: TiktokCard | null;
  /** How many more cards the board can take (its card cap minus what is on it). */
  room: number;
  onClose: () => void;
  onCreate: (cards: TiktokCard[]) => void;
}) {
  const [copies, setCopies] = useState("3");
  const [selected, setSelected] = useState<Set<FieldKey>>(new Set(FIELDS.map((f) => f.key)));

  // Reset to "everything, 3 copies" each open — a plain reset-on-open, no cascade.
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCopies("3");
    setSelected(new Set(FIELDS.map((f) => f.key)));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);

  if (!open || !source) return null;

  const cap = Math.max(1, Math.min(TIKTOK_MAX_COPIES, room));
  const n = Math.min(cap, tiktokCopies(copies));
  const advertiserOff = !selected.has("advertiser");
  const toggle = (k: FieldKey) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  const create = () => onCreate(Array.from({ length: n }, () => copyFields(source, selected)));

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="animate-fade-in absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label="Autofill copies" className="animate-pop-in relative flex max-h-[88vh] w-full max-w-[520px] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_30px_80px_rgba(0,0,0,0.6)]">
        {/* header */}
        <div className="flex items-start justify-between gap-3 border-b border-line px-6 py-5">
          <div className="flex items-center gap-3.5">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-accent/25 to-accent2/25 text-[#9db8ff]">
              <SparklesIcon className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-[17px] font-semibold leading-tight text-ink">Autofill copies</h2>
              <p className="mt-1.5 text-[13px] text-dim">
                New cards copying the ticked fields from <span className="font-medium text-ink">campaign 01</span>.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-faint transition-colors hover:bg-raise hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        {/* number of copies */}
        <div className="flex items-center justify-between border-b border-line px-6 py-3">
          <span className={"text-[12px] font-semibold uppercase tracking-[0.14em] text-faint"}>Number of copies</span>
          <div className="flex items-center overflow-hidden rounded-lg border border-line bg-surface2">
            <button
              type="button"
              onClick={() => setCopies(String(Math.max(1, n - 1)))}
              disabled={n <= 1}
              aria-label="Fewer copies"
              className="flex h-8 w-8 items-center justify-center text-faint transition-colors hover:bg-raise hover:text-ink disabled:opacity-30"
            >
              <MinusIcon className="h-3.5 w-3.5" />
            </button>
            <input
              value={copies}
              onChange={(e) => {
                const raw = e.target.value.replace(/\D/g, "").slice(0, 2);
                setCopies(raw !== "" && Number(raw) > cap ? String(cap) : raw);
              }}
              onBlur={() => {
                if (copies === "" || Number(copies) < 1) setCopies("1");
              }}
              inputMode="numeric"
              aria-label="Number of copies"
              className="w-10 bg-transparent px-1 text-center font-mono text-[13px] tabular-nums text-[#9db8ff] outline-none"
            />
            <button
              type="button"
              onClick={() => setCopies(String(Math.min(cap, n + 1)))}
              disabled={n >= cap}
              aria-label="More copies"
              className="flex h-8 w-8 items-center justify-center text-faint transition-colors hover:bg-raise hover:text-ink disabled:opacity-30"
            >
              <PlusIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* fields */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {FIELDS.map((f) => {
            const checked = selected.has(f.key);
            // Countries / Language are the advertiser's own lists — they can't travel without it.
            const orphan = advertiserOff && (f.key === "countries" || f.key === "language");
            return (
              <button
                key={f.key}
                type="button"
                role="checkbox"
                aria-checked={checked && !orphan}
                onClick={() => toggle(f.key)}
                disabled={orphan}
                title={orphan ? "Needs the advertiser — the list is that advertiser's own" : undefined}
                className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors duration-100 hover:bg-raise/60 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <span
                  className={
                    "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors " +
                    (checked && !orphan ? "border-accent bg-accent text-white" : "border-line2 bg-surface")
                  }
                >
                  {checked && !orphan ? <CheckIcon className="h-3.5 w-3.5" /> : null}
                </span>
                <span className="flex-1 truncate text-[14px] text-ink">{f.label}</span>
                <span className="max-w-[50%] shrink-0 truncate text-right font-mono text-[12px] text-faint">{f.preview(source)}</span>
              </button>
            );
          })}
        </div>

        {/* footer */}
        <div className="flex items-center justify-end gap-2.5 border-t border-line px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-line bg-surface px-4 py-2.5 text-[14px] font-medium text-dim transition-colors hover:border-line2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={create}
            className="flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/15 px-4 py-2.5 text-[14px] font-semibold text-[#9db8ff] transition-all duration-150 hover:border-accent/60 hover:bg-accent/25 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <SparklesIcon className="h-4 w-4" />
            Create {n} cop{n === 1 ? "y" : "ies"}
          </button>
        </div>
      </div>
    </div>
  );
}
