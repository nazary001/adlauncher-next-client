import { NextResponse } from "next/server";
import { type Campaign, bidAmountMissing, bidKind, bidTag, withPartnerMark } from "@/lib/types";
import { AV_OBJECTIVE, type PartnerId, fullLandingUrl, partnerConfig } from "@/lib/partners";
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
import { type AvRail, avKeysRegistered, avRail, avRailEnabled } from "@/lib/av-launch";
import { backfillAvKey, claimAvKey, releaseAvKey } from "@/lib/av-keys";
import { resolveAvDestination } from "@/lib/av-destination";
import { claimAcctSlot, releaseAcctSlot } from "@/lib/acct-limit";
import { ACCOUNT_NOT_ASSIGNED_MSG, accountAllowedFor } from "@/lib/acct-assignments";
import { taskWriter } from "@/lib/task-store";
import { del } from "@vercel/blob";

export const runtime = "nodejs";
export const maxDuration = 300;

type Json = Record<string, unknown>;

// Same per-launch FB retry budget as the MO/AIF routes: rate-limited calls wait out Meta's regain
// estimate but never past the deadline — the hard failure must land INSIDE the function so the
// error path (key release/retire, task row settle) always runs.
const FB_BUDGET_MS = 240_000;
const FB_BUDGET_RETRIES = 8;

// ---------- locale resolution (best-effort, non-fatal) — the AV-token twin of /api/aif/launch's ----------

