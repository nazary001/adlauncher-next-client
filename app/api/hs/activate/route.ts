import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { activateRetryDelay } from "@/lib/activate-retry";
import { lionConfigured, lionSetCampaignStatus } from "@/lib/lion";
import { coll } from "@/lib/mongo";
import { LAUNCH_TASKS, STORE_TIMEOUT_MS, bounded, storeConfigured } from "@/lib/store";

export const runtime = "nodejs";
// One bounded store row read + the status flip, each repeated while LION answers "Campaign not
// found" for a newborn its own store has not synced yet (lib/activate-retry: up to 5 attempts 15 s
// apart, ~1 min) — then the last flip's own bound (2 × 60 s).
export const maxDuration = 300;

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
 *
 * The flip is PATIENT, like the server pumps' (duplicate, JURO): a single attempt raced LION's own
 * sync right after COMPLETED — the tab's call answered "Campaign not found" and stamped "activation
 * failed — flip it ACTIVE in LION" on a clone the pump activated seconds later (by 08.10 on 84 % of
 * the day's duplicate rows, 109 of 130; of 40 sampled in LION all 40 were ACTIVE). The gates are
 * re-read before EVERY attempt, so waiting never widens the window in which a gated clone could be
 * flipped — it narrows it (the pump has had time to stamp the row).
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

  for (let attempt = 1; ; attempt++) {
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
    // Only "not found" heals by waiting (the newborn is not in LION's store yet); every other
    // refusal — and the last attempt's — is the answer.
    const wait = activateRetryDelay(r, attempt);
    if (wait == null) return bad(`activate_failed: ${r.message ?? "unknown"}`, 502);
    await sleep(wait);
  }
}
