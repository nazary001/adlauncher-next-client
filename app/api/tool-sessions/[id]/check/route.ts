import { NextResponse, after } from "next/server";
import { ownerGate, toolError } from "@/lib/tool-sessions-gate";
import { checkSession, getSession, toolConfigured } from "@/lib/tool-sessions";
import { appendToolLog } from "@/lib/tool-sessions-log";
import { parseToolId, toJobView, toSession } from "@/lib/tool-sessions-model";

export const runtime = "nodejs";

/**
 * POST → queues TOOL's session.check (me + accounts + egress IP through the proxy; read-only on
 * Facebook's side) → { ok, job }. The board then polls GET /api/tool-sessions/jobs/<id> until the
 * job is terminal and reloads the session row (status may flip active ↔ expired).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = ownerGate(req);
  if (g instanceof NextResponse) return g;
  if (!toolConfigured()) return NextResponse.json({ ok: false, error: "not_configured", message: "TOOL_SESSIONS_API_KEY is not set on this deployment" }, { status: 500 });
  const id = parseToolId((await ctx.params).id);
  if (!id) return NextResponse.json({ ok: false, error: "bad_id", message: "session id must be a positive integer" }, { status: 400 });
  const r = await checkSession(id);
  if (!r.ok) return toolError(r);
  if (!r.data || typeof r.data !== "object") return NextResponse.json({ ok: false, error: "bad_answer", message: "TOOL queued the check but answered without the job — watch the session's jobs" }, { status: 502 });
  const job = toJobView(r.data);
  const before = await getSession(id);
  const name = before.ok ? toSession(before.data).name : `#${id}`;
  after(() => appendToolLog({ by: g.username, kind: "check", sessionId: id, name, text: `Check queued for "${name}" (job #${job.id})` }));
  return NextResponse.json({ ok: true, job }, { status: 202 });
}
