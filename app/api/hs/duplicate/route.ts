import { NextResponse, after } from "next/server";
import { bidKind, parseMoney } from "@/lib/types";
import { hsWireBid } from "@/lib/hs-launch";
import { overrideDeadlineError } from "@/lib/launch-guards";
import { reportPagesUsed } from "@/lib/hs-pages";
import { ACCOUNT_NOT_ASSIGNED_MSG, accountAllowedFor } from "@/lib/acct-assignments";
import { sessionFromCookieHeader } from "@/lib/session";
import { readAppCache, writeAppCache } from "@/lib/app-cache";
import {
  ACCT_LIMIT,
  AcctLimitedError,
  acctKey,
  acctLimitMessage,
  acctLimitSnapshot,
  claimAcctSlot,
  releaseAcctSlot,
} from "@/lib/acct-limit";
import { stampHsTaskRow, upsertTaskRow } from "@/lib/task-store";
import {
  LionError,
  lionAccountPixels,
  lionBidStrategy,
  lionCampaignAds,
  lionConfigured,
  lionCreationStatus,
  lionDuplicate,
  lionProfileData,
  lionSetCampaignStatus,
} from "@/lib/lion";
import { hsFbGet, hsFbPost, hsTokenAccountIds, hsTokenConfigured, hsTokenGate } from "@/lib/hs-token-launch";
import {
  type GeoOverride,
  applyGeoOverride,
  geoOverrideRegionalCategories,
  parseGeoOverride,
  relabelNameGeo,
} from "@/lib/targeting-override";

export const runtime = "nodejs";
// The batch path keeps working AFTER the response (`after()` pump: jittered submits + status
// polling + clone activation) — the route's maxDuration is that pump's whole time budget.
// 800s = the Fluid-compute ceiling (fluid confirmed ON for this project 08-14): submits for a
// full 45-shot wave take ~4 min, the rest is polling headroom for LION's slow days.
export const maxDuration = 800;

const MAX_COPIES = 20;
// Batch cap: ~5s per shot (jitter + LION latency) must fit the pump's window with room for the
// poll/activate phase. Above it the board asks the buyer to fire in two waves.
const MAX_SHOTS = 45;
// Stop the pump this many ms after the request started — headroom under maxDuration so the last
// row writes land before the platform freezes the function.
const PUMP_BUDGET_MS = 770_000;

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

