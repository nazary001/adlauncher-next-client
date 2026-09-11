// Node's built-in runner (v24 strips types natively): `node --test tests/launch-stream.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { drainNdjson, isLaunchStream, launchOutcome, parseEvent } from "../lib/launch-stream.ts";

test("a pre-stream rejection (one JSON object, no newline) is a verdict, not a cut stream", () => {
  const raw = '{"ok":false,"stage":"media","error":"image fetch failed (HTTP 404)"}';
  const { events, rest } = drainNdjson(raw);
  assert.equal(events.length, 0);
  assert.equal(rest, raw); // the splitter leaves it as the unterminated tail…
  const out = launchOutcome({ status: 400, streamed: false, final: parseEvent(rest) }); // …which still counts
  assert.equal(out.ok, false);
  assert.equal(out.text, "image fetch failed (HTTP 404) · HTTP 400");
  assert.equal(out.creativeConsumed, false); // the run never started → the staged creative survives
});

test("a streamed failure names the stage error and consumes the creative", () => {
  const raw = '{"stage":"gcm"}\n{"ok":false,"stage":"error","error":"gcm pool exhausted — no free code 01–200","created":{}}\n';
  const { events, rest } = drainNdjson(raw);
  assert.equal(rest, "");
  const final = events.filter((e) => e.ok !== undefined).at(-1) ?? null;
  const out = launchOutcome({ status: 200, streamed: true, final });
  assert.equal(out.ok, false);
  assert.equal(out.text, "gcm pool exhausted — no free code 01–200");
  assert.equal(out.creativeConsumed, true);
});

test("a streamed success reports the claimed code", () => {
  const { events } = drainNdjson('{"stage":"gcm"}\n{"stage":"ad","done":1,"total":1}\n{"ok":true,"stage":"done","gcm":"01","link":"https://x/y?gcm=01"}\n');
  const final = events.filter((e) => e.ok !== undefined).at(-1) ?? null;
  const out = launchOutcome({ status: 200, streamed: true, final });
  assert.equal(out.ok, true);
  assert.equal(out.text, "Live · gcm 01");
});

test("a cut stream is ambiguous: no verdict, creative treated as consumed", () => {
  const out = launchOutcome({ status: 200, streamed: true, final: null });
  assert.equal(out.ok, false);
  assert.match(out.text, /stream ended without a verdict \(HTTP 200\)/);
  assert.equal(out.creativeConsumed, true);
});

test("a platform error page (no JSON) is a rejection carrying the HTTP status", () => {
  assert.equal(parseEvent("An error occurred with this function"), null);
  const out = launchOutcome({ status: 504, streamed: false, final: null });
  assert.equal(out.ok, false);
  assert.match(out.text, /HTTP 504/);
  assert.equal(out.creativeConsumed, false);
});

test("chunk boundaries: a line split across reads is parsed once complete", () => {
  let buf = "";
  const got: string[] = [];
  for (const chunk of ['{"stage":"gc', 'm"}\n{"sta', 'ge":"video"}\n']) {
    buf += chunk;
    const { events, rest } = drainNdjson(buf);
    buf = rest;
    for (const e of events) if (e.stage) got.push(e.stage);
  }
  assert.deepEqual(got, ["gcm", "video"]);
  assert.equal(buf, "");
});

test("garbage lines never throw and never count as a verdict", () => {
  const { events } = drainNdjson('not json\n\n{"stage":"campaign"}\n42\n');
  assert.deepEqual(events, [{ stage: "campaign" }]);
});

test("content-type sniffing", () => {
  assert.equal(isLaunchStream("application/x-ndjson; charset=utf-8"), true);
  assert.equal(isLaunchStream("application/json"), false);
  assert.equal(isLaunchStream(null), false);
});
