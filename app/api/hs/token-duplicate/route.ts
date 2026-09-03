import { NextResponse, after } from "next/server";
import { bidKind, parseMoney } from "@/lib/types";
import { SUPPORTED_BID_STRATEGIES } from "@/lib/fb-launch";
import { hsEnsureTokenMark, hsNormalizedConstraints, hsWireBid } from "@/lib/hs-launch";
import { reportPagesUsed } from "@/lib/hs-pages";
import {
  type GeoOverride,
  applyGeoOverride,
  geoOverrideRegionalCategories,
  parseGeoOverride,
} from "@/lib/targeting-override";
import { sessionFromCookieHeader } from "@/lib/session";
import { readAppCache, writeAppCache } from "@/lib/app-cache";
import { stampHsTaskRow, upsertTaskRow } from "@/lib/task-store";
import { FbError, withFbBudget } from "@/lib/fb-graph";
import {
  hsDupActiveToken,
  hsDupCreateAdset,
  hsDupFbGet,
  hsDupFbPost,
  hsDupPauseCampaign,
  hsDupTokenAccountIds,
  hsDupTokenConfigured,
  hsDupTokenGate,
  hsTokenStartTime,
} from "@/lib/hs-token-launch";
import {
  type SourceMedia,
  adPayload,
  cloneCreativePayload,
  extractAdMedia,
  migrateMediaToAccount,
  swapPixel,
} from "@/lib/clone-run";
import { launchFailureDisposition, partialFailureNote } from "@/lib/launch-guards";
import { ACCOUNT_NOT_ASSIGNED_MSG, accountAllowedFor } from "@/lib/acct-assignments";
import { LionError, lionAccountPixels, lionConfigured, lionProfileData } from "@/lib/lion";
import { ACCT_LIMIT, AcctLimitedError, acctKey, acctLimitMessage, acctLimitSnapshot, claimAcctSlot, releaseAcctSlot } from "@/lib/acct-limit";

export const runtime = "nodejs";
// Fire-and-forget like the LION duplicate route: the response returns at once and an after()
// pump keeps building — each token clone is a full Graph tree (reads + optional media migration
// + campaign/adset/creatives/ads), so the wave cap below keeps the whole run inside this window.
export const maxDuration = 800;

const PUMP_BUDGET_MS = 770_000;
/** Token clones are built ONE Graph tree at a time (~20–60s each with migration) — a wave above
 *  this can't reliably finish inside the pump window; the board asks for two waves instead. */
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

/** Bind validation against LION's catalog — the owner rule from the token-LAUNCH rail applies to
 *  token duplicates too: clones may only land where a weapon profile is bound, or the partner's
 *  ingestion never sees them. */
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
  return { currency: acct.currency || "USD", accountName: acct.name || "", pageName: pageRow.name || "" };
}

type TokenShot = {
  campaignId: string;
  budget: number;
  budgetRaw: string;
  bid: number | null;
  bidStrategy: string;
  /** TARGET bid strategy (per-row ROAS ↔ cap ↔ lowest switch, owner ask 09-01) — this rail
   *  rebuilds the ad set, so it can re-bid it. "" = inherit the source's strategy verbatim. */
  bidStrategyOverride: string;
  name: string;
  geo: string;
  label: string;
  taskId: string;
  /** Geo/locales override (Targeting modal) — null = faithful clone of the source's targeting. */
  override: GeoOverride | null;
  settled?: boolean;
};

