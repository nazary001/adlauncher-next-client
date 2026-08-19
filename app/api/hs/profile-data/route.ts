import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { hsTokenAccountIds, hsTokenConfigured } from "@/lib/hs-token-launch";
import { lionConfigured, lionProfileData } from "@/lib/lion";

export const runtime = "nodejs";
// A cold profile-data pull is heavy on LION's side (hundreds of accounts) — give it headroom.
export const maxDuration = 60;

/** One profile's bind space: ad accounts (with status), pages and FB locales. */
export async function GET(req: Request): Promise<NextResponse> {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!lionConfigured()) {
    return NextResponse.json({ ok: false, error: "lion_not_configured" }, { status: 500 });
  }
  const slug = new URL(req.url).searchParams.get("slug")?.trim() ?? "";
  if (!slug) return NextResponse.json({ ok: false, error: "slug_required" }, { status: 400 });
  try {
    const data = await lionProfileData(slug);
    // Which of the profile's accounts our FB token can actually act on — the FB Token rail's
    // pickers offer only these (LION binds cover segments the token was never granted, 08-19).
    // null = sweep unavailable → the client skips filtering (fail open, Graph is the backstop).
    let tokenAccounts: string[] | null = null;
    if (hsTokenConfigured()) {
      const ids = await hsTokenAccountIds();
      if (ids) tokenAccounts = data.accounts.filter((a) => ids.has(a.id.replace(/^act_/, ""))).map((a) => a.id);
    }
    return NextResponse.json({ ok: true, ...data, tokenAccounts });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 502 });
  }
}
