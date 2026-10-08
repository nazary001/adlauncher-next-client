// Client-side creative uploads to OUR S3 bucket — one manager for every rail (owner ask 08.10:
// "когда ребята только добавляют креатив … чтобы он уже сразу загружался куда-то и уже потом оттуда
// использовался для самого запуска"). A file starts uploading the moment it is ATTACHED to a card
// (the shared Dropzone calls startCreativeUpload); by the time the buyer presses Launch it is usually
// already there, and the launch just takes its URL (ensureCreativeUploaded).
//
// The manager is a module-level singleton keyed by the file's SESSION OBJECT URL (the `blob:` URL
// every FileItem carries): duplicated cards and "apply creative to all" share the URL and therefore
// the upload; uploads survive navigating between boards; nothing is ever uploaded twice in a tab.
//
// This file is the BROWSER BINDING only — the XMLHttpRequest PUT (fetch has no upload progress), the
// /api/creatives fetches, the WebCrypto hash and the React hooks. The algorithm (the 3-file cap, the
// join-on-hash dedupe, the whole failure taxonomy) lives in lib/creative-upload-core.ts, unit-tested
// with fakes. window / XMLHttpRequest / crypto are touched only when a function is CALLED, so the
// module imports cleanly on the server and under `node --test`.

import { useRef, useSyncExternalStore } from "react";
import { CREATIVE_HASH_MAX_BYTES, type CreativeCompleteRequest, type CreativePlanRequest, type CreativePlanResponse } from "@/lib/creative-url";
import {
  createUploadStore,
  hashBlob,
  PlanError,
  ReplanError,
  type CreativeKind,
  type CreativePurpose,
  type PutArgs,
  type UploadMeta,
  type UploadSnapshot,
  type UploadStore,
  type UploadTransport,
} from "@/lib/creative-upload-core";

export type { CreativeKind, CreativePurpose, UploadMeta, UploadSnapshot };
export type UploadPhase = UploadSnapshot["phase"];

/** An http(s) URL needs no upload (HS "add by URL", a remembered identity) — it IS the remote URL. */
export function isRemoteSource(src: string): boolean {
  return /^https?:\/\//i.test(src);
}

// ---- real transport (browser only; constructed lazily so import never touches window) ----

async function fetchBlob(src: string): Promise<Blob> {
  // fetch() of a session object URL hands back the File behind it; a dead handle rejects here or at
  // the probe below (lib/creative-upload-core turns either into the re-attach remedy).
  const r = await fetch(src);
  return r.blob();
}

/** A cheap 64 KB read that forces a REAL disk read — fetch alone can hand back a lazy Blob whose
 *  reads die later (a moved/renamed/cloud-offloaded file). */
async function probe(blob: Blob): Promise<boolean> {
  try {
    await blob.slice(0, 65_536).arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

async function hashBytes(blob: Blob, size: number): Promise<string | null> {
  return hashBlob(blob, size, globalThis.crypto?.subtle, CREATIVE_HASH_MAX_BYTES);
}

async function planFetch(req: CreativePlanRequest): Promise<CreativePlanResponse> {
  let res: Response;
  try {
    res = await fetch("/api/creatives", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
      cache: "no-store",
    });
  } catch (e) {
    // The POST itself never left — a cut connection / proxy reset. Shaped so isNetworkFlake matches.
    throw new Error(`network error: ${String((e as Error | null)?.message ?? e)}`);
  }
  if (res.status === 401) throw new PlanError(401);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new PlanError(res.status, body?.error || `plan failed (HTTP ${res.status})`);
  }
  return (await res.json()) as CreativePlanResponse;
}

async function completeFetch(req: CreativeCompleteRequest): Promise<{ url: string }> {
  let res: Response;
  try {
    res = await fetch("/api/creatives", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
      cache: "no-store",
    });
  } catch (e) {
    throw new Error(`network error: ${String((e as Error | null)?.message ?? e)}`);
  }
  if (res.status === 401) throw new PlanError(401);
  const body = (await res.json().catch(() => null)) as { ok?: boolean; url?: string; error?: string } | null;
  if (!res.ok || !body?.ok || !body.url) throw new PlanError(res.status || 500, body?.error || `complete failed (HTTP ${res.status})`);
  return { url: body.url };
}

async function abortFetch(key: string, uploadId: string): Promise<void> {
  try {
    await fetch("/api/creatives", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "abort", key, uploadId }),
      cache: "no-store",
      keepalive: true,
    });
  } catch {
    /* best effort — the bucket lifecycle aborts stale multipart uploads after 2 days anyway */
  }
}

/** One PUT with real upload progress (only XMLHttpRequest exposes it). Maps S3's answers to the
 *  taxonomy the core expects: 2xx → ETag, 403 → ReplanError (expired/mismatched URL → re-plan),
 *  0 / 5xx / transport error → a network-shaped Error (retried), other 4xx → surfaced once. */
