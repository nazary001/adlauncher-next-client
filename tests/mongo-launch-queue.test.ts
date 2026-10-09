// Node's built-in runner: `node --test tests/mongo-launch-queue.test.ts` (needs MONGODB_URI; runs on
// gc_test). The live store of the server-side launch queue (lib/launch-queue-store.ts) against the
// real unique indexes: the AT-MOST-ONCE claim under concurrency, the lane lock, requeue/cancel rules,
// the reaper's grace, and the demand aggregate. Import ./_mongo.ts FIRST (it pins MONGODB_DB=gc_test);
// every row carries the per-run marker and is wiped in finally; the whole file skips without a store.
import { HAVE_DB, RUN, closeDb, col, ensureTestIndexes, wipe } from "./_mongo.ts";
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  FOLLOW_REQUEUE_DELAY_MS,
  IDEMPOTENT_MAX_ATTEMPTS,
  JOB_LEASE_MS,
  LANE_LEASE_MS,
  REAP_GRACE_MS,
  INTERRUPTED_MSG,
  type NewJob,
} from "../lib/launch-queue-types.ts";

const live = { skip: !HAVE_DB && "MONGODB_URI not set" };

// Lazy import so the file still loads (and skips) without a store configured.
type Store = typeof import("../lib/launch-queue-store.ts");
let S: Store;

const lane = (name: string) => `mo:${name}-${RUN}`;
const jid = (name: string) => `job-${RUN}-${name}`;

const newJob = (over: Partial<NewJob> & Pick<NewJob, "job_id" | "lane">): NewJob => ({
  owner: "nazar",
  role: "buyer",
  sub: "u1",
  scope: "mo",
  kind: "mo.launch",
  partner: "in",
  account: null,
  body: { medias: [{ url: "https://cdn.example.com/v.mp4" }] },
  row: { name: "Camp", gcm: "mk1", geo: "US", budget: "10", bid: "" },
  seq: 1,
  queued_at: Date.now(),
  ...over,
});

async function wipeAll() {
  await wipe("launch_jobs", { job_id: { $regex: RUN } });
  await wipe("launch_lanes", { lane: { $regex: RUN } });
}

before(async () => {
  if (!HAVE_DB) return;
  await ensureTestIndexes();
  S = await import("../lib/launch-queue-store.ts");
});

// A clean slate of RUN rows before every test (tests in one file run sequentially; this is the only
// file that touches launch_jobs / launch_lanes).
beforeEach(async () => {
  if (HAVE_DB) await wipeAll();
});

test("insert + duplicate: a second insert of the same job_id is 'duplicate'; existingJobIds reflects what landed", live, async () => {
  assert.equal(await S.insertJob(newJob({ job_id: jid("a"), lane: lane("x"), seq: 1 })), "inserted");
  assert.equal(await S.insertJob(newJob({ job_id: jid("a"), lane: lane("x"), seq: 2 })), "duplicate");
  assert.equal(await S.insertJob(newJob({ job_id: jid("b"), lane: lane("x"), seq: 3 })), "inserted");
  const existing = await S.existingJobIds([jid("a"), jid("b"), jid("c")]);
  assert.deepEqual([...existing].sort(), [jid("a"), jid("b")].sort());
  assert.deepEqual([...(await S.existingJobIds([]))], []);
  const row = await S.findJob(jid("a"));
  assert.equal(row?.status, "queued");
  assert.equal(row?.attempts, 0);
  assert.equal(row?.retryable, false);
  assert.equal(row?.seq, 1, "the duplicate never overwrote the first job's seq");
  assert.equal(row?.lease_until, null);
  assert.equal(await S.findJob(jid("missing")), null);
});

