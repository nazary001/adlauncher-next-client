import { NextResponse, after } from "next/server";
import { bidKind, bidTag, parseMoney } from "@/lib/types";
import { LION_NAME_SUFFIX_MAX } from "@/lib/hs-clone-name";
import { SUPPORTED_BID_STRATEGIES } from "@/lib/fb-launch";
import { hsWireBid } from "@/lib/hs-launch";
import { hsPageRefusal, reportPagesUsed } from "@/lib/hs-pages";
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
import { stampHsTaskRow } from "@/lib/task-store";
import { LionError, lionAccountPixels, lionCampaignAds, lionConfigured, lionDuplicate, lionProfileData, lionSourceBidFacts } from "@/lib/lion";
import { acctLimitRefusal, bindsKey, demandByAccount, distinctBy, resolveShotBinds } from "@/lib/hs-shot-binds";
import { parseGeoOverride } from "@/lib/targeting-override";
import type { LionLocale } from "@/lib/lion";
import type { HsDupShot } from "@/lib/hs-dup-shot";
import { LION_FOLLOW_MAX_MS } from "@/lib/launch-queue-types";
import { acceptServerJobs, pumpLane, selfOrigin } from "@/lib/launch-queue-run";

export const runtime = "nodejs";
// The batch shape queues one durable job per shot (09.10) and the hand-off answers at once — but
// the SAME invocation hosts the lane pump's first budget window (after(pumpLane)), so maxDuration is
// the pump's, not the hand-off's. 800s = the Fluid-compute ceiling.
export const maxDuration = 800;

const MAX_COPIES = 20;
// Batch cap kept from the wave pump days: the board asks the buyer to fire above it in two waves.
const MAX_SHOTS = 45;

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

/** Shared bind validation against LION's own catalog (cached 10 min) — a shot into a disabled
 *  account or a foreign page dies invisibly on the weapon side, so it is refused here with a
 *  readable reason instead. Returns the account row on success, an error response otherwise. */
async function validateBinds(
  profile: string,
  account: string,
  page: string,
  pixel: string,
): Promise<{ error: NextResponse } | { currency: string; accountName: string; pageName: string; locales: LionLocale[] }> {
  let data;
  try {
    data = await lionProfileData(profile);
  } catch (e) {
    const lionSide = e instanceof LionError && (e.status === undefined || e.status < 500);
    return { error: bad(lionSide ? "profile_invalid" : `lion_unreachable: ${(e as Error).message}`, lionSide ? 400 : 502) };
  }
  // Per-row destinations (09-08) mean one wave can carry several tuples — the refusal names the
  // ids so the buyer knows WHICH row's pick is off.
  const acct = data.accounts.find((a) => a.id === account);
  if (!acct) return { error: bad(`account_not_on_profile — ${account} is not on ${profile}`) };
  if (acct.status !== 1) return { error: bad(`account_disabled — ${account}`) };
  const pageRow = data.pages.find((p) => p.id === page);
  if (!pageRow) return { error: bad(`page_not_on_profile — page ${page} is not on ${profile}`) };
  // Owner rule 2026-09-07: clones may only land on fankas hs-tools marks OK (belt over the
  // picker filter — profile-data hides the rest).
  const fankaRefusal = await hsPageRefusal("br", [pageRow]);
  if (fankaRefusal) return { error: bad(fankaRefusal.error, fankaRefusal.status) };
  let pixels;
  try {
    pixels = await lionAccountPixels(profile, account);
  } catch (e) {
    return { error: bad(`lion_unreachable: ${(e as Error).message}`, 502) };
  }
  if (!pixels.some((p) => p.id === pixel)) return { error: bad(`pixel_not_on_account — pixel ${pixel} is not on ${account}`) };
  // The profile's FB locale list resolves a targeting override's locale ids into LION's { name, id }.
  return { currency: acct.currency || "USD", accountName: acct.name || "", pageName: pageRow.name || "", locales: data.locales };
}

type BatchShot = HsDupShot & { taskId: string };

