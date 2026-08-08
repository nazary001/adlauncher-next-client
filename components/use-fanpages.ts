"use client";

import { useEffect, useState } from "react";
import type { RichOption } from "@/lib/catalog";

/** A fanka picker option: RichOption for the SearchSelect + the raw ad count for badges. */
export type FanpageOption = RichOption & { adCount: number | null };

/**
 * Fanpages the launch token can advertise with, as picker options (value = page ID; display names
 * duplicate across the token's pages, so the id is the search key).
 *
 * Loads in TWO phases so the picker opens instantly: the page list first (one fast call), then
 * the per-page "ads running or in review" counts (/api/fanpages/volume — a slow server sweep)
 * merge in as right-aligned "N/limit" tags (dim → warn ≥80% → danger ≥100%). The count is the
 * page's cross-account total — the number Meta's per-page limit meters. A counts failure leaves
 * the list intact, just untagged.
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

    async function load() {
      // Phase 1: the list itself — the picker is usable as soon as this lands.
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
        setPages(d.pages.map((p) => ({ value: p.id, label: p.name, adCount: null })));
      } catch {
        if (alive) setPages([]);
        return;
      }

      // Phase 2: fill counts — decoration only; failures never touch the loaded list.
      try {
        const v = (await fetch("/api/fanpages/volume").then((r) => r.json())) as {
          ok?: boolean;
          counts?: Record<string, number | null>;
        };
        if (!alive || !v?.ok || !v.counts) return;
        const counts = v.counts;
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
      } catch {
        /* counts unavailable — the untagged list stays */
      }
    }

    load();
    return () => {
      alive = false;
    };
  }, [enabled, limit]);

  return pages;
}
