// `node --test tests/hs-autofill.test.ts` — the HS clone board's "Autofill all rows" (owner ask
// 16.10: "автофил … сменить гео, бюджет и бид во всех кампаниях сразу"): what every row becomes when
// the ticked fields land on the whole wave, and what Undo puts back.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type HsAutofillRow,
  autofillEmpty,
  autofillNote,
  autofillProblem,
  autofillRow,
  autofillRows,
  autofillTakes,
  undoAutofill,
} from "../lib/hs-autofill.ts";

const row = (over: Partial<HsAutofillRow> = {}): HsAutofillRow => ({
  id: over.id ?? "r1",
  info: over.info === undefined ? { status: "ACTIVE", bidStrategy: "LOWEST_COST_WITH_MIN_ROAS" } : over.info,
  bidStrategy: over.bidStrategy ?? "LOWEST_COST_WITH_MIN_ROAS",
  bid: over.bid ?? "0,40",
  budget: over.budget ?? "50,00",
  countries: over.countries ?? [],
  locales: over.locales ?? [],
  copies: over.copies ?? "",
  state: over.state ?? "idle",
  msg: over.msg,
});

// ---- which rows it reaches ----------------------------------------------------------------------

test("every readable row that is not mid-submit takes the autofill; an unreadable source and a sending row are skipped", () => {
  assert.equal(autofillTakes(row()), true);
  assert.equal(autofillTakes(row({ info: null })), true); // facts still loading — budget/geo/copies may land
  assert.equal(autofillTakes(row({ info: { status: "UNREADABLE", bidStrategy: "" } })), false);
  assert.equal(autofillTakes(row({ state: "sending" })), false);
  assert.equal(autofillTakes(row({ state: "ok" })), true); // a queued row becomes a fresh draft
});

// ---- the fields ---------------------------------------------------------------------------------

test("targeting lands on every row: countries + locales, copied (not shared), [] = inherit", () => {
  const rows = [row({ id: "a" }), row({ id: "b", countries: ["US"], locales: ["6"] })];
  const patch = { targeting: { countries: ["BR", "PT"], locales: ["23"] } };
  const out = autofillRows(rows, patch);
  assert.equal(out.changed, 2);
  assert.equal(out.skipped, 0);
  assert.deepEqual(out.rows[0].countries, ["BR", "PT"]);
  assert.deepEqual(out.rows[1].countries, ["BR", "PT"]);
  assert.deepEqual(out.rows[1].locales, ["23"]);
  assert.notEqual(out.rows[0].countries, patch.targeting.countries); // its own array
  // back to inheriting: an empty override clears both lists
  const inherit = autofillRows(out.rows, { targeting: { countries: [], locales: [] } });
  assert.deepEqual(inherit.rows[0].countries, []);
  assert.deepEqual(inherit.rows[1].locales, []);
  assert.equal(inherit.changed, 2);
});

test("budget lands verbatim (the field's cash-register spelling)", () => {
  const out = autofillRows([row(), row({ id: "r2", budget: "10,00" })], { budget: "15,00" });
  assert.equal(out.rows[0].budget, "15,00");
  assert.equal(out.rows[1].budget, "15,00");
  assert.equal(out.changed, 2);
});

test("strategy + bid land together; an untouched default budget follows the strategy exactly like the row's own select", () => {
  // a lowest-cost source still on the $10 seed → min ROAS lifts it to $50 (owner rule 09-11)
  const seeded = row({ id: "s", info: { status: "ACTIVE", bidStrategy: "LOWEST_COST_WITHOUT_CAP" }, bidStrategy: "LOWEST_COST_WITHOUT_CAP", bid: "", budget: "10,00" });
  // a typed budget stays
  const typed = row({ id: "t", info: { status: "ACTIVE", bidStrategy: "LOWEST_COST_WITHOUT_CAP" }, bidStrategy: "LOWEST_COST_WITHOUT_CAP", bid: "", budget: "12,50" });
  const out = autofillRows([seeded, typed], { bidding: { bidStrategy: "LOWEST_COST_WITH_MIN_ROAS", bid: "0,35" } });
  assert.equal(out.rows[0].bidStrategy, "LOWEST_COST_WITH_MIN_ROAS");
  assert.equal(out.rows[0].bid, "0,35");
  assert.equal(out.rows[0].budget, "50,00");
  assert.equal(out.rows[1].budget, "12,50");
  assert.equal(out.rows[1].bid, "0,35");
});

test("a ticked budget wins over the strategy's default budget", () => {
  const seeded = row({ info: { status: "ACTIVE", bidStrategy: "LOWEST_COST_WITHOUT_CAP" }, bidStrategy: "LOWEST_COST_WITHOUT_CAP", bid: "", budget: "10,00" });
  const out = autofillRow(seeded, { bidding: { bidStrategy: "LOWEST_COST_WITH_MIN_ROAS", bid: "0,35" }, budget: "20,00" });
  assert.equal(out.budget, "20,00");
});

test("the strategy may be set on a row whose LION facts have not landed yet — the seed sticks", () => {
  const out = autofillRow(row({ info: null, bidStrategy: "", bid: "", budget: "10,00" }), { bidding: { bidStrategy: "LOWEST_COST_WITH_BID_CAP", bid: "1,20" } });
  assert.equal(out.bidStrategy, "LOWEST_COST_WITH_BID_CAP");
  assert.equal(out.bid, "1,20");
  assert.equal(out.budget, "10,00");
});

