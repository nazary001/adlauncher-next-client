import { NextResponse, after } from "next/server";
import { normalizeRoasGoal, parseMoney } from "@/lib/types";
import { SUPPORTED_BID_STRATEGIES } from "@/lib/fb-launch";
import { dupBidPlan } from "@/lib/lion-dup-bid";
import { hsPageRefusal, reportPagesUsed } from "@/lib/hs-pages";
import { parseGeoOverride } from "@/lib/targeting-override";
import { sessionFromCookieHeader } from "@/lib/session";
import { readAppCache, writeAppCache } from "@/lib/app-cache";
import { stampHsTaskRow, upsertTaskRow } from "@/lib/task-store";
import {
  ACCT_LIMIT,
  AcctLimitedError,
  acctKey,
  acctLimitMessage,
  acctLimitSnapshot,
  claimAcctSlot,
  releaseAcctSlot,
} from "@/lib/acct-limit";
import { type ShotBinds, acctLimitRefusal, bindsKey, demandByAccount, distinctBy, resolveShotBinds } from "@/lib/hs-shot-binds";
import { ACCOUNT_NOT_ASSIGNED_MSG, accountAllowedFor } from "@/lib/acct-assignments";
import { LionError, lionAccountPixels, lionConfigured, lionProfileData } from "@/lib/lion";
import { hsTokenStartTime } from "@/lib/hs-token-launch";
import { buildToolDuplicate, runToolDuplicate, toolEnsureMark } from "@/lib/tool-launch";
import { toolDeps, toolLaunchReady } from "@/lib/tool-run";

export const runtime = "nodejs";
// Fire-and-forget like /api/hs/duplicate: the response returns at once and an after() pump submits
// each clone to TOOL and follows its child job to a terminal state. maxDuration matches the LION
// duplicate route (Fluid-compute ceiling); PUMP_BUDGET_MS leaves headroom under it for the last
// row writes to land before the platform freezes the function.
export const maxDuration = 800;

const PUMP_BUDGET_MS = 770_000;
// Wave cap. Each shot is ONE TOOL /duplicates submit (TOOL does the Graph tree itself on its own
// session — lighter than the token rail's in-request rebuild, so above token's 10) followed by a
// job poll. Capped at 20 because: (a) it matches TOOL's own DuplicateTarget copies≤20 ceiling —
// a batch size the API already blesses; (b) TOOL runs each child job on a SINGLE shared session, so
// a wider fan-out could not reliably finish inside the pump window; (c) no duplicate job has ever
// run live on TOOL (spec §4), so a smaller cap limits blast radius on the first live wave. Above it
// the board asks the buyer to fire in two waves.
const MAX_TOOL_SHOTS = 20;
// Submits are paced across the wave (anti-block, same intent as the LION pump's 1–3s jitter): each
// shot's follower starts this far apart, so the createDuplicates calls fan out over time even though
// the followers then poll concurrently.
const SUBMIT_STAGGER_MS = 1_500;

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Same-instance wave-claim backstop (see /api/hs/duplicate — identical idempotency contract). A
// DISTINCT prefix from the LION/token waves so the same waveId on a different channel is a different
// wave (the client bakes the channel into its waveId, but the server key namespaces it too).
const claimedWaves = new Set<string>();
function rememberWave(waveId: string): void {
  if (claimedWaves.size > 1000) claimedWaves.clear();
  claimedWaves.add(waveId);
}

/** Bind validation against LION's catalog — the owner rule from the token rails applies to TOOL
 *  clones too: they may only land where a weapon profile is bound, or the partner's ingestion never
 *  sees them. Identical to /api/hs/token-duplicate's validateBinds. */
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
  if (!acct) return { error: bad(`account_not_on_profile — ${account} is not on ${profile}`) };
  if (acct.status !== 1) return { error: bad(`account_disabled — ${account}`) };
  const pageRow = data.pages.find((p) => p.id === page);
  if (!pageRow) return { error: bad(`page_not_on_profile — page ${page} is not on ${profile}`) };
  const fankaRefusal = await hsPageRefusal("br", [pageRow]);
  if (fankaRefusal) return { error: bad(fankaRefusal.error, fankaRefusal.status) };
  let pixels;
  try {
    pixels = await lionAccountPixels(profile, account);
  } catch (e) {
    return { error: bad(`lion_unreachable: ${(e as Error).message}`, 502) };
  }
  if (!pixels.some((p) => p.id === pixel)) return { error: bad(`pixel_not_on_account — pixel ${pixel} is not on ${account}`) };
  return { currency: acct.currency || "USD", accountName: acct.name || "", pageName: pageRow.name || "" };
}

