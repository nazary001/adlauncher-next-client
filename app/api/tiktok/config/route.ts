import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { TIKTOK_ADVERTISER_ID_RE } from "@/lib/tiktok-launch";
import { TiktokWeaponError, tiktokRailEnabled, tiktokWeaponConfigured, twAdvertiserConfig } from "@/lib/tiktok-weapon";
import { tiktokLaunchableAdvertisers } from "@/lib/tiktok-wave";

export const runtime = "nodejs";
// One cached upstream read per advertiser (twAdvertiserConfig 10-min cache).
export const maxDuration = 30;

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

/**
 * GET ?advertiser=<id> → that advertiser's launch config: pixels (with the modes each can run),
 * targetable countries and languages. Only launchable advertisers are answered — the same
 * predicate the pickers and the wave routes use.
 */
export async function GET(req: Request): Promise<NextResponse> {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) return bad("unauthorized", 401);
  if (!tiktokRailEnabled()) return bad("tiktok_rail_disabled", 404);
  if (!tiktokWeaponConfigured()) return bad("tiktok_weapon_not_configured", 500);
  const advertiserId = (new URL(req.url).searchParams.get("advertiser") ?? "").trim();
  if (!TIKTOK_ADVERTISER_ID_RE.test(advertiserId)) return bad("advertiser_required");
  try {
    const launchable = await tiktokLaunchableAdvertisers();
    if (!launchable.some((a) => a.advertiserId === advertiserId)) return bad(`advertiser ${advertiserId} is not launch-eligible on LION`, 403);
    return NextResponse.json({ ok: true, config: await twAdvertiserConfig(advertiserId) });
  } catch (e) {
    const st = e instanceof TiktokWeaponError ? e.status : undefined;
    return bad((e as Error).message, st === 401 || st === 403 ? st : 502);
  }
}
