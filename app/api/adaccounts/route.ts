import { NextResponse } from "next/server";
import { FbError, hasFbToken, tokenAdAccounts } from "@/lib/fb-graph";

export const runtime = "nodejs";
// Cold refresh = paginated account list + one pixels call per account; warm calls answer from
// the shared cache instantly.
export const maxDuration = 60;

/**
 * GET /api/adaccounts
 *
 * ACTIVE ad accounts the launch token can use, each with its pixel list — feeds the account
 * picker (and its per-account pixel picker) on the launcher. The launch route validates the
 * picked account/pixel against the same server-cached data. Gated by the proxy.
 *
 * Degrades quietly (ok:false, 200) when the token is absent; real API failures return their
 * mapped status (429 rate-limited / 502 otherwise).
 */
export async function GET() {
  if (!hasFbToken()) return NextResponse.json({ ok: false, reason: "no_token", accounts: [] });
  try {
    const accounts = await tokenAdAccounts();
    return NextResponse.json({ ok: true, accounts });
  } catch (e) {
    const err = e as FbError;
    return NextResponse.json(
      { ok: false, reason: "api", error: err.message ?? String(e), accounts: [] },
      { status: err.status === 429 ? 429 : 502 },
    );
  }
}
