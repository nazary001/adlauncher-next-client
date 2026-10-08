// Node's built-in runner (v24 strips types natively): `node --test tests/launch-queue-run.test.ts`.
// The pure wiring decisions of the server launch queue (lib/launch-queue-wire.ts): the NDJSON reply
// parser, the self-origin resolution for the continuation kick, the internal-token HMAC + its
// constant-time compare, and the lane-name shape check. The runner proper (lib/launch-queue-run.ts)
// imports the route handlers and the store, so it can't be loaded here — these helpers are split out
// for exactly that reason. Relative `.ts` import (a Node requirement).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeInternalToken,
  computeSelfOrigin,
  laneNameValid,
  parseReplyLines,
  pumpBudgetMs,
  timingEqual,
} from "../lib/launch-queue-wire.ts";

// ---- parseReplyLines: a faithful port of the browser's stream reading ----

test("a streaming launch keeps the last progress stage and the ok:true final (the done stage never overrides it)", () => {
  const lines = [
    JSON.stringify({ stage: "gcm" }),
    JSON.stringify({ stage: "video" }),
    JSON.stringify({ stage: "ad", done: 1, total: 1 }),
    JSON.stringify({ ok: true, stage: "done", campaign_id: "c1", gcm: "007", link: "https://x" }),
  ];
  const r = parseReplyLines(lines, "mo.launch");
  assert.equal(r.lastStage, "ad", "the ok event's own stage:done is not a progress stage");
  assert.equal(r.final?.ok, true);
  assert.equal(r.final?.campaign_id, "c1");
});

test("a clone ignores {stage:start} and {stage:batch-done}, keeps the per-clone ok:false final", () => {
  const lines = [
    JSON.stringify({ idx: 0, stage: "start", name: "x" }),
    JSON.stringify({ idx: 0, stage: "source" }),
    JSON.stringify({ idx: 0, stage: "campaign" }),
    JSON.stringify({ idx: 0, ok: false, stage: "error", error: "boom", created: {} }),
    JSON.stringify({ stage: "batch-done", total: 1, ok: 0, failed: 1 }),
  ];
  const r = parseReplyLines(lines, "fb.clone");
  assert.equal(r.lastStage, "campaign", "start never becomes a stage; batch-done is ignored entirely");
  assert.equal(r.final?.ok, false);
  assert.equal(r.final?.error, "boom");
});

test("a pending clone final wins; malformed/empty lines are skipped", () => {
  const lines = ["not json", "", JSON.stringify({ idx: 0, ok: false, pending: true, stage: "ad", error: "tool" })];
  const r = parseReplyLines(lines, "fb.clone");
  assert.equal(r.final?.pending, true);
  assert.equal(r.lastStage, null);
});

test("no final event → final null (the 'no verdict' case outcomeOf settles as ambiguous)", () => {
  const r = parseReplyLines([JSON.stringify({ stage: "campaign" })], "mo.launch");
  assert.equal(r.final, null);
  assert.equal(r.lastStage, "campaign");
});

test("the last ok event wins when several arrive", () => {
  const r = parseReplyLines(
    [JSON.stringify({ ok: false, error: "first" }), JSON.stringify({ ok: true, campaign_id: "c2" })],
    "mo.launch",
  );
  assert.equal(r.final?.ok, true);
  assert.equal(r.final?.campaign_id, "c2");
});

// ---- computeSelfOrigin (spec §4.3) ----

test("ADL_SELF_ORIGIN wins (trailing slash trimmed), even over a vercel.app request", () => {
  assert.equal(
    computeSelfOrigin({ ADL_SELF_ORIGIN: "https://launch.example.com/" }, "https://x-abc.vercel.app/api/launch-queue"),
    "https://launch.example.com",
  );
});

test("a non-vercel request origin is used as-is", () => {
  assert.equal(
    computeSelfOrigin({}, "https://adlauncher.gcamazingtool.xyz/api/launch-queue/pump"),
    "https://adlauncher.gcamazingtool.xyz",
  );
});

