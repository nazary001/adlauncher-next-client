"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RichOption } from "@/lib/catalog";
import { partnerConfig } from "@/lib/partners";
import type { PixelInfo } from "./use-adaccounts";

/** One LION profile's bind space, shaped for the pickers. */
export type HsProfileData = {
  /** value = "act_…" id; ONLY enabled (status=1) accounts — disabled ones are dropped. */
  accounts: RichOption[];
  /** value = page id. */
  pages: RichOption[];
  /** FB locale ids of the profile — the Languages multi-select feed. */
  locales: { id: string; name: string }[];
  /** account_id → its currency (budget/bid hint). */
  currencies: Record<string, string>;
  /** Account ids (same "act_…" format as accounts[].value) OUR FB token can act on — the FB
   *  Token rail offers only these. null = server couldn't sweep → don't filter (fail open). */
  tokenAccounts: ReadonlySet<string> | null;
};

export type HsCatalog = {
  /** Media-buyer acronym bound to the LION token (name prefix). Empty while loading. */
  acr: string;
  /** FB Token rail provisioned server-side (FB_HS_LAUNCH_TOKEN / fallback) — gates the channel
   *  switch. false while loading, so the switch can't offer an unconfigured rail. */
  tokenLaunch: boolean;
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
  tokenLaunch: false,
  profiles: null,
  dataFor: () => undefined,
  pixelsFor: () => undefined,
  ensureProfile: () => {},
  ensurePixels: () => {},
};

// Meta's per-page ad limit the fill badge meters against (same convention as MO's picker).
const PAGE_AD_LIMIT = partnerConfig("br").pageAdLimit ?? 250;
// One retry ladder for the volume map: the server answer is complete when it lands (no
// per-page holes like MO's Graph sweep), so a success is final — only failures re-ask.
const VOLUME_RETRY_MS = 15_000;
const VOLUME_MAX_TRIES = 4;

/**
 * LION catalog feed for the HS partner: profiles + ACR once, then per-profile bind data and
 * per-account pixels on demand (each card `ensure*`s what it shows). Failed loads clear their
 * slot so a later ensure retries — but only after a cooldown, so a dead LION doesn't loop.
 */
