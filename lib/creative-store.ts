// Server-only: the S3 side of the creative store (lib/creative-url.ts is the pure half). Signs the
// browser's uploads (the bytes go browser → S3 directly, never through a function), finishes
// multipart uploads, and writes the few objects the server itself produces.
//
// Shape (so the decision logic is testable without a network): every S3 touch goes through an
// injected `CreativeS3Ops` object. The pure-ish core functions (planUpload / completeUpload /
// abortUpload / putBytes) take that object + a CreativeEnv and never reach for the real SDK; the
// thin `realCreativeS3Ops` binds the actual @aws-sdk commands and is the only place that does I/O.
// The public wrappers (planCreativeUpload, …) feed it `realCreativeS3Ops` + process.env. This file
// uses relative `.ts` imports only (loadable by `node --test`); the SDK is a lazy dynamic import so
// unit tests that use a fake `CreativeS3Ops` never pay for loading it.
//
// Environment (all server-side):
//   CREATIVES_S3_BUCKET              bucket name (required — without it every call answers not-configured)
//   CREATIVES_S3_REGION              default eu-central-1
//   CREATIVES_S3_ACCESS_KEY_ID       } credentials of the signer; fall back to AWS_ACCESS_KEY_ID /
//   CREATIVES_S3_SECRET_ACCESS_KEY   } AWS_SECRET_ACCESS_KEY (local runs with the sibling projects' env)
//   CREATIVES_PUBLIC_BASE            optional https origin creative URLs are built on (a CDN)
//   CREATIVES_S3_ACCELERATE=1        optional — sign uploads for the S3 Transfer Acceleration endpoint

import { createHash, randomBytes } from "node:crypto";
import {
  CREATIVE_HASH_MAX_BYTES,
  CREATIVE_MAX_BYTES,
  CREATIVE_MULTIPART_MIN_BYTES,
  CREATIVE_PART_BYTES,
  CREATIVE_REUSE_MAX_AGE_MS,
  type CreativeCompleteResponse,
  type CreativeEnv,
  type CreativePlanRequest,
  type CreativePlanResponse,
  creativeObjectKey,
  creativeParts,
  creativePublicBase,
  creativeTypeOf,
  creativeUrl,
  isContentKey,
  isCreativeKey,
  isSha256Hex,
} from "./creative-url.ts";

// ---- injected S3 surface (the real bindings are at the bottom; fakes drive the tests) ----

/** The minimal set of S3 operations the store needs. Each method does exactly one thing so a fake
 *  can drive every branch of the core without a network. `head` resolves null for a missing object
 *  (404 / NotFound); any OTHER failure rejects — the core swallows it and plans a fresh upload. */
export type CreativeS3Ops = {
  head(key: string): Promise<{ contentLength: number | undefined; lastModified: Date | undefined } | null>;
  presignPut(key: string, mime: string): Promise<string>;
  createMultipart(key: string, mime: string): Promise<string>;
  presignPart(key: string, uploadId: string, partNumber: number): Promise<string>;
  complete(key: string, uploadId: string, parts: { n: number; etag: string }[]): Promise<void>;
  abort(key: string, uploadId: string): Promise<void>;
  put(key: string, mime: string, bytes: Buffer): Promise<void>;
};

// ---- refusal vocabulary ----
// Refusals are "machine_word — human sentence". The route maps the machine word to an HTTP status:
// a validation refusal is the client's fault (400); anything else is the store failing (502); the
// store being absent is a deployment fact (503).
const VALIDATION_WORDS = new Set(["unsupported_type", "too_large", "bad_size", "bad_request", "bad_key", "bad_parts", "bad_upload_id"]);

/** HTTP status for a refusal string from any store call — the one classifier the route trusts. */
export function creativeRefusalStatus(error: string): number {
  const word = String(error).split("—")[0].trim().toLowerCase();
  if (word === "creatives_not_configured") return 503;
  return VALIDATION_WORDS.has(word) ? 400 : 502;
}

