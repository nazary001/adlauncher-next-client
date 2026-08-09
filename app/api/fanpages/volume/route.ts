import { NextResponse } from "next/server";
import { FbError, advertisablePages, hasFbToken, pageAdCounts } from "@/lib/fb-graph";
import { partnerConfig } from "@/lib/partners";

export const runtime = "nodejs";
// The cold sweep is ~60 sequential-ish Graph reads (6-way pool) — give it headroom beyond the
// default function timeout; warm calls answer from the 15-min cache instantly.
export const maxDuration = 60;

/**
 * GET /api/fanpages/volume
 *
 * Live "ads running or in review" count per token fanpage — the page's CROSS-ACCOUNT total, the
 * number the 250/page limit meters. Split from /api/fanpages because the per-page sweep is slow
 * (one ads_volume call per page, cached 15 min server-side): the picker renders the page list
 * instantly and decorates it with these counts when they arrive. Gated by the proxy.
 */
export async function GET() {
  if (!hasFbToken()) return NextResponse.json({ ok: false, reason: "no_token", counts: {} });
  try {
    const pages = await advertisablePages();
    // The count is the page's CROSS-account total, so any token account works for the sweep — use
    // the partner's default account. (Was lockedAccount, removed in the 08-08 account-picker
    // migration → this route silently returned no_account and killed every fill badge.)
    const accountId = (partnerConfig("in").defaultAccount?.id ?? "").replace(/^act_/, "");
    if (!accountId) return NextResponse.json({ ok: false, reason: "no_account", counts: {} });
    const counts = await pageAdCounts(accountId, pages.map((p) => p.id));
    return NextResponse.json({ ok: true, counts: Object.fromEntries(counts) });
  } catch (e) {
    const err = e as FbError;
    return NextResponse.json(
      { ok: false, reason: "api", error: err.message ?? String(e), counts: {} },
      { status: err.status === 429 ? 429 : 502 },
    );
  }
}
