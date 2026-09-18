import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { TIKTOK_CAMPAIGN_ID_RE } from "@/lib/tiktok-launch";
import type { TiktokSourceInfo } from "@/lib/tiktok-source";
import { TiktokWeaponError, tiktokRailEnabled, tiktokWeaponConfigured, twDatasetFetch } from "@/lib/tiktok-weapon";

export const runtime = "nodejs";
// A fetch trigger for a handful of ids — a short cap keeps an abandoned call from idling.
export const maxDuration = 60;

const MAX_IDS = 30;
const CONCURRENCY = 5;

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

/**
 * POST { ids } → RE-TRIGGER the partner's dataset fetch per id (the board's "re-fetch" button: the
 * source changed since its snapshot — new creatives, a new landing). tiktok-weapon has no dataset
 * status read, so the answer is what the trigger said: "fetching" (accepted, 30–120 s), "missing"
 * (LION never saw the campaign) or "error".
 */
export async function POST(req: Request): Promise<NextResponse> {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) return bad("unauthorized", 401);
  if (!tiktokRailEnabled()) return bad("tiktok_rail_disabled", 404);
  if (!tiktokWeaponConfigured()) return bad("tiktok_weapon_not_configured", 500);

  let body: { ids?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return bad("bad_json");
  }
  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((x) => String(x).trim()).filter((x) => TIKTOK_CAMPAIGN_ID_RE.test(x)))];
  if (ids.length === 0) return bad("no_ids");
  if (ids.length > MAX_IDS) return bad(`too_many_ids (max ${MAX_IDS})`);

  const datasets: Record<string, TiktokSourceInfo["dataset"]> = {};
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      try {
        await twDatasetFetch(id);
        datasets[id] = { state: "fetching" };
      } catch (e) {
        const st = e instanceof TiktokWeaponError ? e.status : undefined;
        datasets[id] = { state: st === 404 ? "missing" : "error", error: e instanceof Error ? e.message : String(e) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
  return NextResponse.json({ ok: true, datasets });
}
