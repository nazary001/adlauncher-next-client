import { NextResponse } from "next/server";
import type { Campaign } from "@/lib/types";
import { conversionEventsFor } from "@/lib/catalog";
import {
  hsCampaignError,
  hsCountryCodes,
  hsFinalLink,
  hsFullName,
  todaySaoPauloDDMM,
} from "@/lib/hs-launch";
import {
  type LaunchBinds,
  adPayload,
  adsetPayload,
  campaignPayload,
  creativePayload,
  imageCreativePayload,
} from "@/lib/fb-launch";
import { FbError, withFbBudget, withParentRetry } from "@/lib/fb-graph";
import { fetchValidatedImage } from "@/lib/fb-media";
import {
  type HsTokenCreative,
  hsCreateAdset,
  hsFbPost,
  hsTokenAccountIds,
  hsTokenConfigured,
  hsTokenStartTime,
  hsUploadImage,
  hsUploadVideo,
  hsVideoThumb,
  hsWaitForVideo,
  parseTokenCreatives,
} from "@/lib/hs-token-launch";
import { LION_ACR, LionError, lionAccountPixels, lionConfigured, lionProfileData } from "@/lib/lion";
import { reportPagesUsed } from "@/lib/hs-pages";
import { sessionFromCookieHeader } from "@/lib/session";
import { taskWriter } from "@/lib/task-store";
import { acctKey, claimAcctSlot, releaseAcctSlot } from "@/lib/acct-limit";

export const runtime = "nodejs";
export const maxDuration = 300;

type Json = Record<string, unknown>;

// Same per-launch FB retry budget as the MO route: rate-limited calls wait out Meta's regain
// estimate but never past the deadline — the hard failure must land INSIDE the function so the
// error path (task row settle) always runs.
const FB_BUDGET_MS = 240_000;
const FB_BUDGET_RETRIES = 8;
// Videos register + process in a small pool — sequential waits on a multi-video card would blow
// the function window, and a wider pool is exactly the burst that trips the ads rate limit.
const VIDEO_POOL = 3;

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

/**
 * HS launch over the FB TOKEN rail: the exact campaign the LION create weapon would build —
 * same LION-validated name, same binds (validated against LION's own profile catalog so the
 * partner's ingestion sees the campaign), same link tail — but the campaign→adset→creatives→ads
 * tree is created directly on the Graph API with our partner-side token, no LION task involved.
 * The one deliberate difference: the ad set carries start_time = now + 30 min (partner rule —
 * their routines need the gap to add the campaign id to the reportable keys before delivery).
 * Streams NDJSON stage events (the HS Task Manager shows live progress) and mirrors them into
 * the shared HS task row so the whole team sees the launch even if this browser dies mid-run.
 */
