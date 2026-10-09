"use client";

// The hook behind a HELD wave (see wave-hold-core.ts for the why and the rules): while a wave whose
// request got no answer is held, ask the server every few seconds whether it has that wave's claim,
// and tell the board when the question is settled. The board decides what a held card looks like;
// this only keeps the list, asks, and reports.
import { useCallback, useEffect, useRef, useState } from "react";
import { type HeldWave, WAVE_HOLD_POLL_MS, type WaveVerdict, holdWave, settleHeldWaves, waveVerdictOf } from "./wave-hold-core";

/** The wave claims /api/wave-status can read: the three platform rails, the HS clone rails
 *  (LION / token duplicates and JURO share `hs-wave:<id>`) and the HS TOOL duplicator. */
export type WaveRail = "google" | "snap" | "tiktok" | "hs" | "hs-tool";

async function askWave(rail: WaveRail, waveId: string): Promise<WaveVerdict> {
  try {
    const res = await fetch(`/api/wave-status?rail=${rail}&id=${encodeURIComponent(waveId)}`, {
      cache: "no-store",
      // A hung request must not freeze the checks: the next tick asks again.
      signal: AbortSignal.timeout(15_000),
    });
    return waveVerdictOf(res.ok, await res.json().catch(() => null));
  } catch {
    return "unknown"; // still offline — nothing is decided
  }
}

export function useWaveHold(opts: {
  rail: WaveRail;
  /** The server HAS the wave: mark its cards queued. */
  onAccepted: (wave: HeldWave) => void;
  /** The server never got the wave: its cards may be launched again. */
  onReleased: (wave: HeldWave) => void;
}): { hold: (waveId: string, cardIds: string[]) => void; holding: boolean } {
  const [holding, setHolding] = useState(false);
  const held = useRef<HeldWave[]>([]);
  // The callbacks close over the board's current render; the interval must call the latest ones.
  const latest = useRef(opts);
  useEffect(() => {
    latest.current = opts;
  });

  const hold = useCallback((waveId: string, cardIds: string[]) => {
    held.current = holdWave(held.current, waveId, cardIds, Date.now());
    setHolding(true);
  }, []);

  useEffect(() => {
    if (!holding) return;
    let stopped = false;
    let busy = false;
    const tick = async () => {
      if (busy || stopped) return;
      busy = true;
      try {
        const asked = held.current.slice();
        const verdicts = new Map<string, WaveVerdict>();
        await Promise.all(asked.map(async (w) => void verdicts.set(w.waveId, await askWave(latest.current.rail, w.waveId))));
        if (stopped) return;
        // Settle against the list as it is NOW: a wave held while we were asking has no verdict yet
        // ("unknown") and simply stays.
        const { accepted, released, still } = settleHeldWaves(held.current, (id) => verdicts.get(id) ?? "unknown", Date.now());
        held.current = still;
        for (const w of accepted) latest.current.onAccepted(w);
        for (const w of released) latest.current.onReleased(w);
        if (still.length === 0) setHolding(false);
      } finally {
        busy = false;
      }
    };
    // The first question soon (an accepted wave is usually claimed within a second or two), then steadily.
    const first = setTimeout(() => void tick(), 1_200);
    const iv = setInterval(() => void tick(), WAVE_HOLD_POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(iv);
    };
  }, [holding]);

  return { hold, holding };
}
