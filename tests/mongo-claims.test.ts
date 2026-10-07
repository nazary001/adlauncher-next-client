// Node's built-in runner: `node --test tests/mongo-claims.test.ts` (needs MONGODB_URI; runs on gc_test).
// Every atomic-claim path the launcher relies on, exercised on a live store with the real unique
// indexes: app_caches.ckey (wave claims / KV), the per-account slot limiter (fail CLOSED without a
// store), gcm_maps.gcm (+ the binding ledger), aif_maps.brand, launch_tasks.task_id (the create race),
// and the counter self-heal behind every insert.
import { HAVE_DB, RUN, closeDb, col, ensureTestIndexes, wipe } from "./_mongo.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

const live = { skip: !HAVE_DB && "MONGODB_URI not set" };

before(async () => {
  if (HAVE_DB) await ensureTestIndexes();
});

// ---- fail CLOSED without a store: no MONGODB_URI needed, so this one always runs ----

test("acct-limit refuses the launch (acct_limit_unavailable) when the store is not configured", async () => {
  const saved = process.env.MONGODB_URI;
  delete process.env.MONGODB_URI;
  try {
    const { claimAcctSlot, acctLimitSnapshot } = await import("../lib/acct-limit.ts");
    await assert.rejects(claimAcctSlot("act_123456789", { user: "nazar" }), /acct_limit_unavailable/);
    await assert.rejects(acctLimitSnapshot(), /acct_limit_unavailable/);
    const { upsertTaskRow } = await import("../lib/task-store.ts");
    assert.deepEqual(await upsertTaskRow("nazar", `t-${RUN}`, {}), { ok: false, reason: "not_configured" });
    const { writeAppCache, readAppCacheDetailed } = await import("../lib/app-cache.ts");
    assert.equal(await writeAppCache(`k-${RUN}`, { a: 1 }), null);
    assert.deepEqual(await readAppCacheDetailed(`k-${RUN}`), { ok: false, row: null });
  } finally {
    if (saved !== undefined) process.env.MONGODB_URI = saved;
  }
});

// ---- app_caches: the generic KV + the wave-claim primitive ----

test("live: app-cache insert claims the unique ckey; a second insert loses (null) and the first row stays the one winner; updates ride the documentId", live, async () => {
  const cache = await import("../lib/app-cache.ts");
  const key = `hs-wave:${RUN}`;
  await wipe("app_caches", { ckey: key });
  try {
    const won = await cache.writeAppCache(key, { at: 1, n: 3 });
    assert.match(String(won), /^[a-z0-9]{24}$/);
    const lost = await cache.writeAppCache(key, { at: 2, n: 3 });
    assert.equal(lost, null, "E11000 on ckey = someone else holds the claim");
    const all = await cache.readAppCacheAll<{ at: number }>(key);
    assert.equal(all.ok, true);
    assert.deepEqual(all.rows.map((r) => [r.documentId, r.value?.at]), [[won, 1]]);
    const read = await cache.readAppCacheDetailed<{ at: number }>(key);
    assert.deepEqual([read.ok, read.row?.documentId, read.row?.value?.at], [true, won, 1]);
    assert.ok((read.row?.refreshedAt ?? 0) > 0);
    // Update by documentId: value + refreshed_at + updatedAt move, ckey does not.
    const upd = await cache.writeAppCache(key, { at: 5, n: 3 }, won);
    assert.equal(upd, won);
    assert.equal((await cache.readAppCache<{ at: number }>(key))?.value?.at, 5);
    const raw = await (await col("app_caches")).findOne({ ckey: key });
    assert.ok(raw && raw.updatedAt > raw.createdAt);
    // A vanished row (bogus documentId) → null, never a fall-through insert.
    assert.equal(await cache.writeAppCache(key, { at: 6 }, "000000000000000000000000"), null);
    assert.equal(await (await col("app_caches")).countDocuments({ ckey: key }), 1);
    // "no row yet" is distinguishable from "store down".
    assert.deepEqual(await cache.readAppCacheDetailed(`${key}-none`), { ok: true, row: null });
  } finally {
    await wipe("app_caches", { ckey: key });
  }
});

// ---- per-account launch slots ----