const localeCache = new Map<string, number | null>();
async function resolveLocales(names: string[], rail: AvRail): Promise<number[]> {
  const ids: number[] = [];
  for (const raw of names) {
    if (/\(all\)/i.test(raw)) continue; // "all" = no language restriction (broadest)
    if (!localeCache.has(raw)) {
      try {
        const body = await rail.fbGet(`search?type=adlocale&limit=25&q=${encodeURIComponent(raw.replace(/[()]/g, " ").trim())}`);
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

/**
 * POST /api/av/launch — the AV (ActiveView) launch rail. Mirrors /api/aif/launch stage for stage
 * (same NDJSON events, same Task Manager pipeline, up to 5 creatives per campaign — one campaign →
 * one ad set → one ad per creative, 09-02), with the rail's own pieces: the tree is built on AV's
 * OWN token (slot av.launch, no env seed), the marker is an AV KEY from the registered pool
 * (lib/av-keys — av001…), and the ad link is the campaign's AV DESTINATION (an article of an AV
 * site or a Redirect path, lib/av-destination) with the key in utm_campaign (lib/av-link). The AV
 * page carries no Meta pixel: delivery is Traffic / link clicks only — conversions and min-ROAS are
 * refused server-side (nothing to optimize on), so no pixel is ever bound and the link carries no
 * &pixel=/&fire= tail. Every gate runs BEFORE any claim, and the destination is RE-RESOLVED here
 * (host must be an AV site / redirect domain, article live, redirect path present + domain live) so
 * a stale draft can never point a live ad at a dead page.
 */
export async function POST(req: Request) {
  // Proxy-gated, but self-checks the session too (parity with /api/aif/launch).
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) {
    return NextResponse.json({ ok: false, stage: "auth", error: "unauthorized" }, { status: 401 });
  }
  // Dormant by flag: the rail is 404 (not half-open) until NEXT_PUBLIC_AV_ENABLED=1 — the server
  // twin of the build-time switcher gate.
  if (!avRailEnabled()) {
    return NextResponse.json({ ok: false, stage: "config", error: "av_rail_disabled" }, { status: 404 });
  }
  // No AV key is launchable until the owner uploaded the pool to AV's "UTM Campaign Values" and set
  // AV_KEYS_REGISTERED — the stub refuses BEFORE any FB write (the card stays not-ready too).
  if (avKeysRegistered() === 0) {
    return NextResponse.json(
      {
        ok: false,
        stage: "config",
        error: "av_keys_not_registered — no AV keys are registered in ActiveView yet; an owner uploads the pool (AV keys page) and sets AV_KEYS_REGISTERED",
      },
      { status: 400 },
    );
  }
  // The AV launch signer is the OWNER'S pick on /tokens (av.launch slot). AV has NO env default
  // (owner call 28.09: a new, separate token) — an unassigned/unreadable slot is a clean config
  // error, never another partner's bearer.
  const railRes = await avRail("launch");
  if (!railRes.ok) {
    return NextResponse.json({ ok: false, stage: "config", error: railRes.error }, { status: 400 });
  }
  const rail = railRes.rail;

  let campaign: Campaign;
  /** Creatives of this launch (1..maxCreatives, MO/AIF-parity): own-Blob URLs; cover = video
   *  thumbnail image. */
  let medias: { url: string; kind: "video" | "image"; coverUrl: string }[] = [];
  let taskId: string | null = null;
  try {
    const j = (await req.json()) as {
      campaign?: Campaign;
      partnerId?: string;
      /** Multi-creative shape (5-creative parity) — the runner already sends it. */
      medias?: { url?: string; kind?: string; coverUrl?: string }[];
      /** Single-creative fields — the pre-multi wire, still sent (and accepted) for open tabs and
       *  restored queued tasks. */
      mediaUrl?: string;
      mediaKind?: string;
      coverUrl?: string;
      taskId?: string;
    };
    campaign = (j.campaign ?? {}) as Campaign;
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
      medias = [
        { url, kind, coverUrl: kind === "video" && typeof j.coverUrl === "string" ? j.coverUrl.trim() : "" },
      ];
    }
    taskId = typeof j.taskId === "string" && /^[\w-]{6,64}$/.test(j.taskId) ? j.taskId : null;
  } catch (e) {
    return NextResponse.json({ ok: false, stage: "parse", error: String(e) }, { status: 400 });
  }

  const partner = partnerConfig("av" as PartnerId);
  // The account and fanka are the buyer's PICKS, validated against the AV token's own data below.
  // AV has NO pixel — the bound pixel is always empty (Traffic / link clicks).
  const pickedAccount = String(campaign.account ?? "").trim().replace(/^act_/, "");
  const pickedPage = String(campaign.page ?? "").trim();
  const binds: LaunchBinds = {
    accountId: pickedAccount,
    pageId: pickedPage,
    pageName: "", // resolved below, once the picked page passes validation
    pixelId: "", // AV never binds a pixel
  };
  // Fire-time belt over the picker filter: /accounts assignments hold even for a crafted POST.
  if (!(await accountAllowedFor(session, pickedAccount))) {
    return NextResponse.json({ ok: false, stage: "config", error: ACCOUNT_NOT_ASSIGNED_MSG }, { status: 403 });
  }

  try {
    if (!/^\d{5,}$/.test(pickedAccount)) {
      return NextResponse.json(
        { ok: false, stage: "config", error: "account_required — pick an ad account on the campaign card" },
        { status: 400 },
      );
    }
    if (!(await rail.isTokenAccount(pickedAccount))) {
      return NextResponse.json(
        { ok: false, stage: "config", error: "account_not_allowed — the AV token cannot use this ad account" },
        { status: 400 },
      );
    }
    if (!/^\d{5,}$/.test(pickedPage)) {
      return NextResponse.json(
        { ok: false, stage: "config", error: "fanpage_required — pick a fanpage on the campaign card" },
        { status: 400 },
      );
    }
    if (!(await rail.isAdvertisablePage(pickedPage))) {
      return NextResponse.json(
        { ok: false, stage: "config", error: "fanpage_not_allowed — the AV token cannot advertise with this page" },
        { status: 400 },
      );
    }
    // DSA beneficiary/payor for EU-reaching ad sets — same rule as MO/AIF (live failure 2026-08-10).
    binds.pageName = await rail.advertisablePageName(pickedPage);
  } catch (e) {
    const err = e as FbError;
    if (err instanceof FbError && err.status === 400) {
      return NextResponse.json({ ok: false, stage: "config", error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      { ok: false, stage: "config", error: `destination check failed: ${err.message ?? String(e)}` },
      { status: 502 },
    );
  }

  // The destination (Campaign.landing = a bare URL) is re-resolved on the server: the host must be
  // an AV site of ours (or one of its redirect domains), an article must answer 200, a redirect
  // path must exist and its domain be live. A stale/renamed draft would otherwise build a live ad
  // pointing at a dead page (mirror of MO/AIF's landing catalog check). The resolver's own status
  // (400 = the buyer's fix, 502 = AV unreachable) is surfaced verbatim.
  const resolved = await resolveAvDestination(String(campaign.landing ?? ""));
  if (!resolved.ok) {
    return NextResponse.json({ ok: false, stage: "config", error: resolved.error }, { status: resolved.status });
  }
  if (medias.length === 0 || medias.some((m) => !m.url)) {
    return NextResponse.json({ ok: false, stage: "media", error: "media_required" }, { status: 400 });
  }
  // Same contract as the other launch routes: a video creative's destination link lives inside its
  // CTA (creativePayload) — a "No CTA" video would ship link-less (review find 08-24).
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
  // Every creative must be a Vercel Blob URL our OWN broker produced — same SSRF fence as the other
  // launch routes — and the count is capped by the partner's own limit (server-side truth: a stale
  // tab could still POST more; the tree would then blow the function window mid-wave).
  {
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
  // AV delivery = Traffic / link clicks: the page has no pixel, so a min-ROAS strategy has nothing
  // to optimize on (the UI pins it away, the server is the truth). Refused BEFORE any claim.
  if (bidKind(campaign.bidStrategy) === "roas") {
    return NextResponse.json(
      {
        ok: false,
        stage: "config",
        error: "bid_strategy_invalid — min-ROAS needs a conversion signal; the AV page has no pixel (Traffic / link clicks only)",
      },
      { status: 400 },
    );
  }
  if (!SUPPORTED_BID_STRATEGIES.has(campaign.bidStrategy)) {
    return NextResponse.json({ ok: false, stage: "config", error: "bid_strategy_invalid" }, { status: 400 });
  }
  if (bidAmountMissing(campaign)) {
    return NextResponse.json(
      { ok: false, stage: "config", error: "Bid amount required for the selected bid strategy" },
      { status: 400 },
    );
  }
  if (!Array.isArray(campaign.countries) || campaign.countries.length === 0) {
    return NextResponse.json(
      { ok: false, stage: "config", error: "geo_required — pick at least one country" },
      { status: 400 },
    );
  }
  if (money(campaign.budget) < 100) {
    return NextResponse.json(
      { ok: false, stage: "config", error: "budget_too_low — daily budget must be at least $1" },
      { status: 400 },
    );
  }

  // Image launches + custom video covers: fetch + validate EVERY one BEFORE the stream (clean 400,
  // nothing claimed). Worst case is bounded: 5 creatives × ≤8MB (fetchValidatedImage ceiling) ≈
  // 40MB in memory — same envelope as the other launch routes.
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

  // Server-pinned invariants (the UI pins them too, but a stale/edited draft is the client's word,
  // not the truth): AV objective Traffic, optimization link clicks, no pixel — the only honest
  // delivery for a page with no conversion signal.
  const serverCampaign: Campaign = { ...campaign, objective: AV_OBJECTIVE, optimization: "clicks", pixel: "" };
  // The partner mark in the prefix is the ROUTE's, not the client's: a card that kept its MO/AIF
  // prefix across a partner switch still launches here as "(AV)" (live bug 23.09).
  const name = withPartnerMark(`${serverCampaign.namePrefix}${serverCampaign.name}`.trim(), partner.label);

  const encoder = new TextEncoder();
  const stream = withFbBudget({ deadlineAt: Date.now() + FB_BUDGET_MS, retries: FB_BUDGET_RETRIES }, () =>
    new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (o: Json) => controller.enqueue(encoder.encode(JSON.stringify(o) + "\n"));
      // Mirror progress into the shared launch-task row — the team keeps seeing the truth even if
      // this browser dies mid-run. partner="av" on every write: the row must land in the AV
      // drawer's scope even when this writer is the one that creates it.
      const bidLabel = bidTag(campaign.bidStrategy, campaign.bidCap);
      const tw = taskWriter(session.username, taskId, { partner: "av", ...(bidLabel ? { bid: bidLabel } : {}) });
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
      let key: { key: string; documentId: string } | null = null;
      let acctSlot: { documentId: string } | null = null;
      try {
        // 0) claim the ACCOUNT's launch slot — at most 5 campaigns per ad account per 30-min
        // window, across every user and channel (owner rule 2026-08-18). Released below on any
        // pre-campaign failure.
        progress("gcm");
        acctSlot = await claimAcctSlot(binds.accountId, {
          user: session.username,
          partner: "av",
          channel: "av",
          name,
          accountName: await rail.accountName(binds.accountId).catch(() => ""),
        });

        // 1) reserve the AV key BEFORE building the link (guarantees no duplicate revenue key).
        // Claim order acct-slot → key → FB tree (spec §3): the key is released below when nothing
        // reached FB, retired (with the campaign id) once a campaign exists.
        key = await claimAvKey(serverCampaign.gcm, avKeysRegistered(), {
          user: session.username,
          via: "launch",
          destination: resolved.base,
          name,
          ad_account: binds.accountId,
          ...(taskId ? { task_id: taskId } : {}),
        });
        const avKey = key.key;
        // The AV link = <destination>?utm_source=facebook&utm_medium={{campaign.id}}&utm_campaign=
        // <key>&utm_term={{adset.id}}&utm_content={{ad.id}} (macros literal, FB fills them). No
        // pixel / fire tail — tracking is entirely in the utm params AV's script reads.
        const link = fullLandingUrl(partner, resolved.base, avKey, false);
        if (!link) throw new FbError("no destination — cannot build the AV link", {});

        // 2) register EVERY creative on the AV account (MO/AIF-parity). Videos: all uploads are
        // fired first (advideos answers immediately, Meta processes in the background, in
        // parallel), THEN processing is waited out one by one — a 5-video card's wall-clock is
        // ~the slowest video, not the sum. Images: validated bytes → adimages hash.
        progress("video");
        type RegisteredMedia =
          | { kind: "image"; imageHash: string }
          | { kind: "video"; videoId: string; thumbUrl: string; coverHash?: string };
        const regs: RegisteredMedia[] = new Array(medias.length);
        for (let i = 0; i < medias.length; i++) {
          const m = medias[i];
          if (m.kind === "image") {
            regs[i] = { kind: "image", imageHash: await rail.uploadImage(binds.accountId, imageBufs.get(i) as Buffer) };
          } else {
            const suffix = medias.length > 1 ? ` · video ${i + 1}` : " · video";
            regs[i] = { kind: "video", videoId: await rail.uploadVideo(binds.accountId, m.url, `${name}${suffix}`), thumbUrl: "" };
          }
        }
        created.video_id = regs.find((r) => r.kind === "video")?.videoId ?? undefined;
        created.image_hash = (regs.find((r) => r.kind === "image") as { imageHash?: string } | undefined)?.imageHash;
        progress("processing");
        for (let i = 0; i < medias.length; i++) {
          const r = regs[i];
          if (r.kind !== "video") continue;
          await rail.waitForVideo(r.videoId);
          // A custom cover replaces the auto-thumbnail entirely (no thumbnail poll needed).
          const coverBuf = coverBufs.get(i);
          if (coverBuf) r.coverHash = await rail.uploadImage(binds.accountId, coverBuf);
          else r.thumbUrl = await rail.videoThumb(r.videoId);
        }
        const localeIds = await resolveLocales(serverCampaign.locales, rail);

        // 3) campaign → adset → one creative+ad PER media, all ACTIVE (parity with the MO/AIF rails)
        progress("campaign");
        const camp = await rail.fbPost(`act_${binds.accountId}/campaigns`, campaignPayload(serverCampaign, name));
        created.campaign_id = String(camp.id);

        progress("adset");
        const adset = await withParentRetry(String(camp.id), () =>
          rail.createAdset(`act_${binds.accountId}/adsets`, adsetPayload(serverCampaign, name, String(camp.id), binds, localeIds)),
        );
        created.adset_id = String(adset.id);

        progress("creative");
        const creativeIds: string[] = [];
        for (let i = 0; i < regs.length; i++) {
          const r = regs[i];
          const adName = regs.length > 1 ? `${name} · ${i + 1}` : name;
          const creative = await rail.fbPost(
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
            rail.fbPost(`act_${binds.accountId}/ads`, adPayload(adName, String(adset.id), creativeIds[i])),
          );
          // Belt over the fbPost error-body guard: never record a phantom "undefined" ad id.
          if (!ad.id) throw new FbError("ad create returned no id", ad);
          adIds.push(String(ad.id));
          // Progress lands on `created` AS ads are born (not after the loop): the catch below reads
          // it to know whether money is already moving when a later ad throws.
          created.ad_id = adIds[0];
          if (adIds.length > 1) created.ad_ids = [...adIds];
          send({ stage: "ad", done: adIds.length, total: creativeIds.length });
        }

        // 4) record the FB ids against the claimed key (retires it — a campaign exists). AV has no
        // hs-tools scope, so there is NO reportPagesUsed here. This backfill is NOT fatal: the
        // campaign is already live, so a registry hiccup only misses the ledger — surface it as a
        // warning and log, never fail a launched campaign over it.
        let warning: string | undefined;
        try {
          await backfillAvKey(avKey, {
            campaign_id: created.campaign_id as string,
            adset_id: created.adset_id as string,
            ad_id: created.ad_id as string,
            ad_count: adIds.length,
          });
        } catch (e) {
          warning = `av key backfill failed (campaign is live): ${(e as Error).message ?? String(e)}`;
          console.error("[av/launch]", warning);
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
          gcm: avKey, // the shared task row's marker column carries the AV key on this rail
          error: null,
        });
        send({
          ok: true,
          stage: "done",
          gcm: avKey,
          link,
          destination_kind: resolved.kind,
          page_id: binds.pageId,
          ...created,
          ...(warning ? { warning } : {}),
        });
      } catch (e) {
        const err = e as FbError;
        // Free the account's launch slot when NO campaign was created — the window only meters
        // campaigns that actually exist on FB. Once one exists the slot stays consumed.
        if (acctSlot && !created.campaign_id) await releaseAcctSlot(acctSlot.documentId);
        // Free the key when nothing was created on FB (early failures) so the registered pool never
        // leaks; keep the row (retired + noted) once a campaign exists so the orphaned campaign
        // stays traceable by key. Both best-effort — never throw out of the catch (spec §3).
        if (key) {
          try {
            if (created.campaign_id) {
              await backfillAvKey(key.key, {
                status: "retired",
                notes: `launch failed: ${err.message}`,
                campaign_id: created.campaign_id as string,
                ...(created.adset_id ? { adset_id: created.adset_id as string } : {}),
              });
            } else {
              await releaseAvKey(key.documentId);
            }
          } catch {
            /* registry settle is best-effort; the AV keys page shows a leftover row to release */
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
        send({ ok: false, stage: "error", error: err.message ?? String(e), detail: err.detail ?? null, created });
      } finally {
        clearInterval(beat);
        // Drop EVERY temporary Blob (creatives + covers) whether the launch succeeded or failed —
        // never orphan an upload.
        for (const m of medias) {
          await del(m.url, { token: process.env.BLOB_READ_WRITE_TOKEN }).catch(() => {});
          if (m.coverUrl) await del(m.coverUrl, { token: process.env.BLOB_READ_WRITE_TOKEN }).catch(() => {});
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
