"use client";

import { useEffect, useState } from "react";
import type { RichOption } from "@/lib/catalog";

/**
 * Fanpages the launch token can advertise with, as picker options (value = page ID; display names
 * duplicate across the token's pages, so the id doubles as the meta column and the search key).
 *
 * null = still loading (or fetch failed) → the picker renders its loading hint. Shared by the
 * launcher board and the clone board; the server re-validates every picked id on launch anyway.
 */
export function useFanpages(enabled: boolean): RichOption[] | null {
  const [pages, setPages] = useState<RichOption[] | null>(null);

  useEffect(() => {
    if (!enabled) {
      setPages(null);
      return;
    }
    let alive = true;
    fetch("/api/fanpages")
      .then((r) => r.json())
      .then((d: { ok?: boolean; pages?: Array<{ id: string; name: string }> }) => {
        if (!alive) return;
        if (d?.ok && Array.isArray(d.pages)) {
          setPages(d.pages.map((p) => ({ value: p.id, label: p.name, meta: p.id })));
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
  }, [enabled]);

  return pages;
}
