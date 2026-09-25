import { NextResponse, after } from "next/server";
import { ownerGate, toolError } from "@/lib/tool-sessions-gate";
import { cancelJob, getJob, jobEvents, retryJob, toolConfigured } from "@/lib/tool-sessions";
import { appendToolLog } from "@/lib/tool-sessions-log";
import { jobCanCancel, jobCanRetry, parseToolId, toJobEvent, toJobView } from "@/lib/tool-sessions-model";

export const runtime = "nodejs";

const notConfigured = () => NextResponse.json({ ok: false, error: "not_configured", message: "TOOL_SESSIONS_API_KEY is not set on this deployment" }, { status: 500 });
const badId = () => NextResponse.json({ ok: false, error: "bad_id", message: "job id must be a positive integer" }, { status: 400 });

/**
 * One TOOL job, owner-only.
 * GET  → { ok, job: ToolJobView, events: ToolJobEvent[] } (events best-effort: `eventsError`)
 * POST → { op: "retry" | "cancel" } → { ok, job }. TOOL's rules are checked here first so a
 *        stale button gets a clear 409 instead of a bare upstream 400: retry takes error/unknown,
 *        cancel takes queued/retry.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = ownerGate(req);
  if (g instanceof NextResponse) return g;
  if (!toolConfigured()) return notConfigured();
  const id = parseToolId((await ctx.params).id);
  if (!id) return badId();
  const [job, events] = await Promise.all([getJob(id), jobEvents(id)]);
  if (!job.ok) return toolError(job);
  return NextResponse.json({ ok: true, job: toJobView(job.data), events: events.ok && Array.isArray(events.data) ? events.data.map(toJobEvent) : [], eventsError: events.ok ? null : events.message, now: Date.now() });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = ownerGate(req);
  if (g instanceof NextResponse) return g;
  if (!toolConfigured()) return notConfigured();
  const id = parseToolId((await ctx.params).id);
  if (!id) return badId();
  const body = (await req.json().catch(() => null)) as { op?: unknown } | null;
  const op = String(body?.op ?? "");
  if (op !== "retry" && op !== "cancel") return NextResponse.json({ ok: false, error: "unknown_op", message: "op must be retry or cancel" }, { status: 400 });
  const current = await getJob(id);
  if (!current.ok) return toolError(current);
  const cur = toJobView(current.data);
  if (op === "retry" && !jobCanRetry(cur.status)) return NextResponse.json({ ok: false, error: "not_retryable", message: `job #${id} is ${cur.status} — only error / unknown jobs can be retried` }, { status: 409 });
  if (op === "cancel" && !jobCanCancel(cur.status)) return NextResponse.json({ ok: false, error: "not_cancelable", message: `job #${id} is ${cur.status} — only queued / retry jobs can be canceled` }, { status: 409 });
  if (op === "retry") {
    const r = await retryJob(id);
    if (!r.ok) return toolError(r);
    const job = toJobView(r.data);
    after(() => appendToolLog({ by: g.username, kind: "job", sessionId: cur.session_id, name: "", text: `Retried job #${id} (${cur.kind})` }));
    return NextResponse.json({ ok: true, job });
  }
  const r = await cancelJob(id);
  if (!r.ok) return toolError(r);
  const refreshed = await getJob(id);
  after(() => appendToolLog({ by: g.username, kind: "job", sessionId: cur.session_id, name: "", text: `Canceled job #${id} (${cur.kind})` }));
  return NextResponse.json({ ok: true, job: refreshed.ok ? toJobView(refreshed.data) : { ...cur, status: "canceled" } });
}
