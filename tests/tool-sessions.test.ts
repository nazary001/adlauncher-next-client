// Node's built-in runner (v24 strips types natively): `node --test tests/tool-sessions.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// TOOL Sessions client — with a stubbed globalThis.fetch: the bearer header, query building,
// TOOL's error body → our ToolFailure (401 = key rejected, 403 = scope, 422 with field/problems),
// unreachable → 502, non-JSON 2xx → 502, the `me` cache, and that no request ever echoes a secret.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TOOL_SESSIONS_API_KEY = "hst_testkey_0000000000";
process.env.TOOL_SESSIONS_BASE = "https://tool.test/";

const api = await import("../lib/tool-sessions.ts");

type Rec = { url: string; method: string; headers: Record<string, string>; body: string | null };
function stubFetch(routes: Array<[RegExp, (r: Rec) => Response | Promise<Response>]>) {
  const calls: Rec[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const rec = { url, method: init?.method ?? "GET", headers, body: typeof init?.body === "string" ? init.body : null };
    calls.push(rec);
    for (const [re, h] of routes) if (re.test(url)) return h(rec);
    return new Response(JSON.stringify({ error: "not_found", message: `no stub for ${url}` }), { status: 404 });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}
const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

test("toolConfigured / toolHost read the env; the host loses its trailing slash", () => {
  assert.equal(api.toolConfigured(), true);
  assert.equal(api.toolHost(), "https://tool.test");
});

test("toolFetch: bearer + Accept headers, JSON body only when given, query params dropped when empty", async () => {
  const stub = stubFetch([[/\/api\/v1\/sessions/, () => json([{ id: 1, name: "glo-01", accounts: [] }])]]);
  try {
    const r = await api.listSessions("");
    assert.ok(r.ok && Array.isArray(r.data) && r.data.length === 1 && (r.data[0] as { name: string }).name === "glo-01");
    const c = stub.calls[0];
    assert.equal(c.url, "https://tool.test/api/v1/sessions", "empty status is not sent");
    assert.equal(c.method, "GET");
    assert.equal(c.headers.authorization, "Bearer hst_testkey_0000000000");
    assert.equal(c.headers.accept, "application/json");
    assert.equal(c.headers["content-type"], undefined, "no body → no content-type");
    assert.equal(c.body, null);
    await api.listSessions("disabled");
    assert.equal(stub.calls[1].url, "https://tool.test/api/v1/sessions?status=disabled");
  } finally {
    stub.restore();
  }
});

test("createSession posts the exact body as JSON and maps the 201 answer", async () => {
  const stub = stubFetch([[/\/sessions$/, (r) => json({ id: 9, ...JSON.parse(r.body ?? "{}"), status: "active", accounts: [] }, 201)]]);
  try {
    const r = await api.createSession({ name: "n1", kind: "adsmanager_session", token: "EAAB" + "x".repeat(30), cookies: "c_user=1; xs=2", user_agent: "Mozilla/5.0 test", check_now: true, source: "api" });
    assert.ok(r.ok && r.status === 201 && (r.data as { id: number; name: string }).id === 9 && (r.data as { name: string }).name === "n1");
    const c = stub.calls[0];
    assert.equal(c.method, "POST");
    assert.equal(c.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(c.body ?? ""), { name: "n1", kind: "adsmanager_session", token: "EAAB" + "x".repeat(30), cookies: "c_user=1; xs=2", user_agent: "Mozilla/5.0 test", check_now: true, source: "api" });
  } finally {
    stub.restore();
  }
});

test("TOOL error bodies → ToolFailure: 422 keeps field + problems, 401 = key rejected, 403 = scope, 404, plain text, 5xx", async () => {
  const stub = stubFetch([
    [/sessions\/422/, () => json({ error: "validation_failed", message: "String should have at least 2 characters; Field required", field: "name", problems: [{ error: "string_too_short", field: "name" }] }, 422)],
    [/sessions\/401/, () => json({ error: "http_error", message: "Unauthorized" }, 401)],
    [/sessions\/403/, () => new Response("forbidden", { status: 403 })],
    [/sessions\/404/, () => json({ error: "not_found", message: "сессия не найдена" }, 404)],
    [/sessions\/500/, () => new Response("<html>boom</html>", { status: 500 })],
    [/sessions\/502/, () => new Response("", { status: 502 })],
    [/sessions\/200text/, () => new Response("not json at all", { status: 200 })],
  ]);
  try {
    const v = await api.getSession(422);
    assert.ok(!v.ok && v.status === 422 && v.error === "validation_failed" && v.field === "name" && Array.isArray(v.problems) && /at least 2/.test(v.message));
    const u = await api.getSession(401);
    assert.ok(!u.ok && u.status === 401 && u.error === "key_rejected" && /tool.gctracking.xyz\/keys/.test(u.message));
    const f = await api.getSession(403);
    assert.ok(!f.ok && f.status === 403 && f.error === "scope_missing");
    const n = await api.getSession(404);
    assert.ok(!n.ok && n.status === 404 && n.error === "not_found" && n.message === "сессия не найдена");
    const s = await api.getSession(500);
    assert.ok(!s.ok && s.status === 500 && s.error === "http_500" && /boom/.test(s.message));
    const g = await api.getSession(502);
    assert.ok(!g.ok && g.status === 502 && /HTTP 502/.test(g.message));
    const t = await api.toolFetch("GET", "/sessions/200text");
    assert.ok(!t.ok && t.status === 502 && t.error === "bad_answer");
  } finally {
    stub.restore();
  }
});

test("unreachable / timeout → 502 tool_unreachable with the cause; never throws", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: new Error("ECONNREFUSED 127.0.0.1:3199") });
  }) as typeof fetch;
  try {
    const r = await api.listSessions();
    assert.ok(!r.ok && r.status === 502 && r.error === "tool_unreachable" && /ECONNREFUSED/.test(r.message));
  } finally {
    globalThis.fetch = real;
  }
});