// Same-instance backstop for the wave claim: survives between requests on a warm function, so a
// double-POST landing on the same instance short-circuits even before the app-cache read.
// Bounded (review 08-14): a wave's retry window is seconds, so wiping the set on overflow only
// costs a fallthrough to the app-cache read — idempotency itself never depends on this cache.
const claimedWaves = new Set<string>();
function rememberWave(waveId: string): void {
  if (claimedWaves.size > 1000) claimedWaves.clear();
  claimedWaves.add(waveId);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = () => 1000 + Math.random() * 2000;

/** Shared bind validation against LION's own catalog (cached 10 min) — a shot into a disabled
 *  account or a foreign page dies invisibly on the weapon side, so it is refused here with a
 *  readable reason instead. Returns the account row on success, an error response otherwise. */
async function validateBinds(
  profile: string,
  account: string,
  page: string,
  pixel: string,
): Promise<{ error: NextResponse } | { currency: string; accountName: string; pageName: string }> {
  let data;
  try {
    data = await lionProfileData(profile);
  } catch (e) {
    const lionSide = e instanceof LionError && (e.status === undefined || e.status < 500);
    return { error: bad(lionSide ? "profile_invalid" : `lion_unreachable: ${(e as Error).message}`, lionSide ? 400 : 502) };
  }
  const acct = data.accounts.find((a) => a.id === account);
  if (!acct) return { error: bad("account_not_on_profile") };
  if (acct.status !== 1) return { error: bad("account_disabled") };
  const pageRow = data.pages.find((p) => p.id === page);
  if (!pageRow) return { error: bad("page_not_on_profile") };
  let pixels;
  try {
    pixels = await lionAccountPixels(profile, account);
  } catch (e) {
    return { error: bad(`lion_unreachable: ${(e as Error).message}`, 502) };
  }
  if (!pixels.some((p) => p.id === pixel)) return { error: bad("pixel_not_on_account") };
  // pageName feeds the geo-override patch's DSA declaration (EU-reaching overrides).
  return { currency: acct.currency || "USD", accountName: acct.name || "", pageName: pageRow.name || "" };
}

type BatchShot = {
  campaignId: string;
  budget: number;
  budgetRaw: string;
  bid: number | null;
  bidStrategy: string;
  name: string;
  geo: string;
  label: string;
  taskId: string;
  /** Geo/locales override (Targeting modal). LION's duplicate/ IGNORES targeting fields (probed
   *  live 08-20), so the pump patches the born clone's ad set through the Graph instead — which
   *  is why override shots demand a token-visible target account. */
  override: GeoOverride | null;
  lionTaskId?: string;
  cloneId?: string;
  /** Geo override landed on the clone's ad set (Graph patch verified) — finalize/activation of
   *  an override shot waits for this, so a clone can never go ACTIVE on the source's geo. */
  patched?: boolean;
  /** The newborn clone was confirmed PAUSED — belt for LION's unpredictable birth status
   *  ("ACTIVE by afternoon", lib/lion.ts): an override clone must not deliver on the source's
   *  geo while the Graph patch is still landing. finalize() re-activates after the patch. */
  hardPaused?: boolean;
  settled?: boolean;
};

/**
 * Clone existing LION campaigns into the picked binds (the playbook-proven duplicate weapon).
 *
 * Two shapes:
 * - `{shots: […]}` — the WHOLE wave in one call (fire-and-forget, owner ask 08-14): every shot's
 *   row is stamped into the shared store immediately, the response returns at once, and an
 *   `after()` pump keeps working server-side — jittered single-copy submits (the anti-profile-
 *   block pacing), then creation-status polling + the campaign reality check, activating each
 *   born-PAUSED clone and finishing its row. The buyer may close the tab right after the click;
 *   whatever the pump doesn't settle inside its window is picked up by any later tab's poller.
 * - legacy single-shot body — kept for in-flight clients from the previous build.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const startedAt = Date.now();
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) {
    return bad("unauthorized", 401);
  }
  if (!lionConfigured()) return bad("lion_not_configured", 500);

  let body: {
    profile?: string;
    account?: string;
    page?: string;
    pixel?: string;
    // ---- batch shape ----
    shots?: {
      campaignId?: string;
      budget?: string;
      /** Optional bid override in HUMAN units — scaled to the wire in the pump by the SOURCE's
       *  re-read strategy (the client's bidStrategy is only the unreadable-source fallback). */
      bid?: string;
      bidStrategy?: string;
      /** Full clone name (fixed grammar prefix + edited tail); absent = LION rebuilds it. */
      name?: string;
      geo?: string;
      /** Row title for the shared task list (source name + copy counter). */
      label?: string;
      countries?: string[];
      locales?: string[];
    }[];
    // ---- legacy single-shot shape ----
    campaignId?: string;
    copies?: number;
    budget?: string;
    bid?: string;
    bidStrategy?: string;
    nameSuffix?: string;
    name?: string;
    geo?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return bad("bad_json");
  }

  const profile = String(body.profile ?? "").trim();
  const account = String(body.account ?? "").trim();
  const page = String(body.page ?? "").trim();
  const pixel = String(body.pixel ?? "").trim();
  if (!profile) return bad("profile_required");
  if (!account) return bad("account_required");
  if (!page) return bad("page_required");
  if (!pixel) return bad("pixel_required");

  // ================= batch (fire-and-forget) =================
  if (Array.isArray(body.shots)) {
    if (body.shots.length === 0) return bad("shots_required");
    if (body.shots.length > MAX_SHOTS) return bad(`too_many_shots_max_${MAX_SHOTS}`);
    // Wave idempotency: the board keeps ONE waveId per prepared wave and re-sends it on a
    // retry-click after a lost answer. A claimed wave NEVER pumps twice — the re-POST just
    // points back at the rows already stamped. Shot task ids derive from it for the same reason
    // (a re-stamp upserts, it can't mint duplicate rows). Absent waveId (curl, older tab) mints
    // a random one — no idempotency, but nothing breaks.
    const waveIdRaw = String((body as { waveId?: unknown }).waveId ?? "").trim();
    if (waveIdRaw && !/^[a-zA-Z0-9-]{8,64}$/.test(waveIdRaw)) return bad("wave_id_invalid");
    const waveId = waveIdRaw || crypto.randomUUID();
    const shots: BatchShot[] = [];
    for (const raw of body.shots) {
      const campaignId = String(raw?.campaignId ?? "").trim();
      if (!/^\d{5,}$/.test(campaignId)) return bad("campaign_id_invalid");
      const budget = parseMoney(String(raw?.budget ?? ""));
      if (budget < 1 || budget > 10000) return bad("budget_invalid");
      const bidRaw = String(raw?.bid ?? "").trim();
      const bid = bidRaw ? parseMoney(bidRaw) : null;
      if (bidRaw && (!Number.isFinite(bid) || (bid as number) <= 0 || (bid as number) > 10000)) {
        return bad("bid_invalid");
      }
      const override = parseGeoOverride(raw?.countries, raw?.locales);
      if (override && "error" in override) return bad(`targeting_override_${override.error}`);
      shots.push({
        campaignId,
        budget,
        budgetRaw: String(raw?.budget ?? ""),
        bid,
        bidStrategy: String(raw?.bidStrategy ?? "").trim(),
        name: String(raw?.name ?? "").trim().slice(0, 200),
        geo: String(raw?.geo ?? "").slice(0, 40) || "inherited",
        label: String(raw?.label ?? "").trim().slice(0, 200),
        override,
        // Zero-padded index: the drawer breaks queued_at ties by STRING id, so "-10" must not
        // sort between "-01" and "-02" (waves share one stamp timestamp).
        taskId: `hsd-${waveId}-${String(shots.length).padStart(2, "0")}`,
      });
    }
    // Fire-time belt over the picker filter: /accounts assignments hold even for a crafted POST.
    if (!(await accountAllowedFor(session, account))) return bad(ACCOUNT_NOT_ASSIGNED_MSG, 403);
    const binds = await validateBinds(profile, account, page, pixel);
    if ("error" in binds) return binds.error;

    // Geo-override clones are patched THROUGH the Graph after LION births them (LION's own
    // duplicate/ ignores targeting fields) — that needs our partner-side token to see the target
    // account. Refuse up front, mirroring the token rail's guard; a failed sweep (null) falls
    // OPEN and the patch phase itself becomes the backstop.
    if (shots.some((s) => s.override)) {
      if (!hsTokenConfigured()) {
        return bad("targeting_override_needs_fb_token — set FB_HS_LAUNCH_TOKEN/FB_HS_VOLUME_TOKEN");
      }
      const visible = await hsTokenAccountIds();
      if (visible && !visible.has(account.replace(/^act_/, ""))) {
        return bad(
          "targeting_override_account_not_visible — geo overrides are applied via our FB token after LION builds the clone, and that token was never granted this ad account; pick a token-visible account or clear the Targeting override",
        );
      }
    }

    const alreadyAccepted = () =>
      NextResponse.json({
        ok: true,
        queued: shots.length,
        alreadyAccepted: true,
        rows: shots.map((s) => ({ taskId: s.taskId })),
        currency: binds.currency,
      });

    const waveKey = `hs-wave:${waveId}`;
    if (claimedWaves.has(waveId)) return alreadyAccepted();
    const existing = await readAppCache<{ at: number }>(waveKey);
    if (existing?.value?.at) {
      rememberWave(waveId);
      return alreadyAccepted();
    }

    // Geo-override waves also need a live bearer for the Graph patch — checked AFTER the
    // idempotency answers above (a re-POST of an accepted wave must say alreadyAccepted, not
    // 429 off a pool its own patches burned); with the whole pool down the clones would be born
    // stuck on the source geo, so refuse before any row is stamped (review find 08-24).
    if (shots.some((s) => s.override)) {
      const gate = await hsTokenGate();
      if (!gate.ok) return bad(`targeting_override_blocked — ${gate.error}`, 429);
    }

    // ---- account launch-limit precheck (5 campaigns / 30 min per ad account, owner rule
    // 2026-08-18): the whole wave lands in ONE account, so an over-capacity wave is refused up
    // front with the countdown instead of stamping rows destined to fail. Runs AFTER the wave-
    // idempotency checks (a re-POST of an already-pumped wave must answer alreadyAccepted, not
    // 429 off its own consumed slots). The per-shot claim in the pump stays the authority.
    {
      let snap;
      try {
        snap = await acctLimitSnapshot();
      } catch {
        return bad("acct_limit_unavailable — wave blocked (launch registry unreachable)", 503);
      }
      const info = snap.accounts[acctKey(account)];
      const remaining = ACCT_LIMIT - (info?.count ?? 0);
      if (info && remaining <= 0) return bad(acctLimitMessage(info.resetAt), 429);
      if (shots.length > remaining) {
        const tail = info ? ` — ${acctLimitMessage(info.resetAt)}` : "";
        return bad(
          `account_limit — only ${Math.max(0, remaining)} of ${shots.length} clones fit this account's 30-min window${tail}`,
          429,
        );
      }
    }

    // Rows land in the shared store BEFORE the claim and the response: the team (and this
    // buyer's next tab) sees the wave as queued even if the browser closes on the very next
    // tick, and a crash between stamping and claiming stays retryable (the re-POST re-stamps
    // the SAME wave-derived ids — pure upserts — and then claims and pumps normally).
    await Promise.all(
      shots.map((s) =>
        stampHsTaskRow(session.username, {
          taskId: s.taskId,
          name: s.name || s.label || `Clone of ${s.campaignId}`,
          geo: s.geo,
          budget: s.budgetRaw,
          lionTaskId: "", // pending — the pump fills it as each shot lands on LION
          kind: "duplicate",
          // Override shots are born behind the geo gate: activate (server + client poller)
          // refuses "geo-gate" rows until the pump's verified patch stamps them "patched".
          ...(s.override ? { stage: "geo-gate" } : {}),
        }),
      ),
    );

    // Claim the wave — the ONE gate before the pump. An already-claimed wave means another POST
    // (whose answer the client may have lost) already started this exact pump — starting a second
    // one would double every campaign, so the re-POST answers success and stops. Best-effort by
    // design (app-cache degrades to null on outages): the human retry-click this guards against
    // comes seconds later, well inside the read path.
    const claimed = await writeAppCache(waveKey, { at: Date.now(), n: shots.length });
    if (claimed === null) {
      // Lost the unique-ckey race → someone else claimed this wave between read and write.
      const winner = await readAppCache<{ at: number }>(waveKey);
      if (winner?.value?.at) {
        rememberWave(waveId);
        return alreadyAccepted();
      }
      // Store unavailable → FAIL CLOSED (review 08-14): without a persisted claim, a retry of
      // this wave could pump twice and double every campaign. Money invariant beats
      // availability — the buyer just re-fires when the store is back. (The stamped rows, if
      // any landed, are harmless upserts of the same ids.)
      return bad("task_store_unavailable_wave_not_fired", 503);
    }
    rememberWave(waveId);

    const user = session.username;
    const deadline = startedAt + PUMP_BUDGET_MS;
    after(() =>
      pumpBatch(
        user,
        { profile, account, page, pixel, accountName: binds.accountName, pageName: binds.pageName },
        shots,
        deadline,
      ),
    );

    return NextResponse.json({
      ok: true,
      queued: shots.length,
      rows: shots.map((s) => ({ taskId: s.taskId })),
      currency: binds.currency,
    });
  }

  // ================= legacy single shot =================
  const campaignId = String(body.campaignId ?? "").trim();
  const copies = Number(body.copies ?? 1);
  const nameSuffix = String(body.nameSuffix ?? "").trim().slice(0, 80);
  const name = String(body.name ?? "").trim().slice(0, 200);

  // LION campaign ids are the REAL FB ids — digits only.
  if (!/^\d{5,}$/.test(campaignId)) return bad("campaign_id_invalid");
  if (!Number.isInteger(copies) || copies < 1 || copies > MAX_COPIES) return bad("copies_invalid");
  // $1 floor mirrors the launch guard; budget rides as integer CENTS of the account currency.
  const budget = parseMoney(String(body.budget ?? ""));
  if (budget < 1 || budget > 10000) return bad("budget_invalid");
  const bidRaw = String(body.bid ?? "").trim();
  const bid = bidRaw ? parseMoney(bidRaw) : null;
  if (bidRaw && (!Number.isFinite(bid) || (bid as number) <= 0 || (bid as number) > 10000)) {
    return bad("bid_invalid");
  }

  // Fire-time belt over the picker filter (legacy single-shot path) — same /accounts contract.
  if (!(await accountAllowedFor(session, account))) return bad(ACCOUNT_NOT_ASSIGNED_MSG, 403);
  const binds = await validateBinds(profile, account, page, pixel);
  if ("error" in binds) return binds.error;

  // ---- bid override → Meta-native wire unit (only when a bid was typed) ----
  // LION forwards starting_bid to the Graph verbatim (hsWireBid doc), so the human decimal must
  // be scaled by the SOURCE's strategy: ROAS × 10000, cap $ × 100. The strategy is re-read from
  // LION here (authoritative); the board's snapshot only covers the "source unreadable right
  // now" lag. No resolvable strategy, or a lowest-cost source → refuse rather than guess: an
  // unscaled/mis-scaled bid creates a wedged CREATING_ADSET task (live 08-10) or a silently
  // absurd bid, and "clear the Bid to inherit" is always available.
  let startingBid: number | undefined;
  if (bid != null) {
    const clientStrategy = String(body.bidStrategy ?? "").trim();
    const strategy = (await lionBidStrategy(campaignId)) || clientStrategy;
    if (!strategy) return bad("bid_strategy_unresolved_clear_bid_to_inherit");
    const kind = bidKind(strategy);
    if (kind === "none") return bad("bid_not_applicable_to_lowest_cost_source");
    // ROAS goals live in 0.001..1000 at Meta; the board caps at 100 (create-side parity).
    if (kind === "roas" && bid > 100) return bad("roas_goal_invalid");
    const wire = hsWireBid(bid, strategy, "lion");
    // For ROAS the null also covers the ambiguous 10–20 band (percent? ×10 slip?) — name it.
    if (wire == null)
      return bad(kind === "roas" ? "roas_goal_ambiguous — type the decimal goal (0,30 = 30%)" : "bid_invalid");
    startingBid = wire;
  }

  // Account launch slots (5 campaigns / 30 min per ad account): the legacy shape creates
  // `copies` clones in ONE LION call, so it needs `copies` slots up front. Limited/store-down
  // mid-claim → everything just claimed goes back and the request is refused with the countdown.
  const acctSlots: string[] = [];
  try {
    for (let i = 0; i < copies; i++) {
      const s = await claimAcctSlot(acctKey(account), {
        user: session.username,
        partner: "br",
        channel: "hs-dup",
        name: name || `Clone of ${campaignId}`,
        accountName: binds.accountName || "",
      });
      acctSlots.push(s.documentId);
    }
  } catch (e) {
    await Promise.all(acctSlots.map((d) => releaseAcctSlot(d)));
    if (e instanceof AcctLimitedError) return bad(e.message, 429);
    return bad((e as Error).message ?? String(e), 503);
  }

  // ---- submit ----
  try {
    const result = await lionDuplicate({
      profile_slug: profile,
      account_id: account,
      page_id: page,
      pixel_id: pixel,
      campaign_id: campaignId,
      starting_budget: Math.round(budget * 100),
      number_of_copies: copies,
      name_suffix: nameSuffix,
      ...(startingBid != null ? { starting_bid: startingBid } : {}),
      ...(name ? { name } : {}),
    });
    const taskIds = (result.task_ids ?? []).map(String).filter(Boolean);
    if ((result.result === "success" || taskIds.length > 0) && taskIds.length > 0) {
      // Server-mint a client task id per copy and stamp each row NOW (durability): the team sees
      // the clones and their polls resume from the LION ids even if this browser closes. Returned
      // as {taskId ↔ lionTaskId} pairs so the client's Task Manager rows use the same ids.
      const rows = taskIds.map((lionTaskId) => ({
        taskId: `hsd-${crypto.randomUUID()}`,
        lionTaskId,
      }));
      await Promise.all(
        rows.map((r, i) =>
          stampHsTaskRow(session.username, {
            taskId: r.taskId,
            name: name || `Clone of ${campaignId}${rows.length > 1 ? ` · copy ${i + 1}/${rows.length}` : ""}`,
            geo: String(body.geo ?? "").slice(0, 40) || "inherited",
            budget: String(body.budget ?? ""),
            lionTaskId: r.lionTaskId,
            kind: "duplicate",
          }),
        ),
      );
      // LION accepted fewer copies than asked → the surplus slots go back to the pool.
      if (acctSlots.length > taskIds.length) {
        await Promise.all(acctSlots.slice(taskIds.length).map((d) => releaseAcctSlot(d)));
      }
      // Registry ledger, optimistically at submit: each accepted copy re-creates every source ad
      // on the bind fanka (fire-safe; failed LION tasks reconcile on the box's next sweep).
      await reportPagesUsed("br", [{ pageId: page, delta: (await sourceAdsCount(campaignId)) * taskIds.length }]);
      return NextResponse.json({ ok: true, rows, taskIds, currency: binds.currency });
    }
    // Preflight rejection — LION's reason is the actionable text ("No valid creative URL found
    // in campaign ads" = object-story source → not duplicable; dead/unreadable source; …).
    // Nothing was created → every claimed slot goes back.
    await Promise.all(acctSlots.map((d) => releaseAcctSlot(d)));
    return bad(result.reason || `LION rejected the duplicate (${result.result ?? "no result"})`);
  } catch (e) {
    // 404 plain-text bodies ("Page not found in account data", "Pixel not found for account")
    // surface verbatim — they are the actionable reason, not a transport failure. A 4xx is a
    // clean LION-side refusal (no clones created → slots released); 5xx/transport is ambiguous —
    // the clones may exist, so the slots stay consumed.
    const status = e instanceof LionError && e.status && e.status < 500 ? 400 : 502;
    if (status === 400) await Promise.all(acctSlots.map((d) => releaseAcctSlot(d)));
    return bad(`lion_duplicate_failed: ${(e as Error).message}`, status);
  }
}