test("N concurrent claims on one lane hand out each job exactly once; sequential claims come in seq order", live, async () => {
  const L = lane("claim");
  for (let i = 1; i <= 5; i++) await S.insertJob(newJob({ job_id: jid(`c${i}`), lane: L, seq: i }));
  const now = Date.now();
  // 8 concurrent claimers for 5 jobs → every job claimed exactly once, 3 come back empty.
  const got = await Promise.all(Array.from({ length: 8 }, () => S.claimNextJob(L, `runner-${Math.random()}`, now)));
  const claimed = got.filter((j): j is NonNullable<typeof j> => j !== null);
  assert.equal(claimed.length, 5);
  assert.equal(got.filter((j) => j === null).length, 3);
  assert.deepEqual(claimed.map((j) => j.job_id).sort(), [1, 2, 3, 4, 5].map((i) => jid(`c${i}`)).sort());
  for (const j of claimed) {
    assert.equal(j.status, "running");
    assert.equal(j.attempts, 1);
    assert.equal(j.started_at, now);
    assert.equal(j.lease_until, now + JOB_LEASE_MS);
  }

  // Sequential claims on a fresh lane arrive strictly in seq order.
  const L2 = lane("order");
  for (const i of [3, 1, 2]) await S.insertJob(newJob({ job_id: jid(`o${i}`), lane: L2, seq: i }));
  const order: string[] = [];
  for (let k = 0; k < 3; k++) order.push((await S.claimNextJob(L2, "r", Date.now()))!.job_id);
  assert.deepEqual(order, [jid("o1"), jid("o2"), jid("o3")]);
  assert.equal(await S.claimNextJob(L2, "r", Date.now()), null);
});

test("unclaim restores the job to queued (attempts back, leases/started cleared) only for the holder", live, async () => {
  const L = lane("unclaim");
  await S.insertJob(newJob({ job_id: jid("u1"), lane: L, seq: 1 }));
  const claimed = await S.claimNextJob(L, "runner-A", Date.now());
  assert.equal(claimed?.attempts, 1);
  // a foreign runner cannot unclaim
  await S.unclaimJob(jid("u1"), "runner-B");
  assert.equal((await S.findJob(jid("u1")))?.status, "running");
  // the holder can
  await S.unclaimJob(jid("u1"), "runner-A");
  const back = await S.findJob(jid("u1"));
  assert.equal(back?.status, "queued");
  assert.equal(back?.attempts, 0);
  assert.equal(back?.runner, null);
  assert.equal(back?.lease_until, null);
  assert.equal(back?.started_at, null);
  // and it can be claimed again
  assert.ok(await S.claimNextJob(L, "runner-C", Date.now()));
});

test("beat and finish only for the holder; a finish after a reap writes nothing", live, async () => {
  const L = lane("finish");
  const now = Date.now();
  await S.insertJob(newJob({ job_id: jid("f1"), lane: L, seq: 1 }));
  await S.insertJob(newJob({ job_id: jid("f2"), lane: L, seq: 2 }));
  await S.claimNextJob(L, "A", now); // f1
  await S.claimNextJob(L, "A", now); // f2

  // beat: foreign runner no-op, holder extends
  await S.beatJob(jid("f1"), "B", now + 1000);
  assert.equal((await S.findJob(jid("f1")))?.lease_until, now + JOB_LEASE_MS);
  await S.beatJob(jid("f1"), "A", now + 1000);
  assert.equal((await S.findJob(jid("f1")))?.lease_until, now + 1000 + JOB_LEASE_MS);

  // finish: foreign runner false (nothing written), holder true
  assert.equal(await S.finishJob(jid("f1"), "B", { status: "done", retryable: false, error: null, result: null, finished_at: now + 2000 }), false);
  assert.equal((await S.findJob(jid("f1")))?.status, "running");
  assert.equal(await S.finishJob(jid("f1"), "A", { status: "done", retryable: false, error: null, result: { campaign_id: "C1" }, finished_at: now + 2000 }), true);
  const done = await S.findJob(jid("f1"));
  assert.equal(done?.status, "done");
  assert.equal(done?.finished_at, now + 2000);
  assert.deepEqual(done?.result, { campaign_id: "C1" });
  assert.equal(done?.lease_until, null);

  // f2 BEGAN (its handler was called), then its lease runs out → the reaper closes it → the
  // original runner's finish writes nothing.
  assert.equal(await S.markJobBegan(jid("f2"), "A", now), true);
  const reapNow = now + JOB_LEASE_MS + REAP_GRACE_MS + 1000;
  const reaped = (await S.reapExpiredJobs(reapNow)).interrupted.filter((j) => j.job_id === jid("f2"));
  assert.equal(reaped.length, 1);
  assert.equal(reaped[0].error, INTERRUPTED_MSG);
  assert.equal(reaped[0].retryable, false);
  assert.equal(await S.finishJob(jid("f2"), "A", { status: "done", retryable: false, error: null, result: null, finished_at: reapNow }), false, "a reaped job is no longer ours to finish");
  const z = await S.findJob(jid("f2"));
  assert.equal(z?.status, "error");
  assert.equal(z?.error, INTERRUPTED_MSG);
});

