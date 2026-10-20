import { NextResponse } from "next/server";
import { SESSION_COOKIE, refreshedSessionToken, sessionCookieOptions, sessionFromCookieHeader } from "@/lib/session";
import { liveSessionVerdict } from "@/lib/session-live";

export const runtime = "nodejs";

/**
 * Is this tab's login still alive, and WHO is it? 200 {username, role, expiresAt} or 401. Under api/auth,
 * so the proxy never answers for it (and never renews here) — the route reads the cookie itself. Two
 * askers: the creative uploader, when the Blob token broker refuses, to tell "your login expired — log
 * in again" apart from a real upload rejection (owner 01.10); and every open tab
 * (components/session-watch), to notice that the browser is signed in as somebody else now.
 *
 * The cookie carries the username and role as they were at sign-in, for up to 30 days. The directory
 * is asked here as the proxy asks it (lib/session-live): a login the owner renamed or gave another role
 * since (/users, scripts/rename-user) is re-issued under what it is now — same sign-in time, same
 * expiry — so the buyer's next names carry the new one without anybody logging out; a login the owner
 * deleted, blocked or signed out everywhere answers 401 session_revoked and loses its cookie (the tab
 * goes to /login). The directory not answering changes nothing: the cookie stands.
 */
export async function GET(req: Request) {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });

  const live = await liveSessionVerdict(session);
  if (live.kind === "revoked") {
    const out = NextResponse.json({ ok: false, error: "session_revoked", reason: live.reason }, { status: 401, headers: { "Cache-Control": "no-store" } });
    out.cookies.set(SESSION_COOKIE, "", sessionCookieOptions(0));
    return out;
  }
  const next = live.kind === "refresh" ? refreshedSessionToken(session, live) : null;
  const now = next ? next.session : session;
  const res = NextResponse.json(
    { ok: true, username: now.username, role: now.role ?? null, expiresAt: session.exp * 1000 },
    { headers: { "Cache-Control": "no-store" } },
  );
  if (next) res.cookies.set(SESSION_COOKIE, next.token, sessionCookieOptions(next.maxAge));
  return res;
}
