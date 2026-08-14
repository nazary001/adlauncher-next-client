import { NextResponse } from "next/server";
import { LionError, lionConfigured } from "@/lib/lion";
import { hsPageAdCounts } from "@/lib/hs-page-volume";
import { sessionFromCookieHeader } from "@/lib/session";

export const runtime = "nodejs";
// The cold path is LION's full metrics payload (multi-MB, routinely laggy) PLUS a ~220-call
// Graph ads_volume sweep — give it headroom; warm calls answer from the caches instantly.
export const maxDuration = 120;

/**
 * GET /api/hs/page-volume
 *
 * Fill count per HS fanpage — the "N/250" badge feed, mirroring MO's /api/fanpages/volume.
 * Counts are one global map (the profiles are mirrors of one page pool): Meta's real
 * ads-running-or-in-review meter where the partner-side token can read it, LION metrics tally
 * as the fallback (see lib/hs-page-volume). A page absent from the map has 0 counted ads —
 * the client tags it "0/limit", it does not mean unknown.
 */
export async function GET(req: Request) {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!lionConfigured()) return NextResponse.json({ ok: false, reason: "no_token", counts: {} });
  try {
    const counts = await hsPageAdCounts();
    return NextResponse.json({ ok: true, counts });
  } catch (e) {
    const err = e as LionError;
    return NextResponse.json(
      { ok: false, reason: "api", error: err.message ?? String(e), counts: {} },
      { status: 502 },
    );
  }
}
