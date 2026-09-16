// Snapchat rail — the after() wave pump ALGORITHM with every side effect injected (lib/snap-pump.ts
// binds the real Snapchat client, the key registry and the task-store writer). Kept pure so
// `node --test tests/snap-pump-core.test.ts` proves the dispositions without a network:
//   key → media → campaign (PAUSED) → adsquad → creative → ad → activate → done
// A refusal (HTTP 4xx) before the campaign exists releases the key (pool capacity, not history);
// after it exists the key is RETIRED with the ids so far and the campaign stays a PAUSED shell
// (nothing delivers). An ambiguous outcome (5xx / network) is reported as "interrupted" and NEVER
// re-sent — a second attempt could build a second campaign. Activation failure is not a failed
// launch: the whole chain exists, the buyer flips it in Ads Manager.
// The key registry is best-effort bookkeeping: a release/backfill that throws never aborts the
// wave and never leaves a row without a terminal status — the failure is folded into the row's
// text (a stuck row invites a re-fire that would build a second campaign).

import type { SnapLaunchShotIn, SnapLaunchWire, SnapResolved } from "./snap-launch";

export const SNAP_PUMP_BUDGET_MS = 770_000;
/** The tail a copy admitted at the deadline may still need once its media is uploaded: five creates
 *  plus the activation GET/PUT, each bounded by the client's 60 s timeout. Vercel kills the function
 *  past maxDuration with the outcome unrecorded (row `running` for 3 h, key `active` with no ids), so
 *  the last two minutes of the budget refuse copies instead of admitting them. */
const DEADLINE_MARGIN_MS = 120_000;
/** The campaign and ad squad start one minute after the claim, so a slow media upload can never
 *  push start_time into the past by the time the create lands (Snap refuses a past start_time). */
const START_LEAD_MS = 60_000;

export const SNAP_PUMP_STAGES = ["key", "media", "campaign", "adsquad", "creative", "ad", "activate", "live", "paused", "failed"] as const;
export type SnapPumpStage = (typeof SNAP_PUMP_STAGES)[number];

export type SnapPumpShot = {
  taskId: string;
  shot: SnapLaunchShotIn;
  /** What the route resolved and validated once for the whole shot. */
  ctx: { adAccountId: string; pixelId?: string; profileId: string; currency: string; niche: string; geoLabel: string; tail: string; startPaused: boolean };
};

export type SnapPumpDeps = {
  claimKey(desired: string | undefined, meta: Record<string, unknown>): Promise<{ key: string; documentId: string }>;
  releaseKey(documentId: string): Promise<void>;
  backfillKey(key: string, patch: Record<string, unknown>): Promise<void>;
  fetchBytes(url: string): Promise<{ bytes: Uint8Array; mime: string; size: number }>;
  createMedia(adAccountId: string, name: string, type: "VIDEO" | "IMAGE"): Promise<{ id: string }>;
  uploadMedia(mediaId: string, bytes: Uint8Array, filename: string, mime: string): Promise<void>;
  mediaReady(mediaId: string): Promise<boolean>;
  createCampaign(adAccountId: string, body: SnapLaunchWire["campaign"]): Promise<{ id: string }>;
  createAdSquad(campaignId: string, body: SnapLaunchWire["adsquad"] & { campaign_id: string }): Promise<{ id: string }>;
  createCreative(adAccountId: string, body: SnapLaunchWire["creative"]): Promise<{ id: string }>;
  createAd(adSquadId: string, body: SnapLaunchWire["ad"] & { ad_squad_id: string; creative_id: string }): Promise<{ id: string }>;
  setCampaignStatus(campaignId: string, status: "ACTIVE" | "PAUSED"): Promise<void>;
  buildWire(shot: SnapLaunchShotIn, resolved: SnapResolved): { wire: SnapLaunchWire; label: string } | { refusal: string };
  buildName(args: { key: string; niche: string; geoLabel: string; tail: string }): string;
  write(taskId: string, fields: Record<string, unknown>): void;
  flush(): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  maxMediaBytes: number;
  mediaPollMs: number;
  mediaWaitMs: number;
};

/** HTTP 4xx = a deterministic refusal (Snap's sentence); anything else is ambiguous. */
const isRefusal = (e: unknown): boolean => {
  const st = (e as { status?: unknown } | null)?.status;
  return typeof st === "number" && st >= 400 && st < 500;
};
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const jitter = () => 1000 + Math.floor(Math.random() * 2000);
/** Media cache key — the same creative on the same ad account is uploaded once per wave. */
const cacheKeyOf = (s: SnapPumpShot): string => `${s.ctx.adAccountId}|${s.shot.mediaUrl}`;
/** Error/interrupted rows carry a registry failure as a suffix — Snap's sentence stays first. */
const withRegistry = (error: string, registry: string): string => (registry ? `${error} · registry: ${registry}` : error);

