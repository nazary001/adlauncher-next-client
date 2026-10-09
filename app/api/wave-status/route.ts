import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { readAppCacheDetailed } from "@/lib/app-cache";

export const runtime = "nodejs";

/** rail → the prefix of its wave claim in app_caches (lib/google-wave, lib/snap-wave, lib/tiktok-wave
 *  and the HS clone routes each write `<prefix>:<waveId>` the moment they accept a wave — before
 *  they answer; `hs` = LION / token duplicates and JURO, `hs-tool` = the TOOL duplicator). */
const CLAIM_PREFIX: Record<string, string> = { google: "google-wave", snap: "snap-wave", tiktok: "tiktok-wave", hs: "hs-wave", "hs-tool": "hs-tool-wave" };
/** The one shape every rail's wave id has (GOOGLE_/SNAP_/TIKTOK_WAVE_ID_RE). */
const WAVE_ID_RE = /^[a-zA-Z0-9-]{8,64}$/;

/**
 * GET /api/wave-status?rail=google|snap|tiktok&id=<waveId> — "did the server ACCEPT this wave?"
 *
 * A wave is one request; when its answer is lost on the way back (the connection dropped) the board
 * cannot know whether the campaigns are being built. It holds the wave's cards and asks here
 * (components/wave-hold.ts) instead of letting the buyer launch them again under a new wave id —
 * which the server would build a second time. Read-only: one indexed read of the wave's claim.
 *
 *   200 { ok: true, accepted: boolean }   the store answered: the claim exists / it does not
 *   503 { ok: false, error }              the store could not be read — NOT a "no" (the board keeps holding)
 *
 * Proxy-gated; self-checks the session too, like the other data routes.
 */
export async function GET(req: Request): Promise<NextResponse> {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const prefix = CLAIM_PREFIX[url.searchParams.get("rail") ?? ""];
  const id = url.searchParams.get("id") ?? "";
  if (!prefix || !WAVE_ID_RE.test(id)) return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  let read: { ok: boolean; row: unknown };
  try {
    read = await readAppCacheDetailed<unknown>(`${prefix}:${id}`);
  } catch {
    read = { ok: false, row: null };
  }
  if (!read.ok) return NextResponse.json({ ok: false, error: "task_store_unavailable" }, { status: 503 });
  return NextResponse.json({ ok: true, accepted: read.row !== null }, { headers: { "Cache-Control": "no-store" } });
}
