import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { avRailEnabled } from "@/lib/av-launch";
import { avApiConfigured } from "@/lib/av-api";
import { resolveAvDestination } from "@/lib/av-destination";

export const runtime = "nodejs";
// A resolve = the shape check + one live GET (article), the redirect catalog lookup, or a chat
// host's DNS + ad settings + address; bounded by lib/av-destination's / lib/av-chat's own timeouts.
export const maxDuration = 30;

/**
 * GET /api/av/destinations/check?url=<pasted url>
 *
 * The server's verdict on a single destination the buyer PASTED into the card (the picked catalog
 * entries are pre-validated; this covers a hand-typed URL — and every chat, which no catalog
 * lists): shape → host is an AV site of ours (or one of its redirect domains / its chat subdomain)
 * → an article answers 200 / a redirect path exists and its domain is live / the chat host shows
 * ads and the chat's address answers. `base` comes back canonical (a chat as …/?asst=<id>).
 * Answers with the resolver's own status (400 = the buyer's fix, 502 = ActiveView unreachable).
 * The card shows the verdict before the URL is stored in `c.landing`.
 */
export async function GET(req: Request) {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!avRailEnabled()) {
    return NextResponse.json({ ok: false, error: "av_rail_disabled" }, { status: 404 });
  }
  if (!avApiConfigured()) {
    return NextResponse.json(
      { ok: false, error: "av_not_configured — AV_API_KEY is not set on the server" },
      { status: 500 },
    );
  }
  const url = String(new URL(req.url).searchParams.get("url") ?? "");
  const resolved = await resolveAvDestination(url);
  if (!resolved.ok) {
    return NextResponse.json({ ok: false, error: resolved.error }, { status: resolved.status });
  }
  return NextResponse.json({
    ok: true,
    kind: resolved.kind,
    base: resolved.base,
    site: resolved.site,
    ...(resolved.kind === "redirect" ? { pathId: resolved.pathId } : {}),
  });
}
