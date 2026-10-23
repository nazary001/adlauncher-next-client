import { NextResponse } from "next/server";
import { type Campaign, bidAmountMissing, bidKind, bidTag, normalizeRoasGoal, parseMoney, withPartnerMark } from "@/lib/types";
import { type PartnerId, partnerConfig } from "@/lib/partners";
import { VC_PIXEL, vcDelivery, vcDestination, vcLink } from "@/lib/vc-link";
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
import { isLegacyBlobUrl, isOwnCreativeUrl } from "@/lib/creative-url";
import { type VcRail, vcRail, vcRailEnabled } from "@/lib/vc-launch";
import { vcToolCatalog, VC_TOOL_NO_SESSION } from "@/lib/vc-tool";
import { localeKeysOf } from "@/lib/locale-keys";
import { claimAcctSlot, releaseAcctSlot } from "@/lib/acct-limit";
import { ACCOUNT_NOT_ASSIGNED_MSG, accountAllowedFor } from "@/lib/acct-assignments";
import { taskWriter } from "@/lib/task-store";
import { del } from "@vercel/blob";
// TOOL launch channel (owner ask 23.10: "сделай на основе Tool тоже этого партнера") — a `via:"tool"`
// body flag runs this VC launch through the HS team's Ads Manager sessions service instead of the
// direct-Graph tree: same auth, rail/catalog validation, acct-slot claim and NDJSON contract, but the
// whole campaign→adset→ad build is one TOOL job. The TOOL key never leaves the server.
import {
  buildToolCampaign,
  runToolMedia,
  runToolPublish,
  toolEnsureMark,
  type ToolCreated,
  type ToolCreativeInput,
  type ToolNdjsonStage,
} from "@/lib/tool-launch";
import { toolDeps, toolInputFromCampaign } from "@/lib/tool-run";

export const runtime = "nodejs";
export const maxDuration = 300;

type Json = Record<string, unknown>;

// Same per-launch FB retry budget as the MO / AIF routes: rate-limited calls wait out Meta's regain
// estimate but never past the deadline — the hard failure must land INSIDE the function so the error
// path (slot release, task row settle) always runs.
const FB_BUDGET_MS = 240_000;
const FB_BUDGET_RETRIES = 8;

// TOOL launch deadline — twin of the MO / AIF routes: media registration + the publish job share this
// wall-clock budget from request start; 265 s < maxDuration 300 s keeps the deadline INSIDE the
// function so a pending job settles the row (slot KEPT, note "pending tool job #N").
const TOOL_DEADLINE_MS = 265_000;

// ---------- languages ----------
// Meta ad-locale keys come from a static table (lib/locale-keys) — no Graph search, so the TOOL path
// needs no token, and a language Meta has no locale for is refused instead of silently dropped.

// ---------- orchestration ----------

/**
 * POST /api/vc/launch — the VC (ValueClick) launch rail. Mirrors /api/aif/launch stage for stage (same
 * NDJSON events, same Task Manager pipeline, up to 5 creatives — one campaign → one ad set → one ad
 * per creative) with the rail's own pieces: the tree is built on VC's token (/tokens VC · Launches),
 * the ad link is the buyer's VC Content Arb landingpage link as VC prints it (lib/vc-link vcDestination —
 * only VC's own domains, only …/coa/<quiz>-<id>/; a Search Arb link is refused), and the delivery is
 * pinned by the server: Purchase on VC_PIXEL (conversions / min-ROAS — VC fires it through the
 * Conversions API with a value) or Traffic / link clicks with no pixel. No marker pool: the
 * landingpage id is VC's revenue key.
 * `via:"tool"` builds the same campaign through TOOL (one job) and needs NO VC token (owner ask 23.10):
 * the cabinet must be one of VC's in TOOL (named GC-for-VC-* / seen by a session of TOOL's "VC"
 * project) or a token cabinet TOOL sees; a typed page id is accepted and TOOL checks page + pixel at
 * publish. With a token, the token's own checks (page, pixel) still run first.
 */
