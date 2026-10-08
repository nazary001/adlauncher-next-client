// Node's built-in runner (v24 strips types natively): `node --test tests/creative-url.test.ts`.
// The pure half of the creative store. isOwnCreativeUrl is a SECURITY BOUNDARY: the server fetches
// bytes from any URL that passes it and hands it to Meta / TOOL as a download source, so the fence
// is tested hostilely — foreign hosts, look-alikes, userinfo, ports, queries, fragments, encoded
// traversal, double slashes, nested paths, and keys that are not ours must all be rejected.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CREATIVE_HASH_MAX_BYTES,
  CREATIVE_MAX_BYTES,
  CREATIVE_PART_BYTES,
  creativeBases,
  creativeKeyOf,
  creativeObjectKey,
  creativeParts,
  creativePublicBase,
  creativeTypeOf,
  creativeUrl,
  isContentKey,
  isCreativeKey,
  isLegacyBlobUrl,
  isOwnCreativeUrl,
} from "../lib/creative-url.ts";

const BUCKET = "gc-adlauncher-creatives";
const env = { CREATIVES_S3_BUCKET: BUCKET, CREATIVES_S3_REGION: "eu-central-1", CREATIVES_PUBLIC_BASE: "https://cdn.example.com" };
const S3 = `https://${BUCKET}.s3.eu-central-1.amazonaws.com`;
const CDN = "https://cdn.example.com";

const CONTENT_KEY = `creatives/${"a".repeat(64)}-300.mp4`;
const RANDOM_KEY = "creatives/u-abcdef0123456789.mp4";
const KEEP_KEY = `keep/${"b".repeat(64)}-512.png`;

test("fence accepts our bucket origin and the public base, both prefixes", () => {
  for (const base of [S3, CDN]) {
    for (const key of [CONTENT_KEY, RANDOM_KEY, KEEP_KEY]) {
      assert.equal(creativeKeyOf(`${base}/${key}`, env), key, `${base}/${key}`);
      assert.equal(isOwnCreativeUrl(`${base}/${key}`, env), true, `${base}/${key}`);
    }
  }
});

test("creativeBases returns both origins; URL building uses the public base", () => {
  assert.deepEqual(new Set(creativeBases(env)), new Set([CDN, S3]));
  assert.equal(creativePublicBase(env), CDN);
  assert.equal(creativeUrl(CONTENT_KEY, env), `${CDN}/${CONTENT_KEY}`);
});

test("fence rejects http", () => {
  assert.equal(isOwnCreativeUrl(`http://${BUCKET}.s3.eu-central-1.amazonaws.com/${CONTENT_KEY}`, env), false);
});

test("fence rejects a different bucket and a different region host", () => {
  assert.equal(isOwnCreativeUrl(`https://evil.s3.eu-central-1.amazonaws.com/${CONTENT_KEY}`, env), false);
  assert.equal(isOwnCreativeUrl(`https://${BUCKET}.s3.us-east-1.amazonaws.com/${CONTENT_KEY}`, env), false);
});

test("fence rejects look-alike host suffix and prefix", () => {
  assert.equal(isOwnCreativeUrl(`https://${BUCKET}.s3.eu-central-1.amazonaws.com.evil.com/${CONTENT_KEY}`, env), false);
  assert.equal(isOwnCreativeUrl(`https://evil-${BUCKET}.s3.eu-central-1.amazonaws.com/${CONTENT_KEY}`, env), false);
});

test("fence rejects userinfo and a non-default port", () => {
  assert.equal(isOwnCreativeUrl(`https://user:pass@${BUCKET}.s3.eu-central-1.amazonaws.com/${CONTENT_KEY}`, env), false);
  // A genuinely different port is a different origin → rejected. (`:443` is the canonical https port:
  // the URL parser normalises it away, so it resolves to the real bucket origin and is safe to accept.)
  assert.equal(isOwnCreativeUrl(`https://${BUCKET}.s3.eu-central-1.amazonaws.com:8443/${CONTENT_KEY}`, env), false);
});

test("fence rejects a query string and a fragment (a smuggled second target)", () => {
  assert.equal(isOwnCreativeUrl(`${S3}/${CONTENT_KEY}?x=1`, env), false);
  assert.equal(isOwnCreativeUrl(`${S3}/${CONTENT_KEY}#frag`, env), false);
});

test("fence rejects encoded traversal (%2e%2e, %2F), double slashes and nested paths", () => {
  assert.equal(isOwnCreativeUrl(`${S3}/%2e%2e/creatives/x.mp4`, env), false);
  assert.equal(isOwnCreativeUrl(`${S3}/creatives/a%2Fb.mp4`, env), false);
  assert.equal(isOwnCreativeUrl(`${S3}/creatives//x.mp4`, env), false);
  assert.equal(isOwnCreativeUrl(`${S3}/creatives/a/b.mp4`, env), false);
});

