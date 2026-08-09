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
    let timer: ReturnType<typeof setTimeout> | null = null;
    setAccounts(null); // (re)enter loading state

    async function load(attempt: number): Promise<void> {
      try {
        const r = await fetch("/api/adaccounts");
        const d = (await r.json().catch(() => ({}))) as {
          ok?: boolean;
          accounts?: Array<{ id: string; name: string; pixels?: PixelInfo[] }>;
        };
        if (!alive) return;
        if (r.ok && d?.ok && Array.isArray(d.accounts)) {
          const short = (preferredName ?? "").replace(/^HS-Pixel-/, "") || "pixel"; // "HS-Pixel-FARM-1" → "FARM-1"
          setAccounts(
            d.accounts.map((a) => {
              const pixels = Array.isArray(a.pixels) ? a.pixels : [];
              const hasPreferred = !preferredId || pixels.some((p) => p.id === preferredId);
              // Tag semantics: no pixel at all = can't run conversions (danger); has the preferred
              // pixel = green marker. An account with some OTHER pixel is FINE now (the buy link
              // carries &pixel=<that pixel> so the funnel fires it and CAPI matches the adset) — no
              // warning, that was only true before the URL-pixel funnel.
              const tag: Partial<Pick<AdAccountOption, "tag" | "tagTone">> =
                pixels.length === 0
                  ? { tag: "no pixel", tagTone: "danger" }
                  : preferredId && hasPreferred
                    ? { tag: short, tagTone: "ok" }
                    : {};
              return { value: String(a.id), label: String(a.name), meta: String(a.id), subLabel: String(a.id), pixels, ...tag };
            }),
          );
          // Coverage check: the preferred pixel (FARM-1) lives on at least one account, so if NO
          // loaded account shows it, the server's pixel sweep was throttled/incomplete — keep
          // re-polling (the shown list is usable meanwhile) until the pixels fill in.
          const coverageOk =
            !preferredId || d.accounts.some((a) => (a.pixels ?? []).some((p) => p.id === preferredId));
          if (!coverageOk && attempt < 8) timer = setTimeout(() => void load(attempt + 1), 12000);
          return;
        }
        // HTTP 200 + ok:false = a genuine "no accounts / no token" answer → show the empty hint.
        if (r.ok) {
          setAccounts([]);
          return;
        }
        throw new Error(`HTTP ${r.status}`); // 429/5xx → transient, retry below
      } catch {
        if (!alive) return;
        // A transient blip must NOT strand every card un-launchable with a false "No accounts on the
        // token" and no recovery: stay in the loading state (null) and retry a few times.
        if (attempt < 4) timer = setTimeout(() => void load(attempt + 1), 4000);
        else setAccounts([]);
      }
    }

    void load(0);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
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
