import { timingSafeEqual } from "node:crypto";
import { NextResponse, after } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { pumpLane, selfOrigin, sweepQueue } from "@/lib/launch-queue-run";

export const runtime = "nodejs";
// Normally a reap pass + up to 20 lane kicks (each a 10 s-bounded POST) — a few seconds. The long
// ceiling is for the FALLBACK only: a lane whose kick the deployment could not deliver to itself is
// pumped right here in after(), so this invocation may host a pump's whole budget window.
export const maxDuration = 800;

/**
 * GET /api/launch-queue/cron — the every-minute sweep (vercel.json cron). It reaps dead job leases
 * (a run that had begun is closed as interrupted and never re-run; a job that was only claimed goes
 * back to the queue) and kicks every lane that has queued work and no live lock, so a lost self-kick
 * is recovered within the minute. A lane whose kick is refused is pumped by THIS invocation instead —
 * the queue keeps moving even where the deployment cannot call itself over HTTP. Last, any row the
 * queue owns that stayed open although its job has ended is closed from the job (`rowsClosed`).
 *
 * Auth: Vercel sends `Authorization: Bearer <CRON_SECRET>` on cron invocations; a valid adlauncher
 * session passes too (manual "sweep now"). Without CRON_SECRET set only sessions pass — the route
 * never runs open. Same pattern as /api/hs/token-cron.
 */
export async function GET(req: Request): Promise<NextResponse> {
  // Anchor a possible fallback pump's budget at the invocation start (see /api/launch-queue).
  const startedAt = Date.now();
  const secret = process.env.CRON_SECRET ?? "";
  const auth = req.headers.get("authorization") ?? "";
  // Constant-time compare, same discipline as lib/session's HMAC verify.
  const expected = Buffer.from(`Bearer ${secret}`);
  const got = Buffer.from(auth);
  const cronOk = secret.length > 0 && got.length === expected.length && timingSafeEqual(got, expected);
  const sessionOk = Boolean(sessionFromCookieHeader(req.headers.get("cookie")));
  if (!cronOk && !sessionOk) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const origin = selfOrigin(req);
    // Only Vercel Cron's own tick announces this build as the current one (a manual "sweep now" with
    // a session may be running on any deployment, and must not move the lanes).
    const { unkicked, ...counters } = await sweepQueue(origin, { announce: cronOk });
    for (const lane of unkicked) after(() => pumpLane(lane, { origin, startedAt }));
    return NextResponse.json({ ok: true, now: Date.now(), ...counters, pumpedHere: unkicked.length });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message ?? e) }, { status: 502 });
  }
}
