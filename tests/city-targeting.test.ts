// Node's built-in runner: `node --test tests/city-targeting.test.ts`.
// City targeting through TOOL (owner ask 18.11: «запуски на конкретный город»): the pure city rules
// (lib/city-targeting), the TOOL builder's raw.geo_locations (lib/tool-launch), the card readiness
// gate (lib/types isReady citiesAllowed) and the Graph city search core (lib/city-search-core) driven
// through a FAKE Graph — no network.
import { test } from "node:test";
import assert from "node:assert/strict";

import * as ct from "../lib/city-targeting.ts";
import * as tl from "../lib/tool-launch.ts";
import type { ToolBuildInput } from "../lib/tool-launch.ts";
import { isReady, makeCampaign } from "../lib/types.ts";
import { _resetCitySearch, searchCities } from "../lib/city-search-core.ts";
import type { CitySearchDeps } from "../lib/city-search-core.ts";

const SP = { key: "269969", name: "São Paulo, Sao Paulo", region: "São Paulo (state)", country: "BR" };
const RIO = { key: "267143", name: "Rio de Janeiro, Rio de Janeiro", region: "Rio de Janeiro (state)", country: "BR" };
const CDMX = { key: "1531765", name: "Mexico City, Distrito Federal", region: "Distrito Federal", country: "MX" };

// ---- lib/city-targeting ------------------------------------------------------------------------

test("cityRadiusKm: default, the picks, garbled → null", () => {
  assert.equal(ct.cityRadiusKm(undefined), 40);
  assert.equal(ct.cityRadiusKm(""), 40);
  assert.equal(ct.cityRadiusKm("0"), 0);
  assert.equal(ct.cityRadiusKm("80"), 80);
  assert.equal(ct.cityRadiusKm("12"), null);
  assert.equal(ct.cityRadiusKm("abc"), null);
});

test("cleanCities: keeps well-formed rows once, refuses garbled ones whole", () => {
  assert.deepEqual(ct.cleanCities(undefined), []);
  assert.deepEqual(ct.cleanCities([SP, { ...SP }, RIO]), [SP, RIO]);
  assert.deepEqual(ct.cleanCities([{ key: "269969", country: "br" }]), [{ key: "269969", country: "BR", name: "269969", region: "" }]);
  assert.equal(ct.cleanCities("SP"), null);
  assert.equal(ct.cleanCities([{ key: "abc", country: "BR" }]), null);
  assert.equal(ct.cleanCities([{ key: "1", country: "Brazil" }]), null);
  assert.equal(ct.cleanCities(Array.from({ length: ct.MAX_CITIES + 1 }, (_, i) => ({ key: String(i + 1), country: "BR" }))), null);
});

test("cityGeoLocations: every country narrowed → only cities, the stub country for TOOL's schema", () => {
  const g = ct.cityGeoLocations(["BR"], [SP, RIO], 40);
  assert.ok(g.ok);
  assert.deepEqual(g.countries, ["BR"]);
  assert.deepEqual(g.geoLocations, {
    cities: [
      { key: "269969", radius: 40, distance_unit: "kilometer" },
      { key: "267143", radius: 40, distance_unit: "kilometer" },
    ],
    location_types: ["home", "recent"],
  });
});

test("cityGeoLocations: a country without a picked city stays whole next to the cities", () => {
  const g = ct.cityGeoLocations(["BR", "MX", "CO"], [CDMX], 0);
  assert.ok(g.ok);
  assert.deepEqual(g.countries, ["BR", "CO"]);
  assert.deepEqual(g.geoLocations, { cities: [{ key: "1531765" }], location_types: ["home", "recent"], countries: ["BR", "CO"] });
});

test("cityGeoLocations refuses WW, a city outside the Geo and a bad radius", () => {
  const ww = ct.cityGeoLocations(["WW"], [SP], 40);
  assert.ok(!ww.ok && ww.error.startsWith("cities_with_worldwide"));
  const out = ct.cityGeoLocations(["MX"], [SP], 40);
  assert.ok(!out.ok && out.error.startsWith("city_outside_geo: São Paulo (BR)"));
  const r = ct.cityGeoLocations(["BR"], [SP], null);
  assert.ok(!r.ok && r.error.startsWith("city_radius_invalid"));
});

