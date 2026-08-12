import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { ROAS_PIXEL, partnerConfig, type PartnerId } from "@/lib/partners";
import { bidAmountMissing, bidKind, parseMoney } from "@/lib/types";
import { SUPPORTED_BID_STRATEGIES, money } from "@/lib/fb-launch";
import {
  FbError,
  accountPixels,
  advertisablePageName,
  fbPost,
  isAdvertisablePage,
  isTokenAccount,
  withFbBudget,
  withParentRetry,
} from "@/lib/fb-graph";
import { backfillGcm, claimGcm, deleteGcm } from "@/lib/gcm-claim";
import { taskWriter } from "@/lib/task-store";
import type { CloneEdit } from "@/lib/clone";
import {
  type LaunchBinds,
  type SourceDetail,
  type SourceMedia,
  adPayload,
  adsetPayload,
  campaignPayload,
  cloneCreativePayload,
  cloneToCampaign,
  fetchSourceDetail,
  migrateMediaToAccount,
  resolveCloneBinds,
  resolveLocales,
} from "@/lib/clone-run";

export const runtime = "nodejs";
export const maxDuration = 300;

type Json = Record<string, unknown>;

// Same per-invocation FB retry budget as /api/launch: rate-limited calls wait out Meta's regain
// estimate (up to 8 attempts) but never sleep past the deadline — the batch must settle every
// task row and stream a terminal event BEFORE Vercel can kill the function.
const FB_BUDGET_MS = 240_000;
const FB_BUDGET_RETRIES = 8;

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
 * media — video or static image — plus copy/title/CTA (only the gcm in the tracking link is swapped
 * for a freshly-claimed code), rebuilds targeting/bid/budget from the buyer's edits, all through the
 * launch payload builders. An optional per-edit TARGET account (accountId+pixelId) makes the clone
 * cross-account: the media is migrated into the target first (video via its CDN source URL →
 * advideos file_url; image via adimages copy_from) and the clone optimizes for the picked pixel.
 * Streams NDJSON per-clone/per-stage progress. Gated by the proxy (session required).
 */
