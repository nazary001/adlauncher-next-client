// Node's built-in runner: `node --test tests/hs-clone-name.test.ts`.
// LION's /duplicate/ rebuilds the clone's name itself and honours only `name_suffix`; the board's
// WHOLE edited tail rides there (owner report 09-09: the addition-only wire dropped "Alex-Tima"
// and every other source-tail tag from LION's name), and the pump then puts the board's exact
// name on the campaign through the Graph.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LION_NAME_SUFFIX_MAX, lionWireSuffix, withOwnAcr } from "../lib/hs-clone-name.ts";

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

// A clone source may be any team's campaign (owner 13.10). The board keeps the source's grammar
// prefix for the clone's name — but the clone is born by the CLONING team's LION key, so the
// acronym in that prefix must be the cloning team's (found on the live GLO-02 board 13.10: the clone
// of a GLO-01 campaign was previewed as "[13/10] (GLO-01) API (CLONE) - …").
test("a clone's name carries the cloning team's acronym, never the source's", () => {
  assert.equal(withOwnAcr("[13/10] (GLO-01) API (CLONE) - (#ADX [HIGH]) - [WORLD] - [ES] - ", "GLO-02"), "[13/10] (GLO-02) API (CLONE) - (#ADX [HIGH]) - [WORLD] - [ES] - ");
  assert.equal(withOwnAcr("[13/10] (ELV-02) API (CLONE) - JURO - (#ADX [HIGH]) - [FR] - ", "GLO-01"), "[13/10] (GLO-01) API (CLONE) - JURO - (#ADX [HIGH]) - [FR] - ");
  // only the acronym slot right after the date — never the redirect label or a later group
  assert.equal(withOwnAcr("[13/10] (C2N-09) API - (META ADX) - [US] - ", "GLO-02"), "[13/10] (GLO-02) API - (META ADX) - [US] - ");
});

test("the team's own source keeps its name; a prefix without the grammar is left alone", () => {
  const own = "[13/10] (GLO-02) API (CLONE) - (#ADX [HIGH]) - [WORLD] - ";
  assert.equal(withOwnAcr(own, "GLO-02"), own);
  assert.equal(withOwnAcr("", "GLO-02"), "");
  assert.equal(withOwnAcr("made by hand (in Ads Manager) - ", "GLO-02"), "made by hand (in Ads Manager) - ");
  assert.equal(withOwnAcr(own, ""), own); // no acronym known → nothing is touched
});
