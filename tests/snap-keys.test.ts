// Node's built-in runner (v24 strips types natively): `node --test tests/snap-keys.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// Snapchat rail — the key registry over Strapi `app-cache` rows (ckey "snap-key:<key>", unique →
// an atomic claim): free/next computation, the claim walk (unique-400 → next candidate, lost
// concurrent race → delete ours and walk on, pool exhausted → throw), backfill and release — and
// the rule that a registry failure is never swallowed (release / find / backfill throw).
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
  assert.equal(keys.SNAP_KEY_POOL_SIZE, 500); // 500 since 23.09 (100 before)
  assert.equal(keys.snapFreeKeys([]).length, keys.SNAP_KEY_POOL_SIZE, "the reported pool size is the size the arithmetic walks");
  const used = ["glo-snp_001", "glo-snp_003"];
  const free = keys.snapFreeKeys(used);
  assert.equal(free.length, 498);
  assert.equal(free.at(-1), "glo-snp_500");
  assert.equal(free[0], "glo-snp_002");
  assert.equal(keys.snapNextKey(used), "glo-snp_002");
  assert.equal(keys.snapNextKey(used, "glo-snp_003"), "glo-snp_004");
  assert.equal(keys.snapNextKey(used, "glo-snp_050"), "glo-snp_050");
  assert.equal(keys.snapNextKey(used, "glo-snp_100"), "glo-snp_100");
  assert.equal(keys.snapNextKey(used, "glo-snp_500"), "glo-snp_500");
  assert.equal(keys.snapNextKey(used, "glo-snp_501"), "glo-snp_002", "outside the pool = no desired key → the first free one");
  assert.equal(keys.snapNextKey(keys.snapFreeKeys([]), "glo-snp_100"), null);
  assert.deepEqual(keys.snapKeyCandidates(["glo-snp_099"], "glo-snp_099").slice(0, 2), ["glo-snp_100", "glo-snp_101"]);
  assert.deepEqual(keys.snapKeyCandidates(["glo-snp_499"], "glo-snp_499").slice(0, 2), ["glo-snp_500", "glo-snp_001"]);
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
  // A failed loser-delete must not abort the walk: the next candidate is still claimed.
  const stuck = stubFetch((r) => {
    if (r.method === "GET" && /startsWith/.test(r.url)) return json({ data: [] });
    if (r.method === "POST") {
      const ckey = String((r.body?.data as Record<string, unknown>)?.ckey);
      return json({ data: { documentId: ckey.endsWith("001") ? "mine-1" : "mine-2" } });
    }
    if (r.method === "GET" && /glo-snp_001/.test(r.url)) return json({ data: [{ documentId: "theirs-1" }, { documentId: "mine-1" }] });
    if (r.method === "GET" && /glo-snp_002/.test(r.url)) return json({ data: [{ documentId: "mine-2" }] });
    if (r.method === "DELETE") return json({ error: "boom" }, 500);
    return json({}, 404);
  });
  try {
    assert.deepEqual(await keys.claimSnapKey(undefined, { user: "nazar" }), { key: "glo-snp_002", documentId: "mine-2" });
    assert.equal(stuck.calls.filter((c) => c.method === "DELETE").length, 1, "the loser-delete was attempted exactly once");
  } finally {
    stuck.restore();
  }
});

test("claim: every key used → pool exhausted without a single POST; a non-400 POST failure aborts", async () => {
  // all 500 keys taken, served the way Strapi pages them (100 per page — the walk must read every page)
  const all = Array.from({ length: keys.SNAP_KEY_POOL_SIZE }, (_, i) => row(`glo-snp_${String(i + 1).padStart(3, "0")}`, `d${i + 1}`));
  const pageOf = (url: string) => Number(/pagination\[page\]=(\d+)/.exec(url)?.[1] ?? 1);
  const full = stubFetch((r) => (r.method === "GET" ? json({ data: all.slice((pageOf(r.url) - 1) * 100, pageOf(r.url) * 100) }) : json({}, 500)));
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

test("registry failures are never swallowed: release / find / backfill throw with the Strapi status", async () => {
  // DELETE refused → releaseSnapKey throws, and releaseSnapKeyByKey never answers `true` for it.
  const forbidden = stubFetch((r) => (r.method === "DELETE" ? json({ error: "forbidden" }, 403) : json({ data: [row("glo-snp_005", "d5")] })));
  try {
    await assert.rejects(keys.releaseSnapKey("d5"), /release failed \(403\)/);
    await assert.rejects(keys.releaseSnapKeyByKey("glo-snp_005"), /release failed \(403\)/);
  } finally {
    forbidden.restore();
  }
  // A failed find is an error, not "no row": release-by-key and backfill propagate it (route → 502).
  const findDown = stubFetch(() => json({}, 503));
  try {
    await assert.rejects(keys.findSnapKey("glo-snp_005"), /strapi 503/);
    await assert.rejects(keys.releaseSnapKeyByKey("glo-snp_005"), /strapi 503/);
    await assert.rejects(keys.backfillSnapKey("glo-snp_005", { notes: "x" }), /strapi 503/);
  } finally {
    findDown.restore();
  }
  // PUT refused → backfill throws with the status.
  const putDown = stubFetch((r) => (r.method === "PUT" ? json({ error: "boom" }, 500) : json({ data: [row("glo-snp_005", "d5")] })));
  try {
    await assert.rejects(keys.backfillSnapKey("glo-snp_005", { status: "retired" }), /backfill failed \(500\)/);
  } finally {
    putDown.restore();
  }
  // No row to merge into → the campaign would run on a key the registry thinks is free: an error, no PUT.
  const noRow = stubFetch(() => json({ data: [] }));
  try {
    await assert.rejects(keys.backfillSnapKey("glo-snp_005", { status: "retired" }), /backfill failed: no registry row for glo-snp_005/);
    assert.equal(noRow.calls.filter((c) => c.method === "PUT").length, 0);
  } finally {
    noRow.restore();
  }
  // A network error propagates as-is (nothing is caught and hidden).
  const offline = stubFetch(() => {
    throw new TypeError("fetch failed");
  });
  try {
    await assert.rejects(keys.releaseSnapKey("d5"), /fetch failed/);
  } finally {
    offline.restore();
  }
});
