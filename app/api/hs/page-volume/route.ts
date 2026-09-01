import { NextResponse } from "next/server";
import { LionError, lionConfigured, lionPageAdCounts } from "@/lib/lion";
import { hsPageAdCounts } from "@/lib/hs-page-volume";
import { hsPagesConfigured, hsToolsPageStats } from "@/lib/hs-pages";
import { sessionFromCookieHeader } from "@/lib/session";

export const runtime = "nodejs";
// The keyless-fallback path is LION's full metrics payload (multi-MB, routinely laggy) PLUS a
// ~220-call Graph ads_volume sweep — keep the headroom; registry reads answer instantly and the
// registry path's tally gap-fill is one cached metrics reduce.
export const maxDuration = 120;

/**
 * GET /api/hs/page-volume
 *
 * Fill data per HS fanpage — the "N/limit" badge feed. SOURCE OF TRUTH: the hs-tools pages
 * registry (mode "registry"): the box's own checker reads Meta's real used/limit per page across
 * the whole pool, and every adlauncher launch/duplicate reports its taken slots back, so the
 * numbers move immediately between the box's sweeps. `counts` = used per page id, `limits` = the
 * page's real ceiling.
 *
 * REGISTRY GAP-FILL (probed live 09-01): the box tracks NONE of the current glo-* profile pages
 * (243 registry rows, 0 of glo-01-11's 21), and the volume tokens can't ads_volume them either
 * ("Unsupported request" — outside their businesses), so registry-only left the whole GLO pool
 * untagged and gate-free. Pages the registry misses are filled from the LION metrics tally
 * (every ACTIVE campaign's ads per page_id — APPROXIMATE: counts dead ads inside still-ACTIVE
 * campaigns, so it overcounts, which errs in the safe direction) and listed in `approx` so the
 * client renders them as "~N/limit". `tallied: true` says the tally landed — a page absent from
 * BOTH is then "~0" (the whole team runs nothing active there), the old legacy-feed contract.
 * Registry numbers always win; the moment the box learns a page, its real meter replaces the
 * tally estimate. A LION hiccup degrades to the plain registry slice (absent = unknown).
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
      const names: Record<string, string> = {};
      for (const [id, s] of Object.entries(stats)) {
        counts[id] = s.used;
        limits[id] = s.limit;
        if (s.name) names[id] = s.name;
      }
      const approx: string[] = [];
      let tallied = false;
      if (lionConfigured()) {
        try {
          const tally = await lionPageAdCounts();
          tallied = true;
          for (const [id, n] of Object.entries(tally)) {
            if (!(id in counts)) {
              counts[id] = n;
              approx.push(id);
            }
          }
        } catch {
          /* LION hiccup — the registry slice alone still answers */
        }
      }
      return NextResponse.json({ ok: true, mode: "registry", counts, limits, names, approx, tallied });
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
