// Node's built-in runner (v24 strips types natively): `node --test tests/fb-media-cache.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts imports below are a Node requirement.
//
// Two units of the fb-media head-start/reuse package (spec §4.6):
//   1. resolveCachedVideo — the PURE Meta-video reuse decision (injected deps);
//   2. graphBase — the loopback-Graph rule (the production guard + the loopback-only allow).
// graphBase lives in lib/fb-graph.ts; it is only node-loadable because that module's relative imports
// carry .ts extensions (added with this package). Both belong to the same fb-media work, so they
// share this file rather than a new one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCachedVideo, type VideoCacheDeps, type VideoProbeStatus } from "../lib/fb-media-cache.ts";
import { graphBase } from "../lib/fb-graph.ts";

// ---- resolveCachedVideo: the pure reuse decision ------------------------------------------------

type Calls = { read: string[]; write: Array<[string, string]>; drop: string[]; probe: string[]; upload: number };

function fakeDeps(
  over: {
    cached?: string | null;
    status?: VideoProbeStatus;
    probeThrows?: boolean;
    readThrows?: boolean;
    writeThrows?: boolean;
    uploadId?: string;
  } = {},
): { deps: VideoCacheDeps; calls: Calls } {
  const calls: Calls = { read: [], write: [], drop: [], probe: [], upload: 0 };
  const deps: VideoCacheDeps = {
    readCache: async (k) => {
      calls.read.push(k);
      if (over.readThrows) throw new Error("store down");
      return over.cached ?? null;
    },
    writeCache: async (k, v) => {
      calls.write.push([k, v]);
      if (over.writeThrows) throw new Error("store down");
    },
    dropCache: async (k) => {
      calls.drop.push(k);
    },
    probe: async (v) => {
      calls.probe.push(v);
      if (over.probeThrows) throw new Error("object does not exist");
      return over.status ?? "stale";
    },
    uploadFresh: async () => {
      calls.upload++;
      return over.uploadId ?? "vid-fresh";
    },
  };
  return { deps, calls };
}

test("miss → upload fresh and write the cache", async () => {
  const { deps, calls } = fakeDeps({ cached: null, uploadId: "vid-1" });
  const id = await resolveCachedVideo("acct|creatives/aa-1.mp4", deps, new Map());
  assert.equal(id, "vid-1");
  assert.equal(calls.upload, 1);
  assert.deepEqual(calls.write, [["acct|creatives/aa-1.mp4", "vid-1"]]);
  assert.deepEqual(calls.probe, []); // nothing cached to probe
  assert.deepEqual(calls.drop, []);
});

test("fresh hit (ready) → reuse, no upload", async () => {
  const { deps, calls } = fakeDeps({ cached: "vid-cached", status: "ready" });
  const id = await resolveCachedVideo("acct|creatives/aa-1.mp4", deps, new Map());
  assert.equal(id, "vid-cached");
  assert.equal(calls.upload, 0);
  assert.deepEqual(calls.probe, ["vid-cached"]);
  assert.deepEqual(calls.write, []);
  assert.deepEqual(calls.drop, []);
});

test("fresh hit (processing) → reuse, no upload", async () => {
  const { deps, calls } = fakeDeps({ cached: "vid-cached", status: "processing" });
  const id = await resolveCachedVideo("acct|creatives/aa-1.mp4", deps, new Map());
  assert.equal(id, "vid-cached");
  assert.equal(calls.upload, 0);
});

test("hit with a stale/error status → drop the entry and upload fresh", async () => {
  const { deps, calls } = fakeDeps({ cached: "vid-dead", status: "stale", uploadId: "vid-new" });
  const id = await resolveCachedVideo("acct|creatives/aa-1.mp4", deps, new Map());
  assert.equal(id, "vid-new");
  assert.deepEqual(calls.drop, ["acct|creatives/aa-1.mp4"]);
  assert.equal(calls.upload, 1);
  assert.deepEqual(calls.write, [["acct|creatives/aa-1.mp4", "vid-new"]]);
});

test("probe throws (Graph 'object does not exist') → drop and upload fresh", async () => {
  const { deps, calls } = fakeDeps({ cached: "vid-dead", probeThrows: true, uploadId: "vid-new" });
  const id = await resolveCachedVideo("acct|creatives/aa-1.mp4", deps, new Map());
  assert.equal(id, "vid-new");
  assert.deepEqual(calls.drop, ["acct|creatives/aa-1.mp4"]);
  assert.equal(calls.upload, 1);
});

