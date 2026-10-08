// Node's built-in runner (v24 strips types natively): `node --test tests/creative-uploads.test.ts`.
// The browser creative-uploader's algorithm lives in lib/creative-upload-core.ts with every side
// effect injected (components/creative-uploads.ts is the thin XHR/fetch/crypto binding, not loadable
// here). These tests drive it with a fake transport + fake file reads: the failure taxonomy (ported
// from the retired blob-uploader.test.ts — network retried 3×, non-network once, timeout wording,
// source died mid-upload, login expired), the 403 → re-plan-once rule, multipart part bookkeeping,
// progress that never slides back, the WebCrypto hash against node:crypto, join-on-hash, the 3-file
// cap and ensure restarting a failed entry once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createAggregator,
  createUploadStore,
  hashBlob,
  partRange,
  PlanError,
  ReplanError,
  runWithRetries,
  type CreativePlanResponse,
  type PutArgs,
  type StoreDeps,
  type UploadTransport,
} from "../lib/creative-upload-core.ts";

const NEVER_SLEEP = async () => {};
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const mkBlob = (bytes: number, type = "video/mp4"): Blob => new Blob([new Uint8Array(bytes)], { type });

// ---------------------------------------------------------------- runWithRetries (failure taxonomy)

test("network class is retried UPLOAD_ATTEMPTS times, then surfaces the network sentence", async () => {
  let n = 0;
  await assert.rejects(
    runWithRetries(
      async () => {
        n++;
        throw new Error("Failed to fetch");
      },
      { label: 'creative "x.mp4"', attempts: 3, retryBaseMs: 1, sleep: NEVER_SLEEP },
    ),
    (e: Error) => {
      assert.match(e.message, /^creative "x\.mp4": network failed 3× while uploading/);
      assert.match(e.message, /press Retry/);
      return true;
    },
  );
  assert.equal(n, 3);
});

test("a store-side 5xx is retried too, but the sentence blames the store — not the buyer's network", async () => {
  let n = 0;
  await assert.rejects(
    runWithRetries(
      async () => {
        n++;
        throw new Error("network error: PUT returned HTTP 503");
      },
      { label: 'creative "x.mp4"', attempts: 3, retryBaseMs: 1, sleep: NEVER_SLEEP },
    ),
    (e: Error) => {
      assert.match(e.message, /^creative "x.mp4": the media store answered HTTP 503 3× in a row/);
      assert.doesNotMatch(e.message, /proxy|VPN/);
      assert.match(e.message, /press Retry/);
      return true;
    },
  );
  assert.equal(n, 3);
});

test("a non-network failure surfaces once as a media-store rejection", async () => {
  let n = 0;
  await assert.rejects(
    runWithRetries(
      async () => {
        n++;
        throw new Error("Content type mismatch");
      },
      { label: 'creative "x.bin"', attempts: 3, sleep: NEVER_SLEEP },
    ),
    /creative "x\.bin": upload rejected by the media store — Content type mismatch/,
  );
  assert.equal(n, 1); // a hard rejection never burns retries
});

test("a timed-out attempt is retried, and the final one keeps the timeout wording", async () => {
  let n = 0;
  await assert.rejects(
    runWithRetries(
      (signal) =>
        new Promise((_res, rej) => {
          n++;
          signal.addEventListener("abort", () => rej(new Error("hung")));
        }),
      { label: 'creative "slow.mp4"', attempts: 2, timeoutMs: 10, retryBaseMs: 1, sleep: NEVER_SLEEP },
    ),
    /creative "slow\.mp4": upload timed out after \d+ min per try/,
  );
  assert.equal(n, 2);
});

test("a source that died mid-upload beats the network mask (re-attach remedy)", async () => {
  await assert.rejects(
    runWithRetries(
      async () => {
        throw new Error("Failed to fetch");
      },
      { label: 'creative "gone.mp4"', reprobe: async () => false, attempts: 3, sleep: NEVER_SLEEP },
    ),
    /creative "gone\.mp4" is no longer readable in this tab/,
  );
});

test("a 403 (ReplanError) bubbles up untouched for the caller to re-plan", async () => {
  await assert.rejects(
    runWithRetries(
      async () => {
        throw new ReplanError();
      },
      { label: 'creative "x.mp4"', reprobe: async () => true, attempts: 3, sleep: NEVER_SLEEP },
    ),
    (e: unknown) => e instanceof ReplanError,
  );
});

// ---------------------------------------------------------------- hash helper

test("hashBlob matches node:crypto across sizes", async () => {
  for (const size of [0, 1, 65_536, 200_000]) {
    const data = new Uint8Array(size).map((_v, i) => i % 251);
    const blob = new Blob([data]);
    const got = await hashBlob(blob, blob.size);
    const want = createHash("sha256").update(Buffer.from(data)).digest("hex");
    assert.equal(got, want, `size ${size}`);
  }
});

test("no WebCrypto, or a file too big, yields no hash (random key, never a mistaken dedupe)", async () => {
  const blob = mkBlob(10);
  assert.equal(await hashBlob(blob, blob.size, null), null); // no WebCrypto in this tab
  assert.equal(await hashBlob(blob, 1024, globalThis.crypto.subtle, 512), null); // size > max
});

