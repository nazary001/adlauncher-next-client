import { NextResponse } from "next/server";
import { moSocNames, moSocStatuses } from "@/lib/mo-soc";
import { sessionFromCookieHeader } from "@/lib/session";

export const runtime = "nodejs";

/**
 * GET /api/mo-socs
 *
 * The provisioned MO soc launch channels (FB_MO_SOC_TOKENS) — feeds the board's System-token ↔
 * soc switch. `socs` = names (legacy shape, keeps mid-deploy tabs honoring their pick);
 * `statuses` = the same socs with a LIVE token verdict (tiny cached `/me` probe) so the switch
 * can show WHY a dead soc's catalogs come back empty (e.g. "(#190/452) session invalidated" =
 * re-issue that token) instead of a silent empty picker. Tokens never leave the server. Gated
 * by the proxy; an empty list simply hides the switch client-side.
 */
export async function GET(req: Request) {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ ok: true, socs: moSocNames(), statuses: await moSocStatuses() });
}
