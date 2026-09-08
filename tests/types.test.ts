// Node's built-in runner (v24 strips types natively): `node --test tests/types.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bidAmountMissing, limitMoneyCents, moneyCentsLabel, normalizeRoasGoal, parseMoney } from "../lib/types.ts";

type BidShape = { bidStrategy: string; bidCap: string };
const c = (bidStrategy: string, bidCap: string) => ({ bidStrategy, bidCap }) as BidShape as never;

// ---- bidAmountMissing must agree with what the wire points accept ----------------------------

test("lowest-cost needs no bid", () => {
  assert.equal(bidAmountMissing(c("LOWEST_COST_WITHOUT_CAP", "")), false);
});

test("cap strategy with an empty bid is not ready", () => {
  assert.equal(bidAmountMissing(c("COST_CAP", "")), true);
});

test("cap strategy with a positive bid is ready", () => {
  assert.equal(bidAmountMissing(c("COST_CAP", "1,50")), false);
});

test("min-ROAS in the ambiguous 10–20 band is NOT ready — every wire point rejects it", () => {
  assert.equal(bidAmountMissing(c("LOWEST_COST_WITH_MIN_ROAS", "12,00")), true);
});

test("min-ROAS decimal and percent forms stay ready", () => {
  assert.equal(bidAmountMissing(c("LOWEST_COST_WITH_MIN_ROAS", "0,30")), false); // decimal goal
  assert.equal(bidAmountMissing(c("LOWEST_COST_WITH_MIN_ROAS", "3")), false); // ÷10 band
  assert.equal(bidAmountMissing(c("LOWEST_COST_WITH_MIN_ROAS", "30")), false); // ÷100 band
});

// ---- parseMoney separator handling -----------------------------------------------------------

test("comma is the decimal separator", () => {
  assert.equal(parseMoney("7,50"), 7.5);
});

test("mixed thousands+decimal parses fully", () => {
  assert.equal(parseMoney("1,234.56"), 1234.56);
});

// ---- normalizeRoasGoal bands (documenting the contract the tests above lean on) --------------

test("normalizeRoasGoal: 10–20 is null, 2–10 divides by 10, ≥20 divides by 100", () => {
  assert.equal(normalizeRoasGoal(12), null);
  assert.equal(normalizeRoasGoal(3), 0.3);
  assert.equal(normalizeRoasGoal(30), 0.3);
  assert.equal(normalizeRoasGoal(0.3), 0.3);
});

// ---- moneyCentsLabel: the seed format of cash-register budget cells --------------------------

test("moneyCentsLabel always shows two decimals with a comma", () => {
  assert.equal(moneyCentsLabel("10"), "10,00");
  assert.equal(moneyCentsLabel("0,5"), "0,50");
  assert.equal(moneyCentsLabel(12.5), "12,50");
  assert.equal(moneyCentsLabel("7"), "7,00");
  assert.equal(moneyCentsLabel("1,234.56"), "1234,56");
});

test("moneyCentsLabel keeps an unknown/empty budget empty", () => {
  assert.equal(moneyCentsLabel(""), "");
  assert.equal(moneyCentsLabel("  "), "");
  assert.equal(moneyCentsLabel(Number.NaN), "");
});

test("moneyCentsLabel round-trips through limitMoneyCents (digits fill cents)", () => {
  assert.equal(limitMoneyCents(moneyCentsLabel("10"), 10000), "10,00");
  assert.equal(limitMoneyCents("1000", 10000), "10,00");
  assert.equal(limitMoneyCents("100050", 10000), "1000,50");
});
