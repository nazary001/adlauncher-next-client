import { NextResponse, after } from "next/server";
import { parseMoney } from "@/lib/types";
import { hsWireBid } from "@/lib/hs-launch";
import {
  juroBidPlan,
  juroBlockingError,
  juroConversionEvent,
  juroLionStrategyAccepted,
  juroStoryPages,
  juroWireCountries,
} from "@/lib/juro";
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
import { stampHsTaskRow, upsertTaskRow } from "@/lib/task-store";
import {
  LionError,
  type LionJuroSource,
  lionAccountPixels,
  lionCampaignAds,
  lionConfigured,
  lionCreationStatus,
  lionJurar,
  lionJuroSources,
  lionProfileData,
  lionSetCampaignStatus,
} from "@/lib/lion";
import { type GeoOverride, parseGeoOverride } from "@/lib/targeting-override";
import { type ShotBinds, acctLimitRefusal, bindsKey, demandByAccount, distinctBy, resolveShotBinds } from "@/lib/hs-shot-binds";

export const runtime = "nodejs";
// Same fire-and-forget pump shape as /api/hs/duplicate: the response returns at once and an
// after() worker submits/polls/finishes — maxDuration is that worker's whole time budget.
export const maxDuration = 800;

const MAX_SHOTS = 45;
const PUMP_BUDGET_MS = 770_000;

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

