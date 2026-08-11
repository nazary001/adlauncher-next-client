import { NextResponse } from "next/server";
import { type Campaign, bidAmountMissing, bidKind, parseMoney } from "@/lib/types";
import { conversionEventsFor } from "@/lib/catalog";
import { partnerConfig, fullLandingUrl, type PartnerId } from "@/lib/partners";
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
import {
  FbError,
  accountPixels,
  advertisablePageName,
  fbGet,
  fbPost,
  isAdvertisablePage,
  isTokenAccount,
  withFbBudget,
  withParentRetry,
} from "@/lib/fb-graph";
import { backfillGcm, claimGcm, deleteGcm } from "@/lib/gcm-claim";
import { taskWriter } from "@/lib/task-store";
import { del } from "@vercel/blob";

export const runtime = "nodejs";
export const maxDuration = 300;

const TOKEN = process.env.FB_LAUNCH_TOKEN ?? "";

type Json = Record<string, unknown>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// FB calls run under a per-launch retry budget (lib/fb-graph withFbBudget): the dev-tier token
// throttles routinely mid-wave, so rate-limited calls wait out Meta's own regain estimate and
// retry up to 8 times — but never sleep past deadline. 240s < maxDuration keeps the hard failure
// INSIDE the function: a Vercel timeout would skip the catch block (no gcm release/retire, task
// row never settled), which is strictly worse than a clean per-launch error.
const FB_BUDGET_MS = 240_000;
const FB_BUDGET_RETRIES = 8;

/**
 * Create the ad set, self-healing the regional "universal ads" declarations Meta requires for
 * regulated locations (Taiwan, Singapore, …) when the audience includes them — e.g. worldwide
 * targeting. Meta surfaces one region per error ("...use the following value ...: TAIWAN_UNIVERSAL"),
 * so we add each demanded value to regional_regulated_categories and retry. Pre-seeded from the
 * payload (worldwide sends the known pair up front); this catches anything further Meta adds.
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
        continue; // Meta named a new required declaration → add it and retry
      }
      throw e; // unrelated failure — surface it
    }
  }
  // Exhausted retries — one last attempt so a genuine failure propagates with its detail.
  return fbPost(path, { ...payload, regional_regulated_categories: [...cats] });
}

// ---------- media upload + processing ----------

/** Register the creative with FB by URL — FB fetches the bytes from the (public) Blob URL itself,
 *  so the video never passes through this function. */
async function uploadVideo(accountId: string, fileUrl: string, name: string): Promise<string> {
  const body = await fbPost(`act_${accountId}/advideos`, { name, file_url: fileUrl });
  if (!body?.id) throw new FbError("video upload failed", body);
  return String(body.id);
}

// Empirical adimages ceilings (probed live 2026-08-11 on this token): any side above ~9000px is
// rejected (sub 2446496 "invalid image format"), and Meta re-encodes every upload — when ITS
// output is still heavy it rejects with sub 1885355 "resized image too large" (a 9.3MB worst-case
// source already failed; 8 buyer launches died on this in one day). 8MB/9000px keeps every upload
// we allow inside what Meta demonstrably accepts. The dropzone enforces the same numbers, so
// buyers hear it at drop time — this is the server-side backstop.
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_MAX_DIM = 9000;

/** Width/height from the image header: PNG (IHDR), JPEG (SOF frame scan), GIF, WebP (VP8/VP8L/
 *  VP8X). Null when the format is unrecognized — the guard then lets Meta be the judge. */
function imageDims(buf: Buffer): { w: number; h: number } | null {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf.length > 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  if (buf.length > 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const fmt = buf.toString("ascii", 12, 16);
    if (fmt === "VP8X") return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    if (fmt === "VP8L") {
      const b = buf.readUInt32LE(21);
      return { w: 1 + (b & 0x3fff), h: 1 + ((b >> 14) & 0x3fff) };
    }
    if (fmt === "VP8 ") return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    return null;
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) return null;
      const marker = buf[off + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { w: buf.readUInt16BE(off + 7), h: buf.readUInt16BE(off + 5) };
      }
      off += 2 + buf.readUInt16BE(off + 2);
    }
  }
  return null;
}

/** Fetch + validate the image BEFORE anything is claimed or created: caught here it costs
 *  nothing; caught at adimages it has already burned a gcm claim round-trip and 20s of wave. */