type ToolDupShot = {
  campaignId: string;
  budget: number;
  budgetRaw: string;
  bid: number | null;
  /** The SOURCE's strategy, sent by the board — dupBidPlan's fallback when scaling a typed bid
   *  (we do NOT read the source; TOOL duplicates it server-side). */
  bidStrategy: string;
  /** TARGET bid strategy (per-row ROAS ↔ cap ↔ lowest switch) — "" = inherit the source's. */
  bidStrategyOverride: string;
  /** Display-only bid/ROAS tag for the monitor card — forwarded verbatim to the row. */
  bidLabel: string;
  name: string;
  geo: string;
  label: string;
  taskId: string;
  /** This shot's OWN destination (per-row binds, 09-08) + the catalog facts validation filled. */
  binds: ShotBinds;
  accountName: string;
  pageName: string;
  settled?: boolean;
};

/**
 * POST /api/hs/tool-duplicate — the HS duplicator's TOOL rail (owner ask 28.09): the SAME wave shape
 * as /api/hs/duplicate and /api/hs/token-duplicate (profile/account/page/pixel + shots[] + waveId,
 * per-row binds), but each clone is submitted to the HS team's Ads Manager sessions service
 * (tool.gctracking.xyz) as a one-target DuplicateRequest (copies:1, status ACTIVE, start +30 min).
 * Money is USD, ROAS a coefficient — lib/tool-launch's buildToolDuplicate does the unit math, never
 * this route. TOOL /duplicates cannot change geo on a clone, so any row carrying a geo/locale
 * override is refused BY NAME before anything (spec §2.5). Rows are stamped EXACTLY like the token
 * rail (kind "duplicate", link ""=no LION id — the client never polls LION for them; TOOL_MARK'd
 * name) before the response; an after() pump submits each shot (paced) and follows its child job to
 * done/error, settling the row from the shared task store. Fire-and-forget: the tab may close.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const startedAt = Date.now();
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return bad("unauthorized", 401);

  // Is TOOL launchable right now? Refuse the whole wave up front with the server's own reason.
  const ready = await toolLaunchReady();
  if (!ready.ok) {
    const status =
      ready.reason === "not_configured" || ready.reason === "key_rejected" || ready.reason === "scope_missing" ? 500 : 503;
    return bad(ready.message, status);
  }
  // Binds are validated against LION's catalog (the HS bind space is LION's) — same tie the token
  // rail keeps; with LION down the TOOL rail refuses rather than clone into an unverifiable bind.
  if (!lionConfigured()) return bad("lion_not_configured", 500);

  let body: {
    profile?: string;
    account?: string;
    page?: string;
    pixel?: string;
    waveId?: string;
    shots?: {
      campaignId?: string;
      budget?: string;
      bid?: string;
      bidStrategy?: string;
      bidStrategyOverride?: string;
      bidLabel?: string;
      name?: string;
      geo?: string;
      label?: string;
      countries?: string[];
      locales?: string[];
      profile?: string;
      account?: string;
      page?: string;
      pixel?: string;
    }[];
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return bad("bad_json");
  }

  // Wave-level binds = the DEFAULTS for shots that carry none (per-row destinations, 09-08).
  const waveBinds = {
    profile: String(body.profile ?? "").trim(),
    account: String(body.account ?? "").trim(),
    page: String(body.page ?? "").trim(),
    pixel: String(body.pixel ?? "").trim(),
  };
  if (!Array.isArray(body.shots) || body.shots.length === 0) return bad("shots_required");
  if (body.shots.length > MAX_TOOL_SHOTS) return bad(`too_many_shots_max_${MAX_TOOL_SHOTS}`);

  const waveIdRaw = String(body.waveId ?? "").trim();
  if (waveIdRaw && !/^[a-zA-Z0-9-]{8,64}$/.test(waveIdRaw)) return bad("wave_id_invalid");
  const waveId = waveIdRaw || crypto.randomUUID();

  const shots: ToolDupShot[] = [];
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
    // TOOL /duplicates cannot change geo on a clone (its DuplicateTarget carries no country_codes/
    // locales — spec §2.5). Any row carrying a geo/locale override refuses the WHOLE wave BY NAME
    // before a single row is stamped — never a silent clone on the SOURCE's geo (the exact bug the
    // LION-dup Graph patch was added to fix). Geo tests go through LION or the FB Token rail.
    if (parseGeoOverride(raw?.countries, raw?.locales)) {
      return bad("TOOL cannot change geo on a duplicate — use LION API or FB Token for geo tests");
    }
    const strategyOverride = String(raw?.bidStrategyOverride ?? "").trim();
    if (strategyOverride && !SUPPORTED_BID_STRATEGIES.has(strategyOverride)) return bad("bid_strategy_invalid");
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
      name: String(raw?.name ?? "").trim().slice(0, 200),
      geo: String(raw?.geo ?? "").slice(0, 40) || "inherited",
      label: String(raw?.label ?? "").trim().slice(0, 200),
      taskId: `hstld-${waveId}-${String(shots.length).padStart(2, "0")}`,
      binds: shotBinds,
      accountName: "",
      pageName: "",
    });
  }

  // Fire-time belt over the picker filter: /accounts assignments hold even for a crafted POST — for
  // EVERY account the wave targets.
  const accounts = distinctBy(shots, (s) => s.binds.account);
  for (const acct of accounts) {
    if (!(await accountAllowedFor(session, acct))) return bad(`${ACCOUNT_NOT_ASSIGNED_MSG} (${acct})`, 403);
  }

  // Every TARGET account must be visible to a LIVE TOOL session, or TOOL answers `missing_context`
  // on the first call. Refuse blind targets up front (one force-refresh in case an owner just
  // refreshed a session) — the TOOL analog of the token rail's hsDupTokenAccountIds precheck.
  {
    const visible = new Set(ready.accounts.map((a) => a.account_id));
    let blind = accounts.filter((a) => !visible.has(acctKey(a)));
    if (blind.length > 0) {
      const r2 = await toolLaunchReady(true);
      const v2 = r2.ok ? new Set(r2.accounts.map((a) => a.account_id)) : visible;
      blind = accounts.filter((a) => !v2.has(acctKey(a)));
    }
    if (blind.length > 0) {
      return bad(
        `account_not_visible_to_tool — no live TOOL session sees ${blind.join(", ")}; an owner refreshes/adds one on Ads Manager sessions (or clone those rows on the LION API rail)`,
      );
    }
  }

  // Catalog validation ONCE per distinct bind tuple.
  const validated = new Map<string, { currency: string; accountName: string; pageName: string }>();
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
  }
  const currency = validated.values().next().value?.currency ?? "USD";

  // Account launch-limit precheck — EVERY account the wave targets must take its share (5/30min per
  // account, owner rule 2026-08-18; per-row destinations 09-08). Runs BEFORE stamping rows.
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

  const alreadyAccepted = () =>
    NextResponse.json({
      ok: true,
      queued: shots.length,
      alreadyAccepted: true,
      rows: shots.map((s) => ({ taskId: s.taskId })),
      currency,
    });

  const waveKey = `hs-tool-wave:${waveId}`;
  if (claimedWaves.has(waveId)) return alreadyAccepted();
  const existing = await readAppCache<{ at: number }>(waveKey);
  if (existing?.value?.at) {
    rememberWave(waveId);
    return alreadyAccepted();
  }

  // Rows land in the shared store BEFORE the claim and the response (team visibility + retry
  // safety). Stamped EXACTLY like the token rail: kind "duplicate", lionTaskId "" (no LION id → the
  // client never polls LION for them; the pump settles them), name TOOL_MARK'd so the drawer row and
  // the born clone never disagree about the channel.
  await Promise.all(
    shots.map((s) =>
      stampHsTaskRow(session.username, {
        taskId: s.taskId,
        name: toolEnsureMark(s.name || s.label || `Clone of ${s.campaignId}`),
        geo: s.geo,
        budget: s.budgetRaw,
        ...(s.bidLabel ? { bid: s.bidLabel } : {}),
        lionTaskId: "",
        kind: "duplicate",
      }),
    ),
  );

  const claimed = await writeAppCache(waveKey, { at: Date.now(), n: shots.length });
  if (claimed === null) {
    const winner = await readAppCache<{ at: number }>(waveKey);
    if (winner?.value?.at) {
      rememberWave(waveId);
      return alreadyAccepted();
    }
    return bad("task_store_unavailable_wave_not_fired", 503);
  }
  rememberWave(waveId);

  const user = session.username;
  const deadline = startedAt + PUMP_BUDGET_MS;
  after(() => pumpToolBatch(user, shots, deadline));

  return NextResponse.json({
    ok: true,
    queued: shots.length,
    rows: shots.map((s) => ({ taskId: s.taskId })),
    currency,
  });
}

const rowWrite = (user: string, taskId: string, fields: Record<string, unknown>) =>
  upsertTaskRow(user, taskId, { ...fields, partner: "br" }).then(
    () => undefined,
    () => undefined,
  );

/**
 * The TOOL rail's pump: submit each shot to TOOL (paced across the wave) and follow its child job to
 * a terminal state, then settle the row. Shots run CONCURRENTLY (Promise.all) with a staggered start
 * so the createDuplicates submits fan out over time (anti-block, like the LION pump's jitter) while
 * their job polls overlap — "submit all, then follow all child jobs concurrently" (spec §2.5). Each
 * shot is one one-target DuplicateRequest via runToolDuplicate (the tested lib/tool-launch
 * orchestration — submit + poll to terminal / deadline). The pump never throws into the runtime;
 * strays age out via the HS Task Manager's caps.
 */
