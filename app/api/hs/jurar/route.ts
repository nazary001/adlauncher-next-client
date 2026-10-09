import { NextResponse, after } from "next/server";
import { parseMoney } from "@/lib/types";
import { juroLionStrategyAccepted } from "@/lib/juro";
import { ACCOUNT_NOT_ASSIGNED_MSG, accountAllowedFor } from "@/lib/acct-assignments";
import { sessionFromCookieHeader } from "@/lib/session";
import { readAppCache, writeAppCache } from "@/lib/app-cache";
import { ACCT_LIMIT, acctLimitMessage, acctLimitSnapshot } from "@/lib/acct-limit";
import { LionError, lionAccountPixels, lionConfigured, lionProfileData } from "@/lib/lion";
import { parseGeoOverride } from "@/lib/targeting-override";
import { acctLimitRefusal, bindsKey, demandByAccount, distinctBy, resolveShotBinds } from "@/lib/hs-shot-binds";
import type { HsJuroShot } from "@/lib/hs-jurar-shot";
import { LION_FOLLOW_MAX_MS } from "@/lib/launch-queue-types";
import { acceptServerJobs, pumpLane, selfOrigin } from "@/lib/launch-queue-run";

export const runtime = "nodejs";
// The hand-off answers at once (one durable queue job per shot, 09.10) — but the SAME invocation
// hosts the lane pump's first budget window (after(pumpLane)): maxDuration is the pump's.
export const maxDuration = 800;

const MAX_SHOTS = 45;

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

// Same-instance backstop for the wave claim (see /api/hs/duplicate for the contract).
const claimedWaves = new Set<string>();
function rememberWave(waveId: string): void {
  if (claimedWaves.size > 1000) claimedWaves.clear();
  claimedWaves.add(waveId);
}

/** JURO binds = profile + account + pixel (NO page — the source post carries it). The profile's
 *  page catalog rides along: jurar refuses a story whose page the profile doesn't list (live
 *  08-25), so the shot pre-checks each source against it with a readable reason. */
async function validateBinds(
  profile: string,
  account: string,
  pixel: string,
): Promise<{ error: NextResponse } | { currency: string; accountName: string; profilePages: string[]; localeNames: Record<string, string> }> {
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
  const localeNames: Record<string, string> = {};
  for (const l of data.locales) localeNames[String(l.id)] = l.name;
  return {
    currency: acct.currency || "USD",
    accountName: acct.name || "",
    profilePages: data.pages.map((p) => p.id),
    localeNames,
  };
}

type JuroShot = HsJuroShot & { taskId: string };

/**
 * JURO clone wave: new campaigns from the sources' page POSTS through LION `/jurar/` — the ads
 * re-use the existing object stories (with their social proof) on the source's own fanpage, so
 * there is no page bind and no Graph patching: geo/locales ride natively in the wire. One shape
 * only ({shots: […]}): every shot is validated here, then handed to the durable server queue as
 * ONE JOB PER SHOT (09.10 — lib/hs-jurar-shot submits, lib/hs-follow-core polls / finishes) plus
 * the wave's follow-up job; the response returns at once and the tab may close.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const startedAt = Date.now();
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return bad("unauthorized", 401);
  if (!lionConfigured()) return bad("lion_not_configured", 500);

  let body: {
    profile?: string;
    account?: string;
    pixel?: string;
    waveId?: string;
    shots?: {
      campaignId?: string;
      budget?: string;
      /** Optional bid override in HUMAN units (ROAS goal decimal / cap $) — scaled to jurar's
       *  wire by the copy's EFFECTIVE strategy (empty = the source's own bid). */
      bid?: string;
      /** Per-row strategy switch (owner ask 09-08): one of LION jurar's bid_strategy values —
       *  ROAS ↔ cap ↔ lowest all reachable (/jurar/ builds a fresh campaign). "" = the source's.
       *  A switched cap/ROAS row must carry a typed `bid` (nothing inherits across strategies). */
      bidStrategyOverride?: string;
      /** Display-only bid/ROAS tag (bidTag) for the monitor card — forwarded verbatim to the row. */
      bidLabel?: string;
      /** Buyer tail — LION builds the JURO name itself and appends this as name_suffix. */
      suffix?: string;
      /** The board's exact name — put on the born campaign through a campaign-level Graph write
       *  (owner ask 09-09); LION's own JURO name keeps its family word and geo list until it
       *  syncs the Facebook name back. */
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
  if (body.shots.length > MAX_SHOTS) return bad(`too_many_shots_max_${MAX_SHOTS}`);

  const waveIdRaw = String(body.waveId ?? "").trim();
  if (waveIdRaw && !/^[a-zA-Z0-9-]{8,64}$/.test(waveIdRaw)) return bad("wave_id_invalid");
  const waveId = waveIdRaw || crypto.randomUUID();
  const shots: JuroShot[] = [];
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
    // The strategy switch is validated against what /jurar/ documents — COST_CAP (a bid-endpoint
    // value) or junk would only die inside LION's task with an opaque reason.
    const strategyOverride = String(raw?.bidStrategyOverride ?? "").trim();
    if (strategyOverride && !juroLionStrategyAccepted(strategyOverride)) {
      return bad("bid_strategy_invalid — LION jurar takes lowest cost / bid cap / min ROAS only");
    }
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
      suffix: String(raw?.suffix ?? "").trim().slice(0, 80),
      name: String(raw?.name ?? "").trim().slice(0, 200),
      geo: String(raw?.geo ?? "").slice(0, 40) || "inherited",
      label: String(raw?.label ?? "").trim().slice(0, 200),
      override,
      taskId: `hsj-${waveId}-${String(shots.length).padStart(2, "0")}`,
      binds: shotBinds,
      accountName: "",
      profilePages: [],
      localeNames: {},
    });
  }

  // Fire-time belt over the picker filter: /accounts assignments hold even for a crafted POST
  // — for EVERY account the wave targets.
  for (const acct of distinctBy(shots, (s) => s.binds.account)) {
    if (!(await accountAllowedFor(session, acct))) return bad(`${ACCOUNT_NOT_ASSIGNED_MSG} (${acct})`, 403);
  }
  // Catalog validation ONCE per distinct bind tuple; each shot keeps ITS profile's page catalog
  // and locale names (the shot pre-checks the source posts' pages against them).
  const validated = new Map<string, { currency: string; accountName: string; profilePages: string[]; localeNames: Record<string, string> }>();
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
    s.profilePages = v.profilePages;
    s.localeNames = v.localeNames;
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

  // ---- account launch-limit precheck (same contract as /api/hs/duplicate): EVERY account the
  // wave targets must take its share (per-row destinations, 09-08) ----
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

  // The hand-off to the durable queue (see /api/hs/duplicate): rows stamped, one job per shot, the
  // wave's follow-up; fail CLOSED when the store cannot take it.
  const user = session.username;
  const res = await acceptServerJobs(
    { username: user, role: session.role ?? null, sub: session.sub },
    "hs",
    waveId,
    shots.map(({ taskId, ...shot }) => ({
      taskId,
      kind: "hs.jurar" as const,
      body: { shot, waveId },
      row: { name: shot.label ? `JURO · ${shot.label}` : `JURO copy of ${shot.campaignId}`, gcm: "duplicate", geo: shot.geo, budget: shot.budgetRaw, bid: shot.bidLabel },
      account: shot.binds.account,
    })),
    { kind: "hs.jurar.follow", body: { waveId, until: Date.now() + LION_FOLLOW_MAX_MS } },
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
