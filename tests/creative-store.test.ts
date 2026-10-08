// Node's built-in runner (v24 strips types natively): `node --test tests/creative-store.test.ts`.
// The decision core of the S3 creative store, driven by a FAKE CreativeS3Ops (no network). Plus one
// test of the REAL bindings: presigning is offline, so we PROVE the presigned URLs sign Content-Type
// + host and carry NO checksum parameter (the AWS SDK ≥ 3.729 CRC32 trap that fails every browser PUT).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  type CreativeS3Ops,
  abortUpload,
  completeUpload,
  creativeOwnerTag,
  creativeRefusalStatus,
  creativesConfigured,
  planUpload,
  putBytes,
  realCreativeS3Ops,
} from "../lib/creative-store.ts";
import { CREATIVE_MAX_BYTES, CREATIVE_PART_BYTES, isContentKey } from "../lib/creative-url.ts";

const env = { CREATIVES_S3_BUCKET: "b", CREATIVES_S3_REGION: "eu-central-1" };
const S3 = "https://b.s3.eu-central-1.amazonaws.com";
const SHA = "a".repeat(64);
const MB = 1024 * 1024;

type Calls = {
  head: string[];
  presignPut: { key: string; mime: string }[];
  createMultipart: { key: string; mime: string }[];
  presignPart: { key: string; uploadId: string; n: number }[];
  complete: { key: string; uploadId: string; parts: { n: number; etag: string }[] }[];
  abort: { key: string; uploadId: string }[];
  put: { key: string; mime: string; len: number }[];
};

function fake(over: Partial<CreativeS3Ops> = {}): { ops: CreativeS3Ops; calls: Calls } {
  const calls: Calls = { head: [], presignPut: [], createMultipart: [], presignPart: [], complete: [], abort: [], put: [] };
  const base: CreativeS3Ops = {
    async head(key) {
      calls.head.push(key);
      return null;
    },
    async presignPut(key, mime) {
      calls.presignPut.push({ key, mime });
      return `https://put/${key}`;
    },
    async createMultipart(key, mime) {
      calls.createMultipart.push({ key, mime });
      return "UP-1";
    },
    async presignPart(key, uploadId, n) {
      calls.presignPart.push({ key, uploadId, n });
      return `https://part/${key}/${n}`;
    },
    async complete(key, uploadId, parts) {
      calls.complete.push({ key, uploadId, parts });
    },
    async abort(key, uploadId) {
      calls.abort.push({ key, uploadId });
    },
    async put(key, mime, bytes) {
      calls.put.push({ key, mime, len: bytes.length });
    },
  };
  return { ops: { ...base, ...over }, calls };
}

// ---------- plan ----------

test("plan single: content-addressed key, signed Content-Type header, public URL", async () => {
  const { ops, calls } = fake();
  const r = await planUpload(ops, { size: MB, type: "video/mp4", name: "a.mp4", sha256: SHA }, env);
  assert.equal(r.ok, true);
  if (!r.ok || r.state !== "single") return assert.fail(`expected single, got ${JSON.stringify(r)}`);
  assert.equal(r.key, `creatives/${SHA}-${MB}.mp4`);
  assert.equal(r.url, `${S3}/${r.key}`);
  assert.deepEqual(r.headers, { "content-type": "video/mp4" });
  assert.ok(r.putUrl);
  assert.deepEqual(calls.head, [r.key]); // a content key is checked for reuse first
  assert.equal(calls.presignPut.length, 1);
});

test("plan multipart: one presigned URL per part, partSize + uploadId returned", async () => {
  const { ops, calls } = fake();
  const size = 40 * MB; // > 32 MB → multipart
  const r = await planUpload(ops, { size, type: "video/mp4", name: "a.mp4", sha256: SHA }, env);
  if (!r.ok || r.state !== "multipart") return assert.fail(`expected multipart, got ${JSON.stringify(r)}`);
  assert.equal(r.uploadId, "UP-1");
  assert.equal(r.partSize, CREATIVE_PART_BYTES);
  assert.equal(r.parts.length, 3); // ceil(40 / 16)
  assert.deepEqual(
    r.parts.map((p) => p.n),
    [1, 2, 3],
  );
  r.parts.forEach((p) => assert.ok(p.url));
  assert.equal(calls.createMultipart.length, 1);
  assert.equal(calls.presignPart.length, 3);
});

