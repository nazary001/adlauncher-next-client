// The browser creative-uploader's ALGORITHM, every side effect injected — same house rule as the
// pump cores (lib/snap-pump-core.ts, lib/launch-queue.ts): the part bookkeeping, the join-on-hash
// dedupe, the 3-file cap and the whole failure taxonomy are unit-tested against fakes, with no XHR,
// no fetch, no React. components/creative-uploads.ts binds the real transport (XMLHttpRequest for
// the progress-bearing PUT, fetch for /api/creatives, WebCrypto for the hash) and the React hooks.
//
// Born from components/blob-uploader.ts (owner 08-21 / 01.10): a raw upload surfaced a dead file
// handle, a proxy blip and an expired login all as the same bare "TypeError: Failed to fetch". Every
// error here is still a NAMED, creative-labelled, actionable sentence — the wording is preserved
// verbatim because each line was written after a real incident.
//
// Only type imports from creative-url (erased at runtime): this module stays loadable by `node --test`
// off disk and by the client bundle with no extension gymnastics.
import type {
  CreativeCompleteRequest,
  CreativePlanRequest,
  CreativePlanResponse,
  CreativeKind,
  CreativePurpose,
} from "./creative-url";

export const UPLOAD_ATTEMPTS = 3;
export const RETRY_BASE_MS = 2_000;
// An upload has no server-side deadline — a hung connection would otherwise spin a card (and, before
// the server queue, block the one-at-a-time wave) forever. Seen live 08-07: a task stuck 30+ min.
export const UPLOAD_TIMEOUT_MS = 5 * 60_000;
// At most this many files PUT their bytes at once; the rest wait. Separately, at most MAX_PREPARE
// files are in the read + probe + hash stage at once — hashing holds a file's bytes in memory, so
// that stage is the one that must stay bounded (4 × the 256 MB hash ceiling at the very worst).
export const MAX_UPLOADS = 3;
export const MAX_PREPARE = MAX_UPLOADS + 1;
// Multipart: this many part-PUTs in flight for one file.
export const PART_CONCURRENCY = 4;
// Mirrors CREATIVE_HASH_MAX_BYTES (lib/creative-url.ts) — kept as the helper's own default so this
// module needs no value import from creative-url (see the header). The component always passes the
// real constant; this default only guards a direct call.
export const HASH_MAX_BYTES_DEFAULT = 256 * 1024 * 1024;

export type { CreativeKind, CreativePurpose };

export type UploadPhase = "queued" | "hashing" | "uploading" | "done" | "error";

export type UploadSnapshot = {
  phase: UploadPhase;
  progress: number;
  size: number;
  name: string;
  kind: CreativeKind;
  url?: string;
  reused?: boolean;
  error?: string;
};

export type UploadMeta = {
  name: string;
  kind: CreativeKind;
  purpose?: CreativePurpose;
  /** Error-sentence label override. Default `creative "<name>"`; the Dropzone passes `cover "<name>"`
   *  for a video's custom cover so a dead/rejected cover names itself as a cover, not a creative. */
  label?: string;
};

/** The error-sentence prefix for a source — `creative "clip.mp4"` / the caller's own `cover "…"`. */
export function uploadLabel(meta: UploadMeta): string {
  return meta.label ?? `creative "${meta.name}"`;
}

// ---- error taxonomy (wording preserved from components/blob-uploader.ts, incident by incident) ----

export function unreadableError(label: string): Error {
  return new Error(
    `${label} is no longer readable in this tab — the file was moved/renamed/edited on disk, ` +
      `offloaded by cloud sync (OneDrive/Drive "online-only"), or attached before a reload. ` +
      `Re-attach the file on the card and launch again — Retry alone re-reads the same dead handle.`,
  );
}

export function sessionExpiredError(label: string): Error {
  // Live 01.10: a 7-day login ran out in an open tab mid-wave and every creative failed pointing the
  // buyer at the FILE. A login in another tab revives this one (same cookie).
  return new Error(
    `${label}: your launcher login expired — log in again in a new tab (keep this one open: the cards ` +
      `and attached files stay), then press Retry here`,
  );
}

