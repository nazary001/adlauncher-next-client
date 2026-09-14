// Node's built-in runner (v24 strips types natively): `node --test tests/task-view.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fromRemote } from "../lib/task-view.ts";

// ---- fromRemote: the store's `bid` column reaches the card model (and its absence stays absent) ----

test("fromRemote carries the bid tag of a restored row", () => {
  const t = fromRemote({
    task_id: "t1",
    name: "[14.09] (MO) - some launch",
    partner: "in",
    gcm: "12",
    geo: "US",
    budget: "50",
    bid: "ROAS 0,3",
    status: "done",
    queued_at: "1789350000000",
  });
  assert.equal(t.bid, "ROAS 0,3");
  assert.equal(t.budget, "50");
  assert.equal(t.kind, "launch");
});

test("fromRemote leaves bid undefined for pre-column rows (null / empty / missing)", () => {
  for (const bid of [null, "", undefined]) {
    const t = fromRemote({ task_id: "t2", name: "[14.09] (CLONE) - x", status: "queued", queued_at: "1", ...(bid === undefined ? {} : { bid }) });
    assert.equal(t.bid, undefined, `bid=${String(bid)}`);
    assert.equal(t.kind, "clone");
  }
});
