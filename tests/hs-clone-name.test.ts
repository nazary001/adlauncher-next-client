// Node's built-in runner: `node --test tests/hs-clone-name.test.ts`.
// LION's /duplicate/ rebuilds the clone's name itself and honours only `name_suffix`; the board's
// WHOLE edited tail rides there (owner report 09-09: the addition-only wire dropped "Alex-Tima"
// and every other source-tail tag from LION's name), and the pump then puts the board's exact
// name on the campaign through the Graph.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LION_NAME_SUFFIX_MAX, lionWireSuffix } from "../lib/hs-clone-name.ts";

test("the whole edited tail rides as LION name_suffix — nothing is stripped", () => {
  assert.equal(lionWireSuffix("MKDIGITAL - Alex-Tima - CREO - Fonu h5rlU - Nazar"), "MKDIGITAL - Alex-Tima - CREO - Fonu h5rlU - Nazar");
});

test("whitespace is squashed and trimmed", () => {
  assert.equal(lionWireSuffix("  AGE-GATE  -  Digital-marketing en   qTnTL - Taras  "), "AGE-GATE - Digital-marketing en qTnTL - Taras");
});

test("empty tail → empty suffix", () => {
  assert.equal(lionWireSuffix(""), "");
  assert.equal(lionWireSuffix("   "), "");
});

test("suffix is capped to LION's wire limit", () => {
  assert.equal(lionWireSuffix("x".repeat(200)).length, LION_NAME_SUFFIX_MAX);
});
