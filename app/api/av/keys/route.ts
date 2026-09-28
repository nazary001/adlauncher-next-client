import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { isOwnerSession } from "@/lib/roles";
import { avKeysRegistered, avRailEnabled } from "@/lib/av-launch";
import { AV_KEY_POOL_MAX, avKeyIndex } from "@/lib/av-link";
import { avNextKey, listAvKeys, releaseAvKeyByKey } from "@/lib/av-keys";

export const runtime = "nodejs";
export const maxDuration = 30;

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

/**
 * GET /api/av/keys — the launcher/clone board pool preview + the owner AV keys page registry.
 *
 * `poolMax` is the LAUNCHABLE range (AV_KEYS_REGISTERED), NOT the codec ceiling (`codecMax` =
 * av999): the boards walk `poolMax` as the effective max for the AV pool, and `poolMax === 0`
 * reads as "no AV keys are registered in ActiveView yet", never "pool exhausted". `used` = the
 * bound keys from the registry; `next` = the key a launch would take.
 *
 * `?rows=1` + an owner session also returns the full registry rows (without documentId) for the AV
 * keys page table. Works without the ActiveView API key (the registry is our own Strapi) — only the
 * rail flag gates it.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return bad("unauthorized", 401);
  if (!avRailEnabled()) return bad("av_rail_disabled", 404);
  const registered = avKeysRegistered();
  try {
    const rows = await listAvKeys();
    const used = rows.map((r) => r.key);
    const body: Record<string, unknown> = {
      ok: true,
      used,
      next: avNextKey(used, registered),
      poolMax: registered,
      registered,
      codecMax: AV_KEY_POOL_MAX,
    };
    // The owner AV keys page wants the full binding per row (status/user/via/campaign/…) — the
    // documentId stays server-side (it is the DELETE handle; the page releases by key).
    if (new URL(req.url).searchParams.get("rows") === "1" && isOwnerSession(session)) {
      body.rows = rows.map(({ documentId: _documentId, ...row }) => row);
    }
    return NextResponse.json(body);
  } catch (e) {
    return bad(`registry_unavailable: ${(e as Error).message}`, 502);
  }
}

/** DELETE ?key=avNNN → owner-only release (the registry row only; ActiveView is not touched — a key
 *  already uploaded to "UTM Campaign Values" stays registered there). `released: false` means no row
 *  existed; a Strapi failure is a 502, never a false "released". A malformed key is a 400. */
export async function DELETE(req: Request): Promise<NextResponse> {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return bad("unauthorized", 401);
  if (!avRailEnabled()) return bad("av_rail_disabled", 404);
  if (!isOwnerSession(session)) return bad("owner_only", 403);
  const key = String(new URL(req.url).searchParams.get("key") ?? "").trim();
  if (avKeyIndex(key) == null) return bad("bad_key");
  try {
    const released = await releaseAvKeyByKey(key);
    return NextResponse.json({ ok: true, released });
  } catch (e) {
    return bad(`registry_unavailable: ${(e as Error).message}`, 502);
  }
}
