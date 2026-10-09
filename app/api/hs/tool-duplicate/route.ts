import { NextResponse, after } from "next/server";
import { parseMoney } from "@/lib/types";
import { SUPPORTED_BID_STRATEGIES } from "@/lib/fb-launch";
import { hsPageRefusal } from "@/lib/hs-pages";
import { parseGeoOverride } from "@/lib/targeting-override";
import { sessionFromCookieHeader } from "@/lib/session";
import { readAppCache, writeAppCache } from "@/lib/app-cache";
import { ACCT_LIMIT, acctKey, acctLimitMessage, acctLimitSnapshot } from "@/lib/acct-limit";
import { acctLimitRefusal, bindsKey, demandByAccount, distinctBy, resolveShotBinds } from "@/lib/hs-shot-binds";
import { ACCOUNT_NOT_ASSIGNED_MSG, accountAllowedFor } from "@/lib/acct-assignments";
import { LionError, lionAccountPixels, lionConfigured, lionProfileData } from "@/lib/lion";
import { toolEnsureMark } from "@/lib/tool-launch";
import { toolLaunchReady } from "@/lib/tool-run";
import type { HsToolDupShot } from "@/lib/hs-tool-dup-shot";
import { acceptServerJobs, pumpLane, selfOrigin } from "@/lib/launch-queue-run";

export const runtime = "nodejs";
// The hand-off answers at once (one durable queue job per shot, 09.10 — lib/hs-tool-dup-shot
// submits the clone to TOOL and takes a first look; a child job still working past it is finished
// by the queue's tool.follow) — but the SAME invocation hosts the lane pump's first budget window
// (after(pumpLane)): maxDuration is the pump's.
export const maxDuration = 800;

// Wave cap, kept: it matches TOOL's own DuplicateTarget copies≤20 ceiling; above it the board asks
// the buyer to fire in two waves.
const MAX_TOOL_SHOTS = 20;

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

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

type ToolDupShot = HsToolDupShot & { taskId: string };

/**
 * POST /api/hs/tool-duplicate — the HS duplicator's TOOL rail (owner ask 28.09): the SAME wave shape
 * as /api/hs/duplicate and /api/hs/token-duplicate (profile/account/page/pixel + shots[] + waveId,
 * per-row binds), but each clone is submitted to the HS team's Ads Manager sessions service
 * (tool.gctracking.xyz) as a one-target DuplicateRequest (copies:1, status ACTIVE, start +30 min).
 * Money is USD, ROAS a coefficient — lib/tool-launch's buildToolDuplicate does the unit math. TOOL
 * /duplicates cannot change geo on a clone, so any row carrying a geo/locale override is refused BY
 * NAME before anything (spec §2.5). Every shot is validated here, then handed to the durable server
 * queue as ONE JOB PER SHOT (09.10); the response returns at once and the tab may close.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const startedAt = Date.now();
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return bad("unauthorized", 401);

  // Is TOOL launchable right now? Refuse the whole wave up front with the server's own reason.
  const ready = await toolLaunchReady();
  if (!ready.ok) {
    const status = ready.reason === "not_configured" || ready.reason === "key_rejected" || ready.reason === "scope_missing" ? 500 : 503;
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
    // before a single row is stamped — never a silent clone on the SOURCE's geo.
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
    let roster = ready.accounts;
    let visible = new Set(roster.map((a) => a.account_id));
    let blind = accounts.filter((a) => !visible.has(acctKey(a)));
    if (blind.length > 0) {
      const r2 = await toolLaunchReady(true);
      if (r2.ok) {
        roster = r2.accounts;
        visible = new Set(roster.map((a) => a.account_id));
      }
      blind = accounts.filter((a) => !visible.has(acctKey(a)));
    }
    if (blind.length > 0) {
      return bad(
        `account_not_visible_to_tool — no live TOOL session sees ${blind.join(", ")}; an owner refreshes/adds one on Ads Manager sessions (or clone those rows on the LION API rail)`,
      );
    }
    // TOOL money is USD (spec §3) — refuse BY NAME any target whose TOOL-roster currency is a known
    // non-USD before anything is queued. A blank/unknown currency fails OPEN. (review find 28.09)
    const currencyOf = new Map(roster.map((a) => [a.account_id, a.currency]));
    const nonUsd = accounts.filter((a) => {
      const cur = currencyOf.get(acctKey(a));
      return cur ? cur.toUpperCase() !== "USD" : false;
    });
    if (nonUsd.length > 0) {
      return bad(`account_currency_not_usd — TOOL money is USD; ${nonUsd.join(", ")} is not a USD account (clone those rows on the LION API rail)`);
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

  // ---- account launch-limit precheck (5 campaigns / 30 min per ad account, owner rule 2026-08-18):
  // EVERY account the wave targets must take its share (per-row destinations, 09-08). Runs AFTER the
  // wave-idempotency checks. The per-shot claim in the job stays the authority.
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

  // The hand-off to the durable queue (see /api/hs/duplicate): rows stamped EXACTLY like the token
  // rail's (kind "duplicate", TOOL_MARK'd name), one job per shot; fail CLOSED when the store cannot
  // take it.
  const user = session.username;
  const res = await acceptServerJobs(
    { username: user, role: session.role ?? null, sub: session.sub },
    "hs",
    waveId,
    shots.map(({ taskId, ...shot }) => ({
      taskId,
      kind: "hs.tooldup" as const,
      body: { shot, waveId },
      row: { name: toolEnsureMark(shot.name || shot.label || `Clone of ${shot.campaignId}`), gcm: "duplicate", geo: shot.geo, budget: shot.budgetRaw, bid: shot.bidLabel },
      account: shot.binds.account,
    })),
  );
  if (!res.ok) return bad(res.status === 503 ? "task_store_unavailable_wave_not_fired" : res.error, res.status);
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