/**
 * POST /api/hs/token-duplicate — the HS duplicator's FB-Token rail (owner ask 2026-08-18): the
 * same wave shape as /api/hs/duplicate, but OUR partner-side token builds every clone directly
 * on the Graph — source tree read + faithful rebuild (verbatim targeting, all reusable ads,
 * media migrated on cross-account), buyer's budget/bid override, binds' page/pixel, ACTIVE with
 * start_time = +30 min (partner rule). Fire-and-forget: rows are stamped before the response and
 * an after() pump settles them; the tab may close immediately.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const startedAt = Date.now();
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return bad("unauthorized", 401);
  if (!hsDupTokenConfigured()) {
    return bad("hs_fb_token_missing — set FB_HS_DUP_TOKEN (or FB_HS_LAUNCH_TOKEN) in the environment", 500);
  }
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
  const page = String(body.page ?? "").trim();
  const pixel = String(body.pixel ?? "").trim();
  if (!profile) return bad("profile_required");
  if (!account) return bad("account_required");
  if (!page) return bad("page_required");
  if (!pixel) return bad("pixel_required");
  if (!Array.isArray(body.shots) || body.shots.length === 0) return bad("shots_required");
  if (body.shots.length > MAX_TOKEN_SHOTS) return bad(`too_many_shots_max_${MAX_TOKEN_SHOTS}`);

  const waveIdRaw = String(body.waveId ?? "").trim();
  if (waveIdRaw && !/^[a-zA-Z0-9-]{8,64}$/.test(waveIdRaw)) return bad("wave_id_invalid");
  const waveId = waveIdRaw || crypto.randomUUID();

  const shots: TokenShot[] = [];
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
      bidStrategy: String(raw?.bidStrategy ?? "").trim(),
      bidStrategyOverride: strategyOverride,
      name: String(raw?.name ?? "").trim().slice(0, 200),
      geo: String(raw?.geo ?? "").slice(0, 40) || "inherited",
      label: String(raw?.label ?? "").trim().slice(0, 200),
      override,
      taskId: `hstd-${waveId}-${String(shots.length).padStart(2, "0")}`,
    });
  }

  // Fire-time belt over the picker filter: /accounts assignments hold even for a crafted POST.
  if (!(await accountAllowedFor(session, account))) return bad(ACCOUNT_NOT_ASSIGNED_MSG, 403);
  const binds = await validateBinds(profile, account, page, pixel);
  if ("error" in binds) return binds.error;

  // LION binds cover segments our token was never granted (aleph, 08-19) — there the wave burns
  // on the first Graph call. Refuse the TARGET up front; a failed sweep (null) falls OPEN so a
  // Graph blip can't block clones into provably-fine accounts. (An unreadable SOURCE still fails
  // per shot inside the pump — its account is only known after the source read.)
  {
    const visible = await hsDupTokenAccountIds();
    if (visible && !visible.has(acctKey(account))) {
      return bad(
        "account_not_visible_to_fb_token — our FB token was never granted this ad account; duplicate on the LION API rail (or pick a token-visible account)",
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
        `account_limit — only ${Math.max(0, remaining)} of ${shots.length} clones fit this account's 30-min window${tail}`,
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
  // the idempotency answers above: a re-POST of an already-accepted wave must say
  // alreadyAccepted, not 429 off the pool its own pump just burned (review find 08-24).
  {
    const gate = await hsDupTokenGate();
    if (!gate.ok) return bad(gate.error, 429);
  }

  // Rows land in the shared store BEFORE the claim and the response (team visibility + retry
  // safety — same contract as the LION duplicate batch).
  await Promise.all(
    shots.map((s) =>
      stampHsTaskRow(session.username, {
        taskId: s.taskId,
        // TOKEN-marked like the campaign itself will be (hsEnsureTokenMark at create) — the
        // drawer row and the born clone must never disagree about the channel.
        name: hsEnsureTokenMark(s.name || s.label || `Clone of ${s.campaignId}`),
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
    return bad("task_store_unavailable_wave_not_fired", 503);
  }
  rememberWave(waveId);

  const user = session.username;
  const deadline = startedAt + PUMP_BUDGET_MS;
  // The whole pump runs under the FB retry budget (AsyncLocalStorage): mid-wave throttles wait
  // out Meta's regain estimate instead of failing shots — never past the pump's own deadline.
  after(() =>
    withFbBudget({ deadlineAt: deadline, retries: 8 }, () =>
      pumpTokenBatch(
        user,
        { account: acctKey(account), page, pixel, pageName: binds.pageName, accountName: binds.accountName },
        shots,
        deadline,
      ),
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

/** The full source read one clone needs: campaign facts + first ad set (verbatim targeting) +
 *  every ad's creative spec. Cached per campaign id across a wave's copies. */
