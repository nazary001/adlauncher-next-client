// Node's built-in runner (v24 strips types natively): `node --test tests/clone-autofill.test.ts`.
// "Autofill all rows" on the shared clone board (owner ask 17.11 — the VC cloner gets what the other
// partners' cloners have): the HS form's patch on the MO / AIF / AV / VC row.
import "./_resolve-hook.ts";
import { test } from "node:test";
import assert from "node:assert/strict";

const { cloneAutofillRow, cloneAutofillRows, undoCloneAutofill } = await import("../lib/clone-autofill.ts");
const { makeCloneRow } = await import("../lib/clone.ts");

const source = (over: Record<string, unknown> = {}) => ({
  campaignId: "120210000000101",
  name: "[26/10] (VC) - Explore your food personality - Tima",
  countries: ["US"],
  locales: ["English (US)"],
  category: "",
  placement: "FULL",
  ageMin: "18",
  userOs: "all" as const,
  originalBudget: "7",
  originalRoas: "2",
  bidStrategy: "LOWEST_COST_WITH_BID_CAP",
  objective: "OUTCOME_LEADS",
  optimization: "conversions" as const,
  conversionEvent: "LEAD",
  redirectType: "",
  creatives: [{ videoId: "1", thumbUrl: "" }],
  ...over,
});
const row = (id: string, over: Record<string, unknown> = {}) => ({ ...makeCloneRow(source(), "17.11", id, "tima"), budget: "7,00", ...over });

test("only the ticked fields land; an untouched patch field leaves the row's own value", () => {
  const r = row("r1");
  const geo = cloneAutofillRow(r, { targeting: { countries: ["BR", "MX"], locales: ["Portuguese (Brazil)"] } }, 100);
  assert.deepEqual(geo.countries, ["BR", "MX"]);
  assert.deepEqual(geo.locales, ["Portuguese (Brazil)"]);
  assert.equal(geo.bidStrategy, r.bidStrategy);
  assert.equal(geo.roasGoal, r.roasGoal);
  assert.equal(geo.budget, "7,00");
  assert.equal(geo.copies, null);
  assert.equal(geo.name, r.name);
  assert.equal(geo.dest, null);
});

test("a targeting pick with nothing in it hands the row back its source's own geo and languages", () => {
  const r = row("r1", { countries: ["BR"], locales: [] });
  const back = cloneAutofillRow(r, { targeting: { countries: [], locales: [] } }, 100);
  assert.deepEqual(back.countries, ["US"]);
  assert.deepEqual(back.locales, ["English (US)"]);
});

test("strategy + bid: a cap carries the bid, lowest cost drops it, min ROAS lifts an untouched budget to $50 — a typed budget stays", () => {
  const r = row("r1");
  const cap = cloneAutofillRow(r, { bidding: { bidStrategy: "LOWEST_COST_WITH_BID_CAP", bid: "0,50" } }, 100);
  assert.equal(cap.roasGoal, "0,50");
  assert.equal(cap.budget, "7,00");
  const low = cloneAutofillRow(r, { bidding: { bidStrategy: "LOWEST_COST_WITHOUT_CAP", bid: "0,50" } }, 100);
  assert.equal(low.bidStrategy, "LOWEST_COST_WITHOUT_CAP");
  assert.equal(low.roasGoal, "");
  const roas = cloneAutofillRow(r, { bidding: { bidStrategy: "LOWEST_COST_WITH_MIN_ROAS", bid: "0,30" } }, 100);
  assert.equal(roas.roasGoal, "0,30");
  assert.equal(roas.budget, "50,00");
  const typed = cloneAutofillRow(row("r2", { budget: "12,00" }), { bidding: { bidStrategy: "LOWEST_COST_WITH_MIN_ROAS", bid: "0,30" } }, 100);
  assert.equal(typed.budget, "12,00");
  // a ticked budget wins over the strategy's default
  const both = cloneAutofillRow(r, { bidding: { bidStrategy: "LOWEST_COST_WITH_MIN_ROAS", bid: "0,30" }, budget: "20,00" }, 100);
  assert.equal(both.budget, "20,00");
});

test("copies: a number is the row's own (clamped), empty hands the row back to the batch default", () => {
  const r = row("r1", { copies: 3 });
  assert.equal(cloneAutofillRow(r, { copies: "5" }, 100).copies, 5);
  assert.equal(cloneAutofillRow(r, { copies: "500" }, 100).copies, 100);
  assert.equal(cloneAutofillRow(r, { copies: "" }, 100).copies, null);
});

test("a patch that changes nothing returns the same row; the batch counts what changed; Undo puts the fields back and keeps later rows", () => {
  const a = row("r1");
  const b = row("r2", { countries: ["BR"] });
  assert.equal(cloneAutofillRow(a, { targeting: { countries: ["US"], locales: ["English (US)"] } }, 100), a);
  const res = cloneAutofillRows([a, b], { targeting: { countries: ["BR"], locales: ["English (US)"] }, budget: "9,00" }, 100);
  assert.equal(res.changed, 2);
  assert.deepEqual(res.rows[0].countries, ["BR"]);
  assert.equal(res.rows[1].budget, "9,00");
  const one = cloneAutofillRows([a, b], { targeting: { countries: ["BR"], locales: ["English (US)"] } }, 100);
  assert.equal(one.changed, 1); // b already targets BR
  const later = row("r3");
  const renamed = { ...res.rows[0], name: "typed after the autofill" };
  const undone = undoCloneAutofill([renamed, res.rows[1], later], [a, b]);
  assert.deepEqual(undone[0].countries, ["US"]);
  assert.equal(undone[0].budget, "7,00");
  assert.equal(undone[0].name, "typed after the autofill"); // only the autofilled fields go back
  assert.deepEqual(undone[1].countries, ["BR"]);
  assert.equal(undone[2], later);
});