async function pumpToolBatch(user: string, shots: ToolDupShot[], deadline: number): Promise<void> {
  try {
    await Promise.all(shots.map((s, i) => runToolShot(user, s, i, deadline).catch(() => {})));
  } catch {
    /* the pump must never throw into the runtime */
  }
}

async function runToolShot(user: string, s: ToolDupShot, index: number, deadline: number): Promise<void> {
  // Pace the submit: fan the createDuplicates calls out across the wave instead of firing them all
  // at once (anti-block, same intent as the LION pump's 1–3s jitter).
  await sleep(index * SUBMIT_STAGGER_MS + Math.floor(Math.random() * 800));
  if (s.settled) return;
  if (Date.now() > deadline - 60_000) {
    s.settled = true;
    await rowWrite(user, s.taskId, {
      status: "error",
      error: "Not submitted — the wave's server window closed before this clone. Re-fire it in the duplicator.",
      finished_at: Date.now(),
    });
    return;
  }

  // ---- bidding (LION duplicate-v2 rules, reused): the buyer's per-row switch wins, else the
  // source's; a switched capped/ROAS row needs a typed value, a lowest-cost row refuses a typed bid,
  // an unswitched row inherits (no bid/strategy on the wire → TOOL keeps the source's). We do NOT
  // read the source (TOOL duplicates it server-side), so the source strategy is the board's own
  // hint. Currencies are moot (all live TOOL accounts are USD) but the rule stays. ----
  const plan = dupBidPlan({
    sourceStrategy: s.bidStrategy,
    override: s.bidStrategyOverride,
    typedBid: s.bid,
    sourceCurrency: "",
    destCurrency: "USD",
  });
  if ("refusal" in plan) {
    s.settled = true;
    await rowWrite(user, s.taskId, { status: "error", error: plan.refusal, finished_at: Date.now() });
    return;
  }
  let bidValue: number | undefined;
  if (plan.human != null) {
    if (plan.kind === "roas") {
      // ROAS rides as the COEFFICIENT (1.2 = 120%), never ×10000 — TOOL scales internally. Percent /
      // ×10-slip entries normalize to the real goal; the ambiguous 10–20 band refuses like every wire.
      const goal = normalizeRoasGoal(plan.human);
      if (goal == null) {
        s.settled = true;
        await rowWrite(user, s.taskId, {
          status: "error",
          error: "roas goal ambiguous — type the decimal goal (0,30 = 30%)",
          finished_at: Date.now(),
        });
        return;
      }
      bidValue = goal;
    } else {
      // cap / cost cap: USD amount as typed (NOT cents — TOOL money is USD).
      bidValue = plan.human;
    }
  }

  const target = acctKey(s.binds.account);
  const name = toolEnsureMark(s.name || `Clone of ${s.campaignId}`);
  const built = buildToolDuplicate({
    sourceCampaignId: s.campaignId,
    accountId: target,
    pageId: s.binds.page,
    pixelId: s.binds.pixel,
    name,
    budgetUsd: s.budget,
    ...(bidValue != null ? { bid: bidValue } : {}),
    // bid_strategy only on a SWITCH — an unswitched row omits it so TOOL inherits the source's.
    ...(plan.wireStrategy ? { bidStrategy: plan.wireStrategy } : {}),
    status: "ACTIVE",
    startTime: hsTokenStartTime(),
  });
  if (!built.ok) {
    s.settled = true;
    await rowWrite(user, s.taskId, { status: "error", error: built.error, finished_at: Date.now() });
    return;
  }

  let slot: { documentId: string } | null = null;
  try {
    await rowWrite(user, s.taskId, { status: "running", stage: "queue", started_at: Date.now() });
    // Account launch slot (5/30min) — right before the submit; released below on a clean refusal
    // that created nothing.
    slot = await claimAcctSlot(target, {
      user,
      partner: "br",
      channel: "hs-tool-dup",
      name,
      accountName: s.accountName,
    });

    const run = await runToolDuplicate(toolDeps, target, built.body, {
      idempotencyKey: s.taskId,
      deadlineAt: deadline - 30_000,
    });

    if (run.ok) {
      s.settled = true;
      await rowWrite(user, s.taskId, {
        status: "done",
        stage: "ads",
        campaign_id: run.campaignId,
        adset_id: run.adsetId,
        ad_id: String(run.adIds.length),
        finished_at: Date.now(),
        error: null,
      });
      // Fanka ledger: every ad this clone landed occupies a slot (fire-safe; the box's next sweep
      // reconciles). adIds may be empty if TOOL's duplicate result omits them (spec §4) → skip.
      if (run.adIds.length) await reportPagesUsed("br", [{ pageId: s.binds.page, delta: run.adIds.length }]);
      return;
    }

    if (run.pending) {
      // Deadline hit while TOOL still works — keep the slot (a campaign may exist) and name the job
      // so a human can verify it. Never a blind re-fire (the Idempotency-Key makes a retry safe, but
      // the row states the ambiguity).
      s.settled = true;
      await rowWrite(user, s.taskId, {
        status: "error",
        error: `TOOL is still finishing this clone past the wave window — verify in Ads Manager before re-firing (tool job #${run.jobId ?? "?"})`,
        ...(run.created?.campaignId ? { campaign_id: run.created.campaignId } : {}),
        finished_at: Date.now(),
      });
      return;
    }

    // Clean failure. TOOL creates PAUSED and activates last, so a partial is already PAUSED — nothing
    // to pause here (unlike the Graph rails). Release the slot ONLY when TOOL proved nothing landed.
    const created = run.created;
    const landed = created?.adIds ?? [];
    if (slot && !created?.campaignId && landed.length === 0) {
      await releaseAcctSlot(slot.documentId);
      slot = null;
    }
    s.settled = true;
    await rowWrite(user, s.taskId, {
      status: "error",
      error: run.error,
      ...(created?.campaignId ? { campaign_id: created.campaignId } : {}),
      ...(created?.adsetIds[0] ? { adset_id: created.adsetIds[0] } : {}),
      ...(landed.length ? { ad_id: String(landed.length) } : {}),
      finished_at: Date.now(),
    });
    if (landed.length) await reportPagesUsed("br", [{ pageId: s.binds.page, delta: landed.length }]);
  } catch (e) {
    // Account window full at claim time, registry down, or anything unexpected. The claim throws
    // BEFORE any TOOL call, so on an AcctLimitedError nothing was created; a throw AFTER a claim
    // keeps the slot (ambiguous). Settle this shot with the message — other shots (other accounts)
    // keep running (per-row destinations, 09-08).
    const msg = e instanceof AcctLimitedError ? e.message : ((e as Error).message ?? String(e));
    s.settled = true;
    await rowWrite(user, s.taskId, { status: "error", error: msg, finished_at: Date.now() });
  }
}
