// A wave on the Google / Snapchat / TikTok rails is ONE request: the board sends every ready card
// under one wave id and the server answers once. When that answer never arrives (the connection
// dropped), nobody on the page knows whether the server took the wave — and its cards used to stay
// launchable: adding or editing a card and pressing Launch again sent them under a NEW wave id, and
// the server, which recognises a wave only by its id, built the same campaigns a second time
// (review find 08.10, confirmed for the Google and Snapchat boards).
//
// So such a wave is HELD: its cards are not launchable until the server itself says what happened
// to it (GET /api/wave-status reads the wave's claim — the record the server writes the moment it
// accepts a wave):
//   • the claim is there                                  → the server HAS the wave: cards read queued;
//   • no claim, and WAVE_HOLD_MS have passed              → it never got it: cards may be launched again;
//   • the answer could not be read (still offline, 5xx)   → nothing is decided; keep holding.
// Pure rules only (no React, no fetch) — components/wave-hold.ts drives them.

export type HeldWave = {
  /** The wave id the unanswered request carried. */
  waveId: string;
  /** The board cards that went out in it. */
  cardIds: string[];
  /** When the request failed (ms). */
  since: number;
};

/** What the server said about one wave: its claim exists / it does not / it could not be asked. */
export type WaveVerdict = "accepted" | "absent" | "unknown";

/** How long a wave with no claim is held before it is declared "never received". A request that DID
 *  reach the server writes its claim right after validating the wave — seconds; three minutes also
 *  covers a validation that waits on slow upstream reads (each bounded at 60 s). */
export const WAVE_HOLD_MS = 180_000;
/** How often the server is asked while a wave is held. */
export const WAVE_HOLD_POLL_MS = 3_000;

/**
 * Sort the held waves by the server's verdicts and the clock.
 *   accepted — the claim exists (evidence beats the timer: however late it shows up);
 *   released — the server answered "no claim" AND the hold has run its full time;
 *   still    — everything else, including every wave the server could not be asked about: a wave
 *              is never released on silence alone.
 */
export function settleHeldWaves(
  held: readonly HeldWave[],
  verdictOf: (waveId: string) => WaveVerdict,
  now: number,
  holdMs: number = WAVE_HOLD_MS,
): { accepted: HeldWave[]; released: HeldWave[]; still: HeldWave[] } {
  const accepted: HeldWave[] = [];
  const released: HeldWave[] = [];
  const still: HeldWave[] = [];
  for (const w of held) {
    const v = verdictOf(w.waveId);
    if (v === "accepted") accepted.push(w);
    else if (v === "absent" && now - w.since >= holdMs) released.push(w);
    else still.push(w);
  }
  return { accepted, released, still };
}

/** Add a wave to the held list (a wave already held keeps its original start — a second failed
 *  attempt must not restart its clock, and gains any card ids the new attempt carried). */
export function holdWave(held: readonly HeldWave[], waveId: string, cardIds: readonly string[], now: number): HeldWave[] {
  const prev = held.find((w) => w.waveId === waveId);
  const next: HeldWave = prev
    ? { ...prev, cardIds: [...new Set([...prev.cardIds, ...cardIds])] }
    : { waveId, cardIds: [...new Set(cardIds)], since: now };
  return [...held.filter((w) => w.waveId !== waveId), next];
}

/** The server's answer to GET /api/wave-status, read defensively: only a 2xx JSON `{ ok: true,
 *  accepted: boolean }` is a verdict — anything else is "could not be asked". */
export function waveVerdictOf(httpOk: boolean, body: unknown): WaveVerdict {
  if (!httpOk || !body || typeof body !== "object") return "unknown";
  const b = body as { ok?: unknown; accepted?: unknown };
  if (b.ok !== true || typeof b.accepted !== "boolean") return "unknown";
  return b.accepted ? "accepted" : "absent";
}

/** The note a held card carries while the server is asked. */
export const WAVE_HELD_NOTE = "no answer from the server — checking whether it took this wave (do not launch it again; this clears by itself)";
/** …once the server says it has the wave. */
export const WAVE_ACCEPTED_NOTE = "queued — the server had taken the wave; only its answer was lost";
/** …once the server says it never got it. */
export const WAVE_RELEASED_NOTE = "the server never received this wave — launch it again";
