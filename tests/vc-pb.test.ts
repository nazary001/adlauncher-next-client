// Node's built-in runner (v24 strips types natively): `node --test tests/vc-pb.test.ts`.
// DE Postback (pb.gctracking.xyz, owner 26.10): every VC launch points its ad at the tracking link the
// API makes for the landingpage — config from env, the POST it sends, the verdict it reads back
// (idempotent 201/200, refusals, a dead / slow service, a malformed answer) — on a fake fetch.
import { test } from "node:test";
import assert from "node:assert/strict";

const { VC_PB_DEFAULT_BASE, vcPbConfig, vcPbLinkName, vcPbEnsureLink } = await import("../lib/vc-pb.ts");

const LP = "https://www.qualitydays.com/coa/words-or-actions-fn3zbpziuj/";
const CFG = { base: "https://pb.example.test", token: "tok-123" };
const ID = "4ydvshmxgwg5hnd4sk4fq17r";
const TRACK = `https://trackwow3.xyz/r/${ID}?campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}&placement={{placement}}`;

type Call = { url: string; init: RequestInit };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const okBody = (created: boolean, over: Record<string, unknown> = {}) => ({
  status: "OK",
  created,
  link: { link_id: ID, tracking_url: TRACK, target_url: LP, name: "VC · words-or-actions-fn3zbpziuj", lpa_id: null, created_at: "2026-10-26T13:09:30+00:00", ...over },
});
/** A fake fetch answering each call from `answers` in turn (a function = throw / custom). */
function fake(...answers: (Response | ((call: Call) => Promise<Response>))[]) {
  const calls: Call[] = [];
  const f = async (url: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    return typeof a === "function" ? a(call) : a.clone();
  };
  return { calls, fetch: f as typeof fetch };
}
const opts = (f: typeof fetch) => ({ fetch: f, retryDelayMs: 0 });

test("vcPbConfig: no token = off; the base defaults to pb.gctracking.xyz and loses a trailing slash", () => {
  assert.equal(vcPbConfig({}), null);
  assert.equal(vcPbConfig({ VC_PB_TOKEN: "   " }), null);
  assert.deepEqual(vcPbConfig({ VC_PB_TOKEN: " t " }), { base: VC_PB_DEFAULT_BASE, token: "t" });
  assert.equal(VC_PB_DEFAULT_BASE, "https://pb.gctracking.xyz");
  assert.deepEqual(vcPbConfig({ VC_PB_TOKEN: "t", VC_PB_BASE: "http://127.0.0.1:3196/" }), { base: "http://127.0.0.1:3196", token: "t" });
});

test("vcPbLinkName: VC + the landingpage's quiz slug and id", () => {
  assert.equal(vcPbLinkName(LP), "VC · words-or-actions-fn3zbpziuj");
  assert.equal(vcPbLinkName("https://www.qualitydays.com/coa/explore-your-dating-style-j4erziw09v/?x=1"), "VC · explore-your-dating-style-j4erziw09v");
});

test("vcPbEnsureLink: POSTs {url, name} with the bearer and returns the tracking link (201 = new)", async () => {
  const f = fake(json(201, okBody(true)));
  const r = await vcPbEnsureLink(CFG, LP, "VC · words-or-actions-fn3zbpziuj", opts(f.fetch));
  assert.deepEqual(r, { ok: true, link: { linkId: ID, trackingUrl: TRACK, created: true } });
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.equal(url, "https://pb.example.test/api/v1/pb/links");
  assert.equal(init.method, "POST");
  const h = new Headers(init.headers);
  assert.equal(h.get("authorization"), "Bearer tok-123");
  assert.match(h.get("content-type") ?? "", /application\/json/);
  assert.deepEqual(JSON.parse(String(init.body)), { url: LP, name: "VC · words-or-actions-fn3zbpziuj" });
});

test("vcPbEnsureLink: 200 = the link already existed — same tracking link, created:false", async () => {
  const r = await vcPbEnsureLink(CFG, LP, "x", opts(fake(json(200, okBody(false))).fetch));
  assert.ok(r.ok);
  assert.equal(r.ok && r.link.created, false);
  assert.equal(r.ok && r.link.trackingUrl, TRACK);
});

