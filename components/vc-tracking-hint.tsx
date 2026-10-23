"use client";

import { useEffect, useState } from "react";
import { CheckIcon, CopyIcon } from "./icons";
import { VC_EVENT, VC_PIXEL, VC_PORTAL_URL } from "@/lib/vc-link";

// The VC card's reminder of what the landingpage's Tracking in VC must say (Pixel-ID / Token /
// Conversion-Event) — the launch optimizes on VC_PIXEL, so VC must fire into the SAME pixel. The
// Conversions API token is served by GET /api/vc/tracking (server env, signed-in buyers only — never
// in the bundle), with a live "which events has the pixel received" line from Meta's dataset quality.

type Quality = { events: { event: string; emq: number | null }[]; checkedAt: number } | { error: string; checkedAt: number } | null;
type Tracking = { token: string | null; quality: Quality };

// One read per tab session — every VC card shares it.
let trackingOnce: Promise<Tracking | null> | null = null;
function loadTracking(): Promise<Tracking | null> {
  if (!trackingOnce) {
    trackingOnce = fetch("/api/vc/tracking", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (j?.ok ? { token: j.token ?? null, quality: j.quality ?? null } : null))
      .catch(() => null);
  }
  return trackingOnce;
}

/** A copy button showing `display` (default: the value itself) and copying the whole `value`. */
function CopyChip({ label, value, display }: { label: string; value: string; display?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      title={`Copy ${label}`}
      className={
        "inline-flex h-6 max-w-full items-center gap-1 rounded-md border px-2 text-[10.5px] transition-colors " +
        (copied ? "border-launch/40 bg-launch/15 text-launch2" : "border-line2 bg-raise text-dim hover:border-accent/50 hover:text-ink")
      }
    >
      {copied ? <CheckIcon className="h-3 w-3 shrink-0" /> : <CopyIcon className="h-3 w-3 shrink-0" />}
      <span className="shrink-0 text-faint">{label}</span>
      <span className="truncate font-mono">{display ?? value}</span>
    </button>
  );
}

function qualityLine(q: Quality): { text: string; tone: "ok" | "warn" | "faint" } {
  if (!q) return { text: "", tone: "faint" };
  if ("error" in q) return { text: "pixel status unavailable", tone: "faint" };
  const purchase = q.events.find((e) => e.event.toLowerCase() === "purchase");
  if (purchase) return { text: `pixel receives Purchase${purchase.emq != null ? ` · match quality ${purchase.emq}` : ""}`, tone: "ok" };
  if (q.events.length) return { text: `pixel receives ${q.events.map((e) => e.event).join(", ")} — no Purchase yet`, tone: "warn" };
  return { text: "no events on the pixel yet — set the Tracking below on the landingpage in VC", tone: "warn" };
}

export function VcTrackingHint() {
  const [t, setT] = useState<Tracking | null>(null);
  useEffect(() => {
    let alive = true;
    void loadTracking().then((v) => {
      if (alive) setT(v);
    });
    return () => {
      alive = false;
    };
  }, []);
  const q = qualityLine(t?.quality ?? null);
  return (
    <div className="mt-2 rounded-lg border border-line bg-surface2/40 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="select-none font-mono text-[10px] uppercase tracking-[0.14em] text-faint">VC landingpage → Tracking</span>
        <a href={VC_PORTAL_URL} target="_blank" rel="noreferrer" className="text-[10.5px] text-dim underline-offset-2 hover:text-ink hover:underline">
          Open VC ↗
        </a>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <CopyChip label="Pixel-ID" value={VC_PIXEL.id} />
        {t?.token ? <CopyChip label="Token" value={t.token} display={`${t.token.slice(0, 8)}…`} /> : null}
        <span className="inline-flex h-6 items-center rounded-md border border-line2 px-2 text-[10.5px] text-dim">
          <span className="mr-1 text-faint">Event</span>
          {VC_EVENT}
        </span>
      </div>
      {q.text ? (
        <p className={"mt-1.5 text-[10.5px] leading-snug " + (q.tone === "ok" ? "text-launch2" : q.tone === "warn" ? "text-warn" : "text-faint")}>{q.text}</p>
      ) : null}
    </div>
  );
}
