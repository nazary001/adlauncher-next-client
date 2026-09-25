import { NextResponse, after } from "next/server";
import { ownerGate, toolError } from "@/lib/tool-sessions-gate";
import { createSession, listSessions, toolConfigured, toolHost, toolMe } from "@/lib/tool-sessions";
import { appendToolLog, readToolLog } from "@/lib/tool-sessions-log";
import { type CreateInput, toSession, toSessionRow, validateSessionCreate } from "@/lib/tool-sessions-model";

export const runtime = "nodejs";
// A create with check_now waits on TOOL's own validation before it answers — give it headroom.
export const maxDuration = 60;

/**
 * Owner-only TOOL Sessions console (feeds /sessions) — owner ask 2026-09-25.
 *
 * GET  → { ok, configured, host, me, sessions: ToolSessionRow[] (no account lists), log, now }
 *        `configured:false` is a 200 with an empty list — the page renders the setup notice.
 * POST → the create form ({ name, kind, token, cookies, user_agent, proxy, profile_slug,
 *        account_ids, accept_language, check_now }) → validated here (lib/tool-sessions-model),
 *        forwarded to TOOL → { ok, session, warnings }. Secrets pass straight through: never
 *        stored here, never logged, never echoed back.
 */
export async function GET(req: Request) {
  const g = ownerGate(req);
  if (g instanceof NextResponse) return g;
  if (!toolConfigured()) {
    return NextResponse.json({ ok: true, configured: false, host: toolHost(), me: null, sessions: [], log: [], now: Date.now() });
  }
  const status = new URL(req.url).searchParams.get("status") || undefined;
  const [list, me, log] = await Promise.all([listSessions(status), toolMe(), readToolLog()]);
  if (!list.ok) return toolError(list);
  return NextResponse.json({
    ok: true,
    configured: true,
    host: toolHost(),
    me: me.ok ? me.data : null,
    meError: me.ok ? null : me.message,
    sessions: (Array.isArray(list.data) ? list.data : []).map(toSessionRow),
    log,
    now: Date.now(),
  });
}

export async function POST(req: Request) {
  const g = ownerGate(req);
  if (g instanceof NextResponse) return g;
  if (!toolConfigured()) return NextResponse.json({ ok: false, error: "not_configured", message: "TOOL_SESSIONS_API_KEY is not set on this deployment" }, { status: 500 });
  const input = (await req.json().catch(() => null)) as CreateInput | null;
  if (!input || typeof input !== "object") return NextResponse.json({ ok: false, error: "bad_json", message: "the body must be a JSON object" }, { status: 400 });
  const v = validateSessionCreate(input);
  if (!v.ok) return NextResponse.json({ ok: false, error: "validation_failed", message: v.error, field: v.field }, { status: 400 });
  const r = await createSession(v.body);
  if (!r.ok) return toolError(r);
  if (!r.data || typeof r.data !== "object") return NextResponse.json({ ok: false, error: "bad_answer", message: "TOOL accepted the session but answered without it — reload the list" }, { status: 502 });
  const s = toSession(r.data);
  after(() => appendToolLog({
    by: g.username,
    kind: "create",
    sessionId: s.id,
    name: s.name,
    text: `Added session "${s.name}" (${v.body.kind}${v.body.proxy ? ", with proxy" : ""}${v.body.account_ids?.length ? `, ${v.body.account_ids.length} account${v.body.account_ids.length === 1 ? "" : "s"} only` : ""})${v.body.check_now ? " — check queued" : ""}`,
  }));
  return NextResponse.json({ ok: true, session: toSessionRow(s), warnings: v.warnings }, { status: 201 });
}