test("plan exists: a young object of the exact size is reused — no presign", async () => {
  const size = MB;
  const { ops, calls } = fake({ async head() { return { contentLength: size, lastModified: new Date() }; } });
  const r = await planUpload(ops, { size, type: "video/mp4", name: "a.mp4", sha256: SHA }, env);
  if (!r.ok || r.state !== "exists") return assert.fail(`expected exists, got ${JSON.stringify(r)}`);
  assert.equal(r.key, `creatives/${SHA}-${size}.mp4`);
  assert.equal(r.url, `${S3}/${r.key}`);
  assert.equal(calls.presignPut.length, 0);
});

test("plan reuse rules: size mismatch, too old, and a HEAD hiccup all plan a fresh upload", async () => {
  const size = MB;
  // Size mismatch → not the same bytes.
  let r = await planUpload(fake({ async head() { return { contentLength: size + 1, lastModified: new Date() }; } }).ops, { size, type: "video/mp4", name: "a.mp4", sha256: SHA }, env);
  assert.equal(r.ok && r.state, "single");
  // Older than the reuse window → re-upload so it can never hit the 14-day expiry before launch.
  r = await planUpload(fake({ async head() { return { contentLength: size, lastModified: new Date(Date.now() - 10 * 24 * 3600 * 1000) }; } }).ops, { size, type: "video/mp4", name: "a.mp4", sha256: SHA }, env);
  assert.equal(r.ok && r.state, "single");
  // A HEAD that throws must NOT fail the attach — plan fresh.
  const thrower = fake({ async head() { throw new Error("transient 503"); } });
  r = await planUpload(thrower.ops, { size, type: "video/mp4", name: "a.mp4", sha256: SHA }, env);
  assert.equal(r.ok && r.state, "single");
  assert.equal(thrower.calls.presignPut.length, 1);
});

test("plan: a sha with a file above the hash ceiling is ignored → random key, HEAD never called", async () => {
  const size = 257 * MB; // > 256 MB hash ceiling, < 500 MB limit
  const { ops, calls } = fake({ async head() { throw new Error("HEAD must not be called for a random key"); } });
  const r = await planUpload(ops, { size, type: "video/mp4", name: "a.mp4", sha256: SHA }, env);
  if (!r.ok || r.state !== "multipart") return assert.fail(`expected multipart, got ${JSON.stringify(r)}`);
  assert.match(r.key, /^creatives\/u-[a-z0-9]{16,}\.mp4$/);
  assert.equal(calls.head.length, 0);
});

test("plan refusals carry the machine_word — human sentence wording", async () => {
  const { ops } = fake();
  let r = await planUpload(ops, { size: 1000, type: "video/x-matroska", name: "a.mkv" }, env);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /^unsupported_type — MKV is not supported here; use MP4, MOV or WebM for a video, JPG, PNG, GIF or WebP for an image$/);
  r = await planUpload(ops, { size: CREATIVE_MAX_BYTES + 1, type: "video/mp4", name: "a.mp4" }, env);
  if (!r.ok) assert.match(r.error, /^too_large — \d+ MB is over the 500 MB limit$/);
  r = await planUpload(ops, { size: 0, type: "video/mp4", name: "a.mp4" }, env);
  if (!r.ok) assert.match(r.error, /^bad_size —/);
  r = await planUpload(ops, { size: 1.5, type: "video/mp4", name: "a.mp4" }, env);
  if (!r.ok) assert.match(r.error, /^bad_size —/);
});

test("plan: an S3 presign failure comes back as a store_error, never a throw", async () => {
  const { ops } = fake({ async presignPut() { throw new Error("kms down"); } });
  const r = await planUpload(ops, { size: MB, type: "video/mp4", name: "a.mp4", sha256: SHA }, env);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /^store_error —/);
    assert.equal(creativeRefusalStatus(r.error), 502);
  }
});

test("plan: not configured → creatives_not_configured (503 class), no S3 touched", async () => {
  const { ops, calls } = fake();
  const r = await planUpload(ops, { size: MB, type: "video/mp4", name: "a.mp4", sha256: SHA }, {});
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(creativeRefusalStatus(r.error), 503);
  assert.equal(calls.head.length + calls.presignPut.length + calls.createMultipart.length, 0);
});