async function fetchValidatedImage(fileUrl: string): Promise<Buffer> {
  const res = await fetch(fileUrl, { cache: "no-store" });
  if (!res.ok) throw new FbError(`image fetch failed (HTTP ${res.status})`, { fileUrl });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength === 0) throw new FbError("image is empty", { fileUrl });
  if (buf.byteLength > IMAGE_MAX_BYTES) {
    throw new FbError(
      `image too heavy (${(buf.byteLength / 1048576).toFixed(1)}MB) — Meta rejects these after its re-encode; compress under 8MB`,
      { size: buf.byteLength },
    );
  }
  const dims = imageDims(buf);
  if (dims && Math.max(dims.w, dims.h) > IMAGE_MAX_DIM) {
    throw new FbError(
      `image too large (${dims.w}×${dims.h}) — Meta rejects sides above ${IMAGE_MAX_DIM}px; export it smaller`,
      dims,
    );
  }
  return buf;
}

/** Upload a static image into the account's image library; returns its stable image_hash. */
async function uploadImage(accountId: string, buf: Buffer): Promise<string> {
  const body = await fbPost(`act_${accountId}/adimages`, { bytes: buf.toString("base64") });
  // Response shape: { images: { bytes: { hash, ... } } } — key varies by upload method, so take
  // the first entry (same convention as the clone route's copy_from reader).
  const images = (body?.images ?? {}) as Record<string, { hash?: string }>;
  const hash = Object.values(images)[0]?.hash;
  if (!hash) throw new FbError("image upload returned no hash", body);
  return String(hash);
}


/** Wait until the uploaded video finishes processing (or throw on error/timeout). 6s cadence —
 *  status polls dominate a wave's call count on the dev-tier quota, so poll no faster than useful. */
async function waitForVideo(videoId: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await fbGet(`${videoId}?fields=status`);
    const status = (body?.status as Json | undefined)?.video_status;
    if (status === "ready") return;
    if (status === "error") throw new FbError("video processing failed", body);
    await sleep(6000);
  }
  throw new FbError("video processing timed out", { videoId });
}

/** The video thumbnail FB auto-generates once processed; needed as the creative image. */
async function videoThumb(videoId: string): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const body = await fbGet(`${videoId}/thumbnails?fields=uri,is_preferred`);
    const thumbs = (body?.data as Array<Json> | undefined) ?? [];
    const pick = thumbs.find((t) => t.is_preferred) ?? thumbs[0];
    if (pick?.uri) return String(pick.uri);
    await sleep(4000);
  }
  throw new FbError("no video thumbnail available", { videoId });
}

// gcm registry claim/backfill/release now come from @/lib/gcm-claim — the SAME race-safe
// (claim-then-verify) implementation the clone route uses. The launch route previously carried its
// own inline copy that returned on the first 2xx without verifying it won the code, so two concurrent
// launches (multi-user waves) could both commit the same code → two live campaigns sharing one gcm.

// ---------- locale resolution (best-effort, non-fatal) ----------

