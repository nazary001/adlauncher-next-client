import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { lionAccountPixels, lionConfigured } from "@/lib/lion";

export const runtime = "nodejs";
// Bounded upstreams (LION 60s x2 / Graph 15s) — cap the function so an abandoned poll can
// never idle a long serverless window (the client gives up at 20s).
export const maxDuration = 60;

/** Pixels of one ad account under a LION profile (dependent picker feed). */
export async function GET(req: Request): Promise<NextResponse> {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!lionConfigured()) {
    return NextResponse.json({ ok: false, error: "lion_not_configured" }, { status: 500 });
  }
  const params = new URL(req.url).searchParams;
  const slug = params.get("slug")?.trim() ?? "";
  const account = params.get("account")?.trim() ?? "";
  if (!slug || !account) {
    return NextResponse.json({ ok: false, error: "slug_and_account_required" }, { status: 400 });
  }
  try {
    const pixels = await lionAccountPixels(slug, account);
    return NextResponse.json({ ok: true, pixels });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 502 });
  }
}
