// Node's built-in runner (v24 strips types natively): `node --test tests/snap-api.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// Snapchat rail — the client's PURE parts: Snap's error sentence, the batch envelope, the
// refresh-token grant + its cache, exactly-once writes, and the batch-create parsing — all with a
// stubbed globalThis.fetch (the real partner is never touched by a unit test).
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SNAP_CLIENT_ID = "cid";
process.env.SNAP_CLIENT_SECRET = "csec";
process.env.SNAP_REFRESH_TOKEN = "rt-1";
process.env.SNAP_API_BASE = "https://ads.test/v1";
process.env.SNAP_AUTH_BASE = "https://auth.test";
process.env.SNAP_BUSINESS_API_BASE = "https://biz.test/v1";
process.env.NEXT_PUBLIC_SNAP_ENABLED = "1";

const api = await import("../lib/snap-api.ts");

type Rec = { url: string; method: string; headers: Record<string, string>; body: string | null };
function stubFetch(routes: Array<[RegExp, (r: Rec) => Response | Promise<Response>]>) {
  const calls: Rec[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body = typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : init?.body ? "<binary>" : null;
    const rec = { url, method: init?.method ?? "GET", headers, body };
    calls.push(rec);
    for (const [re, h] of routes) if (re.test(url)) return h(rec);
    return new Response(JSON.stringify({ request_status: "ERROR", debug_message: `no stub for ${url}` }), { status: 404 });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}
const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const tokenRoute: [RegExp, (r: Rec) => Response] = [/auth\.test\/login\/oauth2\/access_token/, () => json({ access_token: "at-1", expires_in: 3600, token_type: "Bearer" })];

test("snapErrorMessage prefers display_message, then debug_message, then a status fallback", () => {
  assert.equal(api.snapErrorMessage(400, { request_status: "ERROR", display_message: "Budget too low", debug_message: "daily_budget_micro < 5000000" }), "Budget too low (daily_budget_micro < 5000000)");
  assert.equal(api.snapErrorMessage(400, { debug_message: "x" }), "x");
  assert.equal(api.snapErrorMessage(401, "Unauthorized"), "Unauthorized");
  assert.equal(api.snapErrorMessage(503, null), "Snapchat HTTP 503");
  assert.equal(api.snapErrorMessage(undefined, null), "Snapchat unreachable");
});

test("snapBatchItem unwraps {campaigns:[{sub_request_status, campaign}]} and throws on item errors", () => {
  assert.deepEqual(api.snapBatchItem({ request_status: "SUCCESS", campaigns: [{ sub_request_status: "SUCCESS", campaign: { id: "c1" } }] }, "campaigns"), { id: "c1" });
  assert.throws(() => api.snapBatchItem({ request_status: "SUCCESS", campaigns: [{ sub_request_status: "ERROR", debug_message: "name too long" }] }, "campaigns"), (e: Error) => /name too long/.test(e.message) && (e as api.SnapApiError).status === 400);
  assert.throws(() => api.snapBatchItem({ request_status: "ERROR", display_message: "nope" }, "campaigns"), /nope/);
  assert.throws(() => api.snapBatchItem({ request_status: "SUCCESS", campaigns: [] }, "campaigns"), /empty/);
});

test("refresh grant is a form POST, cached until expiry; rejected → 401, an OAuth outage → its own status, unreachable → 502", async () => {
  api._resetSnapTokenCache();
  const stub = stubFetch([tokenRoute]);
  try {
    assert.equal(await api.snapAccessToken(), "at-1");
    assert.equal(await api.snapAccessToken(), "at-1");
    assert.equal(stub.calls.length, 1, "second call served from the cache");
    const c = stub.calls[0];
    assert.equal(c.method, "POST");
    assert.match(c.body ?? "", /grant_type=refresh_token/);
    assert.match(c.body ?? "", /client_id=cid/);
    assert.match(c.body ?? "", /refresh_token=rt-1/);
  } finally {
    stub.restore();
  }
  // A rejected refresh (400/401 or an OAuth error of invalid_grant/invalid_client) = re-consent needed.
  api._resetSnapTokenCache();
  const bad = stubFetch([[/access_token/, () => json({ error: "invalid_grant", error_description: "Refresh token is invalid" }, 400)]]);
  try {
    await assert.rejects(api.snapAccessToken(), (e: api.SnapApiError) => e.status === 401 && /refresh token rejected \(invalid_grant: Refresh token is invalid\)/.test(e.message));
  } finally {
    bad.restore();
  }
  // An accounts.snapchat.com outage is NOT a rejected token: the status is Snap's own, never 401.
  api._resetSnapTokenCache();
  const outage = stubFetch([[/access_token/, () => json({ error: "server_error" }, 503)]]);
  try {
    await assert.rejects(api.snapAccessToken(), (e: api.SnapApiError) => e.status === 503 && /OAuth HTTP 503/.test(e.message) && !/refresh token rejected/.test(e.message));
  } finally {
    outage.restore();
  }
  // A thrown fetch (DNS / timeout) becomes a SnapApiError 502, never a raw TypeError.
  api._resetSnapTokenCache();
  const down = stubFetch([
    [
      /access_token/,
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ]);
  try {
    await assert.rejects(api.snapAccessToken(), (e: api.SnapApiError) => e instanceof api.SnapApiError && e.status === 502 && /OAuth unreachable: fetch failed/.test(e.message));
  } finally {
    down.restore();
  }
});

test("ad accounts come from /me/organizations?with_ad_accounts=true, flattened and sorted", async () => {
  api._resetSnapTokenCache();
  const stub = stubFetch([
    tokenRoute,
    [
      /ads\.test\/v1\/me\/organizations\?with_ad_accounts=true/,
      () =>
        json({
          request_status: "SUCCESS",
          organizations: [
            {
              sub_request_status: "SUCCESS",
              organization: {
                id: "org-1",
                name: "GlobeCoders",
                ad_accounts: [
                  { id: "acct-b", name: "Snap USD 2", currency: "USD", timezone: "UTC", status: "ACTIVE" },
                  { id: "acct-a", name: "Snap USD 1", currency: "usd", timezone: "America/Sao_Paulo", status: "ACTIVE" },
                ],
              },
            },
          ],
        }),
    ],
  ]);
  try {
    const accounts = await api.snapAdAccounts();
    assert.deepEqual(accounts, [
      { id: "acct-a", name: "Snap USD 1", currency: "USD", timezone: "America/Sao_Paulo", status: "ACTIVE", organizationId: "org-1" },
      { id: "acct-b", name: "Snap USD 2", currency: "USD", timezone: "UTC", status: "ACTIVE", organizationId: "org-1" },
    ]);
    assert.equal(stub.calls.find((c) => /organizations/.test(c.url))?.headers.authorization, "Bearer at-1");
  } finally {
    stub.restore();
  }
});

test("creates are ONE attempt: a 500 is thrown as-is (never retried), a 4xx carries Snap's sentence", async () => {
  api._resetSnapTokenCache();
  let hits = 0;
  const stub = stubFetch([
    tokenRoute,
    [
      /adaccounts\/acct-a\/campaigns/,
      () => {
        hits += 1;
        return json({ request_status: "ERROR", debug_message: "internal" }, 500);
      },
    ],
  ]);
  try {
    await assert.rejects(
      api.snapCreateCampaign("acct-a", { name: "n", ad_account_id: "acct-a", status: "PAUSED", start_time: "2026-09-16T00:00:00.000Z" }),
      (e: api.SnapApiError) => e.status === 500,
    );
    assert.equal(hits, 1, "no retry on a create");
  } finally {
    stub.restore();
  }
  const refuse = stubFetch([tokenRoute, [/adaccounts\/acct-a\/campaigns/, () => json({ request_status: "ERROR", display_message: "Name too long" }, 400)]]);
  try {
    await assert.rejects(
      api.snapCreateCampaign("acct-a", { name: "n", ad_account_id: "acct-a", status: "PAUSED", start_time: "2026-09-16T00:00:00.000Z" }),
      (e: api.SnapApiError) => e.status === 400 && /Name too long/.test(e.message),
    );
  } finally {
    refuse.restore();
  }
});

test("a successful create returns the new id from the batch envelope; the body rides as {campaigns:[…]}", async () => {
  api._resetSnapTokenCache();
  const stub = stubFetch([
    tokenRoute,
    [/adaccounts\/acct-a\/campaigns/, (r) => json({ request_status: "SUCCESS", campaigns: [{ sub_request_status: "SUCCESS", campaign: { ...JSON.parse(r.body ?? "{}").campaigns[0], id: "cmp-1" } }] })],
  ]);
  try {
    const r = await api.snapCreateCampaign("acct-a", { name: "n", ad_account_id: "acct-a", status: "PAUSED", start_time: "2026-09-16T00:00:00.000Z" });
    assert.deepEqual(r, { id: "cmp-1" });
    const call = stub.calls.find((c) => /campaigns/.test(c.url))!;
    assert.deepEqual(JSON.parse(call.body ?? "{}"), { campaigns: [{ name: "n", ad_account_id: "acct-a", status: "PAUSED", start_time: "2026-09-16T00:00:00.000Z" }] });
    assert.equal(call.headers["content-type"], "application/json");
  } finally {
    stub.restore();
  }
});

test("status flip: GET the campaign, PUT the whitelisted object with the new status", async () => {
  api._resetSnapTokenCache();
  const stub = stubFetch([
    tokenRoute,
    [/\/v1\/campaigns\/cmp-1$/, () => json({ request_status: "SUCCESS", campaigns: [{ sub_request_status: "SUCCESS", campaign: { id: "cmp-1", name: "n", ad_account_id: "acct-a", status: "PAUSED", start_time: "2026-09-16T00:00:00.000Z", buy_model: "AUCTION", created_at: "x", updated_at: "y", delivery_status: ["z"] } }] })],
    [/adaccounts\/acct-a\/campaigns$/, (r) => json({ request_status: "SUCCESS", campaigns: [{ sub_request_status: "SUCCESS", campaign: JSON.parse(r.body ?? "{}").campaigns[0] }] })],
  ]);
  try {
    await api.snapSetCampaignStatus("cmp-1", "ACTIVE");
    const put = stub.calls.find((c) => c.method === "PUT")!;
    assert.deepEqual(JSON.parse(put.body ?? "{}"), { campaigns: [{ id: "cmp-1", name: "n", ad_account_id: "acct-a", status: "ACTIVE", start_time: "2026-09-16T00:00:00.000Z", buy_model: "AUCTION" }] });
  } finally {
    stub.restore();
  }
});

test("snapFetchBytes refuses a file over the cap by content-length before downloading it", async () => {
  const stub = stubFetch([[/blob\.test/, () => new Response(new Uint8Array(10), { status: 200, headers: { "content-length": String(40 * 1024 * 1024), "content-type": "video/mp4" } })]]);
  try {
    await assert.rejects(api.snapFetchBytes("https://blob.test/v.mp4", 32 * 1024 * 1024), /32 MB/);
  } finally {
    stub.restore();
  }
  const ok = stubFetch([[/blob\.test/, () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "video/mp4" } })]]);
  try {
    const f = await api.snapFetchBytes("https://blob.test/v.mp4", 32 * 1024 * 1024);
    assert.equal(f.size, 3);
    assert.equal(f.mime, "video/mp4");
  } finally {
    ok.restore();
  }
});
