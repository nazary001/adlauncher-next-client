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
import { LION_ACR, LionError, lionAccountPixels, lionConfigured, lionProfileData } from "@/lib/lion";
import { hsPageRefusal, reportPagesUsed } from "@/lib/hs-pages";
import { sessionFromCookieHeader } from "@/lib/session";
import { taskWriter } from "@/lib/task-store";
import { acctKey, claimAcctSlot, releaseAcctSlot } from "@/lib/acct-limit";
import { ACCOUNT_NOT_ASSIGNED_MSG, accountAllowedFor } from "@/lib/acct-assignments";
import { type HsTokenCreative, hsTokenStartTime, parseTokenCreatives } from "@/lib/hs-token-launch";
import {
  type ToolCreativeInput,
  type ToolMediaItem,
  type ToolNdjsonStage,
  buildToolCampaign,
  runToolMedia,
  runToolPublish,
  toolEnsureMark,
} from "@/lib/tool-launch";
import { toolAccountVisible, toolDeps, toolInputFromCampaign, toolLaunchReady } from "@/lib/tool-run";

export const runtime = "nodejs";
// Modelled on /api/hs/token-launch (maxDuration 300): the whole run — media register + poll to
// ready, campaign.create submit + job poll to a terminal state — lives inside one serverless
// window. TOOL does the Graph work itself, so there is no in-request tree build (unlike the token
// rail); the window is spent waiting on TOOL's job + media polls (owner ask 28.09).
export const maxDuration = 300;

// The whole run must finish (or cleanly settle) INSIDE the function window: the media + publish
// poll deadline is maxDuration minus a margin so the final row write + stream close always land
// before the platform freezes the function (mirrors token-launch's FB_BUDGET_MS headroom).
const TOOL_DEADLINE_MS = 270_000;

type Json = Record<string, unknown>;

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

/** TOOL orchestration stage (spec §2.4) → the client's existing HS stage key (STAGES /
 *  TOKEN_STAGE_LABELS in components/hs-task-manager.tsx). TOOL's media/campaign/adset/creative/ad
 *  steps collapse onto the four keys the segmented bar already renders — media registration is the
 *  token rail's "submit" ("Uploading to Facebook"), the job's fragments/publish are campaign→adset→
 *  ads — so a TOOL launch shows an unchanged bar even before the client learns the "tool" kind. */
function wireLaunchStage(s: ToolNdjsonStage): string {
  switch (s) {
    case "gcm":
    case "video":
    case "processing":
      return "submit";
    case "campaign":
      return "campaign";
    case "adset":
      return "adset";
    case "creative":
    case "ad":
    case "done":
      return "ads";
    default:
      return "submit";
  }
}

/**
 * HS launch over the TOOL channel (owner ask 28.09): the same LION-validated campaign the LION and
 * FB-Token rails build — same name grammar, same LION-catalog binds, same tracking-tail link, same
 * fanka gate / acct-limit / task row — but campaign→adset→creatives→ads are created by the HS team's
 * Ads Manager sessions service (tool.gctracking.xyz). The two units that make TOOL different from our
 * Graph/LION rails (spec §3): money is USD (never cents), ROAS is the coefficient (never ×10000) —
 * both handled inside lib/tool-launch's builders, never here. TOOL creates the tree PAUSED then
 * activates it last (options.activate); the ad set still carries start_time = now + 30 min (partner
 * ingestion rule, same as the token rail). Streams NDJSON stage events onto the SAME keys the HS
 * Task Manager already renders, and mirrors them into the shared HS task row (partner="br",
 * gcm="tool") so the team sees the launch even if this browser dies mid-run.
 */
