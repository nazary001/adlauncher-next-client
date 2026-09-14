import { NextResponse } from "next/server";
import { FbError, advertisablePages } from "@/lib/fb-graph";
import { railParam, resolveMoSigner } from "@/lib/mo-soc";
import { sessionFromCookieHeader } from "@/lib/session";

export const runtime = "nodejs";

/** MO fanka allowlist — LIFTED 2026-09-10 (owner ask). The MO signer rotated to the Harvmo
 *  system user, whose assigned pages are a DIFFERENT pool than the four vetted 09-01 (Vinn Kora
 *  108537119019318 / Victoria Martin 115090404871945 / Andrea Smith 115569628163613 / Len Lei
 *  156589310871497 — none of which are assigned to Harvmo), so the filtered picker came back
 *  empty. An empty set = NO filter: every page the launch token carries the ADVERTISE task on is
 *  offered (launcher + clone board share this route). Re-add ids here to re-narrow the picker. */
const MO_PAGE_ALLOWLIST = new Set<string>([]);

/**
 * GET /api/fanpages[?rail=launch|clone]
 *
 * Fanpages the MO signer can advertise with (pages carrying the ADVERTISE task).
 * Deliberately FAST — one cached Graph call, no volume data: the picker must open instantly.
 * Per-page fill counts are a separate, slower call (GET /api/fanpages/volume) the client merges
 * in afterwards. The launch/clone routes validate the picked id against the same page list.
 * Gated by the proxy (session required).
 *
 * `rail` picks WHICH MO signer's catalog is read — the owner's assignment on /tokens for
 * launches (launcher board, default) or for clones (clone board): the picker must show exactly
 * the pages the bearer that will build can use (own cache identity per bearer).
 *
 * Degrades quietly (ok:false, 200) when no token is assigned so the picker just renders empty
 * with the reason; real API failures return their mapped status (429 rate-limited / 502 otherwise).
 */
export async function GET(req: Request) {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const signer = await resolveMoSigner(railParam(new URL(req.url).searchParams.get("rail")));
  if (!signer.ok) return NextResponse.json({ ok: false, reason: "no_token", error: signer.error, pages: [] });
  try {
    const pages = await advertisablePages(signer.signer.cat);
    const allowed = MO_PAGE_ALLOWLIST.size ? pages.filter((p) => MO_PAGE_ALLOWLIST.has(String(p.id))) : pages;
    return NextResponse.json({ ok: true, pages: allowed, signer: signer.signer.name });
  } catch (e) {
    const err = e as FbError;
    return NextResponse.json(
      { ok: false, reason: "api", error: err.message ?? String(e), pages: [] },
      { status: err.status === 429 ? 429 : 502 },
    );
  }
}
