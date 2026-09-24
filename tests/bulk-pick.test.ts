// Node's built-in runner (v24 strips types natively): `node --test tests/bulk-pick.test.ts`.
// Bulk geo pick (owner ask 24.09): a buyer pastes or types a LIST of country codes into a geo
// picker — "CI, CD, BF, MA, CM, SN, DZ, GN" — and every one of them should land as a chip instead
// of the picker answering "No matches". The parsing lives in lib/bulk-pick.ts so the MultiSelect
// (every geo input on every rail shares it) only wires the result.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeBulk, resolveBulk } from "../lib/bulk-pick.ts";

const OPTS = [
  { value: "WW", label: "Worldwide" },
  { value: "US", label: "United States" },
  { value: "CA", label: "Canada" },
  { value: "BR", label: "Brazil" },
  { value: "DE", label: "Germany" },
  { value: "DZ", label: "Algeria" },
  { value: "CI", label: "Côte d'Ivoire" },
  { value: "CD", label: "Congo (DRC)" },
  { value: "BF", label: "Burkina Faso" },
  { value: "MA", label: "Morocco" },
  { value: "CM", label: "Cameroon" },
  { value: "SN", label: "Senegal" },
  { value: "GN", label: "Guinea" },
];
const PRESETS = [
  { label: "World", codes: ["WW"] },
  { label: "LATAM", codes: ["BR", "CA"] },
];

test("a comma list of codes resolves to every code, in the typed order", () => {
  const r = resolveBulk("CI, CD, BF, MA, CM, SN, DZ, GN", OPTS);
  assert.ok(r);
  assert.deepEqual(r.matched, ["CI", "CD", "BF", "MA", "CM", "SN", "DZ", "GN"]);
  assert.deepEqual(r.unknown, []);
});

test("codes and full names match case-insensitively across ; | newline and tab separators", () => {
  const r = resolveBulk("ci; Algeria | brazil\nde\tcanada", OPTS);
  assert.ok(r);
  assert.deepEqual(r.matched, ["CI", "DZ", "BR", "DE", "CA"]);
  assert.deepEqual(r.unknown, []);
});

test("tokens that match nothing are reported, the rest still resolve", () => {
  const r = resolveBulk("US, XX, Narnia, CA", OPTS);
  assert.ok(r);
  assert.deepEqual(r.matched, ["US", "CA"]);
  assert.deepEqual(r.unknown, ["XX", "Narnia"]);
});

test("a list where nothing matches is still a bulk answer (so the picker can say what it did not find)", () => {
  const r = resolveBulk("XX, YY", OPTS);
  assert.ok(r);
  assert.deepEqual(r.matched, []);
  assert.deepEqual(r.unknown, ["XX", "YY"]);
});

test("duplicates collapse to one — code, lower-case code and the name are the same country", () => {
  const r = resolveBulk("US, us, United States, CA", OPTS);
  assert.ok(r);
  assert.deepEqual(r.matched, ["US", "CA"]);
});

test("empty tokens from trailing or doubled separators are ignored", () => {
  const r = resolveBulk("US,,CA, ", OPTS);
  assert.ok(r);
  assert.deepEqual(r.matched, ["US", "CA"]);
  assert.deepEqual(r.unknown, []);
});

test("a preset label in the list expands to the preset's codes", () => {
  const r = resolveBulk("latam, US", OPTS, PRESETS);
  assert.ok(r);
  assert.deepEqual(r.matched, ["BR", "CA", "US"]);
});

test("bare codes separated by spaces alone are a list too", () => {
  const r = resolveBulk("CI CD BF", OPTS);
  assert.ok(r);
  assert.deepEqual(r.matched, ["CI", "CD", "BF"]);
});

test("space-separated words are a list when EVERY word is a code, a name or a preset", () => {
  const r = resolveBulk("PL CZ Portugal", [...OPTS, { value: "PL", label: "Poland" }, { value: "CZ", label: "Czechia" }, { value: "PT", label: "Portugal" }]);
  assert.ok(r);
  assert.deepEqual(r.matched, ["PL", "CZ", "PT"]);
  const withPreset = resolveBulk("latam germany", OPTS, PRESETS);
  assert.ok(withPreset);
  assert.deepEqual(withPreset.matched, ["BR", "CA", "DE"]);
});

test("ordinary search text is NOT a list: a multi-word name, a single code, blank", () => {
  assert.equal(resolveBulk("United States", OPTS), null);
  assert.equal(resolveBulk("US", OPTS), null);
  assert.equal(resolveBulk("   ", OPTS), null);
  assert.equal(resolveBulk("", OPTS), null);
});

test("a single code with a trailing comma is a one-item list (the buyer is mid-list)", () => {
  const r = resolveBulk("US,", OPTS);
  assert.ok(r);
  assert.deepEqual(r.matched, ["US"]);
});

test("mergeBulk unions onto the current picks without duplicates, keeping the current order first", () => {
  assert.deepEqual(mergeBulk(["US"], ["CA", "US", "BR"]), ["US", "CA", "BR"]);
  assert.deepEqual(mergeBulk([], []), []);
});

test("mergeBulk: an exclusive value in the list replaces everything; picks replace a standing exclusive", () => {
  assert.deepEqual(mergeBulk(["US", "CA"], ["BR", "WW"], ["WW"]), ["WW"]);
  assert.deepEqual(mergeBulk(["WW"], ["US"], ["WW"]), ["US"]);
});
