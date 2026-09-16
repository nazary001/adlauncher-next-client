import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { isOwnerSession } from "@/lib/roles";
import { snapRailEnabled } from "@/lib/snap-api";
import { SNAP_KEY_POOL_MAX, isSnapKey } from "@/lib/snap-launch";
import { listSnapKeys, releaseSnapKeyByKey, snapFreeKeys, snapNextKey } from "@/lib/snap-keys";

export const runtime = "nodejs";
export const maxDuration = 30;

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

/** GET → the registry (bound rows), the free keys and the next one a launch would take. Works
 *  without Snapchat credentials (the registry is ours) — only the rail flag gates it. */
export async function GET(req: Request): Promise<NextResponse> {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) return bad("unauthorized", 401);
  if (!snapRailEnabled()) return bad("snap_rail_disabled", 404);
  try {
    const used = await listSnapKeys();
    const free = snapFreeKeys(used.map((r) => r.key));
    return NextResponse.json({ ok: true, poolMax: SNAP_KEY_POOL_MAX, used, free, next: snapNextKey(used.map((r) => r.key)) });
  } catch (e) {
    return bad(`registry_unavailable: ${(e as Error).message}`, 502);
  }
}

/** DELETE ?key=glo-snp_NNN → owner-only release (the registry row only; Snapchat is not touched). */
export async function DELETE(req: Request): Promise<NextResponse> {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return bad("unauthorized", 401);
  if (!snapRailEnabled()) return bad("snap_rail_disabled", 404);
  if (!isOwnerSession(session)) return bad("owner_only", 403);
  const key = String(new URL(req.url).searchParams.get("key") ?? "").trim();
  if (!isSnapKey(key)) return bad("bad_key");
  try {
    const released = await releaseSnapKeyByKey(key);
    return NextResponse.json({ ok: true, released });
  } catch (e) {
    return bad(`registry_unavailable: ${(e as Error).message}`, 502);
  }
}
