// Server-only creative-media helpers shared by the MO launch route and the HS token-launch
// rail: video registration (Meta fetches the bytes from a public URL itself) + processing wait +
// thumbnail, and static-image validation + upload. Extracted verbatim from app/api/launch/route.ts
// (probed limits and all); the optional `token` on each Graph-touching helper picks the launch
// token — omitted = MO's FB_LAUNCH_TOKEN, the HS rail passes its partner-side token.

import { FbError, fbGet, fbPost } from "./fb-graph";

type Json = Record<string, unknown>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Register the creative with FB by URL — FB fetches the bytes from the (public) Blob URL itself,
 *  so the video never passes through this function. */
export async function uploadVideo(accountId: string, fileUrl: string, name: string, token?: string): Promise<string> {
  const body = await fbPost(`act_${accountId}/advideos`, { name, file_url: fileUrl }, token);
  if (!body?.id) throw new FbError("video upload failed", body);
  return String(body.id);
}

// Empirical adimages ceilings (probed live 2026-08-11 on the MO token): any side above ~9000px is
// rejected (sub 2446496 "invalid image format"), and Meta re-encodes every upload — when ITS
// output is still heavy it rejects with sub 1885355 "resized image too large" (a 9.3MB worst-case
// source already failed; 8 buyer launches died on this in one day). 8MB/9000px keeps every upload
// we allow inside what Meta demonstrably accepts. The dropzone enforces the same numbers, so
// buyers hear it at drop time — this is the server-side backstop.
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_MAX_DIM = 9000;
// What sub 1885355 ("resized image too large") ACTUALLY meters is the pixel stream, not the
// file: probed 08-11 — a 10MB PNG whose bytes sit in ancillary chunks passes, while ~9MB of
// IDAT dies (boundary between 5.7MB OK and 9.3MB reject). 7MB keeps a safety margin. The
// dropzone re-encodes big images to ≤2000px anyway; this is the raw-API backstop.
const IMAGE_MAX_IDAT_BYTES = 7 * 1024 * 1024;

/** Total PNG pixel-stream (IDAT) bytes; null for non-PNG (a JPEG's file size ≈ its pixel
 *  stream — no padding trick exists there, IMAGE_MAX_BYTES covers it). */
function pngIdatBytes(buf: Buffer): number | null {
  if (!(buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)) return null;
  let off = 8;
  let total = 0;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    if (type === "IDAT") total += len;
    if (type === "IEND") break;
    off += 12 + len;
  }
  return total;
}

/** Width/height from the image header: PNG (IHDR), JPEG (SOF frame scan), GIF, WebP (VP8/VP8L/
 *  VP8X). Null when the format is unrecognized — the guard then lets Meta be the judge. */
function imageDims(buf: Buffer): { w: number; h: number } | null {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf.length > 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  if (buf.length > 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const fmt = buf.toString("ascii", 12, 16);
    if (fmt === "VP8X") return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    if (fmt === "VP8L") {
      const b = buf.readUInt32LE(21);
      return { w: 1 + (b & 0x3fff), h: 1 + ((b >> 14) & 0x3fff) };
    }
    if (fmt === "VP8 ") return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    return null;
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) return null;
      const marker = buf[off + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { w: buf.readUInt16BE(off + 7), h: buf.readUInt16BE(off + 5) };
      }
      off += 2 + buf.readUInt16BE(off + 2);
    }
  }
  return null;
}

/** Fetch + validate the image BEFORE anything is claimed or created: caught here it costs
 *  nothing; caught at adimages it has already burned a claim round-trip and 20s of wave. */
export async function fetchValidatedImage(fileUrl: string): Promise<Buffer> {
  const res = await fetch(fileUrl, { cache: "no-store" });
  if (!res.ok) throw new FbError(`image fetch failed (HTTP ${res.status})`, { fileUrl });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength === 0) throw new FbError("image is empty", { fileUrl });
  if (buf.byteLength > IMAGE_MAX_BYTES) {
    throw new FbError(
      `image too heavy (${(buf.byteLength / 1048576).toFixed(1)}MB) — Meta rejects these after its re-encode; compress under 8MB`,
      { size: buf.byteLength },
    );
  }
  const dims = imageDims(buf);
  if (dims && Math.max(dims.w, dims.h) > IMAGE_MAX_DIM) {
    throw new FbError(
      `image too large (${dims.w}×${dims.h}) — Meta rejects sides above ${IMAGE_MAX_DIM}px; export it smaller`,
      dims,
    );
  }
  const idat = pngIdatBytes(buf);
  if (idat !== null && idat > IMAGE_MAX_IDAT_BYTES) {
    throw new FbError(
      `image pixel data too heavy (${(idat / 1048576).toFixed(1)}MB) — Meta rejects it after its re-encode; export at smaller dimensions or as JPEG`,
      { idat },
    );
  }
  return buf;
}

/** Upload a static image into the account's image library; returns its stable image_hash. */
export async function uploadImage(accountId: string, buf: Buffer, token?: string): Promise<string> {
  const body = await fbPost(`act_${accountId}/adimages`, { bytes: buf.toString("base64") }, token);
  // Response shape: { images: { bytes: { hash, ... } } } — key varies by upload method, so take
  // the first entry (same convention as the clone route's copy_from reader).
  const images = (body?.images ?? {}) as Record<string, { hash?: string }>;
  const hash = Object.values(images)[0]?.hash;
  if (!hash) throw new FbError("image upload returned no hash", body);
  return String(hash);
}

/** Wait until the uploaded video finishes processing (or throw on error/timeout). 6s cadence —
 *  status polls dominate a wave's call count on the dev-tier quota, so poll no faster than useful. */
export async function waitForVideo(videoId: string, timeoutMs = 180_000, token?: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await fbGet(`${videoId}?fields=status`, token);
    const status = (body?.status as Json | undefined)?.video_status;
    if (status === "ready") return;
    if (status === "error") throw new FbError("video processing failed", body);
    await sleep(6000);
  }
  throw new FbError("video processing timed out", { videoId });
}

/** The video thumbnail FB auto-generates once processed; needed as the creative image. */
export async function videoThumb(videoId: string, token?: string): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const body = await fbGet(`${videoId}/thumbnails?fields=uri,is_preferred`, token);
    const thumbs = (body?.data as Array<Json> | undefined) ?? [];
    const pick = thumbs.find((t) => t.is_preferred) ?? thumbs[0];
    if (pick?.uri) return String(pick.uri);
    await sleep(4000);
  }
  throw new FbError("no video thumbnail available", { videoId });
}
