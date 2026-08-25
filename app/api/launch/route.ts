import { NextResponse } from "next/server";
import { type Campaign, bidAmountMissing, bidKind, normalizeRoasGoal, parseMoney } from "@/lib/types";
import { conversionEventsFor } from "@/lib/catalog";
import { ROAS_PIXEL, partnerConfig, fullLandingUrl, type PartnerId } from "@/lib/partners";
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
  createAdsetSelfHealing,
  fbGet,
  fbPost,
  isAdvertisablePage,
  isTokenAccount,
  tokenAccountName,
  withFbBudget,
  withParentRetry,
} from "@/lib/fb-graph";
import { claimAcctSlot, releaseAcctSlot } from "@/lib/acct-limit";
import { ACCOUNT_NOT_ASSIGNED_MSG, accountAllowedFor } from "@/lib/acct-assignments";
import { launchFailureDisposition, partialFailureNote } from "@/lib/launch-guards";
import { fetchValidatedImage, uploadImage, uploadVideo, videoThumb, waitForVideo } from "@/lib/fb-media";
import { backfillGcm, claimGcm, deleteGcm } from "@/lib/gcm-claim";
import { reportPagesUsed } from "@/lib/hs-pages";
import { taskWriter } from "@/lib/task-store";
import { del } from "@vercel/blob";

export const runtime = "nodejs";
export const maxDuration = 300;

const TOKEN = process.env.FB_LAUNCH_TOKEN ?? "";

type Json = Record<string, unknown>;

// FB calls run under a per-launch retry budget (lib/fb-graph withFbBudget): the dev-tier token
// throttles routinely mid-wave, so rate-limited calls wait out Meta's own regain estimate and
// retry up to 8 times — but never sleep past deadline. 240s < maxDuration keeps the hard failure
// INSIDE the function: a Vercel timeout would skip the catch block (no gcm release/retire, task
// row never settled), which is strictly worse than a clean per-launch error.
const FB_BUDGET_MS = 240_000;
const FB_BUDGET_RETRIES = 8;

// A failed launch pauses its campaign (the tree is born ACTIVE — see step 3 below), but the
// failure is often the throttle itself, so the pause attempt gets a hard confirmation window
// instead of riding fbPost's full retry ladder; past it the row honestly says "not confirmed".
const PAUSE_CONFIRM_MS = 20_000;

// Ad-set creation self-heal and the media upload/processing helpers moved to lib/fb-graph
// (createAdsetSelfHealing) and lib/fb-media — shared with the HS token-launch rail, byte-identical
// behaviour here.

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

