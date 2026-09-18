import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { tiktokTaskOutcome } from "@/lib/tiktok-launch";
import { tiktokRailEnabled, tiktokWeaponConfigured, twTasks } from "@/lib/tiktok-weapon";
import { TIKTOK_PARTNER } from "@/lib/tiktok-pump";
import { storeConfigured, strapiFetch, upsertTaskRow } from "@/lib/task-store";

export const runtime = "nodejs";
// Bounded read of tiktok-weapon task records (≤5 in flight) + at most one store write per id.
export const maxDuration = 60;

const MAX_IDS = 60;

const STRAPI = (process.env.STRAPI_API_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.STRAPI_TOKEN ?? "";

/** The three facts that decide whether a row may be finished here: whose it is, where it stands,
 *  and WHICH partner task it was sent as. null = absent or unreadable (either way: don't write). */
async function readSentRow(taskId: string): Promise<{ owner: string; stage: string; link: string } | null> {
  try {
    const res = await strapiFetch(
      `${STRAPI}/api/launch-tasks?filters[task_id][$eq]=${encodeURIComponent(taskId)}&fields[0]=owner&fields[1]=stage&fields[2]=link&pagination[pageSize]=1`,
      { headers: { Authorization: `Bearer ${TOKEN}` }, cache: "no-store" },
    );
    if (!res.ok) return null;
    const row = ((await res.json().catch(() => ({}))) as { data?: Array<Record<string, unknown>> }).data?.[0];
    return row ? { owner: String(row.owner ?? ""), stage: String(row.stage ?? ""), link: String(row.link ?? "") } : null;
  } catch {
    return null;
  }
}

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

/**
 * POST { tasks: [{ taskId, lionTaskId }] } → finish the CALLER's "Sent to LION" rows the server
 * pump left behind (its settle pass ended before LION did): the partner task is read, and a FINAL
 * one upgrades the row here, server-side — `done/created` with the real campaign, or `error/lion`
 * with LION's step and sentence. Only a row that is the caller's own, still at stage "sent", AND
 * stamped with THIS partner task id is touched — the pairing the client sends is never trusted, so
 * a stale tab can neither rewrite a settled row nor finish a row with another task's verdict.
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
        const row = await readSentRow(asked[i].taskId);
        if (row && row.owner === user && row.stage === "sent" && row.link === asked[i].lionTaskId) {
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
