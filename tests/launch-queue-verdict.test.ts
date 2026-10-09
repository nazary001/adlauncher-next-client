// Node's built-in runner (v24 strips types natively): `node --test tests/launch-queue-verdict.test.ts`.
// The verdict a runner derives from the rows its rail's pump core wrote (lib/launch-queue-verdict):
// the money rule — a one-click retry only when nothing was sent — against every terminal shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verdictFromRows } from "../lib/launch-queue-verdict.ts";

const job = { kind: "sn.launch" as const, scope: "sn" as const, partner: "sn" };
const NOW = 777;

test("done: the core's terminal row is repeated with the ids it recorded; the job is done", () => {
  const v = verdictFromRows(job, { status: "done", stage: "live", campaign_id: "c1", adset_id: "s1", ad_id: "a1", link: "https://l", gcm: "glo-snp_003", name: "N", finished_at: 500 }, NOW);
  assert.equal(v.status, "done");
  assert.equal(v.retryable, false);
  assert.equal(v.ambiguous, false);
  assert.deepEqual(v.result, { campaign_id: "c1", adset_id: "s1", ad_id: "a1", link: "https://l", gcm: "glo-snp_003", name: "N" });
  assert.deepEqual(v.row, { srv: 1, partner: "sn", retry: 0, status: "done", stage: "live", error: null, finished_at: 500, campaign_id: "c1", adset_id: "s1", ad_id: "a1", link: "https://l", gcm: "glo-snp_003", name: "N" });
  // a done row with a note (skipped creatives) keeps the note
  assert.equal(verdictFromRows(job, { status: "done", error: "creative #2 skipped: too big" }, NOW).row.error, "creative #2 skipped: too big");
  // no stage written → the kind's done stage
  assert.equal(verdictFromRows({ ...job, kind: "gg.clone", scope: "gg", partner: "gg" }, { status: "done" }, NOW).row.stage, "sent");
});

test("error with nothing created (no campaign, no partner task id) is retryable; with an id it is final", () => {
  const clean = verdictFromRows(job, { status: "error", stage: "key", error: "no free key", finished_at: 600 }, NOW);
  assert.deepEqual([clean.status, clean.retryable, clean.ambiguous, clean.result], ["error", true, false, null]);
  assert.deepEqual(clean.row, { srv: 1, partner: "sn", retry: 1, status: "error", stage: "key", error: "no free key", finished_at: 600 });
  const partial = verdictFromRows(job, { status: "error", stage: "adsquad", error: "refused", campaign_id: "c1", gcm: "glo-snp_004" }, NOW);
  assert.equal(partial.retryable, false, "a campaign exists — a blind re-run would build a second one");
  assert.equal(partial.row.retry, 0);
  assert.deepEqual(partial.result, { campaign_id: "c1", gcm: "glo-snp_004" });
  const sent = verdictFromRows({ ...job, kind: "tt.launch", scope: "tt", partner: "tt" }, { status: "error", stage: "lion", error: "LION failed", link: "task-9" }, NOW);
  assert.equal(sent.retryable, false, "a partner task id means a submit landed");
});

test("interrupted (the core's ambiguous outcome) is final, never retried, and keeps the drawer's interrupted status", () => {
  const v = verdictFromRows(job, { status: "interrupted", stage: "campaign", error: "Ambiguous outcome (socket hang up)", gcm: "glo-snp_005" }, NOW);
  assert.deepEqual([v.status, v.retryable, v.ambiguous], ["error", false, false]);
  assert.equal(v.row.status, "interrupted");
  assert.equal(v.row.retry, 0);
  assert.deepEqual(v.result, { gcm: "glo-snp_005" });
});

test("no terminal write at all → ambiguous: flags-only row, an interrupted open-row, never retryable", () => {
  const v = verdictFromRows(job, { stage: "media", gcm: "glo-snp_006" }, NOW);
  assert.equal(v.ambiguous, true);
  assert.equal(v.retryable, false);
  assert.deepEqual(v.row, { srv: 1, partner: "sn", retry: 0 });
  assert.equal(v.openRow?.status, "interrupted");
  assert.equal(v.openRow?.stage, "media");
  assert.equal(v.openRow?.gcm, "glo-snp_006");
  assert.equal(v.openRow?.finished_at, NOW);
  assert.equal(verdictFromRows(job, {}, NOW).result, null);
});
