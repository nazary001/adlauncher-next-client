// VC (ValueClick) clone RUN — the server half of the VC cloner (lib/vc-clone holds the pure contract;
// owner ask 05.11: "сделать клоны всех активных кампаний на этот новый пиксель … через TOOL в нашем
// адлаунчере, но если уже не получится через него то через этот токен"; owner ask 17.11: a full cloner like
// the other partners' — "чтобы можно было акк выбрать"). Entered through POST /api/clone/run with partnerId
// "vc" — the queue's fb.clone kind, whose body's partnerId picks the rail — so the VC drawer, the hand-off
// screen and the server pump are the shared ones.
//
// Per edit: ONE Graph read of the source tree with the VC token (the clone rail — VC · Clones when assigned,
// else VC · Launches), the refusals (a bad edit burns nothing: no claim, no write), the launch slot of the
// cabinet the clone is BUILT in, then the recreate — campaign → ad set → one creative + ad PER source ad, on
// the VC token (Graph) or through TOOL (one job; `via:"tool"`). The clone lands in the source's own cabinet,
// or in another VC cabinet the buyer picked: then every video / image of the source is moved there first
// (Graph: lib/clone-run migrateMediaToAccount; TOOL: registered from its public url) — BEFORE the campaign
// exists, so a failed move leaves nothing behind. The page is the source's or the picked one, the targeting
// the source's with the row's changes on top. The ad link is the source's as is (the DE Postback tracking
// link — Meta fills its macros with the clone's own ids). NDJSON per clone / per stage, the shared task rows
// under partner "vc", exactly the clone route's contract (source / media / campaign / adset / creative / ad;
// pending TOOL jobs keep the slot and name the job).

import { NextResponse } from "next/server";
import type { Session } from "./session";
import { bidTag } from "./types";
import { FbError, withFbBudget, withParentRetry } from "./fb-graph";
import { type LaunchBinds, adPayload, adsetPayload, campaignPayload } from "./fb-launch";
import {
  type SourceMedia,
  cloneCreativePayload,
  extractAdMedia,
  migrateMediaToAccount,
  toolCreativeFromSource,
  toolMediaRefFromSource,
  toolSourceMediaItem,
} from "./clone-run";
import { vcCloneRail, vcRailEnabled } from "./vc-launch";
import {
  VC_SOURCE_FIELDS,
  type VcCloneAd,
  type VcCloneEdit,
  isVcCloneEdit,
  vcCloneBinds,
  vcCloneCampaign,
  vcCloneLocaleIds,
  vcCloneRefusal,
  vcCloneSourceOf,
  vcPixelName,
} from "./vc-clone";
import { VC_TOOL_NO_SESSION, vcToolCatalog } from "./vc-tool";
import { claimAcctSlot, releaseAcctSlot } from "./acct-limit";
import { ACCOUNT_NOT_ASSIGNED_MSG, accountAllowedFor } from "./acct-assignments";
import { taskWriter } from "./task-store";
import { type ToolCreativeInput, type ToolMediaRefOut, buildToolCampaign, runToolMedia, runToolPublish, toolEnsureMark } from "./tool-launch";
import { toolDeps, toolInputFromCampaign } from "./tool-run";

type Json = Record<string, unknown>;
const rec = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const edge = (v: unknown): Json[] => (Array.isArray(rec(v).data) ? (rec(v).data as unknown[]).map(rec) : []);

// Same per-invocation FB retry budget as the clone route; the TOOL job shares the wall clock from request start.
const FB_BUDGET_MS = 240_000;
const FB_BUDGET_RETRIES = 8;
const TOOL_DEADLINE_MS = 265_000;

/** One account-local asset of the source — the key two ads that show the same video / image share, so a
 *  cross-account clone moves it once. "" = nothing account-local (a picture-url image travels as it is). */
