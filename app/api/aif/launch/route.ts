import { NextResponse } from "next/server";
import { type Campaign, bidAmountMissing, bidKind, normalizeRoasGoal, parseMoney } from "@/lib/types";
import { AIF_VALUE_PIXEL, type PartnerId, aifOfferablePixels, fullLandingUrl, partnerConfig, pickAifPixel } from "@/lib/partners";
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
 * for stage (same NDJSON events, same Task Manager pipeline, up to 5 creatives per campaign —
 * one campaign → one ad set → one ad per creative, 09-02), with the rail's own pieces:
 * the tree is built on the AIF token, the marker comes from the BRAND registry (aif-maps,
 * test01..test700), the ad link is the partner's RW page with the destination slug, and the
 * pixel comes from the cabinet's OFFERABLE list (token catalog minus retired — owner call
 * 09-02 pt3): min-ROAS pins the rail's value pixel VD-C1-HS-11, plain conversions bind the
 * buyer's pick (or the pickAifPixel auto-default), and the bound pixel rides the RW link's
 * &pixel= param so the postback→CAPI forwarder lands the Purchase on the same pixel. Clicks
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
  /** Creatives of this launch (1..maxCreatives, MO-parity 09-02): own-Blob URLs; cover = video
   *  thumbnail image. */
  let medias: { url: string; kind: "video" | "image"; coverUrl: string }[] = [];
  let taskId: string | null = null;
  try {
    const j = (await req.json()) as {
      campaign?: Campaign;
      partnerId?: string;
      /** Multi-creative shape (5-creative AIF, 09-02 — the runner already sends it). */
      medias?: { url?: string; kind?: string; coverUrl?: string }[];
      /** Single-creative fields — the pre-multi wire, still sent (and accepted) for open tabs
       *  and restored queued tasks. */
      mediaUrl?: string;
      mediaKind?: string;
      coverUrl?: string;
      taskId?: string;
    };
    campaign = (j.campaign ?? {}) as Campaign;
    if (Array.isArray(j.medias) && j.medias.length > 0) {
      medias = j.medias.slice(0, 10).map((m) => {
        const kind = m?.kind === "image" ? ("image" as const) : ("video" as const);
        return {
          url: typeof m?.url === "string" ? m.url : "",
          kind,
          coverUrl: kind === "video" && typeof m?.coverUrl === "string" ? m.coverUrl.trim() : "",
        };
      });
    } else {
      const url = typeof j.mediaUrl === "string" ? j.mediaUrl : "";
      const kind = j.mediaKind === "image" ? ("image" as const) : ("video" as const);
      medias = [
        { url, kind, coverUrl: kind === "video" && typeof j.coverUrl === "string" ? j.coverUrl.trim() : "" },
      ];
    }
    taskId = typeof j.taskId === "string" && /^[\w-]{6,64}$/.test(j.taskId) ? j.taskId : null;
  } catch (e) {
    return NextResponse.json({ ok: false, stage: "parse", error: String(e) }, { status: 400 });
  }

  const partner = partnerConfig("us" as PartnerId);
  // Min-ROAS ALWAYS optimizes purchase value (goal VALUE, event Purchase — fb-launch pins both),
  // so it derives the postback pixel like any conversion launch, no matter what optimization a
  // stale/edited draft sent — the UI pins it, but the server is the truth (mirror of /api/launch).
  const conversions = campaign.optimization === "conversions" || bidKind(campaign.bidStrategy) === "roas";
  // The account, fanka and pixel are the buyer's PICKS, validated against the AIF token's own
  // data below (the pixel only binds on conversion launches; empty → auto-derived).
  const pickedAccount = String(campaign.account ?? "").trim().replace(/^act_/, "");
  const pickedPage = String(campaign.page ?? "").trim();
  const binds: LaunchBinds = {
    accountId: pickedAccount,
    pageId: pickedPage,
    pageName: "", // resolved below, once the picked page passes validation
    pixelId: "", // conversions bind the validated pick below (or the auto-derived fallback)
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
    // Conversion launches run on the cabinet's OFFERABLE pixels (token catalog minus the
    // retired «GC for AIF» / «GC for MO» — owner call 09-02 pt3), validated here BEFORE
    // anything is claimed (Meta would only reject the ad set after the campaign exists —
    // orphan + burnt brand). Min-ROAS pins the rail's value pixel VD-C1-HS-11 (VO-probed
    // eligible 09-02) no matter what the draft sent; a plain conversion binds the buyer's pick
    // or the pickAifPixel auto-default (fresh cards, legacy drafts, queued tasks).
    if (conversions) {
      const raw = await aifAccountPixels(pickedAccount);
      const offer = aifOfferablePixels(raw);
      if (bidKind(campaign.bidStrategy) === "roas") {
        if (!offer.some((p) => p.id === AIF_VALUE_PIXEL.id)) {
          return NextResponse.json(
            {
              ok: false,
              stage: "config",
              error: `pixel_not_on_account — min-ROAS runs only on ${AIF_VALUE_PIXEL.name} (${AIF_VALUE_PIXEL.id}); share it to this ad account in Business Manager first`,
            },
            { status: 400 },
          );
        }
        binds.pixelId = AIF_VALUE_PIXEL.id;
      } else {
        const picked = String(campaign.pixel ?? "").trim();
        if (picked && !/^\d{10,20}$/.test(picked)) {
          return NextResponse.json({ ok: false, stage: "config", error: "pixel_invalid — bad pixel id" }, { status: 400 });
        }
        const bound = picked ? offer.find((p) => p.id === picked) : pickAifPixel(raw);
        if (!bound) {
          return NextResponse.json(
            {
              ok: false,
              stage: "config",
              error: picked
                ? `pixel_not_available — this cabinet's offerable pixels are: ${offer.map((p) => `${p.name} (${p.id})`).join(", ") || "none"}; retired pixels are not launchable`
                : `no_pixel_on_account — share ${AIF_VALUE_PIXEL.name} to this ad account in Business Manager first (or launch with Clicks optimization)`,
            },
            { status: 400 },
          );
        }
        binds.pixelId = bound.id;
      }
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
  if (medias.length === 0 || medias.some((m) => !m.url)) {
    return NextResponse.json({ ok: false, stage: "media", error: "media_required" }, { status: 400 });
  }
  // Same contract as /api/launch: a video creative's destination link lives inside its CTA
  // (creativePayload) — a "No CTA" video would ship link-less (review find 08-24).
  if (!String(campaign.cta ?? "").trim() && medias.some((m) => m.kind === "video")) {
    return NextResponse.json(
      {
        ok: false,
        stage: "media",
        error: "cta_required_for_video — pick a CTA button (its link is the video ad's destination); image-only cards may keep No CTA",
      },
      { status: 400 },
    );
  }
  // Every creative must be a Vercel Blob URL our OWN broker produced — same SSRF fence as
  // /api/launch — and the count is capped by the partner's own limit (server-side truth: a
  // stale tab could still POST more; the tree would then blow the function window mid-wave).
  {
    const cap = Math.max(1, partner.maxCreatives ?? 1);
    if (medias.length > cap) {
      return NextResponse.json(
        { ok: false, stage: "media", error: `too_many_creatives — this partner launches at most ${cap} per campaign` },
        { status: 400 },
      );
    }
    const ownBlob = (raw: string): boolean => {
      try {
        const u = new URL(raw);
        return u.protocol === "https:" && u.hostname.endsWith(".blob.vercel-storage.com") && u.pathname.startsWith("/creatives/");
      } catch {
        return false;
      }
    };
    for (const m of medias) {
      if (!ownBlob(m.url)) {
        return NextResponse.json({ ok: false, stage: "media", error: "media_url_invalid" }, { status: 400 });
      }
      // Covers are fetched server-side into adimages — same own-Blob fence as the creatives.
      if (m.coverUrl && !ownBlob(m.coverUrl)) {
        return NextResponse.json({ ok: false, stage: "media", error: "cover_url_invalid" }, { status: 400 });
      }
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

  // Image launches + custom video covers: fetch + validate EVERY one BEFORE the stream (clean
  // 400, nothing claimed). Worst case is bounded: 5 creatives × ≤8MB (fetchValidatedImage
  // ceiling) ≈ 40MB in memory — same envelope as /api/launch.
  const imageBufs = new Map<number, Buffer>();
  const coverBufs = new Map<number, Buffer>();
  try {
    for (let i = 0; i < medias.length; i++) {
      if (medias[i].kind === "image") imageBufs.set(i, await fetchValidatedImage(medias[i].url));
      if (medias[i].coverUrl) coverBufs.set(i, await fetchValidatedImage(medias[i].coverUrl));
    }
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
        // The pixel rides the RW link (echoed into the postback) so the CAPI forwarder lands
        // the Purchase on the SAME pixel the ad set optimizes for; clicks carry none.
        const link = fullLandingUrl(partner, slug, brand, conversions, binds.pixelId);
        if (!link) throw new FbError("no destination — cannot build the RW link", {});

        // 2) register EVERY creative on the AIF account (MO-parity, 09-02). Videos: all uploads
        // are fired first (advideos answers immediately, Meta processes in the background, in
        // parallel), THEN processing is waited out one by one — a 5-video card's wall-clock is
        // ~the slowest video, not the sum. Images: validated bytes → adimages hash.
        progress("video");
        type RegisteredMedia =
          | { kind: "image"; imageHash: string }
          | { kind: "video"; videoId: string; thumbUrl: string; coverHash?: string };
        const regs: RegisteredMedia[] = new Array(medias.length);
        for (let i = 0; i < medias.length; i++) {
          const m = medias[i];
          if (m.kind === "image") {
            regs[i] = { kind: "image", imageHash: await aifUploadImage(binds.accountId, imageBufs.get(i) as Buffer) };
          } else {
            const suffix = medias.length > 1 ? ` · video ${i + 1}` : " · video";
            regs[i] = { kind: "video", videoId: await aifUploadVideo(binds.accountId, m.url, `${name}${suffix}`), thumbUrl: "" };
          }
        }
        created.video_id = regs.find((r) => r.kind === "video")?.videoId ?? undefined;
        created.image_hash = (regs.find((r) => r.kind === "image") as { imageHash?: string } | undefined)?.imageHash;
        progress("processing");
        for (let i = 0; i < medias.length; i++) {
          const r = regs[i];
          if (r.kind !== "video") continue;
          await aifWaitForVideo(r.videoId);
          // A custom cover replaces the auto-thumbnail entirely (no thumbnail poll needed).
          const coverBuf = coverBufs.get(i);
          if (coverBuf) r.coverHash = await aifUploadImage(binds.accountId, coverBuf);
          else r.thumbUrl = await aifVideoThumb(r.videoId);
        }
        const localeIds = await resolveLocales(serverCampaign.locales);

        // 3) campaign → adset → one creative+ad PER media, all ACTIVE (parity with the MO rail)
        progress("campaign");
        const camp = await aifFbPost(`act_${binds.accountId}/campaigns`, campaignPayload(serverCampaign, name));
        created.campaign_id = String(camp.id);

        progress("adset");
        const adset = await withParentRetry(String(camp.id), () =>
          aifCreateAdset(`act_${binds.accountId}/adsets`, adsetPayload(serverCampaign, name, String(camp.id), binds, localeIds)),
        );
        created.adset_id = String(adset.id);

        progress("creative");
        const creativeIds: string[] = [];
        for (let i = 0; i < regs.length; i++) {
          const r = regs[i];
          const adName = regs.length > 1 ? `${name} · ${i + 1}` : name;
          const creative = await aifFbPost(
            `act_${binds.accountId}/adcreatives`,
            r.kind === "image"
              ? imageCreativePayload(serverCampaign, adName, binds, { imageHash: r.imageHash, link })
              : creativePayload(serverCampaign, adName, binds, {
                  videoId: r.videoId,
                  thumbUrl: r.thumbUrl,
                  link,
                  ...(r.coverHash ? { coverHash: r.coverHash } : {}),
                }),
          );
          creativeIds.push(String(creative.id));
        }
        created.creative_id = creativeIds[0];

        progress("ad");
        const adIds: string[] = [];
        for (let i = 0; i < creativeIds.length; i++) {
          const adName = creativeIds.length > 1 ? `${name} · ${i + 1}` : name;
          const ad = await withParentRetry(String(adset.id), () =>
            aifFbPost(`act_${binds.accountId}/ads`, adPayload(adName, String(adset.id), creativeIds[i])),
          );
          // Belt over the fbPost error-body guard: never record a phantom "undefined" ad id.
          if (!ad.id) throw new FbError("ad create returned no id", ad);
          adIds.push(String(ad.id));
          // Progress lands on `created` AS ads are born (not after the loop): the catch below
          // reads it to know whether money is already moving when a later ad throws.
          created.ad_id = adIds[0];
          if (adIds.length > 1) created.ad_ids = [...adIds];
          send({ stage: "ad", done: adIds.length, total: creativeIds.length });
        }

        // 4) tell the hs-tools pages registry how many slots this fanka just took (one per ad;
        // AIF scope — inert until the box syncs AIF pages) + record the FB ids against the
        // claimed brand (best-effort)
        await reportPagesUsed("us", [{ pageId: binds.pageId, delta: adIds.length }]);
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
        // Drop EVERY temporary Blob (creatives + covers) whether the launch succeeded or
        // failed — never orphan an upload.
        for (const m of medias) {
          await del(m.url, { token: process.env.BLOB_READ_WRITE_TOKEN }).catch(() => {});
          if (m.coverUrl) await del(m.coverUrl, { token: process.env.BLOB_READ_WRITE_TOKEN }).catch(() => {});
        }
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