export async function runSnapPump(user: string, shots: SnapPumpShot[], deadline: number, deps: SnapPumpDeps): Promise<void> {
  // One upload per (ad account, creative URL) per wave: copies of a card reuse the media id.
  const mediaByKey = new Map<string, string>();

  const ensureMedia = async (s: SnapPumpShot): Promise<string> => {
    const cacheKey = cacheKeyOf(s);
    const hit = mediaByKey.get(cacheKey);
    if (hit) return hit;
    const file = await deps.fetchBytes(s.shot.mediaUrl);
    if (file.size > deps.maxMediaBytes) {
      throw Object.assign(new Error(`creative is ${Math.round(file.size / 1024 / 1024)} MB — Snapchat single upload takes at most 32 MB; trim the file`), { status: 400 });
    }
    const type = s.shot.mediaKind === "image" ? "IMAGE" : "VIDEO";
    const filename = s.shot.mediaName || (type === "IMAGE" ? "creative.jpg" : "creative.mp4");
    const { id } = await deps.createMedia(s.ctx.adAccountId, filename, type);
    await deps.uploadMedia(id, file.bytes, filename, file.mime);
    // Bounded by BOTH the wall clock and an attempt count (a frozen test clock must still end).
    const until = deps.now() + deps.mediaWaitMs;
    const attempts = Math.max(1, Math.ceil(deps.mediaWaitMs / deps.mediaPollMs));
    let ready = await deps.mediaReady(id);
    for (let i = 1; !ready && i < attempts && deps.now() < until; i++) {
      await deps.sleep(deps.mediaPollMs);
      ready = await deps.mediaReady(id);
    }
    if (!ready) throw Object.assign(new Error(`Snap media ${id} not ready after ${Math.round(deps.mediaWaitMs / 1000)} s — fire again`), { status: 400 });
    mediaByKey.set(cacheKey, id);
    return id;
  };

  // Registry writes are best-effort: "" on success, otherwise the failure for the row's text.
  const safeRelease = async (documentId: string): Promise<string> => {
    try {
      await deps.releaseKey(documentId);
      return "";
    } catch (e) {
      return messageOf(e);
    }
  };
  const safeBackfill = async (key: string, patch: Record<string, unknown>): Promise<string> => {
    try {
      await deps.backfillKey(key, patch);
      return "";
    } catch (e) {
      return messageOf(e);
    }
  };

  let first = true;
  try {
    for (const s of shots) {
      // The after() budget is hard (Vercel kills the function past it), so a copy is admitted only
      // when its LONGEST possible run still fits: a fresh upload may wait up to mediaWaitMs for
      // READY on top of the chain itself; a copy whose media is already uploaded needs only the
      // chain (the margin). A refused copy costs nothing — no key claimed, no Snap call.
      const reserve = mediaByKey.has(cacheKeyOf(s)) ? DEADLINE_MARGIN_MS : deps.mediaWaitMs + DEADLINE_MARGIN_MS;
      if (deps.now() > deadline - reserve) {
        deps.write(s.taskId, { status: "error", stage: "failed", error: "Not built — the wave's time budget ran out before this copy; fire it again", finished_at: deps.now() });
        continue;
      }
      if (!first) await deps.sleep(jitter());
      first = false;

      // ---- key ----
      deps.write(s.taskId, { stage: "key", started_at: deps.now() });
      let claimed: { key: string; documentId: string };
      try {
        claimed = await deps.claimKey(s.shot.desiredKey, {
          user,
          ad_account: s.ctx.adAccountId,
          niche: s.ctx.niche,
          landing: s.shot.landingId === "custom" ? s.shot.landingUrl : s.shot.landingId,
          task_id: s.taskId,
        });
      } catch (e) {
        deps.write(s.taskId, { status: "error", stage: "key", error: messageOf(e).slice(0, 1000), finished_at: deps.now() });
        continue;
      }
      const { key, documentId } = claimed;
      /** Nothing exists on Snapchat yet: the key goes back to the pool and the row fails. When the
       *  registry refuses the release, the row keeps the key so the stuck claim stays visible. */
      const releaseAndFail = async (stage: SnapPumpStage, message: string) => {
        const registry = await safeRelease(documentId);
        deps.write(s.taskId, { status: "error", stage, gcm: registry ? key : "", error: withRegistry(message, registry).slice(0, 1000), finished_at: deps.now() });
      };
      let name: string;
      try {
        name = deps.buildName({ key, niche: s.ctx.niche, geoLabel: s.ctx.geoLabel, tail: s.ctx.tail });
      } catch (e) {
        await releaseAndFail("failed", messageOf(e));
        continue;
      }
      deps.write(s.taskId, { gcm: key, name: name.slice(0, 250) });

      // ---- media (nothing with money exists yet: any failure hands the key back) ----
      deps.write(s.taskId, { stage: "media" });
      let mediaId: string;
      try {
        mediaId = await ensureMedia(s);
      } catch (e) {
        await releaseAndFail("media", messageOf(e));
        continue;
      }

      // ---- the real wire (claimed key + real media id). A THROW here is a programming error and
      //      is handled exactly like a returned refusal — one bad shot never aborts the wave. ----
      let built: { wire: SnapLaunchWire; label: string } | { refusal: string };
      try {
        built = deps.buildWire(s.shot, {
          adAccountId: s.ctx.adAccountId,
          pixelId: s.ctx.pixelId,
          profileId: s.ctx.profileId,
          name,
          key,
          mediaId,
          startTimeIso: new Date(deps.now() + START_LEAD_MS).toISOString(),
        });
      } catch (e) {
        built = { refusal: messageOf(e) };
      }
      if ("refusal" in built) {
        await releaseAndFail("failed", built.refusal);
        continue;
      }
      const wire = built.wire;

      // ---- campaign (born PAUSED — a partial chain can never spend) ----
      deps.write(s.taskId, { stage: "campaign", link: wire.landingUrl });
      let campaignId = "";
      try {
        campaignId = (await deps.createCampaign(s.ctx.adAccountId, wire.campaign)).id;
      } catch (e) {
        if (isRefusal(e)) {
          await releaseAndFail("campaign", messageOf(e));
        } else {
          const registry = await safeBackfill(key, { status: "retired", notes: `ambiguous campaign create: ${messageOf(e).slice(0, 200)}` });
          deps.write(s.taskId, {
            status: "interrupted",
            stage: "campaign",
            error: withRegistry(`Ambiguous outcome (${messageOf(e)}) — the campaign may exist on Snapchat; check Ads Manager before re-firing`, registry).slice(0, 1000),
            finished_at: deps.now(),
          });
        }
        continue;
      }
      deps.write(s.taskId, { campaign_id: campaignId });

      // ---- adsquad → creative → ad (the campaign exists: a failure retires the key, shell stays PAUSED) ----
      const ids: { adsquad_id?: string; ad_id?: string } = {};
      const failAfterCampaign = async (stage: SnapPumpStage, e: unknown) => {
        const ambiguous = !isRefusal(e);
        const registry = await safeBackfill(key, { status: "retired", campaign_id: campaignId, ...ids, notes: `${ambiguous ? "ambiguous" : "refused"} at ${stage}: ${messageOf(e).slice(0, 200)}` });
        deps.write(s.taskId, {
          status: ambiguous ? "interrupted" : "error",
          stage,
          error: withRegistry(ambiguous ? `Ambiguous outcome (${messageOf(e)}) — the ${stage} may exist on Snapchat; the campaign is PAUSED, check Ads Manager` : messageOf(e), registry).slice(0, 1000),
          finished_at: deps.now(),
        });
      };
      let adSquadId = "";
      let creativeId = "";
      let adId = "";
      try {
        deps.write(s.taskId, { stage: "adsquad" });
        adSquadId = (await deps.createAdSquad(campaignId, { ...wire.adsquad, campaign_id: campaignId })).id;
        ids.adsquad_id = adSquadId;
        deps.write(s.taskId, { adset_id: adSquadId });
      } catch (e) {
        await failAfterCampaign("adsquad", e);
        continue;
      }
      try {
        deps.write(s.taskId, { stage: "creative" });
        creativeId = (await deps.createCreative(s.ctx.adAccountId, wire.creative)).id;
      } catch (e) {
        await failAfterCampaign("creative", e);
        continue;
      }
      try {
        deps.write(s.taskId, { stage: "ad" });
        adId = (await deps.createAd(adSquadId, { ...wire.ad, ad_squad_id: adSquadId, creative_id: creativeId })).id;
        ids.ad_id = adId;
        deps.write(s.taskId, { ad_id: adId });
      } catch (e) {
        await failAfterCampaign("ad", e);
        continue;
      }

      // ---- activate (unless the buyer wants to review first) ----
      let activationError = "";
      if (!s.ctx.startPaused) {
        deps.write(s.taskId, { stage: "activate" });
        try {
          await deps.setCampaignStatus(campaignId, "ACTIVE");
        } catch (e) {
          activationError = `activation failed: ${messageOf(e).slice(0, 300)} — activate in Ads Manager`;
        }
      }

      // ---- done (the chain exists whatever the registry says: the row always lands here) ----
      const registry = await safeBackfill(key, { status: "active", campaign_id: campaignId, adsquad_id: adSquadId, ad_id: adId, name });
      const registryError = registry ? `registry backfill failed: ${registry} — check the Keys page` : "";
      const live = !s.ctx.startPaused && !activationError;
      deps.write(s.taskId, {
        status: "done",
        stage: live ? "live" : "paused",
        campaign_id: campaignId,
        adset_id: adSquadId,
        ad_id: adId,
        link: wire.landingUrl,
        gcm: key,
        name: name.slice(0, 250),
        error: [activationError, registryError].filter(Boolean).join(" · ").slice(0, 1000),
        finished_at: deps.now(),
      });
    }
  } finally {
    // The rows written so far reach the store even if a shot threw something the stages did not anticipate.
    await deps.flush();
  }
}