/**
 * Clone existing LION campaigns into the picked binds (the playbook-proven duplicate weapon).
 *
 * Two shapes:
 * - `{shots: […]}` — the WHOLE wave in one call: every shot is validated here (binds against
 *   LION's catalog, assignments, the launch-limit precheck), then handed to the durable server
 *   queue as ONE JOB PER SHOT (09.10 — lib/hs-dup-shot runs the submit, lib/hs-follow-core polls
 *   LION and activates the born-PAUSED clone), plus the wave's follow-up job. The response returns
 *   at once; leases, the every-minute sweep and server Retry take it from there — the buyer may
 *   close the tab right after the click, and nothing a tab did (polling, activation) is needed.
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
      /** Optional bid override in HUMAN units — scaled to the wire by the clone's EFFECTIVE
       *  strategy (the source's re-read one, or the row's switch; the client's bidStrategy is
       *  only the unreadable-source fallback). */
      bid?: string;
      bidStrategy?: string;
      /** Per-row strategy switch (owner ask 09-09, LION duplicate v2): any of the four
       *  strategies — ROAS ↔ cap ↔ cost cap ↔ lowest. "" = the source's. A switched cap/ROAS row
       *  must carry a typed `bid` (nothing inherits across strategies). */
      bidStrategyOverride?: string;
      /** Display-only bid/ROAS tag (bidTag) for the monitor card — forwarded verbatim to the row. */
      bidLabel?: string;
      /** Full clone name (fixed grammar prefix + edited tail) — the row title and the Graph rename.
       *  LION's duplicate/ never reads it (not in its contract). */
      name?: string;
      /** The buyer's addition beyond the source's tail (lib/hs-clone-name) — the ONLY naming input
       *  LION's duplicate/ honours, appended verbatim as `name_suffix`. */
      suffix?: string;
      geo?: string;
      /** Row title for the shared task list (source name + copy counter). */
      label?: string;
      countries?: string[];
      locales?: string[];
      /** Per-shot destination (09-08) — any field absent rides the wave-level one. */
      profile?: string;
      account?: string;
      page?: string;
      pixel?: string;
    }[];
    // ---- legacy single-shot shape ----
    campaignId?: string;
    copies?: number;
    budget?: string;
    bid?: string;
    bidStrategy?: string;
    bidLabel?: string;
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
  // Wave-level binds are the DEFAULTS for shots that carry none (batch shape) and the only
  // binds of the legacy shape — each shape checks completeness where it resolves them.
  const waveBinds = { profile, account, page, pixel };

  // ================= batch (queued, one job per shot) =================
  if (Array.isArray(body.shots)) {
    if (body.shots.length === 0) return bad("shots_required");
    if (body.shots.length > MAX_SHOTS) return bad(`too_many_shots_max_${MAX_SHOTS}`);
    // Wave idempotency: the board keeps ONE waveId per prepared wave and re-sends it on a
    // retry-click after a lost answer. Shot task ids derive from it — the queue's job ids — so a
    // re-POST meets its own jobs and answers accepted without a second submit. Absent waveId
    // (curl, older tab) mints a random one — no idempotency, but nothing breaks.
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
      // The strategy switch is validated against the four strategies LION's duplicate v2 (and
      // our payload builders) support — junk would only die inside LION's task.
      const strategyOverride = String(raw?.bidStrategyOverride ?? "").trim();
      if (strategyOverride && !SUPPORTED_BID_STRATEGIES.has(strategyOverride)) return bad("bid_strategy_invalid");
      // The shot's own destination over the wave defaults (per-row binds, 09-08).
      const shotBinds = resolveShotBinds(raw, waveBinds, true);
      if ("error" in shotBinds) return bad(shotBinds.error);
      shots.push({
        campaignId,
        budget,
        budgetRaw: String(raw?.budget ?? ""),
        bid,
        bidStrategy: String(raw?.bidStrategy ?? "").trim(),
        bidStrategyOverride: strategyOverride,
        bidLabel: String(raw?.bidLabel ?? "").trim().slice(0, 40),
        currency: "",
        name: String(raw?.name ?? "").trim().slice(0, 200),
        suffix: String(raw?.suffix ?? "").trim().slice(0, LION_NAME_SUFFIX_MAX),
        geo: String(raw?.geo ?? "").slice(0, 40) || "inherited",
        label: String(raw?.label ?? "").trim().slice(0, 200),
        override,
        profileLocales: [],
        // Zero-padded index: the drawer breaks queued_at ties by STRING id, so "-10" must not
        // sort between "-01" and "-02" (waves share one stamp timestamp).
        taskId: `hsd-${waveId}-${String(shots.length).padStart(2, "0")}`,
        binds: shotBinds,
        accountName: "",
        pageName: "",
      });
    }
    // Fire-time belt over the picker filter: /accounts assignments hold even for a crafted POST
    // — for EVERY account the wave targets.
    for (const acct of distinctBy(shots, (s) => s.binds.account)) {
      if (!(await accountAllowedFor(session, acct))) return bad(`${ACCOUNT_NOT_ASSIGNED_MSG} (${acct})`, 403);
    }
    // Catalog validation ONCE per distinct bind tuple (the whole wave used to share one).
    const validated = new Map<string, { currency: string; accountName: string; pageName: string; locales: LionLocale[] }>();
    for (const s of shots) {
      const key = bindsKey(s.binds);
      let v = validated.get(key);
      if (!v) {
        const r = await validateBinds(s.binds.profile, s.binds.account, s.binds.page, s.binds.pixel);
        if ("error" in r) return r.error;
        v = r;
        validated.set(key, v);
      }
      s.accountName = v.accountName;
      s.pageName = v.pageName;
      s.currency = v.currency;
      s.profileLocales = v.locales;
    }
    const currency = validated.values().next().value?.currency ?? "USD";

    const alreadyAccepted = () =>
      NextResponse.json({
        ok: true,
        queued: shots.length,
        alreadyAccepted: true,
        rows: shots.map((s) => ({ taskId: s.taskId })),
        currency,
      });

    const waveKey = `hs-wave:${waveId}`;
    if (claimedWaves.has(waveId)) return alreadyAccepted();
    const existing = await readAppCache<{ at: number }>(waveKey);
    if (existing?.value?.at) {
      rememberWave(waveId);
      return alreadyAccepted();
    }

    // ---- account launch-limit precheck (5 campaigns / 30 min per ad account, owner rule
    // 2026-08-18): EVERY account the wave targets must take its share (per-row destinations,
    // 09-08), else the wave is refused up front with the countdown instead of queuing jobs
    // destined to fail. Runs AFTER the wave-idempotency checks (a re-POST of an already-queued
    // wave must answer alreadyAccepted, not 429 off its own consumed slots). The per-shot claim
    // in the job stays the authority.
    {
      let snap;
      try {
        snap = await acctLimitSnapshot();
      } catch {
        return bad("acct_limit_unavailable — wave blocked (launch registry unreachable)", 503);
      }
      const refusal = acctLimitRefusal(
        demandByAccount(shots, (s) => s.binds.account),
        snap.accounts,
        ACCT_LIMIT,
        acctLimitMessage,
      );
      if (refusal) return bad(refusal.error, refusal.status);
    }

    // The hand-off to the durable queue: rows are stamped and one job per shot inserted (a task id
    // that already exists is reported accepted, never re-stamped), plus the wave's follow-up (poll
    // LION + activate), in the owner's lanes. Fail CLOSED: a store that cannot take the wave refuses
    // it — nothing half-accepted, the buyer re-fires when the store is back.
    const user = session.username;
    const res = await acceptServerJobs(
      { username: user, role: session.role ?? null, sub: session.sub },
      "hs",
      waveId,
      shots.map(({ taskId, ...shot }) => ({
        taskId,
        kind: "hs.dup" as const,
        body: { shot, waveId },
        row: { name: shot.name || shot.label || `Clone of ${shot.campaignId}`, gcm: "duplicate", geo: shot.geo, budget: shot.budgetRaw, bid: shot.bidLabel },
        account: shot.binds.account,
      })),
      { kind: "hs.dup.follow", body: { waveId, until: Date.now() + LION_FOLLOW_MAX_MS } },
    );
    if (!res.ok) return bad(res.status === 503 ? "task_store_unavailable_wave_not_fired" : res.error, res.status);
    // The wave claim — what /api/wave-status answers a board whose answer was lost, and the fast
    // path of a re-POST. Best-effort now: the jobs ARE the durable record (a re-POST meets its ids).
    await writeAppCache(waveKey, { at: Date.now(), n: shots.length });
    rememberWave(waveId);
    const origin = selfOrigin(req);
    for (const lane of res.lanes) after(() => pumpLane(lane, { origin, startedAt }));

    return NextResponse.json({
      ok: true,
      queued: res.accepted.length,
      rows: shots.map((s) => ({ taskId: s.taskId })),
      currency,
      ...(res.failed.length ? { failed: res.failed } : {}),
    });
  }

  // ================= legacy single shot =================
  if (!profile) return bad("profile_required");
  if (!account) return bad("account_required");
  if (!page) return bad("page_required");
  if (!pixel) return bad("pixel_required");
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
  // now" lag. No resolvable strategy, or a lowest-cost source → refuse rather than guess.
  let startingBid: number | undefined;
  if (bid != null) {
    const clientStrategy = String(body.bidStrategy ?? "").trim();
    const strategy = (await lionSourceBidFacts(campaignId)).bidStrategy || clientStrategy;
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
            bid: (String(body.bidLabel ?? "").trim() ||
              bidTag(String(body.bidStrategy ?? "").trim(), String(body.bid ?? "").trim()) ||
              "inherited").slice(0, 40),
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
