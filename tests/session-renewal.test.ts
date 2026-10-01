// Node's built-in runner (v24 strips types natively): `node --test tests/session-renewal.test.ts`.
// Sliding session renewal (owner 01.10: a buyer's launch died mid-wave with "upload rejected by
// the media store — Vercel Blob: Failed to retrieve the client token" — the 7-day session simply
// ran out in an open tab at 13:15 UTC, exactly a week after login). A live session older than a
// day gets a fresh 7-day cookie on its next proxied request, keeping the original login time, so
// an active buyer is never cut off mid-work — but never past SESSION_MAX_LIFETIME_SEC from login.
// proxy.ts imports the "@/" alias + next/server (not loadable by node --test, repo convention), so
// the renewal DECISION lives here in lib/session and the proxy only applies it.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.AUTH_SECRET = "test-secret-0123456789-0123456789-abcdef";

const s = await import("../lib/session.ts");

const DAY = 24 * 60 * 60;
const base = { sub: 7, username: "tima", email: "t@x.y", role: null };

/** A session as if it was signed `ageSec` ago (exp/iat shifted back), without waiting. */
function sessionAged(ageSec: number, extra: Partial<s.Session> = {}): s.Session {
  const now = Math.floor(Date.now() / 1000);
  return { ...base, iat: now - ageSec, exp: now - ageSec + s.SESSION_TTL_SEC, ...extra };
}

test("signSession stamps the login time (iat) and a 7-day exp", () => {
  const now = Math.floor(Date.now() / 1000);
  const v = s.verifySession(s.signSession(base));
  assert.ok(v);
  assert.equal(v.username, "tima");
  assert.ok(Math.abs((v.iat ?? 0) - now) <= 2);
  assert.ok(Math.abs(v.exp - (now + s.SESSION_TTL_SEC)) <= 2);
});

test("a fresh session is not renewed (at most one fresh cookie a day)", () => {
  assert.equal(s.renewedSessionToken(sessionAged(0)), null);
  assert.equal(s.renewedSessionToken(sessionAged(DAY - 60)), null);
});

test("a session older than a day is renewed to a full 7 days, keeping the login time", () => {
  const now = Math.floor(Date.now() / 1000);
  const old = sessionAged(6 * DAY + 23 * 3600); // ~1h before the hard 7-day cut
  const r = s.renewedSessionToken(old, now);
  assert.ok(r);
  const v = s.verifySession(r.token);
  assert.ok(v);
  assert.equal(v.username, "tima");
  assert.equal(v.sub, 7);
  assert.equal(v.iat, old.iat); // the LOGIN time rides across renewals
  assert.equal(v.exp, now + s.SESSION_TTL_SEC);
  assert.equal(r.maxAge, s.SESSION_TTL_SEC);
});

test("a legacy token (no iat) is renewed from its implied login time exp − TTL", () => {
  const now = Math.floor(Date.now() / 1000);
  const legacy: s.Session = { ...base, exp: now + DAY }; // signed 6 days ago by the old code
  const r = s.renewedSessionToken(legacy, now);
  assert.ok(r);
  const v = s.verifySession(r.token);
  assert.ok(v);
  assert.equal(v.iat, legacy.exp - s.SESSION_TTL_SEC);
  assert.equal(v.exp, now + s.SESSION_TTL_SEC);
});

test("renewal never carries a session past the absolute lifetime from login", () => {
  const now = Math.floor(Date.now() / 1000);
  // Logged in 24 days ago, last renewed 2 days ago (exp = day 22 + 7): renewal may only reach
  // login + 30 days, i.e. 6 days from now — not a full 7.
  const near: s.Session = { ...base, iat: now - 24 * DAY, exp: now + 5 * DAY };
  const r = s.renewedSessionToken(near, now);
  assert.ok(r);
  const v = s.verifySession(r.token);
  assert.ok(v);
  assert.equal(v.exp, near.iat! + s.SESSION_MAX_LIFETIME_SEC);
  assert.equal(r.maxAge, v.exp - now);
  // Already at the cap → nothing to renew (no Set-Cookie on every request).
  const capped: s.Session = { ...base, iat: now - 29 * DAY, exp: now - 29 * DAY + s.SESSION_MAX_LIFETIME_SEC };
  assert.equal(s.renewedSessionToken(capped, now), null);
});

test("an expired or tampered token never verifies (renewal can't revive it)", () => {
  const now = Math.floor(Date.now() / 1000);
  const dead = s.signSession({ ...base, iat: now - 8 * DAY }, -60);
  assert.equal(s.verifySession(dead), null);
  const good = s.signSession(base);
  assert.equal(s.verifySession(good.slice(0, -2) + "xx"), null);
});

test("sessionCookieOptions matches the login cookie (httpOnly, lax, path /)", () => {
  const o = s.sessionCookieOptions(123);
  assert.equal(o.httpOnly, true);
  assert.equal(o.sameSite, "lax");
  assert.equal(o.path, "/");
  assert.equal(o.maxAge, 123);
});
