import { NextResponse } from "next/server";
import type { Campaign } from "@/lib/types";
import { partnerConfig, fullLandingUrl, type PartnerId } from "@/lib/partners";
import {
  type LaunchBinds,
  adPayload,
  adsetPayload,
  campaignPayload,
  creativePayload,
} from "@/lib/fb-launch";
import { sessionFromCookieHeader } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 300;

const FB = "https://graph.facebook.com/v21.0";
const TOKEN = process.env.FB_LAUNCH_TOKEN ?? "";
const STRAPI = (process.env.STRAPI_API_URL ?? "").replace(/\/+$/, "");
const STRAPI_TOKEN = process.env.STRAPI_TOKEN ?? "";

// ---------- Graph API helpers ----------

type Json = Record<string, unknown>;

async function fbGet(path: string): Promise<Json> {
  const res = await fetch(`${FB}/${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new FbError(body?.error?.message ?? `GET ${path} failed`, body);
  return body;
}

/** POST with form-encoding; nested objects/arrays are JSON-stringified (Marketing API convention). */
async function fbPost(path: string, params: Json): Promise<Json> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    form.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  const res = await fetch(`${FB}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new FbError(body?.error?.message ?? `POST ${path} failed`, body);
  return body;
}

class FbError extends Error {
  detail: unknown;
  constructor(msg: string, detail: unknown) {
    super(msg);
    this.detail = detail;
  }
}

// ---------- video upload + processing ----------

async function uploadVideo(accountId: string, file: File, name: string): Promise<string> {
  const form = new FormData();
  form.set("name", name);
  form.set("source", file, file.name || "creative.mp4");
  const res = await fetch(`${FB}/act_${accountId}/advideos`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body?.id) throw new FbError(body?.error?.message ?? "video upload failed", body);
  return String(body.id);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until the uploaded video finishes processing (or throw on error/timeout). */
async function waitForVideo(videoId: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await fbGet(`${videoId}?fields=status`);
    const status = (body?.status as Json | undefined)?.video_status;
    if (status === "ready") return;
    if (status === "error") throw new FbError("video processing failed", body);
    await sleep(4000);
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
    await sleep(3000);
  }
  throw new FbError("no video thumbnail available", { videoId });
}

// ---------- gcm registry (atomic claim, unique constraint) ----------

async function strapiUsedCodes(): Promise<Set<string>> {
  const res = await fetch(`${STRAPI}/api/gcm-maps?fields[0]=gcm&pagination[pageSize]=200`, {
    headers: { Authorization: `Bearer ${STRAPI_TOKEN}` },
    cache: "no-store",
  });
  if (!res.ok) return new Set();
  const body = await res.json().catch(() => ({}));
  return new Set(((body.data ?? []) as Array<{ gcm?: string }>).map((r) => String(r.gcm ?? "")).filter(Boolean));
}

/**
 * Reserve a gcm code before the link is built, so two campaigns can never share one.
 * Tries `desired`; on the DB unique-violation, walks to the next free code and retries.
 * Returns the code actually claimed plus the Strapi documentId (for later id back-fill).
 */
async function claimGcm(
  desired: string,
  meta: Json,
): Promise<{ gcm: string; documentId: string | null }> {
  const used = await strapiUsedCodes();
  const candidates: string[] = [];
  const start = /^\d{1,2}$/.test(desired) ? parseInt(desired, 10) : 1;
  for (let n = start; n <= 100; n++) if (!used.has(String(n).padStart(2, "0"))) candidates.push(String(n).padStart(2, "0"));
  for (let n = 1; n < start; n++) if (!used.has(String(n).padStart(2, "0"))) candidates.push(String(n).padStart(2, "0"));

  for (const gcm of candidates) {
    const res = await fetch(`${STRAPI}/api/gcm-maps`, {
      method: "POST",
      headers: { Authorization: `Bearer ${STRAPI_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ data: { gcm, platform: "facebook", status: "active", ...meta } }),
    });
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      return { gcm, documentId: body?.data?.documentId ?? null };
    }
    // 400 = unique violation (someone took it) → try the next candidate; other errors abort.
    if (res.status !== 400) {
      const body = await res.json().catch(() => ({}));
      throw new FbError(`gcm claim failed (${res.status})`, body);
    }
  }
  throw new FbError("gcm pool exhausted — no free code 01–100", {});
}

async function backfillGcm(documentId: string | null, patch: Json): Promise<void> {
  if (!documentId) return;
  await fetch(`${STRAPI}/api/gcm-maps/${documentId}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${STRAPI_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ data: patch }),
  }).catch(() => {});
}

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
        const hit = data.find((d) => d.name && norm(d.name) === norm(raw)) ?? data[0];
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
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return NextResponse.json({ ok: false, stage: "auth", error: "unauthorized" }, { status: 401 });
  }
  if (!TOKEN) return NextResponse.json({ ok: false, stage: "config", error: "no_fb_token" }, { status: 500 });

  let campaign: Campaign;
  let partnerId: PartnerId;
  let video: File | null = null;
  try {
    const fd = await req.formData();
    campaign = JSON.parse(String(fd.get("campaign") ?? "{}")) as Campaign;
    partnerId = String(fd.get("partnerId") ?? "in") as PartnerId;
    const v = fd.get("video");
    if (v instanceof File) video = v;
  } catch (e) {
    return NextResponse.json({ ok: false, stage: "parse", error: String(e) }, { status: 400 });
  }

  const partner = partnerConfig(partnerId);
  // Enforce the locked binds server-side — never trust client for account/page/pixel.
  const binds: LaunchBinds = {
    accountId: (partner.lockedAccount?.id ?? "").replace(/^act_/, ""),
    pageId: partner.lockedPage?.id ?? "",
    pixelId: partner.lockedPixel?.id ?? "",
  };
  if (!binds.accountId || !binds.pageId) {
    return NextResponse.json({ ok: false, stage: "config", error: "partner_not_launchable" }, { status: 400 });
  }
  if (!video) {
    return NextResponse.json({ ok: false, stage: "media", error: "video_required" }, { status: 400 });
  }

  const name = `${campaign.namePrefix}${campaign.name}`.trim();
  const conversions = campaign.optimization === "conversions";
  const vid = video; // narrowed non-null

  // Stream NDJSON stage events so the Task Manager can show live per-stage progress.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (o: Json) => controller.enqueue(encoder.encode(JSON.stringify(o) + "\n"));
      const created: Json = {};
      let claim: { gcm: string; documentId: string | null } | null = null;
      try {
        // 1) reserve the gcm BEFORE building the link (guarantees no duplicate marker)
        send({ stage: "gcm" });
        claim = await claimGcm(campaign.gcm, {
          campaign_name: name,
          landing: campaign.landing || null,
          notes: "claimed via adlauncher launch",
        });
        const gcm = claim.gcm;
        const link = fullLandingUrl(partner, campaign.landing, gcm, conversions);
        if (!link) throw new FbError("no landing selected — cannot build destination link", {});

        // 2) upload the creative video and wait for processing
        send({ stage: "video" });
        const videoId = await uploadVideo(binds.accountId, vid, `${name} · video`);
        created.video_id = videoId;
        send({ stage: "processing" });
        await waitForVideo(videoId);
        const thumbUrl = await videoThumb(videoId);
        const localeIds = await resolveLocales(campaign.locales);

        // 3) campaign → adset → creative → ad, all PAUSED
        send({ stage: "campaign" });
        const camp = await fbPost(`act_${binds.accountId}/campaigns`, campaignPayload(campaign, name));
        created.campaign_id = String(camp.id);

        send({ stage: "adset" });
        const adset = await fbPost(
          `act_${binds.accountId}/adsets`,
          adsetPayload(campaign, name, String(camp.id), binds, localeIds),
        );
        created.adset_id = String(adset.id);

        send({ stage: "creative" });
        const creative = await fbPost(
          `act_${binds.accountId}/adcreatives`,
          creativePayload(campaign, name, binds, { videoId, thumbUrl, link }),
        );
        created.creative_id = String(creative.id);

        send({ stage: "ad" });
        const ad = await fbPost(`act_${binds.accountId}/ads`, adPayload(name, String(adset.id), String(creative.id)));
        created.ad_id = String(ad.id);

        // 4) record the FB ids against the claimed gcm (best-effort)
        await backfillGcm(claim.documentId, {
          campaign_id: created.campaign_id,
          adset_id: created.adset_id,
          ad_id: created.ad_id,
        });

        send({ ok: true, stage: "done", gcm, link, page_id: binds.pageId, ...created });
      } catch (e) {
        const err = e as FbError;
        if (claim) await backfillGcm(claim.documentId, { status: "failed", notes: `launch failed: ${err.message}` });
        send({ ok: false, stage: "error", error: err.message ?? String(e), detail: err.detail ?? null, created });
      } finally {
        controller.close();
      }
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
