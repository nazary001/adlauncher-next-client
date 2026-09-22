import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { GoogleWeaponError, googleRailEnabled, googleWeaponConfigured, gwLaunchCatalog } from "@/lib/google-weapon";
import { LION_ACR } from "@/lib/lion";

export const runtime = "nodejs";
// Two cached upstream reads side by side (gwCustomers + LION's account statuses, 10 min each; the
// status read gives up after 9 s and fails open) — a tight cap is plenty.
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
    // The owner's active GLO-HS list only (21.09), minus the accounts Google has suspended — the
    // pickers never see the rest. `suspended` names what was hidden so the board can say so.
    const { customers, suspended } = await gwLaunchCatalog();
    // `acr` = the LION user's media-buyer acronym: LION stamps it (lower-cased) as mb=/utm on
    // every Google link — the board previews the final link with it.
    return NextResponse.json({ ok: true, customers, suspended, acr: LION_ACR.toLowerCase() });
  } catch (e) {
    // A partner 401 (bad bearer) surfaces as 401; anything else is an upstream failure (502).
    const status = e instanceof GoogleWeaponError && e.status === 401 ? 401 : 502;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
  }
}
