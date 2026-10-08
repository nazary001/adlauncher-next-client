// Launch creatives live in OUR S3 bucket (owner ask 08.10: stop moving media through Vercel Blob).
// This module is the pure half of that store: where an object lives (key), what its public URL is,
// and — the part every launch route leans on — whether a URL a client hands us really is one of OUR
// creatives. Server-side fetches (image bytes for adimages, covers) and the partner fetchers (Meta's
// advideos file_url, TOOL's media/from-url) are only ever pointed at URLs that pass this fence.
// No I/O, no SDK: lib/creative-store.ts does the signing. Relative `.ts` imports only (node --test).

/** Expiring prefix (bucket lifecycle: 14 days) — everything a launch ships. */
export const CREATIVE_PREFIX = "creatives/";
/** Non-expiring prefix — remembered TikTok identity avatars are reused for weeks. */
export const KEEP_PREFIX = "keep/";

/** Same ceiling the Blob broker enforced. */
export const CREATIVE_MAX_BYTES = 500 * 1024 * 1024;
/** Files from this size up ride multipart (part-level retries; a hiccup no longer costs the file). */
export const CREATIVE_MULTIPART_MIN_BYTES = 32 * 1024 * 1024;
/** Multipart part size (S3 floor is 5 MiB; 500 MB → 32 parts). */
export const CREATIVE_PART_BYTES = 16 * 1024 * 1024;
/** Content-addressed keys are only minted for files a browser can hash in one go. */
export const CREATIVE_HASH_MAX_BYTES = 256 * 1024 * 1024;
/** An existing object older than this is re-uploaded instead of reused, so a reused creative can
 *  never hit the 14-day lifecycle expiry between attach and launch. */
export const CREATIVE_REUSE_MAX_AGE_MS = 9 * 24 * 3_600_000;

export type CreativePurpose = "creative" | "keep";
export type CreativeKind = "video" | "image";

/** The environment this module reads (CREATIVES_S3_BUCKET, CREATIVES_S3_REGION,
 *  CREATIVES_PUBLIC_BASE) — `process.env` by default, a plain object in tests. */
export type CreativeEnv = { readonly [key: string]: string | undefined };

const trimBase = (s: string): string => s.trim().replace(/\/+$/, "");

/** The bucket's own virtual-hosted origin, or null while the store is not configured. */
export function creativeS3Base(env: CreativeEnv = process.env): string | null {
  const bucket = (env.CREATIVES_S3_BUCKET ?? "").trim();
  if (!bucket) return null;
  const region = (env.CREATIVES_S3_REGION ?? "").trim() || "eu-central-1";
  return `https://${bucket}.s3.${region}.amazonaws.com`;
}

/** What creative URLs are built on: CREATIVES_PUBLIC_BASE (a CDN in front of the bucket) when set,
 *  else the bucket origin. Null while the store is not configured. */
export function creativePublicBase(env: CreativeEnv = process.env): string | null {
  const explicit = trimBase(env.CREATIVES_PUBLIC_BASE ?? "");
  if (/^https:\/\/[^/\s]+$/i.test(explicit)) return explicit;
  return creativeS3Base(env);
}

/** Every origin a creative URL of ours may carry: the public base AND the bucket origin — a queued
 *  job keeps working when the base is switched to a CDN (or back) under it. */
export function creativeBases(env: CreativeEnv = process.env): string[] {
  const out = new Set<string>();
  const pub = creativePublicBase(env);
  const s3 = creativeS3Base(env);
  if (pub) out.add(pub);
  if (s3) out.add(s3);
  return [...out];
}

/** An object key of ours: `<prefix><name>.<ext>`, nothing else (no traversal, no nesting). */
const KEY_RE = /^(?:creatives|keep)\/[a-z0-9][a-z0-9-]{6,110}\.[a-z0-9]{2,5}$/;

export function isCreativeKey(key: string): boolean {
  return KEY_RE.test(key);
}

export function creativeUrl(key: string, env: CreativeEnv = process.env): string {
  const base = creativePublicBase(env);
  if (!base) throw new Error("creatives_not_configured");
  return `${base}/${key}`;
}

