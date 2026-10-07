import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { lionConfigured, lionSetCampaignStatus } from "@/lib/lion";
import { coll } from "@/lib/mongo";
import { LAUNCH_TASKS, STORE_TIMEOUT_MS, bounded, storeConfigured } from "@/lib/store";

export const runtime = "nodejs";
// One LION status flip (60s-bounded, retried once) + one bounded store row read.
export const maxDuration = 60;

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

/**
 * The geo gate: the duplicate pump stamps a geo-override clone's task row with stage "geo-gate"
 * until its Graph targeting patch is VERIFIED in ("patched"). Activating a gated clone would put
 * spend on the SOURCE's countries — the exact miss the override flow exists to prevent (review
 * find 08-24: the client poller used to flip any COMPLETED duplicate with no patch awareness).
 * Fail-open on a store blip: ordinary duplicates must still activate, and the pump + client
 * belts keep gated clones paused regardless.
 */
async function overrideGated(campaignId: string): Promise<"" | "geo-gate" | "bid-gate"> {
  if (!storeConfigured()) return "";
  try {
    const c = await coll(LAUNCH_TASKS);
    const row = await bounded(
      c.findOne({ campaign_id: campaignId, partner: "br" }, { sort: { updatedAt: -1 }, projection: { _id: 0, stage: 1 }, maxTimeMS: STORE_TIMEOUT_MS }),
      "launch-task read",
    );
    const stage = String(row?.stage ?? "");
    // geo-gate: the override patch hasn't landed; bid-gate: LION resolved other bidding than
    // requested (duplicate v2 read-back) — both keep the clone PAUSED until a human looks.
    return stage === "geo-gate" || stage === "bid-gate" ? stage : "";
  } catch {
    return "";
  }
}

/**
 * Flip one LION campaign ACTIVE — the duplicate flow's last mile. A clone's birth status is
 * unpredictable (playbook: PAUSED in the morning, ACTIVE by afternoon), so the HS Task Manager
 * calls this once a duplicate task reaches COMPLETED; "already active" answers count as success.
 * Geo-override clones are refused until their row says the targeting patch landed.
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

  const gate = await overrideGated(campaignId);
  if (gate === "geo-gate") {
    return bad(
      "override_not_patched — this clone's geo override has not landed yet; it stays PAUSED (the pump activates it after the patch, or set the targeting in Ads Manager and activate there)",
      409,
    );
  }
  if (gate === "bid-gate") {
    return bad(
      "bid_gate — LION resolved other bidding than requested for this clone; it stays PAUSED until its bid strategy / goal is verified in LION or Ads Manager and activated there",
      409,
    );
  }

  const r = await lionSetCampaignStatus(campaignId, "ACTIVE");
  if (r.ok) return NextResponse.json({ ok: true, alreadyActive: Boolean(r.alreadyActive) });
  return bad(`activate_failed: ${r.message ?? "unknown"}`, 502);
}