test("requeue: retryable error/canceled only, owner only, lands at the back with a fresh seq", live, async () => {
  const L = lane("requeue");
  const base = Date.now();
  // an error+retryable (eligible), an error non-retryable, a canceled+retryable (eligible), a done
  await S.insertJob(newJob({ job_id: jid("r_err_yes"), lane: L, seq: 1 }));
  await S.insertJob(newJob({ job_id: jid("r_err_no"), lane: L, seq: 2 }));
  await S.insertJob(newJob({ job_id: jid("r_can_yes"), lane: L, seq: 3 }));
  await S.insertJob(newJob({ job_id: jid("r_done"), lane: L, seq: 4 }));
  await S.insertJob(newJob({ job_id: jid("r_foreign"), lane: L, seq: 5, owner: "mallory" }));

  // drive them into terminal states directly through the store's claim+finish / cancel.
  const c1 = await S.claimNextJob(L, "A", base); // err_yes (seq 1)
  await S.finishJob(c1!.job_id, "A", { status: "error", retryable: true, error: "clean", result: null, finished_at: base });
  const c2 = await S.claimNextJob(L, "A", base); // err_no (seq 2)
  await S.finishJob(c2!.job_id, "A", { status: "error", retryable: false, error: "ambiguous", result: null, finished_at: base });
  await S.cancelQueuedJobs("nazar", { jobIds: [jid("r_can_yes")] }, base); // canceled+retryable
  // seq3 is now canceled, so the next queued by seq is r_done (seq4); drive it to done.
  const c4 = await S.claimNextJob(L, "A", base);
  assert.equal(c4?.job_id, jid("r_done"));
  await S.finishJob(c4!.job_id, "A", { status: "done", retryable: false, error: null, result: null, finished_at: base });

  const now = base + 10_000;
  const requeued = await S.requeueJobs("nazar", [jid("r_err_yes"), jid("r_err_no"), jid("r_can_yes"), jid("r_done"), jid("r_foreign")], now);
  assert.deepEqual(requeued.map((j) => j.job_id).sort(), [jid("r_err_yes"), jid("r_can_yes")].sort(), "only owner's retryable error/canceled jobs");
  for (const j of requeued) {
    assert.equal(j.status, "queued");
    assert.equal(j.retryable, false, "a re-queued job is no longer one-click-retryable until it fails again");
    assert.equal(j.error, null);
    assert.equal(j.result, null);
    assert.equal(j.finished_at, null);
    assert.equal(j.runner, null);
    assert.ok(j.seq >= now * 1000, "a fresh seq lands it at the back of the lane");
  }
});

test("cancel: queued only, owner only — by ids and by scope", live, async () => {
  const L = lane("cancel");
  const now = Date.now();
  await S.insertJob(newJob({ job_id: jid("q1"), lane: L, seq: 1 }));
  await S.insertJob(newJob({ job_id: jid("q2"), lane: L, seq: 2 }));
  await S.insertJob(newJob({ job_id: jid("q_running"), lane: L, seq: 3 }));
  await S.insertJob(newJob({ job_id: jid("q_foreign"), lane: L, seq: 4, owner: "mallory" }));

  // a running job (claimed) must not be cancelable
  const run = await S.claimNextJob(L, "A", now);
  assert.equal(run?.job_id, jid("q1"), "lowest seq claimed first");

  // cancel by ids: q1 is running (skip), q2 queued (cancel), q_foreign not ours (skip)
  const byId = await S.cancelQueuedJobs("nazar", { jobIds: [jid("q1"), jid("q2"), jid("q_foreign")] }, now);
  assert.deepEqual(byId.map((j) => j.job_id), [jid("q2")]);
  const q2 = await S.findJob(jid("q2"));
  assert.equal(q2?.status, "canceled");
  assert.equal(q2?.retryable, true, "a canceled job may be re-queued");
  assert.equal(q2?.finished_at, now);
  assert.equal((await S.findJob(jid("q1")))?.status, "running", "a running job is never canceled");
  assert.equal((await S.findJob(jid("q_foreign")))?.status, "queued", "a foreign queued job is left alone");

  // cancel by scope: every remaining QUEUED job of this owner in scope mo — only q_running is left
  // queued and ours (q_foreign belongs to mallory). Use the owner+scope resolution path.
  const byScope = await S.cancelQueuedJobs("nazar", { scope: "mo" }, now);
  const mine = byScope.filter((j) => j.job_id.includes(RUN));
  assert.ok(mine.some((j) => j.job_id === jid("q_running")));
  assert.equal(mine.every((j) => j.status === "canceled"), true);
  assert.equal((await S.findJob(jid("q_foreign")))?.status, "queued", "scope cancel still respects ownership");
});

