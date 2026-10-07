// Node's built-in runner (v24 strips types natively): `node --test tests/snap-keys.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// Snapchat rail — the key registry over `app_caches` rows (ckey "snap-key:<key>", UNIQUE index → an
// atomic claim): free/next computation (pure), and on a live gc_test store the claim walk (taken key
// → next candidate, pool exhausted → throw without an insert), backfill and release — and the rule
// that a registry failure is never swallowed (release of a missing row / backfill without a row throw).
import { HAVE_DB, closeDb, ensureTestIndexes, wipe } from "./_mongo.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";

const keys = await import("../lib/snap-keys.ts");
const live = { skip: !HAVE_DB && "MONGODB_URI not set" };
const PREFIX = keys.SNAP_KEY_CKEY_PREFIX;

test("free / next: the pool minus the used keys, desired-or-next with wrap-around", () => {
  assert.equal(keys.SNAP_KEY_POOL_SIZE, 500); // 500 since 23.09 (100 before)
  assert.equal(keys.snapFreeKeys([]).length, keys.SNAP_KEY_POOL_SIZE, "the reported pool size is the size the arithmetic walks");
  const used = ["glo-snp_001", "glo-snp_003"];
  const free = keys.snapFreeKeys(used);
  assert.equal(free.length, 498);
  assert.equal(free.at(-1), "glo-snp_500");
  assert.equal(free[0], "glo-snp_002");
  assert.equal(keys.snapNextKey(used), "glo-snp_002");
  assert.equal(keys.snapNextKey(used, "glo-snp_003"), "glo-snp_004");
  assert.equal(keys.snapNextKey(used, "glo-snp_050"), "glo-snp_050");
  assert.equal(keys.snapNextKey(used, "glo-snp_100"), "glo-snp_100");
  assert.equal(keys.snapNextKey(used, "glo-snp_500"), "glo-snp_500");
  assert.equal(keys.snapNextKey(used, "glo-snp_501"), "glo-snp_002", "outside the pool = no desired key → the first free one");
  assert.equal(keys.snapNextKey(keys.snapFreeKeys([]), "glo-snp_100"), null);
  assert.deepEqual(keys.snapKeyCandidates(["glo-snp_099"], "glo-snp_099").slice(0, 2), ["glo-snp_100", "glo-snp_101"]);
  assert.deepEqual(keys.snapKeyCandidates(["glo-snp_499"], "glo-snp_499").slice(0, 2), ["glo-snp_500", "glo-snp_001"]);
});

const clean = () => wipe("app_caches", { ckey: { $regex: `^${PREFIX}` } });

test("live: list maps rows in key order; a claim on a taken key walks to the next; the binding is what the row holds", live, async () => {
  await ensureTestIndexes();
  await clean();
  try {
    const first = await keys.claimSnapKey("glo-snp_002", { user: "nazar", niche: "Cars" });
    assert.equal(first.key, "glo-snp_002");
    assert.match(first.documentId, /^[a-z0-9]{24}$/);
    const second = await keys.claimSnapKey("glo-snp_002", { user: "tima", task_id: "snc-1" });
    assert.equal(second.key, "glo-snp_003", "glo-snp_002 is held (E11000) → the next free key");
    assert.deepEqual([second.binding.key, second.binding.status, second.binding.user, second.binding.task_id], ["glo-snp_003", "active", "tima", "snc-1"]);
    assert.equal(typeof second.binding.claimed_at, "number");
    const rows = await keys.listSnapKeys();
    assert.deepEqual(
      rows.map((x) => [x.key, x.status, x.user, x.niche ?? null]),
      [["glo-snp_002", "active", "nazar", "Cars"], ["glo-snp_003", "active", "tima", null]],
    );
    assert.equal((await keys.findSnapKey("glo-snp_003"))?.documentId, second.documentId);
    assert.equal(await keys.findSnapKey("glo-snp_004"), null);
    // The row itself carries the Strapi envelope the other readers expect.
    const { col } = await import("./_mongo.ts");
    const raw = await (await col("app_caches")).findOne({ ckey: `${PREFIX}glo-snp_003` });
    assert.equal(typeof raw?.id, "number");
    assert.ok(raw?.createdAt instanceof Date && raw?.updatedAt instanceof Date);
    assert.equal(typeof raw?.refreshed_at, "number");
  } finally {
    await clean();
  }
});