/** Ads one clone of a source re-creates (each copy replicates every source ad) — a details/
 *  read for the registry ledger. Unreadable sources count as 1: a clone carries at least one ad,
 *  and the box's Facebook sweep replaces the estimate with facts anyway. */
async function sourceAdsCount(campaignId: string): Promise<number> {
  try {
    return Math.max((await lionCampaignAds([campaignId]))[campaignId]?.adsCount ?? 0, 1);
  } catch {
    return 1;
  }
}

/** Best-effort row update — the pump must never die on a Strapi hiccup (the client-side pollers
 *  are the fallback truth-writers, done rows are server-side sticky). */
const rowWrite = (user: string, taskId: string, fields: Record<string, unknown>) =>
  upsertTaskRow(user, taskId, { ...fields, partner: "br" }).then(
    () => undefined,
    () => undefined,
  );

/**
 * The fire-and-forget worker behind the batch shape. Runs after the response:
 * 1) submits the shots ONE AT A TIME with a random 1–3s gap (firing a wave at once is what gets
 *    the executor profile temporarily blocked — playbook pacing, same as the old client pump);
 *    a preflight rejection kills the source's remaining copies instantly, like the board did;
 * 2) then polls creation-status every ~10s, cross-checking reality (details/) every ~40s, and
 *    ACTIVATEs every finished clone (born PAUSED) before marking its row done.
 * Whatever is still unsettled at the deadline stays `submitted` in the store — any later
 * adlauncher tab's poller (or a retried wave) finishes the bookkeeping; the campaigns themselves
 * are safe on LION either way.
 */
