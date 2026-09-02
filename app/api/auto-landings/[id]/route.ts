import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { isOwnerSession } from "@/lib/roles";
import {
  deleteJob,
  deleteLanding,
  findLandingBySlug,
  patchJob,
  readJob,
} from "@/lib/auto-landings";

export const runtime = "nodejs";

/**
 * Owner-only job actions.
 *
 * PATCH → body { action: "cancel" | "retry" | "reschedule", at? }
 *   cancel     scheduled → canceled (a job the worker already claimed can't be un-generated)
 *   retry      failed | canceled → scheduled at NOW (attempts survive — the count tells the story)
 *   reschedule scheduled → scheduled at `at` (epoch ms, future)
 * DELETE → remove the queue row (terminal states only). `?landing=1` on a published job ALSO
 *   deletes the mo-landing row — the live page 404s and the picker entry disappears; the console
 *   warns about live campaigns before offering it.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!isOwnerSession(session)) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  const job = await readJob(id);
  if (!job) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as { action?: string; at?: unknown } | null;
  const action = String(body?.action ?? "");

  if (action === "cancel") {
    if (job.status !== "scheduled") {
      return NextResponse.json({ ok: false, error: "only_scheduled_cancels" }, { status: 409 });
    }
    const ok = await patchJob(id, { status: "canceled", finished_at: String(Date.now()) });
    return ok
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ ok: false, error: "store_unavailable" }, { status: 502 });
  }

  if (action === "retry") {
    if (job.status !== "failed" && job.status !== "canceled") {
      return NextResponse.json({ ok: false, error: "only_failed_retries" }, { status: 409 });
    }
    const ok = await patchJob(id, {
      status: "scheduled",
      scheduled_at: String(Date.now()),
      error: "",
      started_at: null,
      finished_at: null,
    });
    return ok
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ ok: false, error: "store_unavailable" }, { status: 502 });
  }

  if (action === "reschedule") {
    if (job.status !== "scheduled") {
      return NextResponse.json({ ok: false, error: "only_scheduled_reschedules" }, { status: 409 });
    }
    const at = Number(body?.at);
    if (!Number.isFinite(at) || at < Date.now() - 60_000) {
      return NextResponse.json({ ok: false, error: "bad_time" }, { status: 400 });
    }
    const ok = await patchJob(id, { status: "scheduled", scheduled_at: String(at) });
    return ok
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ ok: false, error: "store_unavailable" }, { status: 502 });
  }

  return NextResponse.json({ ok: false, error: "bad_action" }, { status: 400 });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!isOwnerSession(session)) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  const job = await readJob(id);
  if (!job) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  // A generating row belongs to the worker; a scheduled one wants Cancel first (explicit intent).
  if (job.status === "scheduled" || job.status === "generating") {
    return NextResponse.json({ ok: false, error: "cancel_first" }, { status: 409 });
  }

  const withLanding = new URL(req.url).searchParams.get("landing") === "1";
  if (withLanding && job.status === "published" && job.slug) {
    const landingDoc = await findLandingBySlug(job.slug);
    if (landingDoc && !(await deleteLanding(landingDoc))) {
      return NextResponse.json({ ok: false, error: "landing_delete_failed" }, { status: 502 });
    }
  }
  const ok = await deleteJob(id);
  return ok
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ ok: false, error: "store_unavailable" }, { status: 502 });
}
