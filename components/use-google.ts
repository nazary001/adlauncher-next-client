"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GwCustomer } from "@/lib/google-weapon";

// Re-exported so the board imports every Google client type from one place (these are all
// `type`-only — google-weapon.ts is server code, but a type import is erased and never pulls the
// server module into the client bundle).
export type { GwCustomer } from "@/lib/google-weapon";
export type { GoogleDatasetState, GoogleSourceInfo } from "@/lib/google-source";

export type GoogleCustomers = {
  /** The Google Ads accounts our LION user may launch on. null = still loading. */
  customers: GwCustomer[] | null;
  /** LION user's ACR (lower-cased, e.g. "glo-01") — the mb=/utm prefix LION stamps on links. */
  acr: string;
  /** The last load's error sentence ("" while never-failed) — null when there is none. */
  error: string | null;
  /** Manual re-ask (clears the cooldown and fires at once). */
  retry: () => void;
};

const RETRY_COOLDOWN_MS = 8_000;
const MAX_AUTO_ATTEMPTS = 4;

/**
 * One-shot loader of GET /api/google/customers for the board's Settings + row Destination
 * pickers. Loads once on mount; a transient partner/LION blip auto-retries a few times on a
 * cooldown (the customers list is the whole board's catalog, so an empty picker until F5 would
 * strand the buyer), then holds the error with a manual `retry`. Mirrors the claim discipline of
 * useHs: refs guard the in-flight/done state so a re-render can't start a second fetch.
 */
export function useGoogleCustomers(): GoogleCustomers {
  const [customers, setCustomers] = useState<GwCustomer[] | null>(null);
  const [acr, setAcr] = useState("");
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
      const res = await fetch("/api/google/customers");
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; customers?: GwCustomer[]; acr?: string; error?: string };
      if (!res.ok || !d?.ok || !Array.isArray(d.customers)) throw new Error(d?.error || `HTTP ${res.status}`);
      doneRef.current = true;
      setCustomers(d.customers);
      setAcr(String(d.acr ?? ""));
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

  return { customers, acr, error, retry };
}
