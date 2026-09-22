// Snapchat rail — the after() wave pump ALGORITHM with every side effect injected (lib/snap-pump.ts
// binds the real Snapchat client, the key registry and the task-store writer). Kept pure so
// `node --test tests/snap-pump-core.test.ts` proves the dispositions without a network:
//   key → media → campaign (PAUSED) → adsquad → (creative → ad) × every creative → activate → done
// A card carries ANY number of creatives: they all land in the campaign's ONE ad squad, on its ONE
// key. One bad creative never sinks the campaign — a failed upload or a creative Snapchat refuses is
// skipped and named on the row; the campaign fails only when NOTHING could be built. The ads loop
// never outruns the budget (the deadline margin stops it with or without an ad built), stops on a
// refusal that is about the account rather than the file (401 / 403 / 429) and after a run of
// refusals with nothing built, and writes the store a constant number of times however long the list.
// A refusal (HTTP 4xx) before the campaign exists releases the key (pool capacity, not history);
// after it exists the key is RETIRED with the ids so far and the campaign stays a PAUSED shell
// (nothing delivers). An ambiguous outcome (5xx / network) is reported as "interrupted" and NEVER
// re-sent — a second attempt could build a second campaign. Activation failure is not a failed
// launch: the whole chain exists, the buyer flips it in Ads Manager.
// The key registry is best-effort bookkeeping: a release/backfill that throws never aborts the
// wave and never leaves a row without a terminal status — the failure is folded into the row's
// text (a stuck row invites a re-fire that would build a second campaign).

import type { SnapAdWire, SnapCreativeWire, SnapLaunchShotIn, SnapLaunchWire, SnapResolved, SnapShotMedia } from "./snap-launch";

export const SNAP_PUMP_BUDGET_MS = 770_000;
/** The tail a copy admitted at the deadline may still need once its media is uploaded: five creates
 *  plus the activation GET/PUT, each bounded by the client's 60 s timeout. Vercel kills the function
 *  past maxDuration with the outcome unrecorded (row `running` for 3 h, key `active` with no ids), so
 *  the last two minutes of the budget refuse copies instead of admitting them. */
const DEADLINE_MARGIN_MS = 120_000;
/** The campaign and ad squad start one minute after the claim, so a slow media upload can never
 *  push start_time into the past by the time the create lands (Snap refuses a past start_time). */
const START_LEAD_MS = 60_000;
/** Creatives of one shot uploaded to Snapchat at a time: a video's READY wait is mostly idle, so a
 *  long list costs a third of the wall clock, while at most three ≤32 MB files sit in memory. */
const MEDIA_CONCURRENCY = 3;
/** Skipped-creative notes written out in full on a row; the rest are counted ("+N more"). */
const MAX_CREATIVE_NOTES = 3;
/** Snap's sentence inside one note — clamped so a row's 1000 characters hold every note. */
const NOTE_MAX = 140;
/** With NO ad built yet, this many refusals in a row mean a shared cause (headline, profile,
 *  account) — the loop stops instead of walking a long list into the same wall. */
const MAX_LEADING_REFUSALS = 5;

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
  createCreative(adAccountId: string, body: SnapCreativeWire): Promise<{ id: string }>;
  createAd(adSquadId: string, body: SnapAdWire & { ad_squad_id: string; creative_id: string }): Promise<{ id: string }>;
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
/** Refusals about the ACCOUNT or the TOKEN, not about one creative: the next unit would be refused
 *  the same way (and a 429 storm only deepens), so they end the ads loop instead of skipping a file. */
