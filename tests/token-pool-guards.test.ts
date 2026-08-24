// Node's built-in runner (v24 strips types natively): `node --test tests/token-pool-guards.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyHealthDelta, isAppLevelLimitCode, type TokenHealthRow } from "../lib/token-pool-guards.ts";

const row = (over: Partial<TokenHealthRow> = {}): TokenHealthRow => ({ health: {}, names: {}, ...over });

// ---- applyHealthDelta: merge semantics for the shared token-health row -----------------------

test("mark lands on an empty row", () => {
  const next = applyHealthDelta(row(), { kind: "mark", fp: "aaa", mark: { limitedUntil: 1000, reason: "(#4)" } });
  assert.deepEqual(next.health, { aaa: { limitedUntil: 1000, reason: "(#4)" } });
});

test("a later mark of the same token replaces the stored one", () => {
  const base = row({ health: { aaa: { limitedUntil: 1000, reason: "old" } } });
  const next = applyHealthDelta(base, { kind: "mark", fp: "aaa", mark: { limitedUntil: 2000, reason: "new" } });
  assert.deepEqual(next.health.aaa, { limitedUntil: 2000, reason: "new" });
});

test("a stale earlier mark never shortens a stored cooldown", () => {
  const base = row({ health: { aaa: { limitedUntil: 2000, reason: "fresh" } } });
  const next = applyHealthDelta(base, { kind: "mark", fp: "aaa", mark: { limitedUntil: 1000, reason: "stale" } });
  assert.deepEqual(next.health.aaa, { limitedUntil: 2000, reason: "fresh" });
});

test("marks of different tokens do not touch each other", () => {
  const base = row({ health: { aaa: { limitedUntil: 5000, reason: "a" } } });
  const next = applyHealthDelta(base, { kind: "mark", fp: "bbb", mark: { limitedUntil: 7000, reason: "b" } });
  assert.deepEqual(next.health, {
    aaa: { limitedUntil: 5000, reason: "a" },
    bbb: { limitedUntil: 7000, reason: "b" },
  });
});

test("clear removes only its token's mark", () => {
  const base = row({
    health: { aaa: { limitedUntil: 5000, reason: "a" }, bbb: { limitedUntil: 7000, reason: "b" } },
  });
  const next = applyHealthDelta(base, { kind: "clear", fp: "aaa" });
  assert.deepEqual(next.health, { bbb: { limitedUntil: 7000, reason: "b" } });
});

test("names merge per token, preserving already-known fields", () => {
  const base = row({ names: { aaa: { user: "Gcforhs2" } } });
  const next = applyHealthDelta(base, { kind: "names", fp: "aaa", names: { app: "GC for HS 2.1" } });
  assert.deepEqual(next.names.aaa, { user: "Gcforhs2", app: "GC for HS 2.1" });
});

test("the input row is never mutated", () => {
  const base = row({ health: { aaa: { limitedUntil: 1000, reason: "a" } }, names: { aaa: { user: "u" } } });
  const snapshot = JSON.parse(JSON.stringify(base));
  applyHealthDelta(base, { kind: "mark", fp: "bbb", mark: { limitedUntil: 2000, reason: "b" } });
  applyHealthDelta(base, { kind: "clear", fp: "aaa" });
  applyHealthDelta(base, { kind: "names", fp: "aaa", names: { app: "x" } });
  assert.deepEqual(base, snapshot);
});

// ---- isAppLevelLimitCode: which throttles a different app's bearer escapes -------------------

test("(#4) app limit and (#17) user-app limit are app-level", () => {
  assert.equal(isAppLevelLimitCode(4), true);
  assert.equal(isAppLevelLimitCode(17), true);
});

test("account-scoped codes and unknowns are not app-level", () => {
  assert.equal(isAppLevelLimitCode(613), false);
  assert.equal(isAppLevelLimitCode(80004), false);
  assert.equal(isAppLevelLimitCode(80014), false);
  assert.equal(isAppLevelLimitCode(undefined), false);
  assert.equal(isAppLevelLimitCode("4"), false);
});
