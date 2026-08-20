import { NextResponse } from "next/server";
import { hsPagesConfigured, hsToolsPageStats } from "@/lib/hs-pages";
import { sessionFromCookieHeader } from "@/lib/session";

export const runtime = "nodejs";

/**
 * GET /api/aif/fanpages/volume
 *
 * Fill data per AIF fanpage from the hs-tools pages registry (/aif scope) — same contract as
 * /api/fanpages/volume in registry mode. The scope is EMPTY until the box starts syncing AIF
 * pages, so this answers ok with zero counts (pickers just render untagged) and lights up by
 * itself the day the sync lands. AIF has no legacy sweep — keyless answers ok:false, no badges.
 */
export async function GET(req: Request) {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!hsPagesConfigured()) return NextResponse.json({ ok: false, reason: "no_key", counts: {} });
  try {
    const stats = await hsToolsPageStats("us");
    const counts: Record<string, number> = {};
    const limits: Record<string, number> = {};
    for (const [id, s] of Object.entries(stats)) {
      counts[id] = s.used;
      limits[id] = s.limit;
    }
    return NextResponse.json({ ok: true, mode: "registry", counts, limits });
  } catch (e) {
    return NextResponse.json(
      { ok: false, reason: "registry", error: (e as Error).message ?? String(e), counts: {} },
      { status: 502 },
    );
  }
}
