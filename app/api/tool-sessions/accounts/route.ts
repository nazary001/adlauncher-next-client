import { NextResponse } from "next/server";
import { ownerGate, toolError } from "@/lib/tool-sessions-gate";
import { teamAccounts, toolConfigured } from "@/lib/tool-sessions";
import { toTeamAccount } from "@/lib/tool-sessions-model";

export const runtime = "nodejs";

/**
 * GET → { ok, accounts: ToolTeamAccount[] } — every ad account the team's sessions see (from
 * their last checks), each with the sessions that see it. The board's Accounts tab.
 */
export async function GET(req: Request) {
  const g = ownerGate(req);
  if (g instanceof NextResponse) return g;
  if (!toolConfigured()) return NextResponse.json({ ok: false, error: "not_configured", message: "TOOL_SESSIONS_API_KEY is not set on this deployment" }, { status: 500 });
  const r = await teamAccounts();
  if (!r.ok) return toolError(r);
  const accounts = Array.isArray(r.data?.accounts) ? r.data.accounts.map(toTeamAccount) : [];
  return NextResponse.json({ ok: true, accounts, now: Date.now() });
}