function putXhr({ url, body, headers, signal, onProgress }: PutArgs): Promise<{ etag: string | null }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    for (const [k, v] of Object.entries(headers)) {
      try {
        xhr.setRequestHeader(k, v);
      } catch {
        /* a forbidden header name — the plan only returns safe ones */
      }
    }
    if (xhr.upload && onProgress) {
      xhr.upload.onprogress = (ev: ProgressEvent) => {
        if (ev.lengthComputable) onProgress(ev.loaded);
      };
    }
    xhr.onload = () => {
      const s = xhr.status;
      if (s >= 200 && s < 300) {
        resolve({ etag: xhr.getResponseHeader("ETag") });
        return;
      }
      if (s === 403) {
        reject(new ReplanError());
        return;
      }
      if (s === 0 || s >= 500) {
        reject(new Error(`network error: PUT returned HTTP ${s}`));
        return;
      }
      reject(new Error(`the storage rejected the upload (HTTP ${s})`));
    };
    xhr.onerror = () => reject(new Error("network error: the PUT could not be sent"));
    xhr.ontimeout = () => reject(new Error("network error: the PUT timed out"));
    xhr.onabort = () => reject(new Error("aborted"));
    const onAbort = () => {
      try {
        xhr.abort();
      } catch {
        /* already finished */
      }
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    try {
      xhr.send(body);
    } catch (e) {
      reject(new Error(`network error: ${String((e as Error | null)?.message ?? e)}`));
    }
  });
}

const transport: UploadTransport = { plan: planFetch, put: putXhr, complete: completeFetch, abort: abortFetch };

let _store: UploadStore | null = null;
function store(): UploadStore {
  if (!_store) {
    _store = createUploadStore({ transport, fetchBlob, probe, hashBytes, isRemote: isRemoteSource });
  }
  return _store;
}

// ---- public API (every call reaches the lazily-built singleton) ----

/** Start uploading the bytes behind a session object URL. Idempotent per `src`; a remote source is
 *  recorded as done at once. Never throws — failures land in the snapshot. */
export function startCreativeUpload(src: string, meta: UploadMeta): void {
  store().start(src, meta);
}

/** The remote URL of `src`, starting / joining its upload as needed. Rejects with an Error whose
 *  message is a complete, creative-named sentence. A failed entry is restarted ONCE per ensure call. */
export function ensureCreativeUploaded(src: string, meta: UploadMeta): Promise<string> {
  return store().ensure(src, meta);
}

/** Re-run a failed upload (no-op in any other phase). */
export function retryCreativeUpload(src: string): void {
  store().retry(src);
}

/** Current state of one source (null = never started). Referentially stable until it changes. */
export function creativeUploadSnapshot(src: string): UploadSnapshot | null {
  return store().snapshot(src);
}

/** Subscribe to ANY upload state change; returns the unsubscribe. */
export function subscribeCreativeUploads(listener: () => void): () => void {
  return store().subscribe(listener);
}

/** Upload bytes that exist only in memory (a canvas crop, a generated image) and resolve with the
 *  remote URL. Rejects like ensureCreativeUploaded. */
export function uploadCreativeBlob(blob: Blob, meta: UploadMeta): Promise<string> {
  // An object URL so the source is keyed like every other creative (useCreativeUpload works on it)
  // and the pipeline can re-read the bytes; session-lived, like the Dropzone's own URLs.
  const src = URL.createObjectURL(blob);
  const done = store().startBlob(src, blob, meta);
  // Once it is on the server only the remote URL is used — release the tab-local one. (Kept on a
  // failure: a retry re-reads the bytes through it.)
  void done.then(
    () => URL.revokeObjectURL(src),
    () => {},
  );
  return done;
}

// ---- React bindings ----

const subscribe = (listener: () => void): (() => void) => store().subscribe(listener);
const EMPTY: ReadonlyArray<UploadSnapshot | null> = [];

/** React binding of one source (null while `src` is undefined or was never started). */
export function useCreativeUpload(src: string | undefined): UploadSnapshot | null {
  return useSyncExternalStore(
    subscribe,
    () => (src ? store().snapshot(src) : null),
    () => null,
  );
}

/** React binding of several sources at once (same order; the array keeps its identity until one of
 *  ITS sources changes, so a consumer does not re-render when an unrelated upload moves). */
export function useCreativeUploads(srcs: readonly string[]): ReadonlyArray<UploadSnapshot | null> {
  const cache = useRef<{ snaps: ReadonlyArray<UploadSnapshot | null> }>(null);
  const getSnapshot = (): ReadonlyArray<UploadSnapshot | null> => {
    const next = srcs.map((s) => store().snapshot(s));
    const prev = cache.current?.snaps;
    if (prev && prev.length === next.length && prev.every((p, i) => p === next[i])) return prev;
    cache.current = { snaps: next };
    return next;
  };
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
}

/** A cheap session probe: false ONLY when the launcher definitively says this tab's login is gone
 *  (401). Unknown (a network blip) counts as alive — never claim an expiry we did not see. Exported
 *  because other code may still want to tell "login expired" from "network down". */
export async function sessionAlive(): Promise<boolean> {
  try {
    const r = await fetch("/api/auth/session", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    return r.status !== 401;
  } catch {
    return true;
  }
}
