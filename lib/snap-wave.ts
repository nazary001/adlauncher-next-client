// Snapchat rail — the wave handler behind POST /api/snap/launch. Same skeleton as the Google
// wave: session → parse → validate EVERY shot against the live catalogs (ad accounts, pixels) and
// the shared validator (dry-run with placeholder key/media/name) → stamp rows into the shared
// store → claim the wave (idempotency, fail CLOSED) → after(pump) → answer at once.

import { NextResponse, after } from "next/server";
import { sessionFromCookieHeader } from "./session";
import { readAppCache, writeAppCache } from "./app-cache";
import { storeConfigured, upsertTaskRow } from "./task-store";
import {
  SNAP_MAX_SHOTS,
  SNAP_WAVE_ID_RE,
  isSnapKey,
  snapCampaignName,
  snapGoalNeedsPixel,
  snapLaunchWire,
  snapShotTaskId,
  todaySaoPauloDotDDMM,
  type SnapLaunchShotIn,
} from "./snap-launch";
import { SnapApiError, snapAdAccounts, snapConfigured, snapDefaults, snapPixels, snapRailEnabled, type SnapAdAccount, type SnapPixel } from "./snap-api";
import { SNAP_PARTNER, pumpSnapWave } from "./snap-pump";
import { SNAP_PUMP_BUDGET_MS, type SnapPumpShot } from "./snap-pump-core";

export type SnapLaunchWaveBody = { waveId?: string; shots?: SnapLaunchShotIn[] };

const bad = (error: string, status = 400, extra: Record<string, unknown> = {}) => NextResponse.json({ ok: false, error, ...extra }, { status });
const s = (v: unknown): string => (v == null ? "" : String(v)).trim();

const claimedWaves = new Set<string>();
const rememberWave = (id: string) => {
  claimedWaves.add(id);
  if (claimedWaves.size > 500) claimedWaves.delete(claimedWaves.values().next().value as string);
};

/** Pixel for the ad squad: required + validated when the goal is PIXEL_* (auto when the account
 *  has exactly one), otherwise optional but validated when given. */
function resolvePixel(pixels: SnapPixel[], picked: string, needed: boolean, accountName: string): { pixelId?: string } | { error: string } {
  const ids = pixels.map((p) => p.id);
  if (picked && !ids.includes(picked)) return { error: `pixel ${picked} is not on ${accountName}` };
  if (!needed) return picked ? { pixelId: picked } : {};
  if (ids.length === 0) return { error: `${accountName} has no Snap Pixel — pick a non-pixel goal or create a pixel in Ads Manager` };
  if (ids.length === 1) return { pixelId: ids[0] };
  if (!picked) return { error: `${accountName} has ${ids.length} pixels — pick one` };
  return { pixelId: picked };
}

/** The shot as the board sent it, normalized (strings trimmed, geo as strings, booleans coerced). */
function cleanShot(x: SnapLaunchShotIn): SnapLaunchShotIn {
  return {
    label: s(x.label),
    adAccount: s(x.adAccount),
    pixel: s(x.pixel),
    profileId: s(x.profileId),
    optimizationGoal: s(x.optimizationGoal),
    bidStrategy: s(x.bidStrategy),
    bid: s(x.bid),
    budget: s(x.budget),
    startPaused: Boolean(x.startPaused),
    headline: s(x.headline),
    brandName: s(x.brandName),
    cta: s(x.cta),
    mediaUrl: s(x.mediaUrl),
    mediaKind: x.mediaKind === "image" ? "image" : "video",
    mediaName: s(x.mediaName),
    geo: (Array.isArray(x.geo) ? x.geo : []).map(s).filter(Boolean),
    minAge: s(x.minAge) || "18",
    landingId: x.landingId === "custom" || x.landingId === "dmi" || x.landingId === "cars" ? x.landingId : ("" as SnapLaunchShotIn["landingId"]),
    landingUrl: s(x.landingUrl),
    desiredKey: s(x.desiredKey),
    suffix: s(x.suffix).replace(/[\r\n]+/g, " "),
  };
}

type ResolvedShot = { taskId: string; pump: SnapPumpShot; row: { name: string; geo: string; budget: string; bid: string; key: string } };

