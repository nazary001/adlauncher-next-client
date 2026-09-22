// Node's built-in runner (v24 strips types natively): `node --test tests/targeting-override.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// HS duplicate rail — lib/targeting-override.ts: the per-clone geo/locales override as the wire
// parses it, and (22.09) as LION's duplicate/ takes it: `country_codes` / `locales` per campaign.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lionDuplicateTargeting, parseGeoOverride, relabelNameGeo, type GeoOverride } from "../lib/targeting-override.ts";

const PROFILE_LOCALES = [
  { id: 6, name: "English (US)" },
  { id: 24, name: "English (UK)" },
  { id: 23, name: "Spanish" },
];

test("parseGeoOverride: nothing → null; codes upper-cased; WW exclusive; locale ids numeric", () => {
  assert.equal(parseGeoOverride([], []), null);
  assert.deepEqual(parseGeoOverride(["us", "ca"], ["6", 24]), { countries: ["US", "CA"], localeIds: [6, 24] });
  assert.deepEqual(parseGeoOverride(["WW"], []), { countries: ["WW"], localeIds: [] });
  assert.deepEqual(parseGeoOverride(["WW", "US"], []), { error: "ww_is_exclusive" });
  assert.deepEqual(parseGeoOverride(["USA"], []), { error: "country_code_invalid_USA" });
  assert.deepEqual(parseGeoOverride([], ["abc"]), null); // a non-numeric id is no locale at all
});

test("lionDuplicateTargeting: countries ride as ISO codes, WW as [\"WORLD\"]; locales as { name, id } from the profile list; an empty side is omitted (inherit)", () => {
  const both: GeoOverride = { countries: ["US", "CA"], localeIds: [6, 24] };
  assert.deepEqual(lionDuplicateTargeting(both, PROFILE_LOCALES), {
    country_codes: ["US", "CA"],
    locales: [
      { name: "English (US)", id: "6" },
      { name: "English (UK)", id: "24" },
    ],
  });
  assert.deepEqual(lionDuplicateTargeting({ countries: ["WW"], localeIds: [] }, PROFILE_LOCALES), { country_codes: ["WORLD"] });
  const localesOnly = lionDuplicateTargeting({ countries: [], localeIds: [23] }, PROFILE_LOCALES);
  assert.deepEqual(localesOnly, { locales: [{ name: "Spanish", id: "23" }] });
  assert.equal("country_codes" in localesOnly, false); // omitted = the source's countries stay
  // never `locales: []` — that would mean "all languages" on LION's side
  assert.equal("locales" in lionDuplicateTargeting({ countries: ["US"], localeIds: [] }, PROFILE_LOCALES), false);
});

test("lionDuplicateTargeting: a locale id the profile does not list is refused before any call (LION rejects a locale without its id per campaign)", () => {
  const r = lionDuplicateTargeting({ countries: ["US"], localeIds: [6, 999] }, PROFILE_LOCALES);
  assert.ok("refusal" in r);
  if ("refusal" in r) assert.match(r.refusal, /^locale_unknown_999 — not on this profile's FB locale list/);
  // the input arrays are never mutated / shared
  const o: GeoOverride = { countries: ["US"], localeIds: [] };
  const w = lionDuplicateTargeting(o, PROFILE_LOCALES);
  if (!("refusal" in w)) {
    w.country_codes!.push("XX");
    assert.deepEqual(o.countries, ["US"]);
  }
});

test("relabelNameGeo swaps the [CODES] group after the redirect label, WORLD for WW", () => {
  assert.equal(relabelNameGeo("[20/08] (GLO-01) API (CLONE) - (#ADX [HIGH]) - [MX] - x", ["CA", "US"]), "[20/08] (GLO-01) API (CLONE) - (#ADX [HIGH]) - [CA, US] - x");
  assert.equal(relabelNameGeo("[20/08] (GLO-01) API (CLONE) - (#ADX [HIGH]) - [MX] - x", ["WW"]), "[20/08] (GLO-01) API (CLONE) - (#ADX [HIGH]) - [WORLD] - x");
  assert.equal(relabelNameGeo("name", []), "name");
});
