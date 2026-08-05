import { NextResponse } from "next/server";
import { type Campaign, bidAmountMissing } from "@/lib/types";
import { partnerConfig, fullLandingUrl, type PartnerId } from "@/lib/partners";
import {
  type LaunchBinds,
  adPayload,
  adsetPayload,
  campaignPayload,
  creativePayload,
} from "@/lib/fb-launch";
import { sessionFromCookieHeader } from "@/lib/session";
import { del } from "@vercel/blob";

export const runtime = "nodejs";
export const maxDuration = 300;

const FB = "https://graph.facebook.com/v21.0";
const TOKEN = process.env.FB_LAUNCH_TOKEN ?? "";
const STRAPI = (process.env.STRAPI_API_URL ?? "").replace(/\/+$/, "");
const STRAPI_TOKEN = process.env.STRAPI_TOKEN ?? "";

// ---------- Graph API helpers ----------

type Json = Record<string, unknown>;

/** Meta's most actionable error text: prefer the user-facing title/message ("Advertiser is
 *  missing: Provide a verified advertiser…") over the generic "Invalid parameter". */
function fbErrorMessage(body: Json, fallback: string): string {
  const e = (body?.error ?? {}) as Record<string, unknown>;
  const title = typeof e.error_user_title === "string" ? e.error_user_title : "";
  const msg = typeof e.error_user_msg === "string" ? e.error_user_msg : "";
  if (title || msg) return [title, msg].filter(Boolean).join(": ");
  return typeof e.message === "string" ? e.message : fallback;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Meta throttles the whole app with (#4)/(#17)/(#613) or is_transient errors when call volume
// spikes (a big launch wave polls a lot). These are temporary, so instead of failing the launch we
// back off and retry the SAME call — resources already created upstream aren't touched, so no dup
// campaigns. This also self-paces the sequential queue under the limit.
const RATE_LIMIT_CODES = new Set([4, 17, 613, 80004, 80014]);
function isRateLimited(body: Json): boolean {
  const e = (body?.error ?? {}) as { code?: number; is_transient?: boolean };
  return RATE_LIMIT_CODES.has(e.code ?? -1) || e.is_transient === true;
}
const RATE_RETRIES = 5;
const rateBackoff = (attempt: number) => Math.min(4000 * 2 ** attempt, 30000); // 4→8→16→30→30s

// Meta reports rolling ads rate-limit usage in x-business-use-case-usage (per BM/account:
// call_count/total_time are 0–100% of the limit; estimated_time_to_regain_access is minutes until a
// throttle lifts). As usage nears the ceiling we pause so the sequential queue paces itself under
// the limit instead of slamming into (#4). Kept light so a single launch stays within maxDuration.
type UsageStat = {
  call_count?: number;
  total_cputime?: number;
  total_time?: number;
  estimated_time_to_regain_access?: number;
};
async function throttle(res: Response): Promise<void> {
  const raw = res.headers.get("x-business-use-case-usage") ?? res.headers.get("x-app-usage") ?? "";
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const stats: UsageStat[] = [];
    if (typeof (parsed as UsageStat).call_count === "number") stats.push(parsed as UsageStat); // flat x-app-usage
    for (const v of Object.values(parsed)) if (Array.isArray(v)) for (const o of v) if (o && typeof o === "object") stats.push(o as UsageStat);
    let pct = 0;
    let regainMin = 0;
    for (const s of stats) {
      pct = Math.max(pct, s.call_count ?? 0, s.total_cputime ?? 0, s.total_time ?? 0);
      regainMin = Math.max(regainMin, s.estimated_time_to_regain_access ?? 0);
    }
    if (regainMin > 0) await sleep(Math.min(regainMin * 60_000, 30_000)); // throttled → wait (cap 30s)
    else if (pct >= 95) await sleep(8000);
    else if (pct >= 90) await sleep(4000);
    else if (pct >= 80) await sleep(1500);
  } catch {
    /* malformed header — ignore */
  }
}

async function fbGet(path: string): Promise<Json> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${FB}/${path}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      cache: "no-store",
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      await throttle(res);
      return body;
    }
    if (attempt < RATE_RETRIES && isRateLimited(body)) {
      await sleep(rateBackoff(attempt));
      continue;
    }
    throw new FbError(fbErrorMessage(body, `GET ${path} failed`), body);
  }
}

