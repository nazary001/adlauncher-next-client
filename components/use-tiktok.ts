"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TwAdvertiser, TwConfig } from "@/lib/tiktok-weapon";

// Re-exported so the boards import every TikTok client type from one place (these are all
// `type`-only — tiktok-weapon.ts is server code, but a type import is erased and never pulls the
// server module into the client bundle).
export type { TwAdvertiser, TwConfig, TwPixel } from "@/lib/tiktok-weapon";
export type { TiktokDatasetState, TiktokSourceInfo } from "@/lib/tiktok-source";

export type TiktokAdvertisers = {
  /** The advertisers our LION user may launch on NOW. null = still loading. */
  advertisers: TwAdvertiser[] | null;
  /** LION user's ACR (lower-cased, e.g. "glo-01") — printed in campaign names and stamped as mb=. */
  acr: string;
  /** false = this instance reads the live partner but refuses to fire at it (not production). */
  liveLaunch: boolean;
  /** The last load's error sentence — null when there is none. */
  error: string | null;
  /** Manual re-ask (clears the cooldown and fires at once). */
  retry: () => void;
};

const RETRY_COOLDOWN_MS = 8_000;
const MAX_AUTO_ATTEMPTS = 4;

/**
 * One-shot loader of GET /api/tiktok/advertisers for every advertiser picker. Loads once on mount;
 * a transient partner blip auto-retries a few times on a cooldown (the list is the whole board's
 * catalog, so an empty picker until F5 would strand the buyer), then holds the error with a manual
 * `retry`. Same claim discipline as useGoogleCustomers: refs guard the in-flight/done state so a
 * re-render can't start a second fetch.
 */
export function useTiktokAdvertisers(): TiktokAdvertisers {
  const [advertisers, setAdvertisers] = useState<TwAdvertiser[] | null>(null);
  const [acr, setAcr] = useState("");
  const [liveLaunch, setLiveLaunch] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inflightRef = useRef(false);
  const doneRef = useRef(false);
  const attemptRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Holds the latest `load` so the retry timer can call it without `load` referencing itself at
  // declaration time (a self-reference in the useCallback trips react-hooks/immutability).
  const loadRef = useRef<(() => void) | null>(null);

  const load = useCallback(async () => {
    if (inflightRef.current || doneRef.current) return;
    inflightRef.current = true;
    try {
      const res = await fetch("/api/tiktok/advertisers");
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; advertisers?: TwAdvertiser[]; acr?: string; liveLaunch?: boolean; error?: string };
      if (!res.ok || !d?.ok || !Array.isArray(d.advertisers)) throw new Error(d?.error || `HTTP ${res.status}`);
      doneRef.current = true;
      setAdvertisers(d.advertisers);
      setAcr(String(d.acr ?? ""));
      setLiveLaunch(d.liveLaunch !== false);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      attemptRef.current += 1;
      if (attemptRef.current < MAX_AUTO_ATTEMPTS) {
        timerRef.current = setTimeout(() => {
          loadRef.current?.();
        }, RETRY_COOLDOWN_MS);
      }
    } finally {
      inflightRef.current = false;
    }
  }, []);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  const retry = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    attemptRef.current = 0;
    doneRef.current = false;
    setError(null);
    void load();
  }, [load]);

  useEffect(() => {
    // load() only setStates AFTER its fetch resolves (an async callback update, the rule's own
    // exception) — the analyzer can't see through the useCallback boundary, so disable it here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [load]);

  return { advertisers, acr, liveLaunch, error, retry };
}

/** One advertiser's config as the board holds it: loaded, failed (with the sentence), or absent
 *  (= still loading / never asked). */
export type TiktokConfigEntry = TwConfig | { error: string };

// Shared across every card and both boards for the tab's life — a config is per ADVERTISER, and
// the same advertiser is usually picked on many cards. Failures are NOT cached (retry re-asks).
const configCache = new Map<string, TwConfig>();
const configInflight = new Map<string, Promise<TwConfig>>();

async function fetchConfig(advertiserId: string): Promise<TwConfig> {
  const hit = configCache.get(advertiserId);
  if (hit) return hit;
  const running = configInflight.get(advertiserId);
  if (running) return running;
  const p = (async () => {
    try {
      const res = await fetch(`/api/tiktok/config?advertiser=${encodeURIComponent(advertiserId)}`);
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; config?: TwConfig; error?: string };
      if (!res.ok || !d?.ok || !d.config) throw new Error(d?.error || `HTTP ${res.status}`);
      configCache.set(advertiserId, d.config);
      return d.config;
    } finally {
      configInflight.delete(advertiserId);
    }
  })();
  configInflight.set(advertiserId, p);
  return p;
}

/**
 * Configs (pixels + their modes, countries, languages) of the advertisers currently picked on the
 * board, keyed by advertiser id. An id missing from the map is still loading. `retry(id)` re-asks
 * a failed one.
 */
export function useTiktokConfigs(advertiserIds: string[]): { configs: Record<string, TiktokConfigEntry>; retry: (advertiserId: string) => void } {
  const [configs, setConfigs] = useState<Record<string, TiktokConfigEntry>>({});
  const askedRef = useRef(new Set<string>());
  const key = [...new Set(advertiserIds.filter(Boolean))].sort().join(",");

  const ask = useCallback((id: string) => {
    askedRef.current.add(id);
    fetchConfig(id).then(
      (cfg) => setConfigs((c) => ({ ...c, [id]: cfg })),
      (e) => setConfigs((c) => ({ ...c, [id]: { error: e instanceof Error ? e.message : String(e) } })),
    );
  }, []);

  useEffect(() => {
    for (const id of key ? key.split(",") : []) if (!askedRef.current.has(id)) ask(id);
  }, [key, ask]);

  const retry = useCallback(
    (id: string) => {
      setConfigs((c) => {
        const next = { ...c };
        delete next[id];
        return next;
      });
      ask(id);
    },
    [ask],
  );

  return { configs, retry };
}

/** Landing suggestions — the bare landings the team's TikTok campaigns run now (every one is on
 *  LION's allowed-domain list by construction). Best effort: a failure is simply no suggestions. */
export function useTiktokLandings(): string[] {
  const [landings, setLandings] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    fetch("/api/tiktok/landings")
      .then((r) => r.json())
      .then((d: { ok?: boolean; landings?: { url: string }[] }) => {
        if (alive && d?.ok && Array.isArray(d.landings)) setLandings(d.landings.map((l) => String(l.url)).filter(Boolean));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return landings;
}