test("vcPbEnsureLink: a refused / unauthorized call is a config verdict, never retried", async () => {
  for (const [status, re] of [
    [403, /pb_token_rejected.*invalid or disabled token/],
    [401, /pb_token_rejected/],
    [400, /pb_link_refused.*url points to a tracking domain/],
  ] as const) {
    const f = fake(json(status, { status: "error", error: status === 400 ? "url points to a tracking domain — send the DE link itself" : "invalid or disabled token" }));
    const r = await vcPbEnsureLink(CFG, LP, "x", opts(f.fetch));
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", re);
    assert.equal(!r.ok && r.status, 400);
    assert.equal(f.calls.length, 1, `HTTP ${status} is not retried`);
  }
});

test("vcPbEnsureLink: a 5xx / a network error is retried once, then a 502 naming the service", async () => {
  const f5 = fake(json(503, { status: "error", error: "down" }), json(201, okBody(true)));
  const r5 = await vcPbEnsureLink(CFG, LP, "x", opts(f5.fetch));
  assert.ok(r5.ok, "the retry recovers");
  assert.equal(f5.calls.length, 2);

  const dead = fake(async () => {
    throw new TypeError("fetch failed");
  });
  const rd = await vcPbEnsureLink(CFG, LP, "x", opts(dead.fetch));
  assert.equal(rd.ok, false);
  assert.match(!rd.ok ? rd.error : "", /^pb_unreachable — .*pb\.example\.test/);
  assert.equal(!rd.ok && rd.status, 502);
  assert.equal(dead.calls.length, 2);

  const f500 = fake(json(500, { status: "error", error: "boom" }));
  const r500 = await vcPbEnsureLink(CFG, LP, "x", opts(f500.fetch));
  assert.match(!r500.ok ? r500.error : "", /^pb_failed — HTTP 500/);
  assert.equal(!r500.ok && r500.status, 502);
});

test("vcPbEnsureLink: a slow service is cut at the timeout", async () => {
  const slow = fake(
    (call) =>
      new Promise((_, reject) => {
        call.init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  );
  const t0 = Date.now();
  const r = await vcPbEnsureLink(CFG, LP, "x", { fetch: slow.fetch, timeoutMs: 40, retryDelayMs: 0 });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error : "", /pb_unreachable — .*timed out/);
  assert.ok(Date.now() - t0 < 2_000);
});

test("vcPbEnsureLink: an answer that is not a usable tracking link is refused (no launch on a broken link)", async () => {
  const bad = async (over: Record<string, unknown>, re: RegExp, label: string) => {
    const r = await vcPbEnsureLink(CFG, LP, "x", opts(fake(json(201, okBody(true, over))).fetch));
    assert.equal(r.ok, false, label);
    assert.match(!r.ok ? r.error : "", re, label);
    assert.equal(!r.ok && r.status, 502, label);
  };
  await bad({ tracking_url: TRACK.replace("https://", "http://") }, /pb_link_invalid/, "plain http");
  await bad({ tracking_url: `https://trackwow3.xyz/r/${ID}` }, /pb_link_invalid.*\{\{campaign\.id\}\}/, "no FB macros");
  await bad({ tracking_url: TRACK.replace("&ad_id={{ad.id}}", "") }, /pb_link_invalid.*\{\{ad\.id\}\}/, "ad macro missing");
  await bad({ tracking_url: TRACK.replace(`/r/${ID}`, "/r/someoneelse") }, /pb_link_invalid/, "path is another link's");
  await bad({ tracking_url: "not a url" }, /pb_link_invalid/, "garbage");
  await bad({ link_id: "" }, /pb_link_invalid/, "no link id");
  await bad({ target_url: "https://www.qualitydays.com/coa/other-quiz-abcdefghij/" }, /pb_link_mismatch/, "another target");
  const notOk = await vcPbEnsureLink(CFG, LP, "x", opts(fake(json(201, { status: "error", error: "x" })).fetch));
  assert.match(!notOk.ok ? notOk.error : "", /pb_link_invalid/);
  const html = await vcPbEnsureLink(CFG, LP, "x", opts(fake(new Response("<html>gateway</html>", { status: 200 })).fetch));
  assert.match(!html.ok ? html.error : "", /pb_link_invalid/);
});
