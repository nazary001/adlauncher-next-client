import { NextResponse, after } from "next/server";
import { bidKind, parseMoney } from "@/lib/types";
import { hsEnsureTokenMark, hsNormalizedConstraints, hsWireBid } from "@/lib/hs-launch";
import {
  juroBlockingError,
  juroConversionEvent,
  juroEnsureMark,
  juroSourceGeo,
  juroSourceLocaleIds,
  juroStoryPages,
  juroTokenCountries,
  juroTokenRegionalCategories,
  juroTokenTargeting,
} from "@/lib/juro";
import { reportPagesUsed } from "@/lib/hs-pages";
import { type GeoOverride, parseGeoOverride } from "@/lib/targeting-override";
import { sessionFromCookieHeader } from "@/lib/session";
import { readAppCache, writeAppCache } from "@/lib/app-cache";
import { stampHsTaskRow, upsertTaskRow } from "@/lib/task-store";
import { FbError, withFbBudget } from "@/lib/fb-graph";
import {
  hsCreateAdset,
  hsFbGet,
  hsFbPost,
  hsPauseCampaign,
  hsTokenAccountIds,
  hsTokenConfigured,
  hsTokenGate,
  hsTokenStartTime,
} from "@/lib/hs-token-launch";
import { SUPPORTED_BID_STRATEGIES, adPayload } from "@/lib/fb-launch";
import { launchFailureDisposition, partialFailureNote } from "@/lib/launch-guards";
import { ACCOUNT_NOT_ASSIGNED_MSG, accountAllowedFor } from "@/lib/acct-assignments";
import { LionError, lionAccountPixels, lionConfigured, lionProfileData } from "@/lib/lion";
import {
  ACCT_LIMIT,
  AcctLimitedError,
  acctKey,
  acctLimitMessage,
  acctLimitSnapshot,
  claimAcctSlot,
  releaseAcctSlot,
} from "@/lib/acct-limit";

export const runtime = "nodejs";
// Fire-and-forget like the other HS wave routes: the response returns at once and an after()
// pump keeps building — each token JURO copy is a small Graph tree (source read + campaign/
// adset/creatives-from-posts/ads, NO media migration), so the wave cap below fits the window.
export const maxDuration = 800;

const PUMP_BUDGET_MS = 770_000;
/** Same wave cap as the token duplicator: trees build ONE at a time; a bigger wave goes out as
 *  two fires (the board mirrors this cap client-side). */
const MAX_TOKEN_SHOTS = 10;

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = () => 1000 + Math.random() * 2000;

// Same-instance wave-claim backstop (see /api/hs/duplicate — identical idempotency contract).
const claimedWaves = new Set<string>();
function rememberWave(waveId: string): void {
  if (claimedWaves.size > 1000) claimedWaves.clear();
  claimedWaves.add(waveId);
}

type Json = Record<string, unknown>;

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
  const acct = data.accounts.find((a) => a.id === account);
  if (!acct) return { error: bad("account_not_on_profile") };
  if (acct.status !== 1) return { error: bad("account_disabled") };
  let pixels;
  try {
    pixels = await lionAccountPixels(profile, account);
  } catch (e) {
    return { error: bad(`lion_unreachable: ${(e as Error).message}`, 502) };
  }
  if (!pixels.some((p) => p.id === pixel)) return { error: bad("pixel_not_on_account") };
  return { currency: acct.currency || "USD", accountName: acct.name || "" };
}

type TokenJuroShot = {
  campaignId: string;
  budget: number;
  budgetRaw: string;
  bid: number | null;
  /** TARGET bid strategy (per-row ROAS ↔ cap ↔ lowest switch, owner ask 09-01) — this rail
   *  builds a fresh ad set, so it can re-bid it. "" = ride the source's strategy. */
  bidStrategyOverride: string;
  /** Full campaign name built by the board (grammar prefix + JURO + TOKEN + tail); the pump
   *  re-ensures both markers server-side — client names are never the truth. */
  name: string;
  geo: string;
  label: string;
  taskId: string;
  override: GeoOverride | null;
  settled?: boolean;
};

