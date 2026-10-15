// `node --test tests/hs-dup-refusal.test.ts` — LION's duplicate preflight refusals, explained for a buyer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { explainDupRefusal } from "../lib/hs-dup-refusal.ts";

test("'No valid creative URL' names the dead source and tells the buyer to pick another one", () => {
  const out = explainDupRefusal("No valid creative URL found in campaign ads");
  assert.ok(out.startsWith("No valid creative URL found in campaign ads — "), out);
  assert.match(out, /post|creative/i);
  assert.match(out, /another source/i);
});

test("any other reason passes through untouched", () => {
  assert.equal(explainDupRefusal("Failed to retrieve this campaign data"), "Failed to retrieve this campaign data");
  assert.equal(explainDupRefusal(""), "");
});