export async function POST(req: Request) {
  // Defense in depth: this high-impact write route also self-checks the session (like /api/launch),
  // not only the proxy gate — so a matcher edit or future middleware-bypass can't open it up.
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  let partnerId: PartnerId;
  let edits: CloneEdit[];
  let taskIds: (string | null)[] = [];
  try {
    const j = (await req.json()) as { partnerId?: string; edits?: CloneEdit[]; taskIds?: unknown[] };
    partnerId = String(j.partnerId ?? "in") as PartnerId;
    edits = Array.isArray(j.edits) ? j.edits : [];
    // Task Manager rows aligned with `edits` by index. When present, per-clone progress + the
    // terminal state are ALSO written to Strapi server-side (see /api/launch) so every account's
    // drawer tracks the run live, surviving the launching browser.
    taskIds = (Array.isArray(j.taskIds) ? j.taskIds : []).map((x) =>
      typeof x === "string" && /^[\w-]{6,64}$/.test(x) ? x : null,
    );
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  if (edits.length === 0) return NextResponse.json({ ok: false, error: "no_clones" }, { status: 400 });
  if (edits.length > 200) return NextResponse.json({ ok: false, error: "too_many", max: 200 }, { status: 400 });

  const partner = partnerConfig(partnerId);
  if (!partner.fanpagesFromToken) {
    return NextResponse.json({ ok: false, error: "partner_not_launchable" }, { status: 400 });
  }
  // Default: a clone is built in its SOURCE's own account (media is account-local) with the
  // source's pixel. The buyer MAY pick a target account+pixel instead (cross-account, media
  // migrated). The fanka is always the buyer's pick. Every picked id is validated here against
  // the launch token's own data before any FB work starts.
  const pageIds = [...new Set(edits.map((e) => String(e.pageId ?? "").trim()))];
  if (pageIds.some((p) => !/^\d{5,}$/.test(p))) {
    return NextResponse.json(
      { ok: false, error: "fanpage_required — pick a fanpage in the board settings" },
      { status: 400 },
    );
  }
  // Page display names, for the ad set's DSA beneficiary/payor declaration (see adsetPayload) —
  // resolved once per unique page from the same cached list that validates the ids below.
  const pageNames = new Map<string, string>();
  try {
    for (const p of pageIds) {
      if (!(await isAdvertisablePage(p))) {
        return NextResponse.json(
          { ok: false, error: "fanpage_not_allowed — the launch token cannot advertise with this page" },
          { status: 400 },
        );
      }
      pageNames.set(p, await advertisablePageName(p));
    }
    // Optional TARGET account+pixel (cross-account clones): validated up front against the token's
    // own data — a bad pick fails the whole batch here, before any media migration or FB write.
    // Same-account behaviour (no accountId) needs nothing: source accounts are re-checked per clone.
    const targets = new Map<string, Set<string>>(); // accountId → picked pixel ids
    for (const e of edits) {
      const acct = String(e.accountId ?? "").trim().replace(/^act_/, "");
      if (!acct) continue;
      if (!/^\d{5,}$/.test(acct)) {
        return NextResponse.json({ ok: false, error: "account_invalid — bad target ad account id" }, { status: 400 });
      }
      const px = String(e.pixelId ?? "").trim();
      if (px && !/^\d{10,20}$/.test(px)) {
        return NextResponse.json({ ok: false, error: "pixel_invalid — bad pixel id" }, { status: 400 });
      }
      if (!targets.has(acct)) targets.set(acct, new Set());
      if (px) targets.get(acct)!.add(px);
    }
    for (const [acct, pixelIds] of targets) {
      if (!(await isTokenAccount(acct))) {
        return NextResponse.json(
          { ok: false, error: "account_not_allowed — the launch token cannot use this ad account" },
          { status: 400 },
        );
      }
      if (pixelIds.size > 0) {
        const pixels = await accountPixels(acct);
        for (const px of pixelIds) {
          if (!pixels.some((p) => p.id === px)) {
            return NextResponse.json(
              {
                ok: false,
                error: "pixel_not_on_account — this ad account does not carry the picked pixel (share it in BM first)",
              },
              { status: 400 },
            );
          }
        }
      }
    }
  } catch (e) {
    const err = e as { message?: string };
    return NextResponse.json(
      { ok: false, error: `destination check failed: ${err.message ?? String(e)}` },
      { status: 502 },
    );
  }

  const encoder = new TextEncoder();
  const detailCache = new Map<string, SourceDetail>();
  // Media already migrated into a target account this batch, keyed "<sourceCampaignId>→<accountId>".
  const migratedCache = new Map<string, SourceMedia>();

  // withFbBudget wraps the CONSTRUCTION: start() begins inside it, so the whole batch inherits it.
  const stream = withFbBudget({ deadlineAt: Date.now() + FB_BUDGET_MS, retries: FB_BUDGET_RETRIES }, () =>
    new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (o: Json) => controller.enqueue(encoder.encode(JSON.stringify(o) + "\n"));
      let ok = 0;
      let failed = 0;

      for (let idx = 0; idx < edits.length; idx++) {
        const edit = edits[idx];
        // Server-side mirror of this clone's Task Manager row (no-op when no task id was sent).
        const tw = taskWriter(session.username, taskIds[idx] ?? null);
        let lastStage = "source";
        let settled = false; // set before the terminal write — the beat must never chain after it
        const progress = (stage: string) => {
          lastStage = stage;
          send({ idx, stage });
          tw.write({ status: "running", stage });
        };
        // Liveness beat across slow FB calls / rate-limit backoffs (same rationale as /api/launch):
        // keeps the row fresh for the team even if the launching browser died mid-run.
        const beat = setInterval(() => {
          if (!settled) tw.write({ status: "running", stage: lastStage });
        }, 30_000);
        let claim: { gcm: string; documentId: string | null } | null = null;
        const created: Json = {};
        try {
          send({ idx, stage: "start", name: edit.name });

          // Source detail — fetched once per source campaign, reused across its copies.
          let src = detailCache.get(edit.campaignId);
          if (!src) {
            progress("source");
            src = await fetchSourceDetail(edit.campaignId);
            detailCache.set(edit.campaignId, src);
          }
          const media = src.media;
          if (!media) throw new FbError("source ad has no reusable video or image", { campaignId: edit.campaignId });
          // The clone's build location: the source's own account by default, or the buyer's picked
          // TARGET account (cross-account — media gets migrated there below). The source account is
          // re-checked even for cross-account clones: its media is about to be read.
          if (!/^\d{5,}$/.test(src.accountId)) throw new FbError("source account unknown — cannot clone", { campaignId: edit.campaignId });
          if (!(await isTokenAccount(src.accountId))) {
            throw new FbError(`source account act_${src.accountId} is not available to the launch token`, { campaignId: edit.campaignId });
          }
          const binds = resolveCloneBinds(edit, src);
          // A conversion-optimized source cloned into ANOTHER account must carry a pixel of that
          // account (the source's pixel isn't valid there) — the adset's promoted_object and the
          // funnel's &pixel= both need it. Click sources (no source pixel) pass pixel-less.
          if (binds.cross && /^\d{10,20}$/.test(src.pixelId) && !binds.pixelId) {
            throw new FbError(
              "pixel_required — the source optimizes for a pixel; pick a pixel of the target account",
              { campaignId: edit.campaignId },
            );
          }
          const editBinds: LaunchBinds = {
            accountId: binds.accountId,
            // Same-account: the source's own promoted pixel (or the buyer's explicit same-account
            // pick); cross-account: the picked target-account pixel. Empty for click sources. The
            // resolver format-guards ids so a malformed pixel can't reach the adset or the link.
            pixelId: binds.pixelId,
            pageId: String(edit.pageId).trim(),
            pageName: pageNames.get(String(edit.pageId).trim()) ?? "",
          };

          // Build + validate the clone campaign BEFORE claiming a gcm, so an un-clonable source
          // (a bid strategy the builder can't rebuild, or no country targeting) fails here without
          // burning a code or leaving an orphaned PAUSED campaign.
          const campaign = cloneToCampaign(edit, src);
          if (!SUPPORTED_BID_STRATEGIES.has(campaign.bidStrategy)) {
            throw new FbError(`source bid strategy ${campaign.bidStrategy} can't be cloned — recreate it manually`, { campaignId: edit.campaignId });
          }
          if (bidAmountMissing(campaign)) {
            throw new FbError("source uses a bid cap but no ROAS goal was set on the clone row", { campaignId: edit.campaignId });
          }
          // Mirror the HS/launch guard: a min-ROAS goal above 100 (10 000%) is a typo, not a bid.
          if (bidKind(campaign.bidStrategy) === "roas" && parseMoney(campaign.bidCap) > 100) {
            throw new FbError("ROAS goal must be 0–100 on the clone row", { campaignId: edit.campaignId });
          }
          // Owner rule (2026-08-11): min-ROAS clones may only optimize on the partner's value
          // pixel — same gate as /api/launch, before any claim/write.
          if (bidKind(campaign.bidStrategy) === "roas" && editBinds.pixelId !== ROAS_PIXEL.id) {
            throw new FbError(
              `min-ROAS clones run only on ${ROAS_PIXEL.name} (${ROAS_PIXEL.id}) — pick it as the pixel`,
              { campaignId: edit.campaignId },
            );
          }
          if (campaign.countries.length === 0) {
            throw new FbError("source has no country targeting to clone — set a geo on the clone row", { campaignId: edit.campaignId });
          }
          // Budget floor, mirroring the launch route: a cleared/garbage budget → money()=0 →
          // daily_budget below Meta's $1 floor → the ad set is rejected AFTER the campaign exists,
          // orphaning it and burning a gcm. Reject here, before any claim/FB write.
          if (money(campaign.budget) < 100) {
            throw new FbError("clone daily budget must be at least $1", { campaignId: edit.campaignId });
          }

          // Cross-account: re-home the media in the target account BEFORE claiming a gcm — a failed
          // migration (video unfetchable, processing error) must not burn a code or orphan anything.
          // Cached per (source campaign → target account): N copies of one source migrate ONCE.
          let cloneMedia = media;
          if (binds.cross) {
            progress("media");
            const mKey = `${edit.campaignId}→${binds.accountId}`;
            let migrated = migratedCache.get(mKey);
            if (!migrated) {
              migrated = await migrateMediaToAccount(media, src.accountId, binds.accountId, edit.name);
              migratedCache.set(mKey, migrated);
            }
            cloneMedia = migrated;
          }

          progress("gcm");
          claim = await claimGcm("", { campaign_name: edit.name, notes: "claimed via adlauncher clone" });
          const gcm = claim.gcm;

          const localeIds = await resolveLocales(edit.locales);

          progress("campaign");
          const camp = await fbPost(`act_${editBinds.accountId}/campaigns`, campaignPayload(campaign, edit.name));
          created.campaign_id = String(camp.id);

          progress("adset");
          const adset = await withParentRetry(String(camp.id), () =>
            createAdset(
              `act_${editBinds.accountId}/adsets`,
              adsetPayload(campaign, edit.name, String(camp.id), editBinds, localeIds),
            ),
          );
          created.adset_id = String(adset.id);

          progress("creative");
          const creative = await fbPost(
            `act_${editBinds.accountId}/adcreatives`,
            cloneCreativePayload(edit.name, editBinds.pageId, cloneMedia, gcm, editBinds.pixelId),
          );
          created.creative_id = String(creative.id);

          progress("ad");
          const ad = await withParentRetry(String(adset.id), () =>
            fbPost(`act_${editBinds.accountId}/ads`, adPayload(edit.name, String(adset.id), String(creative.id))),
          );
          // Belt over the fbPost error-body guard: never record a phantom "undefined" ad id.
          if (!ad.id) throw new FbError("ad create returned no id", ad);
          created.ad_id = String(ad.id);

          await backfillGcm(
            claim.documentId,
            {
              campaign_id: created.campaign_id,
              adset_id: created.adset_id,
              ad_id: created.ad_id,
            },
            claim.gcm,
          );

          ok++;
          settled = true;
          tw.write({
            status: "done",
            stage: "ad",
            finished_at: Date.now(),
            campaign_id: created.campaign_id,
            adset_id: created.adset_id,
            ad_id: created.ad_id,
            gcm,
            error: null,
          });
          send({ idx, ok: true, stage: "done", gcm, ...created });
        } catch (e) {
          failed++;
          const err = e as FbError;
          // Free the gcm code when nothing was created; keep the row (marked failed) once a campaign
          // exists so the orphaned PAUSED campaign stays traceable — same policy as the launch route.
          if (claim?.documentId) {
            if (created.campaign_id)
              // "retired" — the registry's status enum is active|retired; "failed" is rejected by
              // Strapi (the whole PUT 400s and backfillGcm swallows it, losing the note AND the ids).
              await backfillGcm(
                claim.documentId,
                {
                  status: "retired",
                  notes: `clone failed: ${err.message}`,
                  // Record what DID get created so the orphaned PAUSED campaign is traceable by code.
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
            error: err.message ?? String(e),
            ...(created.campaign_id ? { campaign_id: created.campaign_id } : {}),
            ...(created.adset_id ? { adset_id: created.adset_id } : {}),
          });
          send({ idx, ok: false, stage: "error", error: err.message ?? String(e), detail: err.detail ?? null, created });
        }
        // The clone's last transition must land before the loop moves on / the function freezes.
        clearInterval(beat);
        await tw.flush();
      }

      send({ stage: "batch-done", ok, failed, total: edits.length });
      controller.close();
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