/**
 * POST /api/hs/token-jurar — the JURO rail's FB-Token channel: the same "new campaign from the
 * source's page posts" launch /api/hs/jurar performs through LION, built directly on the Graph
 * with OUR partner-side token pool (like /api/hs/token-duplicate). The ads are re-created from
 * the source ads' object stories, so they live ON the post's own fanpage with its social proof;
 * targeting is the fresh jurar shape (country-level geo + ages 18–65) with the buyer's override
 * — and, unlike LION's wire, the source's LANGUAGES survive. Fire-and-forget: rows are stamped
 * before the response and an after() pump settles them; the tab may close immediately.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const startedAt = Date.now();
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return bad("unauthorized", 401);
  if (!hsTokenConfigured()) {
    return bad("hs_fb_token_missing — set FB_HS_LAUNCH_TOKEN (or FB_HS_VOLUME_TOKEN) in the environment", 500);
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
       *  adset fields by the EFFECTIVE strategy in the pump (empty = inherit the source's bid). */
      bid?: string;
      /** Optional TARGET bid strategy (ROAS ↔ cap ↔ lowest) — empty rides the source's. */
      bidStrategyOverride?: string;
      name?: string;
      geo?: string;
      label?: string;
      countries?: string[];
      locales?: string[];
    }[];
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return bad("bad_json");
  }

  const profile = String(body.profile ?? "").trim();
  const account = String(body.account ?? "").trim();
  const pixel = String(body.pixel ?? "").trim();
  if (!profile) return bad("profile_required");
  if (!account) return bad("account_required");
  if (!pixel) return bad("pixel_required");
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
    shots.push({
      campaignId,
      budget,
      budgetRaw: String(raw?.budget ?? ""),
      bid,
      bidStrategyOverride: strategyOverride,
      name: String(raw?.name ?? "").trim().slice(0, 200),
      geo: String(raw?.geo ?? "").slice(0, 40) || "inherited",
      label: String(raw?.label ?? "").trim().slice(0, 200),
      override,
      taskId: `hsjt-${waveId}-${String(shots.length).padStart(2, "0")}`,
    });
  }

  // Fire-time belt over the picker filter: /accounts assignments hold even for a crafted POST.
  if (!(await accountAllowedFor(session, account))) return bad(ACCOUNT_NOT_ASSIGNED_MSG, 403);
  const binds = await validateBinds(profile, account, pixel);
  if ("error" in binds) return binds.error;

  // The TARGET must be visible to our token (LION binds cover segments the token was never
  // granted — aleph, 08-19). A failed sweep (null) falls OPEN; an unreadable SOURCE still fails
  // per shot inside the pump with its own actionable reason.
  {
    const visible = await hsTokenAccountIds();
    if (visible && !visible.has(acctKey(account))) {
      return bad(
        "account_not_visible_to_fb_token — our FB token was never granted this ad account; run JURO on the LION API rail (or pick a token-visible account)",
      );
    }
  }

  // Account launch-limit precheck — the wave lands in ONE account (same rule as the LION rail).
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
        `account_limit — only ${Math.max(0, remaining)} of ${shots.length} JURO copies fit this account's 30-min window${tail}`,
        429,
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

  // All bearers burned → refuse the wave BEFORE stamping rows, with the retry ETA. Runs AFTER
  // the idempotency answers above (a re-POST of an accepted wave must say alreadyAccepted, not
  // 429 off the pool its own pump just burned — same order as token-duplicate).
  {
    const gate = await hsTokenGate();
    if (!gate.ok) return bad(gate.error, 429);
  }

  // Rows land in the shared store BEFORE the claim and the response (durability contract —
  // see /api/hs/duplicate). Row names carry both markers like the campaigns will.
  await Promise.all(
    shots.map((s) =>
      stampHsTaskRow(session.username, {
        taskId: s.taskId,
        name: hsEnsureTokenMark(juroEnsureMark(s.name || s.label || `copy of ${s.campaignId}`)),
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
  // The whole pump runs under the FB retry budget (AsyncLocalStorage): mid-wave throttles wait
  // out Meta's regain estimate instead of failing shots — never past the pump's own deadline.
  after(() =>
    withFbBudget({ deadlineAt: deadline, retries: 8 }, () =>
      pumpTokenJuro(user, { account: acctKey(account), pixel, accountName: binds.accountName }, shots, deadline),
    ),
  );

  return NextResponse.json({
    ok: true,
    queued: shots.length,
    rows: shots.map((s) => ({ taskId: s.taskId })),
    currency: binds.currency,
  });
}

const rowWrite = (user: string, taskId: string, fields: Record<string, unknown>) =>
  upsertTaskRow(user, taskId, { ...fields, partner: "br" }).then(
    () => undefined,
    () => undefined,
  );

/** What one JURO copy needs from the SOURCE: the ads' object stories + the first ad set's
 *  targeting/bid + the campaign facts. Cached per campaign id across a wave's copies. */
type JuroTree = {
  name: string;
  objective: string;
  specialCategories: string[];
  bidStrategy: string;
  adset: Json;
  stories: string[];
};

async function readJuroTree(campaignId: string): Promise<JuroTree> {
  const fields = [
    "name",
    "objective",
    "special_ad_categories",
    "bid_strategy",
    "adsets.limit(1){targeting,bid_amount,bid_constraints,bid_strategy}",
    // effective_object_story_id resolves the REAL post even for spec-built ads (our launcher's
    // video_data creatives have no object_story_id but do have an effective story) — a superset
    // of what LION's details read offers, so token JURO also covers launcher-born sources.
    "ads.limit(25){creative{effective_object_story_id,object_story_id}}",
  ].join(",");
  const obj = await hsFbGet(`${campaignId}?fields=${encodeURIComponent(fields)}`);
  const adset = ((obj.adsets as { data?: Json[] } | undefined)?.data?.[0] ?? {}) as Json;
  const ads = ((obj.ads as { data?: Json[] } | undefined)?.data ?? []) as Json[];
  const stories = [
    ...new Set(
      ads
        .map((a) => {
          const c = (a.creative ?? {}) as Json;
          return String(c.effective_object_story_id ?? c.object_story_id ?? "");
        })
        .filter(Boolean),
    ),
  ];
  const cats = obj.special_ad_categories as string[] | undefined;
  return {
    name: String(obj.name ?? campaignId),
    objective: typeof obj.objective === "string" ? obj.objective : "OUTCOME_SALES",
    specialCategories: Array.isArray(cats) ? cats.filter((c) => c && c !== "NONE") : [],
    bidStrategy:
      typeof obj.bid_strategy === "string"
        ? obj.bid_strategy
        : typeof adset.bid_strategy === "string"
          ? adset.bid_strategy
          : "LOWEST_COST_WITHOUT_CAP",
    adset,
    stories,
  };
}

/** Per-shot wire pieces resolved from the SOURCE tree. String = the actionable refusal (family-
 *  scoped: every copy of the source refuses identically). */
function resolveShotWire(
  s: TokenJuroShot,
  tree: JuroTree,
):
  | string
  | {
      stories: string[];
      pages: { pageId: string; delta: number }[];
      countries: string[];
      localeIds: number[];
      /** The copy's EFFECTIVE bid strategy (per-row switch or the source's). */
      strategy: string;
      bidAmount?: number;
      bidConstraints?: Json;
      roas: boolean;
      conversionEvent: string;
    } {
  if (tree.stories.length === 0) return "source has no page posts (object stories) to relaunch";
  const pages = juroStoryPages(tree.stories);
  if (!pages) return "source post ids are malformed — page underivable";
  const targeting = (tree.adset.targeting ?? {}) as Json;
  const countries = juroTokenCountries(s.override, juroSourceGeo(targeting));
  if (countries.length === 0) {
    return "source geo unreadable — set a Targeting override on this row";
  }
  // The copy's EFFECTIVE strategy: the buyer's per-row switch wins (owner ask 09-01 — this rail
  // builds a fresh ad set, so ROAS ↔ cap ↔ lowest are all reachable); "" rides the source's.
  const strategy = s.bidStrategyOverride || tree.bidStrategy;
  const switched = strategy !== tree.bidStrategy;
  const kind = bidKind(strategy);
  let bidAmount: number | undefined;
  let bidConstraints: Json | undefined;
  if (s.bid != null) {
    if (kind === "none") {
      // Same honesty rule as the other clone rails: a bid on a lowest-cost copy would be
      // silently meaningless — refuse instead of pretending it applied.
      return "the copy bids lowest-cost (no cap) — clear the Bid on this row";
    }
    const wire = kind === "roas" && s.bid > 100 ? null : hsWireBid(s.bid, strategy, "graph");
    if (wire == null) {
      return kind === "roas"
        ? "roas goal ambiguous — type the decimal goal (0,30 = 30%)"
        : "bid not resolvable — retype the Bid on this row";
    }
    if (kind === "roas") bidConstraints = { roas_average_floor: wire };
    else bidAmount = wire;
  } else if (switched && kind !== "none") {
    // A switched cap/ROAS copy has nothing to inherit — the source's bid means a different thing.
    return `strategy switched to ${strategy} — type a Bid on this row (the source's bid doesn't carry across strategies)`;
  } else if (kind !== "none") {
    // No override → inherit the source ad set's own bid. The new campaign RIDES the source's
    // strategy, so a cap/ROAS source NEEDS the value — an unreadable one would birth a campaign
    // whose ad set Meta then rejects (orphan shell); refuse up front instead.
    if (typeof tree.adset.bid_amount === "number") bidAmount = tree.adset.bid_amount as number;
    if (tree.adset.bid_constraints) bidConstraints = hsNormalizedConstraints(tree.adset.bid_constraints as Json);
    if (kind === "cap" && bidAmount == null) return "source bid unreadable right now — type a Bid on this row";
    if (kind === "roas" && !bidConstraints) return "source ROAS floor unreadable right now — type a Bid on this row";
  }
  return {
    stories: tree.stories,
    pages,
    countries,
    localeIds:
      s.override && s.override.localeIds.length > 0 ? s.override.localeIds : juroSourceLocaleIds(targeting),
    strategy,
    bidAmount,
    bidConstraints,
    roas: kind === "roas",
    conversionEvent: juroConversionEvent(strategy),
  };
}

/** The name of the fanpage carrying a story — the ad's DSA beneficiary/payor (our token CAN set
 *  those, so token JURO escapes the EU-DSA wall that blocks LION's jurar) and the token's page-
 *  access pre-check in one read: a page the token can't see would fail at creative create anyway,
 *  AFTER the campaign shell exists — this fails the shot before anything is born. Successful
 *  reads are cached; failures are re-tried per shot (they may be transient throttles). */
async function juroPageName(pageId: string, cache: Map<string, string>): Promise<string> {
  const hit = cache.get(pageId);
  if (hit !== undefined) return hit;
  let bodyName = "";
  try {
    const body = await hsFbGet(`${pageId}?fields=name`);
    bodyName = typeof body.name === "string" ? body.name : "";
  } catch (e) {
    // Pool-wide limit keeps its own message (transient); anything else = the token genuinely
    // can't use this page's posts — the actionable reason names the page and the way out.
    if (e instanceof FbError && e.status === 429) throw e;
    throw new FbError(
      `source page ${pageId} is not usable by our FB token (${(e as Error).message ?? e}) — its posts can't be relaunched on this rail; run this source's JURO on the LION API rail`,
      e,
    );
  }
  cache.set(pageId, bodyName);
  return bodyName;
}

/**
 * The token JURO pump: one copy = one small Graph tree (campaign → adset → one creative+ad per
 * source post), sequential with the playbook jitter. Rows are settled here (done with campaign
 * id + ad count, or the actionable error); a partial failure pauses the born-ACTIVE tree, and
 * the non-transient Meta walls (account certification / verified-advertiser) settle the rest of
 * the wave/family early instead of building more trees into the same wall.
 */
async function pumpTokenJuro(
  user: string,
  binds: { account: string; pixel: string; accountName: string },
  shots: TokenJuroShot[],
  deadline: number,
): Promise<void> {
  try {
    const treeCache = new Map<string, JuroTree>();
    const pageNameCache = new Map<string, string>();
    const familyFailed = new Map<string, string>();

    for (let i = 0; i < shots.length; i++) {
      if (Date.now() > deadline - 60_000) {
        for (let j = i; j < shots.length; j++) {
          const rest = shots[j];
          if (rest.settled) continue;
          rest.settled = true;
          await rowWrite(user, rest.taskId, {
            status: "error",
            error: "Not built — the wave's server window closed before this copy. Re-fire it.",
            finished_at: Date.now(),
          });
        }
        break;
      }
      const s = shots[i];
      if (familyFailed.has(s.campaignId)) {
        s.settled = true;
        await rowWrite(user, s.taskId, { status: "error", error: familyFailed.get(s.campaignId), finished_at: Date.now() });
        continue;
      }

      let acctSlot: { documentId: string } | null = null;
      const created: Json = {};
      try {
        await rowWrite(user, s.taskId, { status: "running", stage: "queue", started_at: Date.now() });

        // Account launch slot (5/30min) — right before the build; released on pre-campaign failure.
        acctSlot = await claimAcctSlot(binds.account, {
          user,
          partner: "br",
          channel: "hs-juro-token",
          name: s.name || s.label || `JURO copy of ${s.campaignId}`,
          accountName: binds.accountName,
        });

        let tree = treeCache.get(s.campaignId);
        if (!tree) {
          try {
            tree = await readJuroTree(s.campaignId);
          } catch (e) {
            // Unreadable SOURCE = the token was never granted its account (or the id is gone) —
            // family-scoped, with the way out named. Pool-wide throttle keeps its own message.
            if (e instanceof FbError && e.status === 429) throw e;
            const reason = `our FB token can't read source campaign ${s.campaignId} (${(e as Error).message ?? e}) — run its JURO on the LION API rail`;
            familyFailed.set(s.campaignId, reason);
            throw new FbError(reason, e);
          }
          treeCache.set(s.campaignId, tree);
        }

        const wire = resolveShotWire(s, tree);
        if (typeof wire === "string") {
          familyFailed.set(s.campaignId, wire);
          throw new FbError(wire, { campaignId: s.campaignId });
        }

        // Page-access pre-check + the DSA declaration value, BEFORE anything is created.
        let pageName = "";
        for (const p of wire.pages) {
          const n = await juroPageName(p.pageId, pageNameCache);
          if (!pageName) pageName = n;
        }

        // Server-side truth for the markers: whatever name arrives, a token-JURO campaign
        // carries both `API - JURO -` and `TOKEN` in its fixed part.
        const name = hsEnsureTokenMark(juroEnsureMark(s.name || tree.name));

        // creatives FIRST — a story creative is an account-library object with no delivery, so
        // building them before the campaign means a dead source post (deleted/expired — Meta
        // subcode 2446289, probed live 08-27 on a 17-day-old source) refuses the shot with ZERO
        // shells born instead of stranding a paused campaign+adset. Orphans are deleted on any
        // later failure (see catch).
        const creativeIds: string[] = [];
        created.creative_ids = creativeIds;
        for (let m = 0; m < wire.stories.length; m++) {
          const adName = wire.stories.length > 1 ? `${name} · ${m + 1}` : name;
          try {
            const creative = await hsFbPost(`act_${binds.account}/adcreatives`, {
              name: adName,
              object_story_id: wire.stories[m],
            });
            if (!creative.id) throw new FbError("creative create returned no id", creative);
            creativeIds.push(String(creative.id));
          } catch (e) {
            if (e instanceof FbError && e.status === 429) throw e;
            // Deterministic for every copy of this source — the post itself is the problem.
            const reason = `source post ${wire.stories[m]} can't be reused (${(e as Error).message ?? e}) — the post may be deleted/expired or our token lacks rights on its page; pick a fresher source or run it on the LION API rail`;
            familyFailed.set(s.campaignId, reason);
            throw new FbError(reason, e);
          }
        }

        // campaign — CBO with the buyer's budget, the source's objective, the EFFECTIVE bid
        // strategy (per-row switch or the source's), ACTIVE.
        const camp = await hsFbPost(`act_${binds.account}/campaigns`, {
          name,
          objective: tree.objective,
          status: "ACTIVE",
          special_ad_categories: tree.specialCategories,
          daily_budget: Math.round(s.budget * 100),
          bid_strategy: wire.strategy,
        });
        created.campaign_id = String(camp.id);
        await rowWrite(user, s.taskId, { status: "running", stage: "adset", campaign_id: created.campaign_id });

        // adset — FRESH jurar-style targeting (geo/locales from the wire, 18–65, Advantage+
        // placements), the binds' pixel with jurar's conversion pairing (PURCHASE on min-ROAS,
        // CONTENT_VIEW otherwise), the partner's +30 min start gap, the page's DSA declaration;
        // regional declarations self-heal inside hsCreateAdset.
        const adsetPayload: Json = {
          name,
          campaign_id: String(camp.id),
          status: "ACTIVE",
          billing_event: "IMPRESSIONS",
          optimization_goal: wire.roas ? "VALUE" : "OFFSITE_CONVERSIONS",
          targeting: juroTokenTargeting(wire.countries, wire.localeIds),
          start_time: hsTokenStartTime(),
          promoted_object: { pixel_id: binds.pixel, custom_event_type: wire.conversionEvent },
        };
        if (pageName) {
          adsetPayload.dsa_beneficiary = pageName;
          adsetPayload.dsa_payor = pageName;
        }
        if (wire.bidAmount != null) adsetPayload.bid_amount = wire.bidAmount;
        if (wire.bidConstraints) adsetPayload.bid_constraints = wire.bidConstraints;
        const cats = juroTokenRegionalCategories(wire.countries);
        if (cats.length) adsetPayload.regional_regulated_categories = cats;
        const adset = await hsCreateAdset(`act_${binds.account}/adsets`, adsetPayload);
        created.adset_id = String(adset.id);
        await rowWrite(user, s.taskId, { status: "running", stage: "ads", adset_id: created.adset_id });

        // ads — one per pre-built story creative (the post keeps its page and social proof;
        // nothing is re-uploaded or migrated).
        const adIds: string[] = [];
        for (let m = 0; m < creativeIds.length; m++) {
          const adName = creativeIds.length > 1 ? `${name} · ${m + 1}` : name;
          const ad = await hsFbPost(`act_${binds.account}/ads`, adPayload(adName, String(adset.id), creativeIds[m]));
          if (!ad.id) throw new FbError("ad create returned no id", ad);
          adIds.push(String(ad.id));
          // Progress lands on `created` AS ads are born — the catch below reads it to know
          // whether the ACTIVE tree already carries deliverable ads when a later ad throws.
          created.ad_ids = [...adIds];
        }

        s.settled = true;
        await rowWrite(user, s.taskId, {
          status: "done",
          stage: "ads",
          campaign_id: created.campaign_id,
          adset_id: created.adset_id,
          ad_id: String(adIds.length),
          finished_at: Date.now(),
          error: null,
        });
        // Registry ledger: the copy re-creates one ad per source post ON THE POST'S OWN PAGE
        // (that's where JURO ads live — not on a bind page).
        await reportPagesUsed("br", wire.pages);
      } catch (e) {
        const err = e as FbError;
        if (acctSlot && !created.campaign_id) await releaseAcctSlot(acctSlot.documentId);
        // Window full / registry down stops the whole wave (one account) — same as the LION pump.
        if (e instanceof AcctLimitedError || /acct_limit_unavailable/.test(String(err.message ?? ""))) {
          for (let j = i; j < shots.length; j++) {
            const rest = shots[j];
            if (rest.settled) continue;
            rest.settled = true;
            await rowWrite(user, rest.taskId, { status: "error", error: err.message, finished_at: Date.now() });
          }
          break;
        }
        // The tree is born ACTIVE with only the +30 min start gap between a partial failure and
        // unattended delivery — pause the campaign (bounded) and put the confirmed state into
        // the row, same contract as the other token rails.
        const disposition = launchFailureDisposition(created);
        const pausedOk = disposition.pauseNeeded ? await hsPauseCampaign(String(created.campaign_id)) : false;
        // No ad ever referenced the pre-built story creatives → they are orphans; best-effort
        // delete keeps the account's creative library clean (they never deliver either way).
        if (disposition.adsLive === 0 && Array.isArray(created.creative_ids)) {
          for (const cid of created.creative_ids as string[]) {
            await hsFbPost(String(cid), { method: "delete" }).catch(() => {});
          }
        }
        s.settled = true;
        await rowWrite(user, s.taskId, {
          status: "error",
          error: `${err.message ?? String(e)}${partialFailureNote(disposition, pausedOk)}`,
          finished_at: Date.now(),
          ...(created.campaign_id ? { campaign_id: created.campaign_id } : {}),
          ...(created.adset_id ? { adset_id: created.adset_id } : {}),
        });
        // Non-transient Meta walls arrive as DIRECT Graph errors on this rail (no LION retry
        // loop): an account-scoped wall (non-discrimination certification) deterministically
        // kills every other shot of the wave — settle them now instead of building more trees
        // into it; geo-bound walls settle the source's remaining copies.
        const wall = juroBlockingError(err.message);
        if (wall?.scope === "account") {
          for (const rest of shots.filter((x) => !x.settled)) {
            rest.settled = true;
            await rowWrite(user, rest.taskId, { status: "error", error: wall.reason, finished_at: Date.now() });
          }
          break;
        }
        if (wall?.scope === "family") familyFailed.set(s.campaignId, wall.reason);
      }
      if (i < shots.length - 1) await sleep(jitter());
    }
  } catch {
    /* the pump must never throw into the runtime — strays age out via the HS TM cap */
  }
}
