import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { isOwnerSession } from "@/lib/roles";
import { snapAuthorizeUrl, snapRailEnabled } from "@/lib/snap-api";
import { SNAP_OAUTH_STATE_COOKIE, signOauthState, snapClientConfigured, snapOauthRedirectUri } from "@/lib/snap-oauth";

export const runtime = "nodejs";

/** GET → 302 to Snapchat's consent page (scope snapchat-marketing-api). Owner only. */
export async function GET(req: Request) {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!snapRailEnabled()) return NextResponse.json({ ok: false, error: "snap_rail_disabled" }, { status: 404 });
  if (!isOwnerSession(session)) return NextResponse.json({ ok: false, error: "owner_only" }, { status: 403 });
  if (!snapClientConfigured()) return NextResponse.json({ ok: false, error: "snap_client_not_configured (SNAP_CLIENT_ID / SNAP_CLIENT_SECRET)" }, { status: 500 });
  const state = signOauthState();
  const res = NextResponse.redirect(snapAuthorizeUrl(state, snapOauthRedirectUri(req)));
  res.cookies.set(SNAP_OAUTH_STATE_COOKIE, state, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/snap/oauth", maxAge: 600 });
  return res;
}