test("reap: a run that BEGAN and lost its lease is interrupted and never re-queued — only past lease + grace", live, async () => {
  const L = lane("reap");
  const now = Date.now();
  await S.insertJob(newJob({ job_id: jid("rp1"), lane: L, seq: 1 }));
  await S.claimNextJob(L, "A", now); // lease_until = now + JOB_LEASE_MS
  assert.equal(await S.markJobBegan(jid("rp1"), "A", now), true, "the holder records the run as begun");
  assert.equal((await S.findJob(jid("rp1")))?.began, true);

  // before the grace cutoff → not reaped
  const tooEarly = await S.reapExpiredJobs(now + JOB_LEASE_MS + REAP_GRACE_MS - 1000);
  assert.equal([...tooEarly.interrupted, ...tooEarly.requeued].filter((j) => j.job_id === jid("rp1")).length, 0);
  assert.equal((await S.findJob(jid("rp1")))?.status, "running");

  // past lease + grace → reaped, closed as a non-retryable interrupted error
  const swept = await S.reapExpiredJobs(now + JOB_LEASE_MS + REAP_GRACE_MS + 1000);
  assert.equal(swept.requeued.filter((j) => j.job_id === jid("rp1")).length, 0, "a run that began is never put back");
  const mine = swept.interrupted.filter((j) => j.job_id === jid("rp1"));
  assert.equal(mine.length, 1);
  assert.equal(mine[0].status, "error");
  assert.equal(mine[0].retryable, false);
  assert.equal(mine[0].error, INTERRUPTED_MSG);

  // and it is NOT eligible for requeue (retryable false — the system never re-runs an unknown outcome)
  assert.deepEqual(await S.requeueJobs("nazar", [jid("rp1")], now + 1), []);
});

test("reap: a job that was claimed but NEVER begun goes back to the queue (its pump tripped before the call) and runs later", live, async () => {
  const L = lane("reapback");
  const now = Date.now();
  await S.insertJob(newJob({ job_id: jid("rb1"), lane: L, seq: 1 }));
  const claimed = await S.claimNextJob(L, "A", now);
  assert.equal(claimed?.began, false, "a claim never carries the began mark");
  assert.equal(claimed?.attempts, 1);

  const swept = await S.reapExpiredJobs(now + JOB_LEASE_MS + REAP_GRACE_MS + 1000);
  assert.equal(swept.interrupted.filter((j) => j.job_id === jid("rb1")).length, 0, "never interrupted — it never ran");
  const back = swept.requeued.filter((j) => j.job_id === jid("rb1"));
  assert.equal(back.length, 1);
  assert.equal(back[0].status, "queued");
  assert.equal(back[0].runner, null);
  assert.equal(back[0].lease_until, null);
  assert.equal(back[0].attempts, 0, "the attempt that never ran is not counted");

  // the pump that lost it can no longer begin it (not its job any more) — so it can never run twice
  assert.equal(await S.markJobBegan(jid("rb1"), "A", now + 10), false);
  // and a fresh pump claims it normally
  const again = await S.claimNextJob(L, "B", now + 20);
  assert.equal(again?.job_id, jid("rb1"));
  assert.equal(await S.markJobBegan(jid("rb1"), "B", now + 30), true);
});

test("began: only the holder of a running job can record it, and the record refreshes the lease", live, async () => {
  const L = lane("began");
  const now = Date.now();
  await S.insertJob(newJob({ job_id: jid("bg1"), lane: L, seq: 1 }));
  assert.equal(await S.markJobBegan(jid("bg1"), "A", now), false, "a queued job cannot begin");
  await S.claimNextJob(L, "A", now);
  assert.equal(await S.markJobBegan(jid("bg1"), "B", now + 5), false, "a foreign runner cannot begin it");
  assert.equal((await S.findJob(jid("bg1")))?.began, false);
  assert.equal(await S.markJobBegan(jid("bg1"), "A", now + 5000), true);
  const j = await S.findJob(jid("bg1"));
  assert.equal(j?.began, true);
  assert.equal(j?.lease_until, now + 5000 + JOB_LEASE_MS);
  // un-claiming and re-queueing clear the mark
  await S.unclaimJob(jid("bg1"), "A");
  assert.equal((await S.findJob(jid("bg1")))?.began, false);
});