// ---------- complete ----------

test("complete validation rejects a bad key, no parts, bad upload id, bad numbering, missing ETag", async () => {
  const { ops } = fake();
  const key = `creatives/${SHA}-${MB}.mp4`;
  assert.match((await completeUpload(ops, { key: "../x", uploadId: "U", parts: [{ n: 1, etag: "e" }] }, env)).error ?? "", /^bad_key/);
  assert.match((await completeUpload(ops, { key, uploadId: "", parts: [{ n: 1, etag: "e" }] }, env)).error ?? "", /^bad_upload_id/);
  assert.match((await completeUpload(ops, { key, uploadId: "U", parts: [] }, env)).error ?? "", /^bad_parts/);
  assert.match((await completeUpload(ops, { key, uploadId: "U", parts: [{ n: 1, etag: "e" }, { n: 1, etag: "f" }] }, env)).error ?? "", /^bad_parts/);
  assert.match((await completeUpload(ops, { key, uploadId: "U", parts: [{ n: 0, etag: "e" }] }, env)).error ?? "", /^bad_parts/);
  assert.match((await completeUpload(ops, { key, uploadId: "U", parts: [{ n: 10001, etag: "e" }] }, env)).error ?? "", /^bad_parts/);
  assert.match((await completeUpload(ops, { key, uploadId: "U", parts: [{ n: 1, etag: "" }] }, env)).error ?? "", /^bad_parts/);
});

test("complete: parts are sorted and ETags get their quotes back, then HeadObject confirms", async () => {
  const key = `creatives/${SHA}-${MB}.mp4`;
  const { ops, calls } = fake({ async head() { return { contentLength: MB, lastModified: new Date() }; } });
  const r = await completeUpload(ops, { key, uploadId: "U", parts: [{ n: 2, etag: "abc" }, { n: 1, etag: '"def"' }] }, env);
  assert.deepEqual(r, { ok: true, key, url: `${S3}/${key}` });
  assert.equal(calls.complete.length, 1);
  // Sorted ascending, and the bare "abc" was re-quoted while the already-quoted "def" was kept.
  assert.deepEqual(calls.complete[0].parts, [{ n: 1, etag: '"def"' }, { n: 2, etag: '"abc"' }]);
});

test("complete: a HEAD miss after completing is reported, not silently OK", async () => {
  const key = `creatives/${SHA}-${MB}.mp4`;
  const { ops } = fake(); // default head → null
  const r = await completeUpload(ops, { key, uploadId: "U", parts: [{ n: 1, etag: "e" }] }, env);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /^store_error —/);
});

test("complete: a CompleteMultipartUpload failure is a store_error, never a throw", async () => {
  const key = `creatives/${SHA}-${MB}.mp4`;
  const { ops } = fake({ async complete() { throw new Error("EntityTooSmall"); } });
  const r = await completeUpload(ops, { key, uploadId: "U", parts: [{ n: 1, etag: "e" }] }, env);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /^store_error —/);
});

test("complete: not configured", async () => {
  const { ops } = fake();
  const r = await completeUpload(ops, { key: `creatives/${SHA}-${MB}.mp4`, uploadId: "U", parts: [{ n: 1, etag: "e" }] }, {});
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(creativeRefusalStatus(r.error), 503);
});

// ---------- abort ----------

test("abort is best-effort: it swallows a failure and skips a key that is not ours", async () => {
  let aborted = 0;
  const thrower: CreativeS3Ops = { ...fake().ops, async abort() { aborted++; throw new Error("no such upload"); } };
  await assert.doesNotReject(abortUpload(thrower, { key: `creatives/${SHA}-${MB}.mp4`, uploadId: "U" }));
  assert.equal(aborted, 1); // it was called, and the failure was swallowed
  const guarded = fake();
  await abortUpload(guarded.ops, { key: "../evil", uploadId: "U" });
  assert.equal(guarded.calls.abort.length, 0); // never touch S3 for a foreign key
});

// ---------- putBytes ----------

