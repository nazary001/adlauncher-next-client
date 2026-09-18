import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { TiktokWeaponError, tiktokLiveLaunchAllowed, tiktokRailEnabled, tiktokWeaponConfigured } from "@/lib/tiktok-weapon";
import { tiktokLaunchableAdvertisers } from "@/lib/tiktok-wave";
import { LION_ACR } from "@/lib/lion";

export const runtime = "nodejs";
// One cached upstream read (twAdvertisers 10-min cache) — a tight cap is plenty.
export const maxDuration = 30;

/**
 * GET → the TikTok advertisers the LION user may launch on NOW (tiktok-weapon `/advertisers/`
 * filtered to `launch_eligible`, cached 10 min in the client). Powers every advertiser picker.
 * Read-only; a 502 carries the partner's sentence so the board can retry with a clear reason.
 * `liveLaunch:false` tells the board this instance can read the live partner but won't fire at it.
 */
export async function GET(req: Request): Promise<NextResponse> {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!tiktokRailEnabled()) return NextResponse.json({ ok: false, error: "tiktok_rail_disabled" }, { status: 404 });
  if (!tiktokWeaponConfigured()) return NextResponse.json({ ok: false, error: "tiktok_weapon_not_configured" }, { status: 500 });
  try {
    const advertisers = await tiktokLaunchableAdvertisers();
    // `acr` = the LION user's media-buyer acronym: LION prints it in every campaign name and
    // stamps it (lower-cased) as mb= on every link — the board previews both with it.
    return NextResponse.json({ ok: true, advertisers, acr: LION_ACR.toLowerCase(), liveLaunch: tiktokLiveLaunchAllowed() });
  } catch (e) {
    // A partner 401 (bad bearer) surfaces as 401; anything else is an upstream failure (502).
    const status = e instanceof TiktokWeaponError && e.status === 401 ? 401 : 502;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
  }
}
