import { NextResponse } from "next/server";
import { FbError } from "@/lib/fb-graph";
import { aifTokenAdAccounts, aifTokenConfigured } from "@/lib/aif-launch";
import { sessionFromCookieHeader } from "@/lib/session";

export const runtime = "nodejs";
// Cold refresh = paginated account list + one pixels call per account; warm calls answer from
// the shared cache instantly.
export const maxDuration = 60;

/**
 * GET /api/aif/adaccounts
 *
 * ACTIVE ad accounts the AIF token can use, each with its pixel list — feeds the account picker
 * on the AIF launcher. The launch route validates the picked account against the same
 * server-cached data. Gated by the proxy.
 *
 * Degrades quietly (ok:false, 200) when the token is absent; real API failures return their
 * mapped status (429 rate-limited / 502 otherwise).
 */
export async function GET(req: Request) {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!aifTokenConfigured()) return NextResponse.json({ ok: false, reason: "no_token", accounts: [] });
  try {
    const accounts = await aifTokenAdAccounts();
    return NextResponse.json({ ok: true, accounts });
  } catch (e) {
    const err = e as FbError;
    return NextResponse.json(
      { ok: false, reason: "api", error: err.message ?? String(e), accounts: [] },
      { status: err.status === 429 ? 429 : 502 },
    );
  }
}
