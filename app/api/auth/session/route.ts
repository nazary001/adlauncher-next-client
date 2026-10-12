import { NextResponse } from "next/server";
import { SESSION_COOKIE, renamedSessionToken, sessionCookieOptions, sessionFromCookieHeader } from "@/lib/session";
import { currentUsernameOf } from "@/lib/auth-users";

export const runtime = "nodejs";

/**
 * Is this tab's login still alive, and WHO is it? 200 {username, expiresAt} or 401. Under api/auth, so
 * the proxy never answers for it (and never renews here) — the route reads the cookie itself. Two
 * askers: the creative uploader, when the Blob token broker refuses, to tell "your login expired — log
 * in again" apart from a real upload rejection (owner 01.10); and every open tab
 * (components/session-watch), to notice that the browser is signed in as somebody else now.
 *
 * The cookie carries the username as it was at sign-in, for up to 30 days. A login the owner renamed
 * since (scripts/rename-user) is re-issued here under its current name — same sign-in time, same
 * expiry — so the buyer's next names carry the new one without anybody logging out. The directory
 * not answering changes nothing: the cookie's own name stands.
 */
export async function GET(req: Request) {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });

  const current = await currentUsernameOf(session.sub);
  const renamed = current && current !== session.username ? renamedSessionToken(session, current) : null;
  const res = NextResponse.json(
    { ok: true, username: renamed ? current : session.username, expiresAt: session.exp * 1000 },
    { headers: { "Cache-Control": "no-store" } },
  );
  if (renamed) res.cookies.set(SESSION_COOKIE, renamed.token, sessionCookieOptions(renamed.maxAge));
  return res;
}
