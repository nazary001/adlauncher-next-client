import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { GoogleWeaponError, googleRailEnabled, googleWeaponConfigured, gwCustomers } from "@/lib/google-weapon";
import { LION_ACR } from "@/lib/lion";

export const runtime = "nodejs";
// One cached upstream read (gwCustomers 10-min cache) — a tight cap is plenty.
export const maxDuration = 30;

/**
 * GET → the Google Ads accounts the LION user may launch on (google-weapon `/customers/`, cached
 * 10 min in the client). Powers the target-account picker and pixel policy on the Google board.
 * Read-only; a 502 carries the partner's sentence so the board can retry with a clear reason.
 */
export async function GET(req: Request): Promise<NextResponse> {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!googleRailEnabled()) return NextResponse.json({ ok: false, error: "google_rail_disabled" }, { status: 404 });
  if (!googleWeaponConfigured()) {
    return NextResponse.json({ ok: false, error: "google_weapon_not_configured" }, { status: 500 });
  }
  try {
    const customers = await gwCustomers();
    // `acr` = the LION user's media-buyer acronym: LION stamps it (lower-cased) as mb=/utm on
    // every Google link — the board previews the final link with it.
    return NextResponse.json({ ok: true, customers, acr: LION_ACR.toLowerCase() });
  } catch (e) {
    // A partner 401 (bad bearer) surfaces as 401; anything else is an upstream failure (502).
    const status = e instanceof GoogleWeaponError && e.status === 401 ? 401 : 502;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
  }
}
