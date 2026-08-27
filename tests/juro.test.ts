// Node's built-in runner: `node --test tests/juro.test.ts`.
// JURO rail helpers — wire facts probed live 2026-08-25 (see lib/juro.ts header).
import { test } from "node:test";
import assert from "node:assert/strict";
import { juroBlockingError, juroConversionEvent, juroStoryPage, juroStoryPages, juroWireCountries } from "../lib/juro.ts";

// ---- juroStoryPage: page id from object story ids --------------------------------------------

test("story page = the id prefix", () => {
  assert.equal(juroStoryPage(["205747821470626_122243753336046865", "205747821470626_122243753330046865"]), "205747821470626");
});

test("malformed / empty stories → no page", () => {
  assert.equal(juroStoryPage([]), "");
  assert.equal(juroStoryPage(["not-a-story"]), "");
  assert.equal(juroStoryPage(["123_"]), "");
});

// ---- juroStoryPages: per-page ad tally (profile check + registry ledger) ---------------------

test("single-page source → one tally with the ad count", () => {
  assert.deepEqual(juroStoryPages(["205747821470626_1", "205747821470626_2"]), [
    { pageId: "205747821470626", delta: 2 },
  ]);
});

test("multi-page source → one tally per page", () => {
  assert.deepEqual(juroStoryPages(["11111_1", "22222_1", "11111_2"]), [
    { pageId: "11111", delta: 2 },
    { pageId: "22222", delta: 1 },
  ]);
});

test("any malformed story id → null (caller refuses the shot)", () => {
  assert.equal(juroStoryPages(["11111_1", "broken"]), null);
});

// ---- juroConversionEvent: rides the bid kind -------------------------------------------------

test("MIN_ROAS optimizes PURCHASE, everything else CONTENT_VIEW", () => {
  assert.equal(juroConversionEvent("LOWEST_COST_WITH_MIN_ROAS"), "PURCHASE");
  assert.equal(juroConversionEvent("LOWEST_COST_WITH_BID_CAP"), "CONTENT_VIEW");
  assert.equal(juroConversionEvent("LOWEST_COST_WITHOUT_CAP"), "CONTENT_VIEW");
  assert.equal(juroConversionEvent(""), "CONTENT_VIEW");
});

// ---- juroWireCountries: override wins, WW → WORLD, no inheritance guesses --------------------

test("override wins over the source's geo", () => {
  assert.deepEqual(juroWireCountries({ countries: ["MX", "CO"], localeIds: [] }, ["US"]), ["MX", "CO"]);
});

test("WW override → LION's WORLD token", () => {
  assert.deepEqual(juroWireCountries({ countries: ["WW"], localeIds: [] }, ["US"]), ["WORLD"]);
});

test("no override → source countries; nothing resolvable → empty (caller refuses)", () => {
  assert.deepEqual(juroWireCountries(null, ["MX"]), ["MX"]);
  assert.deepEqual(juroWireCountries(null, []), []);
  assert.deepEqual(juroWireCountries({ countries: [], localeIds: [6] }, []), []);
});

// ---- juroBlockingError: non-transient Meta walls ---------------------------------------------

test("certification wall → account scope (live 08-25: [MX]-only shot hit it too)", () => {
  const w = juroBlockingError(
    "You must certify compliance with our non-discrimination policy, before running ads. Visit facebook.com/certification/nondiscrimination to certify compliance.",
  );
  assert.equal(w?.scope, "account");
});

test("verified-advertiser / beneficiary walls → family scope", () => {
  assert.equal(juroBlockingError("Provide a verified advertiser to run ads here")?.scope, "family");
  assert.equal(juroBlockingError("Enter the person or organization being promoted by an ad")?.scope, "family");
});

test("transient noise → null", () => {
  assert.equal(juroBlockingError(undefined), null);
  assert.equal(juroBlockingError(""), null);
  assert.equal(juroBlockingError("Service temporarily unavailable"), null);
});

// jurar's bid wire = hsWireBid's "lion" channel (ROAS ×100 / cap cents), probed live 08-25:
// starting_bid 90 → Meta floor 9000; the doc's "decimal 1.20" lands as a min-clamped floor 100.
// (hsWireBid itself isn't importable here — lib/hs-launch pulls extensionless "./types", which
// node --test's type stripping can't resolve; the route wires it directly.)
