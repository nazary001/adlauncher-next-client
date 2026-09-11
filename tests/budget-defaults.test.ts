// Node's built-in runner (v24 strips types natively): `node --test tests/budget-defaults.test.ts`.
// Owner rule 2026-09-11: a launch or a clone that bids on min ROAS defaults to a $50/day budget
// (the $10 "launch small" default stays for every other strategy).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLONE_DEFAULT_BUDGET,
  LAUNCH_DEFAULT_BUDGET,
  ROAS_DEFAULT_BUDGET,
  budgetOnStrategyChange,
  defaultBudgetFor,
  makeCampaign,
  moneyCentsLabel,
} from "../lib/types.ts";

const ROAS = "LOWEST_COST_WITH_MIN_ROAS";
const CAP = "LOWEST_COST_WITH_BID_CAP";
const COST_CAP = "COST_CAP";
const LOWEST = "LOWEST_COST_WITHOUT_CAP";

// ---- defaultBudgetFor -------------------------------------------------------------------------

test("min ROAS defaults to $50, every other strategy keeps the caller's base", () => {
  assert.equal(ROAS_DEFAULT_BUDGET, "50");
  assert.equal(defaultBudgetFor(ROAS, "10"), "50");
  assert.equal(defaultBudgetFor(ROAS, "7"), "50");
  assert.equal(defaultBudgetFor(CAP, "10"), "10");
  assert.equal(defaultBudgetFor(COST_CAP, "10"), "10");
  assert.equal(defaultBudgetFor(LOWEST, "7"), "7");
  assert.equal(defaultBudgetFor("", "10"), "10"); // strategy unknown yet (HS row before LION facts)
});

test("the launcher's blank card still starts at $7 on lowest cost; the clone default is $10", () => {
  assert.equal(LAUNCH_DEFAULT_BUDGET, "7");
  assert.equal(CLONE_DEFAULT_BUDGET, "10");
  const c = makeCampaign("c1");
  assert.equal(c.bidStrategy, LOWEST);
  assert.equal(c.budget, "7");
});

// ---- budgetOnStrategyChange -------------------------------------------------------------------

test("switching to min ROAS lifts an UNTOUCHED default budget to $50", () => {
  assert.equal(budgetOnStrategyChange(LOWEST, ROAS, "7", "7"), "50");
  assert.equal(budgetOnStrategyChange(CAP, ROAS, "10", "10"), "50");
  // cash-register spelling of the same untouched default counts as untouched
  assert.equal(budgetOnStrategyChange(LOWEST, ROAS, "10,00", "10"), "50");
});

test("a budget the buyer typed is never overwritten by a strategy switch", () => {
  assert.equal(budgetOnStrategyChange(LOWEST, ROAS, "25", "10"), "25");
  assert.equal(budgetOnStrategyChange(ROAS, CAP, "80,00", "10"), "80,00");
  assert.equal(budgetOnStrategyChange(LOWEST, ROAS, "", "10"), ""); // cleared on purpose stays cleared
});

test("switching AWAY from min ROAS with the untouched $50 falls back to the base default", () => {
  assert.equal(budgetOnStrategyChange(ROAS, CAP, "50", "10"), "10");
  assert.equal(budgetOnStrategyChange(ROAS, LOWEST, "50,00", "7"), "7");
  // ROAS → ROAS (no kind change) keeps whatever is there
  assert.equal(budgetOnStrategyChange(ROAS, ROAS, "50", "10"), "50");
  assert.equal(budgetOnStrategyChange(ROAS, ROAS, "33", "10"), "33");
});

test("the HS row seeds from 'strategy unknown' → the source's strategy on the LION facts", () => {
  // freshRow carries the $10 default before LION answers; a min-ROAS source lifts it to $50,
  // a cap source leaves it — and a budget the buyer already typed stays.
  assert.equal(budgetOnStrategyChange("", ROAS, "10,00", "10"), "50");
  assert.equal(budgetOnStrategyChange("", CAP, "10,00", "10"), "10,00");
  assert.equal(budgetOnStrategyChange("", ROAS, "12,50", "10"), "12,50");
});

// ---- the clone boards' cash-register seed (what seedRow / the HS facts path compose) -----------

test("a clone row born on a min-ROAS source seeds 50,00; other strategies keep the source's budget", () => {
  assert.equal(moneyCentsLabel(defaultBudgetFor(ROAS, "10")), "50,00");
  assert.equal(moneyCentsLabel(defaultBudgetFor(CAP, "15")), "15,00");
  assert.equal(moneyCentsLabel(defaultBudgetFor(LOWEST, "20")), "20,00");
  // an unknown source budget stays empty (the field shows its placeholder, the $1 floor blocks)
  assert.equal(moneyCentsLabel(defaultBudgetFor(CAP, "")), "");
});
