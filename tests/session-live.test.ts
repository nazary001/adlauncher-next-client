// `node --test tests/session-live.test.ts` — the session cookie is checked against the user directory
// (owner ask 20.10: owners add / edit / delete logins from the launcher). A cookie lives up to 30 days;
// without this a deleted or blocked login kept launching on it, and a role change only reached the
// cookie at the next sign-in. lib/session-live decides (pure) what the directory's answer means for a
// session; proxy.ts and /api/auth/session apply it. The directory not answering changes nothing.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.AUTH_SECRET = "test-secret-0123456789-0123456789-abcdef";

const s = await import("../lib/session.ts");
const live = await import("../lib/session-live.ts");

const now = Math.floor(Date.now() / 1000);
const session: import("../lib/session.ts").Session = { sub: 7, username: "Tima", role: "designer", iat: now - 3600, exp: now + 3600 };
const user = (extra: Partial<import("../lib/session-live.ts").LiveUser> = {}): import("../lib/session-live.ts").LiveUser => ({
  username: "Tima",
  role: "designer",
  blocked: false,
  sessionsValidAfter: null,
  ...extra,
});

test("judgeLiveSession: the directory agrees → ok; it cannot say (undefined) → ok, the cookie stands", () => {
  assert.deepEqual(live.judgeLiveSession(session, user()), { kind: "ok" });
  assert.deepEqual(live.judgeLiveSession(session, undefined), { kind: "ok" });
});

test("judgeLiveSession: a deleted login, a blocked one, and a cookie older than the owner's 'sign out everywhere' are revoked", () => {
  assert.deepEqual(live.judgeLiveSession(session, null), { kind: "revoked", reason: "gone" });
  assert.deepEqual(live.judgeLiveSession(session, user({ blocked: true })), { kind: "revoked", reason: "blocked" });
  assert.deepEqual(live.judgeLiveSession(session, user({ sessionsValidAfter: now })), { kind: "revoked", reason: "signed_out" });
  // signed in after the cut (or in the same second) → still good
  assert.deepEqual(live.judgeLiveSession({ ...session, iat: now }, user({ sessionsValidAfter: now })), { kind: "ok" });
  // a cookie without a login time cannot prove it is newer than the cut
  assert.deepEqual(live.judgeLiveSession({ ...session, iat: undefined }, user({ sessionsValidAfter: now })), { kind: "revoked", reason: "signed_out" });
});

test("judgeLiveSession: a renamed login or a changed role is re-issued (refresh), no sign-out", () => {
  assert.deepEqual(live.judgeLiveSession(session, user({ username: "Timur" })), { kind: "refresh", username: "Timur", role: "designer" });
  assert.deepEqual(live.judgeLiveSession(session, user({ role: "owner" })), { kind: "refresh", username: "Tima", role: "owner" });
  // null and "" are the same "no role" — no needless re-issue
  assert.deepEqual(live.judgeLiveSession({ ...session, role: null }, user({ role: "" })), { kind: "ok" });
  assert.deepEqual(live.judgeLiveSession({ ...session, role: undefined }, user({ role: null })), { kind: "ok" });
});

test("liveIdOf: only a directory id (a safe positive integer, or its digits) is looked up", () => {
  assert.equal(live.liveIdOf(7), 7);
  assert.equal(live.liveIdOf("21"), 21);
  assert.equal(live.liveIdOf("Tima"), null);
  assert.equal(live.liveIdOf(null as unknown as number), null);
  assert.equal(live.liveIdOf(0), null);
  assert.equal(live.liveIdOf(1.5), null);
});

test("readLiveUser: answers are remembered for the TTL; a failing directory answers undefined (remembered briefly), never throws", async () => {
  live.forgetLiveUsers();
  let calls = 0;
  const load = async (id: number) => {
    calls++;
    return id === 1 ? user() : null;
  };
  const t0 = 1_000_000;
  assert.deepEqual(await live.readLiveUser(1, load, t0), user());
  assert.deepEqual(await live.readLiveUser(1, load, t0 + live.LIVE_TTL_MS - 1), user());
  assert.equal(calls, 1);
  assert.equal(await live.readLiveUser(2, load, t0), null); // gone is an answer too — remembered
  assert.equal(await live.readLiveUser(2, load, t0 + 5), null);
  assert.equal(calls, 2);
  assert.deepEqual(await live.readLiveUser(1, load, t0 + live.LIVE_TTL_MS + 1), user()); // stale → asked again
  assert.equal(calls, 3);

  live.forgetLiveUsers();
  let failing = 0;
  const broken = async () => {
    failing++;
    throw new Error("store down");
  };
  assert.equal(await live.readLiveUser(3, broken, t0), undefined);
  assert.equal(await live.readLiveUser(3, broken, t0 + 1), undefined);
  assert.equal(failing, 1, "a failure is remembered, the directory is not hammered");
  assert.equal(await live.readLiveUser(3, broken, t0 + live.LIVE_FAIL_TTL_MS + 1), undefined);
  assert.equal(failing, 2);

  live.forgetLiveUsers();
  const slow = () => new Promise<null>((resolve) => setTimeout(() => resolve(null), 200));
  assert.equal(await live.readLiveUser(4, slow, t0, 20), undefined, "a slow directory is not waited for");
});