test("live: five slots per account window, the sixth claim is refused with the countdown; a released slot frees up; the snapshot counts", live, async () => {
  const lim = await import("../lib/acct-limit.ts");
  const account = `9${String(Date.now()).slice(-9)}${Math.floor(Math.random() * 90 + 10)}`; // 12 digits, unique per run
  const prefixes = { $regex: `^acct-(window|slot):${account}` };
  await wipe("app_caches", { ckey: prefixes });
  try {
    const counts: number[] = [];
    const docs: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await lim.claimAcctSlot(`act_${account}`, { user: "nazar", partner: "in", accountName: `Acct ${RUN}` });
      counts.push(r.count);
      docs.push(r.documentId);
    }
    assert.deepEqual(counts, [1, 2, 3, 4, 5]);
    await assert.rejects(lim.claimAcctSlot(account, { user: "tima" }), (e: unknown) => {
      assert.ok(e instanceof lim.AcctLimitedError);
      assert.equal(e.accountId, account);
      assert.match(e.message, /Account limit: 5 campaigns \/ 30 min — resets in \d+:\d\d/);
      return true;
    });
    const snap = await lim.acctLimitSnapshot();
    assert.equal(snap.accounts[account]?.count, 5);
    assert.equal(snap.accounts[account]?.name, `Acct ${RUN}`);
    await lim.releaseAcctSlot(docs[2]);
    const again = await lim.claimAcctSlot(account, { user: "tima" });
    assert.equal(again.count, 3, "the released slot number is claimed again");
    await lim.releaseAcctSlot(null); // no-op
  } finally {
    await wipe("app_caches", { ckey: prefixes });
  }
});

// ---- gcm_maps + the binding ledger ----

test("live: gcm claim takes the desired code, the next claim of the same code walks on (E11000); ledger epoch opened/patched/dropped; schema shape kept", live, async () => {
  const gcm = await import("../lib/gcm-claim.ts");
  await wipe("gcm_maps", {});
  await wipe("gcm_binding_logs", {});
  try {
    const a = await gcm.claimGcm("07", { campaign_name: `cmp ${RUN}`, landing: "hotel-jobs", notes: "n", not_a_column: "dropped" });
    assert.equal(a.gcm, "07");
    const b = await gcm.claimGcm("07", { campaign_name: `cmp2 ${RUN}` });
    assert.equal(b.gcm, "08", "07 is held → the next free code");
    const c = await gcm.claimGcm("200", {});
    assert.equal(c.gcm, "200");
    const d = await gcm.claimGcm("200", {});
    assert.equal(d.gcm, "01", "wraps around from the pool's end");
    assert.deepEqual((await gcm.fetchUsedGcms()).sort(), ["01", "07", "08", "200"]);

    const maps = await col("gcm_maps");
    const row = await maps.findOne({ gcm: "07" });
    assert.ok(row);
    assert.deepEqual(Object.keys(row).filter((k) => k !== "_id").sort(), ["ad_id", "ad_ids", "adset_id", "bound_at", "campaign_id", "campaign_name", "createdAt", "documentId", "gcm", "history", "id", "landing", "notes", "platform", "publishedAt", "status", "updatedAt"].sort());
    assert.ok(row.bound_at instanceof Date, "datetime column is a BSON Date");
    assert.equal(row.not_a_column, undefined, "unknown attributes are not persisted (Strapi 400'd them)");
    assert.deepEqual([row.platform, row.status, row.campaign_name, row.landing], ["facebook", "active", `cmp ${RUN}`, "hotel-jobs"]);

    const logs = await col("gcm_binding_logs");
    const epoch = await logs.findOne({ gcm: "07" });
    assert.ok(epoch);
    assert.deepEqual([epoch.reason, epoch.released_at, epoch.campaign_name, epoch.landing], ["claim", null, `cmp ${RUN}`, "hotel-jobs"]);
    assert.ok(epoch.bound_at instanceof Date);
    assert.equal("campaign_id" in epoch && "adset_id" in epoch && "ad_id" in epoch && "notes" in epoch, true, "the ledger row has every attribute");

    await gcm.backfillGcm(a.documentId, { campaign_id: "52600000000001", status: "retired", notes: "launch failed", bogus: 1 }, "07");
    const after1 = await maps.findOne({ gcm: "07" });
    assert.deepEqual([after1?.campaign_id, after1?.status, after1?.notes, after1?.bogus], ["52600000000001", "retired", "launch failed", undefined]);
    const epoch1 = await logs.findOne({ gcm: "07", released_at: null });
    assert.deepEqual([epoch1?.campaign_id, epoch1?.notes, epoch1?.status], ["52600000000001", "launch failed", undefined], "the ledger mirrors binding facts, never the registry-only status");

    await gcm.deleteGcm(b.documentId as string, "08");
    assert.equal(await maps.countDocuments({ gcm: "08" }), 0);
    assert.equal(await logs.countDocuments({ gcm: "08" }), 0, "the never-carried-traffic epoch is dropped");
    assert.equal(await logs.countDocuments({ gcm: "07" }), 1);
  } finally {
    await wipe("gcm_maps", {});
    await wipe("gcm_binding_logs", {});
  }
});

// ---- aif_maps ----