/** The object key behind one of OUR creative URLs, or null for anything else (a foreign host, a
 *  path outside the two prefixes, a query string trying to smuggle a different target, http). */
export function creativeKeyOf(raw: string, env: CreativeEnv = process.env): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) return null;
  if (!creativeBases(env).some((b) => b.toLowerCase() === u.origin.toLowerCase())) return null;
  let key: string;
  try {
    key = decodeURIComponent(u.pathname.slice(1));
  } catch {
    return null;
  }
  return isCreativeKey(key) ? key : null;
}

/** A Vercel Blob URL our retired broker produced (`creatives/<taskid>-<name>` on the Blob host).
 *  Still accepted for a while: a tab opened before the S3 deploy finishes its wave on Blob. */
export function isLegacyBlobUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname.endsWith(".blob.vercel-storage.com") && u.pathname.startsWith("/creatives/");
  } catch {
    return false;
  }
}

/** THE fence: a URL this app itself produced for a creative — our bucket (either origin) or, for
 *  tabs that predate the S3 deploy, our own Blob prefix. Never an arbitrary URL: the server fetches
 *  image bytes from it and hands it to Meta / TOOL as a download source. */
export function isOwnCreativeUrl(raw: string, env: CreativeEnv = process.env): boolean {
  return creativeKeyOf(raw, env) !== null || isLegacyBlobUrl(raw);
}

const VIDEO_TYPES: Record<string, string> = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" };
const IMAGE_SUBTYPES: Record<string, string> = {
  jpeg: "jpg",
  jpg: "jpg",
  pjpeg: "jpg",
  png: "png",
  gif: "gif",
  webp: "webp",
  bmp: "bmp",
  avif: "avif",
  heic: "heic",
  heif: "heif",
  tiff: "tiff",
};
const EXT_TYPES: Record<string, { mime: string; ext: string; kind: CreativeKind }> = {
  mp4: { mime: "video/mp4", ext: "mp4", kind: "video" },
  m4v: { mime: "video/mp4", ext: "mp4", kind: "video" },
  mov: { mime: "video/quicktime", ext: "mov", kind: "video" },
  webm: { mime: "video/webm", ext: "webm", kind: "video" },
  jpg: { mime: "image/jpeg", ext: "jpg", kind: "image" },
  jpeg: { mime: "image/jpeg", ext: "jpg", kind: "image" },
  png: { mime: "image/png", ext: "png", kind: "image" },
  gif: { mime: "image/gif", ext: "gif", kind: "image" },
  webp: { mime: "image/webp", ext: "webp", kind: "image" },
};

/**
 * What a file IS for the store: the Content-Type it is stored (and signed) under, its key
 * extension and its kind — or null for a type no rail can launch. The declared MIME type wins; an
 * empty one (some Windows drops) falls back to the file extension. Same set the Blob broker took:
 * MP4 / MOV / WebM videos and raster images (never SVG — it is markup, not pixels).
 */
