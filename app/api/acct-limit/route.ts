import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { acctLimitSnapshot } from "@/lib/acct-limit";
import { queueHealth, queuedDemandByAccount } from "@/lib/launch-queue-store";
import type { QueueHealth } from "@/lib/launch-queue-types";

export const runtime = "nodejs";

/**
 * GET /api/acct-limit — the live per-account launch-limit picture for the UI (header timer,
 * account-picker badges, launch gates): every account with an ACTIVE 30-min window and its
 * count/resetAt/name. Proxy-gated; self-checks the session too (defense-in-depth, same as the
 * other data routes). Also opportunistically sweeps expired registry rows (bounded, in lib).
 */
export async function GET(req: Request): Promise<NextResponse> {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    const snap = await acctLimitSnapshot();
    // Jobs still QUEUED on the server per ad account (owner ask 08.10 hand-off queue): the client
    // folds this — plus its own not-yet-accepted hand-off items — into countFor, so a second wave can't
    // over-queue an account the first is still waiting to fill. Best effort: a failure leaves it {} and
    // the route still answers ok (the server-side slot claim stays the only authority).
    let queued: Record<string, number> = {};
    try {
      queued = await queuedDemandByAccount();
    } catch {
      queued = {};
    }
    // When the queue's every-minute sweep last ran and since when its oldest job has been waiting —
    // so every open tab can say so when the sweep stops (best effort, like `queued`).
    let queue: QueueHealth | null = null;
    try {
      queue = await queueHealth();
    } catch {
      queue = null;
    }
    return NextResponse.json(
      // `build` = this deployment's build stamp: a client whose inlined stamp differs is a
      // stale tab and must reload before launching (its pre-flight gates are outdated).
      { ok: true, build: process.env.NEXT_PUBLIC_BUILD_STAMP ?? "", ...snap, queued, queue },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message ?? String(e) }, { status: 502 });
  }
}
