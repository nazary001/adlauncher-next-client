// Node's built-in runner (v24 strips types natively): `node --test tests/launch-guards.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  launchFailureDisposition,
  makeGate,
  overrideDeadlineError,
  partialFailureNote,
} from "../lib/launch-guards.ts";

// ---- makeGate: the launch click latch --------------------------------------------------------

test("gate blocks re-entry while held", () => {
  const gate = makeGate();
  assert.equal(gate.enter(), true);
  assert.equal(gate.enter(), false); // the double-click
});

test("gate reopens after exit", () => {
  const gate = makeGate();
  gate.enter();
  gate.exit();
  assert.equal(gate.enter(), true);
});

// ---- launchFailureDisposition: what a failed MO launch left behind on FB ---------------------

test("no campaign created → nothing to pause, no ads live", () => {
  assert.deepEqual(launchFailureDisposition({}), { pauseNeeded: false, adsLive: 0 });
});

test("campaign without ads → pause needed, zero ads live", () => {
  assert.deepEqual(launchFailureDisposition({ campaign_id: "120001" }), { pauseNeeded: true, adsLive: 0 });
});

test("single ad recorded → one ad live", () => {
  assert.deepEqual(launchFailureDisposition({ campaign_id: "120001", ad_id: "990001" }), {
    pauseNeeded: true,
    adsLive: 1,
  });
});

test("multi-creative partial: ad_ids wins the count", () => {
  assert.deepEqual(
    launchFailureDisposition({ campaign_id: "120001", ad_id: "990001", ad_ids: ["990001", "990002", "990003"] }),
    { pauseNeeded: true, adsLive: 3 },
  );
});

// ---- partialFailureNote: the suffix appended to the task's error message ---------------------

test("no campaign → empty note", () => {
  assert.equal(partialFailureNote({ pauseNeeded: false, adsLive: 0 }, false), "");
});

test("live ads + confirmed pause → calm, names the count", () => {
  assert.equal(
    partialFailureNote({ pauseNeeded: true, adsLive: 2 }, true),
    " — 2 ad(s) went live before the failure; the campaign is now PAUSED, nothing is spending",
  );
});

test("live ads + pause NOT confirmed → tells the buyer to act NOW", () => {
  assert.equal(
    partialFailureNote({ pauseNeeded: true, adsLive: 2 }, false),
    " — 2 ad(s) went LIVE before the failure and the campaign could NOT be confirmed paused: pause it in Ads Manager NOW",
  );
});

test("ad-less campaign + confirmed pause → calm", () => {
  assert.equal(partialFailureNote({ pauseNeeded: true, adsLive: 0 }, true), " — the campaign is PAUSED, nothing is spending");
});

test("ad-less campaign + pause NOT confirmed → says nothing spends anyway", () => {
  assert.equal(
    partialFailureNote({ pauseNeeded: true, adsLive: 0 }, false),
    " — the campaign has no ads (nothing spends) but could not be confirmed paused",
  );
});

// ---- overrideDeadlineError: the HS duplicate deadline row must tell the truth ----------------

test("deadline with confirmed pause → 'it is PAUSED' instructions", () => {
  assert.equal(
    overrideDeadlineError("6001", true),
    "clone 6001 created but the geo override was NOT applied in time — it is PAUSED; set the targeting in Ads Manager and activate, or delete and re-fire",
  );
});

test("deadline without confirmed pause → SOURCE-geo delivery alarm", () => {
  assert.equal(
    overrideDeadlineError("6001", false),
    "clone 6001 created but the geo override was NOT applied — and it could NOT be confirmed PAUSED, so it may be DELIVERING on the SOURCE geo: pause it in Ads Manager NOW, fix the targeting, then activate",
  );
});