test("putBytes: content-addressed PutObject, returns the public URL", async () => {
  const { ops, calls } = fake();
  const bytes = Buffer.from("hello world image bytes");
  const url = await putBytes(ops, bytes, { type: "image/png", name: "gen.png" }, env);
  assert.equal(calls.put.length, 1);
  assert.equal(calls.put[0].mime, "image/png");
  assert.match(url, new RegExp(`^${S3.replace(/\./g, "\\.")}/creatives/[0-9a-f]{64}-${bytes.length}\\.png$`));
});

test("putBytes throws on an unsupported type, an empty buffer and when not configured", async () => {
  const { ops } = fake();
  await assert.rejects(putBytes(ops, Buffer.from("x"), { type: "application/pdf", name: "a.pdf" }, env), /^Error: unsupported_type/);
  await assert.rejects(putBytes(ops, Buffer.alloc(0), { type: "image/png", name: "a.png" }, env), /^Error: bad_size/);
  await assert.rejects(putBytes(ops, Buffer.from("x"), { type: "image/png", name: "a.png" }, {}), /creatives_not_configured/);
});

// ---------- status classifier ----------

test("creativeRefusalStatus maps machine words to HTTP status", () => {
  assert.equal(creativeRefusalStatus("unsupported_type — x"), 400);
  assert.equal(creativeRefusalStatus("too_large — x"), 400);
  assert.equal(creativeRefusalStatus("bad_size — x"), 400);
  assert.equal(creativeRefusalStatus("bad_key — x"), 400);
  assert.equal(creativeRefusalStatus("bad_parts — x"), 400);
  assert.equal(creativeRefusalStatus("bad_upload_id — x"), 400);
  assert.equal(creativeRefusalStatus("creatives_not_configured — x"), 503);
  assert.equal(creativeRefusalStatus("store_error — x"), 502);
  assert.equal(creativeRefusalStatus("anything_else — x"), 502);
});

// ---------- configuration ----------