export function creativeTypeOf(type: string, name: string): { mime: string; ext: string; kind: CreativeKind } | null {
  const t = String(type ?? "").trim().toLowerCase().split(";")[0];
  if (VIDEO_TYPES[t]) return { mime: t, ext: VIDEO_TYPES[t], kind: "video" };
  if (t.startsWith("image/")) {
    const ext = IMAGE_SUBTYPES[t.slice(6)];
    return ext ? { mime: t === "image/jpg" || t === "image/pjpeg" ? "image/jpeg" : t, ext, kind: "image" } : null;
  }
  if (t) return null; // a declared type we do not take (mkv, avi, svg, pdf…)
  const m = /\.([a-z0-9]{2,5})$/i.exec(String(name ?? "").trim());
  return m ? (EXT_TYPES[m[1].toLowerCase()] ?? null) : null;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
export const isSha256Hex = (s: unknown): s is string => typeof s === "string" && SHA256_RE.test(s);

/**
 * The object key of one upload. With the file's SHA-256 the key is CONTENT-ADDRESSED
 * (`<sha>-<size>[-<owner>].<ext>`): the same bytes attached twice by the same buyer — on any card,
 * after a reload — are one object and one upload, and the server-side media cache can recognise
 * them per ad account.
 * The byte size rides in the key as a second witness. Without a hash (files too big to hash in the
 * browser) the key is random (`u-<random>`), so nothing is ever deduplicated by mistake.
 */
export function creativeObjectKey(args: {
  purpose: CreativePurpose;
  ext: string;
  sha256?: string | null;
  size: number;
  random: string;
  /** The uploader's namespace tag (see below) — 8…16 lower-case hex chars. */
  owner?: string | null;
}): string {
  const prefix = args.purpose === "keep" ? KEEP_PREFIX : CREATIVE_PREFIX;
  const ext = args.ext.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "bin";
  if (isSha256Hex(args.sha256)) {
    // The hash of a browser upload is the CLIENT's word — S3 does not check the bytes against it. So
    // a content key is namespaced by WHO uploaded it: the "same bytes" shortcut then only ever
    // answers with an object that same buyer put there. Without the tag one login could park other
    // bytes under a hash the team reuses, and a colleague's attach of the real file would be told
    // "already here" and launch the planted ones (review find 08.10). Keys the SERVER mints from
    // bytes it hashed itself carry no tag — nothing a browser plans can ever land on one.
    const tag = typeof args.owner === "string" && /^[0-9a-f]{8,16}$/.test(args.owner) ? `-${args.owner}` : "";
    return `${prefix}${args.sha256}-${Math.max(0, Math.floor(args.size))}${tag}.${ext}`;
  }
  const rnd = args.random.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40);
  if (rnd.length < 16) throw new Error("creativeObjectKey: random token too short");
  return `${prefix}u-${rnd}.${ext}`;
}

/** True for a content-addressed key (safe to reuse an existing object / cache platform media by):
 *  `<sha256>-<size>` with an optional uploader tag. */
export function isContentKey(key: string): boolean {
  return /^(?:creatives|keep)\/[0-9a-f]{64}-\d{1,12}(?:-[0-9a-f]{8,16})?\.[a-z0-9]{2,5}$/.test(key);
}

/** How a file of `size` bytes is split for multipart: part count and the byte range of part n (1-based). */
export function creativeParts(size: number, partBytes = CREATIVE_PART_BYTES): { count: number; range: (n: number) => { start: number; end: number } } {
  const count = Math.max(1, Math.ceil(size / partBytes));
  return {
    count,
    range: (n: number) => ({ start: (n - 1) * partBytes, end: Math.min(size, n * partBytes) }),
  };
}

// ---- wire contract of POST /api/creatives (shared by the route and the browser uploader) ----

export type CreativePlanRequest = {
  action: "plan";
  size: number;
  /** The browser's File.type (may be ""). */
  type: string;
  name: string;
  /** Lower-case hex SHA-256 of the bytes; omitted for files above CREATIVE_HASH_MAX_BYTES. */
  sha256?: string;
  purpose?: CreativePurpose;
};
export type CreativeCompleteRequest = { action: "complete"; key: string; uploadId: string; parts: { n: number; etag: string }[] };
export type CreativeAbortRequest = { action: "abort"; key: string; uploadId: string };
export type CreativeRequest = CreativePlanRequest | CreativeCompleteRequest | CreativeAbortRequest;

export type CreativePlanResponse =
  /** The very same bytes are already in the bucket — nothing to send. */
  | { ok: true; state: "exists"; key: string; url: string }
  /** One PUT. `headers` MUST be sent verbatim (Content-Type is part of the signature). */
  | { ok: true; state: "single"; key: string; url: string; putUrl: string; headers: Record<string, string> }
  /** Multipart: PUT every part (any order, any parallelism), collect each response's ETag, then
   *  `complete`. Part n covers bytes [(n-1)·partSize, min(size, n·partSize)). */
  | { ok: true; state: "multipart"; key: string; url: string; uploadId: string; partSize: number; parts: { n: number; url: string }[] }
  | { ok: false; error: string };
export type CreativeCompleteResponse = { ok: true; key: string; url: string } | { ok: false; error: string };
