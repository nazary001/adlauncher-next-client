import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, renewedSessionToken, sessionCookieOptions, verifySession } from "@/lib/session";
import { teamAllowsPath } from "@/lib/team";

/**
 * Auth gate. Runs on everything except static assets, the login page and /api/auth/*.
 * Valid session → continue (renewed once it is a day old — the open launcher polls proxied
 * routes every few seconds, so a working buyer never hits the 7-day wall mid-wave; see
 * lib/session renewedSessionToken); otherwise API calls get 401 and page/asset requests are
 * sent to /login. (Next 16 proxy runs on the Node.js runtime, so node:crypto is available.)
 *
 * Team gate (lib/team): a signed-in request for something THIS team's launcher does not have — another
 * partner's rail, a launch channel or a platform tab it was not given — is refused here, whatever the
 * UI shows: an API call answers 404, a page goes home. The first team has everything, so nothing is
 * ever refused there. The routes excluded from the matcher below gate themselves, and a QUEUED launch
 * never passes here at all (the pump calls its handler in-process) — the queue asks lib/team itself.
 */
export function proxy(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = verifySession(token);
  if (session) {
    if (!teamAllowsPath(request.nextUrl.pathname)) {
      if (request.nextUrl.pathname.startsWith("/api")) {
        return NextResponse.json({ ok: false, error: "not_available" }, { status: 404 });
      }
      const home = request.nextUrl.clone();
      home.pathname = "/";
      home.search = "";
      return NextResponse.redirect(home);
    }
    const res = NextResponse.next();
    const renewed = renewedSessionToken(session);
    if (renewed) res.cookies.set(SESSION_COOKIE, renewed.token, sessionCookieOptions(renewed.maxAge));
    return res;
  }

  if (request.nextUrl.pathname.startsWith("/api")) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  // Excluded from the proxy (they gate themselves):
  //   • api/launch             — video is now a small JSON URL, but it still auth-checks inline.
  //   • api/launch-queue/pump  — the internal lane self-kick (and the cron's per-lane restart);
  //                              authenticates with a Bearer (HMAC(AUTH_SECRET) internal token or
  //                              CRON_SECRET), never a cookie, so the proxy's session gate would 401
  //                              every kick. The route checks isInternalRequest itself.
  //   • api/launch-queue/cron  — Vercel Cron's every-minute sweep: CRON_SECRET bearer (no cookie on
  //                              cron requests); a session passes too (same as token-cron).
  //   • api/blob-upload        — Blob's server-to-server "upload completed" callback carries no cookie;
  //                              the route enforces auth in onBeforeGenerateToken instead.
  //   • api/hs/token-cron      — Vercel Cron's 10-min token-pool sweep authenticates with the
  //                              CRON_SECRET bearer (no cookie on cron requests); sessions pass too.
  // `api/launch(?![\w-])` keeps /api/launch-tasks AND /api/launch-queue proxied (the `-` is excluded
  // from the lookahead, so "launch-…" never matches that exclusion) — only the two sub-routes named
  // explicitly above are let through; /api/launch-queue itself and /api/creatives stay behind the gate.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|login|api/auth|api/launch(?![\\w-])|api/launch-queue/pump|api/launch-queue/cron|api/blob-upload|api/hs/token-cron).*)",
  ],
};
