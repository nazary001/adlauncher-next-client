"use client";

import { useEffect, useState } from "react";
import type { RichOption } from "@/lib/catalog";

/** A fanka picker option: RichOption for the SearchSelect + the raw ad count for badges. */
export type FanpageOption = RichOption & { adCount: number | null };

// Counts converge server-side (the sweep self-heals its rate-limited holes every ~60s), so the
// client re-asks until every page has a number — a few patient polls, not a hot loop.
const VOLUME_REPOLL_MS = 75_000;
const VOLUME_MAX_POLLS = 6;

/**
 * Fanpages the launch token can advertise with, as picker options (value = page ID = the meta
 * column; display names duplicate across the token's pages, so the id is shown and searchable).
 *
 * Loads in TWO phases so the picker opens instantly: the page list first (one fast call), then
 * the per-page "ads running or in review" counts (/api/fanpages/volume — a slow server sweep)
 * merge in as right-aligned "N/limit" tags (dim → warn ≥80% → danger ≥100%). While some pages
 * still miss a number (rate-limited sweep slots), the hook keeps re-polling the volume endpoint
 * until coverage is complete. The count is the page's cross-account total — the number Meta's
 * per-page limit meters. A counts failure leaves the list intact, just untagged.
 *
 * null = still loading (or fetch failed) → the picker renders its loading hint. Shared by the
 * launcher board and the clone board; the server re-validates every picked id on launch anyway.
 */
export function useFanpages(enabled: boolean, limit = 250): FanpageOption[] | null {
  const [pages, setPages] = useState<FanpageOption[] | null>(null);

  useEffect(() => {
    if (!enabled) {
      setPages(null);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function loadVolume(ids: string[], attempt: number): Promise<void> {
      let missing = ids.length;
      try {
        const v = (await fetch("/api/fanpages/volume").then((r) => r.json())) as {
          ok?: boolean;
          counts?: Record<string, number | null>;
        };
        if (!alive) return;
        if (v?.ok && v.counts) {
          const counts = v.counts;
          missing = ids.filter((id) => typeof counts[id] !== "number").length;
          setPages((prev) =>
            prev
              ? prev.map((o) => {
                  const n = counts[o.value];
                  if (typeof n !== "number") return o;
                  const ratio = limit > 0 ? n / limit : 0;
                  const tagTone: FanpageOption["tagTone"] =
                    ratio >= 1 ? "danger" : ratio >= 0.8 ? "warn" : "dim";
                  return { ...o, adCount: n, tag: `${n}/${limit}`, tagTone };
                })
              : prev,
          );
        }
      } catch {
        /* counts unavailable this round — the list stays, we just try again */
      }
      // Some pages still numberless (throttled sweep slots) → ask again after the server's
      // heal window; the sweep fills holes incrementally, so coverage only grows.
      if (alive && missing > 0 && attempt < VOLUME_MAX_POLLS) {
        timer = setTimeout(() => void loadVolume(ids, attempt + 1), VOLUME_REPOLL_MS);
      }
    }

    async function load() {
      // Phase 1: the list itself — the picker is usable as soon as this lands.
      let ids: string[] = [];
      try {
        const d = (await fetch("/api/fanpages").then((r) => r.json())) as {
          ok?: boolean;
          pages?: Array<{ id: string; name: string }>;
        };
        if (!alive) return;
        if (!d?.ok || !Array.isArray(d.pages)) {
          setPages([]);
          return;
        }
        ids = d.pages.map((p) => p.id);
        setPages(d.pages.map((p) => ({ value: p.id, label: p.name, meta: p.id, adCount: null })));
      } catch {
        if (alive) setPages([]);
        return;
      }
      // Phase 2+: fill counts — decoration only; polls until every page has its number.
      await loadVolume(ids, 1);
    }

    void load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, limit]);

  return pages;
}