type SourceTree = {
  name: string;
  objective: string;
  specialCategories: string[];
  bidStrategy: string;
  accountId: string;
  adset: Json;
  medias: SourceMedia[];
};

async function readSourceTree(campaignId: string): Promise<SourceTree> {
  const fields = [
    "name",
    "objective",
    "special_ad_categories",
    "bid_strategy",
    "account_id",
    "adsets.limit(1){targeting,optimization_goal,billing_event,promoted_object,bid_amount,bid_constraints,bid_strategy}",
    "ads.limit(10){creative{object_story_spec,asset_feed_spec}}",
  ].join(",");
  const obj = await hsDupFbGet(`${campaignId}?fields=${encodeURIComponent(fields)}`);
  const adset = ((obj.adsets as { data?: Json[] } | undefined)?.data?.[0] ?? {}) as Json;
  const ads = ((obj.ads as { data?: Json[] } | undefined)?.data ?? []) as Json[];
  const medias = ads.map((a) => extractAdMedia(a)).filter((m): m is SourceMedia => m !== null);
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
    accountId: String(obj.account_id ?? "").replace(/^act_/, ""),
    adset,
    medias,
  };
}

/**
 * The token rail's pump: one clone = one full Graph tree, sequential with the playbook jitter.
 * Rows are settled here (done with campaign id + ad count, or the actionable error); whatever a
 * platform kill strands is aged out by the HS TM's never-submitted cap ("re-fire").
 */
