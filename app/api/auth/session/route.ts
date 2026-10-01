import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";

export const runtime = "nodejs";

/**
 * Is this tab's login still alive? 200 {username, expiresAt} or 401. Under api/auth, so the proxy
 * never answers for it (and never renews here) — the route reads the cookie itself. The creative
 * uploader asks it when the Blob token broker refuses, to tell "your login expired — log in again"
 * apart from a real upload rejection (owner 01.10).
 */
export async function GET(req: Request) {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  return NextResponse.json(
    { ok: true, username: session.username, expiresAt: session.exp * 1000 },
    { headers: { "Cache-Control": "no-store" } },
  );
}