function timeoutError(label: string): Error {
  return new Error(
    `${label}: upload timed out after ${Math.round(UPLOAD_TIMEOUT_MS / 60_000)} min per try — the ` +
      `connection is too slow or hung; check it and press Retry`,
  );
}

function networkFailedError(label: string, msg: string): Error {
  // A 5xx is the STORE failing on its side — do not send the buyer hunting for a proxy or a VPN.
  const http5 = /http (5\d\d)/i.exec(msg)?.[1];
  if (http5) {
    return new Error(
      `${label}: the media store answered HTTP ${http5} ${UPLOAD_ATTEMPTS}× in a row — it is failing on its ` +
        `side, not your connection; wait a minute and press Retry`,
    );
  }
  return new Error(
    `${label}: network failed ${UPLOAD_ATTEMPTS}× while uploading ("${msg}") — proxy/VPN/antivirus or ` +
      `the connection cut it; check the network and press Retry`,
  );
}

function rejectedError(label: string, msg: string): Error {
  return new Error(`${label}: upload rejected by the media store — ${msg}`);
}

/** The browser-network failure class (no usable HTTP status): a cut connection, a proxy/VPN reset,
 *  DNS, a CORS-invisible reset, or the transport's own 0 / 5xx mapped to this shape. Message-match
 *  only — a bare `instanceof TypeError` also swallowed NON-network TypeErrors and burnt retries on
 *  them, then blamed the buyer's proxy. */
export function isNetworkFlake(e: unknown): boolean {
  const msg = String((e as Error | null)?.message ?? e).toLowerCase();
  return /failed to fetch|networkerror|network error|load failed|fetch failed|socket|econn|network request failed|http 0|http 5\d\d/.test(
    msg,
  );
}

/** A presigned URL came back 403 — it expired, or its signature no longer matches (the public base
 *  was switched under a queued card). The fix is a FRESH plan, not a retry of the same dead URL. */
export class ReplanError extends Error {
  constructor(msg = "presigned url rejected (403)") {
    super(msg);
    this.name = "ReplanError";
  }
}
export function isReplanError(e: unknown): e is ReplanError {
  return e instanceof ReplanError || (e as { name?: string } | null)?.name === "ReplanError";
}

/** A /api/creatives answer that is not ok. `status` 401 ⇒ the login-expired remedy; otherwise the
 *  server's own human sentence is surfaced once. */
export class PlanError extends Error {
  status: number;
  constructor(status: number, serverMessage?: string) {
    super(serverMessage || `request failed (${status})`);
    this.name = "PlanError";
    this.status = status;
  }
}

// ---- pure helpers ----

const sleepReal = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** SHA-256 hex of a blob's bytes, or null when WebCrypto is absent or the file is too big to hash in
 *  one go. NEVER a hand-written hash: a wrong digest would make two different files share one
 *  content-addressed key and launch the wrong creative (lib/creative-url.ts). */