test("orphanCities + cityGeoLabel", () => {
  assert.deepEqual(ct.orphanCities([SP, CDMX], ["MX"]), [SP]);
  assert.deepEqual(ct.orphanCities([SP], ["WW"]), [SP]);
  assert.deepEqual(ct.orphanCities(undefined, ["BR"]), []);
  assert.equal(ct.cityGeoLabel(["BR"], [], "40", "Brazil"), "Brazil");
  assert.equal(ct.cityGeoLabel(["BR"], [SP], "40", "Brazil"), "São Paulo +40 km");
  assert.equal(ct.cityGeoLabel(["BR", "MX"], [SP, RIO, { ...SP, key: "1", name: "Campinas" }], "0", "x"), "São Paulo, Rio de Janeiro +1 · MX");
});

test("hasCities: empty / missing = no; anything else = yes (garbled is refused by the builder)", () => {
  assert.equal(ct.hasCities({}), false);
  assert.equal(ct.hasCities({ cities: [] }), false);
  assert.equal(ct.hasCities({ cities: [SP] }), true);
  assert.equal(ct.hasCities({ cities: "x" }), true);
});

test("citySearchPath + parseGraphCities (Graph adgeolocation shape seen 18.11)", () => {
  const p = ct.citySearchPath("sao paulo", "BR");
  assert.ok(p.startsWith("search?type=adgeolocation&location_types=%5B%22city%22%5D&locale=en_US&limit=20&country_code=BR&q=sao%20paulo"));
  assert.ok(!ct.citySearchPath("x y", null).includes("country_code"));
  const body = {
    data: [
      { key: "247071", name: "Campinas, Sao Paulo", type: "city", country_code: "BR", region: "São Paulo (state)", supports_city: true },
      { key: "460", name: "São Paulo (state)", type: "region", country_code: "BR" },
      { key: "247071", name: "dup", type: "city", country_code: "BR" },
      { key: "x1", name: "bad", type: "city", country_code: "BR" },
    ],
  };
  assert.deepEqual(ct.parseGraphCities(body), [{ key: "247071", country: "BR", name: "Campinas, Sao Paulo", region: "São Paulo (state)" }]);
  assert.deepEqual(ct.parseGraphCities({ error: { code: 200 } }), []);
  assert.equal(ct.cityQuery(" s "), null);
  assert.equal(ct.cityQuery("  sao   paulo "), "sao paulo");
});

// ---- lib/tool-launch buildToolCampaign ----------------------------------------------------------

function input(over: Partial<ToolBuildInput> = {}): ToolBuildInput {
  return {
    name: "[18/11] (ACR) API - (#ADX) - [BR] - GCL TOOL - city",
    objective: "OUTCOME_SALES",
    budgetUsd: 10,
    bidStrategy: "LOWEST_COST_WITHOUT_CAP",
    bid: { kind: "none" },
    optimization: "conversions",
    conversionEvent: "PURCHASE",
    pixelId: "PX1",
    pageId: "PAGE1",
    countries: ["BR"],
    localeIds: [],
    category: "",
    placement: "FULL",
    ageMin: "18",
    userOs: "all",
    creatives: [{ name: "ad1", media: { type: "image", media_id: "med_1" }, primaryText: "body", headline: "Head", url: "https://x.co", cta: "LEARN_MORE" }],
    status: "ACTIVE",
    accountCurrency: "USD",
    ...over,
  };
}

test("buildToolCampaign: cities ride raw.geo_locations with allow_inferred; locales stay normalized", () => {
  const g = ct.cityGeoLocations(["BR"], [SP], 25);
  assert.ok(g.ok);
  const r = tl.buildToolCampaign(input({ cityGeo: { countries: g.countries, geoLocations: g.geoLocations }, localeIds: [6] }));
  assert.ok(r.ok);
  const t = r.body.adsets[0].targeting;
  assert.deepEqual(t.countries, ["BR"]);
  assert.deepEqual(t.raw, { geo_locations: { cities: [{ key: "269969", radius: 25, distance_unit: "kilometer" }], location_types: ["home", "recent"] } });
  assert.deepEqual(t.locales, [6]);
  assert.ok(r.inferred.includes("cities"));
  assert.equal(r.body.options?.allow_inferred, true);
});

test("buildToolCampaign: no cities = the countries-only geo, unchanged", () => {
  const r = tl.buildToolCampaign(input());
  assert.ok(r.ok);
  assert.deepEqual(r.body.adsets[0].targeting.countries, ["BR"]);
  assert.equal(r.body.adsets[0].targeting.raw, undefined);
  assert.ok(!r.inferred.includes("cities"));
});

test("buildToolCampaign refuses a city refusal and WW + cities before anything is sent", () => {
  const bad = tl.buildToolCampaign(input({ cityGeo: { error: "city_outside_geo: X (BR)" } }));
  assert.deepEqual(bad, { ok: false, error: "city_outside_geo: X (BR)" });
  const ww = tl.buildToolCampaign(input({ countries: ["WW"], cityGeo: { countries: ["BR"], geoLocations: { cities: [{ key: "1" }] } } }));
  assert.ok(!ww.ok && ww.error.startsWith("cities_with_worldwide"));
});

