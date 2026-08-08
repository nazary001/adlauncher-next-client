"use client";

import { useEffect, useState } from "react";
import type { RichOption } from "@/lib/catalog";
import type { Bound } from "@/lib/partners";

export type PixelInfo = { id: string; name: string };

/** An account picker option: RichOption for the SearchSelect + that account's own pixels. */
export type AdAccountOption = RichOption & { pixels: PixelInfo[] };

/**
 * ACTIVE ad accounts the launch token can use (value = account_id digits; meta = id, searchable),
 * each carrying its pixel list for the dependent pixel picker. Accounts that MISS the partner's
 * preferred pixel (the one the landing actually fires) get a warn tag — conversion launches
 * there optimize blind, buyers should see that before picking.
 *
 * null = still loading (or fetch failed) → the picker renders its loading hint. The server
 * re-validates every picked account/pixel on launch anyway.
 */
export function useAdAccounts(enabled: boolean, preferredPixel?: Bound): AdAccountOption[] | null {
  const [accounts, setAccounts] = useState<AdAccountOption[] | null>(null);
  const preferredId = preferredPixel?.id;
  const preferredName = preferredPixel?.name;

  useEffect(() => {
    if (!enabled) {
      setAccounts(null);
      return;
    }
    let alive = true;
    fetch("/api/adaccounts")
      .then((r) => r.json())
      .then((d: { ok?: boolean; accounts?: Array<{ id: string; name: string; pixels?: PixelInfo[] }> }) => {
        if (!alive) return;
        if (!d?.ok || !Array.isArray(d.accounts)) {
          setAccounts([]);
          return;
        }
        const short = (preferredName ?? "").replace(/^HS-Pixel-/, "") || "pixel";
        setAccounts(
          d.accounts.map((a) => {
            const pixels = Array.isArray(a.pixels) ? a.pixels : [];
            const hasPreferred = !preferredId || pixels.some((p) => p.id === preferredId);
            return {
              value: String(a.id),
              label: String(a.name),
              meta: String(a.id),
              pixels,
              ...(hasPreferred ? {} : { tag: `no ${short}`, tagTone: "warn" as const }),
            };
          }),
        );
      })
      .catch(() => {
        if (alive) setAccounts([]);
      });
    return () => {
      alive = false;
    };
  }, [enabled, preferredId, preferredName]);

  return accounts;
}

/** Pixels of the picked account (empty while unknown). */
export function pixelOptionsOf(accounts: AdAccountOption[] | null, accountId: string): PixelInfo[] {
  return accounts?.find((a) => a.value === accountId)?.pixels ?? [];
}

/** The pixel a freshly picked account should default to: the preferred one when the account
 *  carries it, else the account's first pixel, else empty (blocks readiness until resolved). */
export function defaultPixelFor(
  accounts: AdAccountOption[] | null,
  accountId: string,
  preferred?: Bound,
): string {
  const pixels = pixelOptionsOf(accounts, accountId);
  if (preferred && pixels.some((p) => p.id === preferred.id)) return preferred.id;
  return pixels[0]?.id ?? "";
}
