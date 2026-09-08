// Pure retry policy for activating a LION-born campaign. LION's `{id}/status/` answers
// "Campaign not found" for a campaign its own store has not synced yet — seconds after birth
// (live 09-09: a JURO clone WITH ads) — and the 09-08 duplicate "activate race" left a
// born-PAUSED clone paused forever under a green "done" row because the pump activated exactly
// once. That one answer heals by waiting; every other refusal does not. No runtime imports
// (leaf module — tests/activate-retry.test.ts loads it under `node --test`).

export type ActivateAttempt = { ok: boolean; alreadyActive?: boolean; message?: string };

/** Attempts per campaign (the first call counts) — ~1 minute of LION sync lag covered. */
export const ACTIVATE_MAX_ATTEMPTS = 5;
export const ACTIVATE_RETRY_MS = 15_000;

/** Milliseconds to wait before the next attempt, or null to stop (success, a refusal that does
 *  not heal, or the cap reached). `attempt` is 1-based: the attempt that just produced `result`. */
export function activateRetryDelay(result: ActivateAttempt, attempt: number): number | null {
  if (result.ok) return null;
  if (attempt >= ACTIVATE_MAX_ATTEMPTS) return null;
  return /not found/i.test(result.message ?? "") ? ACTIVATE_RETRY_MS : null;
}