const NOT_CONFIGURED = "creatives_not_configured — the media store is not set up on this deployment";

/** A short upper-case label for the file the buyer actually dropped (its extension, else its MIME
 *  subtype) — so "unsupported_type" can name MKV, AVI, SVG… back to them. */
function fileLabel(type: string, name: string): string {
  const ext = /\.([a-z0-9]{1,6})$/i.exec(String(name ?? "").trim())?.[1];
  if (ext) return ext.toUpperCase();
  const sub = String(type ?? "").split(";")[0].split("/")[1];
  return sub ? sub.toUpperCase() : "this file";
}

const mib = (bytes: number) => Math.round(bytes / (1024 * 1024));

/** The uploader's key namespace: a short, stable, opaque tag of the username (not a secret — it is
 *  always derived HERE from the authenticated session, never taken from the request). Null without
 *  a username: the key then carries no tag, which is reserved for bytes the server hashed itself. */
export function creativeOwnerTag(owner: string | null | undefined): string | null {
  const name = String(owner ?? "").trim();
  if (!name) return null;
  return createHash("sha256").update(`creative-owner:${name}`).digest("hex").slice(0, 12);
}

/** 48 lower-case hex chars from the CSPRNG — creativeObjectKey slices it to 40 and needs ≥ 16. */
const randomToken = () => randomBytes(24).toString("hex");

// ---- the core: pure-ish, I/O only through `ops` ----

/**
 * Plan one browser upload. Validates size + type, mints the key (content-addressed when a valid
 * sha256 rides with a file of at most CREATIVE_HASH_MAX_BYTES, random otherwise) and answers
 * exists / single / multipart. Never throws — every failure is { ok:false, error }.
 */
export async function planUpload(
  ops: CreativeS3Ops,
  req: Omit<CreativePlanRequest, "action">,
  env: CreativeEnv = process.env,
  /** Who is uploading (the session's username). Content-addressed keys are namespaced by it —
   *  see creativeObjectKey: the browser's hash is the client's word, so "these bytes are already
   *  here" may only ever be answered from that same buyer's own objects. */
  owner?: string | null,
): Promise<CreativePlanResponse> {
  const base = creativePublicBase(env);
  if (!base) return { ok: false, error: NOT_CONFIGURED };

  const size = Number(req.size);
  if (!Number.isInteger(size) || size < 1) return { ok: false, error: "bad_size — the file size is missing or invalid" };
  if (size > CREATIVE_MAX_BYTES) return { ok: false, error: `too_large — ${mib(size)} MB is over the ${mib(CREATIVE_MAX_BYTES)} MB limit` };

  const t = creativeTypeOf(req.type, req.name);
  if (!t) return { ok: false, error: `unsupported_type — ${fileLabel(req.type, req.name)} is not supported here; use MP4, MOV or WebM for a video, JPG, PNG, GIF or WebP for an image` };

  const purpose = req.purpose === "keep" ? "keep" : "creative";
  // A hash only earns a content-addressed key when the browser could hash the WHOLE file; a sha sent
  // with a file above the hash ceiling is ignored (a truncated/partial hash would collide two
  // different files onto one key → the wrong creative launched). No hash → random key, never deduped.
  const sha256 = isSha256Hex(req.sha256) && size <= CREATIVE_HASH_MAX_BYTES ? req.sha256 : null;
  const key = creativeObjectKey({ purpose, ext: t.ext, sha256, size, random: randomToken(), owner: creativeOwnerTag(owner) });
  const url = creativeUrl(key, env);

  // Reuse only a CONTENT-addressed object (random keys are unique by construction): same key, EXACT
  // byte size, and young enough that it cannot hit the 14-day lifecycle between now and launch. A
  // HEAD that 404s or merely hiccups must never fail the attach — it just plans a fresh upload.
  if (isContentKey(key)) {
    let existing: { contentLength: number | undefined; lastModified: Date | undefined } | null = null;
    try {
      existing = await ops.head(key);
    } catch {
      existing = null;
    }
    if (existing && existing.contentLength === size && existing.lastModified && Date.now() - existing.lastModified.getTime() < CREATIVE_REUSE_MAX_AGE_MS) {
      return { ok: true, state: "exists", key, url };
    }
  }

  try {
    if (size < CREATIVE_MULTIPART_MIN_BYTES) {
      const putUrl = await ops.presignPut(key, t.mime);
      // The browser MUST send exactly this Content-Type: it is part of the signature (and of the key
      // the object is stored under). Nothing else is signed, so nothing else must be reproduced.
      return { ok: true, state: "single", key, url, putUrl, headers: { "content-type": t.mime } };
    }
    const uploadId = await ops.createMultipart(key, t.mime);
    const { count, range } = creativeParts(size);
    const parts: { n: number; url: string }[] = [];
    for (let n = 1; n <= count; n++) {
      void range; // ranges are the browser's slice math (creative-url); the server only numbers parts
      parts.push({ n, url: await ops.presignPart(key, uploadId, n) });
    }
    return { ok: true, state: "multipart", key, url, uploadId, partSize: CREATIVE_PART_BYTES, parts };
  } catch (e) {
    return { ok: false, error: `store_error — could not reach the media store (${(e as Error).message}); press Retry` };
  }
}