const isAccountLevel = (e: unknown): boolean => {
  const st = (e as { status?: unknown } | null)?.status;
  return st === 401 || st === 403 || st === 429;
};
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const clamp = (text: string): string => (text.length > NOTE_MAX ? `${text.slice(0, NOTE_MAX - 1)}…` : text);
const jitter = () => 1000 + Math.floor(Math.random() * 2000);
/** Media cache key — the same creative on the same ad account is uploaded once per wave. */
const cacheKeyOf = (adAccountId: string, m: SnapShotMedia): string => `${adAccountId}|${m.url}`;
/** How a row names one creative of the card: "#2 (clip.mp4)". */
const creativeTag = (media: SnapShotMedia[], index: number): string => `#${index + 1}${media[index]?.name ? ` (${media[index].name})` : ""}`;
/** Error/interrupted rows carry a registry failure as a suffix — Snap's sentence stays first. */
const withRegistry = (error: string, registry: string): string => (registry ? `${error} · registry: ${registry}` : error);

export async function runSnapPump(user: string, shots: SnapPumpShot[], deadline: number, deps: SnapPumpDeps): Promise<void> {
  // One upload per (ad account, creative URL) per wave: copies of a card reuse the media id.
  const mediaByKey = new Map<string, string>();
  // Uploads run MEDIA_CONCURRENCY at a time, so the same file listed twice on a card must share the
  // upload in flight instead of racing a second one. A REFUSED upload (4xx-class: unsupported file,
  // over the cap, never READY) is remembered for the rest of the wave — every copy would pay the same
  // download, upload and READY wait for the same answer; a network failure is not (a later copy retries).
  const mediaInFlight = new Map<string, Promise<string>>();
  const mediaRefused = new Map<string, unknown>();

  const uploadMedia = async (adAccountId: string, m: SnapShotMedia): Promise<string> => {
    const file = await deps.fetchBytes(m.url);
    if (file.size > deps.maxMediaBytes) {
      throw Object.assign(new Error(`creative is ${Math.round(file.size / 1024 / 1024)} MB — Snapchat single upload takes at most 32 MB; trim the file`), { status: 400 });
    }
    const type = m.kind === "image" ? "IMAGE" : "VIDEO";
    const filename = m.name || (type === "IMAGE" ? "creative.jpg" : "creative.mp4");
    const { id } = await deps.createMedia(adAccountId, filename, type);
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
    return id;
  };

  const ensureMedia = (adAccountId: string, m: SnapShotMedia): Promise<string> => {
    const cacheKey = cacheKeyOf(adAccountId, m);
    const hit = mediaByKey.get(cacheKey);
    if (hit) return Promise.resolve(hit);
    if (mediaRefused.has(cacheKey)) return Promise.reject(mediaRefused.get(cacheKey));
    const running = mediaInFlight.get(cacheKey);
    if (running) return running;
    const p = uploadMedia(adAccountId, m)
      .then(
        (id) => {
          mediaByKey.set(cacheKey, id);
          return id;
        },
        (e: unknown) => {
          if (isRefusal(e)) mediaRefused.set(cacheKey, e);
          throw e;
        },
      )
      .finally(() => mediaInFlight.delete(cacheKey));
    mediaInFlight.set(cacheKey, p);
    return p;
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
      // READY on top of the chain itself; a copy whose media is ALL already settled (uploaded, or
      // refused earlier in the wave) needs only the chain (the margin). A refused copy costs nothing —
      // no key claimed, no Snap call.
      const media = Array.isArray(s.shot.media) ? s.shot.media : [];
      const isCached = (m: SnapShotMedia) => mediaByKey.has(cacheKeyOf(s.ctx.adAccountId, m)) || mediaRefused.has(cacheKeyOf(s.ctx.adAccountId, m));
      const reserve = media.every(isCached) ? DEADLINE_MARGIN_MS : deps.mediaWaitMs + DEADLINE_MARGIN_MS;
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
          landing: s.shot.landingUrl,
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
      //      Creatives upload MEDIA_CONCURRENCY at a time. A file that fails is SKIPPED and named on
      //      the row — the campaign is built from the rest; only when none uploaded does the shot fail.
      //      A later batch starts only while a fresh upload's longest wait still fits the budget.
      deps.write(s.taskId, { stage: "media" });
      const mediaIds: string[] = media.map(() => "");
      const mediaErrors: { index: number; message: string }[] = [];
      let unsentFrom = -1;
      for (let b = 0; b < media.length; b += MEDIA_CONCURRENCY) {
        const batch = media.slice(b, b + MEDIA_CONCURRENCY);
        if (b > 0 && !batch.every(isCached) && deps.now() > deadline - (deps.mediaWaitMs + DEADLINE_MARGIN_MS)) {
          unsentFrom = b;
          break;
        }
        await Promise.all(
          batch.map(async (m, j) => {
            try {
              mediaIds[b + j] = await ensureMedia(s.ctx.adAccountId, m);
            } catch (e) {
              mediaErrors.push({ index: b + j, message: messageOf(e) });
            }
          }),
        );
      }
      mediaErrors.sort((x, y) => x.index - y.index);
      if (!mediaIds.some(Boolean)) {
        const first = mediaErrors[0];
        const why = first?.message ?? "the shot carries no creative — re-attach the files and fire again";
        const text =
          !first || media.length <= 1
            ? why
            : unsentFrom >= 0
              ? `the first ${unsentFrom} creatives failed and the wave's time budget ran out before the rest — ${creativeTag(media, first.index)}: ${why}`
              : `all ${media.length} creatives failed — ${creativeTag(media, first.index)}: ${why}`;
        await releaseAndFail("media", text);
        continue;
      }
      // What the done row says about creatives that did not make it (the campaign still runs):
      // `urgent` is what the buyer must act on (an ambiguous outcome, a list cut short) and rides
      // first; `skipped` names the files that were left out. Snap's sentences are clamped so the
      // row's 1000 characters hold every note.
      const urgent: string[] = [];
      const skipped: string[] = mediaErrors.slice(0, MAX_CREATIVE_NOTES).map((x) => `creative ${creativeTag(media, x.index)} skipped: ${clamp(x.message)}`);
      if (mediaErrors.length > MAX_CREATIVE_NOTES) skipped.push(`+${mediaErrors.length - MAX_CREATIVE_NOTES} more creatives skipped at the upload`);
      if (unsentFrom >= 0) {
        const range = unsentFrom === media.length - 1 ? `creative #${media.length}` : `creatives #${unsentFrom + 1}–#${media.length}`;
        urgent.push(`${range} not uploaded — the wave's time budget ran out; add them in Ads Manager`);
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
          mediaIds,
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

      // ---- adsquad → (creative → ad) × N (the campaign exists: a failure that leaves it with NO ad
      //      retires the key, shell stays PAUSED) ----
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
      try {
        deps.write(s.taskId, { stage: "adsquad" });
        adSquadId = (await deps.createAdSquad(campaignId, { ...wire.adsquad, campaign_id: campaignId })).id;
        ids.adsquad_id = adSquadId;
        deps.write(s.taskId, { adset_id: adSquadId });
      } catch (e) {
        await failAfterCampaign("adsquad", e);
        continue;
      }
      // One creative + ad per uploaded file. A REFUSED unit (4xx — this file, this creative) is
      // skipped and the next one is tried; a refusal about the account/token (401 / 403 / 429) or a
      // run of MAX_LEADING_REFUSALS with nothing built ends the loop. An AMBIGUOUS outcome is never
      // re-sent and ends the loop (the network is the likely cause): with an ad already built the
      // campaign still goes live and the row says what to check; with none it is the interrupted
      // shell it always was. Past the deadline margin no further unit is started, ads or no ads —
      // the function must never be killed mid-loop with the row still `running`. The stage is
      // written for the FIRST unit only: two store writes per unit would queue the terminal row
      // behind a chain as long as the list.
      const adIds: string[] = [];
      const unitNotes: string[] = [];
      let refusedUnits = 0;
      let firstFailure: { stage: "creative" | "ad"; e: unknown; index: number } | null = null;
      let shellFailed = false;
      /** Why the loop ended early with NO ad built (folded into the zero-ad row). */
      let cutShort = "";
      for (let k = 0; k < wire.ads.length; k++) {
        const unit = wire.ads[k];
        const left = wire.ads.length - k;
        if (k > 0 && deps.now() > deadline - DEADLINE_MARGIN_MS) {
          if (adIds.length > 0) urgent.push(`${left} creative${left === 1 ? "" : "s"} not built — the wave's time budget ran out; add ${left === 1 ? "it" : "them"} in Ads Manager`);
          else cutShort = "the wave's time budget ran out";
          break;
        }
        let stage: "creative" | "ad" = "creative";
        try {
          if (k === 0) deps.write(s.taskId, { stage: "creative" });
          const creativeId = (await deps.createCreative(s.ctx.adAccountId, unit.creative)).id;
          stage = "ad";
          if (k === 0) deps.write(s.taskId, { stage: "ad" });
          const adId = (await deps.createAd(adSquadId, { ...unit.ad, ad_squad_id: adSquadId, creative_id: creativeId })).id;
          adIds.push(adId);
          if (adIds.length === 1) {
            ids.ad_id = adId;
            deps.write(s.taskId, { ad_id: adId });
          }
        } catch (e) {
          firstFailure ??= { stage, e, index: unit.index };
          if (isRefusal(e) && !isAccountLevel(e)) {
            refusedUnits += 1;
            if (refusedUnits <= MAX_CREATIVE_NOTES) unitNotes.push(`creative ${creativeTag(media, unit.index)} refused at the ${stage}: ${clamp(messageOf(e))}`);
            if (adIds.length === 0 && refusedUnits >= MAX_LEADING_REFUSALS && left > 1) {
              cutShort = `stopped after ${refusedUnits} refusals in a row`;
              break;
            }
            continue;
          }
          if (adIds.length === 0) {
            await failAfterCampaign(stage, e);
            shellFailed = true;
          } else {
            const rest = left - 1;
            const notSent = rest > 0 ? `; ${rest} more not sent` : "";
            urgent.push(
              isRefusal(e)
                ? `creative ${creativeTag(media, unit.index)}: Snapchat answered HTTP ${(e as { status: number }).status} (${clamp(messageOf(e))}) at the ${stage} — an account-level refusal${notSent}; add them in Ads Manager`
                : `creative ${creativeTag(media, unit.index)}: ambiguous outcome (${clamp(messageOf(e))}) at the ${stage} — it may exist on Snapchat, check Ads Manager${notSent}`,
            );
          }
          break;
        }
      }
      if (shellFailed) continue;
      if (adIds.length === 0) {
        // Nothing can deliver: every unit tried was refused. The first refusal is the row's sentence.
        if (!firstFailure) {
          await failAfterCampaign("creative", Object.assign(new Error("no creative unit was built for this shot"), { status: 400 }));
          continue;
        }
        const f: { stage: "creative" | "ad"; e: unknown; index: number } = firstFailure;
        const first = `${creativeTag(media, f.index)}: ${messageOf(f.e)}`;
        const text = cutShort ? `${refusedUnits} of ${wire.ads.length} creatives were refused and ${cutShort} — ${first}` : wire.ads.length > 1 ? `all ${wire.ads.length} creatives were refused — ${first}` : "";
        await failAfterCampaign(f.stage, text ? Object.assign(new Error(text), { status: 400 }) : f.e);
        continue;
      }
      if (refusedUnits > MAX_CREATIVE_NOTES) unitNotes.push(`+${refusedUnits - MAX_CREATIVE_NOTES} more creatives refused`);
      skipped.push(...unitNotes);
      const adId = adIds[0];

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
      const registry = await safeBackfill(key, { status: "active", campaign_id: campaignId, adsquad_id: adSquadId, ad_id: adId, ad_count: adIds.length, name });
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
        error: [activationError, registryError, ...urgent, ...skipped].filter(Boolean).join(" · ").slice(0, 1000),
        finished_at: deps.now(),
      });
    }
  } finally {
    // The rows written so far reach the store even if a shot threw something the stages did not anticipate.
    await deps.flush();
  }
}
