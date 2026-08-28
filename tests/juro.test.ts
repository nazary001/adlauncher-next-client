// Node's built-in runner: `node --test tests/juro.test.ts`.
// JURO rail helpers — wire facts probed live 2026-08-25 (see lib/juro.ts header).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  juroBlockingError,
  juroConversionEvent,
  juroEnsureMark,
  juroSourceGeo,
  juroSourceLocaleIds,
  juroStoryPage,
  juroStoryPages,
  juroTokenCountries,
  juroTokenRegionalCategories,
  juroTokenTargeting,
  juroWireCountries,
} from "../lib/juro.ts";

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

// ---- juroEnsureMark: the `API - JURO -` marker (token JURO names) ----------------------------

test("marker splices into the grammar zone, dropping a (CLONE)", () => {
  assert.equal(
    juroEnsureMark("[28/08] (GLO-01) API (CLONE) - (#ADX [HIGH]) - [MX] - tail"),
    "[28/08] (GLO-01) API - JURO - (#ADX [HIGH]) - [MX] - tail",
  );
  assert.equal(
    juroEnsureMark("[28/08] (GLO-01) API - (#ADX [HIGH]) - [MX] - "),
    "[28/08] (GLO-01) API - JURO - (#ADX [HIGH]) - [MX] - ",
  );
});

test("idempotent — an already-marked name/prefix is normalized, never doubled", () => {
  const marked = "[28/08] (GLO-01) API - JURO - (#ADX [HIGH]) - [MX] - tail";
  assert.equal(juroEnsureMark(marked), marked);
  // a JURO-born source run through the clone board gets "(CLONE)" ensured — the marker collapses
  assert.equal(
    juroEnsureMark("[28/08] (GLO-01) API (CLONE) - JURO - (#ADX [HIGH]) - [MX] - t"),
    "[28/08] (GLO-01) API - JURO - (#ADX [HIGH]) - [MX] - t",
  );
});

test("grammar-less names get the marker prepended; empty stays empty", () => {
  assert.equal(juroEnsureMark("manual ads-manager name"), "JURO - manual ads-manager name");
  assert.equal(juroEnsureMark(""), "");
});

// ---- juroTokenCountries: override wins verbatim (WW stays the board sentinel) ----------------

test("token wire: override verbatim, WW NOT translated (the targeting builder resolves it)", () => {
  assert.deepEqual(juroTokenCountries({ countries: ["WW"], localeIds: [] }, ["US"]), ["WW"]);
  assert.deepEqual(juroTokenCountries({ countries: ["MX", "CO"], localeIds: [] }, ["US"]), ["MX", "CO"]);
  assert.deepEqual(juroTokenCountries(null, ["US"]), ["US"]);
  assert.deepEqual(juroTokenCountries({ countries: [], localeIds: [6] }, []), []);
});

// ---- juroSourceGeo / juroSourceLocaleIds: Graph targeting → board codes ----------------------

test("explicit countries verbatim; worldwide group → WW; region-only → [] (refuse)", () => {
  assert.deepEqual(juroSourceGeo({ geo_locations: { countries: ["MX", "AR"] } }), ["MX", "AR"]);
  assert.deepEqual(juroSourceGeo({ geo_locations: { country_groups: ["worldwide"] } }), ["WW"]);
  assert.deepEqual(juroSourceGeo({ geo_locations: { regions: [{ key: "3859" }] } }), []);
  assert.deepEqual(juroSourceGeo({}), []);
});

test("locale ids pass through numeric-clean (the field LION's jurar wire loses)", () => {
  assert.deepEqual(juroSourceLocaleIds({ locales: [7, 23] }), [7, 23]);
  assert.deepEqual(juroSourceLocaleIds({ locales: ["7", "x"] }), [7]);
  assert.deepEqual(juroSourceLocaleIds({}), []);
});

// ---- juroTokenTargeting: fresh jurar-shape targeting for the Graph build ---------------------

test("explicit countries → country-level geo, 18–65, locales riding along", () => {
  assert.deepEqual(juroTokenTargeting(["MX", "CO"], [7, 23]), {
    age_min: 18,
    age_max: 65,
    geo_locations: { location_types: ["home", "recent"], countries: ["MX", "CO"] },
    locales: [7, 23],
  });
});

test("WW → worldwide group minus TW/SG (owner rule), declarations pair rides separately", () => {
  assert.deepEqual(juroTokenTargeting(["WW"], []), {
    age_min: 18,
    age_max: 65,
    geo_locations: { location_types: ["home", "recent"], country_groups: ["worldwide"] },
    excluded_geo_locations: { countries: ["TW", "SG"] },
  });
  assert.deepEqual(juroTokenRegionalCategories(["WW"]), ["TAIWAN_UNIVERSAL", "SINGAPORE_UNIVERSAL"]);
  assert.deepEqual(juroTokenRegionalCategories(["MX"]), []);
});

// jurar's bid wire = hsWireBid's "lion" channel (ROAS ×100 / cap cents), probed live 08-25:
// starting_bid 90 → Meta floor 9000; the doc's "decimal 1.20" lands as a min-clamped floor 100.
// The TOKEN channel writes Meta-native adset fields instead (hsWireBid "graph": ROAS ×10000 /
// cap cents). (hsWireBid itself isn't importable here — lib/hs-launch pulls extensionless
// "./types", which node --test's type stripping can't resolve; the routes wire it directly.)
