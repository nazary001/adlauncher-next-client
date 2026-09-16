// Node's built-in runner (v24 strips types natively): `node --test tests/snap-keys.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// Snapchat rail — the key registry over Strapi `app-cache` rows (ckey "snap-key:<key>", unique →
// an atomic claim): free/next computation, the claim walk (unique-400 → next candidate, lost
// concurrent race → delete ours and walk on, pool exhausted → throw), backfill and release.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.STRAPI_API_URL = "https://strapi.test";
process.env.STRAPI_TOKEN = "tok";
const keys = await import("../lib/snap-keys.ts");

type Rec = { url: string; method: string; body: Record<string, unknown> | null };
function stubFetch(handler: (r: Rec, n: number) => Response) {
  const calls: Rec[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const rec = { url: String(input), method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : null };
    calls.push(rec);
    return handler(rec, calls.length);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}
const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const row = (key: string, documentId: string, extra: Record<string, unknown> = {}) => ({
  documentId,
  ckey: `snap-key:${key}`,
  cvalue: { key, status: "active", user: "nazar", claimed_at: 1, ...extra },
  refreshed_at: 1,
  createdAt: "2026-09-16T00:00:00.000Z",
});

test("free / next: the pool minus the used keys, desired-or-next with wrap-around", () => {
  const used = ["glo-snp_001", "glo-snp_003"];
  const free = keys.snapFreeKeys(used);
  assert.equal(free.length, 98);
  assert.equal(free[0], "glo-snp_002");
  assert.equal(keys.snapNextKey(used), "glo-snp_002");
  assert.equal(keys.snapNextKey(used, "glo-snp_003"), "glo-snp_004");
  assert.equal(keys.snapNextKey(used, "glo-snp_050"), "glo-snp_050");
  assert.equal(keys.snapNextKey(used, "glo-snp_100"), "glo-snp_100");
  assert.equal(keys.snapNextKey(keys.snapFreeKeys([]), "glo-snp_100"), null);
  assert.deepEqual(keys.snapKeyCandidates(["glo-snp_099"], "glo-snp_099").slice(0, 2), ["glo-snp_100", "glo-snp_001"]);
});

test("listSnapKeys reads the prefix filter, maps rows, and throws on a failed page", async () => {
  const stub = stubFetch((r) => (/\$startsWith\]=snap-key%3A/.test(r.url) ? json({ data: [row("glo-snp_002", "d2", { campaign_id: "cmp-1" }), row("glo-snp_001", "d1")] }) : json({}, 500)));
  try {
    const rows = await keys.listSnapKeys();
    assert.deepEqual(
      rows.map((x) => [x.key, x.documentId, x.status, x.campaign_id ?? null]),
      [["glo-snp_001", "d1", "active", null], ["glo-snp_002", "d2", "active", "cmp-1"]],
    );
    assert.match(stub.calls[0].url, /pagination\[pageSize\]=100/);
  } finally {
    stub.restore();
  }
  const bad = stubFetch(() => json({}, 503));
  try {
    await assert.rejects(keys.listSnapKeys(), /strapi 503/);
  } finally {
    bad.restore();
  }
});

test("claim: unique-400 on the desired key walks to the next; the winner is verified oldest-first", async () => {
  const stub = stubFetch((r) => {
    if (r.method === "GET" && /startsWith/.test(r.url)) return json({ data: [row("glo-snp_001", "d1")] });
    if (r.method === "POST") {
      const ckey = String((r.body?.data as Record<string, unknown>)?.ckey);
      if (ckey === "snap-key:glo-snp_002") return json({ error: { status: 400, message: "This attribute must be unique" } }, 400);
      return json({ data: { documentId: "mine-3" } });
    }
    if (r.method === "GET" && /\$eq\]=snap-key%3Aglo-snp_003/.test(r.url)) return json({ data: [{ documentId: "mine-3" }] });
    return json({}, 404);
  });
  try {
    const r = await keys.claimSnapKey("glo-snp_002", { user: "nazar", niche: "Cars" });
    assert.deepEqual(r, { key: "glo-snp_003", documentId: "mine-3" });
    const posts = stub.calls.filter((c) => c.method === "POST");
    assert.deepEqual(posts.map((p) => (p.body?.data as Record<string, unknown>).ckey), ["snap-key:glo-snp_002", "snap-key:glo-snp_003"]);
    const value = (posts[1].body?.data as Record<string, unknown>).cvalue as Record<string, unknown>;
    assert.equal(value.key, "glo-snp_003");
    assert.equal(value.status, "active");
    assert.equal(value.user, "nazar");
    assert.equal(value.niche, "Cars");
    assert.equal(typeof value.claimed_at, "number");
  } finally {
    stub.restore();
  }
});

