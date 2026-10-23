import { NextResponse } from "next/server";
import { FbError } from "@/lib/fb-graph";
import { vcRail, vcRailEnabled } from "@/lib/vc-launch";
import { railParam } from "@/lib/mo-soc";
import { filterAccountsFor } from "@/lib/acct-assignments";
import { sessionFromCookieHeader } from "@/lib/session";

export const runtime = "nodejs";
// Cold refresh = paginated account list + one pixels call per account; warm calls answer from the
// shared cache instantly.
export const maxDuration = 60;

/**
 * GET /api/vc/adaccounts[?rail=launch|clone]
 *
 * ACTIVE ad accounts the VC token can use, each with its pixel list — feeds the account picker on the
 * VC launcher board (the card warns when VC_PIXEL is not shared to the picked cabinet). The launch
 * route validates the picked account against the same server-cached data. Gated by the proxy + the
 * team. `rail` picks the owner's launch or clone token (/tokens).
 *
 * Degrades quietly (ok:false, 200) when no token is assigned; real API failures return their mapped
 * status (429 rate-limited / 502 otherwise).
 */
export async function GET(req: Request) {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!vcRailEnabled()) {
    return NextResponse.json({ ok: false, error: "vc_rail_disabled" }, { status: 404 });
  }
  const r = await vcRail(railParam(new URL(req.url).searchParams.get("rail")));
  if (!r.ok) return NextResponse.json({ ok: false, reason: "no_token", error: r.error, accounts: [] });
  try {
    // Owner assignments: a non-owner sees only accounts assigned to them (unassigned = shared).
    const accounts = await filterAccountsFor(session, await r.rail.tokenAdAccounts(), (a) => a.id);
    return NextResponse.json({ ok: true, accounts, signer: r.rail.label });
  } catch (e) {
    const err = e as FbError;
    return NextResponse.json(
      { ok: false, reason: "api", error: err.message ?? String(e), accounts: [] },
      { status: err.status === 429 ? 429 : 502 },
    );
  }
}
