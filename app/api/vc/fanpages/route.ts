import { NextResponse } from "next/server";
import { FbError } from "@/lib/fb-graph";
import { vcRail, vcRailEnabled } from "@/lib/vc-launch";
import { railParam } from "@/lib/mo-soc";
import { sessionFromCookieHeader } from "@/lib/session";

export const runtime = "nodejs";

/**
 * GET /api/vc/fanpages[?rail=launch|clone]
 *
 * Fanpages the VC token can advertise with (pages carrying the ADVERTISE task). One cached Graph
 * call, no volume data. The launch route validates the picked id against the same page list. Gated by
 * the proxy + the team. `rail` picks the owner's launch or clone token (/tokens).
 *
 * Degrades quietly (ok:false, 200) when no token is assigned so the picker just renders empty; real
 * API failures return their mapped status (429 rate-limited / 502 otherwise).
 */
export async function GET(req: Request) {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!vcRailEnabled()) {
    return NextResponse.json({ ok: false, error: "vc_rail_disabled" }, { status: 404 });
  }
  const r = await vcRail(railParam(new URL(req.url).searchParams.get("rail")));
  if (!r.ok) return NextResponse.json({ ok: false, reason: "no_token", error: r.error, pages: [] });
  try {
    const pages = await r.rail.advertisablePages();
    return NextResponse.json({ ok: true, pages, signer: r.rail.label });
  } catch (e) {
    const err = e as FbError;
    return NextResponse.json(
      { ok: false, reason: "api", error: err.message ?? String(e), pages: [] },
      { status: err.status === 429 ? 429 : 502 },
    );
  }
}
