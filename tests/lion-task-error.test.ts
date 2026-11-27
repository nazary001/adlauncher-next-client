// Node's built-in runner: `node --test tests/lion-task-error.test.ts`.
// LION's creation-status error became a structured object (seen 26–27.11 on GLO-04): a plain-language
// `message` ("Minimum ROAS bidding is not available on this account"), Meta's wording in `title` /
// `detail`, the numeric `subcode` and an `is_transient` flag. The wall matchers read only `message`,
// so the min-ROAS wall (matched on "2446671" / "Minimum ROAS Isn't Available") stopped matching and
// 72 rows waited out the 3 h window; four more Facebook walls LION never gets past were not known.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lionErrorText, lionFinalWall } from "../lib/lion-task-error.ts";
import { lionRoasWall } from "../lib/lion-dup-bid.ts";
import { juroBlockingError } from "../lib/juro.ts";

const roas = {
  message: "Minimum ROAS bidding is not available on this account",
  why: "Facebook has not enabled the Minimum ROAS bid strategy for this ad account or pixel.",
  fix: "Launch with a different bid strategy (lowest cost or bid cap), or use an ad account and pixel that already have value data.",
  step: "creating the campaign",
  title: "Minimum ROAS Isn't Available",
  detail: "Ad accounts owned by a new business can use minimum ROAS for ad delivery after several weeks of following our policies.",
  technical: "Invalid parameter",
  code: 100,
  subcode: 2446671,
  is_transient: false,
};
const advertiser = { message: "Facebook needs an advertiser name for this ad set", title: "No advertiser indicated", detail: "Enter the person or organization being promoted by an ad.", code: 100, subcode: 3858081, is_transient: false };
const refused = { message: "Facebook refused to publish this ad set", fix: "Read Facebook's message below.", title: "This ad set can’t be published", code: 100, subcode: 3858196, is_transient: false };
const payment = { message: "The ad account has no payment method", fix: "Add a payment method to the ad account in Billing.", title: "No Payment Method", code: 100, subcode: 1359188, is_transient: false };
const restricted = { message: "This ad account is restricted from advertising", title: "Disabled accounts can't create or edit ads", code: 100, subcode: 1885316, is_transient: false };
const permission = { message: "The profile does not have permission for this action", title: "Permission Error", code: 200, subcode: 1487194, is_transient: false };
const creativeBlip = { message: "Facebook could not create the creative right now", title: "Creative creation temporarily unavailable", code: 2, subcode: 3858797, is_transient: true };

test("lionErrorText: the structured error reads as one line the wall matchers see; the old string shape passes", () => {
  const t = lionErrorText(roas);
  assert.match(t, /Minimum ROAS bidding is not available/);
  assert.match(t, /Minimum ROAS Isn't Available/);
  assert.match(t, /2446671/);
  assert.equal(lionErrorText({ message: "plain" }), "plain");
  assert.equal(lionErrorText("a sentence"), "a sentence");
  assert.equal(lionErrorText(null), "");
  assert.equal(lionErrorText(undefined), "");
});

test("the min-ROAS wall and the JURO walls match again on the structured error", () => {
  assert.ok(lionRoasWall(lionErrorText(roas)));
  assert.equal(juroBlockingError(lionErrorText(roas))?.scope, "family");
  assert.equal(juroBlockingError(lionErrorText(advertiser))?.scope, "family", "the EU beneficiary wall (Meta's 'person or organization being promoted') — a JURO wall since 08-25");
  assert.equal(lionRoasWall(lionErrorText(advertiser)), null);
});

test("lionFinalWall: the walls LION never gets past — account walls reach the account, the rest the shot", () => {
  assert.equal(lionFinalWall(payment)?.scope, "account");
  assert.equal(lionFinalWall(restricted)?.scope, "account");
  assert.equal(lionFinalWall(refused)?.scope, "shot");
  assert.equal(lionFinalWall(permission)?.scope, "shot");
  assert.match(lionFinalWall(payment)!.reason, /no payment method/i);
  assert.match(lionFinalWall(payment)!.reason, /Add a payment method/);
});

test("lionFinalWall: not for walls LION works through itself, a transient blip, min ROAS (its own matcher) or an unknown answer", () => {
  assert.equal(lionFinalWall(advertiser), null, "LION retries the EU advertiser name with the page name — those tasks complete");
  assert.equal(lionFinalWall(creativeBlip), null);
  assert.equal(lionFinalWall({ ...payment, is_transient: true }), null);
  assert.equal(lionFinalWall(roas), null);
  assert.equal(lionFinalWall({ message: "something new", subcode: 1, is_transient: false }), null);
  assert.equal(lionFinalWall({ message: "The ad account has no payment method" }), null, "the old string-only shape carries no subcode — nothing to be sure of");
  assert.equal(lionFinalWall(null), null);
});
