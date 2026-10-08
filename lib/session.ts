import { createHmac, timingSafeEqual } from "node:crypto";
import { DEFAULT_TEAM, TEAM, type TeamConfig } from "./team.ts";

// Server-only. HMAC-signed session cookie (no JWT dependency). Runs in the proxy (Node
// runtime in Next 16) and route handlers.
// A too-short secret is treated as UNSET (fail closed): with a known-plaintext HMAC pair, a
// low-entropy key could be brute-forced offline → forged sessions. 32+ chars is the floor; the
// deployed secret is far longer.
const RAW_SECRET = process.env.AUTH_SECRET ?? "";
const SECRET = RAW_SECRET.length >= 32 ? RAW_SECRET : "";
if (RAW_SECRET && RAW_SECRET.length < 32) {
  console.error("AUTH_SECRET is too short (<32 chars) — sessions are DISABLED until it is strengthened.");
}
export const SESSION_COOKIE = "adl_session";
export const SESSION_TTL_SEC = 60 * 60 * 24 * 7; // 7 days
// Sliding renewal (owner 01.10): a fixed 7 days from login cut buyers off MID-WAVE — the open tab
// kept launching on a dead cookie and every upload died as "upload rejected by the media store —
// Vercel Blob: Failed to retrieve the client token". A live session older than RENEW_AFTER gets a
// fresh 7-day cookie on its next proxied request (at most one Set-Cookie a day per user); the
// LOGIN time (iat) rides across renewals so activity can't stretch a session past MAX_LIFETIME.
export const SESSION_RENEW_AFTER_SEC = 60 * 60 * 24; // 1 day
export const SESSION_MAX_LIFETIME_SEC = 60 * 60 * 24 * 30; // 30 days from login

export type Session = {
  sub: string | number;
  username: string;
  email?: string;
  role?: string | null;
  /** The team whose launcher minted this cookie (lib/team). A cookie is only ever valid on its own
   *  team's deployment — next to the per-team AUTH_SECRET, so a copied secret alone opens nothing.
   *  Absent on cookies signed before teams existed: those are the first team's. */
  team?: string;
  iat?: number; // login time, epoch seconds (absent on tokens signed before 01.10)
  exp: number; // epoch seconds
};

const b64u = (s: string) => Buffer.from(s).toString("base64url");
const unb64u = (s: string) => Buffer.from(s, "base64url").toString();
const sign = (part: string) => createHmac("sha256", SECRET).update(part).digest("base64url");
const nowSec = () => Math.floor(Date.now() / 1000);

function signPayload(payload: Session): string {
  const body = b64u(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

/** Create a signed, expiring session token. A fresh login stamps `iat` (the login time). The team
 *  is always THIS deployment's — every mint (the login, the queue's run-as-owner cookie) gets it here. */
export function signSession(data: Omit<Session, "exp">, ttlSec = SESSION_TTL_SEC, team: TeamConfig = TEAM): string {
  const now = nowSec();
  return signPayload({ ...data, team: team.id, iat: data.iat ?? now, exp: now + ttlSec });
}

/** The session cookie's attributes — one source for the login route and the proxy's renewal. */
export function sessionCookieOptions(maxAgeSec: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSec,
  };
}

/**
 * Sliding renewal for a VERIFIED live session: a fresh token (+ its cookie max-age) once the
 * current one is RENEW_AFTER old, keeping the login time — or null when no renewal is due or the
 * absolute lifetime from login is spent (then it simply runs out, as before). A token signed
 * before `iat` existed counts its login as exp − TTL (what the old code issued).
 */
export function renewedSessionToken(s: Session, now = nowSec(), team: TeamConfig = TEAM): { token: string; maxAge: number } | null {
  if (s.exp - now > SESSION_TTL_SEC - SESSION_RENEW_AFTER_SEC) return null; // < a day old
  const loginAt = s.iat ?? s.exp - SESSION_TTL_SEC;
  const exp = Math.min(now + SESSION_TTL_SEC, loginAt + SESSION_MAX_LIFETIME_SEC);
  if (exp <= s.exp) return null; // at the lifetime cap — nothing to extend
  const { sub, username, email, role } = s;
  return { token: signPayload({ sub, username, email, role, team: team.id, iat: loginAt, exp }), maxAge: exp - now };
}

/** Read + verify the session straight from a request's Cookie header. Used by routes that are
 *  excluded from the proxy (e.g. the large-body /api/launch upload) so they gate themselves. */
export function sessionFromCookieHeader(cookieHeader: string | null): Session | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      const raw = part.slice(eq + 1).trim();
      let token = raw;
      try {
        token = decodeURIComponent(raw);
      } catch {
        /* malformed %-escape → treat the raw value as the token (verify will just reject it) */
      }
      return verifySession(token);
    }
  }
  return null;
}

/** Verify signature + expiry + team; returns the session, or null if missing/tampered/expired or
 *  minted for another team's launcher. */
export function verifySession(token: string | undefined | null, team: TeamConfig = TEAM): Session | null {
  if (!token || !SECRET) return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(body));
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(unb64u(body)) as Session;
    if (!payload.exp || payload.exp < nowSec()) return null;
    if ((payload.team ?? DEFAULT_TEAM) !== team.id) return null;
    return payload;
  } catch {
    return null;
  }
}