test("lane lock: foreign refused, re-entrant for the holder, taken over after expiry, extend/release only by the holder", live, async () => {
  const L = lane("lock");
  const t0 = Date.now();
  assert.equal(await S.acquireLane(L, "A", t0), true, "a free lane is taken");
  assert.equal(await S.acquireLane(L, "B", t0 + 1), false, "a live foreign holder is refused (E11000 on the unique lane)");
  assert.equal(await S.acquireLane(L, "A", t0 + 2), true, "re-entrant for the current holder");

  // not past expiry yet → still B-refused
  assert.equal(await S.acquireLane(L, "B", t0 + LANE_LEASE_MS - 10), false);
  // past expiry → B takes over
  assert.equal(await S.acquireLane(L, "B", t0 + LANE_LEASE_MS + 100), true);

  // A can no longer extend or release — it is not the holder
  assert.equal(await S.extendLane(L, "A", t0 + LANE_LEASE_MS + 200), false);
  assert.equal(await S.extendLane(L, "B", t0 + LANE_LEASE_MS + 200), true);
  await S.releaseLane(L, "A"); // no-op (not the holder)
  assert.equal(await S.acquireLane(L, "C", t0 + LANE_LEASE_MS + 300), false, "A's no-op release left B holding");
  await S.releaseLane(L, "B");
  assert.equal(await S.acquireLane(L, "C", t0 + LANE_LEASE_MS + 400), true, "after B releases, C acquires");
});

test("lanesNeedingPump: lanes with queued jobs and no live lock (never locked / released / expired)", live, async () => {
  const now = Date.now();
  const L1 = lane("need1"); // queued, no lock → needs pump
  const L2 = lane("need2"); // queued, live lock → does NOT need pump
  const L3 = lane("need3"); // queued, expired lock → needs pump
  const L4 = lane("need4"); // lock but no queued jobs → absent
  await S.insertJob(newJob({ job_id: jid("n1"), lane: L1, seq: 1 }));
  await S.insertJob(newJob({ job_id: jid("n2"), lane: L2, seq: 1 }));
  await S.insertJob(newJob({ job_id: jid("n3"), lane: L3, seq: 1 }));
  await S.acquireLane(L2, "A", now); // live
  await S.acquireLane(L3, "A", now - LANE_LEASE_MS - 1000); // already expired at `now`
  await S.acquireLane(L4, "A", now);

  const need = (await S.lanesNeedingPump(now)).filter((l) => l.includes(RUN));
  assert.ok(need.includes(L1));
  assert.ok(need.includes(L3), "an expired lock does not keep a lane from being pumped");
  assert.ok(!need.includes(L2), "a live lock keeps the lane off the list");
  assert.ok(!need.includes(L4), "no queued jobs → never on the list");
});

test("queuedDemandByAccount: counts QUEUED jobs per known account, ignores null-account and non-queued", live, async () => {
  const L = lane("demand");
  const acctA = `9${String(Date.now()).slice(-9)}1`; // 11 digits, unique per run
  const acctB = `9${String(Date.now()).slice(-9)}2`;
  const now = Date.now();
  await S.insertJob(newJob({ job_id: jid("d1"), lane: L, seq: 1, account: acctA }));
  await S.insertJob(newJob({ job_id: jid("d2"), lane: L, seq: 2, account: acctA }));
  await S.insertJob(newJob({ job_id: jid("d3"), lane: L, seq: 3, account: acctB }));
  await S.insertJob(newJob({ job_id: jid("d4"), lane: L, seq: 4, account: null })); // ignored
  await S.insertJob(newJob({ job_id: jid("d5"), lane: L, seq: 5, account: acctA }));
  // a RUNNING job of acctA must not count toward queued demand
  await S.claimNextJob(L, "A", now); // d1 (seq 1)

  const demand = await S.queuedDemandByAccount();
  assert.equal(demand[acctA], 2, "d2 + d5 queued (d1 is running)");
  assert.equal(demand[acctB], 1);
});