export async function POST(req: Request): Promise<Response> {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return bad("unauthorized", 401);

  // Is TOOL launchable at all right now (key + scopes + ≥1 live session account)? Refuse BEFORE any
  // work with the server's own actionable reason (no row, no TOOL call) — same fail-fast shape as
  // the token rail's hsTokenGate. Cached 60s in tool-run, so this is nearly free.
  {
    const ready = await toolLaunchReady();
    if (!ready.ok) {
      const status =
        ready.reason === "not_configured" || ready.reason === "key_rejected" || ready.reason === "scope_missing"
          ? 500
          : 503;
      return bad(ready.message, status);
    }
  }
  // Binds are validated against LION's catalog BY DESIGN (the account/page/pixel space of HS is
  // served by LION, and the partner's ingestion only sees accounts a weapon profile is bound to —
  // same tie the token rail keeps). With LION down the TOOL rail refuses rather than fire an
  // unverifiable bind. TOOL itself needs no LION — this is the catalog check, not the launcher.
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
  // Token/MO parity: an event invalid for the objective would only die at the ad-set step — reject
  // it before any write. (buildToolCampaign refuses an unmapped event by name too, but this keeps
  // the failure identical to the other HS rails.)
  if (!conversionEventsFor(c.objective).some((e) => e.value === c.conversionEvent)) {
    return bad("event_invalid — conversion event is not valid for the objective");
  }
  if (!c.profile) return bad("profile_required");
  if (!c.account) return bad("account_required");
  if (!c.page) return bad("page_required");
  if (!c.pixel) return bad("pixel_required");

  // ---- bind validation against LION's own catalog (cached 10 min) — identical to both HS rails ----
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
  // Owner rule 2026-09-07: only fankas hs-tools marks OK may launch — belt over the picker filter.
  const fankaRefusal = await hsPageRefusal("br", [page]);
  if (fankaRefusal) return bad(fankaRefusal.error, fankaRefusal.status);
  let pixels;
  try {
    pixels = await lionAccountPixels(c.profile, c.account);
  } catch (e) {
    return bad(`lion_unreachable: ${(e as Error).message}`, 502);
  }
  if (!pixels.some((p) => p.id === c.pixel)) return bad("pixel_not_on_account");

  // Fire-time belt over the picker filter: /accounts assignments hold even for a crafted POST.
  if (!(await accountAllowedFor(session, c.account))) return bad(ACCOUNT_NOT_ASSIGNED_MSG, 403);

  // Fire-time belt over the picker filter: this account must be visible to a LIVE TOOL session, or
  // TOOL answers `missing_context` on the very first call. toolAccountVisible force-refreshes once
  // on a miss (an owner may have just refreshed the session). Refuse up front with the actionable
  // read instead of letting the run die inside the stream.
  if (!(await toolAccountVisible(c.account))) {
    return bad(
      "account_not_visible_to_tool — no live TOOL session sees this ad account; an owner refreshes/adds one on Ads Manager sessions (or launch it on the LION API rail)",
    );
  }

  const accountId = acctKey(c.account);
  const pageId = c.page;
  const pixelId = c.pixel;

  // Locales: the card stores the profile's FB locale ids as strings; unknown ids (profile switched
  // under the card) are dropped, same as the LION rail's payload builder.
  const knownLocales = new Set(data.locales.map((l) => String(l.id)));
  const localeIds = [
    ...new Set(
      c.locales
        .filter((id) => knownLocales.has(id))
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  ];

  // Server-authoritative name/link — same pure builders the card preview and the other HS rails use.
  // hsFullName(...,"tool") stamps GCL TOOL in the TOKEN slot; toolEnsureMark re-ensures it server-side
  // (idempotent, and it NEVER lets a TOKEN- marker ride) so a stale/tampered client name is corrected.
  const name = toolEnsureMark(hsFullName(c, LION_ACR, todaySaoPauloDDMM(), "tool"));
  const link = hsFinalLink(c.link, c.pixel, LION_ACR, c);
  const geo = hsCountryCodes(c.countries).join(", ");
  const startTime = hsTokenStartTime();
  const currency = account.currency || "USD";

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (o: Json) => controller.enqueue(encoder.encode(JSON.stringify(o) + "\n"));
      // Mirror progress into the shared HS task row. Statics ride on EVERY write so a save racing an
      // admin row-deletion never resurrects a nameless stub (same rule as the token rail). gcm="tool"
      // is the channel marker in the reused column; started_at rides too (an interrupted run still
      // lands with an elapsed time).
      const tw = taskWriter(session.username, taskId);
      const statics: Json = { partner: "br", gcm: "tool", name, geo, budget: c.budget, started_at: Date.now() };
      let lastStage = "";
      let settled = false;
      const writeRow = (fields: Json) => tw.write({ ...statics, ...fields });
      const setStage = (wireStage: string) => {
        if (wireStage === lastStage) return;
        lastStage = wireStage;
        send({ stage: wireStage });
        writeRow({ status: "running", stage: wireStage });
      };
      const onStage = (s: ToolNdjsonStage) => setStage(wireLaunchStage(s));
      // Server-side liveness beat — a media-processing or job poll can gap for minutes with no stage
      // change; the beat re-stamps the row so teammates never read a live run as offline.
      const beat = setInterval(() => {
        if (!settled) writeRow({ status: "running", stage: lastStage || "submit" });
      }, 30_000);

      const deadlineAt = Date.now() + TOOL_DEADLINE_MS;
      let acctSlot: { documentId: string } | null = null;
      // Ads that provably landed on Facebook — reported to the fanka ledger in the finally (partial
      // runs included), exactly like the token rail.
      let landedAdIds: string[] = [];
      try {
        // 0) account launch slot (5 campaigns / 30 min per ad account, every channel — owner rule
        // 2026-08-18) — claimed before any TOOL work; released below on any pre-campaign failure.
        setStage("submit");
        acctSlot = await claimAcctSlot(accountId, {
          user: session.username,
          partner: "br",
          channel: "hs-tool",
          name,
          accountName: account.name || "",
        });

        // 1) register every creative through TOOL (media/{images|videos}/from-url with the public
        // Blob/CDN URL) and wait for each to be `ready` — a media failure must not orphan a campaign
        // (nothing is created yet). NO Idempotency-Key here: runToolMedia forwards ONE key to every
        // media POST, so on a multi-creative launch the same key would ride several from-url calls —
        // if TOOL deduped by key alone that would collapse distinct creatives. The retry-safety that
        // matters (never a second CAMPAIGN) rides on the create's key below; a re-registered media on
        // a retry is a harmless leaked media_id (spec §3 vs the launch's runToolPublish-scoped key).
        const items: ToolMediaItem[] = creatives.map((cr) => ({
          url: cr.url,
          kind: cr.kind,
          ...(cr.name ? { name: cr.name } : {}),
          ...(cr.cover ? { coverUrl: cr.cover } : {}),
        }));
        const media = await runToolMedia(toolDeps, accountId, items, { deadlineAt, onStage });
        if (!media.ok) {
          // No campaign exists → give the slot back.
          if (acctSlot) await releaseAcctSlot(acctSlot.documentId);
          acctSlot = null;
          settled = true;
          const err = `creative ${(media.index ?? 0) + 1}: ${media.error}`;
          writeRow({ status: "error", stage: lastStage, finished_at: Date.now(), error: err });
          send({ ok: false, stage: "error", error: err, via: "tool" });
          return;
        }

        // 2) build the CampaignRequest (USD budget + ROAS coefficient — lib/tool-launch does the
        // unit math; this route never touches cents/×10000) and submit it as a publish job. Each
        // creative's TOOL MediaRef (+ optional custom-cover thumbnail) rides its ad; copy/title/link/
        // cta are the card's, same as the token rail.
        const toolCreatives: ToolCreativeInput[] = creatives.map((cr, i) => ({
          name: creatives.length > 1 ? `${name} · ${i + 1}` : name,
          media: media.refs[i].media,
          ...(media.refs[i].thumbnail ? { thumbnail: media.refs[i].thumbnail } : {}),
          primaryText: c.copy,
          headline: c.title,
          url: link,
          cta: c.cta,
        }));
        const built = buildToolCampaign(
          toolInputFromCampaign(c, {
            name,
            pageId,
            pixelId,
            localeIds,
            creatives: toolCreatives,
            status: "ACTIVE", // launch → born PAUSED then activated last (options.activate)
            adsetStartTime: startTime,
            accountCurrency: currency,
          }),
        );
        if (!built.ok) {
          // A named refusal (bad objective/cta/event/currency/budget/roas) — nothing was sent.
          if (acctSlot) await releaseAcctSlot(acctSlot.documentId);
          acctSlot = null;
          settled = true;
          writeRow({ status: "error", stage: lastStage, finished_at: Date.now(), error: built.error });
          send({ ok: false, stage: "error", error: built.error, via: "tool" });
          return;
        }

        const run = await runToolPublish(toolDeps, accountId, built.body, {
          deadlineAt,
          onStage,
          ...(taskId ? { idempotencyKey: taskId } : {}),
        });

        if (run.ok) {
          landedAdIds = run.adIds;
          settled = true;
          writeRow({
            status: "done",
            stage: "ads",
            finished_at: Date.now(),
            campaign_id: run.campaignId,
            adset_id: run.adsetId,
            ad_id: String(run.adIds.length),
            error: null,
          });
          send({
            ok: true,
            stage: "done",
            name,
            link,
            start_time: startTime,
            currency,
            ad_ids: run.adIds,
            campaign_id: run.campaignId,
            adset_id: run.adsetId,
            via: "tool",
            tool_job_id: run.jobId,
          });
          return;
        }

        // Not ok: a clean refusal (nothing / a partial created), or pending (deadline hit while TOOL
        // still works). Keep the slot when a campaign may exist OR the run is pending; release it
        // only when TOOL proved nothing landed. TOOL creates PAUSED and activates last, so there is
        // nothing to pause on a partial (unlike the Graph rails).
        const created = run.created;
        landedAdIds = created?.adIds ?? [];
        const keepSlot = run.pending === true || Boolean(created?.campaignId) || landedAdIds.length > 0;
        if (acctSlot && !keepSlot) {
          await releaseAcctSlot(acctSlot.documentId);
          acctSlot = null;
        }
        settled = true;
        const errText = run.pending
          ? `TOOL is still finishing this launch past our window — verify in Ads Manager before re-firing (tool job #${run.jobId ?? "?"})`
          : run.error;
        writeRow({
          status: "error",
          stage: lastStage,
          finished_at: Date.now(),
          error: errText,
          ...(created?.campaignId ? { campaign_id: created.campaignId } : {}),
          ...(created?.adsetIds[0] ? { adset_id: created.adsetIds[0] } : {}),
          ...(landedAdIds.length ? { ad_id: String(landedAdIds.length) } : {}),
        });
        send({
          ok: false,
          stage: "error",
          error: errText,
          via: "tool",
          ...(run.jobId ? { tool_job_id: run.jobId } : {}),
          ...(run.pending ? { pending: true } : {}),
          created: {
            ...(created?.campaignId ? { campaign_id: created.campaignId } : {}),
            ...(created?.adsetIds[0] ? { adset_id: created.adsetIds[0] } : {}),
            ad_ids: landedAdIds,
          },
        });
      } catch (e) {
        // Unexpected (e.g. claimAcctSlot AcctLimitedError / registry down). No campaign exists on this
        // path (the claim throws before any TOOL call), so the slot — if somehow claimed — goes back.
        if (acctSlot) await releaseAcctSlot(acctSlot.documentId);
        acctSlot = null;
        settled = true;
        const msg = (e as Error).message ?? String(e);
        writeRow({ status: "error", stage: lastStage || "submit", finished_at: Date.now(), error: msg });
        send({ ok: false, stage: "error", error: msg, via: "tool" });
      } finally {
        clearInterval(beat);
        // Registry ledger: every ad that DID land occupies a slot on the fanka (partial runs
        // included; fire-safe — the box's next Facebook sweep reconciles either way).
        if (landedAdIds.length) await reportPagesUsed("br", [{ pageId, delta: landedAdIds.length }]);
        await tw.flush();
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
