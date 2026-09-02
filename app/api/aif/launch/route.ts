import { NextResponse } from "next/server";
import { type Campaign, bidAmountMissing, bidKind, normalizeRoasGoal, parseMoney } from "@/lib/types";
import { type PartnerId, fullLandingUrl, partnerConfig } from "@/lib/partners";
import {
  type LaunchBinds,
  SUPPORTED_BID_STRATEGIES,
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
  aifAccountName,
  aifAdvertisablePageName,
  aifCreateAdset,
  aifDerivedPixel,
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
import { claimAcctSlot, releaseAcctSlot } from "@/lib/acct-limit";
import { ACCOUNT_NOT_ASSIGNED_MSG, accountAllowedFor } from "@/lib/acct-assignments";
import { reportPagesUsed } from "@/lib/hs-pages";
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
        // Transient throttle/network — do NOT cache: a permanent null here would silently drop
        // this language from every later launch of the instance (broader targeting). The name
        // resolves again on the next launch; only a CONFIRMED no-match is cached above.
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
 * pixel is derived server-side — conversions carry the picked account's own postback pixel,
 * pulled LIVE via the token (aifDerivedPixel, no hardcoded id) + Purchase; clicks carry no
 * pixel at all. Min-ROAS (enabled 2026-08-21) is a conversion launch on that same derived
 * pixel — fb-launch pins goal VALUE + the ×10000 roas_average_floor, recipe identical to MO's.
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
  let coverUrl = "";
  let taskId: string | null = null;
  try {
    const j = (await req.json()) as {
      campaign?: Campaign;
      partnerId?: string;
      mediaUrl?: string;
      mediaKind?: string;
      /** Custom cover image for a video creative (own-Blob URL) — pinned as the thumbnail. */
      coverUrl?: string;
      taskId?: string;
    };
    campaign = (j.campaign ?? {}) as Campaign;
    mediaUrl = typeof j.mediaUrl === "string" ? j.mediaUrl : "";
    mediaKind = j.mediaKind === "image" ? "image" : "video";
    coverUrl = mediaKind === "video" && typeof j.coverUrl === "string" ? j.coverUrl.trim() : "";
    taskId = typeof j.taskId === "string" && /^[\w-]{6,64}$/.test(j.taskId) ? j.taskId : null;
  } catch (e) {
    return NextResponse.json({ ok: false, stage: "parse", error: String(e) }, { status: 400 });
  }

  const partner = partnerConfig("us" as PartnerId);
  // Min-ROAS ALWAYS optimizes purchase value (goal VALUE, event Purchase — fb-launch pins both),
  // so it derives the postback pixel like any conversion launch, no matter what optimization a
  // stale/edited draft sent — the UI pins it, but the server is the truth (mirror of /api/launch).
  const conversions = campaign.optimization === "conversions" || bidKind(campaign.bidStrategy) === "roas";
  // The account and fanka are the buyer's PICKS, validated against the AIF token's own data; the
  // pixel is never picked — it's derived from the optimization right here (server is the truth).
  const pickedAccount = String(campaign.account ?? "").trim().replace(/^act_/, "");
  const pickedPage = String(campaign.page ?? "").trim();
  const binds: LaunchBinds = {
    accountId: pickedAccount,
    pageId: pickedPage,
    pageName: "", // resolved below, once the picked page passes validation
    pixelId: "", // conversions derive it below, from the token's own account data
  };
  // Fire-time belt over the picker filter: /accounts assignments hold even for a crafted POST.
  if (!(await accountAllowedFor(session, pickedAccount))) {
    return NextResponse.json({ ok: false, stage: "config", error: ACCOUNT_NOT_ASSIGNED_MSG }, { status: 403 });
  }

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
    // Conversion launches optimize on the account's own postback pixel, derived LIVE from the
    // token's data (aifDerivedPixel — no hardcoded id, owner ask 2026-09-02). An account with
    // no derivable pixel throws a 400-shaped FbError naming the BM remedy — refused here,
    // BEFORE anything is claimed, else Meta rejects the ad set AFTER the campaign exists
    // (orphan + burnt brand).
    if (conversions) {
      binds.pixelId = (await aifDerivedPixel(pickedAccount)).id;
    }
  } catch (e) {
    const err = e as FbError;
    if (err instanceof FbError && err.status === 400) {
      return NextResponse.json({ ok: false, stage: "config", error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      { ok: false, stage: "config", error: `destination check failed: ${err.message ?? String(e)}` },
      { status: 502 },
    );
  }

  // The destination must be one of the partner's STANDARD articles (owner list in
  // lib/partners AIF_LANDINGS) — same contract as MO's landing catalog: a stale/renamed slug
  // from a restored draft would build a live ad pointing at a dead article. The shape check
  // stays as a belt (the RW link must never carry a path or query junk).
  const slug = String(campaign.landing ?? "").trim();
  if (!SLUG_RE.test(slug) || !partner.landings.some((l) => l.slug === slug)) {
    return NextResponse.json(
      { ok: false, stage: "config", error: "destination_invalid — pick a standard article on the campaign card" },
      { status: 400 },
    );
  }
  if (!mediaUrl) {
    return NextResponse.json({ ok: false, stage: "media", error: "media_required" }, { status: 400 });
  }
  // Same contract as /api/launch: a video creative's destination link lives inside its CTA
  // (creativePayload) — a "No CTA" video would ship link-less (review find 08-24).
  if (!String(campaign.cta ?? "").trim() && mediaKind === "video") {
    return NextResponse.json(
      {
        ok: false,
        stage: "media",
        error: "cta_required_for_video — pick a CTA button (its link is the video ad's destination); image cards may keep No CTA",
      },
      { status: 400 },
    );
  }
  // The creative must be a Vercel Blob URL our OWN broker produced — same SSRF fence as /api/launch.
  {
    const ownBlob = (raw: string): boolean => {
      try {
        const u = new URL(raw);
        return u.protocol === "https:" && u.hostname.endsWith(".blob.vercel-storage.com") && u.pathname.startsWith("/creatives/");
      } catch {
        return false;
      }
    };
    if (!ownBlob(mediaUrl)) {
      return NextResponse.json({ ok: false, stage: "media", error: "media_url_invalid" }, { status: 400 });
    }
    if (coverUrl && !ownBlob(coverUrl)) {
      return NextResponse.json({ ok: false, stage: "media", error: "cover_url_invalid" }, { status: 400 });
    }
  }
  if (!SUPPORTED_BID_STRATEGIES.has(campaign.bidStrategy)) {
    return NextResponse.json({ ok: false, stage: "config", error: "bid_strategy_invalid" }, { status: 400 });
  }
  if (bidAmountMissing(campaign)) {
    return NextResponse.json(
      { ok: false, stage: "config", error: "Bid amount required for the selected bid strategy" },
      { status: 400 },
    );
  }
  // Mirror /api/launch: a min-ROAS goal above 100 (10 000%) is a typo, not a bid, and the
  // ambiguous 10–20 band is refused rather than guessed (normalizeRoasGoal). Rejected here so no
  // campaign/brand exists yet (Meta would only refuse at the ad-set step, orphaning both).
  if (bidKind(campaign.bidStrategy) === "roas") {
    const goal = parseMoney(campaign.bidCap);
    if (goal > 100) {
      return NextResponse.json(
        { ok: false, stage: "config", error: "roas_goal_invalid — ROAS goal must be 0–100" },
        { status: 400 },
      );
    }
    if (normalizeRoasGoal(goal) == null) {
      return NextResponse.json(
        { ok: false, stage: "config", error: "roas_goal_ambiguous — type the decimal goal (0,30 = 30%)" },
        { status: 400 },
      );
    }
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

  // Image launches + custom video covers: fetch + validate BEFORE the stream (clean 400,
  // nothing claimed).
  let imageBuf: Buffer | null = null;
  let coverBuf: Buffer | null = null;
  try {
    if (mediaKind === "image") imageBuf = await fetchValidatedImage(mediaUrl);
    if (coverUrl) coverBuf = await fetchValidatedImage(coverUrl);
  } catch (e) {
    return NextResponse.json(
      { ok: false, stage: "media", error: (e as FbError).message ?? String(e) },
      { status: 400 },
    );
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
      // if this browser dies mid-run. partner="us" on every write: the row must land in the AIF
      // drawer's scope even when this writer is the one that creates it.
      const tw = taskWriter(session.username, taskId, { partner: "us" });
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
      let acctSlot: { documentId: string } | null = null;
      try {
        // 0) claim the ACCOUNT's launch slot — at most 5 campaigns per ad account per 30-min
        // window, across every user and channel (owner rule 2026-08-18). Released below on any
        // pre-campaign failure.
        progress("gcm");
        acctSlot = await claimAcctSlot(binds.accountId, {
          user: session.username,
          partner: "us",
          channel: "aif",
          name,
          accountName: await aifAccountName(binds.accountId).catch(() => ""),
        });

        // 1) reserve the brand BEFORE building the link (guarantees no duplicate revenue key)
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
        let coverHash = "";
        if (mediaKind === "image") {
          imageHash = await aifUploadImage(binds.accountId, imageBuf as Buffer); // validated pre-flight
          created.image_hash = imageHash;
        } else {
          videoId = await aifUploadVideo(binds.accountId, mediaUrl, `${name} · video`);
          created.video_id = videoId;
          progress("processing");
          await aifWaitForVideo(videoId);
          // A custom cover replaces the auto-thumbnail entirely (no thumbnail poll needed).
          if (coverBuf) coverHash = await aifUploadImage(binds.accountId, coverBuf);
          else thumbUrl = await aifVideoThumb(videoId);
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
            : creativePayload(serverCampaign, name, binds, { videoId, thumbUrl, link, ...(coverHash ? { coverHash } : {}) }),
        );
        created.creative_id = String(creative.id);

        progress("ad");
        const ad = await withParentRetry(String(adset.id), () =>
          aifFbPost(`act_${binds.accountId}/ads`, adPayload(name, String(adset.id), String(creative.id))),
        );
        // Belt over the fbPost error-body guard: never record a phantom "undefined" ad id.
        if (!ad.id) throw new FbError("ad create returned no id", ad);
        created.ad_id = String(ad.id);

        // 4) tell the hs-tools pages registry (AIF scope — inert until the box syncs AIF pages)
        // + record the FB ids against the claimed brand (best-effort)
        await reportPagesUsed("us", [{ pageId: binds.pageId, delta: 1 }]);
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
        // Free the account's launch slot when NO campaign was created — the window only meters
        // campaigns that actually exist on FB. Once one exists the slot stays consumed.
        if (acctSlot && !created.campaign_id) await releaseAcctSlot(acctSlot.documentId);
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
        if (coverUrl) await del(coverUrl, { token: process.env.BLOB_READ_WRITE_TOKEN }).catch(() => {});
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
