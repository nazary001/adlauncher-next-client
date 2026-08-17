import { NextResponse } from "next/server";
import { type Campaign, bidAmountMissing, bidKind } from "@/lib/types";
import { AIF_PIXEL, type PartnerId, fullLandingUrl, partnerConfig } from "@/lib/partners";
import {
  type LaunchBinds,
  adPayload,
  adsetPayload,
  campaignPayload,
  creativePayload,
  imageCreativePayload,
  money,
} from "@/lib/fb-launch";
import { sessionFromCookieHeader } from "@/lib/session";
import { FbError, withFbBudget, withParentRetry } from "@/lib/fb-graph";
import { fetchValidatedImage } from "@/lib/fb-media";
import {
  aifAccountPixels,
  aifAdvertisablePageName,
  aifCreateAdset,
  aifFbGet,
  aifFbPost,
  aifIsAdvertisablePage,
  aifIsTokenAccount,
  aifTokenConfigured,
  aifUploadImage,
  aifUploadVideo,
  aifVideoThumb,
  aifWaitForVideo,
} from "@/lib/aif-launch";
import { backfillBrand, claimBrand, deleteBrand } from "@/lib/aif-claim";
import { taskWriter } from "@/lib/task-store";
import { del } from "@vercel/blob";

export const runtime = "nodejs";
export const maxDuration = 300;

type Json = Record<string, unknown>;

// Same per-launch FB retry budget as the MO route: rate-limited calls wait out Meta's regain
// estimate but never past the deadline — the hard failure must land INSIDE the function so the
// error path (brand release/retire, task row settle) always runs.
const FB_BUDGET_MS = 240_000;
const FB_BUDGET_RETRIES = 8;

// Bid strategies this rail rebuilds faithfully. Min-ROAS is DELIBERATELY absent: AIF conversions
// are postback→CAPI Purchases with value 0 — VALUE optimization would have nothing to optimize,
// so a roas card is rejected before any claim/write (the UI hides the strategy too).
const AIF_BID_STRATEGIES = new Set(["LOWEST_COST_WITHOUT_CAP", "LOWEST_COST_WITH_BID_CAP", "COST_CAP"]);

// A destination slug the RW page can serve: bare article slug, no slashes/spaces/query junk.
const SLUG_RE = /^[\w-]{1,200}$/;

// ---------- locale resolution (best-effort, non-fatal) — the AIF-token twin of /api/launch's ----------

const localeCache = new Map<string, number | null>();
async function resolveLocales(names: string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const raw of names) {
    if (/\(all\)/i.test(raw)) continue; // "all" = no language restriction (broadest)
    if (!localeCache.has(raw)) {
      try {
        const body = await aifFbGet(`search?type=adlocale&limit=25&q=${encodeURIComponent(raw.replace(/[()]/g, " ").trim())}`);
        const data = (body?.data as Array<{ key?: number; name?: string }> | undefined) ?? [];
        const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
        // Only accept an exact normalized-name match — never fall back to data[0], which would
        // silently target an arbitrary wrong language.
        const hit = data.find((d) => d.name && norm(d.name) === norm(raw));
        localeCache.set(raw, typeof hit?.key === "number" ? hit.key : null);
      } catch {
        localeCache.set(raw, null);
      }
    }
    const key = localeCache.get(raw);
    if (typeof key === "number") ids.push(key);
  }
  return [...new Set(ids)];
}

// ---------- orchestration ----------

/**
 * POST /api/aif/launch — the AIF (Airfind Rewarded Web) launch rail. Mirrors /api/launch stage
 * for stage (same NDJSON events, same Task Manager pipeline), with the rail's own pieces:
 * the tree is built on the AIF token, the marker comes from the BRAND registry (aif-maps,
 * test01..test700), the ad link is the partner's RW page with the destination slug, and the
 * pixel is derived server-side — conversions pin the AIF postback pixel + Purchase, clicks
 * carry no pixel at all.
 */
