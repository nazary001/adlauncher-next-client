// Node's built-in runner (v24 strips types natively): `node --test tests/wave-hold-core.test.ts`.
// The rules of a HELD wave (components/wave-hold-core.ts): a Google / Snapchat / TikTok wave whose
// request got no answer is neither launched again nor forgotten — it waits for the server's own
// word. The decisions that guard money: a wave is never released on silence, never before its full
// hold has run, and an accepted wave is recognised however late.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WAVE_HOLD_MS, holdWave, settleHeldWaves, waveVerdictOf, type HeldWave, type WaveVerdict } from "../components/wave-hold-core.ts";

const T0 = 1_000_000;
const w = (waveId: string, since = T0, cardIds = ["c1"]): HeldWave => ({ waveId, cardIds, since });
const verdicts = (m: Record<string, WaveVerdict>) => (id: string): WaveVerdict => m[id] ?? "unknown";
const ids = (ws: HeldWave[]) => ws.map((x) => x.waveId);

test("an accepted wave is settled at once — and however late the claim shows up", () => {
  const held = [w("fresh"), w("old", T0 - 10 * WAVE_HOLD_MS)];
  const r = settleHeldWaves(held, verdicts({ fresh: "accepted", old: "accepted" }), T0 + 1);
  assert.deepEqual(ids(r.accepted), ["fresh", "old"]);
  assert.deepEqual([r.released.length, r.still.length], [0, 0]);
});

test("'no claim' releases a wave only after the FULL hold — a request that did reach the server may still be validating", () => {
  const held = [w("a")];
  for (const dt of [0, 1_000, WAVE_HOLD_MS - 1]) {
    const r = settleHeldWaves(held, verdicts({ a: "absent" }), T0 + dt);
    assert.deepEqual([ids(r.still), r.released.length, r.accepted.length], [["a"], 0, 0], `still held at +${dt} ms`);
  }
  const done = settleHeldWaves(held, verdicts({ a: "absent" }), T0 + WAVE_HOLD_MS);
  assert.deepEqual([ids(done.released), done.still.length], [["a"], 0]);
});

test("a wave the server could not be asked about is NEVER released — silence decides nothing", () => {
  const held = [w("offline", T0 - 100 * WAVE_HOLD_MS)];
  const r = settleHeldWaves(held, verdicts({ offline: "unknown" }), T0);
  assert.deepEqual([ids(r.still), r.released.length, r.accepted.length], [["offline"], 0, 0]);
  // a wave with no verdict at all (it was held while the others were being asked) is the same
  const none = settleHeldWaves([w("new", T0 - 100 * WAVE_HOLD_MS)], () => "unknown", T0);
  assert.deepEqual(ids(none.still), ["new"]);
});

test("each wave is judged on its own", () => {
  const held = [w("yes"), w("no", T0 - WAVE_HOLD_MS), w("wait"), w("dark", T0 - WAVE_HOLD_MS)];
  const r = settleHeldWaves(held, verdicts({ yes: "accepted", no: "absent", wait: "absent", dark: "unknown" }), T0);
  assert.deepEqual([ids(r.accepted), ids(r.released), ids(r.still)], [["yes"], ["no"], ["wait", "dark"]]);
  assert.deepEqual(settleHeldWaves([], () => "accepted", T0), { accepted: [], released: [], still: [] });
});

test("holdWave: a new wave starts its clock; a wave already held keeps it and gains the cards of the new attempt", () => {
  let held = holdWave([], "w1", ["a", "b", "a"], T0);
  assert.deepEqual(held, [{ waveId: "w1", cardIds: ["a", "b"], since: T0 }]);
  held = holdWave(held, "w2", ["x"], T0 + 5);
  held = holdWave(held, "w1", ["b", "c"], T0 + 60_000);
  assert.deepEqual(
    held.find((x) => x.waveId === "w1"),
    { waveId: "w1", cardIds: ["a", "b", "c"], since: T0 },
    "a second failed attempt must not restart the hold",
  );
  assert.equal(held.length, 2);
  assert.equal(held.find((x) => x.waveId === "w2")?.since, T0 + 5);
});

test("waveVerdictOf: only a 2xx { ok: true, accepted: boolean } is a verdict — everything else is 'could not be asked'", () => {
  assert.equal(waveVerdictOf(true, { ok: true, accepted: true }), "accepted");
  assert.equal(waveVerdictOf(true, { ok: true, accepted: false }), "absent");
  // the store was unreadable (503), the session expired (401 → the login page), a proxy answered
  assert.equal(waveVerdictOf(false, { ok: false, error: "task_store_unavailable" }), "unknown");
  assert.equal(waveVerdictOf(false, { ok: true, accepted: false }), "unknown", "a non-2xx is never a 'no'");
  assert.equal(waveVerdictOf(true, { ok: false, accepted: false }), "unknown");
  assert.equal(waveVerdictOf(true, { ok: true }), "unknown");
  assert.equal(waveVerdictOf(true, { ok: true, accepted: "false" }), "unknown");
  assert.equal(waveVerdictOf(true, null), "unknown");
  assert.equal(waveVerdictOf(true, "<html>"), "unknown");
});
