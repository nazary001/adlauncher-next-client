import { NextResponse, after } from "next/server";
import { bidKind, parseMoney } from "@/lib/types";
import { hsWireBid } from "@/lib/hs-launch";
import { sessionFromCookieHeader } from "@/lib/session";
import { readAppCache, writeAppCache } from "@/lib/app-cache";
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
const claimedWaves = new Set<string>();

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
): Promise<{ error: NextResponse } | { currency: string }> {
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
  if (!data.pages.some((p) => p.id === page)) return { error: bad("page_not_on_profile") };
  let pixels;
  try {
    pixels = await lionAccountPixels(profile, account);
  } catch (e) {
    return { error: bad(`lion_unreachable: ${(e as Error).message}`, 502) };
  }
  if (!pixels.some((p) => p.id === pixel)) return { error: bad("pixel_not_on_account") };
  return { currency: acct.currency || "USD" };
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
  lionTaskId?: string;
  cloneId?: string;
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
      shots.push({
        campaignId,
        budget,
        budgetRaw: String(raw?.budget ?? ""),
        bid,
        bidStrategy: String(raw?.bidStrategy ?? "").trim(),
        name: String(raw?.name ?? "").trim().slice(0, 200),
        geo: String(raw?.geo ?? "").slice(0, 40) || "inherited",
        label: String(raw?.label ?? "").trim().slice(0, 200),
        // Zero-padded index: the drawer breaks queued_at ties by STRING id, so "-10" must not
        // sort between "-01" and "-02" (waves share one stamp timestamp).
        taskId: `hsd-${waveId}-${String(shots.length).padStart(2, "0")}`,
      });
    }
    const binds = await validateBinds(profile, account, page, pixel);
    if ("error" in binds) return binds.error;

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
      claimedWaves.add(waveId);
      return alreadyAccepted();
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
        claimedWaves.add(waveId);
        return alreadyAccepted();
      }
      // Store unavailable → FAIL CLOSED (review 08-14): without a persisted claim, a retry of
      // this wave could pump twice and double every campaign. Money invariant beats
      // availability — the buyer just re-fires when the store is back. (The stamped rows, if
      // any landed, are harmless upserts of the same ids.)
      return bad("task_store_unavailable_wave_not_fired", 503);
    }
    claimedWaves.add(waveId);

    const user = session.username;
    const deadline = startedAt + PUMP_BUDGET_MS;
    after(() => pumpBatch(user, { profile, account, page, pixel }, shots, deadline));

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
    const wire = hsWireBid(bid, strategy);
    if (wire == null) return bad("bid_invalid");
    startingBid = wire;
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
      return NextResponse.json({ ok: true, rows, taskIds, currency: binds.currency });
    }
    // Preflight rejection — LION's reason is the actionable text ("No valid creative URL found
    // in campaign ads" = object-story source → not duplicable; dead/unreadable source; …).
    return bad(result.reason || `LION rejected the duplicate (${result.result ?? "no result"})`);
  } catch (e) {
    // 404 plain-text bodies ("Page not found in account data", "Pixel not found for account")
    // surface verbatim — they are the actionable reason, not a transport failure.
    const status = e instanceof LionError && e.status && e.status < 500 ? 400 : 502;
    return bad(`lion_duplicate_failed: ${(e as Error).message}`, status);
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
  binds: { profile: string; account: string; page: string; pixel: string },
  shots: BatchShot[],
  deadline: number,
): Promise<void> {
  try {
    const strategyCache = new Map<string, string>();
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
            strategy && kind !== "none" && !(kind === "roas" && s.bid > 100) ? hsWireBid(s.bid, strategy) : null;
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
        } else {
          // Preflight rejection kills the whole family (object-story creatives, dead source…).
          const reason = result.reason || `LION rejected the duplicate (${result.result ?? "no result"})`;
          familyFailed.set(s.campaignId, reason);
          s.settled = true;
          await rowWrite(user, s.taskId, { status: "error", error: reason, finished_at: Date.now() });
        }
      } catch (e) {
        const msg = `lion_duplicate_failed: ${(e as Error).message ?? e}`;
        // 4xx = LION-side semantic answer (page/pixel not in account data…) — deterministic for
        // the family; 5xx/transport may be transient, so only this shot is marked.
        if (e instanceof LionError && e.status && e.status < 500) familyFailed.set(s.campaignId, msg);
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
            await rowWrite(user, s.taskId, { campaign_id: s.cloneId });
          }
          if (r.status === "COMPLETED" && r.campaign_id) {
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
