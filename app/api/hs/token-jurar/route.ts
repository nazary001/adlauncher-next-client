import { NextResponse, after } from "next/server";
import { parseMoney } from "@/lib/types";
import { hsEnsureTokenMark } from "@/lib/hs-launch";
import { juroEnsureMark } from "@/lib/juro";
import { parseGeoOverride } from "@/lib/targeting-override";
import { sessionFromCookieHeader } from "@/lib/session";
import { readAppCache, writeAppCache } from "@/lib/app-cache";
import { hsDupTokenAccountIds, hsDupTokenConfigured, hsDupTokenGate } from "@/lib/hs-token-launch";
import { SUPPORTED_BID_STRATEGIES } from "@/lib/fb-launch";
import { ACCOUNT_NOT_ASSIGNED_MSG, accountAllowedFor } from "@/lib/acct-assignments";
import { LionError, lionAccountPixels, lionConfigured, lionProfileData } from "@/lib/lion";
import { ACCT_LIMIT, acctKey, acctLimitMessage, acctLimitSnapshot } from "@/lib/acct-limit";
import { acctLimitRefusal, bindsKey, demandByAccount, distinctBy, resolveShotBinds } from "@/lib/hs-shot-binds";
import type { HsTokenJuroShot } from "@/lib/hs-token-jurar-shot";
import { acceptServerJobs, pumpLane, selfOrigin } from "@/lib/launch-queue-run";

export const runtime = "nodejs";
// The hand-off answers at once (one durable queue job per shot, 09.10 — lib/hs-token-jurar-shot
// builds the copy's Graph tree inside the job) — but the SAME invocation hosts the lane pump's
// first budget window (after(pumpLane)): maxDuration is the pump's.
export const maxDuration = 800;

/** Same wave cap as the token duplicator: the board mirrors it client-side. */
const MAX_TOKEN_SHOTS = 10;

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

// Same-instance wave-claim backstop (see /api/hs/duplicate — identical idempotency contract).
const claimedWaves = new Set<string>();
function rememberWave(waveId: string): void {
  if (claimedWaves.size > 1000) claimedWaves.clear();
  claimedWaves.add(waveId);
}

/** JURO binds = profile + account + pixel (NO page — the source post carries it). Validation
 *  runs against LION's catalog like every token rail: campaigns may only land in accounts a
 *  weapon-connected profile can see (partner rule), even though OUR token executes the build. */
async function validateBinds(
  profile: string,
  account: string,
  pixel: string,
): Promise<{ error: NextResponse } | { currency: string; accountName: string }> {
  let data;
  try {
    data = await lionProfileData(profile);
  } catch (e) {
    const lionSide = e instanceof LionError && (e.status === undefined || e.status < 500);
    return { error: bad(lionSide ? "profile_invalid" : `lion_unreachable: ${(e as Error).message}`, lionSide ? 400 : 502) };
  }
  // Per-row destinations (09-08): the refusal names the ids so the buyer knows WHICH row is off.
  const acct = data.accounts.find((a) => a.id === account);
  if (!acct) return { error: bad(`account_not_on_profile — ${account} is not on ${profile}`) };
  if (acct.status !== 1) return { error: bad(`account_disabled — ${account}`) };
  let pixels;
  try {
    pixels = await lionAccountPixels(profile, account);
  } catch (e) {
    return { error: bad(`lion_unreachable: ${(e as Error).message}`, 502) };
  }
  if (!pixels.some((p) => p.id === pixel)) return { error: bad(`pixel_not_on_account — pixel ${pixel} is not on ${account}`) };
  return { currency: acct.currency || "USD", accountName: acct.name || "" };
}

type TokenJuroShot = HsTokenJuroShot & { taskId: string };