async function pumpBatch(
  user: string,
  binds: { profile: string; account: string; page: string; pixel: string; accountName?: string; pageName?: string },
  shots: BatchShot[],
  deadline: number,
): Promise<void> {
  try {
    const strategyCache = new Map<string, string>();
    const adsCountCache = new Map<string, number>();
    const familyFailed = new Map<string, string>();

    // ---- phase 1: jittered submits ----
    for (let i = 0; i < shots.length; i++) {
      // Window exhausted mid-wave (LION crawling — each call may burn up to its 60s timeout):
      // mark every not-yet-fired shot explicitly instead of leaving silent "running" rows the
      // platform kill would strand (review 08-14), then stop. Re-firing is the buyer's call.
      if (Date.now() > deadline - 30_000) {
        for (let j = i; j < shots.length; j++) {
          const rest = shots[j];
          if (rest.settled || rest.lionTaskId) continue;
          rest.settled = true;
          await rowWrite(user, rest.taskId, {
            status: "error",
            error: "Not submitted — the wave's server window closed before this shot (LION was slow). Re-fire it in the duplicator.",
            finished_at: Date.now(),
          });
        }
        break;
      }
      const s = shots[i];
      if (familyFailed.has(s.campaignId)) {
        s.settled = true;
        await rowWrite(user, s.taskId, {
          status: "error",
          error: familyFailed.get(s.campaignId),
          finished_at: Date.now(),
        });
        continue;
      }
      let slotDoc: string | null = null;
      try {
        let startingBid: number | undefined;
        if (s.bid != null) {
          let strategy = strategyCache.get(s.campaignId);
          if (strategy === undefined) {
            strategy = (await lionBidStrategy(s.campaignId)) || s.bidStrategy;
            strategyCache.set(s.campaignId, strategy);
          }
          const kind = strategy ? bidKind(strategy) : "none";
          const wire =
            strategy && kind !== "none" && !(kind === "roas" && s.bid > 100) ? hsWireBid(s.bid, strategy, "lion") : null;
          if (wire == null) {
            // Deterministic per source — the same bid re-fails every copy.
            const reason = "bid not applicable/resolvable for this source — clear the Bid to inherit";
            familyFailed.set(s.campaignId, reason);
            s.settled = true;
            await rowWrite(user, s.taskId, { status: "error", error: reason, finished_at: Date.now() });
            continue;
          }
          startingBid = wire;
        }
        // Account launch slot (5 campaigns / 30 min per ad account) — claimed right before the
        // submit; released on a clean preflight rejection below, KEPT on ambiguous outcomes
        // (the clone may exist on LION). A full window stops the whole wave in the catch.
        slotDoc = (
          await claimAcctSlot(acctKey(binds.account), {
            user,
            partner: "br",
            channel: "hs-dup",
            name: s.name || s.label || `Clone of ${s.campaignId}`,
            accountName: binds.accountName || "",
          })
        ).documentId;
        const result = await lionDuplicate({
          profile_slug: binds.profile,
          account_id: binds.account,
          page_id: binds.page,
          pixel_id: binds.pixel,
          campaign_id: s.campaignId,
          starting_budget: Math.round(s.budget * 100),
          number_of_copies: 1, // single-copy shots → controllable pacing, gentler on the profile
          name_suffix: "",
          ...(startingBid != null ? { starting_bid: startingBid } : {}),
          ...(s.name ? { name: s.name } : {}),
        });
        const lionTaskId = (result.task_ids ?? []).map(String).filter(Boolean)[0];
        if (lionTaskId) {
          s.lionTaskId = lionTaskId;
          // started_at = the REAL submit moment (rows are stamped minutes earlier): the drawer's
          // elapsed timer and the 3h cap then measure time ON LION, not time in our queue.
          await rowWrite(user, s.taskId, { link: lionTaskId, started_at: Date.now() });
          // Registry ledger, optimistically at submit: this copy re-creates every source ad on
          // the bind fanka (fire-safe; failed LION tasks reconcile on the box's next sweep).
          let srcAds = adsCountCache.get(s.campaignId);
          if (srcAds === undefined) {
            srcAds = await sourceAdsCount(s.campaignId);
            adsCountCache.set(s.campaignId, srcAds);
          }
          await reportPagesUsed("br", [{ pageId: binds.page, delta: srcAds }]);
        } else {
          // Preflight rejection kills the whole family (object-story creatives, dead source…).
          // No clone was created → the account slot goes back to the pool.
          await releaseAcctSlot(slotDoc);
          const reason = result.reason || `LION rejected the duplicate (${result.result ?? "no result"})`;
          familyFailed.set(s.campaignId, reason);
          s.settled = true;
          await rowWrite(user, s.taskId, { status: "error", error: reason, finished_at: Date.now() });
        }
      } catch (e) {
        // Account window full / limit registry down: every later shot targets the SAME account,
        // so settle them all with the countdown message and stop submitting (deterministic —
        // the pump's whole budget fits inside one 30-min window).
        if (e instanceof AcctLimitedError || /acct_limit_unavailable/.test(String((e as Error).message ?? ""))) {
          const msg = (e as Error).message ?? String(e);
          for (let j = i; j < shots.length; j++) {
            const rest = shots[j];
            if (rest.settled || rest.lionTaskId) continue;
            rest.settled = true;
            await rowWrite(user, rest.taskId, { status: "error", error: msg, finished_at: Date.now() });
          }
          break;
        }
        const msg = `lion_duplicate_failed: ${(e as Error).message ?? e}`;
        // 4xx = LION-side semantic answer (page/pixel not in account data…) — deterministic for
        // the family (and no clone was created → the slot goes back); 5xx/transport may be
        // transient AND ambiguous, so only this shot is marked and the slot stays consumed.
        if (e instanceof LionError && e.status && e.status < 500) {
          familyFailed.set(s.campaignId, msg);
          await releaseAcctSlot(slotDoc);
        }
        s.settled = true;
        await rowWrite(user, s.taskId, { status: "error", error: msg, finished_at: Date.now() });
      }
      if (i < shots.length - 1) await sleep(jitter());
    }

    // ---- phase 2: poll + activate + finish rows ----
    const activated = new Set<string>();
    const finalize = async (s: BatchShot, cloneId: string, adCount: number) => {
      s.settled = true;
      if (!activated.has(cloneId)) {
        activated.add(cloneId);
        // "does not have permission" = already active = success (playbook) — helper handles it.
        await lionSetCampaignStatus(cloneId, "ACTIVE").catch(() => {});
      }
      await rowWrite(user, s.taskId, {
        status: "done",
        stage: "ads",
        campaign_id: cloneId,
        ad_id: String(adCount),
        finished_at: Date.now(),
      });
    };

    let lastReality = 0;
    while (Date.now() < deadline) {
      const pending = shots.filter((s) => s.lionTaskId && !s.settled);
      if (pending.length === 0) break;
      try {
        const tasks = await lionCreationStatus([...new Set(pending.map((s) => s.lionTaskId as string))]);
        const byId = new Map(tasks.map((t) => [String(t.task_id ?? ""), t]));
        for (const s of pending) {
          const r = byId.get(s.lionTaskId as string);
          if (!r) continue;
          if (r.campaign_id && !s.cloneId) {
            s.cloneId = String(r.campaign_id);
            // Persist the clone id the moment it exists: if LION then takes HOURS (congestion)
            // and prunes the finished record before anyone watches again, a later tab can still
            // find the campaign via the reality check and activate it — without this the clone
            // could sit PAUSED unnoticed.
            await rowWrite(user, s.taskId, {
              campaign_id: s.cloneId,
              // Re-assert the gate next to the campaign id: any activation path that reads the
              // row must see the clone is still unpatched (belt over the stamp-time mark).
              ...(s.override && !s.patched ? { stage: "geo-gate" } : {}),
            });
          }
          // Geo override: patch the born clone's ad set through the Graph BEFORE any finalize —
          // an override shot must never go ACTIVE on the source's geo. The adset exists while
          // the task still reads CREATING_ADS (probed live 08-20, ~40-70s after submit);
          // transient misses just retry next tick (every step is idempotent).
          if (s.cloneId && s.override && !s.patched) {
            // Belt for LION's unpredictable birth status ("ACTIVE by afternoon" — lib/lion.ts):
            // force the newborn PAUSED before patching, so a clone born live can't deliver on the
            // source's geo while the patch is still landing. Retried every tick until confirmed;
            // finalize() re-activates once the verified patch is in.
            if (!s.hardPaused) {
              const paused = await lionSetCampaignStatus(s.cloneId, "PAUSED");
              if (paused.ok) s.hardPaused = true;
            }
            try {
              await patchCloneTargeting(s.cloneId, s.override, binds.pageName ?? "", s.name);
              s.patched = true;
              // "patched" lifts the geo gate — /api/hs/activate and the client poller may flip
              // the clone from here on (finalize below normally does it first).
              await rowWrite(user, s.taskId, { geo: s.geo, stage: "patched" });
            } catch {
              /* adset not born yet / throttled — next tick */
            }
          }
          if (r.status === "COMPLETED" && r.campaign_id && (!s.override || s.patched)) {
            await finalize(s, String(r.campaign_id), (r.ad_ids ?? []).length || 1);
          } else if (r.status === "NO_COUNTRIES_LEFT") {
            s.settled = true;
            await rowWrite(user, s.taskId, {
              status: "error",
              error: "LION: no eligible countries left for this campaign",
              finished_at: Date.now(),
            });
          }
          // NOT_FOUND / CREATING_*: the reality check below settles them (task records wedge
          // and prune — live 08-13); anything left rides the store for a later tab.
        }
        if (Date.now() - lastReality > 40_000) {
          lastReality = Date.now();
          const ids = [...new Set(shots.filter((s) => !s.settled && s.cloneId).map((s) => s.cloneId as string))];
          if (ids.length > 0) {
            const real = await lionCampaignAds(ids).catch(() => ({}) as Record<string, never>);
            for (const s of shots.filter((x) => !x.settled && x.cloneId)) {
              const c = (real as Record<string, { status: string; adsCount: number } | undefined>)[s.cloneId as string];
              // Override shots wait for the patch here too — same activation gate as above.
              if (c && c.adsCount > 0 && (!s.override || s.patched)) await finalize(s, s.cloneId as string, c.adsCount);
            }
          }
        }
      } catch {
        /* transient LION/store blip — next tick retries */
      }
      if (Date.now() >= deadline) break;
      await sleep(10_000);
    }

    // Deadline hit with an unpatched override: the clone EXISTS but still targets the source's
    // geo — and the activation gate only withholds OUR activation, it cannot undo an ACTIVE
    // birth. Pause it now (or stand on the earlier confirmed pause) and tell the buyer the true
    // state instead of letting a later poller quietly activate the wrong geo.
    for (const s of shots) {
      if (s.settled || !s.override || s.patched || !s.cloneId) continue;
      s.settled = true;
      const pausedOk = s.hardPaused || (await lionSetCampaignStatus(s.cloneId, "PAUSED")).ok;
      await rowWrite(user, s.taskId, {
        status: "error",
        error: overrideDeadlineError(s.cloneId, pausedOk),
        campaign_id: s.cloneId,
        finished_at: Date.now(),
      });
    }
  } catch {
    /* the pump must never throw into the runtime — rows left running are picked up later */
  }
}