test("missing key → not_configured without any network call", async () => {
  const saved = process.env.TOOL_SESSIONS_API_KEY;
  process.env.TOOL_SESSIONS_API_KEY = "";
  const stub = stubFetch([]);
  try {
    assert.equal(api.toolConfigured(), false);
    const r = await api.listSessions();
    assert.ok(!r.ok && r.error === "not_configured");
    assert.equal(stub.calls.length, 0);
  } finally {
    process.env.TOOL_SESSIONS_API_KEY = saved;
    stub.restore();
  }
});

test("toolMe is cached per instance (5 min) and forced by request", async () => {
  api._resetToolCaches();
  let n = 0;
  const stub = stubFetch([[/\/me$/, () => json({ actor: `key:hst_${++n}`, team_id: 1, teams: [1], is_hs_admin: false, scopes: ["sessions:read"] })]]);
  try {
    const a = await api.toolMe();
    const b = await api.toolMe();
    assert.ok(a.ok && b.ok && a.data.actor === "key:hst_1" && b.data.actor === "key:hst_1");
    assert.equal(stub.calls.length, 1);
    const c = await api.toolMe(true);
    assert.ok(c.ok && c.data.actor === "key:hst_2");
    assert.equal(stub.calls.length, 2);
  } finally {
    stub.restore();
    api._resetToolCaches();
  }
});

test("jobs: list keeps rows + total (or counts rows), filters ride the query; events / retry / cancel paths", async () => {
  const stub = stubFetch([
    [/\/jobs\/7\/events$/, () => json([{ id: 1, ts: "2026-09-25T11:38:03Z", step: "queued", level: "info", message: "publish" }])],
    [/\/jobs\/7\/retry$/, () => json({ id: 7, status: "queued", stage: "NEW", kind: "session.check" })],
    [/\/jobs\/7\/cancel$/, () => json({ ok: true })],
    [/\/jobs\/7$/, () => json({ id: 7, status: "error", stage: "FAILED", kind: "session.check", error: "boom" })],
    [/\/jobs\?/, (r) => json(r.url.includes("total") ? { rows: [{ id: 1 }], total: 40 } : { rows: [{ id: 1 }, { id: 2 }] })],
  ]);
  try {
    const l = await api.listJobs({ session_id: 1, kind: "session.check", status: "error", limit: 10, offset: 20 });
    assert.ok(l.ok && l.data.rows.length === 2 && l.data.total === 2);
    assert.equal(stub.calls[0].url, "https://tool.test/api/v1/jobs?session_id=1&kind=session.check&status=error&limit=10&offset=20");
    const j = await api.getJob(7);
    assert.ok(j.ok && j.data.status === "error");
    const e = await api.jobEvents(7);
    assert.ok(e.ok && (e.data[0] as { step: string }).step === "queued");
    const rt = await api.retryJob(7);
    assert.ok(rt.ok && rt.data.status === "queued" && stub.calls.at(-1)?.method === "POST");
    const cn = await api.cancelJob(7);
    assert.ok(cn.ok && cn.data?.ok === true);
  } finally {
    stub.restore();
  }
});

test("sessionAccounts / teamAccounts hand back {accounts} raw; checkSession posts; delete answers {ok}", async () => {
  const stub = stubFetch([
    [/\/sessions\/1\/accounts$/, () => json({ accounts: [{ account_id: "act_1", name: "A", currency: "USD", status: 1 }] })],
    [/\/sessions\/1\/check$/, () => json({ id: 3, status: "queued", stage: "NEW", kind: "session.check", session_id: 1 })],
    [/\/accounts$/, () => json({ accounts: [{ account_id: "1", name: "A", currency: "USD", status: 1, sessions: [{ id: 1, name: "glo-01" }] }], scope: [] })],
    [/\/sessions\/1$/, () => json({ ok: true })],
  ]);
  try {
    const a = await api.sessionAccounts(1);
    assert.ok(a.ok && (a.data.accounts?.[0] as { account_id: string }).account_id === "act_1", "raw — the route strips act_ via toAccount");
    const c = await api.checkSession(1);
    assert.ok(c.ok && c.data.kind === "session.check");
    assert.equal(stub.calls.find((x) => x.url.endsWith("/check"))?.method, "POST");
    const t = await api.teamAccounts();
    assert.ok(t.ok && (t.data.accounts?.[0] as { sessions: { name: string }[] }).sessions[0].name === "glo-01");
    const d = await api.deleteSession(1);
    assert.ok(d.ok && d.data?.ok === true && stub.calls.at(-1)?.method === "DELETE");
  } finally {
    stub.restore();
  }
});

test("toolFailure: an unknown 4xx with an empty body gets a sentence, never an empty message", () => {
  const f = api.toolFailure(418, "");
  assert.equal(f.error, "http_418");
  assert.match(f.message, /HTTP 418/);
  const g = api.toolFailure(404, null);
  assert.equal(g.message, "not found");
});