test("jobs carry their document version and the build that queued them (a job queued without them is version 1)", live, async () => {
  const L = lane("ver");
  await S.insertJob(newJob({ job_id: jid("v1"), lane: L, seq: 1 }));
  await S.insertJob(newJob({ job_id: jid("v2"), lane: L, seq: 2, v: 2, build: "2026-10-09T00:00:00.000Z" }));
  const a = await S.claimNextJob(L, "A", Date.now());
  assert.deepEqual([a?.job_id, a?.v, a?.build], [jid("v1"), 1, null]);
  const b = await S.claimNextJob(L, "A", Date.now());
  assert.deepEqual([b?.job_id, b?.v, b?.build], [jid("v2"), 2, "2026-10-09T00:00:00.000Z"]);
});

test("beacon + queue health: the last announced build (one document), and since when the oldest job waits", live, async () => {
  const t0 = Date.now();
  await S.writeBeacon("build-" + RUN + "-a", t0 - 5_000);
  await S.writeBeacon("build-" + RUN + "-b", t0); // the second write replaces the first
  assert.deepEqual(await S.readBeacon(), { build: "build-" + RUN + "-b", at: t0 });
  const L = lane("health");
  await S.insertJob(newJob({ job_id: jid("h1"), lane: L, seq: 1, queued_at: t0 - 60_000 }));
  const h = await S.queueHealth();
  assert.equal(h.sweptAt, t0);
  assert.ok(h.oldestQueuedAt !== null && h.oldestQueuedAt <= t0 - 60_000, "this run's job, or an older leftover of the test database");
  assert.deepEqual(await S.lanesNeedingPump(Date.now()).then((ls) => ls.includes("@beacon")), false, "the beacon is never mistaken for a lane");
  // Leave no announcement behind in the shared test database (an empty build reads as "never swept").
  await S.writeBeacon("", 0);
  assert.equal(await S.readBeacon(), null);
});

test("findJobsBrief: the jobs of many ids in one read, without their bodies; unknown ids are simply absent", live, async () => {
  const L = lane("brief");
  await S.insertJob(newJob({ job_id: jid("b1"), lane: L, seq: 1, body: { big: "x".repeat(2000) } }));
  await S.insertJob(newJob({ job_id: jid("b2"), lane: L, seq: 2 }));
  const claimed = await S.claimNextJob(L, "A", Date.now());
  assert.equal(claimed?.job_id, jid("b1"));
  const m = await S.findJobsBrief([jid("b1"), jid("b2"), jid("nope")]);
  assert.deepEqual([...m.keys()].sort(), [jid("b1"), jid("b2")].sort());
  assert.equal(m.get(jid("b1"))?.status, "running");
  assert.equal(m.get(jid("b2"))?.status, "queued");
  assert.equal(m.get(jid("b1"))?.kind, "mo.launch");
  assert.equal(m.get(jid("b1"))?.partner, "in");
  assert.deepEqual(m.get(jid("b1"))?.body, {}, "bodies are not read");
  assert.equal((await S.findJobsBrief([])).size, 0);
});

// ---- 09.10: not_before, defer, siblings, idempotent reap, reopen, groups, overdue running ----

test("not_before: a job due later is invisible to claim / peek / lanesNeedingPump until its time", live, async () => {
  const L = lane("due");
  const now = Date.now();
  await S.insertJob(newJob({ job_id: jid("d1"), lane: L, seq: 1, not_before: now + 60_000 }));
  await S.insertJob(newJob({ job_id: jid("d2"), lane: L, seq: 2 }));
  assert.equal((await S.claimNextJob(L, "A", now))?.job_id, jid("d2"), "the due job is claimed even behind an earlier seq");
  assert.equal(await S.claimNextJob(L, "A", now), null, "nothing else is due");
  assert.deepEqual((await S.peekQueued(L, 5, now)).map((j) => j.job_id), []);
  assert.ok(!(await S.lanesNeedingPump(now)).includes(L), "a lane whose only queued job is not due needs no pump");
  assert.ok((await S.lanesNeedingPump(now + 61_000)).includes(L));
  assert.deepEqual((await S.peekQueued(L, 5, now + 61_000)).map((j) => j.job_id), [jid("d1")]);
  const late = await S.claimNextJob(L, "A", now + 61_000);
  assert.equal(late?.job_id, jid("d1"));
  assert.equal(late?.not_before, now + 60_000);
});

