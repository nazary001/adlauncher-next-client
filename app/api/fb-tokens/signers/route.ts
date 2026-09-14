import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { signersView } from "@/lib/fb-tokens";

export const runtime = "nodejs";

/**
 * GET /api/fb-tokens/signers — the effective signer of every partner×rail slot for the boards'
 * read-only "Signs as …" badges (any session): label, source (owner-assigned vs env default),
 * identity and a cached live health verdict. Labels and fingerprints only — no bearers.
 */
export async function GET(req: Request) {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ ok: true, now: Date.now(), slots: await signersView() });
}