/**
 * Apply a geo override to a freshly-born LION clone THROUGH the Graph (partner-side token):
 * patch the ad set's targeting (+ WW universal-ads declarations + the DSA beneficiary/payor
 * LION's duplicate never sets), rename the campaign to the board's relabeled name (LION ignores
 * duplicate `name` — probed live 08-20), and VERIFY the stored geo before reporting success.
 * Throws on any miss; the pump's poll loop retries and every step is idempotent.
 */
async function patchCloneTargeting(
  campaignId: string,
  o: GeoOverride,
  pageName: string,
  newName: string,
): Promise<void> {
  type Json = Record<string, unknown>;
  const camp = await hsFbGet(`${campaignId}?fields=name,adsets{id}`);
  const adsetId = String((camp.adsets as { data?: { id?: string }[] } | undefined)?.data?.[0]?.id ?? "");
  if (!adsetId) throw new Error("adset_not_born_yet");
  const cur = await hsFbGet(`${adsetId}?fields=targeting`);
  const patched = applyGeoOverride((cur.targeting ?? {}) as Json, o);
  const cats = geoOverrideRegionalCategories(o);
  await hsFbPost(adsetId, {
    targeting: patched,
    ...(cats.length ? { regional_regulated_categories: cats } : {}),
    ...(pageName ? { dsa_beneficiary: pageName, dsa_payor: pageName } : {}),
  });
  // Rename: the board's relabeled name when it sent one; otherwise re-derive the geo label from
  // LION's auto-name server-side — the [CODES] group their ecosystem parses geo from must never
  // keep the SOURCE's countries on a clone that now targets the override (review find 08-24).
  const rename = newName || relabelNameGeo(String(camp.name ?? ""), o.countries);
  if (rename && rename !== String(camp.name ?? "")) await hsFbPost(campaignId, { name: rename });
  if (o.countries.length) {
    const ver = await hsFbGet(`${adsetId}?fields=targeting`);
    const geo = ((ver.targeting as Json | undefined)?.geo_locations ?? {}) as Json;
    const ww = o.countries.includes("WW");
    const got = (ww ? geo.country_groups : geo.countries) as string[] | undefined;
    const want = ww ? ["worldwide"] : o.countries;
    const norm = (a?: string[]) => [...(a ?? [])].sort().join(",");
    if (norm(got) !== norm(want)) throw new Error(`geo_verify_mismatch ${JSON.stringify(geo)}`);
  }
}
