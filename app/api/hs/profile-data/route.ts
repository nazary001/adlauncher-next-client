import { NextResponse } from "next/server";
import { filterAccountsFor } from "@/lib/acct-assignments";
import { sessionFromCookieHeader } from "@/lib/session";
import { hsDupTokenAccountIds, hsDupTokenConfigured, hsTokenAccountIds, hsTokenConfigured } from "@/lib/hs-token-launch";
import { lionConfigured, lionProfileData } from "@/lib/lion";

export const runtime = "nodejs";
// A cold profile-data pull is heavy on LION's side (hundreds of accounts) — give it headroom.
export const maxDuration = 60;

/** One profile's bind space: ad accounts (with status), pages and FB locales. */
export async function GET(req: Request): Promise<NextResponse> {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!lionConfigured()) {
    return NextResponse.json({ ok: false, error: "lion_not_configured" }, { status: 500 });
  }
  const slug = new URL(req.url).searchParams.get("slug")?.trim() ?? "";
  if (!slug) return NextResponse.json({ ok: false, error: "slug_required" }, { status: 400 });
  try {
    const data = await lionProfileData(slug);
    // Owner assignments: a non-owner sees only accounts assigned to them (unassigned = shared).
    // Filter into a NEW list — `data` is lib/lion's shared 10-min cache object, never mutate it.
    const accounts = await filterAccountsFor(session, data.accounts, (a) => a.id);
    // Which of the profile's accounts our FB tokens can actually act on — the FB Token rails'
    // pickers offer only these (LION binds cover segments a token was never granted, 08-19).
    // Two sweeps since 09-03: the LAUNCH pool's grant (launcher card) and the dedicated
    // duplicate/JURO signer's own grant (clone board — a different user with a smaller grant,
    // so the pre-filter must match the bearer that will actually build).
    // null = sweep unavailable → the client skips filtering (fail open, Graph is the backstop).
    let tokenAccounts: string[] | null = null;
    if (hsTokenConfigured()) {
      const ids = await hsTokenAccountIds();
      if (ids) tokenAccounts = accounts.filter((a) => ids.has(a.id.replace(/^act_/, ""))).map((a) => a.id);
    }
    let dupTokenAccounts: string[] | null = null;
    if (hsDupTokenConfigured()) {
      const ids = await hsDupTokenAccountIds();
      if (ids) dupTokenAccounts = accounts.filter((a) => ids.has(a.id.replace(/^act_/, ""))).map((a) => a.id);
    }
    return NextResponse.json({ ok: true, ...data, accounts, tokenAccounts, dupTokenAccounts });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 502 });
  }
}