test("claim: a lost concurrent race (an older twin row) deletes ours and walks on", async () => {
  const stub = stubFetch((r) => {
    if (r.method === "GET" && /startsWith/.test(r.url)) return json({ data: [] });
    if (r.method === "POST") {
      const ckey = String((r.body?.data as Record<string, unknown>)?.ckey);
      return json({ data: { documentId: ckey.endsWith("001") ? "mine-1" : "mine-2" } });
    }
    if (r.method === "GET" && /glo-snp_001/.test(r.url)) return json({ data: [{ documentId: "theirs-1" }, { documentId: "mine-1" }] });
    if (r.method === "GET" && /glo-snp_002/.test(r.url)) return json({ data: [{ documentId: "mine-2" }] });
    if (r.method === "DELETE") return json({});
    return json({}, 404);
  });
  try {
    const r = await keys.claimSnapKey(undefined, { user: "nazar" });
    assert.deepEqual(r, { key: "glo-snp_002", documentId: "mine-2" });
    assert.deepEqual(stub.calls.filter((c) => c.method === "DELETE").map((c) => c.url), ["https://strapi.test/api/app-caches/mine-1"]);
  } finally {
    stub.restore();
  }
});

test("claim: every key used → pool exhausted without a single POST; a non-400 POST failure aborts", async () => {
  const all = Array.from({ length: 100 }, (_, i) => row(`glo-snp_${String(i + 1).padStart(3, "0")}`, `d${i + 1}`));
  const full = stubFetch((r) => (r.method === "GET" ? json({ data: all }) : json({}, 500)));
  try {
    await assert.rejects(keys.claimSnapKey(undefined, { user: "nazar" }), /pool exhausted/);
    assert.equal(full.calls.filter((c) => c.method === "POST").length, 0);
  } finally {
    full.restore();
  }
  const broken = stubFetch((r) => (r.method === "GET" ? json({ data: [] }) : json({ error: "boom" }, 503)));
  try {
    await assert.rejects(keys.claimSnapKey(undefined, { user: "nazar" }), /claim failed \(503\)/);
  } finally {
    broken.restore();
  }
});

test("backfill merges into the row's cvalue with a PUT that carries NO ckey; release deletes", async () => {
  const stub = stubFetch((r) => {
    if (r.method === "GET") return json({ data: [row("glo-snp_005", "d5", { niche: "Cars" })] });
    return json({});
  });
  try {
    await keys.backfillSnapKey("glo-snp_005", { status: "retired", campaign_id: "cmp-9", notes: "refused at adsquad" });
    const put = stub.calls.find((c) => c.method === "PUT")!;
    assert.equal(put.url, "https://strapi.test/api/app-caches/d5");
    const data = put.body?.data as Record<string, unknown>;
    assert.equal(data.ckey, undefined);
    assert.deepEqual(data.cvalue, { key: "glo-snp_005", status: "retired", user: "nazar", claimed_at: 1, niche: "Cars", campaign_id: "cmp-9", notes: "refused at adsquad" });
    await keys.releaseSnapKey("d5");
    assert.deepEqual(stub.calls.filter((c) => c.method === "DELETE").map((c) => c.url), ["https://strapi.test/api/app-caches/d5"]);
    assert.equal(await keys.releaseSnapKeyByKey("glo-snp_005"), true);
  } finally {
    stub.restore();
  }
  const missing = stubFetch(() => json({ data: [] }));
  try {
    assert.equal(await keys.releaseSnapKeyByKey("glo-snp_077"), false);
  } finally {
    missing.restore();
  }
});