async function pumpTokenBatch(
  user: string,
  binds: { account: string; page: string; pixel: string; pageName: string; accountName: string },
  shots: TokenShot[],
  deadline: number,
): Promise<void> {
  try {
    const treeCache = new Map<string, SourceTree>();
    const migratedCache = new Map<string, SourceMedia>();
    const familyFailed = new Map<string, string>();

    for (let i = 0; i < shots.length; i++) {
      if (Date.now() > deadline - 60_000) {
        for (let j = i; j < shots.length; j++) {
          const rest = shots[j];
          if (rest.settled) continue;
          rest.settled = true;
          await rowWrite(user, rest.taskId, {
            status: "error",
            error: "Not built — the wave's server window closed before this clone. Re-fire it in the duplicator.",
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
          channel: "hs-token-dup",
          name: s.name || s.label || `Clone of ${s.campaignId}`,
          accountName: binds.accountName,
        });

        let tree = treeCache.get(s.campaignId);
        if (!tree) {
          tree = await readSourceTree(s.campaignId);
          treeCache.set(s.campaignId, tree);
        }
        if (tree.medias.length === 0) {
          const reason = "source has no reusable video/image creatives — duplicate it on the LION rail";
          familyFailed.set(s.campaignId, reason);
          throw new FbError(reason, { campaignId: s.campaignId });
        }

        // The clone's EFFECTIVE strategy: the buyer's per-row switch wins (owner ask 09-01 —
        // this rail rebuilds the ad set from scratch, so ROAS ↔ cap ↔ lowest are all
        // reachable); "" inherits the source's verbatim. A typed bid is scaled by the EFFECTIVE
        // strategy; with the strategy unchanged an empty bid inherits the source ad set's own
        // fields, but a SWITCHED cap/ROAS clone has nothing to inherit (the source's bid means
        // a different thing) — the row must type one.
        const strategy = s.bidStrategyOverride || tree.bidStrategy;
        const switched = strategy !== tree.bidStrategy;
        const kind = bidKind(strategy);
        if (switched && kind === "roas" && !((tree.adset.promoted_object ?? {}) as Json).pixel_id) {
          const reason =
            "source isn't conversion-optimized (no promoted pixel) — it can't switch to min-ROAS; pick cap/lowest instead";
          familyFailed.set(s.campaignId, reason);
          throw new FbError(reason, { campaignId: s.campaignId });
        }
        let bidAmount: number | undefined;
        let bidConstraints: Json | undefined;
        if (s.bid != null) {
          // "graph": this rail writes bid_constraints straight to Meta — floor stays ×10000.
          const wire = kind !== "none" && !(kind === "roas" && s.bid > 100) ? hsWireBid(s.bid, strategy, "graph") : null;
          if (wire == null) {
            const reason =
              kind === "none"
                ? "the clone bids lowest-cost — clear the Bid on this row"
                : "bid not applicable/resolvable for this clone — retype the Bid";
            familyFailed.set(s.campaignId, reason);
            throw new FbError(reason, { campaignId: s.campaignId });
          }
          if (kind === "roas") bidConstraints = { roas_average_floor: wire };
          else bidAmount = wire;
        } else if (!switched) {
          // No override → inherit the source ad set's own bid, normalizing a percent/×10 ROAS
          // floor a pre-fix source may still carry (hsNormalizedConstraints) — a broken floor
          // must not propagate into the newborn clone.
          if (typeof tree.adset.bid_amount === "number") bidAmount = tree.adset.bid_amount as number;
          if (tree.adset.bid_constraints) bidConstraints = hsNormalizedConstraints(tree.adset.bid_constraints as Json);
        } else if (kind !== "none") {
          const reason = `strategy switched to ${strategy} — type a Bid on this row (the source's bid doesn't carry across strategies)`;
          familyFailed.set(s.campaignId, reason);
          throw new FbError(reason, { campaignId: s.campaignId });
        }

        // Cross-account: re-home EVERY reusable media in the target before any write (cached per
        // source×index×target — copies of one source migrate once).
        const cross = binds.account !== tree.accountId;
        let medias = tree.medias;
        if (cross) {
          await rowWrite(user, s.taskId, { status: "running", stage: "queue" });
          const migrated: SourceMedia[] = [];
          for (let m = 0; m < tree.medias.length; m++) {
            const mKey = `${s.campaignId}:${m}→${binds.account}`;
            let done = migratedCache.get(mKey);
            if (!done) {
              done = await migrateMediaToAccount(tree.medias[m], tree.accountId, binds.account, `${s.name || tree.name} · media ${m + 1}`, await hsDupActiveToken());
              migratedCache.set(mKey, done);
            }
            migrated.push(done);
          }
          medias = migrated;
        }

        // Server-side truth for the channel marker: whatever name arrives (new clients send it
        // marked, old/unreadable paths don't), a token-born clone ALWAYS carries TOKEN in its
        // fixed part.
        const name = hsEnsureTokenMark(s.name || `${tree.name} (copy)`);

        // campaign — CBO with the buyer's budget, the source's objective, the EFFECTIVE bid
        // strategy (per-row switch or the source's), ACTIVE.
        const camp = await hsDupFbPost(`act_${binds.account}/campaigns`, {
          name,
          objective: tree.objective,
          status: "ACTIVE",
          special_ad_categories: tree.specialCategories,
          daily_budget: Math.round(s.budget * 100),
          bid_strategy: strategy,
        });
        created.campaign_id = String(camp.id);
        await rowWrite(user, s.taskId, { status: "running", stage: "adset", campaign_id: created.campaign_id });

        // adset — the source's targeting VERBATIM (faithful duplicate) unless the buyer set a
        // Targeting override (geo/locales swapped in, everything else — age, placements,
        // advantage flags — stays the source's), the binds' pixel, the partner's +30 min start
        // gap; regional declarations self-heal inside hsDupCreateAdset.
        let targeting = JSON.parse(JSON.stringify(tree.adset.targeting ?? {})) as Json;
        delete targeting.age_range; // read-only echo field
        if (s.override) targeting = applyGeoOverride(targeting, s.override);
        const srcPromoted = (tree.adset.promoted_object ?? {}) as Json;
        const adsetPayload: Json = {
          name,
          campaign_id: String(camp.id),
          status: "ACTIVE",
          billing_event: tree.adset.billing_event ?? "IMPRESSIONS",
          // Min-ROAS optimizes purchase VALUE; a clone switched OFF roas maps the source's
          // VALUE goal back to conversions. Unswitched clones keep the source's verbatim.
          optimization_goal: switched
            ? kind === "roas"
              ? "VALUE"
              : tree.adset.optimization_goal === "VALUE"
                ? "OFFSITE_CONVERSIONS"
                : (tree.adset.optimization_goal ?? "OFFSITE_CONVERSIONS")
            : (tree.adset.optimization_goal ?? "OFFSITE_CONVERSIONS"),
          targeting,
          start_time: hsTokenStartTime(),
          dsa_beneficiary: binds.pageName,
          dsa_payor: binds.pageName,
        };
        if (srcPromoted.pixel_id) {
          adsetPayload.promoted_object = {
            ...srcPromoted,
            pixel_id: binds.pixel,
            // A ROAS-switched clone value-optimizes PURCHASE regardless of the source's event
            // (same pairing every launch rail ships for min-ROAS).
            ...(switched && kind === "roas" ? { custom_event_type: "PURCHASE" } : {}),
          };
        }
        if (bidAmount != null) adsetPayload.bid_amount = bidAmount;
        if (bidConstraints) adsetPayload.bid_constraints = bidConstraints;
        // A WW override needs the TW/SG universal-ads declarations up front (further regions
        // self-heal inside hsDupCreateAdset, same as the launcher's create path).
        if (s.override) {
          const cats = geoOverrideRegionalCategories(s.override);
          if (cats.length) adsetPayload.regional_regulated_categories = cats;
        }
        const adset = await hsDupCreateAdset(`act_${binds.account}/adsets`, adsetPayload);
        created.adset_id = String(adset.id);
        await rowWrite(user, s.taskId, { status: "running", stage: "ads", adset_id: created.adset_id });

        // creatives + ads — one per reusable source ad. Links keep the {{campaign.id}} macros
        // ({{…}} re-resolves for the new campaign) but the `pixel=` param is swapped to the BIND
        // pixel: the ad set optimizes on binds.pixel (promoted_object above) while the funnel
        // fires whatever the link names — a verbatim link on a cross-account clone would starve
        // the optimization pixel of every conversion (review find 08-24).
        const adIds: string[] = [];
        for (let m = 0; m < medias.length; m++) {
          const adName = medias.length > 1 ? `${name} · ${m + 1}` : name;
          const creative = await hsDupFbPost(
            `act_${binds.account}/adcreatives`,
            cloneCreativePayload(adName, binds.page, medias[m], "", "", (l) => swapPixel(l, binds.pixel)),
          );
          const ad = await hsDupFbPost(`act_${binds.account}/ads`, adPayload(adName, String(adset.id), String(creative.id)));
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
        // Registry ledger: every ad this clone landed occupies a slot on the bind fanka
        // (fire-safe; the box's next Facebook sweep reconciles either way).
        await reportPagesUsed("br", [{ pageId: binds.page, delta: adIds.length }]);
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
        // The clone tree is born ACTIVE with only the +30 min start gap between a partial
        // failure and unattended delivery — pause the campaign (bounded) and put the confirmed
        // state into the row, same contract as the launch rails (review find 08-24).
        const disposition = launchFailureDisposition(created);
        const pausedOk = disposition.pauseNeeded ? await hsDupPauseCampaign(String(created.campaign_id)) : false;
        s.settled = true;
        await rowWrite(user, s.taskId, {
          status: "error",
          error: `${err.message ?? String(e)}${partialFailureNote(disposition, pausedOk)}`,
          finished_at: Date.now(),
          ...(created.campaign_id ? { campaign_id: created.campaign_id } : {}),
          ...(created.adset_id ? { adset_id: created.adset_id } : {}),
        });
      }
      if (i < shots.length - 1) await sleep(jitter());
    }
  } catch {
    /* the pump must never throw into the runtime — strays age out via the HS TM cap */
  }
}
