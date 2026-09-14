// Google Ads rail — the shared wave handler behind POST /api/google/clone and /api/google/juro.
// Same skeleton as the HS wave routes: session → parse → validate every shot → stamp rows into
// the shared store → claim the wave (idempotency) → after(pump) → answer at once.

import { NextResponse, after } from "next/server";
import { sessionFromCookieHeader } from "./session";
import { readAppCache, writeAppCache } from "./app-cache";
import { storeConfigured, upsertTaskRow } from "./task-store";
import {
  GOOGLE_CAMPAIGN_ID_RE,
  GOOGLE_CUSTOMER_ID_RE,
  GOOGLE_WAVE_ID_RE,
  googleBidPlan,
  googleBudgetWire,
  googleGeoLabel,
  googleLaunchWire,
  googleNamePreview,
  googleNameSuffix,
  googleShotTaskId,
  todaySaoPauloDotDDMM,
  type GoogleLaunchShotIn,
  type GoogleMode,
} from "./google-bid";
import { googleGeoFromName, splitGoogleName } from "./google-source";
import { googleRailEnabled, googleWeaponConfigured, gwCustomers, type GwCloneBody, type GwCustomer, type GwJuroBody, type GwLaunchBody } from "./google-weapon";
import { lionConfigured } from "./lion";
import { lionGoogleFindCampaigns } from "./lion-google";
import { GOOGLE_PARTNER, GOOGLE_PUMP_BUDGET_MS, pumpGoogleWave, type GooglePumpShot } from "./google-pump";

export const GOOGLE_MAX_SHOTS = 45;

/** One shot as the board sends it (money as HUMAN strings; the server scales). */
export type GoogleShotIn = {
  campaignId: string;
  budget: string;
  bid: string;
  /** Clone only: "" = inherit the source's strategy. */
  bidStrategy: string;
  /** Buyer's free tail — the team-pattern suffix is built server-side around it. */
  suffix: string;
  customer?: string;
  pixel?: string;
  /** Display material the board already read (the server re-reads what it can). */
  sourceName?: string;
  geo?: string;
  sourceAccount?: string;
  currency?: string;
};

export type GoogleWaveBody = {
  waveId?: string;
  customer?: string;
  pixel?: string;
  shots?: GoogleShotIn[];
};

const bad = (error: string, status = 400, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ ok: false, error, ...extra }, { status });

const claimedWaves = new Set<string>();
const rememberWave = (id: string) => {
  claimedWaves.add(id);
  if (claimedWaves.size > 500) claimedWaves.delete(claimedWaves.values().next().value as string);
};

const s = (v: unknown): string => (v == null ? "" : String(v)).trim();

/** Pixel to send for a target account: required + validated when it has several, auto when it
 *  has exactly one, omitted when it has none (google-weapon then decides). `null` = refusal. */
function resolvePixel(target: GwCustomer | null, picked: string): { pixel?: string } | { error: string } {
  if (!target) return picked ? { pixel: picked } : {};
  if (target.pixels.length === 0) return picked ? { pixel: picked } : {};
  if (target.pixels.length === 1) {
    if (picked && picked !== target.pixels[0]) return { error: `pixel ${picked} is not on ${target.name} (its only pixel is ${target.pixels[0]})` };
    return { pixel: target.pixels[0] };
  }
  if (!picked) return { error: `${target.name} has ${target.pixels.length} conversion pixels — pick one` };
  if (!target.pixels.includes(picked)) return { error: `pixel ${picked} is not on ${target.name}` };
  return { pixel: picked };
}