test("forgetLiveUser drops one id, so this instance sees an owner's change at once", async () => {
  live.forgetLiveUsers();
  let role = "designer";
  const load = async () => user({ role });
  assert.equal((await live.readLiveUser(9, load, 5))?.role, "designer");
  role = "owner";
  assert.equal((await live.readLiveUser(9, load, 6))?.role, "designer");
  live.forgetLiveUser(9);
  assert.equal((await live.readLiveUser(9, load, 7))?.role, "owner");
});

test("refreshedSessionToken: same sign-in time and expiry, the directory's name and role", () => {
  const r = s.refreshedSessionToken(session, { username: "Timur", role: "owner" });
  const v = s.verifySession(r.token);
  assert.ok(v);
  assert.equal(v.username, "Timur");
  assert.equal(v.role, "owner");
  assert.equal(v.sub, 7);
  assert.equal(v.iat, session.iat);
  assert.equal(v.exp, session.exp);
  assert.deepEqual(r.session, v);
  assert.ok(r.maxAge > 0 && r.maxAge <= 3600);
});

test("cookieHeaderWith: swaps one cookie's value in a Cookie header, adds it when absent", () => {
  assert.equal(s.cookieHeaderWith("a=1; adl_session=old; b=2", "adl_session", "new"), "a=1; adl_session=new; b=2");
  assert.equal(s.cookieHeaderWith("a=1", "adl_session", "new"), "a=1; adl_session=new");
  assert.equal(s.cookieHeaderWith(null, "adl_session", "new"), "adl_session=new");
  assert.equal(s.cookieHeaderWith("adl_session=x;adl_session_other=y", "adl_session", "z"), "adl_session=z; adl_session_other=y");
});

test("liveSessionVerdict: ADL_SESSION_LIVE=off (a bench whose scripts sign their own cookies) asks nothing — every cookie stands", async () => {
  const prev = { live: process.env.ADL_SESSION_LIVE, uri: process.env.MONGODB_URI };
  process.env.MONGODB_URI = "mongodb://127.0.0.1:1/never"; // would fail (→ ok anyway), but must not even be asked
  process.env.ADL_SESSION_LIVE = "off";
  live.forgetLiveUsers();
  try {
    const t0 = Date.now();
    assert.deepEqual(await live.liveSessionVerdict({ ...session, sub: 424242 }), { kind: "ok" });
    assert.ok(Date.now() - t0 < 200, "no store round-trip");
  } finally {
    if (prev.live === undefined) delete process.env.ADL_SESSION_LIVE;
    else process.env.ADL_SESSION_LIVE = prev.live;
    if (prev.uri === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = prev.uri;
  }
});

test("queueOwnerRefusal: a queued launch of a login deleted or blocked meanwhile is not sent; a follow-up of a launch already made still runs; a new password stops nothing", () => {
  const gone = { kind: "revoked", reason: "gone" } as const;
  const blocked = { kind: "revoked", reason: "blocked" } as const;
  const signedOut = { kind: "revoked", reason: "signed_out" } as const;
  assert.match(String(live.queueOwnerRefusal("hs.lion", "Oleg", gone)), /Oleg.*deleted.*nothing was sent/);
  assert.match(String(live.queueOwnerRefusal("mo.launch", "Oleg", blocked)), /Oleg.*blocked.*nothing was sent/);
  assert.match(String(live.queueOwnerRefusal("tt.launch", "Oleg", blocked)), /blocked/);
  for (const k of ["hs.dup.follow", "hs.jurar.follow", "tool.follow", "tt.follow"]) assert.equal(live.queueOwnerRefusal(k, "Oleg", gone), null, k);
  assert.equal(live.queueOwnerRefusal("hs.lion", "Oleg", signedOut), null);
  assert.equal(live.queueOwnerRefusal("hs.lion", "Oleg", { kind: "ok" }), null);
  assert.equal(live.queueOwnerRefusal("hs.lion", "Oleg", { kind: "refresh", username: "Olegg", role: null }), null);
});