/** POST with form-encoding; nested objects/arrays are JSON-stringified (Marketing API convention). */
async function fbPost(path: string, params: Json): Promise<Json> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    form.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${FB}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      await throttle(res);
      return body;
    }
    if (attempt < RATE_RETRIES && isRateLimited(body)) {
      await sleep(rateBackoff(attempt));
      continue;
    }
    throw new FbError(fbErrorMessage(body, `POST ${path} failed`), body);
  }
}

class FbError extends Error {
  detail: unknown;
  constructor(msg: string, detail: unknown) {
    super(msg);
    this.detail = detail;
  }
}

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

// ---------- video upload + processing ----------

/** Register the creative with FB by URL — FB fetches the bytes from the (public) Blob URL itself,
 *  so the video never passes through this function. */
async function uploadVideo(accountId: string, fileUrl: string, name: string): Promise<string> {
  const body = await fbPost(`act_${accountId}/advideos`, { name, file_url: fileUrl });
  if (!body?.id) throw new FbError("video upload failed", body);
  return String(body.id);
}

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
  // Codes are 2-digit (01–99): the buy-link contract is gcm=NN, so never hand out "100".
  const start = /^\d{1,2}$/.test(desired) ? Math.min(parseInt(desired, 10) || 1, 99) : 1;
  for (let n = start; n <= 99; n++) if (!used.has(String(n).padStart(2, "0"))) candidates.push(String(n).padStart(2, "0"));
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
  throw new FbError("gcm pool exhausted — no free code 01–99", {});
}

async function backfillGcm(documentId: string | null, patch: Json): Promise<void> {
  if (!documentId) return;
  await fetch(`${STRAPI}/api/gcm-maps/${documentId}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${STRAPI_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ data: patch }),
  }).catch(() => {});
}

/** Release a claimed gcm code (delete the registry row) — used when a launch fails before any FB
 *  resource is created, so failed attempts don't permanently drain the 01–99 pool. */
async function deleteGcm(documentId: string): Promise<void> {
  await fetch(`${STRAPI}/api/gcm-maps/${documentId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${STRAPI_TOKEN}` },
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
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return NextResponse.json({ ok: false, stage: "auth", error: "unauthorized" }, { status: 401 });
  }
  if (!TOKEN) return NextResponse.json({ ok: false, stage: "config", error: "no_fb_token" }, { status: 500 });

  let campaign: Campaign;
  let partnerId: PartnerId;
  let videoUrl = "";
  try {
    const j = (await req.json()) as { campaign?: Campaign; partnerId?: string; videoUrl?: string };
    campaign = (j.campaign ?? {}) as Campaign;
    partnerId = String(j.partnerId ?? "in") as PartnerId;
    videoUrl = typeof j.videoUrl === "string" ? j.videoUrl : "";
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
  if (!videoUrl) {
    return NextResponse.json({ ok: false, stage: "media", error: "video_required" }, { status: 400 });
  }
  if (bidAmountMissing(campaign)) {
    return NextResponse.json(
      { ok: false, stage: "config", error: "Bid amount required for the selected bid strategy" },
      { status: 400 },
    );
  }

  const name = `${campaign.namePrefix}${campaign.name}`.trim();
  const conversions = campaign.optimization === "conversions";

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

        // 2) register the creative (FB pulls it from the Blob URL) and wait for processing
        send({ stage: "video" });
        const videoId = await uploadVideo(binds.accountId, videoUrl, `${name} · video`);
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
        const adset = await createAdset(
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
        // Free the gcm code when nothing was created on FB (early failures like a rate limit or a
        // video error) so the 01–99 pool never leaks; keep the row (marked failed) once a campaign
        // exists so the orphaned PAUSED campaign stays traceable.
        if (claim?.documentId) {
          if (created.campaign_id)
            await backfillGcm(claim.documentId, { status: "failed", notes: `launch failed: ${err.message}` });
          else await deleteGcm(claim.documentId);
        }
        send({ ok: false, stage: "error", error: err.message ?? String(e), detail: err.detail ?? null, created });
      } finally {
        // Drop the temporary Blob whether the launch succeeded or failed — never orphan the upload.
        // Awaited (not fire-and-forget) so it completes before the stream closes and Vercel can
        // freeze the function. The "done"/"error" event was already sent, so this adds no visible wait.
        await del(videoUrl, { token: process.env.BLOB_READ_WRITE_TOKEN }).catch(() => {});
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