/** Normalise one part's ETag: S3 returns it quoted; some browsers strip the quotes off the response
 *  header. CompleteMultipartUpload rejects a bare hex, so we put them back. */
function quoteEtag(etag: string): string {
  const e = etag.trim();
  if (!e) return "";
  return e.startsWith('"') && e.endsWith('"') ? e : `"${e.replace(/^"|"$/g, "")}"`;
}

/** CompleteMultipartUpload for a key this store minted, then HeadObject to prove the object exists.
 *  Never throws. */
export async function completeUpload(
  ops: CreativeS3Ops,
  req: { key: string; uploadId: string; parts: { n: number; etag: string }[] },
  env: CreativeEnv = process.env,
): Promise<CreativeCompleteResponse> {
  const base = creativePublicBase(env);
  if (!base) return { ok: false, error: NOT_CONFIGURED };
  if (!req || !isCreativeKey(String(req.key))) return { ok: false, error: "bad_key — not a creative object key" };
  if (!req.uploadId || typeof req.uploadId !== "string") return { ok: false, error: "bad_upload_id — missing upload id" };
  if (!Array.isArray(req.parts) || req.parts.length === 0) return { ok: false, error: "bad_parts — no parts to complete" };

  const parts = [...req.parts].sort((a, b) => a.n - b.n);
  let prev = 0;
  const normalized: { n: number; etag: string }[] = [];
  for (const p of parts) {
    const n = Number(p?.n);
    if (!Number.isInteger(n) || n < 1 || n > 10000) return { ok: false, error: "bad_parts — a part number is out of range" };
    if (n <= prev) return { ok: false, error: "bad_parts — part numbers must be unique and ascending" };
    prev = n;
    const etag = quoteEtag(String(p?.etag ?? ""));
    if (etag === '""' || !etag) return { ok: false, error: "bad_parts — a part is missing its ETag" };
    normalized.push({ n, etag });
  }

  try {
    await ops.complete(req.key, req.uploadId, normalized);
    // Prove the object is really there (a complete can report success yet leave nothing a launch can
    // fetch); a HEAD miss here is an honest "not finalized" rather than a launch against a 404.
    let head: { contentLength: number | undefined; lastModified: Date | undefined } | null = null;
    try {
      head = await ops.head(req.key);
    } catch (e) {
      return { ok: false, error: `store_error — could not confirm the upload (${(e as Error).message}); press Retry` };
    }
    if (!head) return { ok: false, error: "store_error — the upload did not finalize; press Retry" };
    return { ok: true, key: req.key, url: creativeUrl(req.key, env) };
  } catch (e) {
    return { ok: false, error: `store_error — completing the upload failed (${(e as Error).message}); press Retry` };
  }
}