export async function handleGoogleWave(req: Request, mode: GoogleMode): Promise<NextResponse> {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session?.username) return bad("unauthorized", 401);
  if (!googleRailEnabled()) return bad("google_rail_disabled", 404);
  if (!googleWeaponConfigured()) return bad("google_weapon_not_configured", 500);
  const user = String(session.username);

  let body: GoogleWaveBody;
  try {
    body = (await req.json()) as GoogleWaveBody;
  } catch {
    return bad("bad_json");
  }
  const shotsIn = Array.isArray(body.shots) ? body.shots : [];
  if (shotsIn.length === 0) return bad("no_shots");
  if (shotsIn.length > GOOGLE_MAX_SHOTS) return bad(`too_many_shots (max ${GOOGLE_MAX_SHOTS})`);
  const waveId = GOOGLE_WAVE_ID_RE.test(s(body.waveId)) ? s(body.waveId) : crypto.randomUUID();

  // ---- catalogs: customers (target validation) + LION metrics (names / geo / source accounts) --
  let customers: GwCustomer[];
  try {
    customers = await gwCustomers();
  } catch (e) {
    return bad(`google_weapon_unreachable: ${(e as Error).message}`, 502);
  }
  const customerById = new Map(customers.map((c) => [c.customerId, c]));
  const sourceIds = [...new Set(shotsIn.map((x) => s(x.campaignId)))];
  let known: Record<string, { name: string; accountId: string; accountName: string; budget: number | null; bid: number | null }> = {};
  if (lionConfigured()) {
    try {
      known = await lionGoogleFindCampaigns(sourceIds);
    } catch {
      known = {}; // LION lag must not block a launch — the dataset fetch is the real gate
    }
  }

  // ---- per-shot resolution -------------------------------------------------------------------
  const ddmm = todaySaoPauloDotDDMM();
  const waveCustomer = s(body.customer);
  const wavePixel = s(body.pixel);
  const resolved: ResolvedShot[] = [];
  for (let i = 0; i < shotsIn.length; i++) {
    const x = shotsIn[i];
    const campaignId = s(x.campaignId);
    const at = `shot ${i + 1}`;
    if (!GOOGLE_CAMPAIGN_ID_RE.test(campaignId)) return bad(`${at}: bad campaignId`);
    const budget = googleBudgetWire(s(x.budget));
    if (!budget) return bad(`${at}: budget must be between 1 and 10000 in the target account currency`);
    // The override is forwarded on BOTH modes: googleBidPlan refuses a JURO strategy switch
    // (JURO keeps the source's strategy) instead of this handler silently dropping it.
    const plan = googleBidPlan({ mode, override: s(x.bidStrategy), typedBid: s(x.bid) });
    if ("refusal" in plan) return bad(`${at}: ${plan.refusal}`);
    const src = known[campaignId];

    let target: GwCustomer | null = null;
    let customerId = "";
    if (mode === "clone") {
      customerId = s(x.customer) || waveCustomer;
      if (!GOOGLE_CUSTOMER_ID_RE.test(customerId)) return bad(`${at}: target account is required`);
      target = customerById.get(customerId) ?? null;
      if (!target) return bad(`${at}: target account ${customerId} is not launchable for the LION user`, 400, { customerId });
    } else {
      // JURO always lands on the source's own account; we know it only through LION metrics.
      customerId = src?.accountId ?? s(x.sourceAccount);
      target = customerId ? (customerById.get(customerId) ?? null) : null;
    }
    // The wave pixel rides only onto targets that actually carry it — a per-row override onto a
    // pixel-less account (GC-HS-Lion-BR-N) must send NO pixel, not the wave's foreign one.
    const picked = s(x.pixel) || (target && wavePixel && target.pixels.includes(wavePixel) ? wavePixel : "");
    const px = resolvePixel(target, picked);
    if ("error" in px) return bad(`${at}: ${px.error}`, 400, { availablePixels: target?.pixels ?? [] });

    const name_suffix = googleNameSuffix({ mode, sourceId: campaignId, user, ddmm, tail: s(x.suffix) });
    const wire: GwCloneBody | GwJuroBody =
      mode === "clone"
        ? {
            source_campaign_id: campaignId,
            customer_id: customerId,
            budget,
            ...(plan.wireStrategy ? { bid_strategy: plan.wireStrategy } : {}),
            ...(plan.wireBid != null ? { bid_value: plan.wireBid } : {}),
            ...(px.pixel ? { pixel: px.pixel } : {}),
            name_suffix,
          }
        : {
            source_campaign_id: campaignId,
            budget,
            ...(plan.wireBid != null ? { bid_value: plan.wireBid } : {}),
            ...(px.pixel ? { pixel: px.pixel } : {}),
            name_suffix,
          };
    const sourceName = src?.name || s(x.sourceName) || `campaign ${campaignId}`;
    // Provisional row name = the source's generated HEAD (its own team suffix dropped) + OUR
    // suffix — the pump swaps in LION's real campaign_name when the task completes.
    const provisionalName = googleNamePreview({ mode, head: splitGoogleName(sourceName).head || sourceName, suffix: name_suffix, sourceId: campaignId }).slice(0, 250);
    resolved.push({
      taskId: googleShotTaskId(mode, waveId, i),
      campaignId,
      rowKey: JSON.stringify(wire),
      wire,
      row: {
        name: provisionalName,
        geo: googleGeoFromName(sourceName) || s(x.geo),
        budget: budget.replace(".", ","),
        customer: customerId,
        currency: target?.currency ?? s(x.currency),
        bid: plan.label,
      },
    });
  }

  return acceptGoogleWave(user, mode, waveId, resolved);
}

/** One resolved shot, ready to stamp + pump (shared by the clone/JURO and the launch handlers). */
type ResolvedShot = {
  taskId: string;
  campaignId: string;
  rowKey: string;
  wire: GwCloneBody | GwJuroBody | GwLaunchBody;
  row: { name: string; geo: string; budget: string; customer: string; currency: string; bid: string };
};

/**
 * The accepted-wave tail every Google launch shares: idempotency (same-instance set + app-cache
 * claim), stamp rows BEFORE the claim and the answer (the team sees queued rows even if the
 * browser dies now; a crash before the claim re-stamps the SAME task ids on retry), claim
 * (fail CLOSED when unwritable — a retry could otherwise pump twice), after(pump), answer.
 */
