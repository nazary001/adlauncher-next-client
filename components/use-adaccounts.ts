"use client";

import { useEffect, useState } from "react";
import type { RichOption } from "@/lib/catalog";
import type { Bound } from "@/lib/partners";

export type PixelInfo = { id: string; name: string };

/** An account picker option: RichOption for the SearchSelect + that account's own pixels. */
export type AdAccountOption = RichOption & { pixels: PixelInfo[] };

/**
 * ACTIVE ad accounts the launch token can use (value = account_id digits; meta = id, searchable),
 * each carrying its pixel list for the dependent pixel picker. Rows render PLAIN (owner call
 * 2026-08-11 — no green preferred-pixel badges); only a pixel-less account gets a danger tag,
 * since conversion launches there are impossible.
 *
 * null = still loading (or fetch failed) → the picker renders its loading hint. The server
 * re-validates every picked account/pixel on launch anyway.
 *
 * State is keyed by the hook inputs and only ever written from async fetch callbacks; a key
 * mismatch (or enabled=false) IS the loading/reset state, so the effect never needs a
 * synchronous setState reset (which the react-compiler lint flags as cascade-prone).
 */
export function useAdAccounts(enabled: boolean, preferredPixel?: Bound): AdAccountOption[] | null {
  const preferredId = preferredPixel?.id;
  const preferredName = preferredPixel?.name;
  const key = `${preferredId ?? ""}|${preferredName ?? ""}`;
  const [state, setState] = useState<{ key: string; list: AdAccountOption[] | null }>({
    key,
    list: null,
  });

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function load(attempt: number): Promise<void> {
      try {
        const r = await fetch("/api/adaccounts");
        const d = (await r.json().catch(() => ({}))) as {
          ok?: boolean;
          accounts?: Array<{ id: string; name: string; pixels?: PixelInfo[] }>;
        };
        if (!alive) return;
        if (r.ok && d?.ok && Array.isArray(d.accounts)) {
          setState({
            key,
            list: d.accounts.map((a) => {
              const pixels = Array.isArray(a.pixels) ? a.pixels : [];
              // Only a pixel-less account is flagged (danger) — conversions can't run there.
              const tag: Partial<Pick<AdAccountOption, "tag" | "tagTone">> =
                pixels.length === 0 ? { tag: "no pixel", tagTone: "danger" } : {};
              return { value: String(a.id), label: String(a.name), meta: String(a.id), subLabel: String(a.id), pixels, ...tag };
            }),
          });
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
          setState({ key, list: [] });
          return;
        }
        throw new Error(`HTTP ${r.status}`); // 429/5xx → transient, retry below
      } catch {
        if (!alive) return;
        // A transient blip must NOT strand every card un-launchable with a false "No accounts on the
        // token" and no recovery: stay in the loading state (null) and retry a few times.
        if (attempt < 4) timer = setTimeout(() => void load(attempt + 1), 4000);
        else setState({ key, list: [] });
      }
    }

    void load(0);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, key, preferredId, preferredName]);

  return enabled && state.key === key ? state.list : null;
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
