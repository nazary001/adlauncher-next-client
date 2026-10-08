// Node's built-in runner (v24 strips types natively): `node --test tests/hs-task-queue-contract.test.ts`.
//
// The HS task manager (components/hs-task-manager.tsx) no longer runs launches — it hands them to the
// server queue and MIRRORS the rows the queue writes. That component is a React client module and
// cannot be loaded by node --test (JSX, "@/…" aliases), so this file instead pins the exact contract
// VALUES the component's srv-row mapping is coded against (lib/launch-queue-types.ts). If any of these
// shift, the drawer would mis-read a server row — e.g. a done LION launch stuck "running", a cancel
// shown as a hard failure, or a retryable job with no Retry — so they are asserted here.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CANCELED_STAGE,
  canceledRow,
  firstStage,
  outcomeOf,
  queuedRow,
  reapedRow,
  runningRow,
} from "../lib/launch-queue-types.ts";

const ROW = { name: "n", gcm: "launch", geo: "US", budget: "10", bid: "" };

// ---- the row the optimistic client row must match (queued → "Queued on the server") ----

test("queuedRow stamps srv, queued, and the HS first stage the optimistic row uses", () => {
  const r = queuedRow({ kind: "hs.lion", partner: "br", row: ROW, queued_at: 123 });
  assert.equal(r.srv, 1); // → fromRemote maps srv:1 → the client never ages/writes/stale-judges it
  assert.equal(r.retry, 0);
  assert.equal(r.status, "queued"); // → client "Queued on the server"
  assert.equal(r.stage, "submit"); // the optimistic row is born at stage "submit" to match
  assert.equal(firstStage("hs.lion"), "submit");
  assert.equal(firstStage("hs.token"), "submit");
  assert.equal(firstStage("hs.tool"), "submit");
});

test("runningRow is srv + running at the HS first stage (client shows it 'running')", () => {
  const r = runningRow({ kind: "hs.lion", partner: "br" }, 500);
  assert.equal(r.srv, 1);
  assert.equal(r.status, "running");
  assert.equal(r.stage, "submit");
});

// ---- cancel: status error + stage "canceled" + retryable (the client's `canceled` + Retry gate) ----

test("CANCELED_STAGE is 'canceled' and canceledRow is a retryable error row", () => {
  assert.equal(CANCELED_STAGE, "canceled");
  const r = canceledRow({ partner: "br" }, 900);
  assert.equal(r.srv, 1);
  assert.equal(r.status, "error"); // → client detects canceled by (status error && stage "canceled")
  assert.equal(r.stage, "canceled");
  assert.equal(r.retry, 1); // → Retry affordance (srv && retry) shows on a canceled row
  assert.equal(r.finished_at, 900);
});

// ---- a LION done launch: stage "queue" + link (the client's done-with-LION-id row) ----

test("outcomeOf hs.lion acceptance → done, stage 'queue', link, not retryable", () => {
  const o = outcomeOf(
    { kind: "hs.lion", partner: "br", body: {} },
    { httpStatus: 200, streamed: false, final: { ok: true, lionTaskId: "777", name: "X" }, lastStage: null },
    1000,
  );
  assert.equal(o.status, "done");
  assert.equal(o.retryable, false);
  assert.equal(o.row.status, "done");
  assert.equal(o.row.stage, "queue"); // → fromRemote resumes/renders a LION done row at "queue"
  assert.equal(o.row.link, "777");
  assert.equal(o.row.retry, 0);
});

test("outcomeOf hs.lion clean rejection is retryable (row.retry 1 → client Retry)", () => {
  const o = outcomeOf(
    { kind: "hs.lion", partner: "br", body: {} },
    { httpStatus: 400, streamed: false, final: { ok: false, error: "campaign_required" }, lastStage: null },
    1000,
  );
  assert.equal(o.status, "error");
  assert.equal(o.retryable, true);
  assert.equal(o.row.retry, 1);
  assert.equal(o.row.status, "error");
});

test("outcomeOf hs.lion ambiguous submit → interrupted (client 'unknown'), never retryable", () => {
  const o = outcomeOf(
    { kind: "hs.lion", partner: "br", body: {} },
    { httpStatus: 502, streamed: false, final: null, lastStage: null },
    1000,
  );
  assert.equal(o.retryable, false);
  assert.equal(o.ambiguous, true);
  assert.equal(o.row.retry, 0);
  assert.ok(o.openRow && o.openRow.status === "interrupted"); // → fromRemote maps interrupted → unknown (no Retry)
});

// ---- a token/tool done launch: stage "ads", ad_id as a STRING (the 08-17 400 incident) ----

test("outcomeOf hs.token success → done at stage 'ads' with a string ad_id, not retryable", () => {
  const o = outcomeOf(
    { kind: "hs.token", partner: "br", body: { creatives: [{}, {}] } },
    { httpStatus: 200, streamed: true, final: { ok: true, campaign_id: "c", adset_id: "a", ad_ids: ["1", "2"] }, lastStage: "ad" },
    1000,
  );
  assert.equal(o.status, "done");
  assert.equal(o.retryable, false);
  assert.equal(o.row.stage, "ads");
  assert.equal(o.row.ad_id, "2"); // String(adCount) — a numeric ad_id once 400'd the whole write
  assert.equal(o.row.retry, 0);
});

test("outcomeOf streaming error is retryable only while nothing was created", () => {
  const clean = outcomeOf(
    { kind: "hs.token", partner: "br", body: { creatives: [{}] } },
    { httpStatus: 400, streamed: true, final: { ok: false, error: "boom", created: {} }, lastStage: "campaign" },
    1000,
  );
  assert.equal(clean.retryable, true);
  assert.equal(clean.row.retry, 1);

  const withCampaign = outcomeOf(
    { kind: "hs.token", partner: "br", body: { creatives: [{}] } },
    { httpStatus: 400, streamed: true, final: { ok: false, error: "boom", created: { campaign_id: "c" } }, lastStage: "ad" },
    1000,
  );
  assert.equal(withCampaign.retryable, false);
  assert.equal(withCampaign.row.retry, 0);
});

// ---- a reaped (dead-lease) HS job → interrupted (client 'unknown'), never retryable ----

test("reapedRow for an HS job is a non-retryable interrupted row", () => {
  const r = reapedRow({ kind: "hs.lion", partner: "br" }, 2000);
  assert.equal(r.status, "interrupted"); // → client "unknown"
  assert.equal(r.retry, 0);
  assert.equal(r.srv, 1);
});
