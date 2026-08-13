import { NextResponse } from "next/server";
import { LionError, lionConfigured, lionPageAdCounts } from "@/lib/lion";
import { sessionFromCookieHeader } from "@/lib/session";

export const runtime = "nodejs";
// The cold read behind this is LION's full metrics payload (multi-MB, routinely laggy) — give
// it headroom beyond the default function timeout; warm calls answer from the 10-min cache.
export const maxDuration = 60;

/**
 * GET /api/hs/page-volume
 *
 * Active-ads count per HS fanpage — the "N/250" fill badge feed, mirroring MO's
 * /api/fanpages/volume. Counts are one global map (the profiles are mirrors of one page pool),
 * tallied from today's LION metrics (see lionPageAdCounts). A page absent from the map has 0
 * counted ads — the client tags it "0/limit", it does not mean unknown.
 */
export async function GET(req: Request) {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!lionConfigured()) return NextResponse.json({ ok: false, reason: "no_token", counts: {} });
  try {
    const counts = await lionPageAdCounts();
    return NextResponse.json({ ok: true, counts });
  } catch (e) {
    const err = e as LionError;
    return NextResponse.json(
      { ok: false, reason: "api", error: err.message ?? String(e), counts: {} },
      { status: 502 },
    );
  }
}
