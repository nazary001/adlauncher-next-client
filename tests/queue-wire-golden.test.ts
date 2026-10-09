// Node's built-in runner (v24 strips types natively): `node --test tests/queue-wire-golden.test.ts`.
//
// WHY THIS FILE EXISTS — jobs outlive the build that queued them. The owner ships an update while a
// 40-campaign wave is still queued (or rolls one back), and the new code then runs jobs the OLD
// browser handed over, minutes or hours earlier. So the shapes below are a promise, not a snapshot:
// tests/fixtures/queue-wire-v1.json holds hand-off requests exactly as the browser of 08.10.2026
// sends them (the HS and MO ones are real requests of that day with the ids replaced), together
// with what the server made of them then.
//
// If this test fails you changed how an EXISTING hand-off is read or what its handler receives.
// Either keep the old shape working (the usual answer), or — when old code could now MISREAD new
// documents — bump JOB_SCHEMA_VERSION (lib/launch-queue-types.ts) and add a NEW fixture file for the
// new shape. Never edit queue-wire-v1.json to make the test pass: jobs of that shape may be sitting
// in production's queue right now.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  HANDLER_KINDS,
  JOB_SCHEMA_VERSION,
  handlerBody,
  jobMediaUrls,
  parseEnqueue,
  unsupportedReason,
  type EnqueueInput,
} from "../lib/launch-queue-types.ts";
import { isOwnCreativeUrl } from "../lib/creative-url.ts";

type Case = {
  name: string;
  request: unknown;
  expect: { value: EnqueueInput; handlerBodies: Record<string, unknown>[]; mediaUrls: string[][] };
};
const golden = JSON.parse(readFileSync(new URL("./fixtures/queue-wire-v1.json", import.meta.url), "utf8")) as { cases: Case[] };
const ENV = { CREATIVES_S3_BUCKET: "gc-adlauncher-creatives", CREATIVES_S3_REGION: "eu-central-1" };

test("the fixture covers every job kind a BROWSER hands over (the wave routes queue the other kinds themselves — their bodies never cross the wire)", () => {
  const kinds = new Set(golden.cases.flatMap((c) => c.expect.value.jobs.map((j) => j.kind)));
  assert.deepEqual([...kinds].sort(), [...HANDLER_KINDS].sort());
});

for (const c of golden.cases) {
  test(`golden v1 · ${c.name}`, () => {
    const parsed = parseEnqueue(structuredClone(c.request));
    assert.ok(parsed.ok, `a hand-off the 08.10 browser sends must still be accepted: ${parsed.ok ? "" : parsed.error}`);
    assert.deepEqual(parsed.value, c.expect.value, "the normalized jobs are what they were");
    parsed.value.jobs.forEach((j, i) => {
      assert.deepEqual(handlerBody({ kind: j.kind, body: j.body, job_id: j.taskId }), c.expect.handlerBodies[i], `job ${i + 1}: the handler still receives the same request body`);
      const media = jobMediaUrls(j.kind, j.body);
      assert.deepEqual(media, c.expect.mediaUrls[i], `job ${i + 1}: the same creative links are read out of it`);
      for (const u of media) assert.ok(isOwnCreativeUrl(u, ENV), `job ${i + 1}: ${u.slice(-40)} still passes the creative fence`);
      // A job stored from this request — with or without the version field — is runnable by this build.
      assert.equal(unsupportedReason({ kind: j.kind }), null);
      assert.equal(unsupportedReason({ kind: j.kind, v: 1 }), null);
    });
  });
}

test("the version this build writes is the one the fixture was taken at — or a newer fixture file exists", () => {
  // When you bump JOB_SCHEMA_VERSION, add tests/fixtures/queue-wire-v<N>.json and a block for it here.
  assert.equal(JOB_SCHEMA_VERSION, 1);
});
