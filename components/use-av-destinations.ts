"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AvDestinationCatalog, AvResolved } from "@/lib/av-destination";

// The card's AV Destination picker talks to three routes (WP-B), all gated by avRailEnabled() +
// avApiConfigured() server-side:
//   GET  /api/av/destinations[?fresh=1]  → the whole catalog (sites, articles, redirect domains +
//        paths/weights/liveness), each part degrading with its own *Error string.
//   GET  /api/av/destinations/check?url= → resolveAvDestination(url) for a pasted URL.
//   POST /api/av/redirect-paths          → create a redirect path, then re-pull the catalog.
// One instance per launcher board (enabled only for the AV partner); the cards share it. Reads are
// live-catalog only — no optimistic writes, no browser storage (the server is the truth).

/** The created redirect path the POST hands back (enough to select it on the card). */
export type AvCreatedPath = { id: string; path: string; url: string };

export type AvDestinations = {
  /** The last good catalog (kept across a failed refresh so the picker never blanks). */
  data: AvDestinationCatalog | null;
  loading: boolean;
  /** Whole-request failure (av_not_configured / network / non-ok) — shown with a Retry. Per-part
   *  failures ride the catalog itself (articlesError / redirectsError). */
  error: string | null;
  refresh: (force?: boolean) => void;
  /** Create a redirect path (slug + target article) through AV, then refresh the catalog so the new
   *  path is pickable. Returns the created path's bare URL on success. */
  createPath: (
    input: { domainId: string; path: string; targetUrl: string },
  ) => Promise<{ ok: true; url: string; path: AvCreatedPath } | { ok: false; error: string }>;
  /** Resolve a pasted URL (host is an AV site / redirect domain, article live / path exists). */
  check: (url: string) => Promise<AvResolved>;
};

const errText = (e: unknown): string => (e as Error)?.message ?? String(e);

export function useAvDestinations(enabled: boolean): AvDestinations {
  // Keyed by `enabled` so switching partners resets to the loading state WITHOUT a synchronous
  // setState inside the effect (the react-compiler cascade rule) — a key mismatch IS the loading
  // state, exactly like useAdAccounts / useFanpages. Every write happens from an async fetch
  // callback or an event handler (refresh / createPath), never in the effect body.
  const key = enabled ? "on" : "off";
  const [state, setState] = useState<{ key: string; data: AvDestinationCatalog | null; loading: boolean; error: string | null }>({
    key,
    data: null,
    loading: enabled,
    error: null,
  });
  // Monotonic request id: a later refresh (force) must win over an in-flight earlier one, so a slow
  // first load can't clobber a fresh catalog the buyer just asked for.
  const reqId = useRef(0);

  const doFetch = useCallback(
    (force?: boolean) => {
      const id = ++reqId.current;
      fetch(`/api/av/destinations${force ? "?fresh=1" : ""}`)
        .then(async (r) => (await r.json().catch(() => ({}))) as AvDestinationCatalog & { ok?: boolean; error?: string })
        .then((d) => {
          if (id !== reqId.current) return; // superseded by a newer refresh
          if (d && d.ok) {
            setState({
              key,
              data: {
                sites: d.sites ?? [],
                articles: d.articles ?? [],
                redirects: d.redirects ?? [],
                ...(d.articlesError ? { articlesError: d.articlesError } : {}),
                ...(d.redirectsError ? { redirectsError: d.redirectsError } : {}),
              },
              loading: false,
              error: null,
            });
          } else {
            // Keep the last good catalog on-screen; surface the reason for a Retry.
            setState((s) => ({ key, data: s.data, loading: false, error: d?.error || "av_destinations_failed — the ActiveView catalog did not load" }));
          }
        })
        .catch((e) => {
          if (id !== reqId.current) return;
          setState((s) => ({ key, data: s.data, loading: false, error: `av_destinations_failed — ${errText(e)}` }));
        });
    },
    [key],
  );

  useEffect(() => {
    if (!enabled) return;
    doFetch();
  }, [enabled, doFetch]);

  // A key mismatch (partner just flipped to AV) reads as loading with no data until the fetch lands.
  const matched = state.key === key;
  const data = matched ? state.data : null;
  const loading = enabled && (!matched || state.loading);
  const error = matched ? state.error : null;

  const refresh = useCallback(
    (force?: boolean) => {
      // Event handler (Retry / createPath) — a synchronous setState here is fine (not in an effect).
      setState((s) => ({ ...s, key, loading: true, error: null }));
      doFetch(force);
    },
    [doFetch, key],
  );

  const check = useCallback(async (url: string): Promise<AvResolved> => {
    try {
      const r = await fetch(`/api/av/destinations/check?url=${encodeURIComponent(url)}`);
      const d = (await r.json().catch(() => ({}))) as AvResolved;
      if (d && typeof (d as { ok?: unknown }).ok === "boolean") return d;
      return { ok: false, error: `destination_check_failed — the check did not answer (HTTP ${r.status})`, status: r.status };
    } catch (e) {
      return { ok: false, error: `destination_check_failed — ${errText(e)}`, status: 0 };
    }
  }, []);

  const createPath = useCallback(
    async (input: { domainId: string; path: string; targetUrl: string }) => {
      try {
        const r = await fetch("/api/av/redirect-paths", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        const d = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; path?: AvCreatedPath };
        if (r.ok && d.ok && d.path) {
          refresh(true); // the new path only becomes pickable once the catalog is re-pulled
          return { ok: true as const, url: d.path.url, path: d.path };
        }
        return { ok: false as const, error: d.error || `redirect_path_failed — HTTP ${r.status}` };
      } catch (e) {
        return { ok: false as const, error: `redirect_path_failed — ${errText(e)}` };
      }
    },
    [refresh],
  );

  return { data, loading, error, refresh, check, createPath };
}