/**
 * POST /api/hs/token-jurar — the JURO rail's FB-Token channel: the same "new campaign from the
 * source's page posts" launch /api/hs/jurar performs through LION, built directly on the Graph
 * with OUR partner-side token pool (like /api/hs/token-duplicate). The ads are re-created from
 * the source ads' object stories, so they live ON the post's own fanpage with its social proof;
 * targeting is the fresh jurar shape (country-level geo + ages 18–65) with the buyer's override
 * — and, unlike LION's wire, the source's LANGUAGES survive. Every shot is validated here, then
 * handed to the durable server queue as ONE JOB PER SHOT (09.10); the tab may close at once.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const startedAt = Date.now();
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return bad("unauthorized", 401);
  if (!(await hsDupTokenConfigured())) {
    return bad("hs_fb_token_missing — set FB_HS_DUP_TOKEN (or FB_HS_LAUNCH_TOKEN) in the environment", 500);
  }
  if (!lionConfigured()) return bad("lion_not_configured", 500);

  let body: {
    profile?: string;
    account?: string;
    pixel?: string;
    waveId?: string;
    shots?: {
      campaignId?: string;
      budget?: string;
      /** Optional bid override in HUMAN units (ROAS goal decimal / cap $) — scaled to Meta-native
       *  adset fields by the EFFECTIVE strategy in the job (empty = inherit the source's bid). */
      bid?: string;
      /** Optional TARGET bid strategy (ROAS ↔ cap ↔ lowest) — empty rides the source's. */
      bidStrategyOverride?: string;
      /** Display-only bid/ROAS tag (bidTag) for the monitor card — forwarded verbatim to the row. */
      bidLabel?: string;
      name?: string;
      geo?: string;
      label?: string;
      countries?: string[];
      locales?: string[];
      /** Per-shot destination (09-08) — any field absent rides the wave-level one. */
      profile?: string;
      account?: string;
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
    pixel: String(body.pixel ?? "").trim(),
  };
  if (!Array.isArray(body.shots) || body.shots.length === 0) return bad("shots_required");
  if (body.shots.length > MAX_TOKEN_SHOTS) return bad(`too_many_shots_max_${MAX_TOKEN_SHOTS}`);

  const waveIdRaw = String(body.waveId ?? "").trim();
  if (waveIdRaw && !/^[a-zA-Z0-9-]{8,64}$/.test(waveIdRaw)) return bad("wave_id_invalid");
  const waveId = waveIdRaw || crypto.randomUUID();

  const shots: TokenJuroShot[] = [];
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
    const strategyOverride = String(raw?.bidStrategyOverride ?? "").trim();
    if (strategyOverride && !SUPPORTED_BID_STRATEGIES.has(strategyOverride)) return bad("bid_strategy_invalid");
    // The shot's own destination over the wave defaults (per-row binds, 09-08; no page on JURO).
    const shotBinds = resolveShotBinds(raw, waveBinds, false);
    if ("error" in shotBinds) return bad(shotBinds.error);
    shots.push({
      campaignId,
      budget,
      budgetRaw: String(raw?.budget ?? ""),
      bid,
      bidStrategyOverride: strategyOverride,
      bidLabel: String(raw?.bidLabel ?? "").trim().slice(0, 40),
      name: String(raw?.name ?? "").trim().slice(0, 200),
      geo: String(raw?.geo ?? "").slice(0, 40) || "inherited",
      label: String(raw?.label ?? "").trim().slice(0, 200),
      override,
      taskId: `hsjt-${waveId}-${String(shots.length).padStart(2, "0")}`,
      binds: shotBinds,
      accountName: "",
    });
  }

  // Fire-time belt over the picker filter: /accounts assignments hold even for a crafted POST
  // — for EVERY account the wave targets.
  const accounts = distinctBy(shots, (s) => s.binds.account);
  for (const acct of accounts) {
    if (!(await accountAllowedFor(session, acct))) return bad(`${ACCOUNT_NOT_ASSIGNED_MSG} (${acct})`, 403);
  }
  // Catalog validation ONCE per distinct bind tuple (the whole wave used to share one).
  const validated = new Map<string, { currency: string; accountName: string }>();
  for (const s of shots) {
    const key = bindsKey(s.binds);
    let v = validated.get(key);
    if (!v) {
      const r = await validateBinds(s.binds.profile, s.binds.account, s.binds.pixel);
      if ("error" in r) return r.error;
      v = r;
      validated.set(key, v);
    }
    s.accountName = v.accountName;
  }
  const currency = validated.values().next().value?.currency ?? "USD";

  // Every TARGET must be visible to our token (LION binds cover segments the token was never
  // granted — aleph, 08-19). A failed sweep (null) falls OPEN; an unreadable SOURCE still fails
  // per shot inside the job with its own actionable reason.
  {
    const visible = await hsDupTokenAccountIds();
    const blind = visible ? accounts.filter((a) => !visible.has(acctKey(a))) : [];
    if (blind.length > 0) {
      return bad(
        `account_not_visible_to_fb_token — our FB token was never granted ${blind.join(", ")}; run those rows' JURO on the LION API rail (or pick a token-visible account)`,
      );
    }
  }

  // Account launch-limit precheck — EVERY account the wave targets must take its share (same
  // rule as the LION rail; per-row destinations 09-08).
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
      "JURO copies",
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

  const waveKey = `hs-wave:${waveId}`;
  if (claimedWaves.has(waveId)) return alreadyAccepted();
  const existing = await readAppCache<{ at: number }>(waveKey);
  if (existing?.value?.at) {
    rememberWave(waveId);
    return alreadyAccepted();
  }

  // All bearers burned → refuse the wave BEFORE queuing anything, with the retry ETA. Runs AFTER
  // the idempotency answers above (a re-POST of an accepted wave must say alreadyAccepted, not
  // 429 off the pool its own jobs just burned — same order as token-duplicate).
  {
    const gate = await hsDupTokenGate();
    if (!gate.ok) return bad(gate.error, 429);
  }

  // The hand-off to the durable queue (see /api/hs/duplicate): rows stamped — carrying both
  // markers like the campaigns will — one job per shot; fail CLOSED when the store cannot take it.
  const user = session.username;
  const res = await acceptServerJobs(
    { username: user, role: session.role ?? null, sub: session.sub },
    "hs",
    waveId,
    shots.map(({ taskId, ...shot }) => ({
      taskId,
      kind: "hs.tokenjurar" as const,
      body: { shot, waveId },
      row: { name: hsEnsureTokenMark(juroEnsureMark(shot.name || shot.label || `copy of ${shot.campaignId}`)), gcm: "duplicate", geo: shot.geo, budget: shot.budgetRaw, bid: shot.bidLabel },
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