// Same-instance backstop for the wave claim (see /api/hs/duplicate for the contract).
const claimedWaves = new Set<string>();
function rememberWave(waveId: string): void {
  if (claimedWaves.size > 1000) claimedWaves.clear();
  claimedWaves.add(waveId);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = () => 1000 + Math.random() * 2000;

/** JURO binds = profile + account + pixel (NO page — the source post carries it). The profile's
 *  page catalog rides along: jurar refuses a story whose page the profile doesn't list (live
 *  08-25), so the pump pre-checks each source against it with a readable reason. */
async function validateBinds(
  profile: string,
  account: string,
  pixel: string,
): Promise<
  | { error: NextResponse }
  | { currency: string; accountName: string; profilePages: Set<string>; localeNames: Map<number, string> }
> {
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
  return {
    currency: acct.currency || "USD",
    accountName: acct.name || "",
    profilePages: new Set(data.pages.map((p) => p.id)),
    localeNames: new Map(data.locales.map((l) => [l.id, l.name])),
  };
}

type JuroShot = {
  campaignId: string;
  budget: number;
  budgetRaw: string;
  bid: number | null;
  /** Per-row strategy switch ("" = the source's) — LION's /jurar/ takes bid_strategy natively. */
  bidStrategyOverride: string;
  suffix: string;
  geo: string;
  label: string;
  taskId: string;
  override: GeoOverride | null;
  /** This shot's OWN destination (per-row binds, 09-08; page always "" — JURO binds none) and
   *  the catalog facts of ITS profile/account, filled by validation. */
  binds: ShotBinds;
  accountName: string;
  profilePages: Set<string>;
  localeNames: Map<number, string>;
  lionTaskId?: string;
  cloneId?: string;
  settled?: boolean;
};

/**
 * JURO clone wave: new campaigns from the sources' page POSTS through LION `/jurar/` — the ads
 * re-use the existing object stories (with their social proof) on the source's own fanpage, so
 * there is no page bind and no Graph patching: geo/locales ride natively in the wire. One shape
 * only ({shots: […]}): rows stamp into the shared store, the response returns at once, and the
 * after() pump submits jittered single-copy shots, then polls/finishes them.
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
       *  wire by the copy's EFFECTIVE strategy in the pump (empty = the source's own bid). */
      bid?: string;
      /** Per-row strategy switch (owner ask 09-08): one of LION jurar's bid_strategy values —
       *  ROAS ↔ cap ↔ lowest all reachable (/jurar/ builds a fresh campaign). "" = the source's.
       *  A switched cap/ROAS row must carry a typed `bid` (nothing inherits across strategies). */
      bidStrategyOverride?: string;
      /** Buyer tail — LION builds the JURO name itself and appends this as name_suffix. */
      suffix?: string;
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
      suffix: String(raw?.suffix ?? "").trim().slice(0, 80),
      geo: String(raw?.geo ?? "").slice(0, 40) || "inherited",
      label: String(raw?.label ?? "").trim().slice(0, 200),
      override,
      taskId: `hsj-${waveId}-${String(shots.length).padStart(2, "0")}`,
      binds: shotBinds,
      accountName: "",
      profilePages: new Set(),
      localeNames: new Map(),
    });
  }

  // Fire-time belt over the picker filter: /accounts assignments hold even for a crafted POST
  // — for EVERY account the wave targets.
  for (const acct of distinctBy(shots, (s) => s.binds.account)) {
    if (!(await accountAllowedFor(session, acct))) return bad(`${ACCOUNT_NOT_ASSIGNED_MSG} (${acct})`, 403);
  }
  // Catalog validation ONCE per distinct bind tuple; each shot keeps ITS profile's page catalog
  // and locale names (the pump pre-checks the source posts' pages against them).
  const validated = new Map<
    string,
    { currency: string; accountName: string; profilePages: Set<string>; localeNames: Map<number, string> }
  >();
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

  // Rows land in the shared store BEFORE the claim and the response (durability contract —
  // see /api/hs/duplicate).
  await Promise.all(
    shots.map((s) =>
      stampHsTaskRow(session.username, {
        taskId: s.taskId,
        name: s.label ? `JURO · ${s.label}` : `JURO copy of ${s.campaignId}`,
        geo: s.geo,
        budget: s.budgetRaw,
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
    // Store unavailable → FAIL CLOSED: without a persisted claim a retried wave could pump twice.
    return bad("task_store_unavailable_wave_not_fired", 503);
  }
  rememberWave(waveId);

  const user = session.username;
  const deadline = startedAt + PUMP_BUDGET_MS;
  after(() => pumpJuro(user, shots, deadline));

  return NextResponse.json({
    ok: true,
    queued: shots.length,
    rows: shots.map((s) => ({ taskId: s.taskId })),
    currency,
  });
}

/** Best-effort row update — the pump must never die on a Strapi hiccup. */
const rowWrite = (user: string, taskId: string, fields: Record<string, unknown>) =>
  upsertTaskRow(user, taskId, { ...fields, partner: "br" }).then(
    () => undefined,
    () => undefined,
  );

/** Per-shot jurar wire pieces resolved from the SOURCE. String = the actionable refusal. */
function resolveShotWire(
  s: JuroShot,
  src: LionJuroSource,
  binds: { profilePages: Set<string>; localeNames: Map<number, string> },
):
  | string
  | {
      stories: string[];
      /** Per-page ad tally — profile-checked AND ledgered page by page (a source can carry ads
       *  on more than one fanpage). */
      pages: { pageId: string; delta: number }[];
      countries: string[];
      locales: { id: number; name: string }[];
      bidStrategy?: string;
      startingBid?: number;
      conversionEvent: string;
    } {
  if (src.status === "UNREADABLE") {
    return "LION can't read this source right now (deleted, or the fresh-campaign lag) — its JURO copy would die the same way";
  }
  if (src.stories.length === 0) return "source has no page posts (object stories) to relaunch";
  const pages = juroStoryPages(src.stories);
  if (!pages) return "source post ids are malformed — page underivable";
  // jurar validates every story's page against the executor profile (live 08-25) — pre-check
  // here so the refusal names the page instead of LION's opaque reject.
  for (const p of pages) {
    if (!binds.profilePages.has(p.pageId)) {
      return `source page ${p.pageId} is not on the picked profile — pick a profile that carries this fanpage`;
    }
  }
  const countries = juroWireCountries(s.override, src.countries);
  if (countries.length === 0) {
    return "source geo unreadable — set a Targeting override on this row";
  }
  // jurar has no bid inheritance: whatever rides the wire IS the new campaign's strategy — the
  // row's switch (09-08) or the source's. juroBidPlan owns the rules (typed-bid duties, lowest
  // refusals, unreadable sources — tests/juro.test.ts); the scaling to LION's wire unit is here.
  const plan = juroBidPlan({
    sourceStrategy: src.bidStrategy,
    override: s.bidStrategyOverride,
    typedBid: s.bid,
    sourceBid: src.bid,
  });
  if ("refusal" in plan) return plan.refusal;
  let startingBid: number | undefined;
  if (plan.human != null) {
    const wire = hsWireBid(plan.human, plan.strategy, "lion");
    if (wire == null) {
      return plan.kind === "roas"
        ? "roas goal ambiguous — type the decimal goal (0,30 = 30%)"
        : "bid not resolvable for this source — clear the Bid to use the source's";
    }
    startingBid = wire;
  }
  const bidStrategy = plan.wireStrategy;
  const locales =
    s.override && s.override.localeIds.length > 0
      ? s.override.localeIds.map((id) => ({ id, name: binds.localeNames.get(id) ?? "" }))
      : src.locales;
  return {
    stories: src.stories,
    pages,
    countries,
    locales,
    bidStrategy,
    startingBid,
    // The pairing follows the EFFECTIVE strategy: a ROAS switch value-optimizes PURCHASE.
    conversionEvent: juroConversionEvent(plan.strategy),
  };
}

/**
 * Fire-and-forget worker: reads every distinct source ONCE (details/ + targeting/), then
 * 1) submits the shots one at a time with a 1–3s jitter (profile-block pacing, same as the
 *    duplicate pump); every wire piece is resolved from the SOURCE facts with readable refusals;
 * 2) polls creation-status + the details/ reality check, finishing each shot after COMPLETED
 *    with ads (jurar campaigns are BORN ACTIVE — the activate call is a belt that also heals a
 *    PAUSED birth; "already active" answers count as success).
 * Non-transient Meta walls (account certification, verified-advertiser, DSA beneficiary) settle
 * shots early with the actionable reason instead of spinning on LION's retry loop.
 */
async function pumpJuro(user: string, shots: JuroShot[], deadline: number): Promise<void> {
  try {
    // ---- phase 0: one batched source read for the whole wave ----
    let sources: Record<string, LionJuroSource>;
    try {
      sources = await lionJuroSources([...new Set(shots.map((s) => s.campaignId))]);
    } catch (e) {
      const msg = `lion_source_read_failed: ${(e as Error).message ?? e}`;
      for (const s of shots) {
        s.settled = true;
        await rowWrite(user, s.taskId, { status: "error", error: msg, finished_at: Date.now() });
      }
      return;
    }

    const familyFailed = new Map<string, string>();

    // ---- phase 1: jittered submits ----
    for (let i = 0; i < shots.length; i++) {
      if (Date.now() > deadline - 30_000) {
        for (let j = i; j < shots.length; j++) {
          const rest = shots[j];
          if (rest.settled || rest.lionTaskId) continue;
          rest.settled = true;
          await rowWrite(user, rest.taskId, {
            status: "error",
            error: "Not submitted — the wave's server window closed before this shot (LION was slow). Re-fire it.",
            finished_at: Date.now(),
          });
        }
        break;
      }
      const s = shots[i];
      // Family failures are keyed per source AND profile: the same source may be fine on a row
      // bound to another profile (per-row destinations, 09-08).
      const familyKey = `${s.campaignId}|${s.binds.profile}`;
      if (familyFailed.has(familyKey)) {
        s.settled = true;
        await rowWrite(user, s.taskId, {
          status: "error",
          error: familyFailed.get(familyKey),
          finished_at: Date.now(),
        });
        continue;
      }
      // THIS shot's destination (per-row binds, 09-08): its profile's page catalog / locale
      // names resolve the wire, its account takes the launch slot, its binds ride to LION.
      const binds = {
        profile: s.binds.profile,
        account: s.binds.account,
        pixel: s.binds.pixel,
        accountName: s.accountName,
        profilePages: s.profilePages,
        localeNames: s.localeNames,
      };
      const wire = resolveShotWire(s, sources[s.campaignId], binds);
      if (typeof wire === "string") {
        // A page/geo/bid refusal is a fact of the SOURCE for this profile — copies of the source
        // bound to the same profile refuse identically; other rows may carry another profile.
        familyFailed.set(`${s.campaignId}|${s.binds.profile}`, wire);
        s.settled = true;
        await rowWrite(user, s.taskId, { status: "error", error: wire, finished_at: Date.now() });
        continue;
      }
      // Owner rule 2026-09-07: JURO copies land on the source post's OWN fanka — it must be OK in
      // hs-tools like any picked page (family-scoped: every copy of this source refuses alike).
      const fankaRefusal = await hsPageRefusal("br", wire.pages.map((p) => ({ id: p.pageId })));
      if (fankaRefusal) {
        familyFailed.set(s.campaignId, fankaRefusal.error);
        s.settled = true;
        await rowWrite(user, s.taskId, { status: "error", error: fankaRefusal.error, finished_at: Date.now() });
        continue;
      }
      let slotDoc: string | null = null;
      try {
        slotDoc = (
          await claimAcctSlot(acctKey(binds.account), {
            user,
            partner: "br",
            channel: "hs-juro",
            name: s.label || `JURO copy of ${s.campaignId}`,
            accountName: binds.accountName || "",
          })
        ).documentId;
        const result = await lionJurar({
          profile_slug: binds.profile,
          account_id: binds.account,
          pixel_id: binds.pixel,
          object_story_ids: wire.stories,
          starting_budget: Math.round(s.budget * 100),
          country_codes: wire.countries,
          locales: wire.locales,
          name_suffix: s.suffix,
          ...(wire.bidStrategy ? { bid_strategy: wire.bidStrategy } : {}),
          ...(wire.startingBid != null ? { starting_bid: wire.startingBid } : {}),
          conversion_event: wire.conversionEvent,
        });
        const lionTaskId = (result.task_ids ?? []).map(String).filter(Boolean)[0];
        if (lionTaskId) {
          s.lionTaskId = lionTaskId;
          await rowWrite(user, s.taskId, { link: lionTaskId, started_at: Date.now() });
          // Registry ledger, optimistically at submit: the copy re-creates one ad per source
          // post ON THE POST'S OWN PAGE (that's where jurar ads live — not on a bind page).
          await reportPagesUsed("br", wire.pages);
        } else {
          await releaseAcctSlot(slotDoc);
          const reason = result.reason || result.message || `LION rejected the jurar (${result.result ?? "no result"})`;
          familyFailed.set(familyKey, reason);
          s.settled = true;
          await rowWrite(user, s.taskId, { status: "error", error: reason, finished_at: Date.now() });
        }
      } catch (e) {
        // Window full: every later shot into the SAME account hits it too — those settle with
        // the countdown and are skipped, other accounts' shots keep going (per-row destinations,
        // 09-08). Registry down settles the whole rest of the wave.
        if (e instanceof AcctLimitedError || /acct_limit_unavailable/.test(String((e as Error).message ?? ""))) {
          const msg = (e as Error).message ?? String(e);
          const registryDown = !(e instanceof AcctLimitedError);
          for (let j = i; j < shots.length; j++) {
            const rest = shots[j];
            if (rest.settled || rest.lionTaskId) continue;
            if (!registryDown && j > i && acctKey(rest.binds.account) !== acctKey(s.binds.account)) continue;
            rest.settled = true;
            await rowWrite(user, rest.taskId, { status: "error", error: msg, finished_at: Date.now() });
          }
          if (registryDown) break;
          if (i < shots.length - 1) await sleep(jitter());
          continue;
        }
        // Clean 4xx = LION refused, nothing was created (slot back, family settles). Anything
        // else (5xx/transport/timeout) is AMBIGUOUS — and unlike duplicate's PAUSED births, a
        // jurar campaign LION accepted despite the lost answer is born ACTIVE and spending, with
        // no task id for phase 2 to reconcile. The row must say so before the buyer re-fires.
        const clean4xx = e instanceof LionError && e.status !== undefined && e.status < 500;
        const msg = clean4xx
          ? `lion_jurar_failed: ${(e as Error).message ?? e}`
          : `lion_jurar_failed (AMBIGUOUS — a JURO campaign MAY have been created and born ACTIVE; check LION/Ads Manager before re-firing): ${(e as Error).message ?? e}`;
        if (clean4xx) {
          familyFailed.set(familyKey, msg);
          await releaseAcctSlot(slotDoc);
        }
        s.settled = true;
        await rowWrite(user, s.taskId, { status: "error", error: msg, finished_at: Date.now() });
      }
      if (i < shots.length - 1) await sleep(jitter());
    }

    // ---- phase 2: poll + finish rows ----
    const finalize = async (s: JuroShot, cloneId: string, adCount: number) => {
      s.settled = true;
      // Born ACTIVE (live 08-25) — this is a belt for a PAUSED birth; "already active" = success.
      await lionSetCampaignStatus(cloneId, "ACTIVE").catch(() => {});
      await rowWrite(user, s.taskId, {
        status: "done",
        stage: "ads",
        campaign_id: cloneId,
        ad_id: String(adCount),
        finished_at: Date.now(),
      });
    };
    /** A wall answer settles a shot as failed; the ad-less shell it leaves is born ACTIVE, so a
     *  best-effort pause rides along (LION 404s status/ on 0-ad shells — reported honestly). */
    const settleWall = async (s: JuroShot, reason: string) => {
      s.settled = true;
      let note = "";
      if (s.cloneId) {
        const paused = await lionSetCampaignStatus(s.cloneId, "PAUSED").then(
          (r) => r.ok,
          () => false,
        );
        note = paused
          ? " Shell campaign paused."
          : " Shell campaign left ACTIVE with 0 ads ($0) — LION can't pause ad-less shells; delete it in the UI.";
      }
      await rowWrite(user, s.taskId, {
        status: "error",
        error: reason + note,
        ...(s.cloneId ? { campaign_id: s.cloneId } : {}),
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
        let accountWall: string | null = null;
        for (const s of pending) {
          // A family-wall sweep below may have settled this shot within the same pass.
          if (s.settled) continue;
          const r = byId.get(s.lionTaskId as string);
          if (!r) continue;
          if (r.campaign_id && !s.cloneId) {
            s.cloneId = String(r.campaign_id);
            await rowWrite(user, s.taskId, { campaign_id: s.cloneId });
          }
          if (r.status === "COMPLETED" && r.campaign_id) {
            await finalize(s, String(r.campaign_id), (r.ad_ids ?? []).length || 1);
            continue;
          }
          if (r.status === "NO_COUNTRIES_LEFT") {
            s.settled = true;
            await rowWrite(user, s.taskId, {
              status: "error",
              error: "LION: no eligible countries left for this campaign",
              finished_at: Date.now(),
            });
            continue;
          }
          // Non-transient Meta wall in the task's retry loop → settle now with the real reason
          // instead of spinning until the deadline (live 08-25: the certification loop is
          // endless; LION never fails the task).
          const wall = juroBlockingError(r.error?.message);
          if (wall) {
            await settleWall(s, wall.reason);
            if (wall.scope === "account") {
              accountWall = wall.reason;
            } else {
              // Family wall (geo-bound): the source's other pending copies hit it identically —
              // settle them now instead of letting them spin on LION's retry loop.
              for (const sib of shots.filter((x) => !x.settled && x.campaignId === s.campaignId)) {
                await settleWall(sib, wall.reason);
              }
            }
          }
        }
        if (accountWall) {
          // One wave = one target account — the wall deterministically kills every other shot.
          for (const s of shots.filter((x) => !x.settled)) await settleWall(s, accountWall);
          break;
        }
        if (Date.now() - lastReality > 40_000) {
          lastReality = Date.now();
          const ids = [...new Set(shots.filter((s) => !s.settled && s.cloneId).map((s) => s.cloneId as string))];
          if (ids.length > 0) {
            const real = await lionCampaignAds(ids).catch(() => ({}) as Record<string, never>);
            for (const s of shots.filter((x) => !x.settled && x.cloneId)) {
              const c = (real as Record<string, { status: string; adsCount: number } | undefined>)[s.cloneId as string];
              if (c && c.adsCount > 0) await finalize(s, s.cloneId as string, c.adsCount);
            }
          }
        }
      } catch {
        /* transient LION/store blip — next tick retries */
      }
      if (Date.now() >= deadline) break;
      await sleep(10_000);
    }
  } catch {
    /* the pump must never throw into the runtime — rows left running are picked up later */
  }
}