test("creativesConfigured needs the bucket and both credentials", () => {
  const keys = ["CREATIVES_S3_BUCKET", "CREATIVES_S3_ACCESS_KEY_ID", "CREATIVES_S3_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    assert.equal(creativesConfigured(), false);
    process.env.CREATIVES_S3_BUCKET = "b";
    assert.equal(creativesConfigured(), false); // bucket alone is not enough
    process.env.CREATIVES_S3_ACCESS_KEY_ID = "AK";
    process.env.CREATIVES_S3_SECRET_ACCESS_KEY = "SK";
    assert.equal(creativesConfigured(), true);
    // The AWS_* fallback covers the signer credentials for local runs.
    delete process.env.CREATIVES_S3_ACCESS_KEY_ID;
    delete process.env.CREATIVES_S3_SECRET_ACCESS_KEY;
    process.env.AWS_ACCESS_KEY_ID = "AK";
    process.env.AWS_SECRET_ACCESS_KEY = "SK";
    assert.equal(creativesConfigured(), true);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

// ---------- the real bindings: offline presign proof (the CRC32 trap) ----------

test("real presigned PUT signs content-type + host and carries NO checksum parameter", async () => {
  const keys = ["CREATIVES_S3_BUCKET", "CREATIVES_S3_REGION", "CREATIVES_S3_ACCESS_KEY_ID", "CREATIVES_S3_SECRET_ACCESS_KEY"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    process.env.CREATIVES_S3_BUCKET = "gc-adlauncher-creatives";
    process.env.CREATIVES_S3_REGION = "eu-central-1";
    process.env.CREATIVES_S3_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
    process.env.CREATIVES_S3_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const key = `creatives/${SHA}-300.mp4`;

    const putUrl = await realCreativeS3Ops.presignPut(key, "video/mp4");
    const put = new URL(putUrl);
    const signed = (put.searchParams.get("X-Amz-SignedHeaders") ?? "").toLowerCase();
    assert.match(signed, /content-type/);
    assert.match(signed, /host/);
    assert.ok(!putUrl.toLowerCase().includes("x-amz-checksum"), "PUT URL must not carry an x-amz-checksum parameter");
    assert.ok(!put.searchParams.has("x-amz-sdk-checksum-algorithm"), "PUT URL must not carry x-amz-sdk-checksum-algorithm");

    // A part URL: no checksum parameter either.
    const partUrl = await realCreativeS3Ops.presignPart(key, "UPLOAD-ID-xyz", 1);
    const part = new URL(partUrl);
    assert.ok(!partUrl.toLowerCase().includes("x-amz-checksum"), "part URL must not carry an x-amz-checksum parameter");
    assert.ok(!part.searchParams.has("x-amz-sdk-checksum-algorithm"), "part URL must not carry x-amz-sdk-checksum-algorithm");
    assert.match((part.searchParams.get("X-Amz-SignedHeaders") ?? "").toLowerCase(), /host/);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

// ---------- the uploader's namespace (review find 08.10) ----------
// The browser's sha256 is the client's word — S3 does not check the bytes against it. So a content
// key is namespaced by who uploaded it: "these bytes are already here" is only ever answered from
// that same buyer's own objects, and no login can park bytes under a key a colleague will reuse.

test("owner tag: stable, opaque, 12 hex — different buyers differ, no username → none", () => {
  const a = creativeOwnerTag("alice");
  assert.match(a ?? "", /^[0-9a-f]{12}$/);
  assert.equal(creativeOwnerTag("alice"), a, "stable for the same buyer");
  assert.notEqual(creativeOwnerTag("bob"), a);
  assert.notEqual(creativeOwnerTag("Alice"), a, "usernames are taken as they are");
  assert.equal(creativeOwnerTag(""), null);
  assert.equal(creativeOwnerTag(null), null);
  assert.equal(creativeOwnerTag(undefined), null);
  // Two teams share the bucket (lib/team): the same username on another team is another namespace,
  // while the first team's tag — an empty namespace — is the pre-team formula, byte for byte.
  assert.equal(creativeOwnerTag("alice", ""), a);
  assert.notEqual(creativeOwnerTag("alice", "glo-02"), a);
  assert.match(String(creativeOwnerTag("alice", "glo-02")), /^[0-9a-f]{12}$/);
  assert.notEqual(creativeOwnerTag("alice", "glo-02"), creativeOwnerTag("alice", "glo-03"));
});

test("plan: the same sha from two buyers lands on two different keys", async () => {
  const { ops } = fake();
  const a = await planUpload(ops, { size: MB, type: "video/mp4", name: "a.mp4", sha256: SHA }, env, "alice");
  const b = await planUpload(ops, { size: MB, type: "video/mp4", name: "a.mp4", sha256: SHA }, env, "bob");
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;
  assert.equal(a.key, `creatives/${SHA}-${MB}-${creativeOwnerTag("alice")}.mp4`);
  assert.equal(b.key, `creatives/${SHA}-${MB}-${creativeOwnerTag("bob")}.mp4`);
  assert.notEqual(a.key, b.key);
  assert.ok(isContentKey(a.key), "still a content-addressed key (reuse / media cache by key keep working)");
});

test("plan: 'exists' is answered only from the SAME buyer's object — a colleague's object under that hash is never reused", async () => {
  const size = MB;
  const aliceKey = `creatives/${SHA}-${size}-${creativeOwnerTag("alice")}.mp4`;
  const { ops, calls } = fake({
    async head(key) {
      calls.head.push(key);
      // only alice ever uploaded these bytes (or bytes CLAIMED to be these)
      return key === aliceKey ? { contentLength: size, lastModified: new Date() } : null;
    },
  });
  const again = await planUpload(ops, { size, type: "video/mp4", name: "a.mp4", sha256: SHA }, env, "alice");
  assert.ok(again.ok && again.state === "exists", "alice re-attaching her own file: nothing to send");
  const bob = await planUpload(ops, { size, type: "video/mp4", name: "a.mp4", sha256: SHA }, env, "bob");
  assert.ok(bob.ok && bob.state === "single", "bob uploads his own copy — he is never handed alice's object");
  assert.deepEqual(calls.head, [aliceKey, `creatives/${SHA}-${size}-${creativeOwnerTag("bob")}.mp4`]);
});

test("plan without a buyer (server-side callers): an untagged content key", async () => {
  const { ops } = fake();
  const r = await planUpload(ops, { size: MB, type: "video/mp4", name: "a.mp4", sha256: SHA }, env);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.key, `creatives/${SHA}-${MB}.mp4`);
});
