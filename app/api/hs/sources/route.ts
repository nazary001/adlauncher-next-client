import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { lionConfigured, lionSourceInfo } from "@/lib/lion";

export const runtime = "nodejs";
export const maxDuration = 60;

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

/**
 * Read source campaigns for the HS duplicator table (LION details/ + targeting/): name,
 * countries, original budget/bid, creatives count. Read-only. UNREADABLE sources (details/
 * can't see them) are flagged — their duplicate would die the same way.
 */
export async function POST(req: Request): Promise<NextResponse> {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return bad("unauthorized", 401);
  }
  if (!lionConfigured()) return bad("lion_not_configured", 500);

  let body: { ids?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return bad("bad_json");
  }
  const ids = [
    ...new Set(
      (Array.isArray(body.ids) ? body.ids : [])
        .map((x) => String(x).trim())
        .filter((x) => /^\d{5,}$/.test(x)),
    ),
  ];
  if (ids.length === 0) return bad("no_ids");
  if (ids.length > 30) return bad("too_many_ids");

  try {
    const sources = await lionSourceInfo(ids);
    return NextResponse.json({ ok: true, sources });
  } catch (e) {
    return bad(`lion_unreachable: ${(e as Error).message}`, 502);
  }
}
