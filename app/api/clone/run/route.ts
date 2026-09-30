import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { AIF_VALUE_PIXEL, AV_PIXEL, ROAS_PIXEL, aifOfferablePixels, avDelivery, partnerConfig, pickAifPixel, type PartnerId } from "@/lib/partners";
import { resolveMoSigner } from "@/lib/mo-soc";
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
import { aifRail } from "@/lib/aif-launch";
import { avKeysRegistered, avRail, avRailEnabled } from "@/lib/av-launch";
import { backfillGcm, claimGcm, deleteGcm } from "@/lib/gcm-claim";
import { backfillBrand, claimBrand, deleteBrand } from "@/lib/aif-claim";
import { backfillAvKey, claimAvKey, releaseAvKey } from "@/lib/av-keys";
import { avDestinationBase, avLink } from "@/lib/av-link";
import { sourceMediaLink } from "@/lib/av-clone";
import { resolveAvDestination } from "@/lib/av-destination";
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
  swapGcm,
  swapPixel,
  toolCreativeFromSource,
  toolMediaRefFromSource,
  toolSourceMediaItem,
} from "@/lib/clone-run";
// TOOL channel (owner ask 28.09): the same clone RECREATE, but built through the HS Ads Manager
// sessions service instead of direct Graph — USD money + ROAS coefficient, everything PAUSED.
import { buildToolCampaign, runToolMedia, runToolPublish, toolEnsureMark, type ToolMediaRefOut } from "@/lib/tool-launch";
import { toolAccountVisible, toolDeps, toolInputFromCampaign, toolLaunchReady } from "@/lib/tool-run";

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
  // Which rail builds the clone: "graph" = today's direct-Graph recreate (unchanged default);
  // "tool" = recreate through the HS Ads Manager sessions service (owner ask 28.09). A batch-level
  // field (the board picks one channel per wave, like the HS clone board's dup-channel toggle). NOT
  // the legacy `channel` wire field (the retired per-buyer soc switch — still ignored).
  let via: "graph" | "tool" = "graph";
  try {
    const j = (await req.json()) as { partnerId?: string; edits?: CloneEdit[]; taskIds?: unknown[]; /** launch channel: "tool" builds through TOOL; anything else = Graph */ via?: string; /** legacy, ignored — the signer is the owner's pick on /tokens */ channel?: string };
    partnerId = String(j.partnerId ?? "in") as PartnerId;
    via = j.via === "tool" ? "tool" : "graph";
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
  // The partner picks the RAIL: AV clones ride the AV token, the AV key registry and a
  // destination+key link rewrite (no pixel tail — AV's site script fires AV_PIXEL); AIF clones ride the AIF token, the aif-maps brand
  // registry and a brand-only link rewrite; everything else stays byte-identical to the MO flow
  // (token default, gcm registry, gcm+pixel link rewrite). One route, three claim/backfill/release
  // bundles.
  const av = Boolean(partner.avLaunch);
  const aif = Boolean(partner.aifLaunch);
  // Dormant by flag: the AV clone rail is 404 (not half-open) until NEXT_PUBLIC_AV_ENABLED=1 — the
  // server twin of the build-time switcher gate, matching /api/av/launch (which 404s in this same
  // window). Without it a STAGED enable (av.clone token assigned + AV_KEYS_REGISTERED set, but the
  // public flag still off / not yet redeployed) would let a crafted POST { partnerId: "av" } pass the
  // token + key gates and build REAL AV clones while the launch route is correctly dormant. partnerId
  // is taken raw (not sanitizePartnerId'd) here, so this is the gate that keeps the rail fully
  // dormant, not half-open (review find 09-28). MO/AIF/HS are untouched (av is false).
  if (av && !avRailEnabled()) {
    return NextResponse.json({ ok: false, error: "av_rail_disabled" }, { status: 404 });
  }
  // AV has no TOOL channel: its cabinets live on AV's own FB token, the TOOL sessions are the HS
  // team's Ads Manager sessions. A crafted via:"tool" is refused rather than silently rerouted.
  if (av && via === "tool") {
    return NextResponse.json({ ok: false, error: "tool_not_available — AV clones run on the AV token only" }, { status: 400 });
  }
  // WHICH bearer builds is the OWNER'S pick on /tokens (clone slots; env defaults while unassigned,
  // no env default for AV) — the AV rail on its token, the AIF rail on its token, the MO rail on the
  // MO clone signer. A missing/unreadable token is a clean config error, never a silent fallback to
  // another bearer. The legacy `channel` wire field (the retired per-buyer soc switch) is ignored.
  const avRes = av ? await avRail("clone") : null;
  if (av && !avRes?.ok) {
    return NextResponse.json({ ok: false, error: avRes?.ok === false ? avRes.error : "no_av_token" }, { status: 400 });
  }
  // AV keys are launchable only once the owner registered the pool in ActiveView — refuse the whole
  // batch up front (no FB write, no key claim) rather than fail every clone at the claim.
  if (av && avKeysRegistered() === 0) {
    return NextResponse.json(
      {
        ok: false,
        error: "av_keys_not_registered — no AV keys are registered in ActiveView yet; an owner uploads the pool (AV keys page) and sets AV_KEYS_REGISTERED",
      },
      { status: 400 },
    );
  }
  const aifRes = aif ? await aifRail("clone") : null;
  if (aif && !aifRes?.ok) {
    return NextResponse.json({ ok: false, error: aifRes?.ok === false ? aifRes.error : "no_aif_token" }, { status: 400 });
  }
  const moRes = aif || av ? null : await resolveMoSigner("clone");
  if (!aif && !av && !moRes?.ok) {
    return NextResponse.json({ ok: false, error: moRes?.ok === false ? moRes.error : "no_token" }, { status: 400 });
  }
  /** The AV rail (null off the AV rail) — its token signs every Graph call and its catalogs validate
   *  the picked page/account and (Purchase clones) that the build account carries AV_PIXEL. */
  const avr = avRes?.ok ? avRes.rail : null;
  const rail = aifRes?.ok ? aifRes.rail : null;
  /** The MO signer (null on the AIF/AV rails) — its bearer signs EVERY Graph call (source read,
   *  media migration, tree build) and its catalogs validate the picked page/account/pixel. */
  const soc = moRes?.ok ? moRes.signer : null;
  /** Catalog identity of the MO signer (undefined = the AIF/AV rails' own catalog helpers below). */
  const cat = soc?.cat;
  const railToken = av ? avr?.token : aif ? rail?.token : soc?.token;
  const pageOk = (p: string) => (av ? avr!.isAdvertisablePage(p) : aif ? rail!.isAdvertisablePage(p) : isAdvertisablePage(p, cat));
  const pageNameOf = (p: string) => (av ? avr!.advertisablePageName(p) : aif ? rail!.advertisablePageName(p) : advertisablePageName(p, cat));
  const acctOk = (a: string) => (av ? avr!.isTokenAccount(a) : aif ? rail!.isTokenAccount(a) : isTokenAccount(a, cat));
  // AV reads the AV token's own catalog (a Purchase clone checks the build account carries AV_PIXEL);
  // AIF its rail's; MO the signer's.
  const pixelsOf = (a: string) => (av ? accountPixels(a, avr!.cat) : aif ? rail!.accountPixels(a) : accountPixels(a, cat));
  const acctNameOf = (a: string) => (av ? avr!.accountName(a) : aif ? rail!.accountName(a) : tokenAccountName(a, cat));
  const post: typeof fbPost = (path, params) =>
    av ? avr!.fbPost(path, params as Json) : aif ? rail!.fbPost(path, params as Json) : fbPost(path, params, railToken);
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
      // AV's pixel is never a row pick (a Purchase clone gets AV_PIXEL server-side, avDelivery) —
      // ignore any pixel a stale row carries so it is neither validated here nor sent.
      const px = av ? "" : String(e.pixelId ?? "").trim();
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
  // AV: the verdict on a source's destination, kept for this batch — many clones of one source ask
  // the same question, and a chat target that does not answer would cost its timeouts per clone.
  const avDestinationCache = new Map<string, ReturnType<typeof resolveAvDestination>>();
  // Media already migrated into a target account this batch, keyed "<sourceCampaignId>→<accountId>".
  const migratedCache = new Map<string, SourceMedia>();

  // withFbBudget wraps the CONSTRUCTION: start() begins inside it, so the whole batch inherits it.
  // The same deadline bounds every TOOL media/publish poll (TOOL calls ride toolFetch, not the FB
  // ALS budget) so a TOOL clone settles + streams a terminal/pending event before Vercel freezes us.
  const streamDeadlineAt = Date.now() + FB_BUDGET_MS;
  const stream = withFbBudget({ deadlineAt: streamDeadlineAt, retries: FB_BUDGET_RETRIES }, () =>
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
        // The clone's name carries the CHANNEL marker server-side (an old/tampered client may send
        // an unmarked or wrong one). TOOL clones get ` GCL TOOL - ` after the clone prefix
        // (toolEnsureMark — never a SOC mark: TOOL is not our social token, spec §1). Graph clones on
        // a soc-class signer keep the ` SOC - ` marker (same as /api/launch); system-class socs
        // (Spencermo) and TOOL both create without SOC.
        const src0 = edits[idx];
        const markedName =
          via === "tool"
            ? toolEnsureMark(src0.name)
            : soc && !soc.sys
              ? moEnsureSocMark(src0.name)
              : src0.name;
        const edit = markedName === src0.name ? src0 : { ...src0, name: markedName };
        // Server-side mirror of this clone's Task Manager row (no-op when no task id was sent).
        // The partner rides on every write: a row this writer CREATES (client save lost) must
        // still land in the right drawer's scope — null matches no scope at all.
        const tw = taskWriter(session.username, taskIds[idx] ?? null, { partner: av ? "av" : aif ? "us" : "in" });
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
        // review find 28.09 (belt): set by runToolPublish's onSubmitted the instant TOOL returns a
        // job id (before any poll). Once set, the per-clone catch treats "no campaign id known" as
        // PENDING (keep marker + slot), never a freed code/slot — the job may still be creating it.
        let toolSubmittedJob: number | null = null;
        // Set just before the deliberate rethrow of a DEFINITE TOOL failure (error / canceled job
        // with no ids) — the belt must not turn that into a kept marker + slot (review find 28.09).
        let toolDefiniteFail = false;
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
          // AV clone: the SOURCE ad's link must already be an AV destination. Re-resolve it
          // server-side (host is an AV site / redirect domain, article live / redirect path present
          // + domain live) BEFORE any slot/key claim — a source pointing anywhere else is refused
          // with the reason, nothing burned. The link is rebuilt from this base + a fresh key below
          // (the source's own utm_campaign is never kept).
          let avBase = "";
          if (av) {
            const shape = avDestinationBase(sourceMediaLink(media));
            if (!shape.ok) {
              throw new FbError(`clone_destination_invalid — the source ad's link is not an AV destination (${shape.error})`, { campaignId: edit.campaignId });
            }
            let verdict = avDestinationCache.get(shape.base);
            if (!verdict) {
              verdict = resolveAvDestination(shape.base);
              avDestinationCache.set(shape.base, verdict);
            }
            const resolved = await verdict;
            if (!resolved.ok) {
              throw new FbError(`clone_destination_invalid — ${resolved.error}`, { campaignId: edit.campaignId });
            }
            avBase = resolved.base;
          }
          // The clone's build location: the source's own account by default, or the buyer's picked
          // TARGET account (cross-account — media gets migrated there below). The source account is
          // re-checked even for cross-account clones: its media is about to be read.
          if (!/^\d{5,}$/.test(src.accountId)) throw new FbError("source account unknown — cannot clone", { campaignId: edit.campaignId });
          if (!(await acctOk(src.accountId))) {
            throw new FbError(`source account act_${src.accountId} is not available to the launch token`, { campaignId: edit.campaignId });
          }
          const binds = resolveCloneBinds(edit, src);
          // AV never carries the SOURCE's pixel through (resolveCloneBinds would, for a same-account
          // clone): its pixel is AV_PIXEL or none, set from the clone's delivery below (avDelivery).
          if (av) binds.pixelId = "";
          // The clone's EFFECTIVE strategy (per-row switch wins, else the source's) — resolved
          // once here so the pixel derivations below and cloneToCampaign can never disagree.
          const targetStrategy = cloneBidStrategy(edit, src);
          // Min-ROAS optimizes purchase VALUE and AV's Purchase events carry none — a min-ROAS target
          // (the row's switch or an inherited roas source) has nothing to optimize on, refused before any claim.
          if (av && bidKind(targetStrategy) === "roas") {
            throw new FbError(
              "bid_strategy_invalid — min-ROAS needs purchase value; AV's Purchase events carry none (use lowest cost or a cost cap)",
              { campaignId: edit.campaignId },
            );
          }
          // Fire-time belt over the picker filter: /accounts assignments hold even for a crafted
          // POST — and for a same-account clone whose SOURCE lives in someone else's account.
          if (!(await accountAllowedFor(session, binds.accountId))) {
            throw new FbError(ACCOUNT_NOT_ASSIGNED_MSG, { campaignId: edit.campaignId }, 403);
          }
          // AIF pixel (parity with /api/aif/launch): conversion clones run on the BUILD
          // account's OFFERABLE pixels (token catalog minus retired — owner call 09-02 pt3).
          // A row switched to min-ROAS pins the rail's value pixel VD-C1-HS-11; a plain
          // conversion keeps a valid target pick / the source's own pixel when offerable, else
          // falls to the pickAifPixel auto-default (clones of legacy campaigns migrate off the
          // retired pixel automatically). Validated BEFORE the brand marker is burned (review
          // find 08-24). Click clones stay pixel-less; the link rewrite mirrors whatever the
          // adset promotes.
          if (aif) {
            const roasTarget = bidKind(targetStrategy) === "roas";
            if (roasTarget || /^\d{10,20}$/.test(src.pixelId)) {
              const raw = await pixelsOf(binds.accountId);
              const offer = aifOfferablePixels(raw);
              if (roasTarget) {
                if (!offer.some((p) => p.id === AIF_VALUE_PIXEL.id)) {
                  throw new FbError(
                    `pixel_not_on_account — min-ROAS runs only on ${AIF_VALUE_PIXEL.name} (${AIF_VALUE_PIXEL.id}); share it to act_${binds.accountId} in Business Manager first`,
                    { campaignId: edit.campaignId },
                  );
                }
                binds.pixelId = AIF_VALUE_PIXEL.id;
              } else {
                const bound = offer.find((p) => p.id === binds.pixelId) ?? pickAifPixel(raw);
                if (!bound) {
                  throw new FbError(
                    `no_pixel_on_account — share ${AIF_VALUE_PIXEL.name} to act_${binds.accountId} in Business Manager first`,
                    { campaignId: edit.campaignId },
                  );
                }
                binds.pixelId = bound.id;
              }
            } else {
              binds.pixelId = "";
            }
          }
          // A conversion-optimized source cloned into ANOTHER account must carry a pixel of that
          // account (the source's pixel isn't valid there) — the adset's promoted_object and the
          // funnel's &pixel= both need it. Click sources (no source pixel) pass pixel-less.
          // MO min-ROAS targets are exempt: their pixel is PINNED to the value pixel below.
          if (
            !av &&
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
          if (av) {
            // AV delivery follows the SOURCE (owner ask 30.09 — both AV modes): a Purchase source
            // clones as Sales / Purchase on AV_PIXEL, a link-click source as Traffic / link clicks
            // with no pixel (avDelivery). AV's own site script fires the pixel, so the build account
            // must carry it — checked here, before any claim.
            const d = avDelivery(campaign.optimization);
            campaign.objective = d.objective;
            campaign.optimization = d.optimization;
            if (d.conversionEvent) campaign.conversionEvent = d.conversionEvent;
            campaign.pixel = d.pixel;
            editBinds.pixelId = d.pixel;
            if (d.pixel && !(await pixelsOf(binds.accountId)).some((p) => p.id === d.pixel)) {
              throw new FbError(
                `pixel_not_on_account — Purchase clones run on ${AV_PIXEL.name} (${AV_PIXEL.id}); share it to act_${binds.accountId} in Business Manager first`,
                { campaignId: edit.campaignId },
              );
            }
          }
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
          // Owner rule (2026-08-11, re-pinned 09-08): MO min-ROAS optimizes ONLY on the partner's
          // value pixel ROAS_PIXEL (VD-C1-HS-11). PIN it (launcher-card parity — same-account
          // clones have no pixel picker, and a row switched to ROAS needs it regardless of what
          // the source promoted) after verifying the build account STILL carries the shared pixel
          // — checked even when the source already promoted it: the admin can unshare a pixel
          // between the source launch and the clone (09-02 precedent), and this must fail BEFORE
          // any gcm claim/write, not at adset-create. The link rewrite below then fires it too.
          // AIF rows pinned their own value pixel above.
          if (!aif && !av && bidKind(campaign.bidStrategy) === "roas") {
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
          // TOOL build target must be visible to a LIVE TOOL session (owner ask 28.09) — checked at
          // fire time (force-refreshes once on a miss) BEFORE any slot/marker claim, so a not-ready
          // rail burns nothing. Live 28.09 only HS accounts exist on TOOL, so MO/AIF cabinets stay
          // not-visible until a session that sees them is added on Ads Manager sessions.
          if (via === "tool" && !(await toolAccountVisible(binds.accountId))) {
            throw new FbError(
              `account act_${binds.accountId} is not visible to any live TOOL session — an owner adds/refreshes one on Ads Manager sessions`,
              { campaignId: edit.campaignId },
            );
          }
          // review find 28.09: read the BUILD account's real currency from the TOOL ready roster
          // (accounts[].currency — the SAME source app/api/launch reads) so a clone inherits
          // buildToolCampaign's account_currency_not_usd refusal, instead of assuming USD. Default
          // USD ONLY when the roster row is genuinely missing (a 60s-roster refresh race; TOOL's own
          // validate step re-checks currency regardless). Live 28.09 every TOOL account is USD, so
          // this is latent until an MO/AIF (non-USD) cabinet becomes TOOL-visible.
          let toolAcctCurrency = "USD";
          if (via === "tool") {
            const roster = await toolLaunchReady();
            if (roster.ok) toolAcctCurrency = roster.accounts.find((a) => a.account_id === binds.accountId)?.currency || "USD";
          }

          // Account launch slot (5 campaigns / 30 min per ad account, all channels — owner rule
          // 2026-08-18), claimed BEFORE the costly media migration so a full account fails fast;
          // released in the catch on any pre-campaign failure. The channel marker is telemetry only
          // (the 5/30min window spans every channel); TOOL clones tag "tool-clone"/"aif-tool-clone".
          acctSlot = await claimAcctSlot(binds.accountId, {
            user: session.username,
            partner: av ? "av" : aif ? "us" : "in",
            channel: av ? "av-clone" : via === "tool" ? (aif ? "aif-tool-clone" : "tool-clone") : aif ? "aif-clone" : "clone",
            name: edit.name,
            accountName: await acctNameOf(binds.accountId).catch(() => ""),
          });

          // Cross-account: re-home the media in the target account BEFORE claiming a gcm — a failed
          // migration (video unfetchable, processing error) must not burn a code or orphan anything.
          // Cached per (source campaign → target account): N copies of one source migrate ONCE.
          // Graph cross-account re-home (advideos file_url / adimages copy_from). SKIPPED on TOOL:
          // the TOOL build registers the source's media itself (same-account ref or media/from-url),
          // so no Graph re-upload with our token into a TOOL session's account.
          let cloneMedia = media;
          if (via !== "tool" && binds.cross) {
            progress("media");
            const mKey = `${edit.campaignId}→${binds.accountId}`;
            let migrated = migratedCache.get(mKey);
            if (!migrated) {
              migrated = await migrateMediaToAccount(media, src.accountId, binds.accountId, edit.name, railToken);
              migratedCache.set(mKey, migrated);
            }
            cloneMedia = migrated;
          }

          // Reserve this rail's revenue marker: MO = a gcm code, AIF = a brand, AV = an AV key (all
          // registries enforce uniqueness atomically; the marker rides the shared `gcm` field
          // downstream). AV claims a fresh key from the registered pool — the source's own key is
          // never kept.
          progress("gcm");
          if (av) {
            const c = await claimAvKey("", avKeysRegistered(), {
              user: session.username,
              via: "clone",
              source_campaign_id: edit.campaignId,
              name: edit.name,
              ad_account: editBinds.accountId,
              destination: avBase,
            });
            claim = { gcm: c.key, documentId: c.documentId };
          } else if (aif) {
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

          if (via === "tool") {
            // ---- TOOL create-from-scratch (owner ask 28.09). Same recreate, built through the HS
            //      Ads Manager sessions service: USD money + ROAS coefficient (never cents / ×10000),
            //      everything PAUSED. The Idempotency-Key is the clone's task id (a retried wave
            //      never double-creates); media rides a suffixed key so it can't collide with the
            //      create's client_request_id. ----
            const idemKey = taskIds[idx] ?? undefined;
            const mediaIdemKey = idemKey ? `${idemKey}:media` : undefined;
            // The rebuilt destination link: fresh gcm/brand + the build account's pixel, byte-for-byte
            // the same rewrite the Graph creative uses (swapGcm+swapPixel for MO, swapBrand+swapPixel
            // for AIF; swapPixel no-ops for pixel-less click clones).
            const toolRewrite = aif
              ? (l: string) => swapPixel(swapBrand(l, gcm), editBinds.pixelId)
              : (l: string) => swapPixel(swapGcm(l, gcm), editBinds.pixelId);
            const toolCreative = toolCreativeFromSource(media, toolRewrite);

            // Media: same-account reuses the source's own account-local asset directly (valid — the
            // build account IS the source's and the resolving TOOL session sees it); cross-account
            // (or a picture-URL-only image with no hash) registers the source's PUBLIC url into the
            // build account through TOOL and polls it ready. The `media` stage only fires when we
            // actually register (mirrors the Graph rail, which shows "media" only cross-account).
            let toolMedia: ToolMediaRefOut | null = binds.cross ? null : toolMediaRefFromSource(media);
            if (!toolMedia) {
              progress("media");
              const item = await toolSourceMediaItem(media, src.accountId, edit.name, railToken);
              const reg = await runToolMedia(toolDeps, binds.accountId, [item], {
                deadlineAt: streamDeadlineAt,
                idempotencyKey: mediaIdemKey,
                onStage: () => progress("media"),
              });
              if (!reg.ok) throw new FbError(reg.error, { campaignId: edit.campaignId });
              toolMedia = reg.refs[0];
            }

            // Assemble the normalized TOOL input from the SAME cloneToCampaign object the Graph build
            // uses (so geo / bid / budget / category / placement / age stay identical), with the
            // rebuilt creative + registered media. Clones are PAUSED. accountCurrency is the BUILD
            // account's real roster currency (review find 28.09) so a non-USD cabinet is refused the
            // same way the launch routes refuse it — USD only when the roster row is genuinely missing.
            const built = buildToolCampaign(
              toolInputFromCampaign(campaign, {
                name: edit.name,
                pageId: editBinds.pageId,
                pixelId: editBinds.pixelId,
                localeIds,
                status: "PAUSED",
                accountCurrency: toolAcctCurrency,
                creatives: [
                  {
                    name: edit.name,
                    media: toolMedia.media,
                    ...(toolMedia.thumbnail ? { thumbnail: toolMedia.thumbnail } : {}),
                    primaryText: toolCreative.primaryText,
                    headline: toolCreative.headline,
                    ...(toolCreative.description ? { description: toolCreative.description } : {}),
                    url: toolCreative.url,
                    cta: toolCreative.cta,
                  },
                ],
              }),
            );
            // A builder refusal (bad currency/objective/cta/event, WW without support, etc.) is a
            // clean per-clone error — nothing was created, so the catch frees the marker + slot.
            if (!built.ok) throw new FbError(built.error, { campaignId: edit.campaignId });

            // Submit + follow the create job to a terminal state. Stages feed the same clone-stage
            // keys the Task Manager renders (campaign/adset/creative/ad); a media step collapses to
            // "media" and the terminal done/error is handled from the result, not the stage.
            progress("campaign");
            const run = await runToolPublish(toolDeps, binds.accountId, built.body, {
              idempotencyKey: idemKey,
              deadlineAt: streamDeadlineAt,
              // review find 28.09 (belt): record the job id the instant TOOL accepts the submit,
              // before any poll — so the per-clone catch never frees the marker/slot under a live
              // clone TOOL is still creating server-side.
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
                // Deadline hit while TOOL is still working: KEEP the marker + slot and note the job
                // so it can be reconciled from the TOOL console (spec §2.5). Nothing is freed; the
                // row stays "running" (honest — the job is genuinely in flight).
                if (run.jobId) created.tool_job_id = run.jobId;
                if (run.created?.campaignId) created.campaign_id = run.created.campaignId;
                const note = `pending tool job #${run.jobId ?? "?"} — check Ads Manager sessions → Jobs`;
                if (claim.documentId) {
                  const patch = { notes: note, ...(created.campaign_id ? { campaign_id: created.campaign_id } : {}) };
                  if (aif) await backfillBrand(claim.documentId, patch);
                  else await backfillGcm(claim.documentId, patch, claim.gcm);
                }
                settled = true;
                // Terminal row, like the launch rails: this synchronous stream never revisits it, so
                // a "running" row would sit in the team drawer forever (review find 28.09). The
                // client reads pending:true and offers no retry; the note names the TOOL job.
                tw.write({
                  status: "error",
                  stage: "ad",
                  finished_at: Date.now(),
                  error: note,
                  ...(created.campaign_id ? { campaign_id: created.campaign_id } : {}),
                  ...(run.jobId ? { link: String(run.jobId) } : {}),
                });
                send({ idx, ok: false, stage: "ad", pending: true, via: "tool", tool_job_id: run.jobId ?? null, error: run.error, ...created });
                // `continue` runs the loop's finally (clearInterval + tw.flush) before advancing.
                continue;
              }
              // A clean refusal. Record whatever TOOL created so the shared catch RETIRES the marker
              // (traceable by the job id in the note) + keeps the slot when something exists, or
              // FREES both when nothing did — identical policy to the Graph rail (spec §2.5).
              if (run.created?.campaignId) created.campaign_id = run.created.campaignId;
              if (run.created?.adsetIds[0]) created.adset_id = run.created.adsetIds[0];
              if (run.jobId) created.tool_job_id = run.jobId;
              // A DEFINITE outcome (runToolPublish reports every ambiguous end as `pending`, handled
              // above) — mark it so the catch's submitted-job belt lets the free/retire policy run
              // instead of keeping a marker + slot for a clone that provably never landed.
              toolDefiniteFail = true;
              throw new FbError(run.jobId ? `${run.error} (tool job #${run.jobId})` : run.error, { campaignId: edit.campaignId });
            }

            // Done — record the created ids; fall through to the shared success finalization below.
            created.campaign_id = run.campaignId;
            if (run.adsetId) created.adset_id = run.adsetId;
            if (run.adIds[0]) created.ad_id = run.adIds[0];
            if (run.adIds.length > 1) created.ad_ids = [...run.adIds];
            created.tool_job_id = run.jobId;
          } else {
            // ---- Graph recreate (unchanged) ----
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
                // AV links are REBUILT from the resolved destination + the fresh key (the source's
                // whole tracking tail is discarded — destination/macros come from lib/av-link, never
                // the stale source link). AIF RW links: brand marker + the promoted pixel (09-02 —
                // the RW page echoes it into the postback, the CAPI forwarder routes the Purchase by
                // it; swapPixel no-ops for pixel-less click clones, leaving legacy links untouched).
                av
                  ? () => avLink(avBase, gcm)
                  : aif
                    ? (l: string) => swapPixel(swapBrand(l, gcm), editBinds.pixelId)
                    : undefined,
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
          }

          // Registry ledger: this clone took one slot on its fanka (fire-safe; the box's next
          // Facebook sweep reconciles either way). AV has no hs-tools scope — nothing to report.
          if (!av) await reportPagesUsed(aif ? "us" : "in", [{ pageId: editBinds.pageId, delta: 1 }]);

          if (av) {
            await backfillAvKey(claim.gcm, {
              campaign_id: String(created.campaign_id),
              adset_id: String(created.adset_id),
              ad_id: String(created.ad_id),
              ad_count: 1,
            });
          } else if (aif) {
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
            // TOOL clones persist the job id in `link` (the HS convention: link = remote id) so the
            // drawer can trace the run to the TOOL console; the Graph clone leaves link empty.
            ...(via === "tool" && created.tool_job_id != null ? { link: String(created.tool_job_id) } : {}),
          });
          // `...created` already carries tool_job_id on the TOOL path; add the channel tag on top.
          send({ idx, ok: true, stage: "done", gcm, ...created, ...(via === "tool" ? { via: "tool" } : {}) });
        } catch (e) {
          const err = e as FbError;
          // review find 28.09 (TOOL belt): once TOOL accepted the submit (onSubmitted set
          // toolSubmittedJob) but no campaign id came back, a throw here (the definite-failure
          // rethrow, or any other) must NOT free the marker/slot — TOOL may still be creating the
          // clone server-side. Settle it exactly like the pending terminal above (keep marker + slot,
          // "pending tool job #N" note, row stays running with the job id in `link`); the job is in
          // flight, so it is NOT counted as failed. backfill is .catch-guarded here because we are
          // already inside the catch (a Strapi throw must not escape past the finally).
          if (via === "tool" && toolSubmittedJob != null && !created.campaign_id && !toolDefiniteFail) {
            if (created.tool_job_id == null) created.tool_job_id = toolSubmittedJob;
            const note = `pending tool job #${toolSubmittedJob} — check Ads Manager sessions → Jobs`;
            if (claim?.documentId) {
              const patch = { notes: note };
              if (aif) await backfillBrand(claim.documentId, patch).catch(() => {});
              else await backfillGcm(claim.documentId, patch, claim.gcm).catch(() => {});
            }
            settled = true;
            // Terminal row (the launch rails do the same): nothing in this synchronous stream will
            // ever advance it, so "running" would sit in the team drawer forever.
            tw.write({ status: "error", stage: "ad", finished_at: Date.now(), error: note, link: String(toolSubmittedJob) });
            send({ idx, ok: false, stage: "ad", pending: true, via: "tool", tool_job_id: toolSubmittedJob, error: err.message ?? String(e), ...created });
            // `continue` runs the loop's finally (clearInterval + tw.flush) before advancing.
            continue;
          }
          failed++;
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
              // AV registry settle is best-effort (never abort the batch over a Strapi hiccup).
              if (av) {
                try {
                  await backfillAvKey(claim.gcm, {
                    status: "retired",
                    notes: `clone failed: ${err.message}`,
                    campaign_id: String(created.campaign_id),
                    ...(created.adset_id ? { adset_id: String(created.adset_id) } : {}),
                  });
                } catch {
                  /* the AV keys page shows the retired-but-unsettled row to release by hand */
                }
              } else if (aif) await backfillBrand(claim.documentId, failPatch);
              else await backfillGcm(claim.documentId, failPatch, claim.gcm);
            } else if (av) {
              try {
                await releaseAvKey(claim.documentId);
              } catch {
                /* best-effort — a leftover row shows on the AV keys page */
              }
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
          send({
            idx,
            ok: false,
            stage: "error",
            error: err.message ?? String(e),
            detail: err.detail ?? null,
            created,
            // TOOL failures carry the channel + (when TOOL got far enough to have one) the job id, so
            // the drawer/console can trace a retired-with-ids clone. The Graph path adds neither.
            ...(via === "tool" ? { via: "tool" } : {}),
            ...(via === "tool" && created.tool_job_id != null ? { tool_job_id: created.tool_job_id } : {}),
          });
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
