import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/session";

/**
 * Auth gate. Runs on everything except static assets, the login page and /api/auth/*.
 * Valid session → continue; otherwise API calls get 401 and page/asset requests are sent
 * to /login. (Next 16 proxy runs on the Node.js runtime, so node:crypto is available.)
 */
export function proxy(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (verifySession(token)) return NextResponse.next();

  if (request.nextUrl.pathname.startsWith("/api")) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  // Exclude /api/launch: it carries the multi-MB video upload, and the proxy buffers request
  // bodies (capped) — that upload gates itself inline instead. `api/launch(?!-)` keeps
  // /api/launch-tasks proxied.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|login|api/auth|api/launch(?!-)).*)"],
};
