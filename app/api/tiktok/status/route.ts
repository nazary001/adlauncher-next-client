import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { tiktokTaskOutcome } from "@/lib/tiktok-launch";
import { tiktokRailEnabled, tiktokWeaponConfigured, twTasks } from "@/lib/tiktok-weapon";
import { TIKTOK_PARTNER } from "@/lib/tiktok-pump";
import { findTaskRow, storeConfigured, upsertTaskRow } from "@/lib/task-store";

export const runtime = "nodejs";
// Bounded read of tiktok-weapon task records (≤5 in flight) + at most one store write per id.
export const maxDuration = 60;

const MAX_IDS = 60;

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

/**
 * POST { tasks: [{ taskId, lionTaskId }] } → finish the CALLER's "Sent to LION" rows the server
 * pump left behind (its settle pass ended before LION did): the partner task is read, and a FINAL
 * one upgrades the row here, server-side — `done/created` with the real campaign, or `error/lion`
 * with LION's step and sentence. Only a row that is the caller's own AND still at stage "sent" is
 * touched (the store refuses foreign rows anyway), so a stale tab can never rewrite a settled row.
 * Answers the partner's view per task so the drawer can show progress without a second read.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session?.username) return bad("unauthorized", 401);
  if (!tiktokRailEnabled()) return bad("tiktok_rail_disabled", 404);
  if (!tiktokWeaponConfigured()) return bad("tiktok_weapon_not_configured", 500);
  const user = String(session.username);

  let body: { tasks?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return bad("bad_json");
  }
  const asked = (Array.isArray(body.tasks) ? body.tasks : [])
    .map((t) => (t && typeof t === "object" ? (t as Record<string, unknown>) : {}))
    .map((t) => ({ taskId: String(t.taskId ?? "").trim(), lionTaskId: String(t.lionTaskId ?? "").trim() }))
    .filter((t) => /^tt[lcj]-[a-zA-Z0-9-]{8,80}$/.test(t.taskId) && /^[a-zA-Z0-9_-]{6,64}$/.test(t.lionTaskId))
    .slice(0, MAX_IDS);
  if (asked.length === 0) return bad("tasks_required");

  try {
    const partner = await twTasks(asked.map((t) => t.lionTaskId));
    const out = [];
    for (let i = 0; i < asked.length; i++) {
      const p = partner[i];
      const verdict = tiktokTaskOutcome(p);
      let settled = false;
      if (verdict && storeConfigured()) {
        const row = await findTaskRow(asked[i].taskId).catch(() => null);
        if (row && row.owner === user && row.stage === "sent") {
          const res = await upsertTaskRow(user, asked[i].taskId, { ...verdict, partner: TIKTOK_PARTNER, finished_at: Date.now() });
          settled = res.ok;
        }
      }
      out.push({ taskId: asked[i].taskId, lionTaskId: asked[i].lionTaskId, status: p.status, campaignId: p.campaignId, errorStep: p.errorStep, errorMessage: p.errorMessage, settled });
    }
    return NextResponse.json({ ok: true, tasks: out });
  } catch (e) {
    return bad((e as Error).message, 502);
  }
}
