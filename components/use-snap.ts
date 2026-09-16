"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SnapCatalog } from "@/app/api/snap/accounts/route";
import type { SnapKeyRow } from "@/lib/snap-keys";

// Type-only re-exports so the boards import every Snap client type from one place (erased at
// build time — the server modules never enter the client bundle).
export type { SnapCatalog, SnapCatalogAccount } from "@/app/api/snap/accounts/route";
export type { SnapAdAccount, SnapPixel, SnapProfile } from "@/lib/snap-api";
export type { SnapKeyRow } from "@/lib/snap-keys";

const RETRY_COOLDOWN_MS = 8_000;
const MAX_AUTO_ATTEMPTS = 4;

/** One-shot loader with a bounded auto-retry and a manual retry (the useGoogleCustomers discipline:
 *  refs guard the in-flight/done state so a re-render can't start a second fetch). */
function useOneShot<T>(url: string, pick: (d: Record<string, unknown>) => T): { data: T | null; error: string | null; retry: () => void; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inflightRef = useRef(false);
  const doneRef = useRef(false);
  /** A reload asked for while a read was in flight — exactly one follow-up read, never a queue. */
  const queuedRef = useRef(false);
  const attemptRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadRef = useRef<(() => void) | null>(null);

  const load = useCallback(async () => {
    if (inflightRef.current || doneRef.current) return;
    inflightRef.current = true;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      const d = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || !d?.ok) throw new Error(String(d?.error || `HTTP ${res.status}`));
      doneRef.current = true;
      setData(pick(d));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      attemptRef.current += 1;
      if (attemptRef.current < MAX_AUTO_ATTEMPTS) timerRef.current = setTimeout(() => loadRef.current?.(), RETRY_COOLDOWN_MS);
    } finally {
      inflightRef.current = false;
      if (queuedRef.current) {
        queuedRef.current = false;
        doneRef.current = false;
        void loadRef.current?.();
      }
    }
  }, [url, pick]);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  const retry = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    attemptRef.current = 0;
    doneRef.current = false;
    setError(null);
    void load();
  }, [load]);
  /** Silent re-read (keeps the current data on screen while it runs). A call while a read is in
   *  flight is not dropped: ONE follow-up read runs when the current one settles — the answer in
   *  flight may already be stale (the pump keeps claiming keys while the board polls). */
  const reload = useCallback(() => {
    if (inflightRef.current) {
      queuedRef.current = true;
      return;
    }
    doneRef.current = false;
    void load();
  }, [load]);

  useEffect(() => {
    // load() only setStates AFTER its fetch resolves (an async callback update, the rule's own exception).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      queuedRef.current = false;
    };
  }, [load]);

  return { data, error, retry, reload };
}

const pickCatalog = (d: Record<string, unknown>): SnapCatalog => ({
  accounts: Array.isArray(d.accounts) ? (d.accounts as SnapCatalog["accounts"]) : [],
  profiles: Array.isArray(d.profiles) ? (d.profiles as SnapCatalog["profiles"]) : [],
  ...(d.profilesError ? { profilesError: String(d.profilesError) } : {}),
  defaults: (d.defaults as SnapCatalog["defaults"]) ?? { adAccount: "", pixel: "", profile: "", brandName: "" },
});

/** GET /api/snap/accounts — the launcher's whole catalog (accounts + pixels, profiles, defaults). */
export function useSnapCatalog(): { catalog: SnapCatalog | null; error: string | null; retry: () => void } {
  const { data, error, retry } = useOneShot<SnapCatalog>("/api/snap/accounts", pickCatalog);
  return { catalog: data, error, retry };
}

export type SnapKeysState = { poolMax: number; used: SnapKeyRow[]; free: string[]; next: string | null };
const pickKeys = (d: Record<string, unknown>): SnapKeysState => ({
  poolMax: Number(d.poolMax) || 100,
  used: Array.isArray(d.used) ? (d.used as SnapKeyRow[]) : [],
  free: Array.isArray(d.free) ? (d.free as string[]) : [],
  next: typeof d.next === "string" ? d.next : null,
});

/** GET /api/snap/keys — the registry view (free keys drive the card preview + the fire gate). */
export function useSnapKeys(): { keys: SnapKeysState | null; error: string | null; refresh: () => void; poll: () => void } {
  const { data, error, retry, reload } = useOneShot<SnapKeysState>("/api/snap/keys", pickKeys);
  // `refresh` is the button (a retry when the last read failed); `poll` is the silent re-read the
  // launch board runs while builds are in flight — what is on screen stays until the answer lands.
  return { keys: data, error, refresh: error ? retry : reload, poll: reload };
}