export async function POST(req: Request): Promise<Response> {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return bad("unauthorized", 401);
  if (!hsTokenConfigured()) {
    return bad("hs_fb_token_missing — set FB_HS_LAUNCH_TOKEN (or FB_HS_VOLUME_TOKEN) in the environment", 500);
  }
  // Binds are validated against LION's catalog BY DESIGN (owner decision 08-17: keep the tie —
  // token launches may only go where LION profiles are bound): an account no weapon profile sees
  // would be invisible to the partner's ingestion (their rule #2). Consequence, accepted: with
  // LION down the token rail refuses to launch rather than fire an unverifiable bind.
  if (!lionConfigured()) return bad("lion_not_configured", 500);

  let body: { campaign?: Campaign; creatives?: unknown; taskId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return bad("bad_json");
  }
  const taskId = typeof body.taskId === "string" && /^[\w-]{6,64}$/.test(body.taskId) ? body.taskId : null;
  const c = body.campaign;
  if (!c || typeof c !== "object") return bad("campaign_required");
  const parsed = parseTokenCreatives(body.creatives);
  if ("error" in parsed) return bad(parsed.error);
  const creatives: HsTokenCreative[] = parsed.creatives;

  const invalid = hsCampaignError(c, creatives.map((x) => x.url));
  if (invalid) return bad(invalid);
  // MO-route parity: an event invalid for the objective dies at the ad-set step AFTER the
  // campaign exists (orphan shell) — reject before any write instead.
  if (!conversionEventsFor(c.objective).some((e) => e.value === c.conversionEvent)) {
    return bad("event_invalid — conversion event is not valid for the objective");
  }
  if (!c.profile) return bad("profile_required");
  if (!c.account) return bad("account_required");
  if (!c.page) return bad("page_required");
  if (!c.pixel) return bad("pixel_required");

  // ---- bind validation against LION's own data (cached 10 min) — identical to the LION rail:
  // the campaign must land where a weapon-connected profile can see it. ----
  let data;
  try {
    data = await lionProfileData(c.profile);
  } catch (e) {
    const lionSide = e instanceof LionError && (e.status === undefined || e.status < 500);
    return bad(lionSide ? "profile_invalid" : `lion_unreachable: ${(e as Error).message}`, lionSide ? 400 : 502);
  }
  const account = data.accounts.find((a) => a.id === c.account);
  if (!account) return bad("account_not_on_profile");
  if (account.status !== 1) return bad("account_disabled");
  const page = data.pages.find((p) => p.id === c.page);
  if (!page) return bad("page_not_on_profile");
  let pixels;
  try {
    pixels = await lionAccountPixels(c.profile, c.account);
  } catch (e) {
    return bad(`lion_unreachable: ${(e as Error).message}`, 502);
  }
  if (!pixels.some((p) => p.id === c.pixel)) return bad("pixel_not_on_account");

  // LION binds cover segments our token was never granted (aleph, 08-19) — there the first Graph
  // POST dies with an unexplained "Unsupported post request". Refuse those up front; a failed
  // sweep (null) falls OPEN so a Graph blip can't block launches into provably-fine accounts.
  {
    const visible = await hsTokenAccountIds();
    if (visible && !visible.has(c.account.replace(/^act_/, ""))) {
      return bad(
        "account_not_visible_to_fb_token — our FB token was never granted this ad account; launch it on the LION API rail (or pick a token-visible account)",
      );
    }
  }

  const binds: LaunchBinds = {
    accountId: c.account.replace(/^act_/, ""),
    pageId: c.page,
    // The page's display name feeds the ad set's DSA beneficiary/payor declaration — WORLD-
    // targeted HS launches always reach the EU, and Meta rejects those without it ("Advertiser
    // not specified") unless the account carries a default beneficiary.
    pageName: page.name,
    pixelId: c.pixel,
  };

  // Locales: the card stores the profile's FB locale ids as strings; unknown ids (profile
  // switched under the card) are dropped, same as the LION rail's payload builder.
  const knownLocales = new Set(data.locales.map((l) => String(l.id)));
  const localeIds = [
    ...new Set(
      c.locales
        .filter((id) => knownLocales.has(id))
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  ];

  // Image creatives + custom video COVERS: fetch + validate BEFORE the stream — an oversized
  // image must die here as a clean 400, not mid-run at adimages. Video URLs themselves are never
  // fetched by us (Meta pulls them); a cover is an image and gets the image treatment.
  const imageBufs = new Map<number, Buffer>();
  const coverBufs = new Map<number, Buffer>();
  for (let i = 0; i < creatives.length; i++) {
    try {
      if (creatives[i].kind === "image") imageBufs.set(i, await fetchValidatedImage(creatives[i].url));
      const cover = creatives[i].cover;
      if (cover) coverBufs.set(i, await fetchValidatedImage(cover));
    } catch (e) {
      return bad(`creative ${i + 1}: ${(e as FbError).message ?? String(e)}`);
    }
  }

  // Server-authoritative name/link — same pure builders the card preview and the LION rail use.
  const name = hsFullName(c, LION_ACR, todaySaoPauloDDMM());
  const link = hsFinalLink(c.link, c.pixel, LION_ACR, c);
  const geo = hsCountryCodes(c.countries).join(", ");
  const startTime = hsTokenStartTime();

  const encoder = new TextEncoder();
  const stream = withFbBudget({ deadlineAt: Date.now() + FB_BUDGET_MS, retries: FB_BUDGET_RETRIES }, () =>
    new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (o: Json) => controller.enqueue(encoder.encode(JSON.stringify(o) + "\n"));
        // Mirror progress into the shared HS task row. Statics (name/geo/budget + partner/kind)
        // ride in EVERY write so a save racing an admin row-deletion never resurrects a nameless
        // stub (same rule as the client saver). gcm column = kind → "token". started_at rides
        // too: without it a launch whose browser died mid-run lands "done" with no elapsed time
        // (the client's own saves also carry its upload-start stamp — either value is truthful).
        const tw = taskWriter(session.username, taskId);
        const statics: Json = { partner: "br", gcm: "token", name, geo, budget: c.budget, started_at: Date.now() };
        let lastStage = "submit";
        let settled = false;
        const progress = (stage: string) => {
          lastStage = stage;
          send({ stage });
          tw.write({ ...statics, status: "running", stage });
        };
        // Server-side liveness beat — stage writes alone can gap for minutes on video processing.
        const beat = setInterval(() => {
          if (!settled) tw.write({ ...statics, status: "running", stage: lastStage });
        }, 30_000);
        const created: Json = {};
        const adIds: string[] = [];
        let acctSlot: { documentId: string } | null = null;
        try {
          // 0) account launch slot (5 campaigns / 30 min per ad account, every channel — owner
          // rule 2026-08-18) — claimed before any FB work; released below on any pre-campaign
          // failure (media registration included: no campaign exists yet).
          progress("submit");
          acctSlot = await claimAcctSlot(acctKey(binds.accountId), {
            user: session.username,
            partner: "br",
            channel: "hs-token",
            name,
            accountName: account.name || "",
          });

          // 1) register every creative first (a media failure must not orphan a campaign shell).
          // "submit" is the client's wire stage for this phase — its bar maps it to "on Facebook".
          type Media =
            | { kind: "video"; videoId: string; thumbUrl: string; coverHash?: string }
            | { kind: "image"; imageHash: string };
          const media: Media[] = new Array(creatives.length);
          {
            let next = 0;
            const worker = async () => {
              for (;;) {
                const i = next++;
                if (i >= creatives.length) return;
                const cr = creatives[i];
                if (cr.kind === "image") {
                  media[i] = { kind: "image", imageHash: await hsUploadImage(binds.accountId, imageBufs.get(i) as Buffer) };
                } else {
                  const videoId = await hsUploadVideo(binds.accountId, cr.url, `${name} · video ${i + 1}`);
                  await hsWaitForVideo(videoId);
                  // A custom cover replaces the auto-thumbnail entirely: upload it into the
                  // account's image library and pin its hash (no thumbnail poll needed).
                  const coverBuf = coverBufs.get(i);
                  media[i] = coverBuf
                    ? {
                        kind: "video",
                        videoId,
                        thumbUrl: "",
                        coverHash: await hsUploadImage(binds.accountId, coverBuf),
                      }
                    : { kind: "video", videoId, thumbUrl: await hsVideoThumb(videoId) };
                }
              }
            };
            await Promise.all(Array.from({ length: Math.min(VIDEO_POOL, creatives.length) }, worker));
          }

          // 2) campaign → adset (start_time = +30 min, partner rule) → one creative+ad per media.
          progress("campaign");
          const camp = await hsFbPost(`act_${binds.accountId}/campaigns`, campaignPayload(c, name));
          created.campaign_id = String(camp.id);

          progress("adset");
          const adset = await withParentRetry(String(camp.id), () =>
            hsCreateAdset(`act_${binds.accountId}/adsets`, {
              ...adsetPayload(c, name, String(camp.id), binds, localeIds),
              start_time: startTime,
            }),
          );
          created.adset_id = String(adset.id);

          progress("ads");
          for (let i = 0; i < creatives.length; i++) {
            const m = media[i];
            const adName = creatives.length > 1 ? `${name} · ${i + 1}` : name;
            const creative = await hsFbPost(
              `act_${binds.accountId}/adcreatives`,
              m.kind === "image"
                ? imageCreativePayload(c, adName, binds, { imageHash: m.imageHash, link })
                : creativePayload(c, adName, binds, {
                    videoId: m.videoId,
                    thumbUrl: m.thumbUrl,
                    link,
                    coverHash: m.coverHash,
                  }),
            );
            const ad = await withParentRetry(String(adset.id), () =>
              hsFbPost(`act_${binds.accountId}/ads`, adPayload(adName, String(adset.id), String(creative.id))),
            );
            if (!ad.id) throw new FbError("ad create returned no id", ad);
            adIds.push(String(ad.id));
            send({ stage: "ads", done: adIds.length, total: creatives.length });
            // ad_id is a STRING column (it holds the ad id on the MO rail); the HS convention
            // rides the ad COUNT in it — but it must go over the wire as a string, or Strapi
            // 400s the whole write and the row wedges at "running" (live 08-17, 4/4 launches).
            tw.write({ ...statics, status: "running", stage: "ads", ad_id: String(adIds.length) });
          }

          settled = true;
          tw.write({
            ...statics,
            status: "done",
            stage: "ads",
            finished_at: Date.now(),
            campaign_id: created.campaign_id,
            adset_id: created.adset_id,
            ad_id: String(adIds.length),
            error: null,
          });
          send({
            ok: true,
            stage: "done",
            name,
            link,
            start_time: startTime,
            currency: account.currency || "USD",
            ad_ids: adIds,
            ...created,
          });
        } catch (e) {
          const err = e as FbError;
          // Free the account's launch slot when NO campaign was created — the window meters only
          // campaigns that exist. Once one exists the slot stays consumed.
          if (acctSlot && !created.campaign_id) await releaseAcctSlot(acctSlot.documentId);
          // Partial trees stay traceable: the ids that DID land ride in the row and the error
          // event, and the client blocks a retry once a campaign exists (a re-fire would build a
          // second one — the buyer settles the partial in Ads Manager instead).
          const partial = adIds.length ? ` (created ${adIds.length}/${creatives.length} ads)` : "";
          settled = true;
          tw.write({
            ...statics,
            status: "error",
            stage: lastStage,
            finished_at: Date.now(),
            error: `${err.message ?? String(e)}${partial}`,
            ...(created.campaign_id ? { campaign_id: created.campaign_id } : {}),
            ...(created.adset_id ? { adset_id: created.adset_id } : {}),
            ...(adIds.length ? { ad_id: String(adIds.length) } : {}),
          });
          send({
            ok: false,
            stage: "error",
            error: `${err.message ?? String(e)}${partial}`,
            detail: err.detail ?? null,
            created: { ...created, ad_ids: adIds },
          });
        } finally {
          clearInterval(beat);
          // Registry ledger: every ad that DID land occupies a slot on the fanka — partial trees
          // included (fire-safe; the box's next Facebook sweep reconciles either way).
          if (adIds.length) await reportPagesUsed("br", [{ pageId: binds.pageId, delta: adIds.length }]);
          // No Blob cleanup here on purpose: the HS rail keeps creatives in Blob either way (the
          // LION rail leaves them for the weapon to fetch), and a retry re-uses the same URLs.
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
