import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { lionCampaignAds, lionConfigured, lionCreationStatus } from "@/lib/lion";

export const runtime = "nodejs";

const MAX_IDS = 100;
// Must cover a full duplicate wave (45 shots): the client's verify list is stable-ordered, so a
// smaller cap would permanently starve the tail — clones beyond the cut would never get their
// reality check while the head stays pending.
const MAX_VERIFY_IDS = 50;

/** Batched creation-status proxy — the HS task manager polls all its pending LION tasks in ONE
 *  call. camelCase-mapped; `error` flattened to the message string.
 *  `verifyCampaignIds` (optional) piggybacks a reality check: one details/ read answering
 *  whether those campaigns exist and how many ads they carry — the poller's antidote to LION
 *  task records that wedge in "creating" (or prune to NOT_FOUND) long after the launch actually
 *  landed (live 08-13). Its failure never sinks the status answer. */
export async function POST(req: Request): Promise<NextResponse> {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!lionConfigured()) {
    return NextResponse.json({ ok: false, error: "lion_not_configured" }, { status: 500 });
  }
  let body: { taskIds?: unknown; verifyCampaignIds?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  const ids = Array.isArray(body.taskIds)
    ? (body.taskIds as unknown[]).filter((v): v is string => typeof v === "string" && v.length > 0).slice(0, MAX_IDS)
    : [];
  if (ids.length === 0) {
    return NextResponse.json({ ok: false, error: "taskIds_required" }, { status: 400 });
  }
  const verifyIds = Array.isArray(body.verifyCampaignIds)
    ? (body.verifyCampaignIds as unknown[])
        .filter((v): v is string => typeof v === "string" && /^\d{5,}$/.test(v))
        .slice(0, MAX_VERIFY_IDS)
    : [];
  try {
    const [tasks, campaigns] = await Promise.all([
      lionCreationStatus(ids),
      verifyIds.length ? lionCampaignAds(verifyIds).catch(() => ({})) : Promise.resolve({}),
    ]);
    return NextResponse.json({
      ok: true,
      campaigns,
      tasks: tasks.map((t) => ({
        taskId: String(t.task_id ?? ""),
        status: String(t.status ?? ""),
        campaignId: t.campaign_id ? String(t.campaign_id) : null,
        adsetId: t.adset_id ? String(t.adset_id) : null,
        adIds: Array.isArray(t.ad_ids) ? t.ad_ids.map(String) : [],
        name: t.campaign_name ? String(t.campaign_name) : null,
        error: t.error?.message ? String(t.error.message) : null,
      })),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 502 });
  }
}
