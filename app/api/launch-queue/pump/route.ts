import { NextResponse, after } from "next/server";
import { isInternalRequest, laneNameValid, pumpLane, selfOrigin, thisBuild } from "@/lib/launch-queue-run";

export const runtime = "nodejs";
// This invocation HOSTS the lane pump (after() extends its lifetime): maxDuration is the pump's full
// budget. The route answers 202 at once; the work runs in the background.
export const maxDuration = 800;

/**
 * POST /api/launch-queue/pump — the internal self-kick (and the cron's per-lane restart). Excluded
 * from the proxy; it authenticates itself with a Bearer that is either the HMAC(AUTH_SECRET) internal
 * token (so self-kicks work even where CRON_SECRET is unset) or CRON_SECRET, compared constant-time.
 * Body: { lane }. Answers 202 immediately and pumps the lane in after().
 */
/**
 * GET /api/launch-queue/pump — "which build answers at this address?" (same internal bearer). A pump
 * that the beacon says has been replaced asks the production address this before it steps aside: it
 * yields only to a build that will really receive its kick.
 */
export async function GET(req: Request): Promise<NextResponse> {
  if (!isInternalRequest(req)) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ ok: true, build: thisBuild() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request): Promise<NextResponse> {
  // Anchor the pump budget at the invocation start, before any await (see /api/launch-queue).
  const startedAt = Date.now();
  if (!isInternalRequest(req)) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  let lane: unknown;
  try {
    lane = ((await req.json()) as { lane?: unknown }).lane;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  if (!laneNameValid(lane)) return NextResponse.json({ ok: false, error: "bad_lane" }, { status: 400 });
  const origin = selfOrigin(req);
  after(() => pumpLane(lane, { origin, startedAt }));
  return NextResponse.json({ ok: true }, { status: 202 });
}
