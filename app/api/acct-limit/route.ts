import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { acctLimitSnapshot } from "@/lib/acct-limit";

export const runtime = "nodejs";

/**
 * GET /api/acct-limit — the live per-account launch-limit picture for the UI (header timer,
 * account-picker badges, launch gates): every account with an ACTIVE 30-min window and its
 * count/resetAt/name. Proxy-gated; self-checks the session too (defense-in-depth, same as the
 * other data routes). Also opportunistically sweeps expired registry rows (bounded, in lib).
 */
export async function GET(req: Request): Promise<NextResponse> {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    const snap = await acctLimitSnapshot();
    return NextResponse.json(
      // `build` = this deployment's build stamp: a client whose inlined stamp differs is a
      // stale tab and must reload before launching (its pre-flight gates are outdated).
      { ok: true, build: process.env.NEXT_PUBLIC_BUILD_STAMP ?? "", ...snap },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message ?? String(e) }, { status: 502 });
  }
}
