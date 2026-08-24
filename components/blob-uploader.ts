// Shared client→Vercel-Blob creative uploader for BOTH task managers (MO/AIF launches and the
// HS FB-Token rail). Born from the 08-21 "TypeError: Failed to fetch" hunt: the raw fetch/upload
// pair surfaced every failure — a dead file handle, a proxy blip, a mid-stream cut — as the same
// bare TypeError, telling the buyer nothing. This module splits the pipeline into steps that
// each fail with a NAMED, actionable error, and self-heals the transient class with bounded
// retries. Client-only (session object URLs + window timers).

import { upload } from "@vercel/blob/client";

// A Blob upload has no server-side deadline — a hung connection would otherwise spin the task
// (and block the one-at-a-time queue) forever. Seen live 08-07: a task stuck 30+ min.
export const UPLOAD_TIMEOUT_MS = 5 * 60_000;
// Transient network failures (proxy/VPN blips — the anti-detect setups flake) heal themselves:
// 3 attempts, growing breather. Non-network errors and dead files never burn extra attempts.
const UPLOAD_ATTEMPTS = 3;
const RETRY_BASE_MS = 2_000;
// Big videos ride multipart: the SDK splits the file and uploads parts with its own retry, so a
// single TCP hiccup no longer kills a 500MB transfer at minute 4. Small files keep the single
// PUT (part bookkeeping would only add requests).
const MULTIPART_MIN_BYTES = 32 * 1024 * 1024;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The browser-network failure class (fetch rejects, no HTTP status): connection cut, proxy/VPN
 *  reset, DNS, CORS-invisible resets. Chrome says "Failed to fetch", Firefox "NetworkError",
 *  Safari "Load failed". */
function isNetworkFlake(e: unknown): boolean {
  // Message-match only — a bare `instanceof TypeError` also swallowed NON-network TypeErrors
  // (bad argument, SDK internals), retrying them 3× and then blaming the buyer's proxy/VPN.
  // Every browser's genuine network failure carries one of these phrases.
  const msg = String((e as Error | null)?.message ?? e).toLowerCase();
  return /failed to fetch|networkerror|network error|load failed|fetch failed|socket|econn|network request failed/.test(msg);
}

/** True while the File behind a session object URL still yields bytes — a cheap 64KB probe that
 *  forces a REAL disk read (fetch alone can hand back a lazy Blob whose reads die later). */
async function probeReadable(blob: Blob): Promise<boolean> {
  try {
    await blob.slice(0, 65_536).arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

function unreadableError(label: string): Error {
  return new Error(
    `${label} is no longer readable in this tab — the file was moved/renamed/edited on disk, ` +
      `offloaded by cloud sync (OneDrive/Drive "online-only"), or attached before a reload. ` +
      `Re-attach the file on the card and launch again — Retry alone re-reads the same dead handle.`,
  );
}

/**
 * Recover the bytes behind a session object URL and PROVE they read, BEFORE anything is claimed
 * or uploaded. A dead handle fails here in under a second with the creative's name and the
 * re-attach remedy (previously it surfaced minutes later as a bare "TypeError: Failed to fetch").
 */
export async function readCreative(
  objUrl: string,
  rawName: string,
  kind: "video" | "image",
  label: string,
): Promise<File> {
  const fallbackType = kind === "image" ? "image/jpeg" : "video/mp4";
  const fallbackName = kind === "image" ? "creative.jpg" : "creative.mp4";
  let blob: Blob;
  try {
    blob = await fetch(objUrl).then((r) => r.blob());
  } catch {
    throw unreadableError(label);
  }
  if (!(await probeReadable(blob))) throw unreadableError(label);
  return new File([blob], rawName || fallbackName, { type: blob.type || fallbackType });
}

/**
 * The bounded-retry harness around ONE upload attempt — separated from the Blob SDK call so the
 * classification/retry logic is testable with a fake attempt. Behavior: each attempt is bounded
 * by UPLOAD_TIMEOUT_MS; network-class failures retry up to UPLOAD_ATTEMPTS with a growing pause;
 * `reprobe` (when given) runs after a failure to detect the source dying MID-upload — that's the
 * unreadable case wearing a network mask, reported with its own remedy; anything else (broker
 * 4xx, quota…) surfaces once with the real message. Every error names the creative via `label`.
 */
export async function withUploadRetries<T>(
  attempt: (signal: AbortSignal) => Promise<T>,
  label: string,
  reprobe?: () => Promise<boolean>,
): Promise<T> {
  for (let n = 1; n <= UPLOAD_ATTEMPTS; n++) {
    const abort = new AbortController();
    const timer = window.setTimeout(() => abort.abort(), UPLOAD_TIMEOUT_MS);
    try {
      return await attempt(abort.signal);
    } catch (e) {
      if (abort.signal.aborted) {
        throw new Error(
          `${label}: upload timed out after ${UPLOAD_TIMEOUT_MS / 60_000} min — the connection is too slow or hung; check it and Retry`,
        );
      }
      if (reprobe && !(await reprobe())) throw unreadableError(label);
      const msg = String((e as Error | null)?.message ?? e);
      if (!isNetworkFlake(e)) {
        throw new Error(`${label}: upload rejected by the media store — ${msg}`);
      }
      if (n === UPLOAD_ATTEMPTS) {
        throw new Error(
          `${label}: network failed ${UPLOAD_ATTEMPTS}× while uploading ("${msg}") — proxy/VPN/antivirus or the connection cut it; check the network and press Retry`,
        );
      }
      await sleep(RETRY_BASE_MS * n);
    } finally {
      window.clearTimeout(timer);
    }
  }
  throw new Error(`${label}: upload failed`); // unreachable — the loop throws or returns
}

/** Upload one creative to the Blob store under `path` — the retry harness above around the real
 *  SDK call; big files ride multipart (part-level SDK retries on top of ours). */
export function uploadCreativeFile(path: string, file: File, label: string): Promise<string> {
  return withUploadRetries(
    async (signal) => {
      const { url } = await upload(path, file, {
        access: "public",
        contentType: file.type || "application/octet-stream",
        handleUploadUrl: "/api/blob-upload",
        abortSignal: signal,
        multipart: file.size >= MULTIPART_MIN_BYTES,
      });
      return url;
    },
    label,
    () => probeReadable(file),
  );
}

/** Filesystem-safe basename for the Blob path (mirrors the old inline sanitizer). */
export function safeBlobName(name: string, fallback: string): string {
  return (name || fallback).replace(/[^\w.-]+/g, "_");
}
