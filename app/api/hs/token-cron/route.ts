import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { hsProbeTokenHealth, hsTokenConfigured } from "@/lib/hs-token-launch";
import { sessionFromCookieHeader } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * GET /api/hs/token-cron — the scheduled token-pool health sweep (vercel.json cron, every 30
 * minutes; owner ask 08-20). Rate limits lift on their own schedule, so a probe pass has to run
 * even when nobody has a tab open: it re-checks every bearer raw, CLEARS the marks of tokens
 * whose limit already lifted (launches switch back to them — T1 first by priority) and
 * re-marks the ones still burned, keeping the shared health row truthful for the whole fleet.
 *
 * Auth: Vercel sends `Authorization: Bearer <CRON_SECRET>` on cron invocations; a valid
 * adlauncher session works too (manual "check now"). Without CRON_SECRET set, only sessions
 * pass — the route never runs open.
 */
export async function GET(req: Request) {
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
  if (!hsTokenConfigured()) return NextResponse.json({ ok: true, tokens: [] });

  try {
    const tokens = await hsProbeTokenHealth();
    const summary = tokens
      .map((t) => `T${t.index}=${t.state}${t.active ? "*" : ""}`)
      .join(" ");
    console.log(`[hs-token-cron] ${summary}`);
    return NextResponse.json({
      ok: true,
      now: Date.now(),
      summary,
      tokens: tokens.map((t) => ({
        index: t.index,
        state: t.state,
        active: t.active,
        app: t.app,
        limitedUntil: t.limitedUntil,
      })),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message ?? e) }, { status: 502 });
  }
}