async function acceptGoogleWave(user: string, mode: GoogleMode, waveId: string, resolved: ResolvedShot[]): Promise<NextResponse> {
  const waveKey = `google-wave:${waveId}`;
  const alreadyAccepted = () =>
    NextResponse.json({ ok: true, queued: resolved.length, rows: resolved.map((r) => ({ taskId: r.taskId, campaignId: r.campaignId })), alreadyAccepted: true });
  if (claimedWaves.has(waveId)) return alreadyAccepted();
  if (storeConfigured()) {
    const prior = await readAppCache<{ user: string; at: number }>(waveKey);
    if (prior) return alreadyAccepted();
  }
  if (!storeConfigured()) return bad("task_store_not_configured_wave_not_fired", 503);
  const now = Date.now();
  await Promise.all(
    resolved.map((r) =>
      upsertTaskRow(user, r.taskId, {
        partner: GOOGLE_PARTNER,
        name: r.row.name,
        geo: r.row.geo,
        budget: r.row.budget,
        status: "running",
        stage: mode === "launch" ? "submit" : "dataset",
        gcm: mode === "clone" ? "g-clone" : mode === "juro" ? "g-juro" : "g-launch",
        adset_id: r.row.customer,
        ad_id: r.row.currency,
        campaign_id: "",
        link: "",
        error: "",
        ...(r.row.bid ? { bid: r.row.bid } : {}),
        queued_at: now,
        started_at: now,
      }),
    ),
  );
  const claim = await writeAppCache(waveKey, { user, at: now });
  if (!claim) return bad("task_store_unavailable_wave_not_fired", 503);
  rememberWave(waveId);

  const shots: GooglePumpShot[] = resolved.map((r) => ({ taskId: r.taskId, mode, campaignId: r.campaignId, body: r.wire, rowKey: r.rowKey }));
  const deadline = now + GOOGLE_PUMP_BUDGET_MS;
  after(() => pumpGoogleWave(user, shots, deadline));

  return NextResponse.json({ ok: true, queued: resolved.length, rows: resolved.map((r) => ({ taskId: r.taskId, campaignId: r.campaignId })) });
}

export type GoogleLaunchWaveBody = { waveId?: string; shots?: GoogleLaunchShotIn[] };

/**
 * POST /api/google/launch — fresh Demand Gen campaigns (one shot = one campaign; copies are
 * expanded by the board). Every asset must already be a public HTTPS URL (Vercel Blob / YouTube);
 * the wire is built + validated by lib/google-bid googleLaunchWire, the target account and its
 * pixel are validated against the live customers list exactly like clones.
 */
export async function handleGoogleLaunch(req: Request): Promise<NextResponse> {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session?.username) return bad("unauthorized", 401);
  if (!googleRailEnabled()) return bad("google_rail_disabled", 404);
  if (!googleWeaponConfigured()) return bad("google_weapon_not_configured", 500);
  const user = String(session.username);

  let body: GoogleLaunchWaveBody;
  try {
    body = (await req.json()) as GoogleLaunchWaveBody;
  } catch {
    return bad("bad_json");
  }
  const shotsIn = Array.isArray(body.shots) ? body.shots : [];
  if (shotsIn.length === 0) return bad("no_shots");
  if (shotsIn.length > GOOGLE_MAX_SHOTS) return bad(`too_many_shots (max ${GOOGLE_MAX_SHOTS})`);
  const waveId = GOOGLE_WAVE_ID_RE.test(s(body.waveId)) ? s(body.waveId) : crypto.randomUUID();

  let customers: GwCustomer[];
  try {
    customers = await gwCustomers();
  } catch (e) {
    return bad(`google_weapon_unreachable: ${(e as Error).message}`, 502);
  }
  const customerById = new Map(customers.map((c) => [c.customerId, c]));
  const ddmm = todaySaoPauloDotDDMM();

  const resolved: ResolvedShot[] = [];
  for (let i = 0; i < shotsIn.length; i++) {
    const x = shotsIn[i];
    const at = `shot ${i + 1}`;
    const customerId = s(x.customer);
    if (!GOOGLE_CUSTOMER_ID_RE.test(customerId)) return bad(`${at}: target account is required`);
    const target = customerById.get(customerId) ?? null;
    if (!target) return bad(`${at}: target account ${customerId} is not launchable for the LION user`, 400, { customerId });
    const px = resolvePixel(target, s(x.pixel));
    if ("error" in px) return bad(`${at}: ${px.error}`, 400, { availablePixels: target.pixels });
    const nameSuffix = googleNameSuffix({ mode: "launch", user, ddmm, tail: s(x.suffix) });
    const built = googleLaunchWire(x, { customerId, pixel: px.pixel, nameSuffix });
    if ("refusal" in built) return bad(`${at}: ${built.refusal}`);
    const label = s(x.label) || `Google launch · ${target.name}`;
    resolved.push({
      taskId: googleShotTaskId("launch", waveId, i),
      campaignId: "",
      rowKey: JSON.stringify(built.wire),
      wire: built.wire,
      row: {
        // Provisional: LION generates the real campaign name; the pump swaps it in on completion.
        name: googleNamePreview({ mode: "launch", head: label, suffix: nameSuffix }).slice(0, 250),
        geo: googleGeoLabel(x.geo),
        budget: built.wire.budget.replace(".", ","),
        customer: customerId,
        currency: target.currency,
        bid: built.label,
      },
    });
  }
  return acceptGoogleWave(user, "launch", waveId, resolved);
}