test("live: every key used → pool exhausted without a single insert", live, async () => {
  await ensureTestIndexes();
  await clean();
  const { col } = await import("./_mongo.ts");
  const c = await col("app_caches");
  const { newDocumentId } = await import("../lib/mongo.ts");
  const now = new Date();
  try {
    await c.insertMany(
      Array.from({ length: keys.SNAP_KEY_POOL_SIZE }, (_, i) => {
        const key = `glo-snp_${String(i + 1).padStart(3, "0")}`;
        return { id: 9_000_000 + i, documentId: newDocumentId(), ckey: `${PREFIX}${key}`, cvalue: { key, status: "active", user: "x", claimed_at: 1 }, refreshed_at: 1, createdAt: now, updatedAt: now, publishedAt: now };
      }),
    );
    const before = await c.countDocuments({ ckey: { $regex: `^${PREFIX}` } });
    await assert.rejects(keys.claimSnapKey(undefined, { user: "nazar" }), /pool exhausted/);
    assert.equal(await c.countDocuments({ ckey: { $regex: `^${PREFIX}` } }), before, "nothing was inserted");
    assert.equal((await keys.listSnapKeys()).length, keys.SNAP_KEY_POOL_SIZE, "the list reads the WHOLE pool (the old 2-page cap hid keys 201+)");
  } finally {
    await clean();
  }
});

test("live: backfill merges into the row's cvalue (ckey untouched); release deletes; failures are never swallowed", live, async () => {
  await ensureTestIndexes();
  await clean();
  try {
    const claim = await keys.claimSnapKey("glo-snp_005", { user: "nazar", niche: "Cars" });
    await keys.backfillSnapKey("glo-snp_005", { status: "retired", campaign_id: "cmp-9", notes: "refused at adsquad" });
    const row = await keys.findSnapKey("glo-snp_005");
    assert.deepEqual(
      { ...row, documentId: undefined, claimed_at: undefined },
      { key: "glo-snp_005", status: "retired", user: "nazar", niche: "Cars", campaign_id: "cmp-9", notes: "refused at adsquad", documentId: undefined, claimed_at: undefined },
    );
    // A backfill given the claim updates by id (no find by key — the 22.09 read-lag case).
    await keys.backfillSnapKey("glo-snp_005", { ad_count: 2 }, claim);
    assert.equal((await keys.findSnapKey("glo-snp_005"))?.ad_count, 2);
    assert.equal((await keys.findSnapKey("glo-snp_005"))?.user, "nazar", "the claim's binding is kept");
    // No row to merge into → the campaign would run on a key the registry thinks is free: an error.
    await assert.rejects(keys.backfillSnapKey("glo-snp_077", { status: "retired" }), /backfill failed: no registry row for glo-snp_077/);
    // Release: by id, then by key (false ONLY when no row exists); a missing row is an error, not "released".
    await keys.releaseSnapKey(claim.documentId);
    assert.equal(await keys.findSnapKey("glo-snp_005"), null);
    await assert.rejects(keys.releaseSnapKey(claim.documentId), /release failed \(not found\)/);
    assert.equal(await keys.releaseSnapKeyByKey("glo-snp_005"), false);
    const again = await keys.claimSnapKey("glo-snp_005", { user: "nazar" });
    assert.equal(again.key, "glo-snp_005", "a released key is free again");
    assert.equal(await keys.releaseSnapKeyByKey("glo-snp_005"), true);
  } finally {
    await clean();
  }
});

after(async () => {
  await closeDb();
});