// ---------------------------------------------------------------- part range + progress aggregator

test("partRange splits a file into the server's part size, last part short", () => {
  assert.deepEqual(partRange(1, 10, 25), { start: 0, end: 10 });
  assert.deepEqual(partRange(2, 10, 25), { start: 10, end: 20 });
  assert.deepEqual(partRange(3, 10, 25), { start: 20, end: 25 });
});

test("progress aggregation never slides backwards", () => {
  const seen: number[] = [];
  const agg = createAggregator(100, (f) => seen.push(f));
  agg(1, 50); // 0.50
  agg(2, 30); // 0.80
  agg(1, 10); // part 1 retried → sum 40 → would be 0.40, must NOT emit a drop
  agg(2, 50); // sum 60 → 0.60, still below the 0.80 max → no emit
  agg(1, 50); // sum 100 → 1.00
  assert.deepEqual(seen, [0.5, 0.8, 1]);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1]);
});

// ---------------------------------------------------------------- store with a fake transport

type Recorder = {
  plan: number;
  put: number;
  completeParts: { n: number; etag: string }[] | null;
  aborts: number;
};

function fakeStore(
  over: Partial<UploadTransport> & { hash?: (src: string) => string | null; blobs?: Map<string, Blob>; probeOk?: boolean } = {},
): { store: ReturnType<typeof createUploadStore>; rec: Recorder; deps: StoreDeps } {
  const rec: Recorder = { plan: 0, put: 0, completeParts: null, aborts: 0 };
  const transport: UploadTransport = {
    plan: async (): Promise<CreativePlanResponse> => {
      rec.plan++;
      return { ok: true, state: "single", key: "creatives/k.mp4", url: "https://cdn/creatives/k.mp4", putUrl: "https://s3/put", headers: {} };
    },
    put: async (): Promise<{ etag: string | null }> => {
      rec.put++;
      return { etag: '"e"' };
    },
    complete: async (req): Promise<{ url: string }> => {
      rec.completeParts = req.parts;
      return { url: "https://cdn/creatives/k.mp4" };
    },
    abort: async (): Promise<void> => {
      rec.aborts++;
    },
    ...over,
  };
  const blobs = over.blobs ?? new Map<string, Blob>();
  const deps: StoreDeps = {
    transport,
    fetchBlob: async (src) => blobs.get(src) ?? mkBlob(10),
    probe: async () => over.probeOk ?? true,
    hashBytes: async () => null,
    isRemote: (src) => /^https?:\/\//i.test(src),
    sleep: NEVER_SLEEP,
  };
  if (over.hash) {
    const h = over.hash;
    deps.hashBytes = async () => h("");
  }
  return { store: createUploadStore(deps), rec, deps };
}

test("a remote source is done at once, with its own URL and no transport", async () => {
  const { store, rec } = fakeStore();
  const url = await store.ensure("https://cdn/remote.mp4", { name: "r.mp4", kind: "video" });
  assert.equal(url, "https://cdn/remote.mp4");
  assert.equal(store.snapshot("https://cdn/remote.mp4")?.phase, "done");
  assert.equal(rec.plan, 0);
});

test("a single upload runs plan → PUT and lands done", async () => {
  const { store, rec } = fakeStore();
  const url = await store.ensure("blob:a", { name: "a.mp4", kind: "video" });
  assert.equal(url, "https://cdn/creatives/k.mp4");
  assert.equal(rec.plan, 1);
  assert.equal(rec.put, 1);
  assert.equal(store.snapshot("blob:a")?.progress, 1);
});

test('plan answering exists reuses the object — nothing is sent, "reused" is set', async () => {
  const { store, rec } = fakeStore({
    plan: async () => {
      return { ok: true, state: "exists", key: "creatives/k.mp4", url: "https://cdn/creatives/k.mp4" };
    },
  });
  // typed around the recorder: wrap plan to also count
  const url = await store.ensure("blob:a", { name: "a.mp4", kind: "video" });
  assert.equal(url, "https://cdn/creatives/k.mp4");
  assert.equal(rec.put, 0);
  assert.equal(store.snapshot("blob:a")?.reused, true);
});

test("a 403 on the PUT triggers exactly one fresh plan, then succeeds", async () => {
  let puts = 0;
  let plans = 0;
  const { store } = fakeStore({
    plan: async () => {
      plans++;
      return { ok: true, state: "single", key: "creatives/k.mp4", url: "https://cdn/creatives/k.mp4", putUrl: `https://s3/put?${plans}`, headers: {} };
    },
    put: async () => {
      puts++;
      if (puts === 1) throw new ReplanError();
      return { etag: '"e"' };
    },
  });
  const url = await store.ensure("blob:a", { name: "a.mp4", kind: "video" });
  assert.equal(url, "https://cdn/creatives/k.mp4");
  assert.equal(plans, 2); // one fresh plan after the 403
  assert.equal(puts, 2);
});

