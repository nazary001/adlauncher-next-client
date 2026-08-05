import { NextResponse } from "next/server";
import { SESSION_COOKIE, signSession } from "@/lib/session";

export const runtime = "nodejs";

// Same users as amazon-tools: the "tools" Strapi (users-permissions /api/auth/local).
const TOOLS = (process.env.STRAPI_TOOLS_URL ?? "").replace(/\/+$/, "");

// Best-effort in-memory brute-force throttle (per IP, counting FAILED attempts only — so a shared
// office/VPN NAT IP isn't locked out by successful logins). Resets on restart.
const hits = new Map<string, { n: number; resetAt: number }>();
const WINDOW = 15 * 60 * 1000;
const MAX = 10;
function overLimit(ip: string): boolean {
  const rec = hits.get(ip);
  return !!rec && rec.resetAt >= Date.now() && rec.n >= MAX;
}
function recordFailure(ip: string): void {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || rec.resetAt < now) hits.set(ip, { n: 1, resetAt: now + WINDOW });
  else rec.n += 1;
}

export async function POST(req: Request) {
  if (!TOOLS) return NextResponse.json({ ok: false, error: "auth_not_configured" }, { status: 500 });

  const ip = (req.headers.get("x-forwarded-for") ?? "local").split(",")[0].trim();
  if (overLimit(ip)) {
    return NextResponse.json({ ok: false, error: "Too many failed attempts — try again later." }, { status: 429 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const identifier = String(body.username ?? body.identifier ?? "").trim();
  const password = String(body.password ?? "").trim();
  if (!identifier || !password) {
    return NextResponse.json({ ok: false, error: "Username and password are required." }, { status: 400 });
  }

  try {
    const res = await fetch(`${TOOLS}/api/auth/local`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier, password }),
      signal: AbortSignal.timeout(8000),
    });
    const data = (await res.json().catch(() => ({}))) as { user?: Record<string, unknown> };
    if (!res.ok || !data?.user) {
      recordFailure(ip);
      return NextResponse.json({ ok: false, error: "Invalid username or password." }, { status: 401 });
    }
    hits.delete(ip); // successful login clears the failure counter

    const u = data.user;
    const username = String(u.username ?? identifier);
    const role = (u.app_role as string | undefined) ?? null;
    const token = signSession({ sub: (u.id as string | number) ?? username, username, email: u.email as string, role });

    const out = NextResponse.json({ ok: true, user: { username, email: u.email ?? null, role } });
    out.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
    return out;
  } catch {
    return NextResponse.json({ ok: false, error: "Auth service is unavailable. Try again." }, { status: 502 });
  }
}
