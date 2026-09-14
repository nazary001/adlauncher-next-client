import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { googleRailEnabled, googleWeaponConfigured, gwTasks } from "@/lib/google-weapon";

export const runtime = "nodejs";
// Bounded read of google-weapon task records (≤5 in flight) — the client poller gives up first.
export const maxDuration = 60;

const MAX_IDS = 100;

/**
 * POST { taskIds } → the current google-weapon task record per id (`gwTasks`, per-id failure
 * isolated: a lost/foreign id comes back status "not_found"|"unknown"). The Google task manager's
 * client poller uses it to finish MY running rows the server pump left behind at its deadline.
 */
export async function POST(req: Request): Promise<NextResponse> {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!googleRailEnabled()) return NextResponse.json({ ok: false, error: "google_rail_disabled" }, { status: 404 });
  if (!googleWeaponConfigured()) {
    return NextResponse.json({ ok: false, error: "google_weapon_not_configured" }, { status: 500 });
  }
  let body: { taskIds?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  const taskIds = Array.isArray(body.taskIds)
    ? (body.taskIds as unknown[]).filter((v): v is string => typeof v === "string" && v.length > 0).slice(0, MAX_IDS)
    : [];
  if (taskIds.length === 0) {
    return NextResponse.json({ ok: false, error: "taskIds_required" }, { status: 400 });
  }
  try {
    const tasks = await gwTasks(taskIds);
    return NextResponse.json({ ok: true, tasks });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}
