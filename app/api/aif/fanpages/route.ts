import { NextResponse } from "next/server";
import { FbError } from "@/lib/fb-graph";
import { aifAdvertisablePages, aifTokenConfigured } from "@/lib/aif-launch";
import { sessionFromCookieHeader } from "@/lib/session";

export const runtime = "nodejs";

/**
 * GET /api/aif/fanpages
 *
 * Fanpages the AIF token can advertise with (pages carrying the ADVERTISE task). One cached
 * Graph call, no volume data (AIF v1 ships without the N/limit fill badges). The launch route
 * validates the picked id against the same page list. Gated by the proxy.
 *
 * Degrades quietly (ok:false, 200) when the token is absent so the picker just renders empty;
 * real API failures return their mapped status (429 rate-limited / 502 otherwise).
 */
export async function GET(req: Request) {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!aifTokenConfigured()) return NextResponse.json({ ok: false, reason: "no_token", pages: [] });
  try {
    const pages = await aifAdvertisablePages();
    return NextResponse.json({ ok: true, pages });
  } catch (e) {
    const err = e as FbError;
    return NextResponse.json(
      { ok: false, reason: "api", error: err.message ?? String(e), pages: [] },
      { status: err.status === 429 ? 429 : 502 },
    );
  }
}
