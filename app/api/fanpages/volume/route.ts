import { NextResponse } from "next/server";
import { FbError, advertisablePages, hasFbToken, pageAdCounts } from "@/lib/fb-graph";
import { hsPagesConfigured, hsToolsPageStats } from "@/lib/hs-pages";
import { partnerConfig } from "@/lib/partners";
import { sessionFromCookieHeader } from "@/lib/session";

export const runtime = "nodejs";
// The keyless-fallback sweep is ~60 sequential-ish Graph reads (6-way pool) — give it headroom
// beyond the default function timeout; registry reads and warm calls answer instantly.
export const maxDuration = 60;

/**
 * GET /api/fanpages/volume
 *
 * Fill data per MO fanpage for the picker badges. SOURCE OF TRUTH: the hs-tools pages registry
 * (mode "registry" — real used AND per-page limit from the box's own Meta sweep; adlauncher also
 * reports its launches there, so the numbers move the moment a wave lands). `counts` carries
 * used per page id, `limits` the page's real ceiling; a page ABSENT from counts is UNKNOWN to
 * the registry (has_data:false) — the client leaves it untagged rather than painting 0/250.
 *
 * KILL SWITCH: without HS_PAGES_API_KEY the route serves the legacy Graph ads_volume sweep
 * (mode "legacy", absent = null = still sweeping) — exactly the pre-registry behaviour.
 */
export async function GET(req: Request) {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  if (hsPagesConfigured()) {
    try {
      const stats = await hsToolsPageStats("in");
      const counts: Record<string, number> = {};
      const limits: Record<string, number> = {};
      for (const [id, s] of Object.entries(stats)) {
        counts[id] = s.used;
        limits[id] = s.limit;
      }
      return NextResponse.json({ ok: true, mode: "registry", counts, limits });
    } catch (e) {
      // Registry unreachable → no badges this poll; the client re-asks on its own cadence.
      return NextResponse.json(
        { ok: false, reason: "registry", error: (e as Error).message ?? String(e), counts: {} },
        { status: 502 },
      );
    }
  }

  if (!hasFbToken()) return NextResponse.json({ ok: false, reason: "no_token", counts: {} });
  try {
    const pages = await advertisablePages();
    // The count is the page's CROSS-account total, so any token account works for the sweep — use
    // the partner's default account. (Was lockedAccount, removed in the 08-08 account-picker
    // migration → this route silently returned no_account and killed every fill badge.)
    const accountId = (partnerConfig("in").defaultAccount?.id ?? "").replace(/^act_/, "");
    if (!accountId) return NextResponse.json({ ok: false, reason: "no_account", counts: {} });
    const counts = await pageAdCounts(accountId, pages.map((p) => p.id));
    return NextResponse.json({ ok: true, mode: "legacy", counts: Object.fromEntries(counts) });
  } catch (e) {
    const err = e as FbError;
    return NextResponse.json(
      { ok: false, reason: "api", error: err.message ?? String(e), counts: {} },
      { status: err.status === 429 ? 429 : 502 },
    );
  }
}
