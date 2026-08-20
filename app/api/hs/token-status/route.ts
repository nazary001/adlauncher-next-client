import { NextResponse } from "next/server";
import { hsProbeTokenHealth, hsTokenConfigured } from "@/lib/hs-token-launch";
import { sessionFromCookieHeader } from "@/lib/session";

export const runtime = "nodejs";

/**
 * GET /api/hs/token-status
 *
 * Live health of the HS launch-token POOL for the header widget: per token — display identity
 * (user + the FB APP it was issued through; the (#4) limit is app-level so the app is the
 * meaningful label), state (ok / limited / dead), cooldown end, and which one the next launch
 * call would actually use. The probe itself STEERS the failover: it marks a burned token in the
 * shared health row, so the whole serverless fleet skips it without paying retry latency.
 * Tokens never leave the server — the widget sees fingerprints only.
 */
export async function GET(req: Request) {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!hsTokenConfigured()) return NextResponse.json({ ok: true, now: Date.now(), tokens: [] });
  try {
    const tokens = await hsProbeTokenHealth();
    return NextResponse.json({ ok: true, now: Date.now(), tokens });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message ?? e), tokens: [] }, { status: 502 });
  }
}
