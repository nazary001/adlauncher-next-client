import { NextResponse } from "next/server";
import { FbError, advertisablePages, hasFbToken } from "@/lib/fb-graph";

export const runtime = "nodejs";

/**
 * GET /api/fanpages
 *
 * Fanpages the launch token can advertise with (system-user pages carrying the ADVERTISE task).
 * Feeds the fanka picker on the launcher and the clone board; the launch/clone routes validate
 * the picked id against the same (server-cached) list. Gated by the proxy (session required).
 *
 * Degrades quietly (ok:false, 200) when the token is absent so the picker just renders empty;
 * real API failures return their mapped status (429 rate-limited / 502 otherwise).
 */
export async function GET() {
  if (!hasFbToken()) return NextResponse.json({ ok: false, reason: "no_token", pages: [] });
  try {
    const pages = await advertisablePages();
    return NextResponse.json({ ok: true, pages });
  } catch (e) {
    const err = e as FbError;
    return NextResponse.json(
      { ok: false, reason: "api", error: err.message ?? String(e), pages: [] },
      { status: err.status === 429 ? 429 : 502 },
    );
  }
}