export async function POST(req: Request) {
  // This route is excluded from the proxy (large body), so it authenticates itself.
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) {
    return NextResponse.json({ ok: false, stage: "auth", error: "unauthorized" }, { status: 401 });
  }
  if (!TOKEN) return NextResponse.json({ ok: false, stage: "config", error: "no_fb_token" }, { status: 500 });

  let campaign: Campaign;
  let partnerId: PartnerId;
  /** Creatives of this launch (1..maxCreatives): own-Blob URLs; cover = video thumbnail image. */
  let medias: { url: string; kind: "video" | "image"; coverUrl: string }[] = [];
  let taskId: string | null = null;
  try {
    const j = (await req.json()) as {
      campaign?: Campaign;
      partnerId?: string;
      /** Multi-creative shape (5-creative MO, 08-20). */
      medias?: { url?: string; kind?: string; coverUrl?: string }[];
      /** Single-creative fields — the pre-multi wire, still sent (and accepted) for open tabs. */
      mediaUrl?: string;
      mediaKind?: string;
      coverUrl?: string;
      /** Legacy client field (pre-image builds still in open tabs) — video by definition. */
      videoUrl?: string;
      taskId?: string;
    };
    campaign = (j.campaign ?? {}) as Campaign;
    partnerId = String(j.partnerId ?? "in") as PartnerId;
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
      const url =
        typeof j.mediaUrl === "string" && j.mediaUrl ? j.mediaUrl : typeof j.videoUrl === "string" ? j.videoUrl : "";
      const kind = j.mediaKind === "image" ? ("image" as const) : ("video" as const);
      medias = [
        { url, kind, coverUrl: kind === "video" && typeof j.coverUrl === "string" ? j.coverUrl.trim() : "" },
      ];
    }
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
  // Fire-time belt over the picker filter: /accounts assignments hold even for a crafted POST.
  if (!(await accountAllowedFor(session, binds.accountId))) {
    return NextResponse.json({ ok: false, stage: "config", error: ACCOUNT_NOT_ASSIGNED_MSG }, { status: 403 });
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
      // Owner rule (2026-08-11): min-ROAS may only optimize on the partner's value pixel — the
      // one with real purchase-value history. Any other pixel is rejected before any claim/write.
      if (bidKind(campaign.bidStrategy) === "roas" && pickedPixel !== ROAS_PIXEL.id) {
        return NextResponse.json(
          {
            ok: false,
            stage: "config",
            error: `roas_pixel_required — min-ROAS launches run only on ${ROAS_PIXEL.name} (${ROAS_PIXEL.id})`,
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
  if (medias.length === 0 || medias.some((m) => !m.url)) {
    return NextResponse.json({ ok: false, stage: "media", error: "media_required" }, { status: 400 });
  }
  // A video ad's destination rides ONLY on its CTA button (creativePayload puts the link inside
  // call_to_action) — a "No CTA" video would reach Meta with no link at all: rejected after the
  // campaign/adset/marker already exist, or delivered unclickable (review find 08-24). Image
  // creatives carry a top-level link and may stay CTA-less.
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
  // The creative must be a Vercel Blob URL our OWN broker produced — never an arbitrary URL.
  // Otherwise a logged-in user could make FB (or this function, for images) fetch any URL, or make
  // `del()` target a blob outside our flow. Our broker always uploads to `creatives/<taskid>-<name>`
  // on the *.blob.vercel-storage.com host over https, so we require both the host suffix AND that
  // path prefix — narrowing the surface to blobs this app actually creates (rev-api #2).
  {
    // Server-side creative cap — the partner's own limit, never the client's word (a stale tab
    // could still POST more; the tree would then blow the function window mid-wave).
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
  if (bidAmountMissing(campaign)) {
    return NextResponse.json(
      { ok: false, stage: "config", error: "Bid amount required for the selected bid strategy" },
      { status: 400 },
    );
  }
  // Mirror the HS guard: a min-ROAS goal above 100 (10 000%) is a typo, not a bid, and the
  // ambiguous 10–20 band is refused rather than guessed (normalizeRoasGoal). Rejected here so no
  // campaign/gcm exists yet (Meta would only refuse at the ad-set step, orphaning both).
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

  // Image launches + custom video covers: fetch + validate EVERY one BEFORE the stream — an
  // oversized image must die here as a clean 400 (nothing claimed, no campaign shell), not 20s
  // into the wave at adimages. Validated bytes ride into the stream so no Blob is fetched twice.
  // Worst case is bounded: 5 creatives × ≤8MB (fetchValidatedImage ceiling) ≈ 40MB in memory.
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
      // partner="in" on every write: if THIS writer creates the row (client's queued-save failed,
      // browser died), a null partner would match neither drawer scope — invisible team-wide.
      const tw = taskWriter(session.username, taskId, { partner: "in" });
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
      let acctSlot: { documentId: string } | null = null;
      try {
        // 0) claim the ACCOUNT's launch slot — at most 5 campaigns per ad account per 30-min
        // window, across every user and channel (owner rule 2026-08-18). Throws the human
        // countdown message when the window is full; released below on any pre-campaign failure.
        progress("gcm");
        acctSlot = await claimAcctSlot(binds.accountId, {
          user: session.username,
          partner: "in",
          channel: "launch",
          name,
          accountName: await tokenAccountName(binds.accountId).catch(() => ""),
        });

        // 1) reserve the gcm BEFORE building the link (guarantees no duplicate marker)
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

        // 2) register EVERY creative. Videos: FB pulls each from its Blob URL — all uploads are
        // fired first (advideos answers immediately, Meta processes in the background, in
        // parallel), THEN processing is waited out one by one, so a 5-video card's wall-clock is
        // ~the slowest video, not the sum. Images: validated bytes go straight into the account's
        // image library (no processing step).
        progress("video");
        type RegisteredMedia =
          | { kind: "image"; imageHash: string }
          | { kind: "video"; videoId: string; thumbUrl: string; coverHash?: string };
        const regs: RegisteredMedia[] = new Array(medias.length);
        for (let i = 0; i < medias.length; i++) {
          const m = medias[i];
          if (m.kind === "image") {
            regs[i] = { kind: "image", imageHash: await uploadImage(binds.accountId, imageBufs.get(i) as Buffer) };
          } else {
            const suffix = medias.length > 1 ? ` · video ${i + 1}` : " · video";
            regs[i] = { kind: "video", videoId: await uploadVideo(binds.accountId, m.url, `${name}${suffix}`), thumbUrl: "" };
          }
        }
        created.video_id = regs.find((r) => r.kind === "video")?.videoId ?? undefined;
        created.image_hash = (regs.find((r) => r.kind === "image") as { imageHash?: string } | undefined)?.imageHash;
        progress("processing");
        for (let i = 0; i < medias.length; i++) {
          const r = regs[i];
          if (r.kind !== "video") continue;
          await waitForVideo(r.videoId);
          // A custom cover replaces the auto-thumbnail entirely (no thumbnail poll needed).
          const coverBuf = coverBufs.get(i);
          if (coverBuf) r.coverHash = await uploadImage(binds.accountId, coverBuf);
          else r.thumbUrl = await videoThumb(r.videoId);
        }
        const localeIds = await resolveLocales(campaign.locales);

        // 3) campaign → adset → creative → ad, all ACTIVE (live on creation since 08-11)
        progress("campaign");
        const camp = await fbPost(`act_${binds.accountId}/campaigns`, campaignPayload(campaign, name));
        created.campaign_id = String(camp.id);

        progress("adset");
        const adset = await withParentRetry(String(camp.id), () =>
          createAdsetSelfHealing(`act_${binds.accountId}/adsets`, adsetPayload(campaign, name, String(camp.id), binds, localeIds)),
        );
        created.adset_id = String(adset.id);

        progress("creative");
        const creativeIds: string[] = [];
        for (let i = 0; i < regs.length; i++) {
          const r = regs[i];
          const adName = regs.length > 1 ? `${name} · ${i + 1}` : name;
          const creative = await fbPost(
            `act_${binds.accountId}/adcreatives`,
            r.kind === "image"
              ? imageCreativePayload(campaign, adName, binds, { imageHash: r.imageHash, link })
              : creativePayload(campaign, adName, binds, {
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
            fbPost(`act_${binds.accountId}/ads`, adPayload(adName, String(adset.id), creativeIds[i])),
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
        // fire-safe — the box's next Facebook sweep reconciles either way) + record the FB ids
        // against the claimed gcm (best-effort; mirrors into the ledger epoch)
        await reportPagesUsed("in", [{ pageId: binds.pageId, delta: adIds.length }]);
        await backfillGcm(
          claim.documentId,
          {
            campaign_id: created.campaign_id,
            adset_id: created.adset_id,
            ad_id: created.ad_id,
          },
          claim.gcm,
        );

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
        // Free the account's launch slot when NO campaign was created — the window only meters
        // campaigns that actually exist on FB. Once one exists the slot stays consumed.
        if (acctSlot && !created.campaign_id) await releaseAcctSlot(acctSlot.documentId);
        // The tree is born ACTIVE (08-11), so a failed launch must never keep delivering: any ads
        // created before the failure (multi-creative loop) are already spending. Pause the
        // campaign first — bounded to PAUSE_CONFIRM_MS so a throttle-caused failure can't hang
        // the stream on its own pause attempt — and carry the confirmed state into the message.
        const disposition = launchFailureDisposition(created);
        let pausedOk = false;
        if (disposition.pauseNeeded) {
          pausedOk = await Promise.race([
            fbPost(String(created.campaign_id), { status: "PAUSED" }).then(
              () => true,
              () => false,
            ),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), PAUSE_CONFIRM_MS)),
          ]);
        }
        const failMsg = `${err.message ?? String(e)}${partialFailureNote(disposition, pausedOk)}`;
        // Free the gcm code when nothing was created on FB (early failures like a rate limit or a
        // video error) so the 01–200 pool never leaks; keep the row (marked failed) once a campaign
        // exists so the orphaned (paused above) campaign stays traceable.
        if (claim?.documentId) {
          if (created.campaign_id)
            // "retired" — the registry's status enum is active|retired; "failed" is rejected by
            // Strapi (the whole PUT 400s and backfillGcm swallows it, losing the note AND the ids).
            await backfillGcm(
              claim.documentId,
              {
                status: "retired",
                notes: `launch failed: ${failMsg}`,
                // Record what DID get created so the orphaned campaign is traceable by code.
                campaign_id: created.campaign_id,
                ...(created.adset_id ? { adset_id: created.adset_id } : {}),
              },
              claim.gcm,
            );
          else await deleteGcm(claim.documentId, claim.gcm);
        }
        settled = true;
        tw.write({
          status: "error",
          stage: lastStage,
          finished_at: Date.now(),
          error: failMsg,
          ...(created.campaign_id ? { campaign_id: created.campaign_id } : {}),
          ...(created.adset_id ? { adset_id: created.adset_id } : {}),
        });
        send({ ok: false, stage: "error", error: failMsg, detail: err.detail ?? null, created });
      } finally {
        clearInterval(beat);
        // Drop EVERY temporary Blob (creatives + covers) whether the launch succeeded or failed —
        // never orphan an upload. Awaited (not fire-and-forget) so it completes before the stream
        // closes and Vercel can freeze the function; "done"/"error" was already sent, no visible wait.
        for (const m of medias) {
          await del(m.url, { token: process.env.BLOB_READ_WRITE_TOKEN }).catch(() => {});
          if (m.coverUrl) await del(m.coverUrl, { token: process.env.BLOB_READ_WRITE_TOKEN }).catch(() => {});
        }
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
