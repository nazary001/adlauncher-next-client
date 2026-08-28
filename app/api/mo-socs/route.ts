import { NextResponse } from "next/server";
import { moSocNames } from "@/lib/mo-soc";
import { sessionFromCookieHeader } from "@/lib/session";

export const runtime = "nodejs";

/**
 * GET /api/mo-socs
 *
 * Names of the provisioned MO soc launch channels (FB_MO_SOC_TOKENS) — feeds the board's
 * System-token ↔ soc switch. Names only, tokens never leave the server. Gated by the proxy;
 * an empty list simply hides the switch client-side.
 */
export async function GET(req: Request) {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ ok: true, socs: moSocNames() });
}
