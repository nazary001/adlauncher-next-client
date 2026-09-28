// Node's built-in runner (v24 strips types natively): `node --test tests/av-keys.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// AV rail — the key registry over Strapi `app-cache` rows (ckey "av-key:<key>", unique → atomic
// claim): the REGISTERED range is the only launchable pool (0 = the stub: nothing claimable, no
// Strapi call at all), the claim walk (unique-400 → next, lost race → delete ours and walk on,
// exhausted → throw), backfill and release — a registry failure is never swallowed.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.STRAPI_API_URL = "https://strapi.test";
process.env.STRAPI_TOKEN = "tok";
const keys = await import("../lib/av-keys.ts");

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
  ckey: `av-key:${key}`,
  cvalue: { key, status: "active", user: "nazar", claimed_at: 1, ...extra },
  refreshed_at: 1,
  createdAt: "2026-09-28T00:00:00.000Z",
});

test("free / next walk ONLY the registered range, desired-or-next with wrap-around", () => {
  assert.deepEqual(keys.avFreeKeys([], 0), [], "registered 0 = the stub: nothing is free");
  assert.equal(keys.avNextKey([], 0), null);
  const used = ["av001", "av003"];
  const free = keys.avFreeKeys(used, 200);
  assert.equal(free.length, 198);
  assert.equal(free[0], "av002");
  assert.equal(free.at(-1), "av200");
  assert.equal(keys.avNextKey(used, 200), "av002");
  assert.equal(keys.avNextKey(used, 200, "av003"), "av004");
  assert.equal(keys.avNextKey(used, 200, "av150"), "av150");
  assert.equal(keys.avNextKey(used, 200, "av201"), "av002", "an unregistered desired key is ignored");
  assert.deepEqual(keys.avKeyCandidates(["av199"], 200, "av199").slice(0, 2), ["av200", "av001"]);
  assert.equal(keys.avFreeKeys([], 5000).length, 999, "the registered count is clamped to the codec range");
});

test("claim with nothing registered refuses BEFORE touching Strapi", async () => {
  const stub = stubFetch(() => json({}, 500));
  try {
    await assert.rejects(keys.claimAvKey(undefined, 0, { user: "nazar" }), /av_keys_not_registered/);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test("claim walks past a unique-400 and returns the next registered key", async () => {
  const stub = stubFetch((r) => {
    if (r.method === "GET" && /\$startsWith\]=av-key%3A/.test(r.url)) return json({ data: [row("av001", "d1")] });
    if (r.method === "POST") {
      const ckey = (r.body?.data as { ckey: string }).ckey;
      if (ckey === "av-key:av002") return json({ error: { message: "This attribute must be unique" } }, 400);
      return json({ data: { documentId: "dNEW" } });
    }
    if (r.method === "GET" && /filters\[ckey\]\[\$eq\]=av-key%3Aav003/.test(r.url)) return json({ data: [{ documentId: "dNEW" }] });
    return json({}, 500);
  });
  try {
    const got = await keys.claimAvKey(undefined, 200, { user: "nazar", via: "launch", destination: "https://thecadrion.com/x" });
    assert.deepEqual(got, { key: "av003", documentId: "dNEW" });
    const posted = stub.calls.filter((c) => c.method === "POST").map((c) => (c.body?.data as { ckey: string }).ckey);
    assert.deepEqual(posted, ["av-key:av002", "av-key:av003"]);
    const bound = stub.calls.find((c) => c.method === "POST" && (c.body?.data as { ckey: string }).ckey === "av-key:av003");
    assert.equal(((bound?.body?.data as { cvalue: { via: string } }).cvalue).via, "launch");
  } finally {
    stub.restore();
  }
});

test("claim that lost a concurrent race deletes its younger twin and walks on", async () => {
  let posts = 0;
  const stub = stubFetch((r) => {
    if (r.method === "GET" && /\$startsWith\]/.test(r.url)) return json({ data: [] });
    if (r.method === "POST") {
      posts++;
      return json({ data: { documentId: posts === 1 ? "dYOUNG" : "dMINE" } });
    }
    if (r.method === "GET" && /av-key%3Aav001/.test(r.url)) return json({ data: [{ documentId: "dOLD" }, { documentId: "dYOUNG" }] });
    if (r.method === "GET" && /av-key%3Aav002/.test(r.url)) return json({ data: [{ documentId: "dMINE" }] });
    if (r.method === "DELETE") return json({ data: null });
    return json({}, 500);
  });
  try {
    const got = await keys.claimAvKey(undefined, 10, { user: "nazar" });
    assert.deepEqual(got, { key: "av002", documentId: "dMINE" });
    assert.ok(stub.calls.some((c) => c.method === "DELETE" && c.url.endsWith("/dYOUNG")));
  } finally {
    stub.restore();
  }
});

test("claim on an exhausted registered range throws by name", async () => {
  const stub = stubFetch((r) => (r.method === "GET" ? json({ data: [row("av001", "d1"), row("av002", "d2")] }) : json({}, 500)));
  try {
    await assert.rejects(keys.claimAvKey(undefined, 2, { user: "nazar" }), /av key pool exhausted — every registered key av001…av002/);
  } finally {
    stub.restore();
  }
});

test("backfill merges into the found row; release/backfill failures throw", async () => {
  const stub = stubFetch((r) => {
    if (r.method === "GET" && /av-key%3Aav005/.test(r.url)) return json({ data: [row("av005", "d5", { name: "n" })] });
    if (r.method === "GET" && /av-key%3Aav006/.test(r.url)) return json({ data: [] });
    if (r.method === "PUT") return json({ data: {} });
    if (r.method === "DELETE") return json({}, 500);
    return json({}, 500);
  });
  try {
    await keys.backfillAvKey("av005", { campaign_id: "c1", status: "retired" });
    const put = stub.calls.find((c) => c.method === "PUT");
    assert.ok(put?.url.endsWith("/app-caches/d5"));
    const cv = (put?.body?.data as { cvalue: Record<string, unknown>; ckey?: string });
    assert.equal(cv.ckey, undefined, "PUT never re-sends the unique ckey");
    assert.deepEqual([cv.cvalue.key, cv.cvalue.campaign_id, cv.cvalue.status, cv.cvalue.name], ["av005", "c1", "retired", "n"]);
    await assert.rejects(keys.backfillAvKey("av006", { campaign_id: "x" }), /no registry row for av006/);
    await assert.rejects(keys.releaseAvKey("d5"), /av key release failed \(500\)/);
    assert.equal(await keys.releaseAvKeyByKey("av006"), false);
  } finally {
    stub.restore();
  }
});