export function useHs(enabled: boolean): HsCatalog {
  const [acr, setAcr] = useState("");
  const [tokenLaunch, setTokenLaunch] = useState(false);
  const [profiles, setProfiles] = useState<RichOption[] | null>(null);
  const [data, setData] = useState<Map<string, HsProfileData | null>>(new Map());
  const [pixels, setPixels] = useState<Map<string, PixelInfo[] | null>>(new Map());
  // page id → active-ads count (+ per-page real limits in registry mode), one global map for
  // every profile (mirrors of one pool). null = not landed (yet / at all) → pages render
  // untagged, exactly like MO's loading state.
  const [pageVolume, setPageVolume] = useState<{
    counts: Record<string, number>;
    limits: Record<string, number>;
    /** hs-tools registry: a page absent from counts is UNKNOWN (untagged, pickable). Legacy
     *  sweep: absent means 0 counted ads — the old "0/limit" contract. */
    mode: "registry" | "legacy";
  } | null>(null);
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
        const d = (await r.json().catch(() => ({}))) as {
          ok?: boolean;
          acr?: string;
          profiles?: string[];
          tokenLaunch?: boolean;
        };
        if (!alive) return;
        if (r.ok && d?.ok && Array.isArray(d.profiles)) {
          setAcr(typeof d.acr === "string" ? d.acr : "");
          setTokenLaunch(d.tokenLaunch === true);
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

  // Fill-badge feed: fetch the global page→ads map once per mount; failures retry a few times
  // (the cold server read is a slow LION metrics reduce), then give up — badges are decoration.
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function load(attempt: number): Promise<void> {
      try {
        const r = await fetch("/api/hs/page-volume");
        const d = (await r.json().catch(() => ({}))) as {
          ok?: boolean;
          counts?: Record<string, number>;
          limits?: Record<string, number>;
          mode?: string;
        };
        if (!alive) return;
        if (r.ok && d?.ok && d.counts) {
          setPageVolume({
            counts: d.counts,
            limits: d.limits ?? {},
            mode: d.mode === "registry" ? "registry" : "legacy",
          });
          return;
        }
        throw new Error(`HTTP ${r.status}`);
      } catch {
        if (alive && attempt < VOLUME_MAX_TRIES) {
          timer = setTimeout(() => void load(attempt + 1), VOLUME_RETRY_MS);
        }
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
            tokenAccounts?: string[] | null;
          };
          if (!r.ok || !d?.ok) throw new Error(`HTTP ${r.status}`);
          // Disabled accounts are DROPPED entirely (owner call 2026-08-11) — the picker offers
          // only what can actually launch; the server refuses status≠1 anyway.
          const accounts = (d.accounts ?? [])
            .filter((a) => a.status === 1)
            .map(
              (a) =>
                ({
                  value: a.id,
                  label: a.name || a.id,
                  meta: a.id,
                  subLabel: `${a.id}${a.currency ? ` · ${a.currency}` : ""}`,
                }) satisfies RichOption,
            )
            .sort((x, y) => x.label.localeCompare(y.label));
          const currencies: Record<string, string> = {};
          for (const a of d.accounts ?? []) currencies[a.id] = a.currency || "";
          const value: HsProfileData = {
            accounts,
            // subLabel switches the picker row to the two-line layout (name on top; id + fill
            // badge below) — same idiom as the accounts picker, so long page names don't truncate
            // against the id and the N/limit tag. meta stays for id-search and the closed input.
            pages: (d.pages ?? []).map((p) => ({
              value: p.id,
              label: p.name || p.id,
              meta: p.id,
              subLabel: p.id,
            })),
            locales: (d.locales ?? []).map((l) => ({ id: String(l.id), name: l.name })),
            currencies,
            tokenAccounts: Array.isArray(d.tokenAccounts) ? new Set(d.tokenAccounts.map(String)) : null,
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
          // FARM accounts carry service pixels next to the FARM one (S-1, union-*; live scan
          // 08-13) — owner rule: wherever a FARM-named pixel exists it is the ONLY offerable
          // choice, the rest are hidden. Accounts without one (single VD-C1-HS-1) pass through.
          const all = d.pixels ?? [];
          const farm = all.filter((p) => /farm/i.test(p.name));
          setPixels((m) => new Map(m).set(mapKey, farm.length > 0 ? farm : all));
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

  // Same badge grammar as MO's fanpage picker (use-fanpages): right-aligned "N/limit", dim →
  // warn ≥80% → danger ≥100%, with the page's REAL limit in registry mode. Registry mode: a page
  // absent from the map is UNKNOWN (the box never read its meter) → untagged and pickable —
  // "0/250" there would be an invitation onto numbers nobody has. Legacy sweep keeps its old
  // contract: absent = 0 counted ads → tags "0/limit".
  const decorated = useMemo(() => {
    if (!pageVolume) return data;
    const { counts, limits, mode } = pageVolume;
    const next = new Map<string, HsProfileData | null>();
    for (const [slug, d] of data) {
      next.set(
        slug,
        d && {
          ...d,
          pages: d.pages.map((p) => {
            const raw = counts[p.value];
            const n = typeof raw === "number" ? raw : mode === "legacy" ? 0 : null;
            if (n === null) return p;
            const lim = limits[p.value] ?? PAGE_AD_LIMIT;
            const ratio = lim > 0 ? n / lim : 0;
            const tagTone: RichOption["tagTone"] = ratio >= 1 ? "danger" : ratio >= 0.8 ? "warn" : "dim";
            // Full pages stay listed (the red count explains itself) but can't be picked — a
            // launch would just burn against Meta's per-page ad limit.
            return { ...p, tag: `${n}/${lim}`, tagTone, disabled: ratio >= 1 };
          }),
        },
      );
    }
    return next;
  }, [data, pageVolume]);

  const dataFor = useCallback((slug: string) => (slug ? decorated.get(slug) : undefined), [decorated]);
  const pixelsFor = useCallback(
    (slug: string, account: string) => (slug && account ? pixels.get(`${slug}|${account}`) : undefined),
    [pixels],
  );

  if (!enabled) return EMPTY;
  return { acr, tokenLaunch, profiles, dataFor, pixelsFor, ensureProfile, ensurePixels };
}
