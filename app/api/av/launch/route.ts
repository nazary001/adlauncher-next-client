import { NextResponse } from "next/server";
import { type Campaign, bidAmountMissing, bidKind, bidTag, withPartnerMark } from "@/lib/types";
import { AV_PIXEL, type PartnerId, avAdText, avDelivery, fullLandingUrl, partnerConfig } from "@/lib/partners";
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
import { FbError, accountPixels, fbGet, withFbBudget, withParentRetry } from "@/lib/fb-graph";
import { fetchValidatedImage } from "@/lib/fb-media";
import { isLegacyBlobUrl, isOwnCreativeUrl } from "@/lib/creative-url";
import { avKeysRegistered, avRail, avRailEnabled } from "@/lib/av-launch";
import { backfillAvKey, claimAvKey, releaseAvKey } from "@/lib/av-keys";
import { resolveAvDestination } from "@/lib/av-destination";
import { avServerName } from "@/lib/av-link";
import { avApiConfigured } from "@/lib/av-api";
import { publisherPlatformsOf } from "@/lib/publisher-platforms";
import { claimAcctSlot, releaseAcctSlot } from "@/lib/acct-limit";
import { ACCOUNT_NOT_ASSIGNED_MSG, accountAllowedFor } from "@/lib/acct-assignments";
import { taskWriter } from "@/lib/task-store";
import { del } from "@vercel/blob";
// TOOL launch channel (owner ask 28.09): a `via:"tool"` body flag runs the AV launch through the HS
// team's Ads Manager sessions service (tool.gctracking.xyz) instead of building the tree on the AV
// token — the GC-AV cabinets live on a live TOOL session, not on the AV token. Same destination
// re-resolve, AV-key + acct-slot claims, name prefix and NDJSON contract; the whole
// campaign→adset→ad build is one TOOL job. The one thing the AV token STILL provides on this path is
// the FANPAGE: "нужно на нужную фанку делать — на то что тянет токен, а через сам токен только фанку
// тянуть". So the picked page is validated against the AV token's own advertisable-page catalog
// (below), and the token is used for NOTHING else here (no account catalog, no upload, no signing).
// Locales resolve on the MO signer's token — NEVER the AV token (adlocale search needs no account
// access), so the AV token is truly page-only on TOOL.
import {
  buildToolCampaign,
  runToolMedia,
  runToolPublish,
  toolEnsureMark,
  toolSessionPick,
  type ToolCreated,
  type ToolCreativeInput,
  type ToolNdjsonStage,
} from "@/lib/tool-launch";
import { toolDeps, toolInputFromCampaign, toolLaunchReady, toolSessionDirectory } from "@/lib/tool-run";
import { resolveMoSigner } from "@/lib/mo-soc";

export const runtime = "nodejs";
export const maxDuration = 300;

type Json = Record<string, unknown>;

// Same per-launch FB retry budget as the MO/AIF routes: rate-limited calls wait out Meta's regain
// estimate but never past the deadline — the hard failure must land INSIDE the function so the
// error path (key release/retire, task row settle) always runs.
const FB_BUDGET_MS = 240_000;
const FB_BUDGET_RETRIES = 8;

// TOOL launch deadline (owner ask 28.09) — twin of the MO/AIF routes: media registration + the
// publish job share this wall-clock budget from request start; 265 s < maxDuration 300 s keeps the
// deadline INSIDE the function so a pending job settles the row (slot + key KEPT, note "pending tool
// job #N") rather than a Vercel timeout skipping the disposition.
const TOOL_DEADLINE_MS = 265_000;

// ---------- locale resolution (best-effort, non-fatal) — the AV-token twin of /api/aif/launch's ----------

