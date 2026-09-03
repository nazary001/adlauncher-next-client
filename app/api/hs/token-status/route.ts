import { NextResponse } from "next/server";
import { hsDupTokenConfigured, hsProbeDupToken, hsProbeTokenHealth, hsTokenConfigured } from "@/lib/hs-token-launch";
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
 * `dup` = the DUPLICATE/JURO rails' signer (dedicated FB_HS_DUP_TOKEN since 09-03, else the
 * pool's active token) — powers the cloner's "signs as …" badge. Tokens never leave the
 * server — the widget sees fingerprints only.
 */
export async function GET(req: Request) {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!hsTokenConfigured() && !hsDupTokenConfigured()) {
    return NextResponse.json({ ok: true, now: Date.now(), tokens: [], dup: null });
  }
  try {
    const tokens = hsTokenConfigured() ? await hsProbeTokenHealth() : [];
    const dup = await hsProbeDupToken();
    return NextResponse.json({ ok: true, now: Date.now(), tokens, dup });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message ?? e), tokens: [] }, { status: 502 });
  }
}
