// Node's built-in runner (v24 strips types natively): `node --test tests/av-api.test.ts`.
// AV external API client: envelope unwrap ({response} vs the redirect routes' own keys), bearer
// header, 429 Retry-After + 5xx retries for idempotent calls only (a POST is never replayed after the
// server may have acted), stable error codes, defensive redirect-path parsing, mapping-sum guard.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.AV_API_KEY = "k".repeat(64) + ":" + "s".repeat(20);
process.env.AV_API_BASE = "https://av.test";
const api = await import("../lib/av-api.ts");

type Rec = { url: string; method: string; auth: string; body: unknown };
function stubFetch(handler: (r: Rec, n: number) => Response) {
  const calls: Rec[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const h = (init?.headers ?? {}) as Record<string, string>;
    const rec = { url: String(input), method: init?.method ?? "GET", auth: h.Authorization ?? "", body: typeof init?.body === "string" ? JSON.parse(init.body) : null };
    calls.push(rec);
    return handler(rec, calls.length);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}
const json = (o: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...headers } });

test("/me unwraps the envelope and maps the live 28.09 shape", async () => {
  const stub = stubFetch(() =>
    json({ response: { publisher_id: "f845", sites: [{ delegation_type: "MANAGE_PARTNER", domain: "TheCadrion.com", network_code: "2550370616", parent_network_code: "198073784", site_name: "thecadrion.com" }] } }),
  );
  try {
    const me = await api.avMe();
    assert.equal(me.publisherId, "f845");
    assert.deepEqual(me.sites, [{ domain: "thecadrion.com", siteName: "thecadrion.com", networkCode: "2550370616", parentNetworkCode: "198073784", delegationType: "MANAGE_PARTNER" }]);
    assert.equal(stub.calls[0].url, "https://av.test/me");
    assert.match(stub.calls[0].auth, /^Bearer k{64}:s{20}$/);
  } finally {
    stub.restore();
  }
});

test("/v1/redirects reads its own top-level key (no envelope)", async () => {
  const stub = stubFetch(() =>
    json({ redirectDomains: [{ createdAt: "2026-09-23T14:36:23.245Z", id: "cmue7", name: "redirect.thecadrion.com", redirectPaths: [{ id: "p1", path: "jobs" }] }] }),
  );
  try {
    assert.deepEqual(await api.avRedirects(), [{ id: "cmue7", name: "redirect.thecadrion.com", createdAt: "2026-09-23T14:36:23.245Z", paths: [{ id: "p1", path: "/jobs" }] }]);
  } finally {
    stub.restore();
  }
});

test("429 waits Retry-After then succeeds; 5xx retried on GET", async () => {
  const stub = stubFetch((_r, n) => (n === 1 ? json({ message: "slow down" }, 429, { "retry-after": "0" }) : n === 2 ? json({}, 503) : json({ response: { publisher_id: "x", sites: [] } })));
  try {
    const me = await api.avMe();
    assert.equal(me.publisherId, "x");
    assert.equal(stub.calls.length, 3);
  } finally {
    stub.restore();
  }
});

test("a POST is NOT replayed on 5xx (the path may exist) — only on 429", async () => {
  const stub = stubFetch(() => json({ message: "boom" }, 500));
  try {
    await assert.rejects(api.avCreateRedirectPath("cmue7", { path: "jobs" }), (e: unknown) => (e as { code?: string }).code === "av_upstream");
    assert.equal(stub.calls.length, 1);
    assert.deepEqual(stub.calls[0].body, { path: "/jobs" });
  } finally {
    stub.restore();
  }
});

test("errors map to stable codes; unconfigured key refuses without a call", async () => {
  const stub = stubFetch((r) => (r.url.endsWith("/me") ? json({ error: "Unauthorized" }, 401) : json({ message: "Path already exists" }, 400)));
  try {
    await assert.rejects(api.avMe(), (e: unknown) => (e as { code?: string }).code === "av_key_rejected");
    await assert.rejects(api.avCreateRedirectPath("d", { path: "/x", fallback: "https://thecadrion.com/a" }), /Path already exists/);
  } finally {
    stub.restore();
  }
  const saved = process.env.AV_API_KEY;
  process.env.AV_API_KEY = "";
  try {
    await assert.rejects(api.avMe(), (e: unknown) => (e as { code?: string }).code === "av_not_configured");
  } finally {
    process.env.AV_API_KEY = saved;
  }
});

test("a target weight is read as a number whatever it is written as — one that cannot be read stays unknown, never 0", async () => {
  const stub = stubFetch(() =>
    json({ response: [{ url: "https://a", percentage: "40" }, { url: "https://b", percentage: "40%" }, { url: "https://c", percentage: 20 }, { url: "https://d", percentage: null }, { url: "https://e", percentage: "abc" }] }),
  );
  try {
    const got = await api.avRedirectMappings("p9");
    assert.deepEqual(got.map((m) => m.percentage), [40, 40, 20, NaN, NaN]);
  } finally {
    stub.restore();
  }
});

test("path bodies are read defensively (create's {redirectDomains:{…}}, detail, mappings shapes)", async () => {
  const stub = stubFetch((r) => {
    if (r.method === "POST") return json({ redirectDomains: { id: "p9", path: "/jobs", fallbackUrl: "https://thecadrion.com/a", redirectType: "FIXED", redirectMappings: [] } });
    if (r.url.endsWith("/mappings") && r.method === "GET") return json({ response: [{ id: "m1", percentage: 100, url: "https://thecadrion.com/a" }] });
    if (r.method === "PUT") return json([{ url: "https://thecadrion.com/a", percentage: 100 }]);
    return json({ id: "p9", path: "jobs", fallbackUrl: "", redirectType: "FIXED", redirectMappings: [{ percentage: 60, url: "https://a" }, { percentage: 40, url: "https://b" }] });
  });
  try {
    const created = await api.avCreateRedirectPath("cmue7", { path: "/jobs", fallback: "https://thecadrion.com/a" });
    assert.deepEqual(created, { id: "p9", path: "/jobs", fallbackUrl: "https://thecadrion.com/a", redirectType: "FIXED", mappings: [] });
    const detail = await api.avRedirectPath("p9");
    assert.deepEqual(detail.mappings, [{ url: "https://a", percentage: 60 }, { url: "https://b", percentage: 40 }]);
    assert.deepEqual(await api.avRedirectMappings("p9"), [{ url: "https://thecadrion.com/a", percentage: 100 }]);
    assert.deepEqual(await api.avPutMappings("p9", [{ url: "https://thecadrion.com/a", percentage: 100 }]), [{ url: "https://thecadrion.com/a", percentage: 100 }]);
    await assert.rejects(api.avPutMappings("p9", [{ url: "https://a", percentage: 50 }]), /must sum to 100/);
  } finally {
    stub.restore();
  }
});
