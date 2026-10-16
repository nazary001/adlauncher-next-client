import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { storeConfigured } from "@/lib/store";
import { bumpTemplateUse } from "@/lib/template-store";

export const runtime = "nodejs";

/**
 * POST /api/templates/<documentId>/use → { ok } — "this template was just applied": the use counter
 * and the last-use stamp move. Every login (anyone may apply anyone's template); best-effort — the
 * client fires and forgets it, so a 404 / 502 here never blocks an apply.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!storeConfigured()) return NextResponse.json({ ok: false, error: "store_unavailable" }, { status: 502 });
  const id = (await ctx.params).id;
  if (!/^[a-z0-9]{24}$/.test(id ?? "")) return NextResponse.json({ ok: false, error: "bad_id" }, { status: 400 });
  try {
    const found = await bumpTemplateUse(id);
    return found ? NextResponse.json({ ok: true }) : NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: "store_unavailable", message: e instanceof Error ? e.message : undefined }, { status: 502 });
  }
}