export async function POST(req: Request) {
  // Proxy-gated, but self-checks the session too (parity with /api/launch).
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) {
    return NextResponse.json({ ok: false, stage: "auth", error: "unauthorized" }, { status: 401 });
  }
  if (!aifTokenConfigured()) {
    return NextResponse.json(
      { ok: false, stage: "config", error: "no_aif_token — set FB_AIF_LAUNCH_TOKEN in the environment" },
      { status: 500 },
    );
  }

  let campaign: Campaign;
  let mediaUrl = "";
  let mediaKind: "video" | "image" = "video";
  let taskId: string | null = null;
  try {
    const j = (await req.json()) as {
      campaign?: Campaign;
      partnerId?: string;
      mediaUrl?: string;
      mediaKind?: string;
      taskId?: string;
    };
    campaign = (j.campaign ?? {}) as Campaign;
    mediaUrl = typeof j.mediaUrl === "string" ? j.mediaUrl : "";
    mediaKind = j.mediaKind === "image" ? "image" : "video";
    taskId = typeof j.taskId === "string" && /^[\w-]{6,64}$/.test(j.taskId) ? j.taskId : null;
  } catch (e) {
    return NextResponse.json({ ok: false, stage: "parse", error: String(e) }, { status: 400 });
  }

  const partner = partnerConfig("us" as PartnerId);
  const conversions = campaign.optimization === "conversions";
  // The account and fanka are the buyer's PICKS, validated against the AIF token's own data; the
  // pixel is never picked — it's derived from the optimization right here (server is the truth).
  const pickedAccount = String(campaign.account ?? "").trim().replace(/^act_/, "");
  const pickedPage = String(campaign.page ?? "").trim();
  const binds: LaunchBinds = {
    accountId: pickedAccount,
    pageId: pickedPage,
    pageName: "", // resolved below, once the picked page passes validation
    pixelId: conversions ? AIF_PIXEL.id : "",
  };

  try {
    if (!/^\d{5,}$/.test(pickedAccount)) {
      return NextResponse.json(
        { ok: false, stage: "config", error: "account_required — pick an ad account on the campaign card" },
        { status: 400 },
      );
    }
    if (!(await aifIsTokenAccount(pickedAccount))) {
      return NextResponse.json(
        { ok: false, stage: "config", error: "account_not_allowed — the AIF token cannot use this ad account" },
        { status: 400 },
      );
    }
    if (!/^\d{5,}$/.test(pickedPage)) {
      return NextResponse.json(
        { ok: false, stage: "config", error: "fanpage_required — pick a fanpage on the campaign card" },
        { status: 400 },
      );
    }
    if (!(await aifIsAdvertisablePage(pickedPage))) {
      return NextResponse.json(
        { ok: false, stage: "config", error: "fanpage_not_allowed — the AIF token cannot advertise with this page" },
        { status: 400 },
      );
    }
    // DSA beneficiary/payor for EU-reaching ad sets — same rule as MO (live failure 2026-08-10).
    binds.pageName = await aifAdvertisablePageName(pickedPage);
    // Conversion launches may only optimize on the AIF postback pixel, and that pixel must be
    // shared to the picked ad account in BM — otherwise Meta rejects the ad set AFTER the
    // campaign exists (orphan + burnt brand). Rejected here with the real remedy named.
    if (conversions) {
      const pixels = await aifAccountPixels(pickedAccount);
      if (!pixels.some((p) => p.id === AIF_PIXEL.id)) {
        return NextResponse.json(
          {
            ok: false,
            stage: "config",
            error: `pixel_not_on_account — share the AIF pixel ${AIF_PIXEL.id} to this ad account in Business Manager first (or launch with Clicks optimization)`,
          },
          { status: 400 },
        );
      }
    }
  } catch (e) {
    const err = e as { message?: string };
    return NextResponse.json(
      { ok: false, stage: "config", error: `destination check failed: ${err.message ?? String(e)}` },
      { status: 502 },
    );
  }

  // The destination is a free-typed article slug — the card sanitizes as you type, but the server
  // re-validates so a hostile/stale client can't smuggle a path or query into the RW link.
  const slug = String(campaign.landing ?? "").trim();
  if (!SLUG_RE.test(slug)) {
    return NextResponse.json(
      { ok: false, stage: "config", error: "destination_invalid — type the bare article slug (letters, digits, dashes)" },
      { status: 400 },
    );
  }
  if (!mediaUrl) {
    return NextResponse.json({ ok: false, stage: "media", error: "media_required" }, { status: 400 });
  }
  // The creative must be a Vercel Blob URL our OWN broker produced — same SSRF fence as /api/launch.
  {
    let host = "";
    let path = "";
    try {
      const u = new URL(mediaUrl);
      if (u.protocol === "https:") {
        host = u.hostname;
        path = u.pathname;
      }
    } catch {
      host = "";
    }
    if (!host.endsWith(".blob.vercel-storage.com") || !path.startsWith("/creatives/")) {
      return NextResponse.json({ ok: false, stage: "media", error: "media_url_invalid" }, { status: 400 });
    }
  }
  if (!AIF_BID_STRATEGIES.has(campaign.bidStrategy)) {
    const roas = bidKind(campaign.bidStrategy) === "roas";
    return NextResponse.json(
      {
        ok: false,
        stage: "config",
        error: roas
          ? "roas_not_supported — AIF conversions carry value 0 (postback CAPI), min-ROAS has nothing to optimize"
          : "bid_strategy_invalid",
      },
      { status: 400 },
    );
  }
  if (bidAmountMissing(campaign)) {
    return NextResponse.json(
      { ok: false, stage: "config", error: "Bid amount required for the selected bid strategy" },
      { status: 400 },
    );
  }
  if (!Array.isArray(campaign.countries) || campaign.countries.length === 0) {
    return NextResponse.json(
      { ok: false, stage: "config", error: "geo_required — pick at least one country" },
      { status: 400 },
    );
  }
  if (money(campaign.budget) < 100) {
    return NextResponse.json(
      { ok: false, stage: "config", error: "budget_too_low — daily budget must be at least $1" },
      { status: 400 },
    );
  }

  // Image launches: fetch + validate the creative BEFORE the stream (clean 400, nothing claimed).
  let imageBuf: Buffer | null = null;
  if (mediaKind === "image") {
    try {
      imageBuf = await fetchValidatedImage(mediaUrl);
    } catch (e) {
      return NextResponse.json(
        { ok: false, stage: "media", error: (e as FbError).message ?? String(e) },
        { status: 400 },
      );
    }
  }

  // Server-pinned invariants (the UI pins them too, but a stale/edited draft is the client's
  // word, not the truth): objective SALES, event Purchase — the only event the CAPI forwarder
  // ever sends into the AIF pixel.
  const serverCampaign: Campaign = { ...campaign, objective: "OUTCOME_SALES", conversionEvent: "PURCHASE" };
  const name = `${serverCampaign.namePrefix}${serverCampaign.name}`.trim();

  const encoder = new TextEncoder();
  const stream = withFbBudget({ deadlineAt: Date.now() + FB_BUDGET_MS, retries: FB_BUDGET_RETRIES }, () =>
    new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (o: Json) => controller.enqueue(encoder.encode(JSON.stringify(o) + "\n"));
      // Mirror progress into the shared launch-task row — the team keeps seeing the truth even
      // if this browser dies mid-run.
      const tw = taskWriter(session.username, taskId);
      let lastStage = "gcm";
      let settled = false; // set before the terminal write — the beat must never chain after it
      const progress = (stage: string) => {
        lastStage = stage;
        send({ stage });
        tw.write({ status: "running", stage });
      };
      const beat = setInterval(() => {
        if (!settled) tw.write({ status: "running", stage: lastStage });
      }, 30_000);
      const created: Json = {};
      let claim: { brand: string; documentId: string | null } | null = null;
      try {
        // 1) reserve the brand BEFORE building the link (guarantees no duplicate revenue key)
        progress("gcm");
        claim = await claimBrand(serverCampaign.gcm, {
          campaign_name: name,
          destination: slug,
          notes: "claimed via adlauncher launch",
        });
        const brand = claim.brand;
        const link = fullLandingUrl(partner, slug, brand, conversions);
        if (!link) throw new FbError("no destination — cannot build the RW link", {});

        // 2) register the creative on the AIF account (video: FB pulls from the Blob URL, then
        // processing is waited out; image: bytes → adimages hash).
        progress("video");
        let videoId = "";
        let thumbUrl = "";
        let imageHash = "";
        if (mediaKind === "image") {
          imageHash = await aifUploadImage(binds.accountId, imageBuf as Buffer); // validated pre-flight
          created.image_hash = imageHash;
        } else {
          videoId = await aifUploadVideo(binds.accountId, mediaUrl, `${name} · video`);
          created.video_id = videoId;
          progress("processing");
          await aifWaitForVideo(videoId);
          thumbUrl = await aifVideoThumb(videoId);
        }
        const localeIds = await resolveLocales(serverCampaign.locales);

        // 3) campaign → adset → creative → ad, all ACTIVE (parity with the MO rail)
        progress("campaign");
        const camp = await aifFbPost(`act_${binds.accountId}/campaigns`, campaignPayload(serverCampaign, name));
        created.campaign_id = String(camp.id);

        progress("adset");
        const adset = await withParentRetry(String(camp.id), () =>
          aifCreateAdset(`act_${binds.accountId}/adsets`, adsetPayload(serverCampaign, name, String(camp.id), binds, localeIds)),
        );
        created.adset_id = String(adset.id);

        progress("creative");
        const creative = await aifFbPost(
          `act_${binds.accountId}/adcreatives`,
          mediaKind === "image"
            ? imageCreativePayload(serverCampaign, name, binds, { imageHash, link })
            : creativePayload(serverCampaign, name, binds, { videoId, thumbUrl, link }),
        );
        created.creative_id = String(creative.id);

        progress("ad");
        const ad = await withParentRetry(String(adset.id), () =>
          aifFbPost(`act_${binds.accountId}/ads`, adPayload(name, String(adset.id), String(creative.id))),
        );
        // Belt over the fbPost error-body guard: never record a phantom "undefined" ad id.
        if (!ad.id) throw new FbError("ad create returned no id", ad);
        created.ad_id = String(ad.id);

        // 4) record the FB ids against the claimed brand (best-effort)
        await backfillBrand(claim.documentId, {
          campaign_id: created.campaign_id,
          adset_id: created.adset_id,
          ad_id: created.ad_id,
        });

        settled = true;
        tw.write({
          status: "done",
          stage: "ad",
          finished_at: Date.now(),
          campaign_id: created.campaign_id,
          adset_id: created.adset_id,
          ad_id: created.ad_id,
          link,
          gcm: brand, // the shared task row's marker column carries the brand on this rail
          error: null,
        });
        send({ ok: true, stage: "done", gcm: brand, link, page_id: binds.pageId, ...created });
      } catch (e) {
        const err = e as FbError;
        // Free the brand when nothing was created on FB (early failures) so the test01..test700
        // pool never leaks; keep the row (retired + noted) once a campaign exists so the orphaned
        // campaign stays traceable by brand.
        if (claim?.documentId) {
          if (created.campaign_id)
            await backfillBrand(claim.documentId, {
              status: "retired",
              notes: `launch failed: ${err.message}`,
              campaign_id: created.campaign_id,
              ...(created.adset_id ? { adset_id: created.adset_id } : {}),
            });
          else await deleteBrand(claim.documentId);
        }
        settled = true;
        tw.write({
          status: "error",
          stage: lastStage,
          finished_at: Date.now(),
          error: err.message ?? String(e),
          ...(created.campaign_id ? { campaign_id: created.campaign_id } : {}),
          ...(created.adset_id ? { adset_id: created.adset_id } : {}),
        });
        send({ ok: false, stage: "error", error: err.message ?? String(e), detail: err.detail ?? null, created });
      } finally {
        clearInterval(beat);
        // Drop the temporary Blob whether the launch succeeded or failed — never orphan the upload.
        await del(mediaUrl, { token: process.env.BLOB_READ_WRITE_TOKEN }).catch(() => {});
        await tw.flush();
        controller.close();
      }
    },
    }),
  );

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
