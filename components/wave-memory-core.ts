// Pure rules of the wave memory (components/wave-memory.ts): what a clone board remembers about the
// wave it just sent, and when that memory is still worth acting on. No React, no storage — so the
// Node test runner can load it by relative path.

export type RememberedWave = {
  /** The wave id the request carried. */
  id: string;
  /** The wave's content signature — the same content fired again re-uses the id. */
  sig: string;
  /** The source keys (campaign ids / refs) of the rows that went out: the rows a reloaded board holds. */
  keys: string[];
  /** The /api/wave-status rail that can answer for this wave (components/wave-hold WaveRail). */
  rail: string;
  /** When the request went out (ms). */
  at: number;
};

/** A memory older than this is ignored: the hold it would start has nothing left to decide (the
 *  server answers a wave within seconds, and a hold runs three minutes — wave-hold-core) and the
 *  Task Manager is the truth by then. A board must not freeze its rows over a wave from an hour ago. */
export const WAVE_MEMORY_MAX_MS = 30 * 60_000;

/** Parse a stored memory defensively: null for anything malformed, too old, or from the future. */
export function parseRememberedWave(raw: string | null, now: number, maxAgeMs: number = WAVE_MEMORY_MAX_MS): RememberedWave | null {
  if (!raw) return null;
  let w: unknown;
  try {
    w = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!w || typeof w !== "object") return null;
  const o = w as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id || typeof o.sig !== "string" || !Array.isArray(o.keys) || typeof o.rail !== "string" || typeof o.at !== "number") {
    return null;
  }
  if (!Number.isFinite(o.at) || now - o.at > maxAgeMs || o.at - now > 60_000) return null;
  return { id: o.id, sig: o.sig, keys: o.keys.filter((k): k is string => typeof k === "string"), rail: o.rail, at: o.at };
}

/** The board rows a memory refers to: those whose source key went out in the wave. */
export function rememberedRowIds<R extends { id: string }>(rows: readonly R[], keyOf: (row: R) => string, memory: RememberedWave): string[] {
  const keys = new Set(memory.keys);
  return rows.filter((r) => keys.has(keyOf(r))).map((r) => r.id);
}
