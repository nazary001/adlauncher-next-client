// Node's built-in runner: `node --test tests/activate-retry.test.ts`.
// LION's `{id}/status/` answers "Campaign not found" for a campaign its own store has not synced
// yet (live 09-09: a JURO clone WITH ads, seconds after birth; the 09-08 duplicate "activate race"
// left a born-PAUSED clone paused forever under a green row) — the pumps retry that one answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTIVATE_MAX_ATTEMPTS, ACTIVATE_RETRY_MS, activateRetryDelay } from "../lib/activate-retry.ts";

test("success (or already active) → stop", () => {
  assert.equal(activateRetryDelay({ ok: true }, 1), null);
  assert.equal(activateRetryDelay({ ok: true, alreadyActive: true }, 1), null);
});

test("'Campaign not found' → wait and retry, up to the attempt cap", () => {
  assert.equal(activateRetryDelay({ ok: false, message: "activate_failed: Campaign not found" }, 1), ACTIVATE_RETRY_MS);
  assert.equal(activateRetryDelay({ ok: false, message: "LION 404: Campaign Not Found" }, ACTIVATE_MAX_ATTEMPTS - 1), ACTIVATE_RETRY_MS);
  assert.equal(activateRetryDelay({ ok: false, message: "Campaign not found" }, ACTIVATE_MAX_ATTEMPTS), null);
});

test("any other refusal does not heal by waiting → stop", () => {
  assert.equal(activateRetryDelay({ ok: false, message: "Permissions error" }, 1), null);
  assert.equal(activateRetryDelay({ ok: false, message: "business account not allowed to advertise" }, 1), null);
  assert.equal(activateRetryDelay({ ok: false }, 1), null);
});