test("fence rejects an empty key, an upper-case key and a key outside the two prefixes", () => {
  assert.equal(isOwnCreativeUrl(`${S3}/creatives/`, env), false);
  assert.equal(isOwnCreativeUrl(`${S3}/creatives/ABCDEFG.mp4`, env), false);
  assert.equal(isOwnCreativeUrl(`${S3}/other/${"a".repeat(64)}-300.mp4`, env), false);
  assert.equal(isOwnCreativeUrl(`${S3}/uploads/x.mp4`, env), false);
});

test("fence rejects outright garbage", () => {
  assert.equal(isOwnCreativeUrl("not a url", env), false);
  assert.equal(creativeKeyOf("not a url", env), null);
});

test("legacy Blob URLs pass only the legacy checks, never creativeKeyOf", () => {
  const blob = "https://abc123.public.blob.vercel-storage.com/creatives/999-video.mp4";
  assert.equal(isLegacyBlobUrl(blob), true);
  assert.equal(isOwnCreativeUrl(blob, env), true);
  assert.equal(creativeKeyOf(blob, env), null);
  // A Blob-looking host that is NOT the vercel storage host, or a path outside /creatives/, is not legacy.
  assert.equal(isLegacyBlobUrl("https://abc.blob.vercel-storage.com.evil.com/creatives/x.mp4"), false);
  assert.equal(isLegacyBlobUrl("https://abc.public.blob.vercel-storage.com/other/x.mp4"), false);
});

test("store not configured: no bases, no URL, fence false (except legacy Blob)", () => {
  assert.deepEqual(creativeBases({}), []);
  assert.equal(creativePublicBase({}), null);
  assert.throws(() => creativeUrl(CONTENT_KEY, {}), /creatives_not_configured/);
  assert.equal(isOwnCreativeUrl(`${S3}/${CONTENT_KEY}`, {}), false);
  assert.equal(isOwnCreativeUrl("https://abc.public.blob.vercel-storage.com/creatives/x.mp4", {}), true);
});

test("creativeTypeOf matrix: declared MIME, normalisation, extension fallback, refusals", () => {
  assert.deepEqual(creativeTypeOf("video/mp4", "a.mp4"), { mime: "video/mp4", ext: "mp4", kind: "video" });
  assert.deepEqual(creativeTypeOf("video/quicktime", "a.mov"), { mime: "video/quicktime", ext: "mov", kind: "video" });
  assert.deepEqual(creativeTypeOf("video/webm", "a.webm"), { mime: "video/webm", ext: "webm", kind: "video" });
  assert.deepEqual(creativeTypeOf("image/png", "a.png"), { mime: "image/png", ext: "png", kind: "image" });
  assert.deepEqual(creativeTypeOf("image/jpeg", "a.jpg"), { mime: "image/jpeg", ext: "jpg", kind: "image" });
  // image/jpg + image/pjpeg normalise to image/jpeg.
  assert.deepEqual(creativeTypeOf("image/jpg", "a.jpg"), { mime: "image/jpeg", ext: "jpg", kind: "image" });
  assert.deepEqual(creativeTypeOf("image/pjpeg", "a.jpg"), { mime: "image/jpeg", ext: "jpg", kind: "image" });
  // Empty declared type → fall back to the file extension.
  assert.deepEqual(creativeTypeOf("", "clip.MP4"), { mime: "video/mp4", ext: "mp4", kind: "video" });
  assert.deepEqual(creativeTypeOf("  ", "pic.PNG"), { mime: "image/png", ext: "png", kind: "image" });
  // Refusals: a declared type we do not take, and an unknown extension with no declared type.
  assert.equal(creativeTypeOf("video/x-matroska", "a.mkv"), null);
  assert.equal(creativeTypeOf("application/pdf", "a.pdf"), null);
  assert.equal(creativeTypeOf("image/svg+xml", "a.svg"), null);
  assert.equal(creativeTypeOf("", "a.mkv"), null);
  assert.equal(creativeTypeOf("", "noext"), null);
});

