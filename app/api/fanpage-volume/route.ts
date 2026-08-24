import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";

export const runtime = "nodejs";
// One 15s-bounded Graph read — the function itself gets a matching hard cap.
export const maxDuration = 30;

// Server-only: the FB launch token never reaches the browser.
const TOKEN = process.env.FB_LAUNCH_TOKEN ?? "";
const VER = "v21.0";

/**
 * GET /api/fanpage-volume?account=<digits>
 *
 * Live "ads running or in review" count from the Graph API `ads_volume` edge of the ad
 * account. Meta enforces an ad limit per Page (default tier 250); for the Indians flow —
 * one account bound to one fanpage — this account-scoped count equals the fanpage's usage
 * against that limit. The API returns the count but NOT the numeric ceiling, so the limit
 * is a UI-side constant (`partner.pageAdLimit`).
 *
 * Degrades quietly (ok:false, 200) when the token is absent so the field just renders
 * without a badge; real API/transport failures return 4xx/5xx.
 */
export async function GET(req: Request) {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!TOKEN) return NextResponse.json({ ok: false, reason: "no_token" });

  const account = new URL(req.url).searchParams.get("account") ?? "";
  if (!/^\d{5,}$/.test(account)) {
    return NextResponse.json({ ok: false, reason: "bad_account" }, { status: 400 });
  }

  try {
    const res = await fetch(
      `https://graph.facebook.com/${VER}/act_${account}/ads_volume?fields=ads_running_or_in_review_count`,
      { headers: { Authorization: `Bearer ${TOKEN}` }, cache: "no-store", signal: AbortSignal.timeout(15_000) },
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, reason: "api", status: res.status, error: body?.error?.message ?? null },
        { status: 502 },
      );
    }
    const count = body?.data?.[0]?.ads_running_or_in_review_count;
    if (typeof count !== "number") {
      return NextResponse.json({ ok: false, reason: "no_data" });
    }
    return NextResponse.json({ ok: true, count });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: "fetch", error: String(e) }, { status: 502 });
  }
}
