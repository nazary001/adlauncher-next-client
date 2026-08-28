import { NextResponse } from "next/server";
import { FbError, advertisablePages, hasFbToken } from "@/lib/fb-graph";
import { resolveMoChannel } from "@/lib/mo-soc";
import { sessionFromCookieHeader } from "@/lib/session";

export const runtime = "nodejs";

/**
 * GET /api/fanpages[?channel=soc:<name>]
 *
 * Fanpages the launch token can advertise with (pages carrying the ADVERTISE task).
 * Deliberately FAST — one cached Graph call, no volume data: the picker must open instantly.
 * Per-page fill counts are a separate, slower call (GET /api/fanpages/volume) the client merges
 * in afterwards. The launch/clone routes validate the picked id against the same page list.
 * Gated by the proxy (session required).
 *
 * `channel` picks the signer the page catalog is read from: absent/system = the MO system-user
 * token, `soc:<name>` = that personal token from FB_MO_SOC_TOKENS (its me/accounts — the pages
 * that соц manages with the ADVERTISE task; own cache identity).
 *
 * Degrades quietly (ok:false, 200) when the token is absent so the picker just renders empty;
 * real API failures return their mapped status (429 rate-limited / 502 otherwise).
 */
export async function GET(req: Request) {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const channel = resolveMoChannel(new URL(req.url).searchParams.get("channel"));
  if (!channel) return NextResponse.json({ ok: false, reason: "channel_unknown", pages: [] });
  if (channel.kind === "system" && !hasFbToken()) {
    return NextResponse.json({ ok: false, reason: "no_token", pages: [] });
  }
  try {
    const pages = await advertisablePages(channel.kind === "soc" ? channel.cat : undefined);
    return NextResponse.json({ ok: true, pages });
  } catch (e) {
    const err = e as FbError;
    return NextResponse.json(
      { ok: false, reason: "api", error: err.message ?? String(e), pages: [] },
      { status: err.status === 429 ? 429 : 502 },
    );
  }
}
