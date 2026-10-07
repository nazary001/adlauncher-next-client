import { NextResponse } from "next/server";
import { SESSION_COOKIE, SESSION_TTL_SEC, sessionCookieOptions, signSession } from "@/lib/session";
import { authenticateUser } from "@/lib/auth-users";
import { storeConfigured } from "@/lib/store";

export const runtime = "nodejs";

// Same users as amazon-tools: the `up_users` collection (migrated from the tools Strapi's
// users-permissions). Passwords are verified locally (bcrypt); a user whose hash never left Strapi
// is verified ONCE against the old `STRAPI_TOOLS_URL` and migrated — see lib/auth-users.

// Best-effort in-memory brute-force throttle, counting FAILED attempts only (a shared office/VPN NAT
// IP isn't locked out by successful logins). Keyed by BOTH the client IP and the identifier, so
// rotating one can't dodge the other. Resets on restart / per serverless instance.
const hits = new Map<string, { n: number; resetAt: number }>();
const WINDOW = 15 * 60 * 1000;
const MAX = 10;
function overLimit(key: string): boolean {
  const rec = hits.get(key);
  return !!rec && rec.resetAt >= Date.now() && rec.n >= MAX;
}
function recordFailure(key: string): void {
  const now = Date.now();
  const rec = hits.get(key);
  if (!rec || rec.resetAt < now) hits.set(key, { n: 1, resetAt: now + WINDOW });
  else rec.n += 1;
}

/** Trusted client IP. On Vercel `x-real-ip` is set by the platform (a client can't spoof it); the
 *  leftmost X-Forwarded-For hop is CLIENT-controlled, so never key the throttle on it. */
function clientIp(req: Request): string {
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  // Fallback (local dev / non-Vercel): the RIGHTMOST XFF hop is the one added by the nearest proxy.
  const xff = req.headers.get("x-forwarded-for") ?? "";
  const hops = xff.split(",").map((s) => s.trim()).filter(Boolean);
  return hops.length ? hops[hops.length - 1] : "local";
}

export async function POST(req: Request) {
  if (!storeConfigured()) return NextResponse.json({ ok: false, error: "auth_not_configured" }, { status: 500 });

  const ipKey = `ip:${clientIp(req)}`;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const identifier = String(body.username ?? body.identifier ?? "").trim();
  const password = String(body.password ?? "").trim();
  if (!identifier || !password) {
    return NextResponse.json({ ok: false, error: "Username and password are required." }, { status: 400 });
  }
  const idKey = `id:${identifier.toLowerCase()}`;
  if (overLimit(ipKey) || overLimit(idKey)) {
    return NextResponse.json({ ok: false, error: "Too many failed attempts — try again later." }, { status: 429 });
  }

  const res = await authenticateUser(identifier, password);
  if (!res.ok) {
    if (res.reason === "unavailable") {
      return NextResponse.json({ ok: false, error: "Auth service is unavailable. Try again." }, { status: 502 });
    }
    recordFailure(ipKey);
    recordFailure(idKey);
    return NextResponse.json({ ok: false, error: "Invalid username or password." }, { status: 401 });
  }
  hits.delete(ipKey); // successful login clears both failure counters
  hits.delete(idKey);

  const u = res.user;
  const username = String(u.username || identifier);
  const role = u.app_role ?? null;
  const token = signSession({ sub: u.id ?? username, username, email: u.email ?? undefined, role });

  const out = NextResponse.json({ ok: true, user: { username, email: u.email ?? null, role } });
  out.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(SESSION_TTL_SEC));
  return out;
}
