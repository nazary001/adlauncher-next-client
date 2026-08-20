import { NextResponse } from "next/server";
import { LionError, lionConfigured } from "@/lib/lion";
import { hsPageAdCounts } from "@/lib/hs-page-volume";
import { hsPagesConfigured, hsToolsPageStats } from "@/lib/hs-pages";
import { sessionFromCookieHeader } from "@/lib/session";

export const runtime = "nodejs";
// The keyless-fallback path is LION's full metrics payload (multi-MB, routinely laggy) PLUS a
// ~220-call Graph ads_volume sweep — keep the headroom; registry reads answer instantly.
export const maxDuration = 120;

/**
 * GET /api/hs/page-volume
 *
 * Fill data per HS fanpage — the "N/limit" badge feed. SOURCE OF TRUTH: the hs-tools pages
 * registry (mode "registry"): the box's own checker reads Meta's real used/limit per page across
 * the whole pool, and every adlauncher launch/duplicate reports its taken slots back, so the
 * numbers move immediately between the box's sweeps. `counts` = used per page id, `limits` = the
 * page's real ceiling; a page ABSENT from counts is UNKNOWN to the registry — the client leaves
 * it untagged instead of painting "0/250" on a meter nobody has read.
 *
 * KILL SWITCH: without HS_PAGES_API_KEY the route serves the legacy feed (LION metrics tally +
 * partner-token ads_volume sweep, mode "legacy", absent = 0 counted ads — the old contract).
 */
export async function GET(req: Request) {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  if (hsPagesConfigured()) {
    try {
      const stats = await hsToolsPageStats("br");
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

  if (!lionConfigured()) return NextResponse.json({ ok: false, reason: "no_token", counts: {} });
  try {
    const counts = await hsPageAdCounts();
    return NextResponse.json({ ok: true, mode: "legacy", counts });
  } catch (e) {
    const err = e as LionError;
    return NextResponse.json(
      { ok: false, reason: "api", error: err.message ?? String(e), counts: {} },
      { status: 502 },
    );
  }
}