test("multipart: every part's range is uploaded and the ETags reach complete sorted by n", async () => {
  const size = 25;
  const partSize = 10;
  const putSizes: { n: number; size: number }[] = [];
  const { store, rec } = fakeStore({
    blobs: new Map([["blob:big", mkBlob(size)]]),
    plan: async () => ({
      ok: true,
      state: "multipart",
      key: "creatives/k.mp4",
      url: "https://cdn/creatives/k.mp4",
      uploadId: "up-1",
      partSize,
      // deliberately out of order to prove the sort
      parts: [
        { n: 2, url: "u2" },
        { n: 1, url: "u1" },
        { n: 3, url: "u3" },
      ],
    }),
    put: async ({ url, body }: PutArgs) => {
      const n = Number(url.slice(1));
      putSizes.push({ n, size: body.size });
      return { etag: `"etag-${n}"` };
    },
  });
  const url = await store.ensure("blob:big", { name: "big.mp4", kind: "video" });
  assert.equal(url, "https://cdn/creatives/k.mp4");
  // each part carried its own byte range
  putSizes.sort((a, b) => a.n - b.n);
  assert.deepEqual(putSizes, [
    { n: 1, size: 10 },
    { n: 2, size: 10 },
    { n: 3, size: 5 },
  ]);
  // complete got the parts ascending by n, each with its ETag
  assert.deepEqual(rec.completeParts, [
    { n: 1, etag: '"etag-1"' },
    { n: 2, etag: '"etag-2"' },
    { n: 3, etag: '"etag-3"' },
  ]);
});

test("join-on-hash: two sources with identical bytes share ONE upload", async () => {
  let plans = 0;
  let puts = 0;
  const { store } = fakeStore({
    hash: () => "deadbeef", // both sources hash the same
    plan: async () => {
      plans++;
      return { ok: true, state: "single", key: "creatives/k.mp4", url: "https://cdn/creatives/k.mp4", putUrl: "https://s3/put", headers: {} };
    },
    put: async () => {
      puts++;
      await new Promise((r) => setTimeout(r, 5)); // keep the leader in flight while the follower attaches
      return { etag: '"e"' };
    },
    blobs: new Map([
      ["blob:a", mkBlob(10)],
      ["blob:b", mkBlob(10)],
    ]),
  });
  const [ua, ub] = await Promise.all([
    store.ensure("blob:a", { name: "a.mp4", kind: "video" }),
    store.ensure("blob:b", { name: "b.mp4", kind: "video" }),
  ]);
  assert.equal(ua, "https://cdn/creatives/k.mp4");
  assert.equal(ub, ua);
  assert.equal(plans, 1); // the follower never planned
  assert.equal(puts, 1); // nor uploaded
  assert.equal(store.snapshot("blob:b")?.reused, true);
});

test("at most 3 files upload at once; the rest wait as queued", async () => {
  let concurrent = 0;
  let peak = 0;
  const releases: (() => void)[] = [];
  const { store } = fakeStore({
    put: () =>
      new Promise<{ etag: string | null }>((resolve) => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        releases.push(() => {
          concurrent--;
          resolve({ etag: '"e"' });
        });
      }),
  });
  const srcs = ["a", "b", "c", "d", "e", "f"].map((s) => `blob:${s}`);
  const ps = srcs.map((s) => store.ensure(s, { name: `${s}.mp4`, kind: "video" }));
  await flush();
  assert.equal(concurrent, 3, "exactly three PUTs in flight");
  assert.ok(peak <= 3);
  // drain: each release frees a slot a queued file then takes
  while (releases.length) {
    releases.shift()!();
    await flush();
  }
  await Promise.all(ps);
  assert.ok(peak <= 3, "never more than three concurrent uploads");
  for (const s of srcs) assert.equal(store.snapshot(s)?.phase, "done");
});

test("ensure restarts a failed entry once, and the retry can succeed", async () => {
  let plans = 0;
  const { store } = fakeStore({
    plan: async () => {
      plans++;
      if (plans === 1) throw new PlanError(400, "temporary glitch");
      return { ok: true, state: "single", key: "creatives/k.mp4", url: "https://cdn/creatives/k.mp4", putUrl: "https://s3/put", headers: {} };
    },
  });
  store.start("blob:a", { name: "a.mp4", kind: "video" });
  await flush();
  assert.equal(store.snapshot("blob:a")?.phase, "error");
  assert.match(store.snapshot("blob:a")?.error ?? "", /temporary glitch/);
  const url = await store.ensure("blob:a", { name: "a.mp4", kind: "video" }); // restarts once
  assert.equal(url, "https://cdn/creatives/k.mp4");
  assert.equal(plans, 2);
});

test("a plan answering 401 becomes the login-expired remedy, not a file error", async () => {
  const { store } = fakeStore({
    plan: async () => {
      throw new PlanError(401);
    },
  });
  await assert.rejects(store.ensure("blob:a", { name: "a.mp4", kind: "video" }), (e: Error) => {
    assert.match(e.message, /login expired/i);
    assert.match(e.message, /log in again/i);
    assert.doesNotMatch(e.message, /no longer readable/);
    return true;
  });
});
