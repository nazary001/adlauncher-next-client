import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { tiktokRailEnabled } from "@/lib/tiktok-weapon";
import { lionTokenConfigured } from "@/lib/lion";
import { lionTiktokLandings } from "@/lib/lion-tiktok";

export const runtime = "nodejs";
// Two cached LION metrics days (~1.6 s each cold).
export const maxDuration = 60;

/**
 * GET → the bare landings the team's TikTok campaigns run today and yesterday, most used first.
 * tiktok-weapon publishes its allowed-domain list only inside a 400, so the launcher suggests what
 * is provably allowed instead. Never an error for the board: no LION token / a LION blip → [].
 */
export async function GET(req: Request): Promise<NextResponse> {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!tiktokRailEnabled()) return NextResponse.json({ ok: false, error: "tiktok_rail_disabled" }, { status: 404 });
  if (!lionTokenConfigured()) return NextResponse.json({ ok: true, landings: [] });
  const landings = await lionTiktokLandings(40).catch(() => []);
  return NextResponse.json({ ok: true, landings });
}
