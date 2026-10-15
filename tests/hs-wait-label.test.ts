// `node --test tests/hs-wait-label.test.ts` — what a server-queued HS row says while LION works on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { doneRowNote, lionWaitLabel } from "../lib/hs-wait-label.ts";

test("a server row names the LION stage the follow-up wrote", () => {
  assert.equal(lionWaitLabel({ srv: true, stage: "queue" }), "Queued on LION");
  assert.equal(lionWaitLabel({ srv: true, stage: "campaign" }), "Creating campaign");
  assert.equal(lionWaitLabel({ srv: true, stage: "adset" }), "Creating ad set");
  assert.equal(lionWaitLabel({ srv: true, stage: "ads" }), "Creating ads");
});

test("a clone waiting for its activation says so", () => {
  assert.equal(lionWaitLabel({ srv: true, stage: "activate" }), "Created on LION · activating");
});

test("an unknown stage falls back to a plain wait, and a legacy client-polled row keeps the old text", () => {
  assert.equal(lionWaitLabel({ srv: true, stage: "submit" }), "Waiting for LION");
  assert.equal(lionWaitLabel({ srv: false, stage: "queue" }), "On LION: …");
  assert.equal(lionWaitLabel({ srv: false, stage: "queue", lionStatus: "CREATING_ADS" }), "Creating ads");
});

test("a done row that still carries a note shows it; a clean done row or an open row shows nothing", () => {
  assert.equal(doneRowNote({ status: "done", error: "activation failed — flip it ACTIVE in LION (Campaign not found)" }), "activation failed — flip it ACTIVE in LION (Campaign not found)");
  assert.equal(doneRowNote({ status: "done", error: null }), null);
  assert.equal(doneRowNote({ status: "done", error: "" }), null);
  assert.equal(doneRowNote({ status: "submitted", error: "whatever" }), null);
  assert.equal(doneRowNote({ status: "done", error: null, lionNote: "activation failed — flip it ACTIVE in LION (502)" }), "activation failed — flip it ACTIVE in LION (502)", "a legacy client-polled row keeps its note in lionNote");
});
