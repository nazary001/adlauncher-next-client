import { NextResponse } from "next/server";
import { FbError, advertisablePages, hasFbToken, pageAdCounts } from "@/lib/fb-graph";
import { partnerConfig } from "@/lib/partners";

export const runtime = "nodejs";

/**
 * GET /api/fanpages
 *
 * Fanpages the launch token can advertise with (system-user pages carrying the ADVERTISE task),
 * each with its live "ads running or in review" count (adCount; null = count unavailable — the
 * per-page ads_volume sweep is cached server-side, see lib/fb-graph). Feeds the fanka picker on
 * the launcher and the clone board; the launch/clone routes validate the picked id against the
 * same page list. Gated by the proxy (session required).
 *
 * Degrades quietly (ok:false, 200) when the token is absent so the picker just renders empty;
 * real API failures return their mapped status (429 rate-limited / 502 otherwise).
 */
export async function GET() {
  if (!hasFbToken()) return NextResponse.json({ ok: false, reason: "no_token", pages: [] });
  try {
    const pages = await advertisablePages();
    // Volume is account-scoped in the API; the Indians flow runs one pinned account today.
    const accountId = (partnerConfig("in").lockedAccount?.id ?? "").replace(/^act_/, "");
    let counts: Map<string, number | null> | null = null;
    if (accountId) {
      try {
        counts = await pageAdCounts(accountId, pages.map((p) => p.id));
      } catch {
        counts = null; // counts are decoration — never fail the page list over them
      }
    }
    return NextResponse.json({
      ok: true,
      pages: pages.map((p) => ({ id: p.id, name: p.name, adCount: counts?.get(p.id) ?? null })),
    });
  } catch (e) {
    const err = e as FbError;
    return NextResponse.json(
      { ok: false, reason: "api", error: err.message ?? String(e), pages: [] },
      { status: err.status === 429 ? 429 : 502 },
    );
  }
}
