import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { cachedAutoLandings } from "@/lib/auto-landings";

export const runtime = "nodejs";

/**
 * Published AUTO landings for the MO landing picker (every buyer — the owner manages creation,
 * the whole team launches on the results). The board merges these under the partner's static
 * catalog; /api/launch accepts either. Answer shape mirrors lib/partners `Landing`.
 */
export async function GET(req: Request) {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const rows = await cachedAutoLandings();
  return NextResponse.json({
    ok: true,
    landings: rows.map(({ slug, title, lang, niche }) => ({ slug, title, lang, niche })),
  });
}
