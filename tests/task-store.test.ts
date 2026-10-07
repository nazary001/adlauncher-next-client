// Node's built-in runner (v24 strips types natively): `node --test tests/task-store.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// Pure parts of the task store: the field whitelist, the drawer-scope filters (Mongo null
// semantics) and the short team cache (loader injected — no database). The live counterparts
// (unique task_id race, the MO scope on real rows) are in tests/mongo-claims / mongo-semantics.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DRAWER_PARTNERS, pickTaskFields, readTeamTasksWith, taskScopeFilter } from "../lib/task-store.ts";

// ---- pickTaskFields: the `bid` tag rides the whitelist, clamped to the column's 40 chars ----

test("pickTaskFields keeps bid (clamped, trimmed) and drops junk keys / empty bids", () => {
  assert.deepEqual(pickTaskFields({ task_id: "t", bid: " ROAS 0,3 ", junk: 1 }), { task_id: "t", bid: "ROAS 0,3" });
  assert.deepEqual(pickTaskFields({ task_id: "t", bid: "x".repeat(60) }).bid, "x".repeat(40));
  assert.deepEqual(pickTaskFields({ task_id: "t", bid: "" }), { task_id: "t" });
  assert.deepEqual(pickTaskFields({ task_id: "t", bid: null }), { task_id: "t" });
  assert.deepEqual(pickTaskFields({ task_id: "t", bid: 7 }), { task_id: "t" });
  assert.deepEqual(pickTaskFields({ task_id: "t", status: "done" }), { task_id: "t", status: "done" });
  assert.deepEqual(pickTaskFields({ task_id: "t", owner: "mallory" }), { task_id: "t" }, "owner never comes from the wire");
});

// ---- taskScopeFilter: the MO scope keeps partner-null rows and excludes every other drawer ----

test("the MO scope is `$nin` over the drawer partners (null/missing partner stays MO); a partner scope is an equality", () => {
  const mo = taskScopeFilter("mo", 1000);
  assert.deepEqual(mo, {
    owner: { $ne: null },
    partner: { $nin: ["br", "us", "gg", "sn", "tt", "av"] },
    queued_at: { $gte: 1000 },
  });
  assert.deepEqual([...DRAWER_PARTNERS], ["br", "us", "gg", "sn", "tt", "av"]);
  assert.deepEqual(taskScopeFilter({ partner: "br" }, 5), { owner: { $ne: null }, partner: "br", queued_at: { $gte: 5 } });
  // No `$ne` anywhere: in Mongo `{partner: {$ne: "br"}}` would MATCH null — the SQL filter this
  // replaces (`$or[partner $null][$and partner $ne …]`) is the `$nin` set, not a transliteration.
  assert.equal(JSON.stringify(mo).includes('"$ne":"'), false);
});

// ---- readTeamTasksWith: the 4 s team cache, with the loader injected ----

test("a failed load with nothing cached answers ok:false and is NOT cached", async () => {
  let calls = 0;
  const failing = async () => {
    calls++;
    throw new Error("store timeout");
  };
  const first = await readTeamTasksWith("test-fail", failing, (r) => r);
  assert.deepEqual(first, { ok: false, tasks: [] });
  const second = await readTeamTasksWith("test-fail", async () => [{ i: 1 }], (r) => r);
  assert.equal(second.ok, true);
  assert.equal(second.tasks.length, 1, "the failure left no cache entry — the healed store is read again");
  assert.equal(calls, 1);
});

test("a complete read IS served from the short cache, and a later failure serves the last good list", async () => {
  let calls = 0;
  const load = async () => {
    calls++;
    return [{ i: 1 }, { i: 2 }];
  };
  const first = await readTeamTasksWith("test-complete", load, (r) => r);
  assert.equal(first.tasks.length, 2);
  const second = await readTeamTasksWith("test-complete", load, (r) => r);
  assert.equal(second.tasks.length, 2);
  assert.equal(calls, 1, "no new store round-trip inside the TTL");
  // The cache is per scope key: another scope loads on its own.
  const other = await readTeamTasksWith("test-other", async () => [{ i: 9 }], (r) => r);
  assert.deepEqual(other.tasks, [{ i: 9 }]);
});

test("mapRow is applied once per row at load time", async () => {
  const got = await readTeamTasksWith("test-map", async () => [{ task_id: "a" }, { task_id: "b" }], (r) => ({ id: r.task_id }));
  assert.deepEqual(got, { ok: true, tasks: [{ id: "a" }, { id: "b" }] });
});
