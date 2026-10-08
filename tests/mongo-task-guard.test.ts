// Node's built-in runner: `node --test tests/mongo-task-guard.test.ts` (needs MONGODB_URI; runs on
// gc_test). The server-launch-queue write guard of lib/task-store upsertTaskRow, on a live store:
// the queue owns a job's row (srv=1), and a CLIENT write (a buyer's stale tab — heartbeat,
// stale-settle, pagehide beacon) must never bury it; a client can never set srv/retry itself; a
// client write to a NON-server row still works; a foreign owner is still refused. Import _mongo FIRST
// (it pins MONGODB_DB=gc_test before lib/mongo reads it).
import { HAVE_DB, RUN, closeDb, col, ensureTestIndexes, wipe } from "./_mongo.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

const live = { skip: !HAVE_DB && "MONGODB_URI not set" };

before(async () => {
  if (HAVE_DB) await ensureTestIndexes();
});
after(async () => {
  await closeDb();
});

test("live: a client write never buries a server-owned row, and can never stamp srv/retry itself", live, async () => {
  const ts = await import("../lib/task-store.ts");
  const c = await col("launch_tasks");
  const idA = `guard-${RUN}-a`;
  const idB = `guard-${RUN}-b`;
  await wipe("launch_tasks", { task_id: { $in: [idA, idB] } });
  try {
    // (a) the server stamps a row it owns (srv=1).
    assert.deepEqual(await ts.upsertTaskRow("nazar", idA, { partner: "in", status: "running", stage: "gcm", srv: 1, retry: 0 }), { ok: true });
    let row = await c.findOne({ task_id: idA });
    assert.equal(row?.srv, 1);
    assert.equal(row?.status, "running");

    // (b) a client write to that server row is silently ACCEPTED but changes nothing.
    assert.deepEqual(
      await ts.upsertTaskRow("nazar", idA, { status: "error", stage: "upload", error: "stale tab beacon", finished_at: Date.now() }, { client: true }),
      { ok: true },
      "a client write to a server-owned row answers ok and is dropped",
    );
    row = await c.findOne({ task_id: idA });
    assert.equal(row?.status, "running", "the server's status stands");
    assert.equal(row?.error ?? null, null, "the client's error never landed");

    // (c) a client CREATE carrying srv/retry has them stripped — a client can never own a row.
    assert.deepEqual(await ts.upsertTaskRow("nazar", idB, { partner: "in", status: "queued", srv: 1, retry: 1 }, { client: true }), { ok: true });
    row = await c.findOne({ task_id: idB });
    assert.equal(row?.srv ?? null, null, "a client can never stamp srv");
    assert.equal(row?.retry ?? null, null, "a client can never stamp retry");
    assert.equal(row?.status, "queued");

    // (d) a client write to a NON-server row still works (the ordinary buyer upsert).
    assert.deepEqual(await ts.upsertTaskRow("nazar", idB, { status: "done", stage: "ad" }, { client: true }), { ok: true });
    row = await c.findOne({ task_id: idB });
    assert.equal(row?.status, "done");

    // (e) a foreign owner is refused — as a server write AND as a client write.
    assert.deepEqual(await ts.upsertTaskRow("mallory", idA, { status: "done" }), { ok: false, reason: "forbidden" });
    assert.deepEqual(await ts.upsertTaskRow("mallory", idA, { status: "done" }, { client: true }), { ok: false, reason: "forbidden" });

    // (f) the server still owns idA and can advance it (no opts — a normal server write).
    assert.deepEqual(await ts.upsertTaskRow("nazar", idA, { status: "done", stage: "ad", srv: 1, retry: 0, finished_at: Date.now() }), { ok: true });
    row = await c.findOne({ task_id: idA });
    assert.equal(row?.status, "done");
    assert.equal(row?.srv, 1);
  } finally {
    await wipe("launch_tasks", { task_id: { $in: [idA, idB] } });
  }
});