test("live: brand claim takes the desired brand, the next claim walks on (E11000); backfill/delete", live, async () => {
  const aif = await import("../lib/aif-claim.ts");
  await wipe("aif_maps", {});
  try {
    const a = await aif.claimBrand("test01", { campaign_name: `aif ${RUN}`, destination: "best-family-pets" });
    assert.equal(a.brand, "test01");
    const b = await aif.claimBrand("TEST01", {});
    assert.equal(b.brand, "test02");
    const c = await aif.claimBrand("test700", {});
    assert.equal(c.brand, "test700");
    assert.deepEqual((await aif.fetchUsedBrands()).sort(), ["test01", "test02", "test700"]);
    await aif.backfillBrand(a.documentId, { campaign_id: "120250245045430468", adset_id: "1", ad_id: "2" });
    const maps = await col("aif_maps");
    const row = await maps.findOne({ brand: "test01" });
    assert.deepEqual([row?.campaign_id, row?.adset_id, row?.ad_id, row?.destination, row?.platform, row?.status], ["120250245045430468", "1", "2", "best-family-pets", "facebook", "active"]);
    assert.ok(row?.bound_at instanceof Date);
    await aif.deleteBrand(b.documentId as string);
    assert.equal(await maps.countDocuments({ brand: "test02" }), 0);
  } finally {
    await wipe("aif_maps", {});
  }
});

// ---- launch_tasks: the create race on task_id, ownership, typing ----

test("live: concurrent upserts of one task_id end with ONE row (the loser retries as an update); foreign updates are forbidden; biginteger columns are Numbers", live, async () => {
  const ts = await import("../lib/task-store.ts");
  const taskId = `race-${RUN}`;
  await wipe("launch_tasks", { task_id: { $regex: `-${RUN}$` } });
  try {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => ts.upsertTaskRow("nazar", taskId, { name: `w${i}`, status: "running", stage: "s", queued_at: "1786002783326", partner: "in" })),
    );
    assert.deepEqual(results, Array.from({ length: 6 }, () => ({ ok: true })));
    const c = await col("launch_tasks");
    assert.equal(await c.countDocuments({ task_id: taskId }), 1);
    const row = await c.findOne({ task_id: taskId });
    assert.equal(row?.owner, "nazar");
    assert.equal(typeof row?.queued_at, "number", "a numeric string from an older client is stored as a Number");
    assert.equal(row?.queued_at, 1786002783326);
    assert.equal(row?.status, "running");
    assert.equal(typeof row?.id, "number");
    assert.ok(row?.createdAt instanceof Date && row?.updatedAt instanceof Date && row?.publishedAt instanceof Date);
    // Every schema attribute is present on a fresh row (other readers index the keys directly).
    for (const k of ["gcm", "geo", "budget", "campaign_id", "adset_id", "ad_id", "bid", "link", "error", "started_at", "finished_at"]) assert.ok(k in row!, `${k} present`);

    assert.deepEqual(await ts.upsertTaskRow("mallory", taskId, { status: "done" }), { ok: false, reason: "forbidden" });
    assert.equal((await ts.findTaskRow(taskId))?.status, "running", "the foreign write did not land");
    assert.deepEqual(await ts.findTaskRow(`absent-${RUN}`, true), null, "strict mode: a confirmed absence is null, not a throw");

    const found = await ts.findTaskRow(taskId);
    assert.ok(found);
    assert.equal(await ts.deleteTaskRow(found.documentId), true);
    assert.equal(await ts.deleteTaskRow(found.documentId), false);
    assert.equal(await ts.findTaskRow(taskId), null);
  } finally {
    await wipe("launch_tasks", { task_id: { $regex: `-${RUN}$` } });
  }
});

// ---- the envelope: counters heal themselves after a delta sync pushed ids past the seed ----

test("live: insertFresh re-syncs the counter when a document already holds the next id (no false claim loss)", live, async () => {
  const { insertFresh } = await import("../lib/store.ts");
  const name = "mo_landing_jobs";
  const marker = { batch_id: RUN };
  await wipe(name, marker);
  const counters = (await col("counters")) as unknown as import("mongodb").Collection<{ _id: string; seq: number }>;
  try {
    const c = await col(name);
    const top = (await c.find({}, { projection: { id: 1 }, sort: { id: -1 }, limit: 1 }).toArray())[0]?.id ?? 0;
    const max = Number(top) + 10;
    // A delta-synced row with an id above the counter…
    await c.insertOne({ id: max, documentId: `x${RUN}`.padEnd(24, "0").slice(0, 24), title: "synced", ...marker, createdAt: new Date(), updatedAt: new Date() });
    await counters.updateOne({ _id: name }, { $set: { seq: max - 1 } }, { upsert: true });
    // …then the next app insert would have collided on id → it heals and lands above.
    const doc = await insertFresh(name, { title: "fresh", ...marker });
    assert.ok(doc.id > max, `fresh id ${doc.id} is above the synced ${max}`);
    assert.equal(await c.countDocuments(marker), 2);
  } finally {
    await wipe(name, marker);
  }
});

after(async () => {
  await closeDb();
});
