// Node's built-in runner: `node --test tests/hs-clone-name.test.ts`.
// LION's /duplicate/ rebuilds the clone's name itself and honours only `name_suffix`; the board's
// WHOLE edited tail rides there (owner report 09-09: the addition-only wire dropped "Alex-Tima"
// and every other source-tail tag from LION's name), and the pump then puts the board's exact
// name on the campaign through the Graph.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LION_NAME_SUFFIX_MAX, cleanSourceTail, lionWireSuffix, stripLionTag, withOwnAcr } from "../lib/hs-clone-name.ts";

test("the whole edited tail rides as LION name_suffix — nothing is stripped", () => {
  assert.equal(lionWireSuffix("MKDIGITAL - Alex-Tima - CREO - Fonu h5rlU - Nazar"), "MKDIGITAL - Alex-Tima - CREO - Fonu h5rlU - Nazar");
});

test("whitespace is squashed and trimmed", () => {
  assert.equal(lionWireSuffix("  MKDIGITAL  -  Alex-Tima   - Taras  "), "MKDIGITAL - Alex-Tima - Taras");
});

// GLO-04 27.11 (no FB token — LION's own name stays on the campaign): a clone of a LION-born clone
// stacked LION's family ("CAPTCHA-6 - Cars pt CAPTCHA-6 - Cars pt CARS - …", 106 of 340 clones),
// and long tails lost the buyer's login to the 80-char cap (40 of 340).
test("a leading LION family is dropped — LION writes its own in front of the suffix", () => {
  assert.equal(lionWireSuffix("CAPTCHA-6 - Cars pt CARS - Mystery - AVMY - 25.11 rH6a2 - Anna"), "CARS - Mystery - AVMY - 25.11 rH6a2 - Anna");
  assert.equal(lionWireSuffix("AGE-GATE - Digital-marketing en qTnTL - Taras"), "qTnTL - Taras");
  assert.equal(lionWireSuffix("CAPTCHA-6 - Digital-marketing es- Katya - CREO - Lakshmi - Anna"), "Katya - CREO - Lakshmi - Anna");
  assert.equal(lionWireSuffix("CAPTCHA-6 - Cars pt CAPTCHA-6 - Cars pt CAPTCHA - Cars pt CARS - Katya"), "CARS - Katya");
  // a buyer's own words that only look a little like it stay
  assert.equal(lionWireSuffix("CARS - Mystery - AVMY - 24.11"), "CARS - Mystery - AVMY - 24.11");
  assert.equal(lionWireSuffix("CAPTC- CLOTHES - Tima - PLASHKA - Lena"), "CAPTC- CLOTHES - Tima - PLASHKA - Lena");
});

test("the buyer's login ends the suffix — added when the tail does not name it, never twice", () => {
  assert.equal(lionWireSuffix("CARS - Tima - PLASHKA", "Alex"), "CARS - Tima - PLASHKA - Alex");
  assert.equal(lionWireSuffix("CARS - Tima - PLASHKA - Alex", "Alex"), "CARS - Tima - PLASHKA - Alex");
  assert.equal(lionWireSuffix("CARS - Tima - PLASHKA - alex", "Alex"), "CARS - Tima - PLASHKA - alex");
  assert.equal(lionWireSuffix("Lakshmi2411 Noqdo - Alex zPA6D - Alex", "Alex"), "Lakshmi2411 Noqdo - Alex zPA6D - Alex");
  assert.equal(lionWireSuffix("", "Anna"), "Anna");
  // a longer name that merely ends with the login's letters is not the login
  assert.equal(lionWireSuffix("CARS - Joanna", "Anna"), "CARS - Joanna - Anna");
});

test("the cap keeps the login: the head of a long tail is cut, never its end", () => {
  const s = lionWireSuffix("CAPTCHA-6 - Cars pt CARS - Katya - CREO - Lakshmi2511 | HSWEAPON | tuBEx | RECENT - Margo - VIRAL - SOFA", "Anna");
  assert.ok(s.length <= LION_NAME_SUFFIX_MAX, s);
  assert.ok(s.endsWith(" - Anna"), s);
  assert.ok(s.startsWith("CARS - Katya - CREO"), s);
  assert.ok(!/[\s|-] - Anna$/.test(s), `no dangling separator before the login: ${s}`);
});

test("a source tail read off a LION-born name loses LION's family and random tag; our own tails stay", () => {
  assert.equal(cleanSourceTail("CAPTCHA-6 - Cars pt CARS - Mystery - AVMY - 25.11 rH6a2 - Taras 11zhO"), "CARS - Mystery - AVMY - 25.11 rH6a2 - Taras");
  assert.equal(cleanSourceTail("CAPTCHA-6 - Cars fr CARS - Katya - CREO - Lakshmi2411 Noqdo - Alex zPA6D"), "CARS - Katya - CREO - Lakshmi2411 Noqdo - Alex");
  assert.equal(cleanSourceTail("CAPTCHA - Cars pt CARS - Margo - CREO - VIRAL | HSWEAPON | NSlff | RECENT - Anna RlHLA"), "CARS - Margo - CREO - VIRAL | HSWEAPON | NSlff | RECENT - Anna");
  // a tag-less LION name (creation-status) loses only the family
  assert.equal(cleanSourceTail("CAPTCHA-6 - Cars pt CARS - Mystery - AVMY - Anna"), "CARS - Mystery - AVMY - Anna");
  // names we gave (token renames, launches) are not LION's: nothing goes, a login segment least of all
  assert.equal(cleanSourceTail("CARS - Katya - CREO - Lakshmi2511 | HSWEAPON | ZcZpK | RECENT - Taras"), "CARS - Katya - CREO - Lakshmi2511 | HSWEAPON | ZcZpK | RECENT - Taras");
  assert.equal(cleanSourceTail("MKDIGITAL - Alex-Tima - CREO - Fonu h5rlU - Nazar"), "MKDIGITAL - Alex-Tima - CREO - Fonu h5rlU - Nazar");
  assert.equal(stripLionTag("CARS - Katya"), "CARS - Katya", "a whole segment is a typed word, never a tag");
  assert.equal(stripLionTag("CARS - Mystery VIRAL"), "CARS - Mystery VIRAL", "one kind of letters is a word, not a tag");
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