/** Best-effort AbortMultipartUpload (the bucket lifecycle sweeps abandoned uploads anyway). Never
 *  throws, and never touches S3 for a key that is not ours. */
export async function abortUpload(ops: CreativeS3Ops, req: { key: string; uploadId: string }): Promise<void> {
  if (!req || !isCreativeKey(String(req.key)) || !req.uploadId) return;
  try {
    await ops.abort(req.key, req.uploadId);
  } catch {
    /* best effort: the lifecycle rule aborts stale multipart uploads after 2 days anyway */
  }
}

/** Server-side PutObject of bytes the SERVER produced (the Auto-landing Gemini image). Content-
 *  addressed by the real sha256 of the bytes. Returns the public URL. THROWS on failure. */
export async function putBytes(ops: CreativeS3Ops, bytes: Buffer, opts: { type: string; name: string }, env: CreativeEnv = process.env): Promise<string> {
  if (!creativePublicBase(env)) throw new Error(NOT_CONFIGURED);
  const t = creativeTypeOf(opts.type, opts.name);
  if (!t) throw new Error(`unsupported_type — ${fileLabel(opts.type, opts.name)} is not supported here; use MP4, MOV or WebM for a video, JPG, PNG, GIF or WebP for an image`);
  const size = bytes.length;
  if (!Number.isInteger(size) || size < 1) throw new Error("bad_size — empty buffer");
  if (size > CREATIVE_MAX_BYTES) throw new Error(`too_large — ${mib(size)} MB is over the ${mib(CREATIVE_MAX_BYTES)} MB limit`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const key = creativeObjectKey({ purpose: "creative", ext: t.ext, sha256, size, random: randomToken() });
  await ops.put(key, t.mime, bytes);
  return creativeUrl(key, env);
}

// ---- configuration + the real (lazy-SDK) bindings ----

/** True when the bucket and the signer credentials are present. */
export function creativesConfigured(): boolean {
  const bucket = (process.env.CREATIVES_S3_BUCKET ?? "").trim();
  const ak = (process.env.CREATIVES_S3_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY_ID ?? "").trim();
  const sk = (process.env.CREATIVES_S3_SECRET_ACCESS_KEY ?? process.env.AWS_SECRET_ACCESS_KEY ?? "").trim();
  return Boolean(bucket && ak && sk);
}

function clientConfig(): { bucket: string; region: string; accessKeyId: string; secretAccessKey: string; accelerate: boolean } {
  const bucket = (process.env.CREATIVES_S3_BUCKET ?? "").trim();
  const region = (process.env.CREATIVES_S3_REGION ?? "").trim() || "eu-central-1";
  const accessKeyId = (process.env.CREATIVES_S3_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY_ID ?? "").trim();
  const secretAccessKey = (process.env.CREATIVES_S3_SECRET_ACCESS_KEY ?? process.env.AWS_SECRET_ACCESS_KEY ?? "").trim();
  return { bucket, region, accessKeyId, secretAccessKey, accelerate: process.env.CREATIVES_S3_ACCELERATE === "1" };
}

// One S3Client per serverless instance (they are reused). Cached on globalThis and keyed by config,
// so a Preview that swaps the bucket/region at runtime rebuilds the client instead of signing for
// the old one. The SDK itself is imported lazily — a `node --test` with fake ops never loads it.
type CachedClient = { key: string; bucket: string; client: import("@aws-sdk/client-s3").S3Client };
const G = globalThis as unknown as { __adlCreativeS3?: CachedClient };

async function s3(): Promise<{ bucket: string; client: import("@aws-sdk/client-s3").S3Client }> {
  const cfg = clientConfig();
  const cacheKey = `${cfg.bucket}|${cfg.region}|${cfg.accelerate ? "1" : "0"}|${cfg.accessKeyId}`;
  if (G.__adlCreativeS3 && G.__adlCreativeS3.key === cacheKey) return G.__adlCreativeS3;
  const { S3Client } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    region: cfg.region,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    // AWS SDK ≥ 3.729 otherwise bakes a CRC32 (x-amz-sdk-checksum-algorithm) into presigned PUTs and
    // every browser PUT fails the signature — WHEN_REQUIRED keeps it off the upload URLs.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    useAccelerateEndpoint: cfg.accelerate,
    maxAttempts: 3,
  });
  G.__adlCreativeS3 = { key: cacheKey, bucket: cfg.bucket, client };
  return G.__adlCreativeS3;
}

