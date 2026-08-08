"use client";

import { useEffect, useState } from "react";
import type { RichOption } from "@/lib/catalog";

/** A fanka picker option: RichOption for the SearchSelect + the raw ad count for badges. */
export type FanpageOption = RichOption & { adCount: number | null };

/**
 * Fanpages the launch token can advertise with, as picker options (value = page ID; display names
 * duplicate across the token's pages, so the id is the search key). Each option carries the
 * page's live "ads running or in review" count as a right-aligned "N/limit" tag (dim → warn ≥80%
 * → danger ≥100%); count unavailable → no tag.
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
    fetch("/api/fanpages")
      .then((r) => r.json())
      .then((d: { ok?: boolean; pages?: Array<{ id: string; name: string; adCount?: number | null }> }) => {
        if (!alive) return;
        if (d?.ok && Array.isArray(d.pages)) {
          setPages(
            d.pages.map((p): FanpageOption => {
              const adCount = typeof p.adCount === "number" ? p.adCount : null;
              const ratio = adCount !== null && limit > 0 ? adCount / limit : 0;
              const tagTone: FanpageOption["tagTone"] =
                ratio >= 1 ? "danger" : ratio >= 0.8 ? "warn" : "dim";
              return {
                value: p.id,
                label: p.name,
                adCount,
                ...(adCount !== null ? { tag: `${adCount}/${limit}`, tagTone } : {}),
              };
            }),
          );
        } else {
          setPages([]);
        }
      })
      .catch(() => {
        if (alive) setPages([]);
      });
    return () => {
      alive = false;
    };
  }, [enabled, limit]);

  return pages;
}