export async function handleSnapLaunch(req: Request): Promise<NextResponse> {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session?.username) return bad("unauthorized", 401);
  if (!snapRailEnabled()) return bad("snap_rail_disabled", 404);
  if (!snapConfigured()) return bad("snap_not_configured", 500);
  const user = String(session.username);

  let body: SnapLaunchWaveBody;
  try {
    body = (await req.json()) as SnapLaunchWaveBody;
  } catch {
    return bad("bad_json");
  }
  const shotsIn = Array.isArray(body.shots) ? body.shots : [];
  if (shotsIn.length === 0) return bad("no_shots");
  if (shotsIn.length > SNAP_MAX_SHOTS) return bad(`too_many_shots (max ${SNAP_MAX_SHOTS})`);
  const waveId = SNAP_WAVE_ID_RE.test(s(body.waveId)) ? s(body.waveId) : crypto.randomUUID();

  let accounts: SnapAdAccount[];
  try {
    accounts = await snapAdAccounts();
  } catch (e) {
    const auth = e instanceof SnapApiError && e.status === 401;
    return bad(`${auth ? "snap_auth_failed" : "snap_unavailable"}: ${(e as Error).message}`, 502);
  }
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const defaults = snapDefaults();
  const ddmm = todaySaoPauloDotDDMM();
  const nowIso = new Date().toISOString();

  const resolved: ResolvedShot[] = [];
  for (let i = 0; i < shotsIn.length; i++) {
    const x = cleanShot(shotsIn[i]);
    const at = `shot ${i + 1}`;
    const adAccountId = x.adAccount || defaults.adAccount;
    if (!adAccountId) return bad(`${at}: ad account is required`);
    const account = accountById.get(adAccountId);
    if (!account) return bad(`${at}: ad account ${adAccountId} is not one of our Snapchat ad accounts`, 400, { adAccount: adAccountId });

    const needsPixel = snapGoalNeedsPixel(x.optimizationGoal);
    let pixels: SnapPixel[] = [];
    if (needsPixel || x.pixel || defaults.pixel) {
      try {
        pixels = await snapPixels(adAccountId);
      } catch (e) {
        return bad(`snap_unavailable: pixels of ${account.name}: ${(e as Error).message}`, 502);
      }
    }
    const picked = x.pixel || (defaults.pixel && pixels.some((p) => p.id === defaults.pixel) ? defaults.pixel : "");
    const px = resolvePixel(pixels, picked, needsPixel, account.name);
    if ("error" in px) return bad(`${at}: ${px.error}`, 400, { availablePixels: pixels.map((p) => p.id) });

    const profileId = x.profileId || defaults.profile;
    if (!profileId) return bad(`${at}: a Public Profile is required on every Snapchat ad — set SNAP_PROFILE_ID or pick one`);

    const shot: SnapLaunchShotIn = { ...x, currency: account.currency };
    // Dry-run with placeholders: the validator is pure, so every refusal fires here, before any row exists.
    const dry = snapLaunchWire(shot, { adAccountId, pixelId: px.pixelId, profileId, name: "preview", key: "glo-snp_001", mediaId: "pending", startTimeIso: nowIso });
    if ("refusal" in dry) return bad(`${at}: ${dry.refusal}`);

    const desiredKey = isSnapKey(x.desiredKey ?? "") ? (x.desiredKey as string) : undefined;
    const cents = dry.wire.adsquad.daily_budget_micro / 10_000;
    const budget = `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, "0")}`;
    const provisionalName = snapCampaignName({ ddmm, niche: dry.niche, geoLabel: dry.geoLabel, key: desiredKey ?? "glo-snp_???", user, tail: x.suffix });
    const taskId = snapShotTaskId(waveId, i);
    resolved.push({
      taskId,
      pump: {
        taskId,
        shot,
        ctx: { adAccountId, pixelId: px.pixelId, profileId, currency: account.currency, niche: dry.niche, geoLabel: dry.geoLabel, tail: x.suffix, startPaused: Boolean(x.startPaused) },
      },
      row: { name: provisionalName.slice(0, 250), geo: dry.geoLabel, budget, bid: dry.label, key: desiredKey ?? "" },
    });
  }
  return acceptSnapWave(user, waveId, resolved);
}

/**
 * Idempotency (same-instance set + app-cache claim), stamp rows BEFORE the claim and the answer
 * (the team sees queued rows even if the browser dies now), claim (fail CLOSED when unwritable —
 * a retry could otherwise pump twice), after(pump), answer.
 */
async function acceptSnapWave(user: string, waveId: string, resolved: ResolvedShot[]): Promise<NextResponse> {
  const waveKey = `snap-wave:${waveId}`;
  const alreadyAccepted = () => NextResponse.json({ ok: true, queued: resolved.length, rows: resolved.map((r) => ({ taskId: r.taskId })), alreadyAccepted: true });
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
        partner: SNAP_PARTNER,
        name: r.row.name,
        geo: r.row.geo,
        budget: r.row.budget,
        status: "running",
        stage: "key",
        gcm: r.row.key,
        adset_id: "",
        ad_id: "",
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
  const shots = resolved.map((r) => r.pump);
  after(() => pumpSnapWave(user, shots, now + SNAP_PUMP_BUDGET_MS));
  return NextResponse.json({ ok: true, queued: resolved.length, rows: resolved.map((r) => ({ taskId: r.taskId })) });
}
