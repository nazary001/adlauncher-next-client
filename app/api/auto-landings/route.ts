import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { isOwnerSession } from "@/lib/roles";
import {
  computeScheduleSlots,
  normalizeDraftItems,
  parseScheduleSpec,
} from "@/lib/auto-landings-plan";
import { createJob, listJobs } from "@/lib/auto-landings";

export const runtime = "nodejs";

/**
 * Owner-only Auto landings queue (feeds the /auto-landings console).
 *
 * GET  → { ok, jobs } — the whole mo-landing-job queue, newest first.
 * POST → body { items: [{title, lang, niche, notes?}], schedule: {mode:"now"} | {mode:"at",at} |
 *        {mode:"spread", startDay, days[], times[]} } — one queue row per title with its
 *        authoritative scheduled_at computed HERE (the client's preview uses the same pure
 *        function, but the server never trusts client timestamps beyond mode "at").
 */
export async function GET(req: Request) {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!isOwnerSession(session)) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  const jobs = await listJobs();
  if (jobs === null) return NextResponse.json({ ok: false, error: "store_unavailable" }, { status: 502 });
  return NextResponse.json({ ok: true, jobs });
}

export async function POST(req: Request) {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!isOwnerSession(session)) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as { items?: unknown; schedule?: unknown } | null;
  const norm = normalizeDraftItems(body?.items);
  if (!norm.ok) {
    return NextResponse.json({ ok: false, error: "bad_items", problems: norm.problems }, { status: 400 });
  }
  const spec = parseScheduleSpec(body?.schedule);
  if (!spec) return NextResponse.json({ ok: false, error: "bad_schedule" }, { status: 400 });

  const now = Date.now();
  // A specific moment slightly in the past (clock skew while composing) still means "now";
  // anything older is a stale form the owner should re-check.
  if (spec.mode === "at" && spec.at < now - 10 * 60_000) {
    return NextResponse.json({ ok: false, error: "schedule_in_past" }, { status: 400 });
  }
  const slots = computeScheduleSlots(norm.items.length, spec, now);
  if (!slots) return NextResponse.json({ ok: false, error: "schedule_unplannable" }, { status: 400 });

  const batchId = `b${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const created = [];
  for (let i = 0; i < norm.items.length; i++) {
    const item = norm.items[i];
    const job = await createJob({
      ...item,
      scheduledAt: slots[i],
      createdBy: session.username,
      batchId,
    });
    if (!job) {
      // Partial batch: report what landed so the owner retries only the tail.
      return NextResponse.json(
        { ok: false, error: "store_unavailable", createdCount: created.length, created },
        { status: 502 },
      );
    }
    created.push(job);
  }
  return NextResponse.json({ ok: true, batchId, created });
}
