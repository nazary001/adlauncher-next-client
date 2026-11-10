import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { acctLimitSnapshot } from "@/lib/acct-limit";
import { queueHealth, queuedDemandByAccount } from "@/lib/launch-queue-store";
import type { QueueHealth } from "@/lib/launch-queue-types";
import { legacyBuildField, releaseOf } from "@/lib/build-update";

export const runtime = "nodejs";

/**
 * GET /api/acct-limit — the live per-account launch-limit picture for the UI (header timer,
 * account-picker badges, launch gates): every account with an ACTIVE 15-min window and its
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
    // `release` = this deployment's build stamp + the wire level it speaks (lib/build-update): a tab
    // whose own stamp differs shows the small "update available" notice and KEEPS launching; only a
    // tab of a lower wire level must reload first. `build` is the same stamp for the bundles from
    // before 10.11.2026, which lock themselves on any mismatch — blank while the wire is still theirs.
    // The env read is LITERAL on purpose (next.config `env` values are build-time replacements).
    const release = releaseOf(process.env.NEXT_PUBLIC_BUILD_STAMP);
    return NextResponse.json(
      { ok: true, build: legacyBuildField(release), release, ...snap, queued, queue },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message ?? String(e) }, { status: 502 });
  }
}
