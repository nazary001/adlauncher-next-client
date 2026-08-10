"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RichOption } from "@/lib/catalog";
import type { PixelInfo } from "./use-adaccounts";

/** One LION profile's bind space, shaped for the pickers. */
export type HsProfileData = {
  /** value = "act_…" id; disabled accounts carry a danger tag and sort last. */
  accounts: RichOption[];
  /** value = page id. */
  pages: RichOption[];
  /** FB locale ids of the profile — the Languages multi-select feed. */
  locales: { id: string; name: string }[];
  /** account_id → its currency (budget/bid hint). */
  currencies: Record<string, string>;
};

export type HsCatalog = {
  /** Media-buyer acronym bound to the LION token (name prefix). Empty while loading. */
  acr: string;
  /** Profile slugs. null = loading (or failed → retried). */
  profiles: RichOption[] | null;
  /** Profile bind space: undefined = never requested / failed, null = loading. */
  dataFor: (slug: string) => HsProfileData | null | undefined;
  pixelsFor: (slug: string, account: string) => PixelInfo[] | null | undefined;
  /** Idempotent loaders — safe to call from card effects on every render. */
  ensureProfile: (slug: string) => void;
  ensurePixels: (slug: string, account: string) => void;
};

const EMPTY: HsCatalog = {
  acr: "",
  profiles: null,
  dataFor: () => undefined,
  pixelsFor: () => undefined,
  ensureProfile: () => {},
  ensurePixels: () => {},
};

/**
 * LION catalog feed for the HS partner: profiles + ACR once, then per-profile bind data and
 * per-account pixels on demand (each card `ensure*`s what it shows). Failed loads clear their
 * slot so a later ensure retries — but only after a cooldown, so a dead LION doesn't loop.
 */
