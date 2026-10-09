"use client";

// The wave a clone board just sent, remembered across a reload (sessionStorage — this tab only).
//
// Why: a clone board seeds its rows from the URL. After a wave whose answer was lost (the connection
// dropped), a reload showed every row idle again, and Fire minted a NEW wave id for campaigns the
// server may already be building — the server recognises a wave only by its id, so it built them a
// second time (audit find 09.10: the HS duplicator and the three platform cloners). The board now
// writes the wave here the moment the request goes out, erases it on any verdict (accepted or
// refused), and a board that mounts with a memory still there HOLDS those rows (components/wave-hold)
// until the server itself says whether it took the wave. The same content fired again (a retry
// after the reload) also re-uses the remembered id, so the server's wave claim makes it a no-op.

import type { WaveRail } from "./wave-hold";
import { parseRememberedWave, type RememberedWave } from "./wave-memory-core";

export type { RememberedWave };

/** Remember the wave that is going out right now (stamped here, so the boards' handlers stay pure). */
export function rememberWave(storageKey: string, wave: Omit<RememberedWave, "at" | "rail"> & { rail: WaveRail }): void {
  try {
    const stamped: RememberedWave = { ...wave, at: Date.now() };
    sessionStorage.setItem(storageKey, JSON.stringify(stamped));
  } catch {
    /* storage disabled — the in-memory waveRef still guards this tab */
  }
}

export function forgetWave(storageKey: string): void {
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    /* storage disabled */
  }
}

/** The remembered wave, or null when there is none (a malformed or stale memory is erased). */
export function recallWave(storageKey: string): RememberedWave | null {
  try {
    const raw = sessionStorage.getItem(storageKey);
    const w = parseRememberedWave(raw, Date.now());
    if (raw && !w) sessionStorage.removeItem(storageKey);
    return w;
  } catch {
    return null;
  }
}
