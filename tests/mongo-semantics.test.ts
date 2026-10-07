// Node's built-in runner: `node --test tests/mongo-semantics.test.ts` (needs MONGODB_URI; runs on gc_test).
// The Task Manager's drawer scopes on REAL rows — the `$ne`/NULL re-derivation of CONVENTIONS §3.2:
// under Strapi/SQL the MO drawer needed `$or[partner IS NULL][partner <> br AND <> us …]` because `<>`
// drops NULLs; here `$nin` keeps null AND missing partners while excluding the other drawers'. Also the
// 7-day window on the biginteger column and the newest-first order the drawers render.
import { HAVE_DB, RUN, closeDb, col, ensureTestIndexes, wipe } from "./_mongo.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";

const live = { skip: !HAVE_DB && "MONGODB_URI not set" };

test("live: the MO scope keeps partner null/missing rows, drops every other drawer's partner; partner scopes are exact; owner-less rows never show; the window is numeric", live, async () => {
  await ensureTestIndexes();
  const ts = await import("../lib/task-store.ts");
  const { newDocumentId } = await import("../lib/mongo.ts");
  const c = await col("launch_tasks");
  const marker = { geo: RUN };
  await wipe("launch_tasks", marker);
  const now = Date.now();
  const mk = (i: number, extra: Record<string, unknown>) => ({
    id: 8_000_000 + i,
    documentId: newDocumentId(),
    task_id: `sem-${RUN}-${i}`,
    owner: "nazar",
    name: `row ${i}`,
    queued_at: now - i * 1000,
    status: "done",
    createdAt: new Date(),
    updatedAt: new Date(),
    publishedAt: new Date(),
    ...marker,
    ...extra,
  });
  try {
    await c.insertMany([
      mk(1, { partner: null }), // MO: historic null stamp
      mk(2, {}), // MO: partner field MISSING entirely
      mk(3, { partner: "in" }), // MO: Indians
      mk(4, { partner: "" }), // MO: empty string (SQL '' <> 'br' is true)
      mk(5, { partner: "br" }), // HS
      mk(6, { partner: "us" }), // AIF
      mk(7, { partner: "gg" }), // Google
      mk(8, { partner: "sn" }), // Snap
      mk(9, { partner: "tt" }), // TikTok
      mk(10, { partner: "av" }), // AV
      mk(11, { partner: "in", owner: null }), // never shown: no owner
      mk(12, { partner: "in", owner: undefined }), // never shown: owner missing
      mk(13, { partner: "in", queued_at: now - 8 * 24 * 3_600_000 }), // outside the 7-day window
      mk(14, { partner: "in", queued_at: String(now) }), // a string timestamp never matches a numeric window (typing rule)
    ]);
    const cutoff = now - 7 * 24 * 3_600_000;
    const names = async (filter: Record<string, unknown>) =>
      (await c.find({ ...filter, ...marker }).sort({ queued_at: -1, id: -1 }).toArray()).map((r) => r.name);

    assert.deepEqual(await names(ts.taskScopeFilter("mo", cutoff)), ["row 1", "row 2", "row 3", "row 4"]);
    assert.deepEqual(await names(ts.taskScopeFilter({ partner: "br" }, cutoff)), ["row 5"]);
    assert.deepEqual(await names(ts.taskScopeFilter({ partner: "us" }, cutoff)), ["row 6"]);
    assert.deepEqual(await names(ts.taskScopeFilter({ partner: "av" }, cutoff)), ["row 10"]);
    // The transliteration this replaces would have been WRONG in Mongo: `$ne` matches null.
    const wrong = await c.find({ partner: { $ne: "br" }, ...marker }).toArray();
    assert.ok(wrong.some((r) => r.partner === null), "Mongo's $ne DOES match null (why the filter is re-derived, not copied)");

    // readTeamTasks end to end: newest queued first, mapped rows, dates as ISO strings for updated_ms.
    const got = await ts.readTeamTasks(`sem-${RUN}`, { ...ts.taskScopeFilter("mo", cutoff), ...marker }, (r) => ({ name: r.name, updatedAt: r.updatedAt, q: r.queued_at }), { limit: 300 });
    assert.equal(got.ok, true);
    assert.deepEqual(got.tasks.map((t) => t.name), ["row 1", "row 2", "row 3", "row 4"]);
    assert.equal(typeof got.tasks[0].updatedAt, "string", "BSON dates reach the mappers as ISO strings (updated_ms = Date.parse)");
    assert.ok(Number.isFinite(Date.parse(String(got.tasks[0].updatedAt))));
    assert.equal(typeof got.tasks[0].q, "number");
    const limited = await ts.readTeamTasks(`sem-${RUN}-lim`, { ...ts.taskScopeFilter("mo", cutoff), ...marker }, (r) => r.name, { limit: 2 });
    assert.deepEqual(limited.tasks, ["row 1", "row 2"], "the limit is the old pages × pageSize window");
  } finally {
    await wipe("launch_tasks", marker);
  }
});

test("live: the ledger's open-epoch lookup treats a missing released_at like null (SQL IS NULL)", live, async () => {
  await ensureTestIndexes();
  const { newDocumentId } = await import("../lib/mongo.ts");
  const c = await col("gcm_binding_logs");
  const marker = { notes: RUN };
  await wipe("gcm_binding_logs", marker);
  const now = new Date();
  try {
    await c.insertMany([
      { id: 8_100_001, documentId: newDocumentId(), gcm: `g${RUN}`, released_at: null, bound_at: now, createdAt: new Date(now.getTime() - 2000), updatedAt: now, ...marker },
      { id: 8_100_002, documentId: newDocumentId(), gcm: `g${RUN}`, bound_at: now, createdAt: new Date(now.getTime() - 1000), updatedAt: now, ...marker }, // released_at missing
      { id: 8_100_003, documentId: newDocumentId(), gcm: `g${RUN}`, released_at: now, bound_at: now, createdAt: now, updatedAt: now, ...marker },
    ]);
    const open = await c.find({ gcm: `g${RUN}`, released_at: null }).sort({ createdAt: -1 }).toArray();
    assert.deepEqual(open.map((r) => r.id), [8_100_002, 8_100_001], "both the null and the missing one are open; newest first");
  } finally {
    await wipe("gcm_binding_logs", marker);
  }
});

after(async () => {
  await closeDb();
});
