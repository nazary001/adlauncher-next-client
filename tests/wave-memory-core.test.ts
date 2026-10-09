// Node's built-in runner (v24 strips types natively): `node --test tests/wave-memory-core.test.ts`.
// The wave memory (components/wave-memory-core.ts): what a clone board keeps about the wave it just
// sent so a reload cannot fire the same campaigns again under a new wave id (audit find 09.10).
import { test } from "node:test";
import assert from "node:assert/strict";
import { WAVE_MEMORY_MAX_MS, parseRememberedWave, rememberedRowIds } from "../components/wave-memory-core.ts";

const NOW = 1_700_000_000_000;
const good = { id: "w-1", sig: "sig", keys: ["c1", "c2"], rail: "hs", at: NOW - 5_000 };

test("a well-formed, recent memory is recalled as stored", () => {
  assert.deepEqual(parseRememberedWave(JSON.stringify(good), NOW), good);
});

test("nothing, garbage, a malformed shape, a stale or a future memory are all null", () => {
  assert.equal(parseRememberedWave(null, NOW), null);
  assert.equal(parseRememberedWave("", NOW), null);
  assert.equal(parseRememberedWave("{not json", NOW), null);
  assert.equal(parseRememberedWave("42", NOW), null);
  assert.equal(parseRememberedWave(JSON.stringify({ ...good, id: "" }), NOW), null);
  assert.equal(parseRememberedWave(JSON.stringify({ ...good, keys: "c1" }), NOW), null);
  assert.equal(parseRememberedWave(JSON.stringify({ ...good, at: "yesterday" }), NOW), null);
  assert.equal(parseRememberedWave(JSON.stringify({ ...good, at: NOW - WAVE_MEMORY_MAX_MS - 1 }), NOW), null, "too old — the Task Manager is the truth by then");
  assert.equal(parseRememberedWave(JSON.stringify({ ...good, at: NOW + 120_000 }), NOW), null, "a clock from the future is not trusted");
  assert.notEqual(parseRememberedWave(JSON.stringify({ ...good, at: NOW - WAVE_MEMORY_MAX_MS + 1 }), NOW), null, "just inside the window");
});

test("non-string keys are dropped, never thrown on", () => {
  const w = parseRememberedWave(JSON.stringify({ ...good, keys: ["c1", 7, null, "c2"] }), NOW);
  assert.deepEqual(w?.keys, ["c1", "c2"]);
});

test("rememberedRowIds maps the remembered source keys back to the rows a reloaded board seeded", () => {
  const rows = [
    { id: "r1", campaignId: "c1" },
    { id: "r2", campaignId: "c9" },
    { id: "r3", campaignId: "c2" },
  ];
  assert.deepEqual(rememberedRowIds(rows, (r) => r.campaignId, good), ["r1", "r3"]);
  assert.deepEqual(rememberedRowIds(rows, (r) => r.campaignId, { ...good, keys: [] }), []);
});
