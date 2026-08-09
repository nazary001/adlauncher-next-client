import { createHmac, timingSafeEqual } from "node:crypto";

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
const DEFAULT_TTL = 60 * 60 * 24 * 7; // 7 days

export type Session = {
  sub: string | number;
  username: string;
  email?: string;
  role?: string | null;
  exp: number; // epoch seconds
};

const b64u = (s: string) => Buffer.from(s).toString("base64url");
const unb64u = (s: string) => Buffer.from(s, "base64url").toString();
const sign = (part: string) => createHmac("sha256", SECRET).update(part).digest("base64url");

/** Create a signed, expiring session token. */
export function signSession(data: Omit<Session, "exp">, ttlSec = DEFAULT_TTL): string {
  const payload: Session = { ...data, exp: Math.floor(Date.now() / 1000) + ttlSec };
  const body = b64u(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
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

/** Verify signature + expiry; returns the session, or null if missing/tampered/expired. */
export function verifySession(token: string | undefined | null): Session | null {
  if (!token || !SECRET) return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(body));
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(unb64u(body)) as Session;
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