test("deferJob: a running follow-up hands itself back — queued from not_before, body replaced, attempts kept, began reset, holder only", live, async () => {
  const L = lane("defer");
  const now = Date.now();
  await S.insertJob(newJob({ job_id: jid("df1"), lane: L, seq: 1, kind: "hs.dup.follow", idempotent: true, body: { waveId: "w" } }));
  const claimed = await S.claimNextJob(L, "A", now);
  assert.equal(claimed?.attempts, 1);
  assert.equal(await S.markJobBegan(jid("df1"), "A", now), true);
  assert.equal(await S.deferJob(jid("df1"), "B", now + 20_000, { waveId: "w", renamed: ["x"] }), false, "not the holder");
  assert.equal(await S.deferJob(jid("df1"), "A", now + 20_000, { waveId: "w", renamed: ["x"] }), true);
  const j = await S.findJob(jid("df1"));
  assert.equal(j?.status, "queued");
  assert.equal(j?.not_before, now + 20_000);
  assert.equal(j?.attempts, 1, "attempts are kept — the sweep's re-queue cap counts every slice");
  assert.equal(j?.began, false);
  assert.equal(j?.runner, null);
  assert.deepEqual(j?.body, { waveId: "w", renamed: ["x"] });
  assert.equal(await S.claimNextJob(L, "C", now + 10_000), null, "not due yet");
  assert.equal((await S.claimNextJob(L, "C", now + 21_000))?.job_id, jid("df1"));
});

test("failQueuedSiblings: the QUEUED siblings of a group whose body matches the fact are settled — never a running one, never another group, never the job itself", live, async () => {
  const L = lane("sib");
  const now = Date.now();
  const G = `wave-${RUN}`;
  await S.insertJob(newJob({ job_id: jid("s0"), lane: L, seq: 1, group: G, body: { shot: { campaignId: "111", binds: { account: "a1" } } } }));
  await S.insertJob(newJob({ job_id: jid("s1"), lane: L, seq: 2, group: G, body: { shot: { campaignId: "111", binds: { account: "a1" } } } }));
  await S.insertJob(newJob({ job_id: jid("s2"), lane: L, seq: 3, group: G, body: { shot: { campaignId: "222", binds: { account: "a1" } } } }));
  await S.insertJob(newJob({ job_id: jid("s3"), lane: L, seq: 4, group: G, body: { shot: { campaignId: "111", binds: { account: "a2" } } } }));
  await S.insertJob(newJob({ job_id: jid("s4"), lane: L, seq: 5, group: `other-${RUN}`, body: { shot: { campaignId: "111", binds: { account: "a1" } } } }));
  const running = await S.claimNextJob(L, "A", now); // s0 is running — the job that learned the refusal
  assert.equal(running?.job_id, jid("s0"));
  const closed = await S.failQueuedSiblings(L, G, { "body.shot.campaignId": "111" }, { error: "LION rejected the family", retryable: false, now, except: jid("s0") });
  assert.deepEqual(closed.map((j) => j.job_id).sort(), [jid("s1"), jid("s3")].sort());
  for (const j of closed) {
    assert.equal(j.status, "error");
    assert.equal(j.retryable, false);
    assert.equal(j.error, "LION rejected the family");
    assert.equal(j.finished_at, now);
  }
  assert.equal((await S.findJob(jid("s2")))?.status, "queued", "another source is untouched");
  assert.equal((await S.findJob(jid("s4")))?.status, "queued", "another wave is untouched");
  assert.equal((await S.findJob(jid("s0")))?.status, "running", "the job itself is the caller's to settle");
  // the account-window rule: by destination account, retryable (the window reopens)
  const byAcct = await S.failQueuedSiblings(L, G, { "body.shot.binds.account": "a1" }, { error: "window full", retryable: true, now });
  assert.deepEqual(byAcct.map((j) => j.job_id), [jid("s2")]);
  assert.equal(byAcct[0].retryable, true);
  assert.deepEqual(await S.failQueuedSiblings(L, "", {}, { error: "x", retryable: false, now }), [], "no group → nothing");
});

