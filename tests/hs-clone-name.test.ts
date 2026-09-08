// Node's built-in runner: `node --test tests/hs-clone-name.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lionNameSuffix } from "../lib/hs-clone-name.ts";

const SRC = "AGE-GATE - Digital-marketing en qTnTL";

test("default tail (source tail + owner) → only the owner rides as LION name_suffix", () => {
  assert.equal(lionNameSuffix(`${SRC} - Taras`, SRC), "Taras");
});

test("multi-part addition keeps its own dashes", () => {
  assert.equal(lionNameSuffix(`${SRC} - Mykola - ANIME - Alex`, SRC), "Mykola - ANIME - Alex");
});

test("source-tail match is case-insensitive and whitespace-tolerant", () => {
  assert.equal(lionNameSuffix(`  age-gate - digital-marketing EN qtntl - Taras `, SRC), "Taras");
});

test("addition glued without a dash separator still strips the source tail", () => {
  assert.equal(lionNameSuffix(`${SRC} Taras`, SRC), "Taras");
});

test("tail rewritten wholesale → sent as typed", () => {
  assert.equal(lionNameSuffix("Anime - Taras", SRC), "Anime - Taras");
});

test("tail equal to the source tail (owner removed) → nothing to append", () => {
  assert.equal(lionNameSuffix(SRC, SRC), "");
  assert.equal(lionNameSuffix(`${SRC} - `, SRC), "");
});

test("empty tail → empty suffix; empty source tail → tail as typed", () => {
  assert.equal(lionNameSuffix("", SRC), "");
  assert.equal(lionNameSuffix("   ", SRC), "");
  assert.equal(lionNameSuffix("Taras", ""), "Taras");
});

test("suffix is capped to LION's 80-char wire limit", () => {
  const long = "x".repeat(120);
  assert.equal(lionNameSuffix(`${SRC} - ${long}`, SRC).length, 80);
});
