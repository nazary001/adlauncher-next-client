import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { lionConfigured, lionSetCampaignStatus } from "@/lib/lion";

export const runtime = "nodejs";
export const maxDuration = 30;

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

/**
 * Flip one LION campaign ACTIVE — the duplicate flow's last mile. A clone's birth status is
 * unpredictable (playbook: PAUSED in the morning, ACTIVE by afternoon), so the HS Task Manager
 * calls this once a duplicate task reaches COMPLETED; "already active" answers count as success.
 */
export async function POST(req: Request): Promise<NextResponse> {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return bad("unauthorized", 401);
  }
  if (!lionConfigured()) return bad("lion_not_configured", 500);

  let body: { campaignId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return bad("bad_json");
  }
  const campaignId = String(body.campaignId ?? "").trim();
  if (!/^\d{5,}$/.test(campaignId)) return bad("campaign_id_invalid");

  const r = await lionSetCampaignStatus(campaignId, "ACTIVE");
  if (r.ok) return NextResponse.json({ ok: true, alreadyActive: Boolean(r.alreadyActive) });
  return bad(`activate_failed: ${r.message ?? "unknown"}`, 502);
}
