// Node's built-in runner (v24 strips types natively): `node --test tests/hs-page-gate.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HS_PAGE_OK_STATE,
  gatePages,
  pageGateRefusal,
  pageGateVerdict,
  registryRowStates,
} from "../lib/hs-page-gate.ts";

// The owner rule (2026-09-07): the HS rail works ONLY with fankas the hs-tools registry marks
// `state: "ok"`; every other state and every page the registry has no row for is discarded.

const STATES = {
  "421334911071579": "ok",
  "704214619452597": "banned",
  "173038562549933": "pub_stale",
  "108997212121934": "no_access",
};

// ---- pageGateVerdict: one page's verdict ----------------------------------------------------

test("ok state passes", () => {
  assert.equal(HS_PAGE_OK_STATE, "ok");
  assert.deepEqual(pageGateVerdict("421334911071579", STATES), { ok: true, state: "ok" });
});

test("banned page is refused with a reason naming page, name and state", () => {
  const v = pageGateVerdict("704214619452597", STATES, "Michael11");
  assert.equal(v.ok, false);
  if (v.ok) return;
  assert.equal(v.state, "banned");
  assert.match(v.reason, /704214619452597/);
  assert.match(v.reason, /Michael11/);
  assert.match(v.reason, /BANNED/);
  assert.match(v.reason, /only OK fankas/);
});

test("stale and no-access states are refused too (anything but ok)", () => {
  assert.equal(pageGateVerdict("173038562549933", STATES).ok, false);
  assert.equal(pageGateVerdict("108997212121934", STATES).ok, false);
});

test("a page the registry has no row for is refused as unregistered", () => {
  const v = pageGateVerdict("1234622636397513", STATES, "Eleanor Clark");
  assert.equal(v.ok, false);
  if (v.ok) return;
  assert.equal(v.state, "");
  assert.match(v.reason, /not registered in hs-tools/);
  assert.match(v.reason, /1234622636397513/);
  assert.match(v.reason, /Eleanor Clark/);
});

test("reason without a catalog name still names the page id", () => {
  const v = pageGateVerdict("704214619452597", STATES);
  assert.equal(v.ok, false);
  if (v.ok) return;
  assert.match(v.reason, /fanka 704214619452597 is BANNED/);
});

test("state comparison tolerates case and whitespace", () => {
  assert.equal(pageGateVerdict("1", { "1": " OK " }).ok, true);
  assert.equal(pageGateVerdict("2", { "2": "Banned" }).ok, false);
});

// ---- registryRowStates: registry rows → page id → state ---------------------------------------

test("registry rows map to states, INCLUDING rows the box has no numbers for", () => {
  const rows = [
    { page_id: "421334911071579", state: "ok", has_data: true },
    { page_id: "108997212121934", state: "no_access", has_data: false },
    { page_id: 704214619452597, state: "banned" }, // numeric id tolerated
    { state: "ok" }, // no id → dropped
    { page_id: "173038562549933" }, // no state → dropped (unknown ≠ ok)
  ];
  assert.deepEqual(registryRowStates(rows), {
    "421334911071579": "ok",
    "108997212121934": "no_access",
    "704214619452597": "banned",
  });
});

// ---- gatePages: a profile catalog split into offered (ok) and hidden -----------------------

test("gatePages offers only ok pages and hides the rest, keeping order", () => {
  const pages = [
    { id: "704214619452597", name: "Michael11" },
    { id: "421334911071579", name: "Freedom resuscitation 08" },
    { id: "1234622636397513", name: "Eleanor Clark" },
    { id: "173038562549933", name: "Willie Kerluke 1" },
  ];
  const { offered, hidden } = gatePages(pages, STATES);
  assert.deepEqual(
    offered.map((p) => p.id),
    ["421334911071579"],
  );
  assert.deepEqual(
    hidden.map((p) => p.id),
    ["704214619452597", "1234622636397513", "173038562549933"],
  );
  // The catalog objects ride through untouched (the client keeps its RichOption shape).
  assert.equal(offered[0], pages[1]);
});

test("gatePages with an empty state map hides everything", () => {
  const { offered, hidden } = gatePages([{ id: "421334911071579" }], {});
  assert.equal(offered.length, 0);
  assert.equal(hidden.length, 1);
});

// ---- pageGateRefusal: one refusal line for a launch's page set ---------------------------------

test("all-ok page set → no refusal", () => {
  assert.equal(pageGateRefusal([{ id: "421334911071579", name: "x" }], STATES), null);
});

test("first offender's reason is the refusal, with the count of further offenders", () => {
  const refusal = pageGateRefusal(
    [
      { id: "421334911071579" },
      { id: "704214619452597", name: "Michael11" },
      { id: "118448311362635", name: "Lee Tremblay" },
    ],
    { ...STATES, "118448311362635": "banned" },
  );
  assert.ok(refusal);
  assert.match(refusal, /704214619452597 \(Michael11\) is BANNED/);
  assert.match(refusal, /\+1 more/);
});

test("single offender carries no '+N more' tail", () => {
  const refusal = pageGateRefusal([{ id: "704214619452597" }], STATES);
  assert.ok(refusal);
  assert.doesNotMatch(refusal, /more/);
});
