import { NextResponse } from "next/server";
import { partnerConfig, type PartnerId } from "@/lib/partners";
import { FbError, fbPost } from "@/lib/fb-graph";
import { backfillGcm, claimGcm, deleteGcm } from "@/lib/gcm-claim";
import type { CloneEdit } from "@/lib/clone";
import {
  type LaunchBinds,
  type SourceDetail,
  adPayload,
  adsetPayload,
  campaignPayload,
  cloneCreativePayload,
  cloneToCampaign,
  fetchSourceDetail,
  resolveLocales,
} from "@/lib/clone-run";

export const runtime = "nodejs";
export const maxDuration = 300;

type Json = Record<string, unknown>;

/**
 * Create the ad set, self-healing the regional "universal ads" declarations Meta demands for
 * regulated locations in the audience (same behaviour as the launch route's createAdset).
 */
async function createAdset(path: string, payload: Json): Promise<Json> {
  const seed = payload.regional_regulated_categories;
  const cats = new Set<string>(Array.isArray(seed) ? (seed as string[]) : []);
  for (let attempt = 0; attempt < 8; attempt++) {
    const body: Json = cats.size ? { ...payload, regional_regulated_categories: [...cats] } : payload;
    try {
      return await fbPost(path, body);
    } catch (e) {
      const detail = (e as FbError).detail as
        | { error?: { error_user_title?: string; error_user_msg?: string } }
        | undefined;
      const text = `${detail?.error?.error_user_title ?? ""} ${detail?.error?.error_user_msg ?? ""}`;
      const m = /([A-Z][A-Z_]*_UNIVERSAL)/.exec(text);
      if (m && !cats.has(m[1])) {
        cats.add(m[1]);
        continue;
      }
      throw e;
    }
  }
  return fbPost(path, { ...payload, regional_regulated_categories: [...cats] });
}

/**
 * POST /api/clone/run  — body: { partnerId, edits: CloneEdit[] } (rows × copies, already flattened).
 *
 * Creates each clone on Facebook as a faithful PAUSED duplicate of its source: reuses the source's
 * video + copy/title/CTA (only the gcm in the tracking link is swapped for a freshly-claimed code),
 * rebuilds targeting/bid/budget from the buyer's edits, all through the launch payload builders.
 * Streams NDJSON per-clone/per-stage progress. Gated by the proxy (session required).
 */
export async function POST(req: Request) {
  let partnerId: PartnerId;
  let edits: CloneEdit[];
  try {
    const j = (await req.json()) as { partnerId?: string; edits?: CloneEdit[] };
    partnerId = String(j.partnerId ?? "in") as PartnerId;
    edits = Array.isArray(j.edits) ? j.edits : [];
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  if (edits.length === 0) return NextResponse.json({ ok: false, error: "no_clones" }, { status: 400 });
  if (edits.length > 200) return NextResponse.json({ ok: false, error: "too_many", max: 200 }, { status: 400 });

  const partner = partnerConfig(partnerId);
  // Enforce the locked binds server-side — never trust the client for account/page/pixel.
  const binds: LaunchBinds = {
    accountId: (partner.lockedAccount?.id ?? "").replace(/^act_/, ""),
    pageId: partner.lockedPage?.id ?? "",
    pixelId: partner.lockedPixel?.id ?? "",
  };
  if (!binds.accountId || !binds.pageId) {
    return NextResponse.json({ ok: false, error: "partner_not_launchable" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const detailCache = new Map<string, SourceDetail>();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (o: Json) => controller.enqueue(encoder.encode(JSON.stringify(o) + "\n"));
      let ok = 0;
      let failed = 0;

      for (let idx = 0; idx < edits.length; idx++) {
        const edit = edits[idx];
        let claim: { gcm: string; documentId: string | null } | null = null;
        const created: Json = {};
        try {
          send({ idx, stage: "start", name: edit.name });

          // Source detail — fetched once per source campaign, reused across its copies.
          let src = detailCache.get(edit.campaignId);
          if (!src) {
            send({ idx, stage: "source" });
            src = await fetchSourceDetail(edit.campaignId);
            detailCache.set(edit.campaignId, src);
          }
          if (!src.videoData.video_id) throw new FbError("source ad has no reusable video", src.videoData);

          send({ idx, stage: "gcm" });
          claim = await claimGcm("", { campaign_name: edit.name, notes: "claimed via adlauncher clone" });
          const gcm = claim.gcm;

          const campaign = cloneToCampaign(edit, src);
          const localeIds = await resolveLocales(edit.locales);

          send({ idx, stage: "campaign" });
          const camp = await fbPost(`act_${binds.accountId}/campaigns`, campaignPayload(campaign, edit.name));
          created.campaign_id = String(camp.id);

          send({ idx, stage: "adset" });
          const adset = await createAdset(
            `act_${binds.accountId}/adsets`,
            adsetPayload(campaign, edit.name, String(camp.id), binds, localeIds),
          );
          created.adset_id = String(adset.id);

          send({ idx, stage: "creative" });
          const creative = await fbPost(
            `act_${binds.accountId}/adcreatives`,
            cloneCreativePayload(edit.name, binds.pageId, src.videoData, gcm),
          );
          created.creative_id = String(creative.id);

          send({ idx, stage: "ad" });
          const ad = await fbPost(`act_${binds.accountId}/ads`, adPayload(edit.name, String(adset.id), String(creative.id)));
          created.ad_id = String(ad.id);

          await backfillGcm(claim.documentId, {
            campaign_id: created.campaign_id,
            adset_id: created.adset_id,
            ad_id: created.ad_id,
          });

          ok++;
          send({ idx, ok: true, stage: "done", gcm, ...created });
        } catch (e) {
          failed++;
          const err = e as FbError;
          // Free the gcm code when nothing was created; keep the row (marked failed) once a campaign
          // exists so the orphaned PAUSED campaign stays traceable — same policy as the launch route.
          if (claim?.documentId) {
            if (created.campaign_id) await backfillGcm(claim.documentId, { status: "failed", notes: `clone failed: ${err.message}` });
            else await deleteGcm(claim.documentId);
          }
          send({ idx, ok: false, stage: "error", error: err.message ?? String(e), detail: err.detail ?? null, created });
        }
      }

      send({ stage: "batch-done", ok, failed, total: edits.length });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