test("copies land verbatim; '' = back to the wave default", () => {
  const out = autofillRows([row({ copies: "" }), row({ id: "r2", copies: "7" })], { copies: "3" });
  assert.deepEqual(out.rows.map((r) => r.copies), ["3", "3"]);
  const back = autofillRows(out.rows, { copies: "" });
  assert.deepEqual(back.rows.map((r) => r.copies), ["", ""]);
});

// ---- identity, state and skips -------------------------------------------------------------------

test("a row the patch does not change is the SAME object and keeps its state; a changed queued/failed row becomes an idle draft; a held row keeps its hold", () => {
  const same = row({ state: "ok", msg: "queued" });
  assert.equal(autofillRow(same, { budget: "50,00" }), same);
  const queued = autofillRow(row({ state: "ok", msg: "queued" }), { budget: "15,00" });
  assert.equal(queued.state, "idle");
  assert.equal(queued.msg, undefined);
  const failed = autofillRow(row({ state: "error", msg: "boom" }), { copies: "2" });
  assert.equal(failed.state, "idle");
  const held = autofillRow(row({ state: "unsure", msg: "held" }), { budget: "15,00" });
  assert.equal(held.state, "unsure");
  assert.equal(held.msg, "held");
  assert.equal(held.budget, "15,00");
});

test("unreadable and sending rows are counted as skipped and left untouched", () => {
  const dead = row({ id: "dead", info: { status: "UNREADABLE", bidStrategy: "" } });
  const flying = row({ id: "fly", state: "sending" });
  const out = autofillRows([dead, row({ id: "ok" }), flying], { budget: "15,00" });
  assert.equal(out.changed, 1);
  assert.equal(out.skipped, 2);
  assert.equal(out.rows[0], dead);
  assert.equal(out.rows[2], flying);
  assert.equal(out.rows[1].budget, "15,00");
});

// ---- undo ----------------------------------------------------------------------------------------

test("undo puts the editable fields (and the state) of every row that still exists back; rows added since keep theirs", () => {
  const before = [row({ id: "a", budget: "50,00", state: "ok", msg: "queued" }), row({ id: "b", countries: ["US"] })];
  const after = autofillRows(before, { budget: "15,00", targeting: { countries: ["BR"], locales: [] } }).rows;
  const added = row({ id: "c", budget: "15,00", countries: ["BR"] });
  const restored = undoAutofill([after[0], added, after[1]], before);
  assert.equal(restored[0].budget, "50,00");
  assert.equal(restored[0].state, "ok"); // exactly the queued content again → still queued
  assert.equal(restored[0].msg, "queued");
  assert.deepEqual(restored[2].countries, ["US"]);
  assert.equal(restored[1], added);
});

test("undo never un-holds a row and never re-holds one", () => {
  const before = [row({ id: "a", state: "unsure", msg: "held", budget: "50,00" })];
  const now = [row({ id: "a", state: "idle", budget: "15,00" })]; // the hold cleared meanwhile
  const restored = undoAutofill(now, before);
  assert.equal(restored[0].budget, "50,00");
  assert.equal(restored[0].state, "idle");
  const stillHeld = undoAutofill([row({ id: "a", state: "unsure", msg: "held", budget: "15,00" })], [row({ id: "a", state: "idle", budget: "50,00" })]);
  assert.equal(stillHeld[0].state, "unsure");
  assert.equal(stillHeld[0].budget, "50,00");
});

// ---- the modal's words and checks ----------------------------------------------------------------

test("the note names what landed", () => {
  assert.equal(autofillNote({ targeting: { countries: ["BR"], locales: [] }, budget: "15,00" }), "targeting · budget");
  assert.equal(autofillNote({ targeting: { countries: [], locales: [] } }), "targeting → inherit");
  assert.equal(autofillNote({ bidding: { bidStrategy: "LOWEST_COST_WITH_MIN_ROAS", bid: "0,35" } }), "strategy + bid");
  assert.equal(autofillNote({ bidding: { bidStrategy: "LOWEST_COST_WITHOUT_CAP", bid: "" }, copies: "2" }), "strategy · copies");
  assert.equal(autofillEmpty({}), true);
  assert.equal(autofillEmpty({ copies: "" }), false);
});

test("the check refuses an empty patch, a bid-less cap/ROAS strategy, a sub-$1 budget and copies out of range", () => {
  assert.equal(autofillProblem({}, 20), "Tick at least one field");
  assert.equal(autofillProblem({ bidding: { bidStrategy: "", bid: "" } }, 20), "Pick a strategy");
  assert.match(autofillProblem({ bidding: { bidStrategy: "LOWEST_COST_WITH_MIN_ROAS", bid: "" } }, 20) ?? "", /ROAS goal/);
  assert.match(autofillProblem({ bidding: { bidStrategy: "COST_CAP", bid: "  " } }, 20) ?? "", /bid cap/);
  assert.match(autofillProblem({ bidding: { bidStrategy: "COST_CAP", bid: "0,00" } }, 20) ?? "", /above 0/);
  assert.equal(autofillProblem({ bidding: { bidStrategy: "LOWEST_COST_WITHOUT_CAP", bid: "" } }, 20), null);
  assert.equal(autofillProblem({ bidding: { bidStrategy: "LOWEST_COST_WITH_MIN_ROAS", bid: "0,35" } }, 20), null);
  assert.match(autofillProblem({ budget: "0,50" }, 20) ?? "", /min \$1/);
  assert.equal(autofillProblem({ budget: "1,00" }, 20), null);
  assert.match(autofillProblem({ copies: "0" }, 20) ?? "", /1 to 20/);
  assert.match(autofillProblem({ copies: "21" }, 20) ?? "", /1 to 20/);
  assert.equal(autofillProblem({ copies: "" }, 20), null);
  assert.equal(autofillProblem({ copies: "20" }, 20), null);
});