test("reap: an IDEMPOTENT run that began and lost its lease is re-queued a little later — until its attempt cap, then interrupted like any other", live, async () => {
  const L = lane("reapidem");
  const now = Date.now();
  await S.insertJob(newJob({ job_id: jid("ri1"), lane: L, seq: 1, kind: "tt.follow", idempotent: true }));
  await S.claimNextJob(L, "A", now);
  assert.equal(await S.markJobBegan(jid("ri1"), "A", now), true);
  const t = now + JOB_LEASE_MS + REAP_GRACE_MS + 1000;
  const swept = await S.reapExpiredJobs(t);
  assert.equal(swept.interrupted.filter((j) => j.job_id === jid("ri1")).length, 0, "a follow-up is never closed as interrupted while it may run again");
  const back = swept.requeued.filter((j) => j.job_id === jid("ri1"));
  assert.equal(back.length, 1);
  assert.equal(back[0].status, "queued");
  assert.equal(back[0].attempts, 1, "the slice that died still counts toward the cap");
  assert.equal(back[0].not_before, t + FOLLOW_REQUEUE_DELAY_MS);
  assert.equal(await S.claimNextJob(L, "B", t), null, "not due before the delay");
  assert.equal((await S.claimNextJob(L, "B", t + FOLLOW_REQUEUE_DELAY_MS + 1))?.job_id, jid("ri1"));
  // at the cap: closed as interrupted
  const c = await col("launch_jobs");
  await c.updateOne({ job_id: jid("ri1") }, { $set: { attempts: IDEMPOTENT_MAX_ATTEMPTS } });
  assert.equal(await S.markJobBegan(jid("ri1"), "B", t + FOLLOW_REQUEUE_DELAY_MS + 2), true);
  const t2 = t + FOLLOW_REQUEUE_DELAY_MS + JOB_LEASE_MS + REAP_GRACE_MS + 2000;
  const swept2 = await S.reapExpiredJobs(t2);
  assert.equal(swept2.interrupted.filter((j) => j.job_id === jid("ri1")).length, 1);
  assert.equal(swept2.requeued.filter((j) => j.job_id === jid("ri1")).length, 0);
});

test("reopenJob: a finished follow-up comes back queued for its time; a submit (not idempotent) and an open job never", live, async () => {
  const L = lane("reopen");
  const now = Date.now();
  await S.insertJob(newJob({ job_id: jid("ro1"), lane: L, seq: 1, kind: "hs.dup.follow", idempotent: true }));
  await S.insertJob(newJob({ job_id: jid("ro2"), lane: L, seq: 2 }));
  assert.equal(await S.reopenJob(jid("ro1"), now + 5000), false, "still queued — nothing to reopen");
  await S.claimNextJob(L, "A", now);
  await S.finishJob(jid("ro1"), "A", { status: "done", retryable: false, error: null, result: null, finished_at: now });
  assert.equal(await S.reopenJob(jid("ro1"), now + 5000), true);
  const j = await S.findJob(jid("ro1"));
  assert.equal(j?.status, "queued");
  assert.equal(j?.not_before, now + 5000);
  assert.equal(j?.finished_at, null);
  await S.claimNextJob(L, "A", now + 6000); // ro1
  await S.claimNextJob(L, "A", now + 6000); // ro2 (not due-gated)
  await S.finishJob(jid("ro2"), "A", { status: "error", retryable: true, error: "x", result: null, finished_at: now });
  assert.equal(await S.reopenJob(jid("ro2"), now + 7000), false, "a submit is never re-opened this way — Retry is the owner's");
});

test("findJobsByGroup: the jobs of a wave in seq order, by kind; queueHealth sees a running job nobody reaped", live, async () => {
  const L = lane("group");
  const now = Date.now();
  const G = `wave2-${RUN}`;
  await S.insertJob(newJob({ job_id: jid("g1"), lane: L, seq: 2, group: G, kind: "tt.launch" }));
  await S.insertJob(newJob({ job_id: jid("g2"), lane: L, seq: 1, group: G, kind: "tt.clone" }));
  await S.insertJob(newJob({ job_id: jid("g3"), lane: `${L}-follow`, seq: 3, group: G, kind: "tt.follow", idempotent: true }));
  assert.deepEqual((await S.findJobsByGroup(G)).map((j) => j.job_id), [jid("g2"), jid("g1"), jid("g3")]);
  assert.deepEqual((await S.findJobsByGroup(G, ["tt.launch", "tt.clone"])).map((j) => j.job_id), [jid("g2"), jid("g1")]);
  assert.deepEqual(await S.findJobsByGroup(""), []);
  // a running job whose lease ran out past the grace — the stranded run no queued backlog shows
  const c = await col("launch_jobs");
  await S.claimNextJob(L, "A", now);
  await c.updateOne({ job_id: jid("g2") }, { $set: { lease_until: now - REAP_GRACE_MS - 120_000 } });
  const h = await S.queueHealth();
  assert.ok(h.oldestOverdueRunningAt !== null && h.oldestOverdueRunningAt <= now - REAP_GRACE_MS - 120_000, "this run's overdue job, or an older leftover");
});

after(async () => {
  if (HAVE_DB) await wipeAll();
  await closeDb();
});
