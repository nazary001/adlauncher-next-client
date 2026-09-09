// Node's built-in runner: `node --test tests/graph-retry.test.ts`.
// Which Graph failures of the post-birth campaign rename deserve another poll tick (the ad set /
// campaign still being born, throttling) and which are final (permission walls, an account no
// bearer sees) — the pump must not spin on the latter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isTransientGraphError } from "../lib/graph-retry.ts";

test("throttles, temporary failures and not-born-yet answers are transient", () => {
  for (const m of [
    "adset_not_born_yet",
    "(#4) Application request limit reached",
    "(#17) User request limit reached",
    "(#32) Page request limit reached",
    "(#613) Calls to this api have exceeded the rate limit",
    "An unknown error occurred (code 1)",
    "Service temporarily unavailable — please try again later",
    "error_subcode 80004 throttled",
  ]) assert.equal(isTransientGraphError(m), true, m);
});

test("permission walls, business restrictions and missing bearers are final", () => {
  for (const m of [
    "(#10) Application does not have permission for this action",
    "(#200) Permissions error",
    "Unsupported post request. Object with ID does not exist",
    "no bearer can see act_123",
    "(#100) Invalid parameter",
    "",
  ]) assert.equal(isTransientGraphError(m), false, m || "(empty)");
});
