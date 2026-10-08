// Node's built-in runner (v24 strips types natively): `node --test tests/task-view.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CANCELED_STAGE, STALE_MS, effStatusOf, fromRemote, isCanceled } from "../lib/task-view.ts";

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

// ---- srv / retry flags: the row columns the launch queue stamps reach the card model ----

test("fromRemote maps srv / retry 1 → true and their absence → undefined", () => {
  const on = fromRemote({ task_id: "f1", name: "x", status: "error", srv: 1, retry: 1, queued_at: "1" });
  assert.equal(on.srv, true);
  assert.equal(on.retry, true);
  const off = fromRemote({ task_id: "f2", name: "x", status: "error", queued_at: "1" });
  assert.equal(off.srv, undefined);
  assert.equal(off.retry, undefined);
  // JSON may carry the flag as "1" or true, not only the numeric 1 the store writes.
  const asStr = fromRemote({ task_id: "f3", name: "x", status: "queued", srv: "1", retry: true, queued_at: "1" });
  assert.equal(asStr.srv, true);
  assert.equal(asStr.retry, true);
});

// ---- effStatusOf: a server-owned (srv) row is never called stale, even with a silent owner ----

test("effStatusOf never marks an srv row stale (the server reaps its own dead jobs)", () => {
  const row = fromRemote({ task_id: "s1", name: "x", status: "running", srv: 1, owner: "ann", queued_at: "1" });
  assert.equal(row.srv, true);
  // Empty liveness map + a clock far past STALE_MS: a non-srv row would be stale; this one stays running.
  assert.equal(effStatusOf(row, new Map(), Date.now() + 10 * STALE_MS), "running");
  const queued = fromRemote({ task_id: "s2", name: "x", status: "queued", srv: 1, owner: "ann", queued_at: "1" });
  assert.equal(effStatusOf(queued, new Map(), Date.now() + 10 * STALE_MS), "queued");
});

test("effStatusOf still marks a non-srv running row stale when its owner is silent (unchanged)", () => {
  const row = fromRemote({ task_id: "n1", name: "x", status: "running", owner: "ann", queued_at: "1" });
  assert.equal(row.srv, undefined);
  assert.equal(effStatusOf(row, new Map(), Date.now()), "stale");
  // A live owner write inside the window keeps it running.
  assert.equal(effStatusOf(row, new Map([["ann", Date.now()]]), Date.now()), "running");
});

// ---- isCanceled: the server's "canceled before it started" row ----

test("isCanceled detects status error + stage canceled, and nothing else", () => {
  const c = fromRemote({ task_id: "c1", name: "x", status: "error", stage: CANCELED_STAGE, retry: 1, queued_at: "1" });
  assert.equal(isCanceled(c), true);
  assert.equal(c.retry, true); // canceled rows stay retryable
  assert.equal(isCanceled(fromRemote({ task_id: "c2", name: "x", status: "error", stage: "ad", queued_at: "1" })), false);
  assert.equal(isCanceled(fromRemote({ task_id: "c3", name: "x", status: "queued", stage: CANCELED_STAGE, queued_at: "1" })), false);
});
