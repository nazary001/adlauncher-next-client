import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { AIF_PIXEL, ROAS_PIXEL, partnerConfig, type PartnerId } from "@/lib/partners";
import { resolveMoChannel } from "@/lib/mo-soc";
import { bidAmountMissing, bidKind, moEnsureSocMark, normalizeRoasGoal, parseMoney } from "@/lib/types";
import { SUPPORTED_BID_STRATEGIES, money } from "@/lib/fb-launch";
import {
  FbError,
  accountPixels,
  advertisablePageName,
  fbPost,
  isAdvertisablePage,
  isTokenAccount,
  tokenAccountName,
  withFbBudget,
  withParentRetry,
} from "@/lib/fb-graph";
import {
  aifAccountName,
  aifAccountPixels,
  aifAdvertisablePageName,
  aifFbPost,
  aifIsAdvertisablePage,
  aifIsTokenAccount,
  aifRawToken,
  aifTokenConfigured,
} from "@/lib/aif-launch";
import { backfillGcm, claimGcm, deleteGcm } from "@/lib/gcm-claim";
import { backfillBrand, claimBrand, deleteBrand } from "@/lib/aif-claim";
import { claimAcctSlot, releaseAcctSlot } from "@/lib/acct-limit";
import { reportPagesUsed } from "@/lib/hs-pages";
import { ACCOUNT_NOT_ASSIGNED_MSG, accountAllowedFor } from "@/lib/acct-assignments";
import { taskWriter } from "@/lib/task-store";
import type { CloneEdit } from "@/lib/clone";
import {
  type LaunchBinds,
  type SourceDetail,
  type SourceMedia,
  adPayload,
  adsetPayload,
  campaignPayload,
  cloneBidStrategy,
  cloneCreativePayload,
  cloneToCampaign,
  fetchSourceDetail,
  migrateMediaToAccount,
  resolveCloneBinds,
  resolveLocales,
  swapBrand,
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
async function createAdset(path: string, payload: Json, post: typeof fbPost = fbPost): Promise<Json> {
  const seed = payload.regional_regulated_categories;
  const cats = new Set<string>(Array.isArray(seed) ? (seed as string[]) : []);
  for (let attempt = 0; attempt < 8; attempt++) {
    const body: Json = cats.size ? { ...payload, regional_regulated_categories: [...cats] } : payload;
    try {
      return await post(path, body);
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
  return post(path, { ...payload, regional_regulated_categories: [...cats] });
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
  let channelRaw: unknown;
  try {
    const j = (await req.json()) as { partnerId?: string; edits?: CloneEdit[]; taskIds?: unknown[]; channel?: string };
    partnerId = String(j.partnerId ?? "in") as PartnerId;
    edits = Array.isArray(j.edits) ? j.edits : [];
    channelRaw = j.channel;
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
  // Target bid strategies (per-row ROAS ↔ cap ↔ lowest switch, owner ask 09-01): only the
  // supported set may reach the payload builders — garbage 400s the batch up front, not mid-run.
  for (const e of edits) {
    const bs = String(e.bidStrategy ?? "").trim();
    if (bs && !SUPPORTED_BID_STRATEGIES.has(bs)) {
      return NextResponse.json({ ok: false, error: `bid_strategy_invalid — ${bs}` }, { status: 400 });
    }
  }

  const partner = partnerConfig(partnerId);
  if (!partner.fanpagesFromToken) {
    return NextResponse.json({ ok: false, error: "partner_not_launchable" }, { status: 400 });
  }
  // The partner picks the RAIL: AIF clones ride the AIF token, the aif-maps brand registry and a
  // brand-only link rewrite; everything else stays byte-identical to the MO flow (token default,
  // gcm registry, gcm+pixel link rewrite). One route, two claim/backfill/release bundles.
  const aif = Boolean(partner.aifLaunch);
  if (aif && !aifTokenConfigured()) {
    return NextResponse.json({ ok: false, error: "no_aif_token" }, { status: 500 });
  }
  // MO clone signer: the system-user token is RETIRED (owner ask 09-01 — Meta's ward 2446325
  // kills its adset-creates; a system clone would burn a gcm on an orphan shell). Every MO batch
  // must name a provisioned soc; its bearer signs EVERY Graph call (source read, media
  // migration, tree build) and its catalogs validate the picked page/account/pixel. AIF keeps
  // its own token — channel is ignored there.
  const channel = aif ? null : resolveMoChannel(channelRaw);
  if (!aif) {
    if (!channel) {
      return NextResponse.json(
        { ok: false, error: "soc_channel_unknown — this soc is not provisioned on the server (FB_MO_SOC_TOKENS)" },
        { status: 400 },
      );
    }
    if (channel.kind === "system") {
      return NextResponse.json(
        {
          ok: false,
          error: "mo_system_channel_retired — the system token no longer signs MO clones; pick a soc signer on the board (reload the tab if you don't see the Signer menu)",
        },
        { status: 400 },
      );
    }
  }
  const soc = channel && channel.kind === "soc" ? channel : null;
  /** Catalog identity of the signer (undefined = AIF's own catalog helpers below). */
  const cat = soc?.cat;
  const railToken = aif ? aifRawToken() : soc?.token;
  const pageOk = (p: string) => (aif ? aifIsAdvertisablePage(p) : isAdvertisablePage(p, cat));
  const pageNameOf = (p: string) => (aif ? aifAdvertisablePageName(p) : advertisablePageName(p, cat));
  const acctOk = (a: string) => (aif ? aifIsTokenAccount(a) : isTokenAccount(a, cat));
  const pixelsOf = (a: string) => (aif ? aifAccountPixels(a) : accountPixels(a, cat));
  const acctNameOf = (a: string) => (aif ? aifAccountName(a) : tokenAccountName(a, cat));
  const post: typeof fbPost = (path, params) =>
    aif ? aifFbPost(path, params as Json) : fbPost(path, params, railToken);
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
      if (!(await pageOk(p))) {
        return NextResponse.json(
          { ok: false, error: "fanpage_not_allowed — the launch token cannot advertise with this page" },
          { status: 400 },
        );
      }
      pageNames.set(p, await pageNameOf(p));
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
      if (!(await acctOk(acct))) {
        return NextResponse.json(
          { ok: false, error: "account_not_allowed — the launch token cannot use this ad account" },
          { status: 400 },
        );
      }
      if (pixelIds.size > 0) {
        const pixels = await pixelsOf(acct);
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
      // No-throw: a client that closed the tab mid-batch makes enqueue throw — the batch must
      // keep building the REMAINING clones (the task rows carry the truth to the drawer), not
      // die between clones with beats leaked and rows stuck "running".
      const send = (o: Json) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(o) + "\n"));
        } catch {
          /* stream gone — rows keep the team informed */
        }
      };
      let ok = 0;
      let failed = 0;

      for (let idx = 0; idx < edits.length; idx++) {
        // Soc-class signers stamp the SOC marker into the clone's name (server-side truth, same
        // as /api/launch — an old/tampered client may send an unmarked name); system-class socs
        // (Spencermo) create unmarked.
        const edit = soc && !soc.sys ? { ...edits[idx], name: moEnsureSocMark(edits[idx].name) } : edits[idx];
        // Server-side mirror of this clone's Task Manager row (no-op when no task id was sent).
        // The partner rides on every write: a row this writer CREATES (client save lost) must
        // still land in the right drawer's scope — null matches no scope at all.
        const tw = taskWriter(session.username, taskIds[idx] ?? null, { partner: aif ? "us" : "in" });
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
        let acctSlot: { documentId: string } | null = null;
        const created: Json = {};
        try {
          send({ idx, stage: "start", name: edit.name });

          // Source detail — fetched once per source campaign, reused across its copies.
          let src = detailCache.get(edit.campaignId);
          if (!src) {
            progress("source");
            src = await fetchSourceDetail(edit.campaignId, railToken);
            detailCache.set(edit.campaignId, src);
          }
          const media = src.media;
          if (!media) throw new FbError("source ad has no reusable video or image", { campaignId: edit.campaignId });
          // The clone's build location: the source's own account by default, or the buyer's picked
          // TARGET account (cross-account — media gets migrated there below). The source account is
          // re-checked even for cross-account clones: its media is about to be read.
          if (!/^\d{5,}$/.test(src.accountId)) throw new FbError("source account unknown — cannot clone", { campaignId: edit.campaignId });
          if (!(await acctOk(src.accountId))) {
            throw new FbError(`source account act_${src.accountId} is not available to the launch token`, { campaignId: edit.campaignId });
          }
          const binds = resolveCloneBinds(edit, src);
          // The clone's EFFECTIVE strategy (per-row switch wins, else the source's) — resolved
          // once here so the pixel derivations below and cloneToCampaign can never disagree.
          const targetStrategy = cloneBidStrategy(edit, src);
          // Fire-time belt over the picker filter: /accounts assignments hold even for a crafted
          // POST — and for a same-account clone whose SOURCE lives in someone else's account.
          if (!(await accountAllowedFor(session, binds.accountId))) {
            throw new FbError(ACCOUNT_NOT_ASSIGNED_MSG, { campaignId: edit.campaignId }, 403);
          }
          // AIF pixel policy is DERIVED, never picked (parity with /api/aif/launch): the pixel
          // follows the OPTIMIZATION — conversion sources AND any clone switched to min-ROAS pin
          // the postback pixel (shared to every AIF cabinet); click clones stay pixel-less. The
          // RW link carries no &pixel= param, so only the adset needs it.
          if (aif) {
            binds.pixelId =
              bidKind(targetStrategy) === "roas" || /^\d{10,20}$/.test(src.pixelId) ? AIF_PIXEL.id : "";
            // Validate on EVERY account, same-account clones included: the swap to AIF_PIXEL
            // replaces whatever the source promoted, and a cabinet the shared pixel never
            // reached would otherwise orphan the campaign only at adset-create time — after the
            // brand marker is already burned (review find 08-24).
            if (binds.pixelId) {
              const pixels = await pixelsOf(binds.accountId);
              if (!pixels.some((p) => p.id === binds.pixelId)) {
                throw new FbError(
                  `pixel_not_on_account — share the AIF pixel ${AIF_PIXEL.id} to act_${binds.accountId} in Business Manager first`,
                  { campaignId: edit.campaignId },
                );
              }
            }
          }
          // A conversion-optimized source cloned into ANOTHER account must carry a pixel of that
          // account (the source's pixel isn't valid there) — the adset's promoted_object and the
          // funnel's &pixel= both need it. Click sources (no source pixel) pass pixel-less.
          // MO min-ROAS targets are exempt: their pixel is PINNED to the value pixel below.
          if (
            binds.cross &&
            /^\d{10,20}$/.test(src.pixelId) &&
            !binds.pixelId &&
            !(!aif && bidKind(targetStrategy) === "roas")
          ) {
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
            throw new FbError(`source bid strategy ${campaign.bidStrategy} can't be cloned — recreate it manually (or switch the row's strategy)`, { campaignId: edit.campaignId });
          }
          if (bidAmountMissing(campaign)) {
            throw new FbError("the clone's bid strategy needs a Bid on the row (cap $ / ROAS goal)", { campaignId: edit.campaignId });
          }
          // Mirror the launch routes: a min-ROAS goal above 100 (10 000%) is a typo, not a bid,
          // and the ambiguous 10–20 band is refused rather than guessed (normalizeRoasGoal) —
          // here, BEFORE any claim/write, so no campaign/marker gets orphaned over it.
          if (bidKind(campaign.bidStrategy) === "roas") {
            const goal = parseMoney(campaign.bidCap);
            if (goal > 100) {
              throw new FbError("ROAS goal must be 0–100 on the clone row", { campaignId: edit.campaignId });
            }
            if (normalizeRoasGoal(goal) == null) {
              throw new FbError("roas_goal_ambiguous — type the decimal goal (0,30 = 30%) on the clone row", { campaignId: edit.campaignId });
            }
          }
          // AIF min-ROAS rides the derived postback pixel — a roas source that somehow carries no
          // promoted pixel has nothing to value-optimize on; refuse before any claim/write (Meta
          // would only reject the VALUE ad set after the campaign exists — orphan + burnt brand).
          if (aif && bidKind(campaign.bidStrategy) === "roas" && !editBinds.pixelId) {
            throw new FbError(
              "roas_pixel_missing — the source has no promoted pixel; a min-ROAS clone can't value-optimize",
              { campaignId: edit.campaignId },
            );
          }
          // Owner rule (2026-08-11): MO min-ROAS optimizes ONLY on the partner's value pixel.
          // PIN it (launcher-card parity — same-account clones have no pixel picker, and a row
          // switched to ROAS needs it regardless of what the source promoted) after verifying the
          // build account carries the shared pixel; the link rewrite below then fires it too.
          if (!aif && bidKind(campaign.bidStrategy) === "roas" && editBinds.pixelId !== ROAS_PIXEL.id) {
            const pixels = await pixelsOf(binds.accountId);
            if (!pixels.some((p) => p.id === ROAS_PIXEL.id)) {
              throw new FbError(
                `pixel_not_on_account — min-ROAS clones run only on ${ROAS_PIXEL.name} (${ROAS_PIXEL.id}); share it to act_${binds.accountId} in Business Manager first`,
                { campaignId: edit.campaignId },
              );
            }
            editBinds.pixelId = ROAS_PIXEL.id;
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

          // Account launch slot (5 campaigns / 30 min per ad account, all channels — owner rule
          // 2026-08-18), claimed BEFORE the costly media migration so a full account fails fast;
          // released in the catch on any pre-campaign failure.
          acctSlot = await claimAcctSlot(binds.accountId, {
            user: session.username,
            partner: aif ? "us" : "in",
            channel: aif ? "aif-clone" : "clone",
            name: edit.name,
            accountName: await acctNameOf(binds.accountId).catch(() => ""),
          });

          // Cross-account: re-home the media in the target account BEFORE claiming a gcm — a failed
          // migration (video unfetchable, processing error) must not burn a code or orphan anything.
          // Cached per (source campaign → target account): N copies of one source migrate ONCE.
          let cloneMedia = media;
          if (binds.cross) {
            progress("media");
            const mKey = `${edit.campaignId}→${binds.accountId}`;
            let migrated = migratedCache.get(mKey);
            if (!migrated) {
              migrated = await migrateMediaToAccount(media, src.accountId, binds.accountId, edit.name, railToken);
              migratedCache.set(mKey, migrated);
            }
            cloneMedia = migrated;
          }

          // Reserve this rail's revenue marker: MO = a gcm code, AIF = a brand (both registries
          // enforce uniqueness atomically; the marker rides the shared `gcm` field downstream).
          progress("gcm");
          if (aif) {
            const c = await claimBrand("", { campaign_name: edit.name, notes: "claimed via adlauncher clone" });
            claim = { gcm: c.brand, documentId: c.documentId };
          } else {
            // The signer rides in the registry note (audits tell soc-born from sys-born runs).
            claim = await claimGcm("", {
              campaign_name: edit.name,
              notes: `claimed via adlauncher clone${soc ? ` (${soc.sys ? "sys" : "soc"}:${soc.name})` : ""}`,
            });
          }
          const gcm = claim.gcm;

          const localeIds = await resolveLocales(edit.locales, railToken);

          progress("campaign");
          const camp = await post(`act_${editBinds.accountId}/campaigns`, campaignPayload(campaign, edit.name));
          created.campaign_id = String(camp.id);

          progress("adset");
          const adset = await withParentRetry(String(camp.id), () =>
            createAdset(
              `act_${editBinds.accountId}/adsets`,
              adsetPayload(campaign, edit.name, String(camp.id), editBinds, localeIds),
              post,
            ),
          );
          created.adset_id = String(adset.id);

          progress("creative");
          const creative = await post(
            `act_${editBinds.accountId}/adcreatives`,
            cloneCreativePayload(
              edit.name,
              editBinds.pageId,
              cloneMedia,
              gcm,
              editBinds.pixelId,
              // AIF RW links carry the brand marker only — no pixel param exists on that rail.
              aif ? (l: string) => swapBrand(l, gcm) : undefined,
            ),
          );
          created.creative_id = String(creative.id);

          progress("ad");
          const ad = await withParentRetry(String(adset.id), () =>
            post(`act_${editBinds.accountId}/ads`, adPayload(edit.name, String(adset.id), String(creative.id))),
          );
          // Belt over the fbPost error-body guard: never record a phantom "undefined" ad id.
          if (!ad.id) throw new FbError("ad create returned no id", ad);
          created.ad_id = String(ad.id);

          // Registry ledger: this clone took one slot on its fanka (fire-safe; the box's next
          // Facebook sweep reconciles either way).
          await reportPagesUsed(aif ? "us" : "in", [{ pageId: editBinds.pageId, delta: 1 }]);

          if (aif) {
            await backfillBrand(claim.documentId, {
              campaign_id: created.campaign_id,
              adset_id: created.adset_id,
              ad_id: created.ad_id,
            });
          } else {
            await backfillGcm(
              claim.documentId,
              {
                campaign_id: created.campaign_id,
                adset_id: created.adset_id,
                ad_id: created.ad_id,
              },
              claim.gcm,
            );
          }

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
          // Free the account's launch slot when NO campaign was created (limit meters only
          // campaigns that exist); once one exists the slot stays consumed.
          if (acctSlot && !created.campaign_id) await releaseAcctSlot(acctSlot.documentId);
          // Free the marker when nothing was created; keep the row (marked retired) once a campaign
          // exists so the orphaned campaign stays traceable — same policy as the launch routes.
          if (claim?.documentId) {
            if (created.campaign_id) {
              const failPatch = {
                status: "retired",
                notes: `clone failed: ${err.message}`,
                // Record what DID get created so the orphaned campaign is traceable by marker.
                campaign_id: created.campaign_id,
                ...(created.adset_id ? { adset_id: created.adset_id } : {}),
              };
              if (aif) await backfillBrand(claim.documentId, failPatch);
              else await backfillGcm(claim.documentId, failPatch, claim.gcm);
            } else if (aif) {
              await deleteBrand(claim.documentId);
            } else {
              await deleteGcm(claim.documentId, claim.gcm);
            }
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
        } finally {
          // The clone's last transition must land before the loop moves on / the function
          // freezes — in a `finally` so no escape path (however unlikely) can leak the 30s beat
          // or skip the flush (review find 08-24; the launch route already does this).
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
