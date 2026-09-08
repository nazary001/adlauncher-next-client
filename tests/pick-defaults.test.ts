// Node's built-in runner (v24 strips types natively): `node --test tests/pick-defaults.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { accountLoads, leastFilledPage, leastLoadedAccount } from "../lib/pick-defaults.ts";

// ---- leastFilledPage ----------------------------------------------------------------------------

test("the lowest fill ratio wins, not the lowest absolute count", () => {
  const pick = leastFilledPage([
    { id: "a", used: 40, limit: 250 }, // 16%
    { id: "b", used: 10, limit: 25 }, // 40%
    { id: "c", used: 30, limit: 250 }, // 12%
  ]);
  assert.equal(pick, "c");
});

test("known fills beat unknown ones; unknown beats nothing", () => {
  assert.equal(leastFilledPage([{ id: "u", used: null, limit: null }, { id: "k", used: 200, limit: 250 }]), "k");
  assert.equal(leastFilledPage([{ id: "u1", used: null, limit: null }, { id: "u2", used: null, limit: null }]), "u1");
});

test("full and disabled pages are never the default", () => {
  assert.equal(leastFilledPage([{ id: "full", used: 250, limit: 250 }, { id: "x", used: 100, limit: 250, disabled: true }]), "");
  assert.equal(leastFilledPage([{ id: "full", used: 250, limit: 250 }, { id: "ok", used: 249, limit: 250 }]), "ok");
});

test("ties on ratio prefer more free slots, then list order", () => {
  assert.equal(leastFilledPage([{ id: "s", used: 25, limit: 250 }, { id: "big", used: 100, limit: 1000 }]), "big");
  assert.equal(leastFilledPage([{ id: "first", used: 10, limit: 250 }, { id: "second", used: 10, limit: 250 }]), "first");
});

test("an unknown limit falls back to the tier default", () => {
  assert.equal(leastFilledPage([{ id: "a", used: 200, limit: null }, { id: "b", used: 100, limit: 250 }], 250), "b");
});

// ---- leastLoadedAccount -------------------------------------------------------------------------

test("fewest launches in the open window wins", () => {
  const pick = leastLoadedAccount(
    [
      { id: "a", count: 3, resetAt: 900 },
      { id: "b", count: 0, resetAt: null },
      { id: "c", count: 1, resetAt: 500 },
    ],
    5,
  );
  assert.equal(pick, "b");
});

test("equal counts: the sooner-resetting window wins; no window beats any window", () => {
  assert.equal(leastLoadedAccount([{ id: "late", count: 2, resetAt: 900 }, { id: "soon", count: 2, resetAt: 300 }], 5), "soon");
  assert.equal(leastLoadedAccount([{ id: "w", count: 0, resetAt: 900 }, { id: "none", count: 0, resetAt: null }], 5), "none");
});

test("full accounts are skipped while any other has room, else the soonest-resetting full one", () => {
  assert.equal(leastLoadedAccount([{ id: "full", count: 5, resetAt: 100 }, { id: "room", count: 4, resetAt: 900 }], 5), "room");
  assert.equal(leastLoadedAccount([{ id: "f1", count: 5, resetAt: 900 }, { id: "f2", count: 6, resetAt: 100 }], 5), "f1");
});

test("disabled accounts are never the default; empty list → empty pick", () => {
  assert.equal(leastLoadedAccount([{ id: "d", count: 0, resetAt: null, disabled: true }], 5), "");
  assert.equal(leastLoadedAccount([], 5), "");
});

test("accountLoads shapes the limit context into rows", () => {
  const rows = accountLoads([{ id: "act_1" }, { id: "act_2", disabled: true }], {
    countFor: (id) => (id === "act_1" ? 2 : 0),
    resetAtFor: (id) => (id === "act_1" ? 777 : null),
  });
  assert.deepEqual(rows, [
    { id: "act_1", count: 2, resetAt: 777, disabled: undefined },
    { id: "act_2", count: 0, resetAt: null, disabled: true },
  ]);
});