const localeCache = new Map<string, number | null>();
async function resolveLocales(names: string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const raw of names) {
    if (/\(all\)/i.test(raw)) continue; // "all" = no language restriction (broadest)
    if (!localeCache.has(raw)) {
      try {
        const body = await fbGet(`search?type=adlocale&limit=25&q=${encodeURIComponent(raw.replace(/[()]/g, " ").trim())}`);
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

export async function POST(req: Request) {
  // This route is excluded from the proxy (large body), so it authenticates itself.
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) {
    return NextResponse.json({ ok: false, stage: "auth", error: "unauthorized" }, { status: 401 });
  }
  if (!TOKEN) return NextResponse.json({ ok: false, stage: "config", error: "no_fb_token" }, { status: 500 });

  let campaign: Campaign;
  let partnerId: PartnerId;
  let mediaUrl = "";
  let mediaKind: "video" | "image" = "video";
  let taskId: string | null = null;
  try {
    const j = (await req.json()) as {
      campaign?: Campaign;
      partnerId?: string;
      mediaUrl?: string;
      mediaKind?: string;
      /** Legacy client field (pre-image builds still in open tabs) — video by definition. */
      videoUrl?: string;
      taskId?: string;
    };
    campaign = (j.campaign ?? {}) as Campaign;
    partnerId = String(j.partnerId ?? "in") as PartnerId;
    mediaUrl = typeof j.mediaUrl === "string" && j.mediaUrl ? j.mediaUrl : typeof j.videoUrl === "string" ? j.videoUrl : "";
    mediaKind = j.mediaKind === "image" ? "image" : "video";
    // The Task Manager row this run belongs to. When present, progress + the terminal state are
    // ALSO written to Strapi server-side, so every account keeps seeing the truth live even if the
    // launching browser dies mid-run (the run itself continues here regardless).
    taskId = typeof j.taskId === "string" && /^[\w-]{6,64}$/.test(j.taskId) ? j.taskId : null;
  } catch (e) {
    return NextResponse.json({ ok: false, stage: "parse", error: String(e) }, { status: 400 });
  }

  const partner = partnerConfig(partnerId);
  // The account, fanka and pixel are the buyer's PICKS, but every id is validated against the
  // launch token's own data server-side — the client can't smuggle in arbitrary destinations.
  const pickedPage = partner.fanpagesFromToken ? String(campaign.page ?? "").trim() : "";
  const pickedAccount = partner.accountsFromToken
    ? String(campaign.account ?? "").trim().replace(/^act_/, "")
    : (partner.lockedAccount?.id ?? "").replace(/^act_/, "");
  const pickedPixel = partner.accountsFromToken
    ? String(campaign.pixel ?? "").trim()
    : partner.lockedPixel?.id ?? "";
  const binds: LaunchBinds = {
    accountId: pickedAccount,
    pageId: partner.fanpagesFromToken ? pickedPage : "",
    pageName: "", // resolved below, once the picked page passes validation
    pixelId: pickedPixel,
  };
  if (!binds.accountId && !partner.accountsFromToken) {
    return NextResponse.json({ ok: false, stage: "config", error: "partner_not_launchable" }, { status: 400 });
  }
  try {
    if (partner.accountsFromToken) {
      if (!/^\d{5,}$/.test(pickedAccount)) {
        return NextResponse.json(
          { ok: false, stage: "config", error: "account_required — pick an ad account on the campaign card" },
          { status: 400 },
        );
      }
      if (!(await isTokenAccount(pickedAccount))) {
        return NextResponse.json(
          { ok: false, stage: "config", error: "account_not_allowed — the launch token cannot use this ad account" },
          { status: 400 },
        );
      }
      if (!/^\d{10,20}$/.test(pickedPixel)) {
        // Must match lib/partners isPixelId, or a pixel set on the adset would be dropped from the
        // link (funnel then fires its default pixel, not the one the adset optimizes for).
        return NextResponse.json(
          { ok: false, stage: "config", error: "pixel_required — pick a pixel on the campaign card" },
          { status: 400 },
        );
      }
      const pixels = await accountPixels(pickedAccount);
      if (!pixels.some((p) => p.id === pickedPixel)) {
        return NextResponse.json(
          {
            ok: false,
            stage: "config",
            error: "pixel_not_on_account — this ad account does not carry the picked pixel (share it in BM first)",
          },
          { status: 400 },
        );
      }
    }
    if (partner.fanpagesFromToken) {
      if (!/^\d{5,}$/.test(pickedPage)) {
        return NextResponse.json(
          { ok: false, stage: "config", error: "fanpage_required — pick a fanpage on the campaign card" },
          { status: 400 },
        );
      }
      if (!(await isAdvertisablePage(pickedPage))) {
        return NextResponse.json(
          { ok: false, stage: "config", error: "fanpage_not_allowed — the launch token cannot advertise with this page" },
          { status: 400 },
        );
      }
      // The page's display name feeds the ad set's DSA beneficiary/payor declaration — without it
      // Meta rejects EU-reaching ad sets ("Advertiser not specified") on any account that lacks a
      // default beneficiary. Free: read from the same cached list that just validated the id.
      binds.pageName = await advertisablePageName(pickedPage);
    } else if (!binds.pageId) {
      return NextResponse.json({ ok: false, stage: "config", error: "partner_not_launchable" }, { status: 400 });
    }
  } catch (e) {
    const err = e as { message?: string };
    return NextResponse.json(
      { ok: false, stage: "config", error: `destination check failed: ${err.message ?? String(e)}` },
      { status: 502 },
    );
  }
  // Landing must be a real slug from the partner catalog — a stale/renamed slug (e.g. from a
  // restored draft) would build a live ad pointing at a 404, reported as success, spend + a burnt
  // gcm on a dead link. Validated here, before any gcm claim / FB write.
  if (partner.usesGcm) {
    const slug = String(campaign.landing ?? "").trim();
    if (!partner.landings.some((l) => l.slug === slug)) {
      return NextResponse.json(
        { ok: false, stage: "config", error: "landing_invalid — pick a valid landing on the campaign card" },
        { status: 400 },
      );
    }
  }
  if (!mediaUrl) {
    return NextResponse.json({ ok: false, stage: "media", error: "media_required" }, { status: 400 });
  }
  // The creative must be a Vercel Blob URL our OWN broker produced — never an arbitrary URL.
  // Otherwise a logged-in user could make FB (or this function, for images) fetch any URL, or make
  // `del()` target a blob outside our flow. Our broker always uploads to `creatives/<taskid>-<name>`
  // on the *.blob.vercel-storage.com host over https, so we require both the host suffix AND that
  // path prefix — narrowing the surface to blobs this app actually creates (rev-api #2).
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
  if (bidAmountMissing(campaign)) {
    return NextResponse.json(
      { ok: false, stage: "config", error: "Bid amount required for the selected bid strategy" },
      { status: 400 },
    );
  }
  // Mirror the HS guard: a min-ROAS goal above 100 (10 000%) is a typo, not a bid. Rejected here
  // so no campaign/gcm exists yet (Meta would only refuse at the ad-set step, orphaning both).
  if (bidKind(campaign.bidStrategy) === "roas" && parseMoney(campaign.bidCap) > 100) {
    return NextResponse.json(
      { ok: false, stage: "config", error: "roas_goal_invalid — ROAS goal must be 0–100" },
      { status: 400 },
    );
  }
  // Geo is required — an empty country list builds geo_locations:{countries:[]}, which Meta rejects
  // only at the ad-set step, AFTER the campaign is created → orphan + burnt gcm. (isReady guards it
  // client-side; a restored/edited draft could still POST empty.)
  if (!Array.isArray(campaign.countries) || campaign.countries.length === 0) {
    return NextResponse.json(
      { ok: false, stage: "config", error: "geo_required — pick at least one country" },
      { status: 400 },
    );
  }
  // The conversion event must be valid for the chosen objective — a desync (e.g. Copy-to-all copying
  // the event but not the objective) sends OFFSITE_CONVERSIONS + a foreign custom_event_type, which
  // Meta rejects after the campaign exists → orphan + burnt gcm.
  if (!conversionEventsFor(campaign.objective).some((e) => e.value === campaign.conversionEvent)) {
    return NextResponse.json(
      { ok: false, stage: "config", error: "event_invalid — conversion event is not valid for the objective" },
      { status: 400 },
    );
  }
  // A cleared/zero budget (money("") → 0) would create the campaign, then Meta rejects the ad set
  // for daily_budget below the floor → orphan PAUSED campaign + a permanently retired gcm code.
  // Reject before any claim/write. $1/day (100 cents) is the USD daily minimum.
  if (money(campaign.budget) < 100) {
    return NextResponse.json(
      { ok: false, stage: "config", error: "budget_too_low — daily budget must be at least $1" },
      { status: 400 },
    );
  }

  // Image launches: fetch + validate the creative BEFORE the stream — an oversized image must
  // die here as a clean 400 (nothing claimed, no campaign shell), not 20s into the wave at
  // adimages. The validated bytes ride into the stream so the Blob isn't fetched twice.
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

  const name = `${campaign.namePrefix}${campaign.name}`.trim();
  // &fire=click follows the optimization — and min-ROAS ALWAYS optimizes purchase value, so the
  // funnel must fire Purchase on click regardless of what optimization the client sent (the UI
  // pins it, but the server is the truth: a stale/edited draft could still say "clicks", which
  // would starve VALUE optimization of its purchase signal).
  const conversions = campaign.optimization === "conversions" || bidKind(campaign.bidStrategy) === "roas";

  // Stream NDJSON stage events so the Task Manager can show live per-stage progress. The whole
  // pipeline runs under the FB retry budget (see FB_BUDGET_MS) so mid-wave throttles are waited
  // out instead of failing the launch — but never past the function's own lifetime. withFbBudget
  // wraps the CONSTRUCTION: start() begins inside it, so its entire async chain inherits the budget.
  const encoder = new TextEncoder();
  const stream = withFbBudget({ deadlineAt: Date.now() + FB_BUDGET_MS, retries: FB_BUDGET_RETRIES }, () =>
    new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (o: Json) => controller.enqueue(encoder.encode(JSON.stringify(o) + "\n"));
      // Mirror progress into the launch-task row (chained, non-blocking, owner-guarded) so the
      // shared Task Manager stays live for every account — including after this client is gone.
      const tw = taskWriter(session.username, taskId);
      let lastStage = "gcm";
      let settled = false; // set before the terminal write — the beat must never chain after it
      const progress = (stage: string) => {
        lastStage = stage;
        send({ stage });
        tw.write({ status: "running", stage });
      };
      // Server-side liveness beat: stage writes alone can gap for minutes (video processing polls,
      // rate-limit backoffs). If the launching browser died, its 25s client heartbeat died with it —
      // without this the team would see a live server-run go amber "stale" mid-processing.
      const beat = setInterval(() => {
        if (!settled) tw.write({ status: "running", stage: lastStage });
      }, 30_000);
      const created: Json = {};
      let claim: { gcm: string; documentId: string | null } | null = null;
      try {
        // 1) reserve the gcm BEFORE building the link (guarantees no duplicate marker)
        progress("gcm");
        claim = await claimGcm(campaign.gcm, {
          campaign_name: name,
          landing: campaign.landing || null,
          notes: "claimed via adlauncher launch",
        });
        const gcm = claim.gcm;
        // The link carries the campaign's chosen pixel (binds.pixelId, already validated) so the
        // funnel fires that pixel — matching the adset's promoted pixel.
        const link = fullLandingUrl(partner, campaign.landing, gcm, conversions, binds.pixelId);
        if (!link) throw new FbError("no landing selected — cannot build destination link", {});

        // 2) register the creative. Video: FB pulls it from the Blob URL, then we wait out
        // processing. Image: the bytes go straight into the account's image library (no
        // processing step) and the creative is built as link_data around the returned hash.
        progress("video");
        let videoId = "";
        let thumbUrl = "";
        let imageHash = "";
        if (mediaKind === "image") {
          imageHash = await uploadImage(binds.accountId, imageBuf as Buffer); // validated pre-flight
          created.image_hash = imageHash;
        } else {
          videoId = await uploadVideo(binds.accountId, mediaUrl, `${name} · video`);
          created.video_id = videoId;
          progress("processing");
          await waitForVideo(videoId);
          thumbUrl = await videoThumb(videoId);
        }
        const localeIds = await resolveLocales(campaign.locales);

        // 3) campaign → adset → creative → ad, all ACTIVE (live on creation since 08-11)
        progress("campaign");
        const camp = await fbPost(`act_${binds.accountId}/campaigns`, campaignPayload(campaign, name));
        created.campaign_id = String(camp.id);

        progress("adset");
        const adset = await withParentRetry(String(camp.id), () =>
          createAdset(`act_${binds.accountId}/adsets`, adsetPayload(campaign, name, String(camp.id), binds, localeIds)),
        );
        created.adset_id = String(adset.id);

        progress("creative");
        const creative = await fbPost(
          `act_${binds.accountId}/adcreatives`,
          mediaKind === "image"
            ? imageCreativePayload(campaign, name, binds, { imageHash, link })
            : creativePayload(campaign, name, binds, { videoId, thumbUrl, link }),
        );
        created.creative_id = String(creative.id);

        progress("ad");
        const ad = await withParentRetry(String(adset.id), () =>
          fbPost(`act_${binds.accountId}/ads`, adPayload(name, String(adset.id), String(creative.id))),
        );
        // Belt over the fbPost error-body guard: never record a phantom "undefined" ad id.
        if (!ad.id) throw new FbError("ad create returned no id", ad);
        created.ad_id = String(ad.id);

        // 4) record the FB ids against the claimed gcm (best-effort)
        await backfillGcm(claim.documentId, {
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
          gcm,
          error: null,
        });
        send({ ok: true, stage: "done", gcm, link, page_id: binds.pageId, ...created });
      } catch (e) {
        const err = e as FbError;
        // Free the gcm code when nothing was created on FB (early failures like a rate limit or a
        // video error) so the 01–200 pool never leaks; keep the row (marked failed) once a campaign
        // exists so the orphaned PAUSED campaign stays traceable.
        if (claim?.documentId) {
          if (created.campaign_id)
            // "retired" — the registry's status enum is active|retired; "failed" is rejected by
            // Strapi (the whole PUT 400s and backfillGcm swallows it, losing the note AND the ids).
            await backfillGcm(claim.documentId, {
              status: "retired",
              notes: `launch failed: ${err.message}`,
              // Record what DID get created so the orphaned PAUSED campaign is traceable by code.
              campaign_id: created.campaign_id,
              ...(created.adset_id ? { adset_id: created.adset_id } : {}),
            });
          else await deleteGcm(claim.documentId);
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
        // Awaited (not fire-and-forget) so it completes before the stream closes and Vercel can
        // freeze the function. The "done"/"error" event was already sent, so this adds no visible wait.
        await del(mediaUrl, { token: process.env.BLOB_READ_WRITE_TOKEN }).catch(() => {});
        // Flush the task-row writer too — its last transition must land before Vercel freezes us.
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
