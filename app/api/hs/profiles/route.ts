import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { hsTokenConfigured } from "@/lib/hs-token-launch";
import { LION_ACR, lionConfigured, lionProfiles } from "@/lib/lion";

export const runtime = "nodejs";
// Bounded upstreams (LION 60s x2 / Graph 15s) — cap the function so an abandoned poll can
// never idle a long serverless window (the client gives up at 20s).
export const maxDuration = 60;

/** LION profiles the token can launch on, plus the token's ACR (the card needs it for the live
 *  campaign-name prefix). Slugs only — profile display names arrive double-encoded from LION.
 *  `tokenLaunch` tells the board whether the FB Token rail is provisioned server-side — the
 *  channel switch renders disabled without it. */
export async function GET(req: Request): Promise<NextResponse> {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!lionConfigured()) {
    return NextResponse.json({ ok: false, error: "lion_not_configured" }, { status: 500 });
  }
  try {
    const profiles = await lionProfiles();
    return NextResponse.json({ ok: true, acr: LION_ACR, profiles, tokenLaunch: hsTokenConfigured() });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 502 });
  }
}