// Locale ids are global Meta facts (token-independent): the fbGetter only SIGNS the adlocale search.
// The Graph path passes the AV rail's fbGet; the TOOL path passes the MO signer's — on TOOL the AV
// token is page-only (owner ask 28.09), so locales are resolved with a non-AV signer, and adlocale
// search needs no account access. One shared cache serves both.
const localeCache = new Map<string, number | null>();
async function resolveLocales(names: string[], fbGetter: (path: string) => Promise<Json>): Promise<number[]> {
  const ids: number[] = [];
  for (const raw of names) {
    if (/\(all\)/i.test(raw)) continue; // "all" = no language restriction (broadest)
    if (!localeCache.has(raw)) {
      try {
        const body = await fbGetter(`search?type=adlocale&limit=25&q=${encodeURIComponent(raw.replace(/[()]/g, " ").trim())}`);
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
 * site, a Redirect path, or a Chat Builder chat — lib/av-destination) with the key in utm_campaign
 * (lib/av-link). Delivery is the card's pick (owner ask 30.09, lib/partners avDelivery): Purchase
 * on the AV site pixel (AV_PIXEL — fired by ActiveView's own site script; the default) or Traffic /
 * link clicks with no pixel. Min-ROAS is refused either way (AV's Purchase carries no value), and the
 * link never carries a &pixel=/&fire= tail (the site script fires). Every gate runs BEFORE any claim, and the
 * destination is RE-RESOLVED here (host must be an AV site / redirect domain / chat host, article
 * live, redirect path present + domain live, chat host showing ads) so a stale draft can never
 * point a live ad at a dead page — or at a chat that earns nothing.
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
  // Wall-clock origin for the TOOL job deadline (see TOOL_DEADLINE_MS) — captured before any await
  // so the whole request shares one budget.
  const startedAt = Date.now();

  let campaign: Campaign;
  /** Creatives of this launch (1..maxCreatives, MO/AIF-parity): own creative-store URLs; cover =
   *  video thumbnail image. */
  let medias: { url: string; kind: "video" | "image"; coverUrl: string }[] = [];
  let taskId: string | null = null;
  /** owner ask 28.09: `via:"tool"` routes this launch through TOOL; absent/anything else is the
   *  unchanged direct-Graph path on the AV token. */
  let viaTool = false;
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
      /** owner ask 28.09: "tool" = launch through TOOL; absent/anything else = direct Graph. */
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
      medias = [
        { url, kind, coverUrl: kind === "video" && typeof j.coverUrl === "string" ? j.coverUrl.trim() : "" },
      ];
    }
    taskId = typeof j.taskId === "string" && /^[\w-]{6,64}$/.test(j.taskId) ? j.taskId : null;
  } catch (e) {
    return NextResponse.json({ ok: false, stage: "parse", error: String(e) }, { status: 400 });
  }
  // The card's Platforms pick (owner ask 30.09: "выбирать соц, на который будет залив") — the Meta
  // platforms this launch runs on, on BOTH channels; no pick = Facebook only (the default, owner
  // 30.09). A word outside the card's choices is refused before any write: never widened to every
  // platform, never narrowed on a guess.
  const platforms = publisherPlatformsOf(campaign.platforms);
  if (platforms === null) {
    return NextResponse.json(
      {
        ok: false,
        stage: "parse",
        error: `platforms_invalid: ${String(campaign.platforms).slice(0, 40)} — pick Facebook, Instagram, Facebook + Instagram or All (auto)`,
      },
      { status: 400 },
    );
  }
  // The card's Profile pick (owner ask 30.09: TOOL added session_id — "теперь можем сделать выбор
  // профилей у нас"): Auto (null) lets TOOL pick a session by account, as before; an id names the
  // TOOL session (FB profile) that uploads the media and builds the campaign. A garbled pick is
  // refused before any write — never silently widened to Auto. Checked against the account's live
  // sessions in the TOOL gate below.
  const sessionPick = toolSessionPick(campaign.toolSession);
  if (!sessionPick.ok) {
    return NextResponse.json(
      {
        ok: false,
        stage: "parse",
        error: `tool_session_invalid: ${String(campaign.toolSession).slice(0, 20)} — pick a profile on the card (or Auto)`,
      },
      { status: 400 },
    );
  }

  // The AV token (slot av.launch) is resolved on BOTH channels (owner ask 28.09). The direct-Graph
  // path signs the whole build with it; the TOOL path uses it ONLY to list + validate the fanpage —
  // "через сам токен только фанку тянуть". Either way an unassigned/unreadable slot is a clean config
  // error: the Graph path surfaces resolveSlot's verdict verbatim; the TOOL path names the remedy so
  // a buyer knows the token is needed only for the fanpage.
  const railRes = await avRail("launch");
  if (!railRes.ok) {
    return NextResponse.json(
      {
        ok: false,
        stage: "config",
        error: viaTool
          ? "AV fanpages come from the AV token — assign it on /tokens (AV · Launches)"
          : railRes.error,
      },
      { status: 400 },
    );
  }
  const rail = railRes.rail;
  // AV needs its OWN API key (AV_API_KEY) to re-resolve the destination below (resolveAvDestination
  // → avSites → avMe → avFetch) on BOTH channels. Gate it here as a clean config 500 — mirroring
  // /api/av/destinations — so a registered pool but a missing/blank key surfaces as configuration,
  // not a misleading 502 "destination_check_failed" from the resolver (review find 09-28).
  if (!avApiConfigured()) {
    return NextResponse.json(
      { ok: false, stage: "config", error: "av_not_configured — set AV_API_KEY" },
      { status: 500 },
    );
  }

  const partner = partnerConfig("av" as PartnerId);
  // The account and fanka are the buyer's PICKS, validated against the AV token's own data below.
  // The delivery is the card's optimization pick, mapped server-side (the client's objective / pixel
  // are never trusted): Purchase binds AV_PIXEL, link clicks bind none.
  const delivery = avDelivery(String(campaign.optimization ?? ""));
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
      return NextResponse.json(
        { ok: false, stage: "config", error: "account_required — pick an ad account on the campaign card" },
        { status: 400 },
      );
    }
    if (viaTool) {
      // TOOL path: the ACCOUNT is a live GC-AV TOOL cabinet, gated against the live session in the
      // TOOL block below (there is no AV-token account check — the token is page-only here). The
      // PAGE, though, is validated against the AV token's OWN advertisable-page catalog (owner ask
      // 28.09: the token pulls only the fanpage), and its name is read from that same list for
      // whatever downstream needs it — exactly as the direct-Graph path does.
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
    } else {
      if (!(await rail.isTokenAccount(pickedAccount))) {
        return NextResponse.json(
          { ok: false, stage: "config", error: "account_not_allowed — the AV token cannot use this ad account" },
          { status: 400 },
        );
      }
      // Purchase optimizes on AV_PIXEL — the cabinet must carry it, or Meta would only reject the ad
      // set once the campaign already exists (orphan + burnt key). On TOOL the cabinet is not on the
      // AV token, so TOOL's own validation answers there.
      if (binds.pixelId && !(await accountPixels(pickedAccount, rail.cat)).some((p) => p.id === binds.pixelId)) {
        return NextResponse.json(
          {
            ok: false,
            stage: "config",
            error: `pixel_not_on_account — Purchase runs on ${AV_PIXEL.name} (${AV_PIXEL.id}); share it to act_${pickedAccount} in Business Manager first, or switch the card to Link clicks`,
          },
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
    }
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
  // an AV site of ours (or one of its redirect domains / its chat subdomain), an article must
  // answer 200, a redirect path must exist and its domain be live, a chat's host must show ads. A
  // stale/renamed draft would otherwise build a live ad pointing at a dead page (mirror of MO/AIF's
  // landing catalog check). The resolver's own status (400 = the buyer's fix, 502 = AV
  // unreachable) is surfaced verbatim.
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
  // Every creative must be a URL this app itself produced — our S3 creative store (either origin,
  // under creatives/ or keep/) or, transition-only, our legacy Blob prefix (isOwnCreativeUrl) — same
  // SSRF fence as the other launch routes (the server fetches image bytes + covers from it). The
  // count is capped by the partner's own limit (server-side truth: a stale tab could still POST more;
  // the tree would then blow the function window mid-wave).
  {
    const cap = Math.max(1, partner.maxCreatives ?? 1);
    if (medias.length > cap) {
      return NextResponse.json(
        { ok: false, stage: "media", error: `too_many_creatives — this partner launches at most ${cap} per campaign` },
        { status: 400 },
      );
    }
    for (const m of medias) {
      if (!isOwnCreativeUrl(m.url)) {
        return NextResponse.json({ ok: false, stage: "media", error: "media_url_invalid" }, { status: 400 });
      }
      // Covers are fetched server-side into adimages — same fence as the creatives.
      if (m.coverUrl && !isOwnCreativeUrl(m.coverUrl)) {
        return NextResponse.json({ ok: false, stage: "media", error: "cover_url_invalid" }, { status: 400 });
      }
    }
  }
  // Min-ROAS optimizes purchase VALUE, and AV's Purchase events carry none (AV's telemetry is off) —
  // nothing to optimize on in either AV mode (the UI pins it away, the server is the truth).
  // Refused BEFORE any claim.
  if (bidKind(campaign.bidStrategy) === "roas") {
    return NextResponse.json(
      {
        ok: false,
        stage: "config",
        error: "bid_strategy_invalid — min-ROAS needs purchase value; AV's Purchase events carry none (use lowest cost or a cost cap)",
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

  // TOOL channel gate (owner ask 28.09) — pre-stream, session-gated exactly like the Graph path.
  // Everything above (destination re-resolve, the AV-token fanpage validation, media/bid/geo/budget
  // validation, image prefetch) ran identically; here we add the TOOL pieces: the account must be a
  // live GC-AV cabinet a TOOL session sees (no AV-token account check — the AV token is page-only on
  // this path), and its TOOL-side currency (the buildToolCampaign USD guard's backstop) + name are
  // read. If the card carries languages we resolve a Graph token that can hit adlocale search WITHOUT
  // account access (the MO signer — adlocale is a global endpoint; NEVER the AV token); with none,
  // refuse by name (a wrong-language ad is worse than a refusal). A not-ready verdict is the SAME
  // pre-stream JSON rejection shape the route already returns.
  let toolAcctCurrency = "USD";
  let toolAcctName = "";
  let toolLocaleToken = "";
  /** The validated Profile pick (undefined = Auto) and its label for notes / errors. */
  let toolSessionId: number | undefined;
  let toolSessionLabel = "";
  if (viaTool) {
    const ready = await toolLaunchReady();
    if (!ready.ok) {
      return NextResponse.json({ ok: false, stage: "config", error: ready.message }, { status: 400 });
    }
    const findAv = (r: Awaited<ReturnType<typeof toolLaunchReady>>) =>
      r.ok ? r.accounts.find((a) => a.account_id === pickedAccount && /^GC-AV-/i.test(String(a.name ?? "").trim())) : undefined;
    // Fire-time visibility (force-refreshes the 60 s roster once on a miss) — a stale pick whose GC-AV
    // account no live session sees is refused here, not mid-stream.
    let row = findAv(ready);
    if (!row) row = findAv(await toolLaunchReady(true));
    if (!row) {
      return NextResponse.json(
        {
          ok: false,
          stage: "config",
          error: `tool_account_unavailable — no live TOOL session sees a GC-AV cabinet ${pickedAccount}; an owner refreshes/adds one on Ads Manager sessions`,
        },
        { status: 400 },
      );
    }
    toolAcctCurrency = row.currency || "USD";
    toolAcctName = row.name || "";
    // Profile pick (owner ask 30.09): the named session must be one TOOL lists as seeing THIS cabinet
    // (one forced roster refresh on a miss — the 60 s cache may predate a session check) and must not
    // be known as expired / disabled. Refused pre-stream, nothing claimed.
    if (sessionPick.id !== null) {
      const pickId = sessionPick.id;
      const seen = (r: typeof row) => r?.sessions.find((s) => s.id === pickId);
      let hit = seen(row);
      if (!hit) {
        const fresh = findAv(await toolLaunchReady(true));
        if (fresh) row = fresh;
        hit = seen(row);
      }
      const info = (await toolSessionDirectory())?.get(pickId);
      const label = hit?.name || info?.name || `#${pickId}`;
      if (!hit || (info && info.status !== "active")) {
        return NextResponse.json(
          {
            ok: false,
            stage: "config",
            error: `tool_session_unavailable — profile ${label}${info && info.status !== "active" ? ` is ${info.status} on TOOL` : ` does not see ${toolAcctName || pickedAccount} on TOOL now`}; pick another profile or Auto`,
          },
          { status: 400 },
        );
      }
      toolSessionId = pickId;
      toolSessionLabel = info?.profile ? `${label} · ${info.profile}` : label;
    }
    const wantsLocales = Array.isArray(campaign.locales) && campaign.locales.some((n) => !/\(all\)/i.test(String(n)));
    if (wantsLocales) {
      const signer = await resolveMoSigner("launch");
      if (!signer.ok) {
        return NextResponse.json(
          { ok: false, stage: "config", error: "languages need a token to resolve on TOOL — clear them or add the AV token" },
          { status: 400 },
        );
      }
      toolLocaleToken = signer.signer.token;
    }
  }

  // Server-pinned invariants (the UI pins them too, but a stale/edited draft is the client's word,
  // not the truth): the delivery the optimization pick maps to — Sales / Purchase on AV_PIXEL, or
  // Traffic / link clicks with no pixel (avDelivery).
  const serverCampaign: Campaign = { ...campaign, ...delivery };
  // AV's ad text is SWAPPED (owner ask 30.09, avAdText): the card's Title feeds the ad's headline and
  // its Headline the description. Only the creatives read this copy — names, targeting, delivery and
  // the key registry keep reading serverCampaign.
  const creativeCampaign: Campaign = { ...serverCampaign, ...avAdText(serverCampaign) };
  // The partner mark in the prefix is the ROUTE's, not the client's: a card that kept its MO/AIF
  // prefix across a partner switch still launches here as "(AV)" (live bug 23.09). A TOOL-born run
  // carries `GCL TOOL - ` after the partner prefix (toolEnsureMark) — the client name is never trusted.
  // The locked "<topic> | <GEO> | <lang> | " is the server's too (owner ask 30.09, avServerName): built
  // from the RESOLVED destination + the card's countries, then only the buyer's typed tail.
  const baseName = withPartnerMark(
    avServerName(serverCampaign.namePrefix, serverCampaign.name, resolved.base, serverCampaign.countries),
    partner.label,
  );
  const name = viaTool ? toolEnsureMark(baseName) : baseName;

  const encoder = new TextEncoder();
  const stream = withFbBudget({ deadlineAt: Date.now() + FB_BUDGET_MS, retries: FB_BUDGET_RETRIES }, () =>
    new ReadableStream<Uint8Array>({
    async start(controller) {
      // review find 28.09: on the TOOL path a client that closed the tab makes controller.enqueue
      // throw — swallow it so a disconnect never unwinds the TOOL branch mid-poll. TOOL creates AND
      // activates server-side, so an unwind into the catch would free the key + acct-slot out from
      // under a campaign being born live. The Graph path MUST keep throwing exactly as before.
      const send = (o: Json) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(o) + "\n"));
        } catch (e) {
          if (!viaTool) throw e;
        }
      };
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
      // review find 28.09 (belt): set by runToolPublish's onSubmitted the instant TOOL returns a job
      // id (before any poll). Once set, a throw reaching the catch with no known campaign id settles
      // as PENDING (keep slot + key), never freed — the job may still be creating the live campaign.
      let toolSubmittedJob: number | null = null;
      try {
        // 0) claim the ACCOUNT's launch slot — at most 5 campaigns per ad account per 30-min
        // window, across every user and channel (owner rule 2026-08-18). Released below on any
        // pre-campaign failure.
        progress("gcm");
        acctSlot = await claimAcctSlot(binds.accountId, {
          user: session.username,
          partner: "av",
          // The 5/30-min account meter spans every channel; a TOOL launch claims here too, under its
          // own channel label so the drawer can tell the rails apart (owner ask 28.09).
          channel: viaTool ? "av-tool" : "av",
          name,
          accountName: viaTool ? toolAcctName : await rail.accountName(binds.accountId).catch(() => ""),
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
        // pixel / fire tail even for Purchase — AV's own site script fires AV_PIXEL and reads the utms.
        const link = fullLandingUrl(partner, resolved.base, avKey, false);
        if (!link) throw new FbError("no destination — cannot build the AV link", {});

        // ============================================================================================
        // TOOL launch block (owner ask 28.09) — twin of the MO/AIF routes'. Replaces the direct-Graph
        // upload+tree with ONE TOOL job (media from Blob URL → CampaignRequest → submit → poll). Every
        // terminal state settles the row and RETURNS, so the Graph code below stays byte-for-byte and
        // never runs on this rail. TOOL creates PAUSED and activates last on full success, so there is
        // nothing to pause on failure (AV never paused on failure anyway). Money is USD, ROAS a
        // coefficient — but AV refuses min-ROAS (its Purchase carries no value), so no ROAS ever reaches here.
        // ============================================================================================
        if (viaTool) {
          const deadlineAt = startedAt + TOOL_DEADLINE_MS;
          // Idempotency-Key = our task id (spec §3) so a retried wave never double-creates; a stable
          // per-run key covers a client that sent none (auto-launch, browser died pre-save).
          const idempotencyKey = taskId || `av-tool-${avKey}-${startedAt.toString(36)}`;
          const onStage = (s: ToolNdjsonStage) => {
            if (s !== "done" && s !== "error") progress(s);
          };
          // Terminal failure disposition — mirrors AV's synchronous catch (release the slot only when
          // nothing was created; retire the key with a job-named note when a campaign exists, else free
          // the key), with NO Graph pause. `pending` is handled inline below.
          const toolFail = async (msg: string, opts: { created?: ToolCreated; jobId?: number } = {}) => {
            if (opts.created?.campaignId) {
              created.campaign_id = opts.created.campaignId;
              if (opts.created.adsetIds[0]) created.adset_id = opts.created.adsetIds[0];
            }
            // toolFail only ever sees DEFINITE outcomes — pre-submit refusals, a 4xx on submit, or a
            // terminal error / canceled job that reported no ids (runToolPublish turns every ambiguous
            // end — partial/unknown without ids, done without a campaign, deadline — into `pending`,
            // handled below). So nothing created here really means nothing: free the slot + the key (a
            // kept key would leak from the registered pool). Post-submit THROWS are the shared catch's
            // job (toolSubmittedJob belt).
            if (acctSlot && !created.campaign_id) await releaseAcctSlot(acctSlot.documentId);
            if (key) {
              try {
                if (created.campaign_id)
                  await backfillAvKey(key.key, {
                    status: "retired",
                    notes: `launch failed: ${msg}`,
                    campaign_id: created.campaign_id as string,
                    ...(created.adset_id ? { adset_id: created.adset_id as string } : {}),
                  });
                else await releaseAvKey(key.documentId);
              } catch {
                /* registry settle is best-effort; the AV keys page shows a leftover row to release */
              }
            }
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

          // 2t) register every creative through TOOL from its public Blob URL (+ custom video cover).
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
            // The picked profile uploads the media too (owner ask 30.09); Auto = TOOL's own pick.
            { deadlineAt, onStage, ...(toolSessionId ? { sessionId: toolSessionId } : {}) },
          );
          if (!mediaRun.ok) {
            await toolFail(`TOOL media registration failed: ${mediaRun.error}${toolSessionLabel ? ` (profile ${toolSessionLabel})` : ""}`);
            return;
          }

          // Build the creatives with the TOOL MediaRefs + the AV link + the card's copy (same field
          // mapping as fb-launch: copy→primary_text, headline||title→headline, title→description) —
          // over AV's SWAPPED ad text (avAdText, owner ask 30.09): the card's Title is the ad's
          // headline, its Headline the description.
          const creatives: ToolCreativeInput[] = medias.map((m, i) => {
            const ref = mediaRun.refs[i];
            const c: ToolCreativeInput = {
              name: medias.length > 1 ? `${name} · ${i + 1}` : name,
              media: ref.media,
              primaryText: creativeCampaign.copy || "",
              headline: creativeCampaign.headline || creativeCampaign.title || "",
              url: link,
              cta: creativeCampaign.cta || "",
            };
            if (ref.thumbnail) c.thumbnail = ref.thumbnail;
            if (creativeCampaign.title && creativeCampaign.headline && creativeCampaign.title !== creativeCampaign.headline)
              c.description = creativeCampaign.title;
            return c;
          });

          // Locales resolve on the MO signer's token (captured pre-stream when the card has any) —
          // adlocale search needs no account access, so it works with no AV token (owner ask 28.09).
          const localeIds = toolLocaleToken
            ? await resolveLocales(serverCampaign.locales, (path) => fbGet(path, toolLocaleToken))
            : [];
          const built = buildToolCampaign(
            toolInputFromCampaign(serverCampaign, {
              name,
              pageId: binds.pageId,
              pixelId: binds.pixelId, // AV_PIXEL for Purchase, "" for link clicks (avDelivery)
              localeIds,
              creatives,
              status: "ACTIVE", // AV launches go live; TOOL creates PAUSED then activates on success
              accountCurrency: toolAcctCurrency,
              platforms,
              ...(toolSessionId ? { sessionId: toolSessionId } : {}), // the Profile pick; Auto = TOOL picks
            }),
          );
          if (!built.ok) {
            await toolFail(`TOOL rejected the campaign: ${built.error}`);
            return;
          }

          // 3t) submit the create job and follow it to a terminal state (poll ~2.5 s).
          progress("campaign");
          const pub = await runToolPublish(toolDeps, binds.accountId, built.body, {
            idempotencyKey,
            deadlineAt,
            onStage,
            // review find 28.09 (belt): record the job id the instant TOOL accepts the submit, before
            // any poll — so a throw after this point never frees the key/slot under a live campaign.
            onSubmitted: (jobId) => {
              toolSubmittedJob = jobId;
            },
          });

          if (pub.ok) {
            created.campaign_id = pub.campaignId;
            created.adset_id = pub.adsetId;
            created.ad_id = pub.adIds[0];
            if (pub.adIds.length > 1) created.ad_ids = [...pub.adIds];
            // 4t) record the FB ids against the claimed key (AV has NO hs-tools scope, so there is no
            // reportPagesUsed here — same as the Graph path). Best-effort: a live TOOL campaign must
            // never be reported failed over a registry hiccup.
            await backfillAvKey(avKey, {
              campaign_id: pub.campaignId,
              adset_id: pub.adsetId,
              ad_id: pub.adIds[0],
              ad_count: pub.adIds.length,
              notes: `launched via TOOL job #${pub.jobId}${toolSessionLabel ? ` · profile ${toolSessionLabel}` : ""}`,
            }).catch(() => {});
            settled = true;
            tw.write({
              status: "done",
              stage: "ad",
              finished_at: Date.now(),
              campaign_id: pub.campaignId,
              adset_id: pub.adsetId,
              ad_id: pub.adIds[0],
              link,
              gcm: avKey, // the shared task row's marker column carries the AV key on this rail
              error: null,
            });
            send({
              ok: true,
              stage: "done",
              via: "tool",
              tool_job_id: pub.jobId,
              gcm: avKey,
              link,
              destination_kind: resolved.kind,
              page_id: binds.pageId,
              campaign_id: pub.campaignId,
              adset_id: pub.adsetId,
              ad_id: pub.adIds[0],
              ...(pub.adIds.length > 1 ? { ad_ids: pub.adIds } : {}),
            });
            return;
          }

          if (pub.pending) {
            // Deadline hit while TOOL was still working — KEEP the slot + key (the campaign may yet be
            // born); note the job so it is traceable on Ads Manager sessions → Jobs.
            if (pub.created?.campaignId) created.campaign_id = pub.created.campaignId;
            const pendingMsg = `pending tool job #${pub.jobId ?? "?"} — check Ads Manager sessions → Jobs`;
            await backfillAvKey(avKey, {
              notes: pendingMsg,
              ...(pub.created?.campaignId ? { campaign_id: pub.created.campaignId } : {}),
            }).catch(() => {});
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

        // Graph path only (the TOOL block returned above). The AV rail is always resolved (avRail
        // returned ok for both channels), so the whole direct-Graph build below signs with it.

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
        const localeIds = await resolveLocales(serverCampaign.locales, rail.fbGet);

        // 3) campaign → adset → one creative+ad PER media, all ACTIVE (parity with the MO/AIF rails)
        progress("campaign");
        const camp = await rail.fbPost(`act_${binds.accountId}/campaigns`, campaignPayload(serverCampaign, name));
        created.campaign_id = String(camp.id);

        progress("adset");
        const adset = await withParentRetry(String(camp.id), () =>
          rail.createAdset(`act_${binds.accountId}/adsets`, adsetPayload(serverCampaign, name, String(camp.id), binds, localeIds, platforms)),
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
              ? imageCreativePayload(creativeCampaign, adName, binds, { imageHash: r.imageHash, link })
              : creativePayload(creativeCampaign, adName, binds, {
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
        // review find 28.09 (TOOL belt): if TOOL accepted the submit (onSubmitted set toolSubmittedJob)
        // but no campaign id is known, a throw reaching here must NOT free the slot/key — TOOL may be
        // creating AND activating the campaign server-side. Settle exactly like the TOOL PENDING
        // terminal above (keep the slot, keep the key with a "pending tool job #N" note, free NOTHING).
        // The guarded send already stops a client disconnect from unwinding the TOOL branch; this
        // covers any other post-submit throw.
        if (viaTool && toolSubmittedJob != null && !created.campaign_id) {
          const pendingMsg = `pending tool job #${toolSubmittedJob} — check Ads Manager sessions → Jobs`;
          if (key) await backfillAvKey(key.key, { notes: pendingMsg }).catch(() => {});
          settled = true;
          tw.write({ status: "error", stage: lastStage, finished_at: Date.now(), error: pendingMsg });
          send({ ok: false, stage: "error", pending: true, via: "tool", tool_job_id: toolSubmittedJob, error: err.message ?? String(e) });
          return;
        }
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
        // Creatives now live in content-addressed S3 objects shared by cards, retries and whole
        // waves — nothing is deleted per launch any more; the bucket's lifecycle is the cleanup.
        // del() stays ONLY for a legacy Blob URL, so a tab opened before the S3 deploy still cleans
        // up after itself.
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