export function useHs(enabled: boolean): HsCatalog {
  const [acr, setAcr] = useState("");
  const [profiles, setProfiles] = useState<RichOption[] | null>(null);
  const [data, setData] = useState<Map<string, HsProfileData | null>>(new Map());
  const [pixels, setPixels] = useState<Map<string, PixelInfo[] | null>>(new Map());
  // Fetch guards live in refs, NOT in the state maps: a state-updater runs whenever React gets to
  // it, so "claim the slot inside the updater" races the render and can silently never start the
  // fetch. Refs are synchronous — one caller wins, everyone else no-ops.
  const inflightRef = useRef(new Set<string>());
  const doneRef = useRef(new Set<string>());
  // Failed keys → retry-not-before timestamp (ensure* skips them during the cooldown).
  const failedAt = useRef(new Map<string, number>());
  const FAIL_COOLDOWN_MS = 20_000;

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // No loading reset here: on a re-enable the previous list stays visible (it is cached LION
    // data, not per-partner state) and the refetch below overwrites it when it lands.

    async function load(attempt: number): Promise<void> {
      try {
        const r = await fetch("/api/hs/profiles");
        const d = (await r.json().catch(() => ({}))) as { ok?: boolean; acr?: string; profiles?: string[] };
        if (!alive) return;
        if (r.ok && d?.ok && Array.isArray(d.profiles)) {
          setAcr(typeof d.acr === "string" ? d.acr : "");
          setProfiles(d.profiles.map((slug) => ({ value: slug, label: slug })));
          return;
        }
        throw new Error(`HTTP ${r.status}`);
      } catch {
        if (!alive) return;
        // Transient LION/API blip — keep the loading state and retry instead of stranding the
        // partner with an empty profile picker until F5.
        if (attempt < 5) timer = setTimeout(() => void load(attempt + 1), 5000);
        else setProfiles([]);
      }
    }

    void load(0);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [enabled]);

  const ensureProfile = useCallback(
    (slug: string) => {
      if (!enabled || !slug) return;
      const key = `d:${slug}`;
      if (inflightRef.current.has(key) || doneRef.current.has(key)) return;
      const cooldown = failedAt.current.get(key);
      if (cooldown && Date.now() < cooldown) return;
      inflightRef.current.add(key);
      setData((m) => (m.has(slug) ? m : new Map(m).set(slug, null))); // null = loading
      void (async () => {
        try {
          const r = await fetch(`/api/hs/profile-data?slug=${encodeURIComponent(slug)}`);
          const d = (await r.json().catch(() => ({}))) as {
            ok?: boolean;
            accounts?: { id: string; name: string; currency: string; status: number }[];
            pages?: { id: string; name: string }[];
            locales?: { id: number; name: string }[];
          };
          if (!r.ok || !d?.ok) throw new Error(`HTTP ${r.status}`);
          const accounts = (d.accounts ?? [])
            .map((a) => ({
              opt: {
                value: a.id,
                label: a.name || a.id,
                meta: a.id,
                subLabel: `${a.id}${a.currency ? ` · ${a.currency}` : ""}`,
                ...(a.status === 1 ? {} : { tag: "disabled", tagTone: "danger" as const }),
              } satisfies RichOption,
              active: a.status === 1,
            }))
            // Active accounts first — a launch into a disabled one is refused server-side anyway.
            .sort((x, y) => Number(y.active) - Number(x.active) || x.opt.label.localeCompare(y.opt.label))
            .map((x) => x.opt);
          const currencies: Record<string, string> = {};
          for (const a of d.accounts ?? []) currencies[a.id] = a.currency || "";
          const value: HsProfileData = {
            accounts,
            pages: (d.pages ?? []).map((p) => ({ value: p.id, label: p.name || p.id, meta: p.id })),
            locales: (d.locales ?? []).map((l) => ({ id: String(l.id), name: l.name })),
            currencies,
          };
          failedAt.current.delete(key);
          doneRef.current.add(key);
          setData((m) => new Map(m).set(slug, value));
        } catch {
          failedAt.current.set(key, Date.now() + FAIL_COOLDOWN_MS);
          setData((m) => {
            const next = new Map(m);
            next.delete(slug); // slot free again → a later ensure (post-cooldown) retries
            return next;
          });
        } finally {
          inflightRef.current.delete(key);
        }
      })();
    },
    [enabled],
  );

  const ensurePixels = useCallback(
    (slug: string, account: string) => {
      if (!enabled || !slug || !account) return;
      const mapKey = `${slug}|${account}`;
      const key = `p:${mapKey}`;
      if (inflightRef.current.has(key) || doneRef.current.has(key)) return;
      const cooldown = failedAt.current.get(key);
      if (cooldown && Date.now() < cooldown) return;
      inflightRef.current.add(key);
      setPixels((m) => (m.has(mapKey) ? m : new Map(m).set(mapKey, null)));
      void (async () => {
        try {
          const r = await fetch(
            `/api/hs/pixels?slug=${encodeURIComponent(slug)}&account=${encodeURIComponent(account)}`,
          );
          const d = (await r.json().catch(() => ({}))) as { ok?: boolean; pixels?: PixelInfo[] };
          if (!r.ok || !d?.ok || !Array.isArray(d.pixels)) throw new Error(`HTTP ${r.status}`);
          failedAt.current.delete(key);
          doneRef.current.add(key);
          setPixels((m) => new Map(m).set(mapKey, d.pixels ?? []));
        } catch {
          failedAt.current.set(key, Date.now() + FAIL_COOLDOWN_MS);
          setPixels((m) => {
            const next = new Map(m);
            next.delete(mapKey);
            return next;
          });
        } finally {
          inflightRef.current.delete(key);
        }
      })();
    },
    [enabled],
  );

  const dataFor = useCallback((slug: string) => (slug ? data.get(slug) : undefined), [data]);
  const pixelsFor = useCallback(
    (slug: string, account: string) => (slug && account ? pixels.get(`${slug}|${account}`) : undefined),
    [pixels],
  );

  if (!enabled) return EMPTY;
  return { acr, profiles, dataFor, pixelsFor, ensureProfile, ensurePixels };
}
