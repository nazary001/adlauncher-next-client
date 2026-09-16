import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { isOwnerSession } from "@/lib/roles";
import { snapExchangeCode, snapRailEnabled } from "@/lib/snap-api";
import { SNAP_OAUTH_STATE_COOKIE, snapClientConfigured, snapOauthRedirectUri, verifyOauthState } from "@/lib/snap-oauth";

export const runtime = "nodejs";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

function page(title: string, body: string, status = 200): NextResponse {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;background:#0b0d12;color:#e6e8ef;padding:32px;max-width:760px;margin:auto}code{display:block;white-space:pre-wrap;word-break:break-all;background:#151925;border:1px solid #2a3040;border-radius:8px;padding:12px;margin:12px 0;font-size:13px}b{color:#f3f0a3}</style></head><body>${body}</body></html>`;
  const res = new NextResponse(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  res.cookies.set(SNAP_OAUTH_STATE_COOKIE, "", { path: "/api/snap/oauth", maxAge: 0 });
  return res;
}

/** GET ?code&state → exchange once, SHOW the refresh token, store nothing. Owner only. */
export async function GET(req: Request) {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!snapRailEnabled()) return NextResponse.json({ ok: false, error: "snap_rail_disabled" }, { status: 404 });
  if (!isOwnerSession(session)) return NextResponse.json({ ok: false, error: "owner_only" }, { status: 403 });
  if (!snapClientConfigured()) return page("Snapchat OAuth", "<h2>Client not configured</h2><p>Set SNAP_CLIENT_ID and SNAP_CLIENT_SECRET first.</p>", 500);
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookie = /(?:^|;\s*)snap_oauth_state=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1] ?? null;
  if (url.searchParams.get("error")) return page("Snapchat OAuth", `<h2>Snapchat refused</h2><p>${esc(url.searchParams.get("error_description") || url.searchParams.get("error") || "")}</p>`, 400);
  // A hand-tampered cookie with a malformed %-escape must land on the 400 page, never a 500.
  let cookieState: string | null = null;
  try {
    cookieState = cookie ? decodeURIComponent(cookie) : null;
  } catch {
    cookieState = null;
  }
  if (!code || !verifyOauthState(state, cookieState)) return page("Snapchat OAuth", "<h2>State mismatch</h2><p>Start again from <a href=\"/api/snap/oauth/start\">/api/snap/oauth/start</a> in the same browser.</p>", 400);
  try {
    const t = await snapExchangeCode(code, snapOauthRedirectUri(req));
    return page(
      "Snapchat OAuth",
      `<h2>Refresh token minted</h2><p>Paste this line into <b>.env.local</b> (locally) — it is shown ONCE and stored nowhere:</p><code>SNAP_REFRESH_TOKEN=${esc(t.refreshToken)}</code><p>Then restart the dev server. The access token (${t.expiresIn}s) is derived from it automatically.</p>`,
    );
  } catch (e) {
    return page("Snapchat OAuth", `<h2>Exchange failed</h2><p>${esc((e as Error).message)}</p>`, 502);
  }
}
