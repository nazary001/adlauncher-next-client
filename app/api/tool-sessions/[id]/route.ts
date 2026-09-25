import { NextResponse, after } from "next/server";
import { ownerGate, toolError } from "@/lib/tool-sessions-gate";
import { deleteSession, getSession, listJobs, sessionEvents, toolConfigured, updateSession } from "@/lib/tool-sessions";
import { appendToolLog } from "@/lib/tool-sessions-log";
import { type UpdateInput, maskProxy, parseToolId, toJobView, toSession, toSessionEvent, toSessionRow, validateSessionUpdate } from "@/lib/tool-sessions-model";

export const runtime = "nodejs";
export const maxDuration = 60;

const notConfigured = () => NextResponse.json({ ok: false, error: "not_configured", message: "TOOL_SESSIONS_API_KEY is not set on this deployment" }, { status: 500 });
const badId = () => NextResponse.json({ ok: false, error: "bad_id", message: "session id must be a positive integer" }, { status: 400 });

/**
 * One session, owner-only.
 *
 * GET    → { ok, session (WITH its accounts), events, jobs: {rows, total}, partial: string[] }
 *          The three reads run together; a failing history or jobs read is reported in `partial`
 *          instead of failing the whole drawer (the session itself must load).
 * PATCH  → the update form (token / cookies / user_agent / proxy / profile_slug / account_ids /
 *          clear_account_ids / accept_language / status / check_now) → ONLY the filled fields go
 *          to TOOL (SessionUpdate is a subset patch) → { ok, session, changed }.
 * DELETE → { ok } — TOOL forgets the session (its jobs stay in the tool's history).
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = ownerGate(req);
  if (g instanceof NextResponse) return g;
  if (!toolConfigured()) return notConfigured();
  const id = parseToolId((await ctx.params).id);
  if (!id) return badId();
  const [session, events, jobs] = await Promise.all([getSession(id), sessionEvents(id, 100), listJobs({ session_id: id, limit: 50 })]);
  if (!session.ok) return toolError(session);
  const partial: string[] = [];
  if (!events.ok) partial.push(`history: ${events.message}`);
  if (!jobs.ok) partial.push(`jobs: ${jobs.message}`);
  return NextResponse.json({
    ok: true,
    session: toSession(session.data),
    events: events.ok && Array.isArray(events.data) ? events.data.map(toSessionEvent) : [],
    jobs: jobs.ok ? { rows: jobs.data.rows.map(toJobView), total: jobs.data.total } : { rows: [], total: 0 },
    partial,
    now: Date.now(),
  });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = ownerGate(req);
  if (g instanceof NextResponse) return g;
  if (!toolConfigured()) return notConfigured();
  const id = parseToolId((await ctx.params).id);
  if (!id) return badId();
  const input = (await req.json().catch(() => null)) as UpdateInput | null;
  if (!input || typeof input !== "object") return NextResponse.json({ ok: false, error: "bad_json", message: "the body must be a JSON object" }, { status: 400 });
  const v = validateSessionUpdate(input);
  if (!v.ok) return NextResponse.json({ ok: false, error: "validation_failed", message: v.error, field: v.field }, { status: 400 });
  const r = await updateSession(id, v.body);
  if (!r.ok) return toolError(r);
  if (!r.data || typeof r.data !== "object") return NextResponse.json({ ok: false, error: "bad_answer", message: "TOOL applied the update but answered without the session — reload the list" }, { status: 502 });
  const s = toSession(r.data);
  // The log line names WHAT changed, never the values (a masked proxy host is the one exception —
  // TOOL shows the same mask).
  const statusOnly = v.changed.length === 1 && v.changed[0] === "status";
  const text = statusOnly
    ? `${v.body.status === "disabled" ? "Disabled" : "Enabled"} session "${s.name}"${v.body.check_now && v.body.status === "active" ? " — check queued" : ""}`
    : `Updated session "${s.name}" — ${v.changed.map((c) => (c === "proxy" && v.body.proxy ? `proxy → ${maskProxy(v.body.proxy)}` : c === "account_ids" ? (v.body.account_ids?.length ? `${v.body.account_ids.length} account${v.body.account_ids.length === 1 ? "" : "s"} only` : "account restriction lifted") : c)).join(", ")}${v.body.check_now ? " — check queued" : ""}`;
  after(() => appendToolLog({ by: g.username, kind: statusOnly ? "status" : "update", sessionId: s.id, name: s.name, text }));
  return NextResponse.json({ ok: true, session: toSessionRow(s), changed: v.changed });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = ownerGate(req);
  if (g instanceof NextResponse) return g;
  if (!toolConfigured()) return notConfigured();
  const id = parseToolId((await ctx.params).id);
  if (!id) return badId();
  // Read the name first so the log line can say which session went (best-effort).
  const before = await getSession(id);
  const r = await deleteSession(id);
  if (!r.ok) return toolError(r);
  const name = before.ok ? toSession(before.data).name : `#${id}`;
  after(() => appendToolLog({ by: g.username, kind: "delete", sessionId: id, name, text: `Deleted session "${name}"` }));
  return NextResponse.json({ ok: true, id, name });
}
