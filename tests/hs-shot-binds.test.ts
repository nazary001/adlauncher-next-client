// Node's built-in runner (v24 strips types natively): `node --test tests/hs-shot-binds.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acctLimitRefusal,
  bindsKey,
  demandByAccount,
  distinctBy,
  resolveShotBinds,
  shotAcctKey,
} from "../lib/hs-shot-binds.ts";

const wave = { profile: "glo-01", account: "act_1", page: "p1", pixel: "px1" };

// ---- resolveShotBinds: per-shot fields win, wave fills the gaps ------------------------------

test("a shot without binds rides the wave-level ones (old tabs / curl)", () => {
  assert.deepEqual(resolveShotBinds({}, wave, true), { profile: "glo-01", account: "act_1", page: "p1", pixel: "px1" });
  assert.deepEqual(resolveShotBinds(undefined, wave, true), { profile: "glo-01", account: "act_1", page: "p1", pixel: "px1" });
});

test("a shot's own binds win field by field", () => {
  assert.deepEqual(resolveShotBinds({ account: " act_2 ", pixel: "px2" }, wave, true), {
    profile: "glo-01",
    account: "act_2",
    page: "p1",
    pixel: "px2",
  });
});

test("JURO rails carry no page — a shot page is dropped, a missing one is not an error", () => {
  assert.deepEqual(resolveShotBinds({ page: "p9" }, { profile: "glo-01", account: "act_1", pixel: "px1" }, false), {
    profile: "glo-01",
    account: "act_1",
    page: "",
    pixel: "px1",
  });
});

test("the first missing field names the refusal, in the wave-level order", () => {
  assert.deepEqual(resolveShotBinds({}, {}, true), { error: "profile_required" });
  assert.deepEqual(resolveShotBinds({ profile: "glo-01" }, {}, true), { error: "account_required" });
  assert.deepEqual(resolveShotBinds({ profile: "glo-01", account: "act_1" }, {}, true), { error: "page_required" });
  assert.deepEqual(resolveShotBinds({ profile: "glo-01", account: "act_1", page: "p1" }, {}, true), { error: "pixel_required" });
  assert.deepEqual(resolveShotBinds({ profile: "glo-01", account: "act_1" }, {}, false), { error: "pixel_required" });
});

test("bindsKey is the tuple identity", () => {
  assert.equal(bindsKey({ profile: "a", account: "b", page: "c", pixel: "d" }), "a|b|c|d");
});

// ---- account demand + launch-limit precheck ---------------------------------------------------

test("shotAcctKey strips act_", () => {
  assert.equal(shotAcctKey(" act_123 "), "123");
  assert.equal(shotAcctKey("123"), "123");
});

test("distinctBy keeps first-appearance order and drops empties", () => {
  assert.deepEqual(distinctBy([{ a: "x" }, { a: "" }, { a: "y" }, { a: "x" }], (s) => s.a), ["x", "y"]);
});

test("demandByAccount sums shots per canonical account", () => {
  const d = demandByAccount([{ acct: "act_1" }, { acct: "1" }, { acct: "act_2" }], (s) => s.acct);
  assert.deepEqual([...d.entries()], [["1", 2], ["2", 1]]);
});

test("acctLimitRefusal: every account fits → null", () => {
  const d = new Map([["1", 2], ["2", 5]]);
  assert.equal(acctLimitRefusal(d, { 1: { count: 3, resetAt: 9 } }, 5, () => "wait"), null);
});

test("acctLimitRefusal: a full window refuses with the countdown and names the account", () => {
  const d = new Map([["1", 1]]);
  const r = acctLimitRefusal(d, { 1: { count: 5, resetAt: 9, name: "BR-1" } }, 5, (at) => `resets@${at}`);
  assert.equal(r?.status, 429);
  assert.match(r?.error ?? "", /resets@9/);
  assert.match(r?.error ?? "", /BR-1 \(1\)/);
});

test("acctLimitRefusal: a partial fit refuses the WHOLE wave and says how many fit", () => {
  const d = new Map([["1", 1], ["2", 4]]);
  const r = acctLimitRefusal(d, { 2: { count: 3, resetAt: 9 } }, 5, () => "wait", "JURO copies");
  assert.equal(r?.status, 429);
  assert.match(r?.error ?? "", /only 2 of 4 JURO copies fit account 2/);
});