test("a *.vercel.app request falls back to the production URL (scheme added, slash trimmed)", () => {
  assert.equal(
    computeSelfOrigin({ VERCEL_PROJECT_PRODUCTION_URL: "adlauncher.gcamazingtool.xyz/" }, "https://adlauncher-abc.vercel.app/api/launch-queue/cron"),
    "https://adlauncher.gcamazingtool.xyz",
  );
});

test("a *.vercel.app request with no production URL keeps the request origin", () => {
  assert.equal(computeSelfOrigin({}, "https://adlauncher-abc.vercel.app/x"), "https://adlauncher-abc.vercel.app");
});

test("an opaque request url with no env falls back to empty (kickLane then no-ops harmlessly)", () => {
  assert.equal(computeSelfOrigin({}, "not a url"), "");
});

// ---- internal token + constant-time compare ----

test("computeInternalToken is empty for an empty secret, stable 64-hex otherwise", () => {
  assert.equal(computeInternalToken(""), "");
  const a = computeInternalToken("a-very-long-secret-of-at-least-32-chars!!");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, computeInternalToken("a-very-long-secret-of-at-least-32-chars!!"), "deterministic for a given secret");
  assert.notEqual(a, computeInternalToken("a-different-secret-of-at-least-32-chars!"));
});

test("timingEqual: false on an empty side or a length mismatch, true only on an exact match", () => {
  assert.equal(timingEqual("", "x"), false);
  assert.equal(timingEqual("x", ""), false);
  assert.equal(timingEqual("abc", "abcd"), false);
  assert.equal(timingEqual("abc", "abd"), false);
  assert.equal(timingEqual("abc", "abc"), true);
});

// ---- lane name validation ----

test("laneNameValid accepts <scope>:<user> lanes — whatever the username holds — and rejects junk", () => {
  assert.equal(laneNameValid("mo:nazar"), true);
  assert.equal(laneNameValid("hs:katya_m"), true);
  assert.equal(laneNameValid("aif:a.b-c"), true);
  assert.equal(laneNameValid("av:name@host"), true);
  // A username is whatever the session carries: a lane the pump route refused could never be
  // continued by a self-kick or restarted by the sweep — so spaces and non-Latin names must pass.
  assert.equal(laneNameValid("mo:na zar"), true, "space in user");
  assert.equal(laneNameValid("hs:Катя-Designer"), true, "non-Latin user");
  assert.equal(laneNameValid("mo:" + "x".repeat(160)), true, "longest user");
  assert.equal(laneNameValid("xx:nazar"), false, "unknown scope");
  assert.equal(laneNameValid("mo:"), false, "empty user");
  assert.equal(laneNameValid("mo:" + "x".repeat(161)), false, "user too long");
  assert.equal(laneNameValid("mo:na\nzar"), false, "control character");
  assert.equal(laneNameValid("mo:na\u0000zar"), false, "NUL");
  assert.equal(laneNameValid(123), false);
  assert.equal(laneNameValid(null), false);
  assert.equal(laneNameValid(undefined), false);
});

test("pumpBudgetMs: the test override can only SHORTEN the budget, and never on production", () => {
  assert.equal(pumpBudgetMs({}, 770_000), 770_000);
  assert.equal(pumpBudgetMs({ ADL_QUEUE_BUDGET_MS: "340000" }, 770_000), 340_000);
  assert.equal(pumpBudgetMs({ ADL_QUEUE_BUDGET_MS: "340000", VERCEL_ENV: "production" }, 770_000), 770_000, "ignored on production");
  assert.equal(pumpBudgetMs({ ADL_QUEUE_BUDGET_MS: "9000000" }, 770_000), 770_000, "never longer than the real budget");
  assert.equal(pumpBudgetMs({ ADL_QUEUE_BUDGET_MS: "5000" }, 770_000), 770_000, "absurdly short → ignored");
  assert.equal(pumpBudgetMs({ ADL_QUEUE_BUDGET_MS: "abc" }, 770_000), 770_000);
});
