// Node's built-in runner (v24 strips types natively): `node --test tests/google-account-status.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// Google Ads rail — lib/google-account-status.ts: the pickers list only launch accounts that are
// ACTIVE on Google (owner ask 21.09; since 25.09 the status is the `status` word google-weapon
// puts on every account of its customers list — the campaign-derived book of 21.09 is gone).
import { test } from "node:test";
import assert from "node:assert/strict";
import { foldGoogleLaunchCatalog, googleAccountDeadReason, googleCustomerStatusVerdict } from "../lib/google-account-status.ts";
import { isGoogleLaunchAccount } from "../lib/google-bid.ts";

const DAY = "2026-09-25";
const cust = (customerId: string, name: string, status?: string, mccId = "2678500976") => ({ customerId, name, mccId, currency: "BRL", pixels: ["AW-1/a"], ...(status === undefined ? {} : { status }) });

test("ENABLED is the one word that may launch; anything else is dead as of the day read", () => {
  assert.equal(googleCustomerStatusVerdict("ENABLED", DAY), null);
  assert.equal(googleCustomerStatusVerdict("enabled ", DAY), null); // spelling is normalized
  assert.deepEqual(googleCustomerStatusVerdict("SUSPENDED", DAY), { status: "SUSPENDED", day: DAY });
  assert.deepEqual(googleCustomerStatusVerdict("canceled", DAY), { status: "CANCELED", day: DAY });
  assert.deepEqual(googleCustomerStatusVerdict("CLOSED", DAY), { status: "CLOSED", day: DAY });
  // "only ACTIVE accounts are shown": a word we do not know is not ENABLED → hidden, not guessed alive
  assert.deepEqual(googleCustomerStatusVerdict("UNKNOWN", DAY), { status: "UNKNOWN", day: DAY });
});

test("no status at all is not 'active': the account is hidden as NO_STATUS (never guessed alive)", () => {
  assert.deepEqual(googleCustomerStatusVerdict("", DAY), { status: "NO_STATUS", day: DAY });
  assert.deepEqual(googleCustomerStatusVerdict(undefined, DAY), { status: "NO_STATUS", day: DAY });
  assert.deepEqual(googleCustomerStatusVerdict(null, DAY), { status: "NO_STATUS", day: DAY });
  assert.deepEqual(googleCustomerStatusVerdict("   ", DAY), { status: "NO_STATUS", day: DAY });
});

test("the reason a refusal and the board's note print", () => {
  assert.equal(googleAccountDeadReason({ status: "SUSPENDED", day: "2026-09-25" }), "suspended on Google (LION saw it 25.09)");
  assert.equal(googleAccountDeadReason({ status: "CANCELED", day: "2026-10-02" }), "canceled on Google (LION saw it 02.10)");
  assert.equal(googleAccountDeadReason({ status: "NO_STATUS", day: "2026-09-25" }), "without a status on LION's list (25.09) — not known to be active");
  assert.equal(googleAccountDeadReason({ status: "UNKNOWN", day: "2026-09-25" }), "unknown on Google (LION saw it 25.09)"); // Google's own word stays its own
});

test("the catalog offers exactly the allowlisted accounts whose status is ENABLED; the rest of the allowlist is `suspended` with a reason", () => {
  const all = [cust("1633475800", "GLO-HS-004", "ENABLED"), cust("6586636091", "GLO-HS-012", "SUSPENDED"), cust("1891859142", "GLO-HS-016", "enabled"), cust("1843099770", "GLO-HS-017")];
  const cat = foldGoogleLaunchCatalog(all, DAY, isGoogleLaunchAccount);
  assert.deepEqual(cat.customers.map((c) => c.name), ["GLO-HS-004", "GLO-HS-016"]); // input order kept
  assert.deepEqual(cat.suspended, [
    { customerId: "6586636091", name: "GLO-HS-012", status: "SUSPENDED", day: DAY, reason: "suspended on Google (LION saw it 25.09)" },
    { customerId: "1843099770", name: "GLO-HS-017", status: "NO_STATUS", day: DAY, reason: "without a status on LION's list (25.09) — not known to be active" },
  ]);
  assert.deepEqual(cat.dead, cat.suspended);
});

test("the owner's allowlist still gates the pickers; every dead partner account is in `dead` for the routes, listed or not", () => {
  const all = [
    cust("8434519748", "GLO-HS-007", "SUSPENDED"), // parked by the owner AND suspended → dead, not "suspended" (never offered)
    cust("6713307003", "GLO-HS-002", "ENABLED"), // parked by the owner though ENABLED → not offered, not dead
    cust("1180779413", "Ads 13", "SUSPENDED", "4904785717"), // another MCC → dead only
    cust("1633475800", "GLO-HS-004", "ENABLED"),
  ];
  const cat = foldGoogleLaunchCatalog(all, DAY, isGoogleLaunchAccount);
  assert.deepEqual(cat.customers.map((c) => c.name), ["GLO-HS-004"]);
  assert.deepEqual(cat.suspended, []);
  assert.deepEqual(cat.dead.map((c) => c.name), ["GLO-HS-007", "Ads 13"]);
});

test("a list that came with no status on any row hides every allowlisted account (blank pickers with reasons, never a launch on a guess)", () => {
  const all = [cust("1633475800", "GLO-HS-004"), cust("1891859142", "GLO-HS-016")];
  const cat = foldGoogleLaunchCatalog(all, DAY, isGoogleLaunchAccount);
  assert.deepEqual(cat.customers, []);
  assert.deepEqual(cat.suspended.map((c) => [c.name, c.status]), [["GLO-HS-004", "NO_STATUS"], ["GLO-HS-016", "NO_STATUS"]]);
});
