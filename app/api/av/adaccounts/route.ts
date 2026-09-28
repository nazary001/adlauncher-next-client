import { NextResponse } from "next/server";
import { FbError } from "@/lib/fb-graph";
import { avRail, avRailEnabled } from "@/lib/av-launch";
import { railParam } from "@/lib/mo-soc";
import { filterAccountsFor } from "@/lib/acct-assignments";
import { sessionFromCookieHeader } from "@/lib/session";

export const runtime = "nodejs";
// Cold refresh = paginated account list; warm calls answer from the shared cache instantly. AV
// accounts carry no pixel list (the AV page has none — Traffic / link clicks only).
export const maxDuration = 60;

/**
 * GET /api/av/adaccounts[?rail=launch|clone]
 *
 * ACTIVE ad accounts the AV token can use — feeds the account picker on the AV launcher / clone
 * board. The launch route validates the picked account against the same server-cached data. Gated
 * by the proxy + the rail flag. `rail` picks the owner's launch or clone token (/tokens) — the
 * picker shows exactly what the bearer that will build can use. `pixels` is omitted (AV never binds
 * a pixel).
 *
 * Degrades quietly (ok:false, 200) when no token is assigned; real API failures return their mapped
 * status (429 rate-limited / 502 otherwise).
 */
export async function GET(req: Request) {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!avRailEnabled()) {
    return NextResponse.json({ ok: false, error: "av_rail_disabled" }, { status: 404 });
  }
  const r = await avRail(railParam(new URL(req.url).searchParams.get("rail")));
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