test("creativeObjectKey: content-addressed when a sha rides, random otherwise, size witness", () => {
  const content = creativeObjectKey({ purpose: "creative", ext: "mp4", sha256: "a".repeat(64), size: 300, random: "unused" });
  assert.equal(content, `creatives/${"a".repeat(64)}-300.mp4`);
  assert.equal(isContentKey(content), true);
  // The byte size is a second witness baked into the key.
  const content2 = creativeObjectKey({ purpose: "creative", ext: "mp4", sha256: "a".repeat(64), size: 301, random: "unused" });
  assert.notEqual(content, content2);
  // keep/ prefix for remembered identities.
  const kept = creativeObjectKey({ purpose: "keep", ext: "png", sha256: "b".repeat(64), size: 10, random: "unusedtoken123456" });
  assert.ok(kept.startsWith("keep/"));
  // No sha → random key, never deduped; isContentKey false.
  const rnd = creativeObjectKey({ purpose: "creative", ext: "mp4", sha256: null, size: 300, random: "abcdef0123456789xyz" });
  assert.ok(/^creatives\/u-[a-z0-9]{16,}\.mp4$/.test(rnd), rnd);
  assert.equal(isContentKey(rnd), false);
  // An invalid sha falls through to the random branch too.
  const badSha = creativeObjectKey({ purpose: "creative", ext: "mp4", sha256: "nothex", size: 300, random: "abcdef0123456789xyz" });
  assert.ok(badSha.startsWith("creatives/u-"));
});

test("creativeObjectKey throws on a too-short random token (random branch only)", () => {
  assert.throws(() => creativeObjectKey({ purpose: "creative", ext: "mp4", sha256: null, size: 1, random: "short" }), /random token too short/);
  // With a valid sha the random is unused, so a short token is fine.
  assert.doesNotThrow(() => creativeObjectKey({ purpose: "creative", ext: "mp4", sha256: "c".repeat(64), size: 1, random: "x" }));
});

test("isCreativeKey accepts our two shapes and rejects traversal / nesting / case", () => {
  assert.equal(isCreativeKey(CONTENT_KEY), true);
  assert.equal(isCreativeKey(RANDOM_KEY), true);
  assert.equal(isCreativeKey(KEEP_KEY), true);
  assert.equal(isCreativeKey("creatives/../x.mp4"), false);
  assert.equal(isCreativeKey("creatives/a/b.mp4"), false);
  assert.equal(isCreativeKey("creatives/ABC.mp4"), false);
  assert.equal(isCreativeKey("other/x.mp4"), false);
});

test("creativeParts boundaries: exact multiple, one byte over, tiny file", () => {
  const p = CREATIVE_PART_BYTES;
  assert.equal(creativeParts(2 * p).count, 2);
  assert.deepEqual(creativeParts(2 * p).range(1), { start: 0, end: p });
  assert.deepEqual(creativeParts(2 * p).range(2), { start: p, end: 2 * p });
  assert.equal(creativeParts(2 * p + 1).count, 3);
  assert.deepEqual(creativeParts(2 * p + 1).range(3), { start: 2 * p, end: 2 * p + 1 });
  // A tiny file is still one part spanning its whole length.
  assert.equal(creativeParts(1).count, 1);
  assert.deepEqual(creativeParts(1).range(1), { start: 0, end: 1 });
});

test("the limits are the ones the store signs against", () => {
  assert.equal(CREATIVE_MAX_BYTES, 500 * 1024 * 1024);
  assert.equal(CREATIVE_HASH_MAX_BYTES, 256 * 1024 * 1024);
  assert.equal(CREATIVE_PART_BYTES, 16 * 1024 * 1024);
});

test("creativeObjectKey: an uploader tag namespaces a content key; a malformed tag is dropped, a random key never carries one", () => {
  const sha = "c".repeat(64);
  const tagged = creativeObjectKey({ purpose: "creative", ext: "mp4", sha256: sha, size: 10, random: "x", owner: "0123456789ab" });
  assert.equal(tagged, `creatives/${sha}-10-0123456789ab.mp4`);
  assert.ok(isCreativeKey(tagged));
  assert.ok(isContentKey(tagged));
  for (const bad of ["", "XYZ", "0123456789AB", "12", "0123456789abcdef0", "../x", null, undefined]) {
    assert.equal(creativeObjectKey({ purpose: "creative", ext: "mp4", sha256: sha, size: 10, random: "x", owner: bad as string }), `creatives/${sha}-10.mp4`, String(bad));
  }
  const rnd = creativeObjectKey({ purpose: "keep", ext: "png", size: 10, random: "0123456789abcdef0123", owner: "0123456789ab" });
  assert.equal(rnd, "keep/u-0123456789abcdef0123.png");
  assert.equal(isContentKey(rnd), false);
  // a key that only LOOKS tagged is not a content key
  assert.equal(isContentKey(`creatives/${sha}-10-zzzzzzzzzzzz.mp4`), false);
  assert.equal(isContentKey(`creatives/${sha}-10-0123456789ab-0123456789ab.mp4`), false);
});
