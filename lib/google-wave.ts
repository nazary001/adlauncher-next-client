// Google Ads rail — the shared wave handler behind POST /api/google/clone and /api/google/juro.
// Same skeleton as the HS wave routes: session → parse → validate every shot → stamp rows into
// the shared store → claim the wave (idempotency) → after(pump) → answer at once.

import { NextResponse, after } from "next/server";
import { type Session, sessionFromCookieHeader } from "./session";
import { readAppCache, writeAppCache } from "./app-cache";
import { storeConfigured } from "./task-store";
import { acceptServerJobs, pumpLane, selfOrigin } from "./launch-queue-run";
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
import { googleRailEnabled, googleWeaponConfigured, gwLaunchCatalog, type GwCloneBody, type GwCustomer, type GwJuroBody, type GwLaunchBody, type GwSuspendedCustomer } from "./google-weapon";
import { lionConfigured } from "./lion";
import { lionGoogleFindCampaigns } from "./lion-google";
import type { QueueKind } from "./launch-queue-types";

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
/** Why an account id is refused as a target: Google suspended it (named, with LION's day), or it
 *  simply is not one of the launch accounts. */
function notLaunchable(customerId: string, suspendedById: Map<string, GwSuspendedCustomer>): string {
  const dead = suspendedById.get(customerId);
  return dead ? `target account ${dead.name} is ${dead.reason} — pick a live account` : `target account ${customerId} is not one of the GLO-HS launch accounts`;
}

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
  const startedAt = Date.now();
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
  let suspendedById: Map<string, GwSuspendedCustomer>;
  try {
    // Every GLO-HS account minus the ones Google suspended — anything else is refused below.
    const catalog = await gwLaunchCatalog();
    customers = catalog.customers;
    suspendedById = new Map(catalog.dead.map((c) => [c.customerId, c])); // every dead account, listed or not
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
      if (!target) return bad(`${at}: ${notLaunchable(customerId, suspendedById)}`, 400, { customerId });
    } else {
      // JURO always lands on the source's own account; we know it only through LION metrics.
      customerId = src?.accountId ?? s(x.sourceAccount);
      target = customerId ? (customerById.get(customerId) ?? null) : null;
      // A JURO stays on the source's account — one Google suspended cannot take a new campaign.
      const dead = customerId ? suspendedById.get(customerId) : undefined;
      if (dead) return bad(`${at}: the source's account ${dead.name} is ${dead.reason} — JURO lands on the source's own account; clone it onto a live account instead`, 400, { customerId });
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

  return acceptGoogleWave(session, mode, waveId, resolved, startedAt, selfOrigin(req));
}

/** One resolved shot, ready to queue (shared by the clone/JURO and the launch handlers). */
type ResolvedShot = {
  taskId: string;
  campaignId: string;
  rowKey: string;
  wire: GwCloneBody | GwJuroBody | GwLaunchBody;
  row: { name: string; geo: string; budget: string; customer: string; currency: string; bid: string };
};

/**
 * The accepted-wave tail every Google launch shares: idempotency (same-instance set + app-cache
 * claim), then the hand-off to the DURABLE queue (09.10) — one job per shot in the buyer's Google
 * lane, rows stamped "queued" before the inserts, a task id that already exists reported accepted
 * (a re-POST of a wave meets its own jobs), the store being down refusing the whole wave (fail
 * CLOSED). The wave claim is written after the jobs (what /api/wave-status answers a board whose
 * answer was lost). The lane pump's first window runs in after().
 */
async function acceptGoogleWave(session: Session, mode: GoogleMode, waveId: string, resolved: ResolvedShot[], startedAt: number, origin: string): Promise<NextResponse> {
  const user = String(session.username);
  const waveKey = `google-wave:${waveId}`;
  const alreadyAccepted = () =>
    NextResponse.json({ ok: true, queued: resolved.length, rows: resolved.map((r) => ({ taskId: r.taskId, campaignId: r.campaignId })), alreadyAccepted: true });
  if (claimedWaves.has(waveId)) return alreadyAccepted();
  if (storeConfigured()) {
    const prior = await readAppCache<{ user: string; at: number }>(waveKey);
    if (prior) return alreadyAccepted();
  }
  if (!storeConfigured()) return bad("task_store_not_configured_wave_not_fired", 503);
  const kind: QueueKind = mode === "clone" ? "gg.clone" : mode === "juro" ? "gg.juro" : "gg.launch";
  const tag = mode === "clone" ? "g-clone" : mode === "juro" ? "g-juro" : "g-launch";
  const res = await acceptServerJobs(
    { username: user, role: session.role ?? null, sub: session.sub },
    "gg",
    waveId,
    resolved.map((r) => ({
      taskId: r.taskId,
      kind,
      body: { mode, campaignId: r.campaignId, wire: r.wire, rowKey: r.rowKey, waveId },
      row: { name: r.row.name, gcm: tag, geo: r.row.geo, budget: r.row.budget, bid: r.row.bid },
      // Google-specific display columns: the target customer id in adset_id, its currency in ad_id.
      rowExtra: { adset_id: r.row.customer, ad_id: r.row.currency },
      account: null,
    })),
  );
  if (!res.ok) return bad(res.status === 503 ? "task_store_unavailable_wave_not_fired" : res.error, res.status);
  await writeAppCache(waveKey, { user, at: Date.now() });
  rememberWave(waveId);
  for (const lane of res.lanes) after(() => pumpLane(lane, { origin, startedAt }));

  return NextResponse.json({ ok: true, queued: res.accepted.length, rows: resolved.map((r) => ({ taskId: r.taskId, campaignId: r.campaignId })), ...(res.failed.length ? { failed: res.failed } : {}) });
}

export type GoogleLaunchWaveBody = { waveId?: string; shots?: GoogleLaunchShotIn[] };

/**
 * POST /api/google/launch — fresh Demand Gen campaigns (one shot = one campaign; copies are
 * expanded by the board). Every asset must already be a public HTTPS URL (Vercel Blob / YouTube);
 * the wire is built + validated by lib/google-bid googleLaunchWire, the target account and its
 * pixel are validated against the live customers list exactly like clones.
 */
export async function handleGoogleLaunch(req: Request): Promise<NextResponse> {
  const startedAt = Date.now();
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
  let suspendedById: Map<string, GwSuspendedCustomer>;
  try {
    // Every GLO-HS account minus the ones Google suspended — anything else is refused below.
    const catalog = await gwLaunchCatalog();
    customers = catalog.customers;
    suspendedById = new Map(catalog.dead.map((c) => [c.customerId, c])); // every dead account, listed or not
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
    if (!target) return bad(`${at}: ${notLaunchable(customerId, suspendedById)}`, 400, { customerId });
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
  return acceptGoogleWave(session, "launch", waveId, resolved, startedAt, selfOrigin(req));
}

