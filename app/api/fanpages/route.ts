import { NextResponse } from "next/server";
import { FbError, advertisablePages, hasFbToken } from "@/lib/fb-graph";

export const runtime = "nodejs";

/**
 * GET /api/fanpages
 *
 * Fanpages the launch token can advertise with (system-user pages carrying the ADVERTISE task).
 * Deliberately FAST — one cached Graph call, no volume data: the picker must open instantly.
 * Per-page fill counts are a separate, slower call (GET /api/fanpages/volume) the client merges
 * in afterwards. The launch/clone routes validate the picked id against the same page list.
 * Gated by the proxy (session required).
 *
 * Degrades quietly (ok:false, 200) when the token is absent so the picker just renders empty;
 * real API failures return their mapped status (429 rate-limited / 502 otherwise).
 */
export async function GET() {
  if (!hasFbToken()) return NextResponse.json({ ok: false, reason: "no_token", pages: [] });
  try {
    const pages = await advertisablePages();
    return NextResponse.json({ ok: true, pages });
  } catch (e) {
    const err = e as FbError;
    return NextResponse.json(
      { ok: false, reason: "api", error: err.message ?? String(e), pages: [] },
      { status: err.status === 429 ? 429 : 502 },
    );
  }
}