function mediaKey(m: SourceMedia): string {
  if (m.kind === "video") return typeof m.data.video_id === "string" && m.data.video_id ? `v:${m.data.video_id}` : "";
  return typeof m.data.image_hash === "string" && m.data.image_hash ? `i:${m.data.image_hash}` : "";
}

export type VcCloneRunInput = {
  /** The board's edits (lib/vc-clone VcCloneEdit) — one per clone, validated here. */
  edits: unknown[];
  /** Task Manager rows aligned with `edits` by index (null = no row). */
  taskIds: (string | null)[];
  /** "tool" builds through TOOL; anything else = the VC token (direct Graph). */
  via: "graph" | "tool";
};

/** The clone run for POST /api/clone/run { partnerId: "vc", edits, taskIds, via }. */
export async function runVcClone(session: Session, input: VcCloneRunInput): Promise<Response> {
  const startedAt = Date.now();
  if (!vcRailEnabled()) return NextResponse.json({ ok: false, error: "vc_rail_disabled" }, { status: 404 });
  if (input.edits.length === 0) return NextResponse.json({ ok: false, error: "no_clones" }, { status: 400 });
  if (input.edits.length > 200) return NextResponse.json({ ok: false, error: "too_many", max: 200 }, { status: 400 });
  for (const e of input.edits) {
    if (!isVcCloneEdit(e)) return NextResponse.json({ ok: false, error: "bad_edit — not a VC clone edit (campaignId, name, event)" }, { status: 400 });
  }
  const edits = input.edits as VcCloneEdit[];
  const viaTool = input.via === "tool";
  // Both channels READ the source with the VC token (TOOL cannot read a campaign tree) — a missing token is a
  // clean config verdict, never another partner's bearer.
  const railRes = await vcCloneRail();
  if (!railRes.ok) return NextResponse.json({ ok: false, error: railRes.error }, { status: 400 });
  const rail = railRes.rail;
  const taskIds = input.taskIds;

  const encoder = new TextEncoder();
  const treeCache = new Map<string, Json>();
  const streamDeadlineAt = Date.now() + FB_BUDGET_MS;
  const stream = withFbBudget({ deadlineAt: streamDeadlineAt, retries: FB_BUDGET_RETRIES }, () =>
    new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (o: Json) => {
          try {
            controller.enqueue(encoder.encode(JSON.stringify(o) + "\n"));
          } catch {
            /* stream gone — the task rows keep the team informed */
          }
        };
        let ok = 0;
        let failed = 0;

        for (let idx = 0; idx < edits.length; idx++) {
          const edit = edits[idx];
          const bidLabel = bidTag(edit.bidStrategy, edit.bidCap);
          const tw = taskWriter(session.username, taskIds[idx] ?? null, { partner: "vc", ...(bidLabel ? { bid: bidLabel } : {}) });
          let lastStage = "source";
          let settled = false;
          const progress = (stage: string) => {
            lastStage = stage;
            send({ idx, stage });
            tw.write({ status: "running", stage });
          };
          const beat = setInterval(() => {
            if (!settled) tw.write({ status: "running", stage: lastStage });
          }, 30_000);
          let acctSlot: { documentId: string } | null = null;
          const created: Json = {};
          let toolSubmittedJob: number | null = null;
          let toolDefiniteFail = false;
          // The cabinet the clone is built in — known once the source is read; until then the edit's own.
          let buildAccount = String(edit.accountId ?? "").replace(/^act_/, "");
          try {
            send({ idx, stage: "start", name: edit.name });

            // ---- the source: one tree read per source campaign, reused across its copies ----
            progress("source");
            let tree = treeCache.get(edit.campaignId);
            if (!tree) {
              tree = await rail.fbGet(`${edit.campaignId}?fields=${encodeURIComponent(VC_SOURCE_FIELDS)}`);
              treeCache.set(edit.campaignId, tree);
            }
            const src = vcCloneSourceOf(tree);
            if (!/^\d{5,}$/.test(src.accountId)) throw new FbError("source account unknown — cannot clone", { campaignId: edit.campaignId });
            if (!(await rail.isTokenAccount(src.accountId))) {
              throw new FbError(`source account act_${src.accountId} is not a VC cabinet of the VC token`, { campaignId: edit.campaignId });
            }
            // Fire-time belt over the picker filter: /accounts assignments hold even for a crafted POST —
            // for the cabinet the source is read from, and (below) for the one the clone is built in.
            if (!(await accountAllowedFor(session, src.accountId))) throw new FbError(ACCOUNT_NOT_ASSIGNED_MSG, { campaignId: edit.campaignId }, 403);
            const refusal = vcCloneRefusal(edit, src);
            if (refusal) throw new FbError(refusal, { campaignId: edit.campaignId });

            // ---- where it lands: the edit's cabinet / page / pixel, the source's own for what it leaves empty ----
            const dest = vcCloneBinds(edit, src);
            buildAccount = dest.accountId;
            if (dest.cross && !(await accountAllowedFor(session, dest.accountId))) throw new FbError(ACCOUNT_NOT_ASSIGNED_MSG, { campaignId: edit.campaignId }, 403);
            // The token holds every VC cabinet today; through TOOL a cabinet only TOOL sees is fine too (below).
            const tokenHoldsDest = dest.cross ? await rail.isTokenAccount(dest.accountId) : true;
            if (!tokenHoldsDest && !viaTool) {
              throw new FbError(`account_not_allowed — act_${dest.accountId} is not a VC cabinet of the VC token`, { campaignId: edit.campaignId });
            }

            // Every reusable ad of the source (video or static image), aligned with the facts by index.
            const rawAds = edge(tree.ads);
            const ads: { ad: VcCloneAd; media: SourceMedia }[] = [];
            for (let i = 0; i < src.ads.length; i++) {
              const media = extractAdMedia(rawAds[i] ?? {});
              if (media) ads.push({ ad: src.ads[i], media });
            }
            if (ads.length === 0) throw new FbError("source has no reusable video or image ad", { campaignId: edit.campaignId });

            // The pixel the clone optimizes on must be shared to the cabinet it is built in, or Meta refuses the
            // ad set only after the campaign exists (an orphan). Checked here, before any claim. (A cabinet only
            // TOOL sees has no pixel list on the token — TOOL checks it at publish.)
            if (dest.pixelId && tokenHoldsDest) {
              const pixels = await rail.accountPixels(dest.accountId);
              if (!pixels.some((p) => p.id === dest.pixelId)) {
                const where = (dest.cross ? await rail.accountName(dest.accountId).catch(() => "") : src.accountName) || "VC cabinet";
                throw new FbError(
                  `pixel_not_on_account — ${vcPixelName(dest.pixelId)} (${dest.pixelId}) is not shared to act_${dest.accountId} (${where}); share it in Business Manager first`,
                  { campaignId: edit.campaignId },
                );
              }
            }
            // The page the clone advertises with (the source's own, or the picked one): the token must hold it —
            // the creative names it. Through TOOL the session's profile is what holds the page, so a page the
            // token lacks is left to TOOL's own check at publish (same rule as a VC launch through TOOL).
            const tokenHoldsPage = await rail.isAdvertisablePage(dest.pageId);
            if (!tokenHoldsPage && !viaTool) {
              throw new FbError(
                `fanpage_not_allowed — the VC token cannot advertise with ${dest.pageId === src.pageId ? "the source's page" : "page"} ${dest.pageId}; pick another fanpage`,
                { campaignId: edit.campaignId },
              );
            }
            const pageName = tokenHoldsPage ? await rail.advertisablePageName(dest.pageId) : "";
            const campaign = vcCloneCampaign(edit, src);
            const localeIds = vcCloneLocaleIds(edit, src).ids;
            const binds: LaunchBinds = {
              accountId: dest.accountId,
              pageId: dest.pageId,
              // DSA beneficiary/payor (fb-launch adsetPayload): on the source's own page its own declaration,
              // else the page's name; on a picked page that page's name (the source's only when it is unknown).
              pageName: dest.pageId === src.pageId ? src.dsaBeneficiary || pageName : pageName || src.dsaBeneficiary,
              pixelId: dest.pixelId,
            };
            let toolAcctCurrency = "USD";
            let toolAcctName = "";
            if (viaTool) {
              // TOOL must see the cabinet the clone is built in (one forced re-read on a miss — the 60 s cache may
              // predate a session an owner just added), and the cabinet must be VC's in TOOL or the token's.
              let cat = await vcToolCatalog();
              if (cat.ok && !cat.live.some((a) => a.account_id === dest.accountId)) cat = await vcToolCatalog(true);
              if (!cat.ok) throw new FbError(cat.message, { campaignId: edit.campaignId });
              const live = cat.live.find((a) => a.account_id === dest.accountId);
              if (!live) {
                throw new FbError(`tool_account_unavailable — no live TOOL session sees ad account ${dest.accountId}; ${VC_TOOL_NO_SESSION}`, { campaignId: edit.campaignId });
              }
              if (!tokenHoldsDest && !cat.vc.some((a) => a.account_id === dest.accountId)) {
                throw new FbError(`account_not_vc — ad account ${dest.accountId} is not one of VC's cabinets`, { campaignId: edit.campaignId });
              }
              toolAcctCurrency = live.currency || "USD";
              toolAcctName = live.name;
            }
            // The name is the server's: a TOOL-born clone carries `GCL TOOL - ` after the clone prefix.
            const name = viaTool ? toolEnsureMark(edit.name.trim()) : edit.name.trim();
            const adName = (i: number): string => (ads.length > 1 ? `${name} · ${i + 1}` : name);
            /** The ad link stays the source's — the tracking link's macros are filled by Meta per clone. */
            const keep = (l: string): string => l;

            // Launch slot of the cabinet the clone is built in (5 campaigns / 15 min per cabinet, every channel)
            // — released in the catch on any pre-campaign failure.
            acctSlot = await claimAcctSlot(dest.accountId, {
              user: session.username,
              partner: "vc",
              channel: viaTool ? "vc-tool-clone" : "vc-clone",
              name,
              accountName: toolAcctName || (dest.cross ? "" : src.accountName) || (await rail.accountName(dest.accountId).catch(() => "")),
            });

            if (viaTool) {
              // ---- TOOL recreate: one CampaignRequest. Same cabinet = the source's own account-local media by
              //      id; another cabinet (or a picture-url image) = registered there from its public url, each
              //      distinct asset once.
              const deadlineAt = startedAt + TOOL_DEADLINE_MS;
              const idemKey = taskIds[idx] ?? `vc-clone-${edit.campaignId}-${startedAt.toString(36)}`;
              const registered = new Map<string, ToolMediaRefOut>();
              const creatives: ToolCreativeInput[] = [];
              for (let i = 0; i < ads.length; i++) {
                const { media } = ads[i];
                const key = mediaKey(media);
                let ref: ToolMediaRefOut | null = dest.cross ? null : toolMediaRefFromSource(media);
                if (!ref && key) ref = registered.get(key) ?? null;
                if (!ref) {
                  progress("media");
                  const item = await toolSourceMediaItem(media, src.accountId, adName(i), rail.cat.token);
                  const reg = await runToolMedia(toolDeps, dest.accountId, [item], { deadlineAt, idempotencyKey: `${idemKey}:media:${i}`, onStage: () => progress("media") });
                  if (!reg.ok) throw new FbError(reg.error, { campaignId: edit.campaignId });
                  ref = reg.refs[0];
                  if (key) registered.set(key, ref);
                }
                const text = toolCreativeFromSource(media, keep);
                creatives.push({
                  name: adName(i),
                  media: ref.media,
                  ...(ref.thumbnail ? { thumbnail: ref.thumbnail } : {}),
                  primaryText: text.primaryText,
                  headline: text.headline,
                  ...(text.description ? { description: text.description } : {}),
                  url: text.url,
                  cta: text.cta,
                });
              }
              const built = buildToolCampaign(
                toolInputFromCampaign(campaign, {
                  name,
                  pageId: binds.pageId,
                  pixelId: binds.pixelId,
                  localeIds,
                  creatives,
                  status: "ACTIVE",
                  accountCurrency: toolAcctCurrency,
                }),
              );
              if (!built.ok) throw new FbError(built.error, { campaignId: edit.campaignId });

              progress("campaign");
              const run = await runToolPublish(toolDeps, dest.accountId, built.body, {
                idempotencyKey: idemKey,
                deadlineAt,
                onSubmitted: (jobId) => {
                  toolSubmittedJob = jobId;
                },
                onStage: (stage) => {
                  if (stage === "done" || stage === "error") return;
                  progress(stage === "video" || stage === "processing" ? "media" : stage);
                },
              });
              if (!run.ok) {
                if (run.pending) {
                  // Deadline hit while TOOL still works: KEEP the slot, name the job — the queue's tool.follow
                  // finishes the row from TOOL's own verdict.
                  if (run.jobId) created.tool_job_id = run.jobId;
                  if (run.created?.campaignId) created.campaign_id = run.created.campaignId;
                  const note = `pending tool job #${run.jobId ?? "?"} — check Ads Manager sessions → Jobs`;
                  settled = true;
                  tw.write({
                    status: "error",
                    stage: "ad",
                    finished_at: Date.now(),
                    error: note,
                    ...(created.campaign_id ? { campaign_id: created.campaign_id } : {}),
                    ...(run.jobId ? { link: String(run.jobId) } : {}),
                  });
                  send({ idx, ok: false, stage: "ad", pending: true, via: "tool", tool_job_id: run.jobId ?? null, account: dest.accountId, error: run.error, ...created });
                  continue;
                }
                if (run.created?.campaignId) created.campaign_id = run.created.campaignId;
                if (run.created?.adsetIds[0]) created.adset_id = run.created.adsetIds[0];
                if (run.jobId) created.tool_job_id = run.jobId;
                toolDefiniteFail = true;
                throw new FbError(run.jobId ? `${run.error} (tool job #${run.jobId})` : run.error, { campaignId: edit.campaignId });
              }
              created.campaign_id = run.campaignId;
              if (run.adsetId) created.adset_id = run.adsetId;
              if (run.adIds[0]) created.ad_id = run.adIds[0];
              if (run.adIds.length > 1) created.ad_ids = [...run.adIds];
              created.tool_job_id = run.jobId;
            } else {
              // ---- Graph recreate on the VC token ----
              // Another cabinet: the source's videos / images are account-local, so each distinct one is moved
              // into the build cabinet first (video: its CDN source url → advideos file_url → its own thumbnail;
              // image: adimages copy_from) — all at once (a video takes minutes to process), and BEFORE the
              // campaign exists, so a failed move leaves no orphan and the row can simply be retried.
              if (dest.cross) {
                progress("media");
                const moved = new Map<string, Promise<SourceMedia>>();
                await Promise.all(
                  ads.map(async (a, i) => {
                    const key = mediaKey(a.media);
                    if (!key) return; // a picture-url image is account-agnostic
                    let job = moved.get(key);
                    if (!job) {
                      job = migrateMediaToAccount(a.media, src.accountId, dest.accountId, adName(i), rail.cat.token);
                      moved.set(key, job);
                    }
                    const next = await job;
                    // Two ads may share one asset but carry their own copy / link — only the asset ids move.
                    const data: Json = { ...a.media.data };
                    if (next.kind === "video") {
                      data.video_id = next.data.video_id;
                      data.image_url = next.data.image_url;
                      delete data.image_hash;
                    } else {
                      data.image_hash = next.data.image_hash;
                    }
                    a.media = { kind: a.media.kind, data } as SourceMedia;
                  }),
                );
              }

              progress("campaign");
              const camp = await rail.fbPost(`act_${dest.accountId}/campaigns`, campaignPayload(campaign, name));
              created.campaign_id = String(camp.id);

              progress("adset");
              const adset = await withParentRetry(String(camp.id), () =>
                rail.createAdset(`act_${dest.accountId}/adsets`, adsetPayload(campaign, name, String(camp.id), binds, localeIds)),
              );
              created.adset_id = String(adset.id);

              progress("creative");
              const creativeIds: string[] = [];
              for (let i = 0; i < ads.length; i++) {
                const cr = await rail.fbPost(`act_${dest.accountId}/adcreatives`, cloneCreativePayload(adName(i), binds.pageId, ads[i].media, "", "", keep));
                creativeIds.push(String(cr.id));
              }
              created.creative_id = creativeIds[0];

              progress("ad");
              const adIds: string[] = [];
              for (let i = 0; i < creativeIds.length; i++) {
                const ad = await withParentRetry(String(adset.id), () => rail.fbPost(`act_${dest.accountId}/ads`, adPayload(adName(i), String(adset.id), creativeIds[i])));
                // Belt over the fbPost error-body guard: never record a phantom "undefined" ad id.
                if (!ad.id) throw new FbError("ad create returned no id", ad);
                adIds.push(String(ad.id));
                created.ad_id = adIds[0];
                if (adIds.length > 1) created.ad_ids = [...adIds];
                send({ idx, stage: "ad", done: adIds.length, total: creativeIds.length });
              }
            }

            ok++;
            settled = true;
            const link = ads[0].ad.link;
            tw.write({
              status: "done",
              stage: "ad",
              finished_at: Date.now(),
              campaign_id: created.campaign_id,
              adset_id: created.adset_id,
              ad_id: created.ad_id,
              link,
              gcm: "",
              error: null,
            });
            send({
              idx,
              ok: true,
              stage: "done",
              gcm: "",
              link,
              source_campaign_id: edit.campaignId,
              page_id: binds.pageId,
              ...created,
              ...(viaTool ? { via: "tool" } : {}),
            });
          } catch (e) {
            const err = e as FbError;
            // TOOL belt: TOOL accepted the submit but no campaign id is known — the job may still be creating
            // the clone server-side. Settle as PENDING (slot kept, the job named); never counted as failed.
            if (viaTool && toolSubmittedJob != null && !created.campaign_id && !toolDefiniteFail) {
              if (created.tool_job_id == null) created.tool_job_id = toolSubmittedJob;
              const note = `pending tool job #${toolSubmittedJob} — check Ads Manager sessions → Jobs`;
              settled = true;
              tw.write({ status: "error", stage: "ad", finished_at: Date.now(), error: note, link: String(toolSubmittedJob) });
              send({ idx, ok: false, stage: "ad", pending: true, via: "tool", tool_job_id: toolSubmittedJob, account: buildAccount, error: err.message ?? String(e), ...created });
              continue;
            }
            failed++;
            // Free the cabinet's launch slot when NO campaign was created (the limit meters campaigns that
            // exist); once one exists the slot stays consumed.
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
            send({
              idx,
              ok: false,
              stage: "error",
              error: err.message ?? String(e),
              detail: err.detail ?? null,
              created,
              ...(viaTool ? { via: "tool" } : {}),
              ...(viaTool && created.tool_job_id != null ? { tool_job_id: created.tool_job_id } : {}),
            });
          } finally {
            clearInterval(beat);
            await tw.flush();
          }
        }

        send({ stage: "batch-done", ok, failed, total: edits.length });
        try {
          controller.close();
        } catch {
          /* already closed by a disconnect */
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
