import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, cookieHeaderWith, refreshedSessionToken, renewedSessionToken, sessionCookieOptions, verifySession } from "@/lib/session";
import { liveSessionVerdict } from "@/lib/session-live";
import { canonicalRedirectUrl } from "@/lib/canonical-host";
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
 *
 * Live login check (owner ask 20.10 — owners manage the team's logins on /users): a valid cookie is
 * also held against the user directory (lib/session-live — remembered per instance for seconds, never
 * waited on for long; a directory that cannot answer changes nothing). A login that was deleted, blocked
 * or signed out everywhere loses its cookie here: an API call answers 401 session_revoked, a page goes
 * to /login. A login that was renamed or got another role gets its cookie re-issued — and the route
 * behind this request already reads the new one (the request's Cookie header is swapped).
 */
export async function proxy(request: NextRequest) {
  // A production page opened on a deployment's own vercel.app URL goes to the team's real site — that
  // URL would show its own (possibly old) build for ever (lib/canonical-host).
  const canonical = canonicalRedirectUrl({
    host: request.headers.get("host"),
    pathname: request.nextUrl.pathname,
    search: request.nextUrl.search,
    method: request.method,
    selfOrigin: process.env.ADL_SELF_ORIGIN,
    vercelEnv: process.env.VERCEL_ENV,
  });
  if (canonical) return NextResponse.redirect(canonical, 307);

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  let session = verifySession(token);
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
    const live = await liveSessionVerdict(session);
    if (live.kind === "revoked") return signedOut(request, live.reason);
    let reissued: { token: string; maxAge: number } | null = null;
    if (live.kind === "refresh") {
      const r = refreshedSessionToken(session, live);
      reissued = r;
      session = r.session;
    }
    const renewed = renewedSessionToken(session);
    if (renewed) reissued = renewed;
    const res =
      live.kind === "refresh" && reissued
        ? NextResponse.next({ request: { headers: withCookie(request.headers, reissued.token) } })
        : NextResponse.next();
    if (reissued) res.cookies.set(SESSION_COOKIE, reissued.token, sessionCookieOptions(reissued.maxAge));
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

/** The request's headers with the session cookie swapped for a re-issued one. */
function withCookie(headers: Headers, token: string): Headers {
  const out = new Headers(headers);
  out.set("cookie", cookieHeaderWith(headers.get("cookie"), SESSION_COOKIE, token));
  return out;
}

/** The login behind this cookie is gone / blocked / signed out everywhere. An API call is refused and
 *  told why (401 session_revoked) — the cookie stays, so the open tab's session watch can learn the same
 *  from /api/auth/session and take the tab to /login; a page goes to /login and drops the cookie. */
function signedOut(request: NextRequest, reason: string) {
  if (request.nextUrl.pathname.startsWith("/api")) {
    return NextResponse.json({ ok: false, error: "session_revoked", reason }, { status: 401 });
  }
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  const res = NextResponse.redirect(url);
  res.cookies.set(SESSION_COOKIE, "", sessionCookieOptions(0));
  return res;
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
