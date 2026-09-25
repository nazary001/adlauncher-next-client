import { NextResponse } from "next/server";
import { ownerGate, toolError } from "@/lib/tool-sessions-gate";
import { listJobs, toolConfigured } from "@/lib/tool-sessions";
import { normalizeJobFilters, toJobView } from "@/lib/tool-sessions-model";

export const runtime = "nodejs";

/**
 * GET ?session_id=&kind=&status=&limit=&offset= → { ok, rows: ToolJobView[], total, filters }
 * The team's TOOL jobs (session checks, campaign creates, duplicates, media uploads) — the
 * board's Jobs tab and the per-session drawer. Unknown filter values are dropped, not refused.
 */
export async function GET(req: Request) {
  const g = ownerGate(req);
  if (g instanceof NextResponse) return g;
  if (!toolConfigured()) return NextResponse.json({ ok: false, error: "not_configured", message: "TOOL_SESSIONS_API_KEY is not set on this deployment" }, { status: 500 });
  const q = Object.fromEntries(new URL(req.url).searchParams.entries());
  const filters = normalizeJobFilters(q);
  const r = await listJobs(filters);
  if (!r.ok) return toolError(r);
  return NextResponse.json({ ok: true, rows: r.data.rows.map(toJobView), total: r.data.total, filters, now: Date.now() });
}
