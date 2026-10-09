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

test("live: patchOpenTaskRow writes only over a row that is still open — one atomic step, never over a verdict", live, async () => {
  const ts = await import("../lib/task-store.ts");
  const c = await col("launch_tasks");
  const open = `open-${RUN}`;
  const closed = `closed-${RUN}`;
  await wipe("launch_tasks", { task_id: { $in: [open, closed] } });
  try {
    await ts.upsertTaskRow("nazar", open, { status: "running", stage: "submit", srv: 1, retry: 0, partner: "br" });
    await ts.upsertTaskRow("nazar", closed, { status: "done", stage: "ad", srv: 1, retry: 0, partner: "br", campaign_id: "123" });
    const interrupted = { srv: 1, retry: 0, partner: "br", status: "interrupted", error: "Interrupted on the server mid-run", finished_at: 5 };
    assert.equal(await ts.patchOpenTaskRow(open, interrupted), true);
    assert.equal(await ts.patchOpenTaskRow(closed, interrupted), false, "a finished row is not touched");
    assert.equal(await ts.patchOpenTaskRow(`missing-${RUN}`, interrupted), false, "an absent row is not created");
    const a = await c.findOne({ task_id: open });
    assert.deepEqual([a?.status, a?.error, a?.srv], ["interrupted", "Interrupted on the server mid-run", 1]);
    const b = await c.findOne({ task_id: closed });
    assert.deepEqual([b?.status, b?.campaign_id, b?.error ?? null], ["done", "123", null]);
    assert.equal(await ts.patchOpenTaskRow(open, { status: "error" }), false, "second time: it is closed now");
  } finally {
    await wipe("launch_tasks", { task_id: { $in: [open, closed] } });
  }
});

test("live: staleOpenServerRows finds only rows that are server-owned, still open AND silent for the given time — oldest first", live, async () => {
  const ts = await import("../lib/task-store.ts");
  const c = await col("launch_tasks");
  const ids = { stale: `st-${RUN}`, stale2: `s2-${RUN}`, fresh: `fr-${RUN}`, closed: `cl-${RUN}`, client: `cu-${RUN}` };
  const mine = Object.values(ids);
  await wipe("launch_tasks", { task_id: { $in: mine } });
  try {
    await ts.upsertTaskRow("nazar", ids.stale, { status: "running", srv: 1, retry: 0, partner: "br" });
    await ts.upsertTaskRow("nazar", ids.stale2, { status: "queued", srv: 1, retry: 0, partner: "in" });
    await ts.upsertTaskRow("nazar", ids.fresh, { status: "queued", srv: 1, retry: 0, partner: "in" });
    await ts.upsertTaskRow("nazar", ids.closed, { status: "done", srv: 1, retry: 0, partner: "br" });
    await ts.upsertTaskRow("nazar", ids.client, { status: "running", partner: "br" }); // a row the queue never owned
    // Far in the past, so these sort before any leftover of the shared test database.
    await c.updateMany({ task_id: { $in: [ids.stale, ids.closed, ids.client] } }, { $set: { updatedAt: new Date("2001-01-01T00:00:00Z") } });
    await c.updateOne({ task_id: ids.stale2 }, { $set: { updatedAt: new Date("2001-01-02T00:00:00Z") } });
    const found = (await ts.staleOpenServerRows(Date.now(), 7 * 60_000, 1000)).filter((r) => mine.includes(r.task_id));
    // queued_at rides along (a row a follow-up still owns is judged by its age) — a number for a row
    // the store stamped, never a string.
    assert.deepEqual(
      found.map((r) => ({ task_id: r.task_id, partner: r.partner, queuedAtIsNumber: typeof r.queued_at === "number" })),
      [
        { task_id: ids.stale, partner: "br", queuedAtIsNumber: true },
        { task_id: ids.stale2, partner: "in", queuedAtIsNumber: true },
      ],
    );
    // the limit cuts from the OLDEST end
    const first = await ts.staleOpenServerRows(Date.now(), 7 * 60_000, 1);
    assert.deepEqual(first.map((r) => ({ task_id: r.task_id, partner: r.partner })), [{ task_id: ids.stale, partner: "br" }]);
    // and the same rows are simply not stale to a longer patience
    const patient = (await ts.staleOpenServerRows(new Date("2001-01-01T00:05:00Z").getTime(), 7 * 60_000, 1000)).filter((r) => mine.includes(r.task_id));
    assert.deepEqual(patient, []);
  } finally {
    await wipe("launch_tasks", { task_id: { $in: mine } });
  }
});
