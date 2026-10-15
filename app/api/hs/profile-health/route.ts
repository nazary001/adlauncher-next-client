import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { lionConfigured, lionProfilesHealth } from "@/lib/lion";

export const runtime = "nodejs";
// The probe reads every team profile's bind space (a few in parallel; each lands in the 10-min
// per-slug cache, so the pickers' own reads are instant afterwards) — give it LION's headroom.
export const maxDuration = 60;

/** Which of the team's LION profiles cannot be read RIGHT NOW, and why — slug → reason. Found on
 *  GLO-01 15.10: a profile whose Facebook user is checkpointed ("log in to www.facebook.com…")
 *  answers no accounts at all, and the pickers showed it as an endless "Loading…". The boards tag
 *  such profiles in the Profile picker and name the reason where the accounts would be. */
export async function GET(req: Request): Promise<NextResponse> {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!lionConfigured()) {
    return NextResponse.json({ ok: false, error: "lion_not_configured" }, { status: 500 });
  }
  try {
    const unreadable = await lionProfilesHealth();
    return NextResponse.json({ ok: true, unreadable });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 502 });
  }
}