test("cache read throws → upload fresh (never fail the upload over the cache)", async () => {
  const { deps, calls } = fakeDeps({ readThrows: true, uploadId: "vid-new" });
  const id = await resolveCachedVideo("acct|creatives/aa-1.mp4", deps, new Map());
  assert.equal(id, "vid-new");
  assert.equal(calls.upload, 1);
  assert.deepEqual(calls.probe, []); // the throw means "no usable cache" → straight to upload
});

test("cache write throws → still returns the fresh id", async () => {
  const { deps, calls } = fakeDeps({ cached: null, writeThrows: true, uploadId: "vid-new" });
  const id = await resolveCachedVideo("acct|creatives/aa-1.mp4", deps, new Map());
  assert.equal(id, "vid-new");
  assert.equal(calls.upload, 1);
});

test("non-content URL / reuse-off (ckey null) bypasses the cache entirely", async () => {
  const { deps, calls } = fakeDeps({ cached: "vid-cached", status: "ready", uploadId: "vid-fresh" });
  const id = await resolveCachedVideo(null, deps, new Map());
  assert.equal(id, "vid-fresh");
  assert.equal(calls.upload, 1);
  assert.deepEqual(calls.read, []);
  assert.deepEqual(calls.probe, []);
  assert.deepEqual(calls.write, []);
});

test("concurrent calls with the same ckey share ONE upload", async () => {
  let resolveUpload!: (id: string) => void;
  const gate = new Promise<string>((r) => {
    resolveUpload = r;
  });
  let uploads = 0;
  const deps: VideoCacheDeps = {
    readCache: async () => null,
    writeCache: async () => {},
    dropCache: async () => {},
    probe: async () => "ready",
    uploadFresh: async () => {
      uploads++;
      return gate; // stays pending until we release it — both callers are in flight meanwhile
    },
  };
  const inflight = new Map<string, Promise<string>>();
  const a = resolveCachedVideo("acct|creatives/aa-1.mp4", deps, inflight);
  const b = resolveCachedVideo("acct|creatives/aa-1.mp4", deps, inflight);
  resolveUpload("vid-shared");
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra, "vid-shared");
  assert.equal(rb, "vid-shared");
  assert.equal(uploads, 1); // the second caller joined the first's in-flight upload
  assert.equal(inflight.size, 0); // the entry is cleaned up after it settles
});

// ---- graphBase: the loopback-Graph rule --------------------------------------------------------

const REAL = "https://graph.facebook.com/v21.0";

function withEnv(env: { base?: string; vercel?: string }, fn: () => void): void {
  const prevBase = process.env.FB_GRAPH_BASE;
  const prevVercel = process.env.VERCEL_ENV;
  if (env.base === undefined) delete process.env.FB_GRAPH_BASE;
  else process.env.FB_GRAPH_BASE = env.base;
  if (env.vercel === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = env.vercel;
  try {
    fn();
  } finally {
    if (prevBase === undefined) delete process.env.FB_GRAPH_BASE;
    else process.env.FB_GRAPH_BASE = prevBase;
    if (prevVercel === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = prevVercel;
  }
}

test("graphBase: unset FB_GRAPH_BASE → the real Graph", () => {
  withEnv({}, () => assert.equal(graphBase(), REAL));
});

test("graphBase: a loopback base off production → that base (trailing slash stripped)", () => {
  withEnv({ base: "http://127.0.0.1:8900/" }, () => assert.equal(graphBase(), "http://127.0.0.1:8900"));
  withEnv({ base: "http://localhost:3000/g", vercel: "preview" }, () => assert.equal(graphBase(), "http://localhost:3000/g"));
  withEnv({ base: "http://127.0.0.1" }, () => assert.equal(graphBase(), "http://127.0.0.1"));
});

test("graphBase: the production guard — a loopback base is ignored on Vercel production", () => {
  withEnv({ base: "http://127.0.0.1:8900", vercel: "production" }, () => assert.equal(graphBase(), REAL));
});

test("graphBase: a non-loopback host is never used, even off production", () => {
  withEnv({ base: "https://graph.facebook.com/v21.0" }, () => assert.equal(graphBase(), REAL));
  withEnv({ base: "http://evil.example.com" }, () => assert.equal(graphBase(), REAL));
  withEnv({ base: "http://127.0.0.1.evil.com" }, () => assert.equal(graphBase(), REAL));
  withEnv({ base: "https://127.0.0.1:8900" }, () => assert.equal(graphBase(), REAL)); // https is not loopback-http
});
