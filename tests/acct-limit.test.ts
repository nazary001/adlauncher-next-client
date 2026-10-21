// lib/acct-limit.ts — the pure half of the per-account launch limit (window maths, the refusal text,
// the snapshot). The store half lives in mongo-claims.test.ts. Run: node --test tests/acct-limit.test.ts
// The window is 15 min on both teams since 21.10 (owner: "снизь таймер с 30 минут на акаунт до 15").
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACCT_LIMIT, ACCT_WINDOW_MS, acctLimitMessage, deriveSnapshot, windowActive } from "../lib/acct-limit.ts";

const MIN = 60_000;

test("the window is 15 minutes, still 5 campaigns per account", () => {
  assert.equal(ACCT_WINDOW_MS, 15 * MIN);
  assert.equal(ACCT_LIMIT, 5);
});

test("windowActive: open until 15 min after the anchor, closed at 15 min sharp", () => {
  const ws = 1_000_000;
  assert.equal(windowActive(ws, ws), true);
  assert.equal(windowActive(ws, ws + 15 * MIN - 1), true);
  assert.equal(windowActive(ws, ws + 15 * MIN), false);
  assert.equal(windowActive(ws, ws + 20 * MIN), false, "what used to be inside the 30-min window is over now");
  assert.equal(windowActive(0, 1), false);
});

test("acctLimitMessage names the 15-min window and the countdown", () => {
  assert.equal(acctLimitMessage(1_090_000, 1_000_000), "Account limit: 5 campaigns / 15 min — resets in 1:30");
});

test("deriveSnapshot: resetAt = anchor + 15 min; a window anchored 16 min ago is gone", () => {
  const now = 10_000_000;
  const fresh = now - 2 * MIN;
  const old = now - 16 * MIN;
  const snap = deriveSnapshot(
    [
      { ckey: "acct-window:111111", value: { ws: fresh } },
      { ckey: "acct-window:222222", value: { ws: old } },
    ],
    [
      { ckey: `acct-slot:111111:${fresh}:1`, value: { accountName: "BR-1", ts: fresh } },
      { ckey: `acct-slot:222222:${old}:1`, value: { ts: old } },
    ],
    now,
  );
  assert.equal(snap.windowMs, 15 * MIN);
  assert.deepEqual(snap.accounts, { "111111": { count: 1, resetAt: fresh + 15 * MIN, name: "BR-1" } });
});