// ---- lib/types isReady ------------------------------------------------------------------------

test("isReady: a card with cities is held off the TOOL rail, ready on it", () => {
  const c = { ...makeCampaign("c1", "", "tail"), countries: ["BR"], cities: [SP] };
  assert.equal(isReady(c), false);
  assert.equal(isReady(c, { citiesAllowed: true }), true);
  assert.equal(isReady({ ...c, cities: [] }), true);
  assert.equal(isReady({ ...c, cities: undefined }), true);
});

// ---- lib/city-search-core (fake Graph) ----------------------------------------------------------

function fakeDeps(answers: Record<string, { status: number; body: unknown }[]>, calls: string[]): CitySearchDeps {
  return {
    signers: async () => [
      { fp: "aif", token: "T_AIF" },
      { fp: "hs", token: "T_HS" },
    ],
    fetchJson: async (url, token) => {
      calls.push(`${token} ${url}`);
      const q = answers[token];
      const next = q?.shift();
      if (!next) throw new Error("unexpected call");
      return next;
    },
    base: () => "https://graph.test/v21.0",
    now: () => 1_000_000,
  };
}
const OK = (rows: object[]) => ({ status: 200, body: { data: rows } });
const ROW = { key: "247071", name: "Campinas, Sao Paulo", type: "city", country_code: "BR", region: "SP" };

test("searchCities: a blocked signer is skipped (and benched), the next one answers; the answer is cached", async () => {
  _resetCitySearch();
  const calls: string[] = [];
  const deps = fakeDeps({ T_AIF: [{ status: 400, body: { error: { code: 200, message: "API access blocked." } } }], T_HS: [OK([ROW])] }, calls);
  const r = await searchCities("campinas", ["BR"], deps);
  assert.deepEqual(r, { ok: true, cities: [{ key: "247071", country: "BR", name: "Campinas, Sao Paulo", region: "SP" }] });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].startsWith("T_AIF https://graph.test/v21.0/search?type=adgeolocation"));
  // same query again → cache, no Graph call at all
  const again = await searchCities("Campinas", ["BR"], deps);
  assert.ok(again.ok);
  assert.equal(calls.length, 2);
  // a new query → the benched AIF signer is skipped, HS asked directly
  (deps as { fetchJson: CitySearchDeps["fetchJson"] }).fetchJson = async (url, token) => {
    calls.push(`${token} ${url}`);
    return OK([]);
  };
  await searchCities("santos", ["BR"], deps);
  assert.equal(calls.length, 3);
  assert.ok(calls[2].startsWith("T_HS "));
});

test("searchCities: a refused QUERY stops at the first signer; all signers dead → error", async () => {
  _resetCitySearch();
  const calls: string[] = [];
  const deps = fakeDeps({ T_AIF: [{ status: 400, body: { error: { code: 100, message: "Invalid parameter" } } }] }, calls);
  const r = await searchCities("zz", ["BR"], deps);
  assert.ok(!r.ok && r.error.includes("#100"));
  assert.equal(calls.length, 1);

  _resetCitySearch();
  const calls2: string[] = [];
  const dead = fakeDeps(
    {
      T_AIF: [{ status: 400, body: { error: { code: 190, message: "expired" } } }],
      T_HS: [{ status: 400, body: { error: { code: 4, message: "rate" } } }],
    },
    calls2,
  );
  const d = await searchCities("rio", ["BR"], dead);
  assert.ok(!d.ok && d.error.includes("#4"));
  const after = await searchCities("rio2", ["BR"], dead);
  assert.ok(!after.ok && after.error.startsWith("no_signer"));
  assert.equal(calls2.length, 2);
});

test("searchCities: one search per country, merged, a city outside the countries dropped", async () => {
  _resetCitySearch();
  const calls: string[] = [];
  const mx = { key: "1531765", name: "Mexico City", type: "city", country_code: "MX", region: "DF" };
  const deps = fakeDeps({ T_AIF: [OK([ROW, { ...mx, key: "9", country_code: "AR" }]), OK([mx])] }, calls);
  const r = await searchCities("ci", ["BR", "MX"], deps);
  assert.ok(r.ok);
  assert.deepEqual(r.cities.map((c) => c.key), ["247071", "1531765"]);
  assert.ok(calls[0].includes("country_code=BR") && calls[1].includes("country_code=MX"));
});
