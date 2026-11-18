// Node's built-in runner (v24 strips types natively): `node --test tests/snap-clone-geo.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// Snapchat CLONE board — the geo of a clone (owner 18.11: «в наш клонер по snapchat добавим
// возможность при клонировании менять гео»): the wave's Geo in Settings, a row's own countries, one
// campaign per country, and the soft word when a Direct page's language does not fit the new geo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { snapCloneGeo, snapCloneGeoSets, snapCloneShotGeos, snapCloneTouchRows } from "../components/snap-clone-core.ts";
import { SNAP_DIRECT_LANDINGS, SNAP_PT_COUNTRIES, snapLandingGeoHint } from "../lib/snap-launch.ts";

type Row = { id: string; geoOwn?: boolean; touched?: boolean; card: { state: "idle" | "sending" | "ok" | "error"; msg?: string; geo: string[] } };
const row = (id: string, geo: string[], geoOwn?: boolean, state: Row["card"]["state"] = "idle"): Row => ({ id, ...(geoOwn === undefined ? {} : { geoOwn }), card: { state, geo, ...(state === "ok" ? { msg: "queued" } : {}) } });

test("snapCloneGeo: no wave Geo → the source's own countries (the row's drafted card)", () => {
  assert.deepEqual(snapCloneGeo(row("a", ["US", "CA"]), []), ["US", "CA"]);
});

test("snapCloneGeo: a wave Geo replaces the source's countries on every row that has none of its own", () => {
  assert.deepEqual(snapCloneGeo(row("a", ["US", "CA"]), ["BR"]), ["BR"]);
  assert.deepEqual(snapCloneGeo(row("b", ["US"], false), ["MX", "CO"]), ["MX", "CO"]);
});

test("snapCloneGeo: a row's own countries win over the wave's", () => {
  assert.deepEqual(snapCloneGeo(row("a", ["GB"], true), ["BR"]), ["GB"]);
  // even an emptied own list stays the row's — the validator then asks for a country
  assert.deepEqual(snapCloneGeo(row("b", [], true), ["BR"]), []);
});

test("snapCloneGeo: the answer is a copy — editing it never edits the wave's list", () => {
  const wave = ["BR"];
  const g = snapCloneGeo(row("a", ["US"]), wave);
  g.push("MX");
  assert.deepEqual(wave, ["BR"]);
});

test("snapCloneGeoSets: one campaign for the whole list unless split per country", () => {
  assert.deepEqual(snapCloneGeoSets(["US", "CA", "GB"], false), [["US", "CA", "GB"]]);
});

test("snapCloneGeoSets: one campaign per country — in order, deduped, upper-cased", () => {
  assert.deepEqual(snapCloneGeoSets(["BR", "mx", "CO", "MX"], true), [["BR"], ["MX"], ["CO"]]);
});

test("snapCloneGeoSets: a single country or an empty list stays ONE set (the validator names an empty one)", () => {
  assert.deepEqual(snapCloneGeoSets(["BR"], true), [["BR"]]);
  assert.deepEqual(snapCloneGeoSets([], true), [[]]);
  assert.deepEqual(snapCloneGeoSets([], false), [[]]);
});

test("snapCloneShotGeos: copies × countries, country by country — each copy its own campaign and key", () => {
  assert.deepEqual(snapCloneShotGeos([["BR"], ["MX"]], 2), [["BR"], ["BR"], ["MX"], ["MX"]]);
  assert.deepEqual(snapCloneShotGeos([["US", "CA"]], 3), [["US", "CA"], ["US", "CA"], ["US", "CA"]]);
  assert.deepEqual(snapCloneShotGeos([["BR"]], 0), [["BR"]], "at least one copy");
});

test("wave Geo change re-opens only the rows that ride it — a row with its own countries sends what it sent", () => {
  const rows = [row("a", ["US"], false, "ok"), row("b", ["GB"], true, "ok")];
  const next = snapCloneTouchRows(rows, (r) => !r.geoOwn);
  assert.equal(next[0].card.state, "idle", "rides the wave Geo → a draft again, no reload");
  assert.equal(next[1].card.state, "ok", "its own countries → still closed (no double clone)");
});

test("snapLandingGeoHint: not a Direct page or no countries → nothing to say", () => {
  assert.equal(snapLandingGeoHint("https://fast-flow.org/ht/age-gate/digital-marketing/en/", ["BR"]), null);
  assert.equal(snapLandingGeoHint("https://fast-flow.org/htd/cars/pt/", []), null);
  assert.equal(snapLandingGeoHint("", ["BR"]), null);
});

test("snapLandingGeoHint: a language that fits every country is fine", () => {
  assert.equal(snapLandingGeoHint("https://fast-flow.org/htd/cars/pt/", ["BR", "PT"]), null);
  assert.equal(snapLandingGeoHint("https://azmvhs.com/v/auto-financing-by-ford/", ["US", "CA"]), null);
});

test("snapLandingGeoHint: a Portuguese page moved to Spanish countries → the note + the same niche in English", () => {
  const h = snapLandingGeoHint("https://fast-flow.org/htd/cars/pt/?utm_campaign=glo-snp_001", ["MX", "CO"]);
  assert.ok(h);
  assert.match(h.note, /Cars · PT/);
  assert.match(h.note, /MX, CO/);
  assert.equal(h.switchTo?.id, "cars");
});

test("snapLandingGeoHint: a Portuguese page on BR + MX → names MX, offers no switch (BR still reads it)", () => {
  const h = snapLandingGeoHint("https://fast-flow.org/htd/digital-marketing/pt/", ["BR", "MX"]);
  assert.ok(h);
  assert.match(h.note, /MX/);
  assert.doesNotMatch(h.note, /BR/);
  assert.equal(h.switchTo, null);
});

test("snapLandingGeoHint: an English page moved to Brazil → the note + the same niche in Portuguese", () => {
  const h = snapLandingGeoHint("https://azmvhs.com/v/dmi-online-marketing-course/", ["br"]);
  assert.ok(h);
  assert.match(h.note, /Digital marketing · EN/);
  assert.match(h.note, /BR/);
  assert.equal(h.switchTo?.id, "dmi-pt");
});

test("snapLandingGeoHint: an English page on US + BR → names BR, offers no switch", () => {
  const h = snapLandingGeoHint("https://azmvhs.com/v/auto-financing-by-ford/", ["US", "BR"]);
  assert.ok(h);
  assert.match(h.note, /BR/);
  assert.equal(h.switchTo, null);
});

test("snapLandingGeoHint: a long list of countries is cut, never a wall of codes", () => {
  const h = snapLandingGeoHint("https://fast-flow.org/htd/cars/pt/", ["AR", "CL", "CO", "CR", "DO", "EC", "GT", "HN", "MX"]);
  assert.ok(h);
  assert.match(h.note, /\+\d more/);
});

test("SNAP_PT_COUNTRIES: Brazil and Portugal are in; every Direct page has its pair in the other language", () => {
  assert.ok(SNAP_PT_COUNTRIES.includes("BR"));
  assert.ok(SNAP_PT_COUNTRIES.includes("PT"));
  for (const l of SNAP_DIRECT_LANDINGS) {
    const pair = SNAP_DIRECT_LANDINGS.find((x) => x.niche === l.niche && x.lang !== l.lang);
    assert.ok(pair, `${l.id} has a pair`);
  }
});