export async function hashBlob(
  blob: { arrayBuffer(): Promise<ArrayBuffer> },
  size: number,
  // Omitted ⇒ the ambient WebCrypto; an explicit null ⇒ "there is none" (so the no-WebCrypto path is
  // testable without passing `undefined`, which would re-trigger the default).
  subtle: SubtleCrypto | null | undefined = undefined,
  maxBytes: number = HASH_MAX_BYTES_DEFAULT,
): Promise<string | null> {
  const s = subtle === undefined ? globalThis.crypto?.subtle : subtle;
  if (!(size <= maxBytes)) return null;
  if (!s) return null;
  const digest = await s.digest("SHA-256", await blob.arrayBuffer());
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

/** Byte range of multipart part `n` (1-based) given the server's part size and the file size. */
export function partRange(n: number, partSize: number, size: number): { start: number; end: number } {
  return { start: (n - 1) * partSize, end: Math.min(size, n * partSize) };
}

/** Aggregates per-part uploaded bytes into one 0…1 fraction that NEVER goes backwards within a run
 *  (a part retry resets that part's bytes; the max-so-far guard keeps the bar from dropping). */
export function createAggregator(size: number, onFraction: (f: number) => void): (part: number, loaded: number) => void {
  const loaded = new Map<number, number>();
  let max = 0;
  return (part, l) => {
    loaded.set(part, l);
    let sum = 0;
    for (const v of loaded.values()) sum += v;
    const f = size > 0 ? Math.min(1, sum / size) : 0;
    if (f > max) {
      max = f;
      onFraction(max);
    }
  };
}

export type PutArgs = {
  url: string;
  body: Blob;
  headers: Record<string, string>;
  signal: AbortSignal;
  /** Cumulative bytes sent for THIS attempt. */
  onProgress?: (loaded: number) => void;
};

/** The injected side effects. The real bindings live in components/creative-uploads.ts. */
export type UploadTransport = {
  /** POST /api/creatives. Throws PlanError on a non-ok answer (status 401 ⇒ login expired). */
  plan: (req: CreativePlanRequest) => Promise<CreativePlanResponse>;
  /** One PUT of `body` to a presigned `url`. Resolves with the response ETag (null if none).
   *  Throws ReplanError on 403, a network-shaped Error on 0 / 5xx / transport error. */
  put: (args: PutArgs) => Promise<{ etag: string | null }>;
  /** POST /api/creatives complete. Throws PlanError on a non-ok answer. */
  complete: (req: CreativeCompleteRequest) => Promise<{ url: string }>;
  /** POST /api/creatives abort — best effort; never throws in a way that matters. */
  abort?: (key: string, uploadId: string) => Promise<void>;
};

export type RetryOpts = {
  label: string;
  /** Re-read the source after a failure: false ⇒ the file died mid-upload (dead-handle wins). */
  reprobe?: () => Promise<boolean>;
  attempts?: number;
  retryBaseMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * The bounded-retry harness around ONE PUT (single file or one multipart part), split from the
 * transport so the classification is testable with a fake attempt. Each attempt is bounded by
 * `timeoutMs`; a dead source (reprobe false) wins over everything; a ReplanError (403) bubbles up
 * untouched so the caller can re-plan once; the network class (XHR error / abort-by-timeout / 0 /
 * 5xx) retries `attempts` times with a growing pause, then surfaces the network (or timeout)
 * sentence; anything else surfaces once as a store rejection. Every error names the creative.
 */
export async function runWithRetries<T>(attempt: (signal: AbortSignal) => Promise<T>, opts: RetryOpts): Promise<T> {
  const attempts = opts.attempts ?? UPLOAD_ATTEMPTS;
  const baseMs = opts.retryBaseMs ?? RETRY_BASE_MS;
  const timeoutMs = opts.timeoutMs ?? UPLOAD_TIMEOUT_MS;
  const sleep = opts.sleep ?? sleepReal;
  for (let n = 1; n <= attempts; n++) {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      return await attempt(signal);
    } catch (e) {
      // A dead file handle masquerading as a network error — report the re-attach remedy instead.
      if (opts.reprobe && !(await opts.reprobe())) throw unreadableError(opts.label);
      // An expired/mismatched presigned URL — the caller re-plans; never a retry of the dead URL.
      if (isReplanError(e)) throw e;
      const timedOut = signal.aborted;
      if (!timedOut && !isNetworkFlake(e)) throw rejectedError(opts.label, String((e as Error | null)?.message ?? e));
      if (n === attempts) {
        throw timedOut ? timeoutError(opts.label) : networkFailedError(opts.label, String((e as Error | null)?.message ?? e));
      }
      await sleep(baseMs * n);
    }
  }
  // unreachable — the loop returns or throws
  throw rejectedError(opts.label, "upload failed");
}

// ---- the upload pipeline (plan → PUT(s) → complete), 403-replan-once ----

export type UploadPipelineDeps = {
  transport: UploadTransport;
  reprobe?: () => Promise<boolean>;
  onFraction: (f: number) => void;
  partConcurrency?: number;
  attempts?: number;
  retryBaseMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

/** Run one file through plan + upload + complete. Resolves `{ url, reused }`; rejects with a
 *  creative-named Error. The 403 ⇒ re-plan happens ONCE, after which a second 403 is surfaced. */
export async function runUploadPipeline(
  blob: Blob,
  plan: CreativePlanRequest,
  label: string,
  deps: UploadPipelineDeps,
): Promise<{ url: string; reused: boolean }> {
  const retry = (attempt: (s: AbortSignal) => Promise<{ etag: string | null }>) =>
    runWithRetries(attempt, {
      label,
      reprobe: deps.reprobe,
      attempts: deps.attempts,
      retryBaseMs: deps.retryBaseMs,
      timeoutMs: deps.timeoutMs,
      sleep: deps.sleep,
    });

  let planned = await planOrThrow(deps.transport, plan, label);
  if (planned.state === "exists") return { url: planned.url, reused: true };

  let replanned = false;
  for (;;) {
    try {
      if (planned.state === "single") {
        const sp = planned; // const so the narrowing survives inside the PUT closure (planned is a let)
        const agg = createAggregator(blob.size, deps.onFraction);
        await retry((signal) => deps.transport.put({ url: sp.putUrl, body: blob, headers: sp.headers, signal, onProgress: (l) => agg(1, l) }));
        deps.onFraction(1);
        return { url: sp.url, reused: false };
      }
      // multipart
      const mp = planned;
      const agg = createAggregator(blob.size, deps.onFraction);
      const etags = await putParts(blob, mp, agg, retry, deps.transport.put, deps.partConcurrency ?? PART_CONCURRENCY);
      const done = await completeOrThrow(deps.transport, { action: "complete", key: mp.key, uploadId: mp.uploadId, parts: etags }, label);
      deps.onFraction(1);
      return { url: done.url, reused: false };
    } catch (e) {
      if (isReplanError(e) && !replanned) {
        replanned = true;
        // A failed multipart leaves a dangling upload id — abort it best-effort before re-planning.
        if (planned.state === "multipart" && deps.transport.abort) {
          await deps.transport.abort(planned.key, planned.uploadId).catch(() => {});
        }
        planned = await planOrThrow(deps.transport, plan, label);
        if (planned.state === "exists") return { url: planned.url, reused: true };
        continue;
      }
      if (isReplanError(e)) throw rejectedError(label, "the upload URL was rejected twice (403) — press Retry");
      throw e;
    }
  }
}

async function putParts(
  blob: Blob,
  mp: Extract<CreativePlanResponse, { state: "multipart" }>,
  agg: (part: number, loaded: number) => void,
  retry: (attempt: (s: AbortSignal) => Promise<{ etag: string | null }>) => Promise<{ etag: string | null }>,
  put: UploadTransport["put"],
  concurrency: number,
): Promise<{ n: number; etag: string }[]> {
  const parts = [...mp.parts].sort((a, b) => a.n - b.n);
  const collected: { n: number; etag: string }[] = [];
  let next = 0;
  // Once one part has failed for good the file is lost for this attempt: the other workers finish
  // the part they are on but take no NEW one (no point pushing more of a file that will be redone).
  let failed = false;
  async function worker(): Promise<void> {
    for (;;) {
      if (failed) return;
      const i = next++;
      if (i >= parts.length) return;
      const p = parts[i];
      const { start, end } = partRange(p.n, mp.partSize, blob.size);
      const slice = blob.slice(start, end);
      try {
        // Each part reports its own bytes into the shared aggregator; other parts keep their last value.
        const res = await retry((signal) => put({ url: p.url, body: slice, headers: {}, signal, onProgress: (l) => agg(p.n, l) }));
        // S3 answers every part with its ETag (the bucket CORS exposes the header). A part WITHOUT one
        // cannot be completed — say so here instead of failing later with S3's opaque complete error.
        if (!res.etag) throw new Error("the storage did not return the part's ETag (bucket CORS must expose it)");
        collected.push({ n: p.n, etag: res.etag });
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, parts.length) }, () => worker());
  await Promise.all(workers);
  // completion order is arrival order; S3 wants parts ascending by n.
  return collected.sort((a, b) => a.n - b.n);
}

type PlannedUpload = Exclude<CreativePlanResponse, { ok: false }>;

async function planOrThrow(transport: UploadTransport, req: CreativePlanRequest, label: string): Promise<PlannedUpload> {
  try {
    const res = await transport.plan(req);
    // A refusal (size / type / not-configured) carries the server's own human sentence (spec §3).
    if (!res.ok) throw new Error(`${label}: ${res.error}`);
    return res;
  } catch (e) {
    throw mapPlanError(e, label);
  }
}

async function completeOrThrow(
  transport: UploadTransport,
  req: CreativeCompleteRequest,
  label: string,
): Promise<{ url: string }> {
  try {
    return await transport.complete(req);
  } catch (e) {
    throw mapPlanError(e, label);
  }
}

function mapPlanError(e: unknown, label: string): Error {
  if (e instanceof PlanError) return e.status === 401 ? sessionExpiredError(label) : new Error(`${label}: ${e.message}`);
  if (isNetworkFlake(e)) return networkFailedError(label, String((e as Error).message ?? e));
  if (e instanceof Error && (e.message.startsWith(`${label}:`) || e.message.startsWith(label))) return e;
  return new Error(`${label}: ${String((e as Error | null)?.message ?? e)}`);
}

// ---- the store: Map<src, entry> + listeners, the 3-file cap and join-on-hash ----

type Entry = {
  src: string;
  meta: UploadMeta;
  snap: UploadSnapshot;
  blob?: Blob; // in-memory source (uploadCreativeBlob) or cached after fetch
  sha256?: string | null;
  token: number; // bumped on every (re)start; a stale worker exits
  running: boolean;
  runPromise: Promise<string>;
  resolve: (url: string) => void;
  reject: (e: Error) => void;
  mirrors: Set<string>; // followers joined on this entry's hash
  maxProgress: number;
};

export type StoreDeps = {
  transport: UploadTransport;
  fetchBlob: (src: string) => Promise<Blob>;
  probe: (blob: Blob) => Promise<boolean>;
  hashBytes: (blob: Blob, size: number) => Promise<string | null>;
  isRemote: (src: string) => boolean;
  sleep?: (ms: number) => Promise<void>;
  maxUploads?: number;
  maxPrepare?: number;
  partConcurrency?: number;
  attempts?: number;
  retryBaseMs?: number;
  timeoutMs?: number;
};

export type UploadStore = {
  start(src: string, meta: UploadMeta): void;
  ensure(src: string, meta: UploadMeta): Promise<string>;
  retry(src: string): void;
  markRemote(src: string, meta: UploadMeta): void;
  startBlob(src: string, blob: Blob, meta: UploadMeta): Promise<string>;
  snapshot(src: string): UploadSnapshot | null;
  subscribe(listener: () => void): () => void;
};

/** FIFO counting semaphore — the gate behind the 3-file upload cap and the one-ahead hash cap. */
class Sem {
  private free: number;
  private q: (() => void)[] = [];
  constructor(n: number) {
    this.free = n;
  }
  acquire(): Promise<void> {
    if (this.free > 0) {
      this.free--;
      return Promise.resolve();
    }
    return new Promise<void>((res) => this.q.push(res));
  }
  release(): void {
    const next = this.q.shift();
    if (next) next();
    else this.free++;
  }
}

export function createUploadStore(deps: StoreDeps): UploadStore {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  const byHash = new Map<string, string>(); // `${sha}|${size}` → leader src
  const uploadSem = new Sem(deps.maxUploads ?? MAX_UPLOADS);
  const prepSem = new Sem(deps.maxPrepare ?? MAX_PREPARE);

  function emit(): void {
    for (const l of listeners) l();
  }

  function setSnap(e: Entry, patch: Partial<UploadSnapshot>): void {
    e.snap = { ...e.snap, ...patch };
    // Followers joined on this entry mirror its live progress/phase until their own await resolves.
    if (e.mirrors.size && (patch.progress != null || patch.phase != null)) {
      for (const src of e.mirrors) {
        const f = entries.get(src);
        if (f && f.snap.phase !== "done" && f.snap.phase !== "error") {
          f.snap = { ...f.snap, phase: e.snap.phase === "done" ? "uploading" : e.snap.phase, progress: e.snap.progress };
        }
      }
    }
    emit();
  }

  function setProgress(e: Entry, f: number): void {
    if (f > e.maxProgress) {
      e.maxProgress = f;
      setSnap(e, { progress: f });
    }
  }

  function makeEntry(src: string, meta: UploadMeta, kind: CreativeKind): Entry {
    const e: Entry = {
      src,
      meta,
      snap: { phase: "queued", progress: 0, size: 0, name: meta.name, kind },
      token: 0,
      running: false,
      runPromise: Promise.resolve(""),
      resolve: () => {},
      reject: () => {},
      mirrors: new Set(),
      maxProgress: 0,
    };
    entries.set(src, e);
    return e;
  }

  function finishDone(e: Entry, url: string, reused: boolean): void {
    e.maxProgress = 1;
    setSnap(e, { phase: "done", progress: 1, url, reused });
    e.running = false;
    e.resolve(url);
  }

  function finishError(e: Entry, err: Error): void {
    setSnap(e, { phase: "error", error: err.message });
    e.running = false;
    // Drop this entry's leadership so a retry can re-claim or a sibling can lead.
    for (const [k, v] of byHash) if (v === e.src) byHash.delete(k);
    e.reject(err);
  }

  function beginRun(e: Entry, meta: UploadMeta): void {
    const token = ++e.token;
    e.running = true;
    e.maxProgress = 0;
    e.meta = meta;
    e.snap = { phase: "queued", progress: 0, size: e.snap.size, name: meta.name, kind: e.snap.kind };
    e.runPromise = new Promise<string>((res, rej) => {
      e.resolve = res;
      e.reject = rej;
    });
    // A rejected runPromise nobody awaits must not crash the serverless instance / dev overlay.
    e.runPromise.catch(() => {});
    emit();
    void worker(e, token);
  }

  async function worker(e: Entry, token: number): Promise<void> {
    const label = uploadLabel(e.meta);
    const stale = () => e.token !== token;
    await prepSem.acquire();
    let holdingPrep = true;
    // The prepare slot covers ONLY read + probe + hash (the stage that holds a file's bytes in
    // memory). It is handed back before the entry waits — on a leader with the same bytes, or on an
    // upload slot — so files queued behind duplicates never sit idle while upload slots are free.
    const releasePrep = () => {
      if (holdingPrep) {
        holdingPrep = false;
        prepSem.release();
      }
    };
    let holdingUpload = false;
    try {
      if (stale()) return;
      // ---- prepare: recover the bytes and PROVE they read, before anything is planned ----
      setSnap(e, { phase: "hashing" });
      let blob: Blob;
      try {
        blob = e.blob ?? (await deps.fetchBlob(e.src));
      } catch {
        if (!stale()) finishError(e, unreadableError(label));
        return;
      }
      if (stale()) return;
      if (!(await deps.probe(blob))) {
        if (!stale()) finishError(e, unreadableError(label));
        return;
      }
      if (stale()) return;
      setSnap(e, { size: blob.size });
      const sha = await deps.hashBytes(blob, blob.size).catch(() => null);
      releasePrep();
      if (stale()) return;
      e.sha256 = sha;

      // ---- join-on-hash: identical bytes already uploading / on the server ⇒ attach, don't re-send ----
      if (sha) {
        for (;;) {
          // Same bytes AND same purpose: a "keep" upload (never expires) must not be handed the URL
          // of an expiring "creative" object that happens to hold the same bytes.
          const key = `${e.meta.purpose ?? "creative"}|${sha}|${blob.size}`;
          const leaderSrc = byHash.get(key);
          if (!leaderSrc || leaderSrc === e.src) {
            byHash.set(key, e.src); // I am the leader
            break;
          }
          const leader = entries.get(leaderSrc);
          if (!leader || leader.snap.phase === "error") {
            byHash.delete(key);
            continue;
          }
          leader.mirrors.add(e.src);
          setSnap(e, { phase: leader.snap.phase === "done" ? "uploading" : leader.snap.phase, progress: leader.snap.progress });
          try {
            const url = await leader.runPromise;
            if (!stale()) finishDone(e, url, true);
            return;
          } catch {
            leader.mirrors.delete(e.src);
            if (stale()) return;
            if (byHash.get(key) === leaderSrc) byHash.delete(key);
            // leader failed — fall through the loop to claim leadership and upload myself
          }
        }
      }

      // ---- upload: wait for a file slot, then plan → PUT(s) → complete ----
      await uploadSem.acquire();
      holdingUpload = true;
      if (stale()) return;
      setSnap(e, { phase: "uploading", progress: e.maxProgress });
      const planReq: CreativePlanRequest = {
        action: "plan",
        size: blob.size,
        type: blob.type,
        name: e.meta.name,
        ...(sha ? { sha256: sha } : {}),
        ...(e.meta.purpose ? { purpose: e.meta.purpose } : {}),
      };
      const { url, reused } = await runUploadPipeline(blob, planReq, label, {
        transport: deps.transport,
        reprobe: () => deps.probe(blob),
        onFraction: (f) => {
          if (!stale()) setProgress(e, f);
        },
        partConcurrency: deps.partConcurrency,
        attempts: deps.attempts,
        retryBaseMs: deps.retryBaseMs,
        timeoutMs: deps.timeoutMs,
        sleep: deps.sleep,
      });
      if (stale()) return;
      finishDone(e, url, reused);
    } catch (err) {
      if (!stale()) finishError(e, err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (holdingUpload) uploadSem.release();
      releasePrep();
    }
  }

  function start(src: string, meta: UploadMeta): void {
    if (deps.isRemote(src)) return markRemote(src, meta);
    let e = entries.get(src);
    if (!e) e = makeEntry(src, meta, meta.kind);
    // Idempotent: a source already done / in flight is left alone; a fresh or errored one (re)starts.
    if (e.snap.phase === "done" || e.running) return;
    beginRun(e, meta);
  }

  function markRemote(src: string, meta: UploadMeta): void {
    let e = entries.get(src);
    if (!e) e = makeEntry(src, meta, meta.kind);
    if (e.snap.phase === "done") return;
    e.running = false;
    e.snap = { phase: "done", progress: 1, size: 0, name: meta.name, kind: meta.kind, url: src };
    e.runPromise = Promise.resolve(src);
    emit();
  }

  function ensure(src: string, meta: UploadMeta): Promise<string> {
    if (deps.isRemote(src)) {
      markRemote(src, meta);
      return Promise.resolve(src);
    }
    let e = entries.get(src);
    if (!e) {
      e = makeEntry(src, meta, meta.kind);
      beginRun(e, meta);
      return e.runPromise;
    }
    if (e.snap.phase === "done") return Promise.resolve(e.snap.url!);
    // A failed entry is restarted ONCE for this call; an idle (never-run) one is kicked.
    if (e.snap.phase === "error" || !e.running) beginRun(e, meta);
    return e.runPromise;
  }

  function retry(src: string): void {
    const e = entries.get(src);
    if (!e || e.running || e.snap.phase !== "error") return;
    beginRun(e, e.meta);
  }

  function startBlob(src: string, blob: Blob, meta: UploadMeta): Promise<string> {
    let e = entries.get(src);
    if (!e) e = makeEntry(src, meta, meta.kind);
    e.blob = blob;
    if (e.snap.phase === "done") return e.runPromise;
    if (!e.running) beginRun(e, meta);
    return e.runPromise;
  }

  function snapshot(src: string): UploadSnapshot | null {
    return entries.get(src)?.snap ?? null;
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { start, ensure, retry, markRemote, startBlob, snapshot, subscribe };
}