export async function POST(req: Request) {
  // Proxy-gated, but self-checks the session too (parity with /api/launch).
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) {
    return NextResponse.json({ ok: false, stage: "auth", error: "unauthorized" }, { status: 401 });
  }
  if (!vcRailEnabled()) {
    return NextResponse.json({ ok: false, stage: "config", error: "vc_rail_disabled" }, { status: 404 });
  }

  let campaign: Campaign;
  /** Creatives of this launch (1..maxCreatives): own creative-store URLs; cover = video thumbnail image. */
  let medias: { url: string; kind: "video" | "image"; coverUrl: string }[] = [];
  let taskId: string | null = null;
  /** `via:"tool"` routes this launch through TOOL; absent / anything else = direct Graph. */
  let viaTool = false;
  // Wall-clock origin for the TOOL job deadline (see TOOL_DEADLINE_MS), before any await.
  const startedAt = Date.now();
  try {
    const j = (await req.json()) as {
      campaign?: Campaign;
      partnerId?: string;
      medias?: { url?: string; kind?: string; coverUrl?: string }[];
      /** Single-creative fields — the queue runner still sends them next to `medias`. */
      mediaUrl?: string;
      mediaKind?: string;
      coverUrl?: string;
      taskId?: string;
      /** "tool" = launch through TOOL; absent / anything else = direct Graph. */
      via?: string;
    };
    campaign = (j.campaign ?? {}) as Campaign;
    viaTool = j.via === "tool";
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
      medias = [{ url, kind, coverUrl: kind === "video" && typeof j.coverUrl === "string" ? j.coverUrl.trim() : "" }];
    }
    taskId = typeof j.taskId === "string" && /^[\w-]{6,64}$/.test(j.taskId) ? j.taskId : null;
  } catch (e) {
    return NextResponse.json({ ok: false, stage: "parse", error: String(e) }, { status: 400 });
  }

  // The VC launch signer is the OWNER'S pick on /tokens (vc.launch slot, no env default). The direct
  // Graph path cannot run without it (clean config error, never another bearer); the TOOL path can.
  const railRes = await vcRail("launch");
  if (!railRes.ok && !viaTool) {
    return NextResponse.json({ ok: false, stage: "config", error: railRes.error }, { status: 400 });
  }
  const rail: VcRail | null = railRes.ok ? railRes.rail : null;
  // TOOL path: the account's TOOL-side currency (buildToolCampaign's USD guard backstop) and name.
  let toolAcctCurrency = "USD";
  let toolAcctName = "";

  const partner = partnerConfig("vc" as PartnerId);
  // Server-pinned delivery: Purchase on VC_PIXEL (conversions / min-ROAS) or Traffic / link clicks
  // with no pixel — whatever objective / pixel / event a stale or edited draft sent.
  const delivery = vcDelivery(String(campaign.optimization ?? ""), String(campaign.bidStrategy ?? ""));
  const pickedAccount = String(campaign.account ?? "").trim().replace(/^act_/, "");
  const pickedPage = String(campaign.page ?? "").trim();
  const binds: LaunchBinds = {
    accountId: pickedAccount,
    pageId: pickedPage,
    pageName: "", // resolved below, once the picked page passes validation
    pixelId: delivery.pixel,
  };
  // Fire-time belt over the picker filter: /accounts assignments hold even for a crafted POST.
  if (!(await accountAllowedFor(session, pickedAccount))) {
    return NextResponse.json({ ok: false, stage: "config", error: ACCOUNT_NOT_ASSIGNED_MSG }, { status: 403 });
  }

  try {
    if (!/^\d{5,}$/.test(pickedAccount)) {
      return NextResponse.json({ ok: false, stage: "config", error: "account_required — pick an ad account on the campaign card" }, { status: 400 });
    }
    const tokenAccount = rail ? await rail.isTokenAccount(pickedAccount) : false;
    if (viaTool) {
      // TOOL must be up and see the cabinet, and the cabinet must be VC's (in TOOL) or the token's —
      // one forced re-read on a miss (the 60 s cache may predate a session an owner just added).
      let cat = await vcToolCatalog();
      if (cat.ok && !cat.live.some((a) => a.account_id === pickedAccount)) cat = await vcToolCatalog(true);
      if (!cat.ok) return NextResponse.json({ ok: false, stage: "config", error: cat.message }, { status: 400 });
      const live = cat.live.find((a) => a.account_id === pickedAccount);
      if (!live) {
        return NextResponse.json(
          { ok: false, stage: "config", error: `tool_account_unavailable — no live TOOL session sees ad account ${pickedAccount}; ${VC_TOOL_NO_SESSION}` },
          { status: 400 },
        );
      }
      if (!tokenAccount && !cat.vc.some((a) => a.account_id === pickedAccount)) {
        return NextResponse.json(
          { ok: false, stage: "config", error: `account_not_vc — act_${pickedAccount} (${live.name}) is not a VC cabinet in TOOL (GC-for-VC-… or a session of the "VC" project) and no VC token holds it` },
          { status: 400 },
        );
      }
      toolAcctCurrency = live.currency || "USD";
      toolAcctName = live.name;
    } else if (!tokenAccount) {
      return NextResponse.json({ ok: false, stage: "config", error: "account_not_allowed — the VC token cannot use this ad account" }, { status: 400 });
    }
    if (!/^\d{5,}$/.test(pickedPage)) {
      return NextResponse.json({ ok: false, stage: "config", error: "fanpage_required — pick (or type the id of) a fanpage on the campaign card" }, { status: 400 });
    }
    const tokenPage = rail ? await rail.isAdvertisablePage(pickedPage) : false;
    if (rail && tokenPage) {
      // DSA beneficiary/payor for EU-reaching ad sets — same rule as MO / AIF.
      binds.pageName = await rail.advertisablePageName(pickedPage);
    } else if (!viaTool) {
      return NextResponse.json({ ok: false, stage: "config", error: "fanpage_not_allowed — the VC token cannot advertise with this page" }, { status: 400 });
    }
    // (TOOL with a page the token does not hold: TOOL checks the session's access to it at publish.)
    // A Purchase launch optimizes on VC_PIXEL — it must be shared to the cabinet, or Meta refuses the
    // ad set only after the campaign exists (orphan). Checked here when the token holds the cabinet;
    // a TOOL-only cabinet has its pixel checked by TOOL at publish.
    if (binds.pixelId && rail && tokenAccount) {
      const pixels = await rail.accountPixels(pickedAccount);
      if (!pixels.some((p) => p.id === binds.pixelId)) {
        return NextResponse.json(
          {
            ok: false,
            stage: "config",
            error: `pixel_not_on_account — ${VC_PIXEL.name} ${VC_PIXEL.id} is not shared to act_${pickedAccount}; share it in Business Manager first (or launch with Clicks optimization)`,
          },
          { status: 400 },
        );
      }
    }
  } catch (e) {
    const err = e as FbError;
    if (err instanceof FbError && err.status === 400) {
      return NextResponse.json({ ok: false, stage: "config", error: err.message }, { status: 400 });
    }
    return NextResponse.json({ ok: false, stage: "config", error: `destination check failed: ${err.message ?? String(e)}` }, { status: 502 });
  }

  // The destination must be a VC Content Arb landingpage link (VC's domains, /coa/<quiz>-<id>/) — a stale
  // / mistyped paste would build a live ad pointing at a page VC does not pay for.
  const dest = vcDestination(String(campaign.landing ?? ""));
  if (!dest.ok) {
    return NextResponse.json({ ok: false, stage: "config", error: dest.error }, { status: 400 });
  }
  if (medias.length === 0 || medias.some((m) => !m.url)) {
    return NextResponse.json({ ok: false, stage: "media", error: "media_required" }, { status: 400 });
  }
  // Same contract as /api/launch: a video creative's destination link lives inside its CTA.
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
  // Every creative must be a URL this app itself produced (the S3 creative store / legacy Blob) — the
  // same SSRF fence as the other rails; the count is capped by the partner's own limit.
  {
    const cap = Math.max(1, partner.maxCreatives ?? 1);
    if (medias.length > cap) {
      return NextResponse.json({ ok: false, stage: "media", error: `too_many_creatives — this partner launches at most ${cap} per campaign` }, { status: 400 });
    }
    for (const m of medias) {
      if (!isOwnCreativeUrl(m.url)) return NextResponse.json({ ok: false, stage: "media", error: "media_url_invalid" }, { status: 400 });
      if (m.coverUrl && !isOwnCreativeUrl(m.coverUrl)) return NextResponse.json({ ok: false, stage: "media", error: "cover_url_invalid" }, { status: 400 });
    }
  }
  if (!SUPPORTED_BID_STRATEGIES.has(campaign.bidStrategy)) {
    return NextResponse.json({ ok: false, stage: "config", error: "bid_strategy_invalid" }, { status: 400 });
  }
  if (bidAmountMissing(campaign)) {
    return NextResponse.json({ ok: false, stage: "config", error: "Bid amount required for the selected bid strategy" }, { status: 400 });
  }
  // Mirror /api/launch: a min-ROAS goal above 100 (10 000%) is a typo, and the ambiguous 10–20 band is
  // refused rather than guessed — rejected here, before anything exists on FB.
  if (bidKind(campaign.bidStrategy) === "roas") {
    const goal = parseMoney(campaign.bidCap);
    if (goal > 100) {
      return NextResponse.json({ ok: false, stage: "config", error: "roas_goal_invalid — ROAS goal must be 0–100" }, { status: 400 });
    }
    if (normalizeRoasGoal(goal) == null) {
      return NextResponse.json({ ok: false, stage: "config", error: "roas_goal_ambiguous — type the decimal goal (0,30 = 30%)" }, { status: 400 });
    }
  }
  if (!Array.isArray(campaign.countries) || campaign.countries.length === 0) {
    return NextResponse.json({ ok: false, stage: "config", error: "geo_required — pick at least one country" }, { status: 400 });
  }
  if (money(campaign.budget) < 100) {
    return NextResponse.json({ ok: false, stage: "config", error: "budget_too_low — daily budget must be at least $1" }, { status: 400 });
  }

  // Image launches + custom video covers: fetch + validate EVERY one BEFORE the stream (clean 400,
  // nothing claimed).
  const imageBufs = new Map<number, Buffer>();
  const coverBufs = new Map<number, Buffer>();
  try {
    for (let i = 0; i < medias.length; i++) {
      if (medias[i].kind === "image") imageBufs.set(i, await fetchValidatedImage(medias[i].url));
      if (medias[i].coverUrl) coverBufs.set(i, await fetchValidatedImage(medias[i].coverUrl));
    }
  } catch (e) {
    return NextResponse.json({ ok: false, stage: "media", error: (e as FbError).message ?? String(e) }, { status: 400 });
  }

  // Languages → Meta ad-locale keys (static table): a language Meta has no locale for is refused
  // here, never dropped (dropping would silently target every language).
  const locales = localeKeysOf(Array.isArray(campaign.locales) ? campaign.locales : []);
  if (locales.unknown.length) {
    return NextResponse.json(
      { ok: false, stage: "config", error: `language_unsupported — Meta has no ad locale for ${locales.unknown.join(", ")}; remove it from Languages` },
      { status: 400 },
    );
  }
  const localeIds = locales.ids;

  const serverCampaign: Campaign = { ...campaign, ...delivery };
  // The partner mark in the prefix is the ROUTE's, not the client's: a card that kept another
  // partner's prefix across a switch still launches here as "(VC)". A TOOL-born run carries
  // `GCL TOOL - ` after the partner prefix (toolEnsureMark).
  const baseName = withPartnerMark(`${serverCampaign.namePrefix}${serverCampaign.name}`.trim(), partner.label);
  const name = viaTool ? toolEnsureMark(baseName) : baseName;
  // The ad link: the landingpage link exactly as VC prints it (normalized) — Content Arb takes no
  // params of ours; Meta's own fbclid is what VC matches the click by.
  const link = vcLink(dest.url);

  const encoder = new TextEncoder();
  const stream = withFbBudget({ deadlineAt: Date.now() + FB_BUDGET_MS, retries: FB_BUDGET_RETRIES }, () =>
    new ReadableStream<Uint8Array>({
      async start(controller) {
        // On the TOOL path a client that closed the tab makes enqueue throw — swallow it so a disconnect
        // never unwinds the TOOL branch mid-poll (TOOL creates AND activates server-side). The Graph
        // path keeps throwing (its tree is not settled server-side when the stream dies).
        const send = (o: Json) => {
          try {
            controller.enqueue(encoder.encode(JSON.stringify(o) + "\n"));
          } catch (e) {
            if (!viaTool) throw e;
          }
        };
        // Mirror progress into the shared launch-task row — partner="vc" on every write, so the row lands
        // in the VC drawer's scope even when this writer is the one that creates it.
        const bidLabel = bidTag(campaign.bidStrategy, campaign.bidCap);
        const tw = taskWriter(session.username, taskId, { partner: "vc", ...(bidLabel ? { bid: bidLabel } : {}) });
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
        let acctSlot: { documentId: string } | null = null;
        // Set by runToolPublish's onSubmitted the instant TOOL returns a job id. Once set, a throw
        // reaching the catch with no known campaign id settles as PENDING (slot kept) — the job may
        // still be creating the live campaign.
        let toolSubmittedJob: number | null = null;
        try {
          // 0) claim the ACCOUNT's launch slot — at most 5 campaigns per ad account per window, across
          // every user and channel. Released below on any pre-campaign failure.
          progress("gcm");
          acctSlot = await claimAcctSlot(binds.accountId, {
            user: session.username,
            partner: "vc",
            channel: viaTool ? "vc-tool" : "vc",
            name,
            accountName: toolAcctName || (rail ? await rail.accountName(binds.accountId).catch(() => "") : ""),
          });

          // ==========================================================================================
          // TOOL launch block — twin of the AIF route's. Replaces the direct-Graph upload+tree with ONE
          // TOOL job (media from the creative URL → CampaignRequest → submit → poll). Every terminal
          // state settles the row and RETURNS, so the Graph code below stays untouched. TOOL creates
          // PAUSED and activates last. Money is USD, ROAS a coefficient.
          // ==========================================================================================
          if (viaTool) {
            const deadlineAt = startedAt + TOOL_DEADLINE_MS;
            const idempotencyKey = taskId || `vc-tool-${dest.lpId}-${startedAt.toString(36)}`;
            const onStage = (s: ToolNdjsonStage) => {
              if (s !== "done" && s !== "error") progress(s);
            };
            // Terminal failure: release the slot only when nothing was created (a definite outcome —
            // runToolPublish turns every ambiguous end into `pending`, handled below).
            const toolFail = async (msg: string, opts: { created?: ToolCreated; jobId?: number } = {}) => {
              if (opts.created?.campaignId) {
                created.campaign_id = opts.created.campaignId;
                if (opts.created.adsetIds[0]) created.adset_id = opts.created.adsetIds[0];
              }
              if (acctSlot && !created.campaign_id) await releaseAcctSlot(acctSlot.documentId);
              settled = true;
              tw.write({
                status: "error",
                stage: lastStage,
                finished_at: Date.now(),
                error: msg,
                ...(created.campaign_id ? { campaign_id: created.campaign_id } : {}),
                ...(created.adset_id ? { adset_id: created.adset_id } : {}),
              });
              send({ ok: false, stage: "error", via: "tool", ...(opts.jobId ? { tool_job_id: opts.jobId } : {}), error: msg, created });
            };

            // 1t) register every creative through TOOL from its public URL (+ custom video cover).
            progress("video");
            const mediaRun = await runToolMedia(
              toolDeps,
              binds.accountId,
              medias.map((m, i) => ({
                url: m.url,
                kind: m.kind,
                name: medias.length > 1 ? `${name} · ${i + 1}` : name,
                coverUrl: m.coverUrl || undefined,
              })),
              { deadlineAt, onStage },
            );
            if (!mediaRun.ok) {
              await toolFail(`TOOL media registration failed: ${mediaRun.error}`);
              return;
            }

            // The creatives with the TOOL MediaRefs + the VC link + the card's copy (same field mapping
            // as fb-launch: copy→primary_text, headline||title→headline, title→description).
            const creatives: ToolCreativeInput[] = medias.map((m, i) => {
              const ref = mediaRun.refs[i];
              const c: ToolCreativeInput = {
                name: medias.length > 1 ? `${name} · ${i + 1}` : name,
                media: ref.media,
                primaryText: serverCampaign.copy || "",
                headline: serverCampaign.headline || serverCampaign.title || "",
                url: link,
                cta: serverCampaign.cta || "",
              };
              if (ref.thumbnail) c.thumbnail = ref.thumbnail;
              if (serverCampaign.title && serverCampaign.headline && serverCampaign.title !== serverCampaign.headline)
                c.description = serverCampaign.title;
              return c;
            });

            const built = buildToolCampaign(
              toolInputFromCampaign(serverCampaign, {
                name,
                pageId: binds.pageId,
                pixelId: binds.pixelId,
                localeIds,
                creatives,
                status: "ACTIVE", // VC launches go live; TOOL creates PAUSED then activates on success
                accountCurrency: toolAcctCurrency,
              }),
            );
            if (!built.ok) {
              await toolFail(`TOOL rejected the campaign: ${built.error}`);
              return;
            }

            // 2t) submit the create job and follow it to a terminal state.
            progress("campaign");
            const pub = await runToolPublish(toolDeps, binds.accountId, built.body, {
              idempotencyKey,
              deadlineAt,
              onStage,
              onSubmitted: (jobId) => {
                toolSubmittedJob = jobId;
              },
            });

            if (pub.ok) {
              created.campaign_id = pub.campaignId;
              created.adset_id = pub.adsetId;
              created.ad_id = pub.adIds[0];
              if (pub.adIds.length > 1) created.ad_ids = [...pub.adIds];
              settled = true;
              tw.write({
                status: "done",
                stage: "ad",
                finished_at: Date.now(),
                campaign_id: pub.campaignId,
                adset_id: pub.adsetId,
                ad_id: pub.adIds[0],
                link,
                gcm: dest.lpId,
                error: null,
              });
              send({
                ok: true,
                stage: "done",
                via: "tool",
                tool_job_id: pub.jobId,
                gcm: dest.lpId,
                link,
                page_id: binds.pageId,
                campaign_id: pub.campaignId,
                adset_id: pub.adsetId,
                ad_id: pub.adIds[0],
                ...(pub.adIds.length > 1 ? { ad_ids: pub.adIds } : {}),
              });
              return;
            }

            if (pub.pending) {
              // Deadline hit while TOOL was still working — KEEP the slot (the campaign may yet be born);
              // the job is traceable on Ads Manager sessions → Jobs.
              if (pub.created?.campaignId) created.campaign_id = pub.created.campaignId;
              const pendingMsg = `pending tool job #${pub.jobId ?? "?"} — check Ads Manager sessions → Jobs`;
              settled = true;
              tw.write({
                status: "error",
                stage: lastStage,
                finished_at: Date.now(),
                error: pendingMsg,
                ...(pub.created?.campaignId ? { campaign_id: pub.created.campaignId } : {}),
              });
              send({ ok: false, stage: "error", pending: true, via: "tool", tool_job_id: pub.jobId, error: pub.error });
              return;
            }

            // Definite failure (refusal or the job ended error/partial) — anything created is PAUSED.
            await toolFail(pub.error, { created: pub.created, jobId: pub.jobId });
            return;
          }

          // The Graph tree needs the VC token (checked before the stream: a token-less launch is TOOL-only).
          const graph = rail;
          if (!graph) throw new FbError("no_vc_token — the direct Graph path needs the VC token (VC · Launches)", null, 400);
          // 1) register EVERY creative on the VC account: video uploads fired first (Meta processes them
          // in parallel), then waited out one by one; images: validated bytes → adimages hash.
          progress("video");
          type RegisteredMedia = { kind: "image"; imageHash: string } | { kind: "video"; videoId: string; thumbUrl: string; coverHash?: string };
          const regs: RegisteredMedia[] = new Array(medias.length);
          for (let i = 0; i < medias.length; i++) {
            const m = medias[i];
            if (m.kind === "image") {
              regs[i] = { kind: "image", imageHash: await graph.uploadImage(binds.accountId, imageBufs.get(i) as Buffer) };
            } else {
              const suffix = medias.length > 1 ? ` · video ${i + 1}` : " · video";
              regs[i] = { kind: "video", videoId: await graph.uploadVideo(binds.accountId, m.url, `${name}${suffix}`), thumbUrl: "" };
            }
          }
          created.video_id = regs.find((r) => r.kind === "video")?.videoId ?? undefined;
          created.image_hash = (regs.find((r) => r.kind === "image") as { imageHash?: string } | undefined)?.imageHash;
          progress("processing");
          for (let i = 0; i < medias.length; i++) {
            const r = regs[i];
            if (r.kind !== "video") continue;
            await graph.waitForVideo(r.videoId);
            // A custom cover replaces the auto-thumbnail entirely (no thumbnail poll needed).
            const coverBuf = coverBufs.get(i);
            if (coverBuf) r.coverHash = await graph.uploadImage(binds.accountId, coverBuf);
            else r.thumbUrl = await graph.videoThumb(r.videoId);
          }

          // 2) campaign → adset → one creative+ad PER media, all ACTIVE (parity with the other rails)
          progress("campaign");
          const camp = await graph.fbPost(`act_${binds.accountId}/campaigns`, campaignPayload(serverCampaign, name));
          created.campaign_id = String(camp.id);

          progress("adset");
          const adset = await withParentRetry(String(camp.id), () =>
            graph.createAdset(`act_${binds.accountId}/adsets`, adsetPayload(serverCampaign, name, String(camp.id), binds, localeIds)),
          );
          created.adset_id = String(adset.id);

          progress("creative");
          const creativeIds: string[] = [];
          for (let i = 0; i < regs.length; i++) {
            const r = regs[i];
            const adName = regs.length > 1 ? `${name} · ${i + 1}` : name;
            const creative = await graph.fbPost(
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
              graph.fbPost(`act_${binds.accountId}/ads`, adPayload(adName, String(adset.id), creativeIds[i])),
            );
            // Belt over the fbPost error-body guard: never record a phantom "undefined" ad id.
            if (!ad.id) throw new FbError("ad create returned no id", ad);
            adIds.push(String(ad.id));
            // Progress lands on `created` AS ads are born: the catch reads it to know whether money moves.
            created.ad_id = adIds[0];
            if (adIds.length > 1) created.ad_ids = [...adIds];
            send({ stage: "ad", done: adIds.length, total: creativeIds.length });
          }

          settled = true;
          tw.write({
            status: "done",
            stage: "ad",
            finished_at: Date.now(),
            campaign_id: created.campaign_id,
            adset_id: created.adset_id,
            ad_id: created.ad_id,
            link,
            // The shared task row's marker column carries the landingpage id on this rail.
            gcm: dest.lpId,
            error: null,
          });
          send({ ok: true, stage: "done", gcm: dest.lpId, link, page_id: binds.pageId, ...created });
        } catch (e) {
          const err = e as FbError;
          // TOOL belt: TOOL accepted the submit but no campaign id is known — the job may be creating
          // AND activating it server-side. Settle like the TOOL PENDING terminal (keep the slot).
          if (viaTool && toolSubmittedJob != null && !created.campaign_id) {
            const pendingMsg = `pending tool job #${toolSubmittedJob} — check Ads Manager sessions → Jobs`;
            settled = true;
            tw.write({ status: "error", stage: lastStage, finished_at: Date.now(), error: pendingMsg });
            send({ ok: false, stage: "error", pending: true, via: "tool", tool_job_id: toolSubmittedJob, error: err.message ?? String(e) });
            return;
          }
          // Free the account's launch slot when NO campaign was created — the window only meters
          // campaigns that actually exist on FB. Once one exists the slot stays consumed.
          if (acctSlot && !created.campaign_id) await releaseAcctSlot(acctSlot.documentId);
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
          // Creatives live in content-addressed S3 objects shared by cards, retries and waves — nothing
          // is deleted per launch; del() stays only for a legacy Blob URL (tabs opened before S3).
          for (const m of medias) {
            if (isLegacyBlobUrl(m.url)) await del(m.url, { token: process.env.BLOB_READ_WRITE_TOKEN }).catch(() => {});
            if (m.coverUrl && isLegacyBlobUrl(m.coverUrl)) await del(m.coverUrl, { token: process.env.BLOB_READ_WRITE_TOKEN }).catch(() => {});
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