function is404(e: unknown): boolean {
  const err = e as { name?: string; $metadata?: { httpStatusCode?: number } } | undefined;
  return err?.$metadata?.httpStatusCode === 404 || err?.name === "NotFound" || err?.name === "NoSuchKey";
}

/** The real S3 bindings — the only code in this module that performs I/O. */
export const realCreativeS3Ops: CreativeS3Ops = {
  async head(key) {
    const { client, bucket } = await s3();
    const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
    try {
      const r = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { contentLength: r.ContentLength, lastModified: r.LastModified };
    } catch (e) {
      if (is404(e)) return null;
      throw e; // a real HEAD failure — the core catches it and plans a fresh upload
    }
  },
  async presignPut(key, mime) {
    const { client, bucket } = await s3();
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    const cmd = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: mime });
    // Sign Content-Type so the browser's one header is covered; DO NOT set CacheControl /
    // ContentDisposition — each would become another header the browser must reproduce verbatim.
    return getSignedUrl(client, cmd, { expiresIn: 3600, signableHeaders: new Set(["content-type"]) });
  },
  async createMultipart(key, mime) {
    const { client, bucket } = await s3();
    const { CreateMultipartUploadCommand } = await import("@aws-sdk/client-s3");
    const r = await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: mime }));
    if (!r.UploadId) throw new Error("no upload id returned");
    return r.UploadId;
  },
  async presignPart(key, uploadId, partNumber) {
    const { client, bucket } = await s3();
    const { UploadPartCommand } = await import("@aws-sdk/client-s3");
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    const cmd = new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber });
    // A part is raw bytes — nothing to sign but host; a 6 h window covers a slow 500 MB upload.
    return getSignedUrl(client, cmd, { expiresIn: 6 * 3600 });
  },
  async complete(key, uploadId, parts) {
    const { client, bucket } = await s3();
    const { CompleteMultipartUploadCommand } = await import("@aws-sdk/client-s3");
    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.n, ETag: p.etag })) },
      }),
    );
  },
  async abort(key, uploadId) {
    const { client, bucket } = await s3();
    const { AbortMultipartUploadCommand } = await import("@aws-sdk/client-s3");
    await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
  },
  async put(key, mime, bytes) {
    const { client, bucket } = await s3();
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: mime }));
  },
};

// ---- public API (contract signatures) ----

export async function planCreativeUpload(req: Omit<CreativePlanRequest, "action">, opts: { owner?: string | null } = {}): Promise<CreativePlanResponse> {
  if (!creativesConfigured()) return { ok: false, error: NOT_CONFIGURED };
  return planUpload(realCreativeS3Ops, req, process.env, opts.owner);
}

export async function completeCreativeUpload(req: { key: string; uploadId: string; parts: { n: number; etag: string }[] }): Promise<CreativeCompleteResponse> {
  if (!creativesConfigured()) return { ok: false, error: NOT_CONFIGURED };
  return completeUpload(realCreativeS3Ops, req, process.env);
}

export async function abortCreativeUpload(req: { key: string; uploadId: string }): Promise<void> {
  if (!creativesConfigured()) return;
  return abortUpload(realCreativeS3Ops, req);
}

export async function putCreativeBytes(bytes: Buffer, opts: { type: string; name: string }): Promise<string> {
  if (!creativesConfigured()) throw new Error(NOT_CONFIGURED);
  return putBytes(realCreativeS3Ops, bytes, opts, process.env);
}
