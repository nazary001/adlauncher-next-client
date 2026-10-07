// Node's built-in runner (v24 strips types natively): `node --test tests/av-keys.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// AV rail — the key registry over `app_caches` rows (ckey "av-key:<key>", UNIQUE index → atomic
// claim): the REGISTERED range is the only launchable pool (0 = the stub: nothing claimable, no store
// call at all), and on a live gc_test store the claim walk (taken key → next, exhausted → throw),
// backfill and release — a registry failure is never swallowed.
import { HAVE_DB, closeDb, ensureTestIndexes, wipe } from "./_mongo.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";

const keys = await import("../lib/av-keys.ts");
const live = { skip: !HAVE_DB && "MONGODB_URI not set" };
const PREFIX = keys.AV_KEY_CKEY_PREFIX;

test("free / next walk ONLY the registered range, desired-or-next with wrap-around", () => {
  assert.deepEqual(keys.avFreeKeys([], 0), [], "registered 0 = the stub: nothing is free");
  assert.equal(keys.avNextKey([], 0), null);
  const used = ["av001", "av003"];
  const free = keys.avFreeKeys(used, 200);
  assert.equal(free.length, 198);
  assert.equal(free[0], "av002");
  assert.equal(free.at(-1), "av200");
  assert.equal(keys.avNextKey(used, 200), "av002");
  assert.equal(keys.avNextKey(used, 200, "av003"), "av004");
  assert.equal(keys.avNextKey(used, 200, "av150"), "av150");
  assert.equal(keys.avNextKey(used, 200, "av201"), "av002", "an unregistered desired key is ignored");
  assert.deepEqual(keys.avKeyCandidates(["av199"], 200, "av199").slice(0, 2), ["av200", "av001"]);
  assert.equal(keys.avFreeKeys([], 5000).length, 999, "the registered count is clamped to the codec range");
});

test("claim with nothing registered refuses BEFORE touching the store (no MONGODB_URI needed)", async () => {
  const saved = process.env.MONGODB_URI;
  delete process.env.MONGODB_URI; // a store call would throw "MONGODB_URI is not set" — it must not be reached
  try {
    await assert.rejects(keys.claimAvKey(undefined, 0, { user: "nazar" }), /av_keys_not_registered/);
  } finally {
    if (saved !== undefined) process.env.MONGODB_URI = saved;
  }
});

const clean = () => wipe("app_caches", { ckey: { $regex: `^${PREFIX}` } });

test("live: claim walks past a taken key and returns the next registered key; exhaustion throws by name", live, async () => {
  await ensureTestIndexes();
  await clean();
  try {
    const first = await keys.claimAvKey("av002", 200, { user: "nazar", via: "launch", destination: "https://thecadrion.com/x" });
    assert.equal(first.key, "av002");
    const second = await keys.claimAvKey("av002", 200, { user: "nazar", via: "clone" });
    assert.equal(second.key, "av003", "av002 is held (E11000) → the next registered key");
    const rows = await keys.listAvKeys();
    assert.deepEqual(rows.map((r) => [r.key, r.via]), [["av002", "launch"], ["av003", "clone"]]);
    assert.equal((await keys.findAvKey("av003"))?.documentId, second.documentId);
    await assert.rejects(keys.claimAvKey(undefined, 3, { user: "nazar" }).then(async (r) => {
      // av001 is free in a 3-key range → it is claimed; the 4th claim must then fail by name
      assert.equal(r.key, "av001");
      await keys.claimAvKey(undefined, 3, { user: "nazar" });
    }), /av key pool exhausted — every registered key av001…av003/);
  } finally {
    await clean();
  }
});

test("live: backfill merges into the found row; release/backfill failures throw", live, async () => {
  await ensureTestIndexes();
  await clean();
  try {
    const claim = await keys.claimAvKey("av005", 200, { user: "nazar", name: "n" });
    await keys.backfillAvKey("av005", { campaign_id: "c1", status: "retired" });
    const row = await keys.findAvKey("av005");
    assert.deepEqual([row?.key, row?.campaign_id, row?.status, row?.name, row?.user], ["av005", "c1", "retired", "n", "nazar"]);
    await assert.rejects(keys.backfillAvKey("av006", { campaign_id: "x" }), /no registry row for av006/);
    assert.equal(await keys.releaseAvKeyByKey("av006"), false);
    await keys.releaseAvKey(claim.documentId);
    await assert.rejects(keys.releaseAvKey(claim.documentId), /av key release failed \(not found\)/);
    assert.equal(await keys.findAvKey("av005"), null);
  } finally {
    await clean();
  }
});

after(async () => {
  await closeDb();
});
