// Snapchat rail — the wave handler behind POST /api/snap/launch. Same skeleton as the Google
// wave: session → parse → validate EVERY shot against the live catalogs (ad accounts, pixels) and
// the shared validator (dry-run with placeholder key/media/name) → stamp rows into the shared
// store → claim the wave (idempotency, fail CLOSED) → after(pump) → answer at once.
// The CLONER (/snap/clone) fires the very same body: a clone shot is a launch shot whose creatives
// name their source media (reused on their own account) and which carries `cloneOf` / `cloneKey`
// — its rows are `snc-…`, tagged "clone", and its name ends in CLONE_FROM=<source>.

import { NextResponse, after } from "next/server";
import { type Session, sessionFromCookieHeader } from "./session";
import { readAppCache, writeAppCache } from "./app-cache";
import { storeConfigured } from "./task-store";
import { acceptServerJobs, pumpLane, selfOrigin } from "./launch-queue-run";
import {
  SNAP_MAX_SHOTS,
  SNAP_WAVE_ID_RE,
  isSnapKey,
  isSnapLaunchAccount,
  snapCampaignName,
  snapCloneMark,
  snapIdIn,
  snapDeviceOs,
  snapDeviceShort,
  snapGoalNeedsPixel,
  snapLaunchWire,
  snapShotTaskId,
  todaySaoPauloDotDDMM,
  snapShotMediaIn,
  type SnapLaunchShotIn,
} from "./snap-launch";
import { SnapApiError, snapAdAccounts, snapConfigured, snapDefaults, snapPixels, snapRailEnabled, type SnapAdAccount, type SnapPixel } from "./snap-api";
import type { SnapPumpShot } from "./snap-pump-core";

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
  if (ids.length === 0) return { error: `${accountName} has no Snap Pixel — choose Landing page view or create a pixel in Ads Manager` };
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
    objective: s(x.objective),
    bidStrategy: s(x.bidStrategy),
    bid: s(x.bid),
    budget: s(x.budget),
    startPaused: Boolean(x.startPaused),
    headline: s(x.headline),
    brandName: s(x.brandName),
    cta: s(x.cta),
    media: snapShotMediaIn(x),
    geo: (Array.isArray(x.geo) ? x.geo : []).map(s).filter(Boolean),
    minAge: s(x.minAge) || "18",
    // Nothing sent = the partner's default (Android only); an unknown word rides on to the
    // validator, which refuses it by name.
    deviceOs: snapDeviceOs(x.deviceOs) ?? s(x.deviceOs),
    landingUrl: s(x.landingUrl),
    desiredKey: s(x.desiredKey),
    suffix: s(x.suffix).replace(/[\r\n]+/g, " "),
    // A clone: its source campaign (a Snap id) and that source's partner key (both optional,
    // anything else dropped — they only name and tag the clone, they never steer the build).
    cloneOf: snapIdIn(x.cloneOf),
    cloneKey: isSnapKey(s(x.cloneKey).toLowerCase()) ? s(x.cloneKey).toLowerCase() : "",
  };
}

type ResolvedShot = { taskId: string; pump: SnapPumpShot; row: { name: string; geo: string; budget: string; bid: string; key: string } };

export async function handleSnapLaunch(req: Request): Promise<NextResponse> {
  // The pump's deadline is anchored HERE, before the catalog reads (snapAdAccounts / snapPixels can
  // spend minutes of timeouts): the route's maxDuration counts from the request, so a deadline taken
  // after those reads could land past it and Vercel would kill a copy mid-create, unrecorded.
  const t0 = Date.now();
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
    accounts = (await snapAdAccounts()).filter(isSnapLaunchAccount); // hidden accounts are refused as targets, not just unlisted
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

    // The board's placeholder from before its Blob upload finished: a client bug, never a creative —
    // refused here rather than at the pump's download (which would claim and release a key first).
    if (x.media.some((m) => /^https?:\/\/pending\.local(?:[:/]|$)/i.test(m.url))) return bad(`${at}: creative upload did not finish — re-attach the file`);
    // The pure validator admits a loopback http creative for the local mock; a production build takes
    // only a public https file (SNAP_ALLOW_LOOPBACK_MEDIA=1 re-admits loopback for a `next start`
    // smoke — never set on Vercel).
    // A clone's creative reused by its source media id may carry no file URL at all (nothing to download).
    if (process.env.NODE_ENV === "production" && process.env.SNAP_ALLOW_LOOPBACK_MEDIA !== "1" && x.media.some((m) => (m.url ? !/^https:\/\//i.test(m.url) : !m.snapMediaId))) return bad(`${at}: Every creative must be a public https:// file`);

    // An empty brand takes SNAP_BRAND_NAME (the spec's default) — the same server-side fallback as
    // the profile and the pixel above, so a card that never touched the field still launches.
    const shot: SnapLaunchShotIn = { ...x, brandName: x.brandName || defaults.brandName, currency: account.currency };
    // Dry-run with placeholders: the validator is pure, so every refusal fires here, before any row exists.
    const dry = snapLaunchWire(shot, { adAccountId, pixelId: px.pixelId, profileId, name: "preview", key: "glo-snp_001", mediaIds: shot.media.map(() => "pending"), startTimeIso: nowIso });
    if ("refusal" in dry) return bad(`${at}: ${dry.refusal}`);

    const desiredKey = isSnapKey(x.desiredKey ?? "") ? (x.desiredKey as string) : undefined;
    const cents = dry.wire.adsquad.daily_budget_micro / 10_000;
    const budget = `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, "0")}`;
    const cloneMark = x.cloneOf ? snapCloneMark(x.cloneKey ?? "", x.cloneOf) : "";
    const provisionalName = snapCampaignName({ ddmm, niche: dry.niche, geoLabel: dry.geoLabel, key: desiredKey ?? "glo-snp_???", user, tail: x.suffix, cloneOf: cloneMark });
    const taskId = snapShotTaskId(waveId, i, x.cloneOf ? "clone" : "launch");
    resolved.push({
      taskId,
      pump: {
        taskId,
        shot,
        ctx: { adAccountId, pixelId: px.pixelId, profileId, currency: account.currency, niche: dry.niche, geoLabel: dry.geoLabel, tail: x.suffix, startPaused: Boolean(x.startPaused), ...(cloneMark ? { cloneMark } : {}) },
      },
      // The monitor tag names the device restriction and how many ads the campaign carries when
      // the card had several creatives: "auto · Android · 5 creatives"; a clone says so first and
      // counts "ads" to stay inside the column's 40 characters: "clone · max $0,27 · Android · 5 ads".
      row: {
        name: provisionalName.slice(0, 250),
        geo: dry.geoLabel,
        budget,
        bid: [x.cloneOf ? "clone" : "", dry.label, snapDeviceShort(dry.deviceOs), shot.media.length > 1 ? `${shot.media.length} ${x.cloneOf ? "ads" : "creatives"}` : ""].filter(Boolean).join(" · "),
        key: desiredKey ?? "",
      },
    });
  }
  return acceptSnapWave(session, waveId, resolved, t0, selfOrigin(req));
}

/**
 * Idempotency (same-instance set + app-cache claim), then the hand-off to the DURABLE queue (09.10):
 * one job per shot in the buyer's Snapchat lane — rows stamped "queued" before the inserts, a task
 * id that already exists reported accepted and never re-stamped (a re-POST of a wave meets its own
 * jobs), the store being down refusing the whole wave (fail CLOSED — nothing half-accepted). The
 * wave claim is written after the jobs (it is what /api/wave-status answers a board whose answer
 * was lost; the jobs are the durable record). The lane pump's first window runs in after().
 */
async function acceptSnapWave(session: Session, waveId: string, resolved: ResolvedShot[], t0: number, origin: string): Promise<NextResponse> {
  const user = String(session.username);
  const waveKey = `snap-wave:${waveId}`;
  const alreadyAccepted = () => NextResponse.json({ ok: true, queued: resolved.length, rows: resolved.map((r) => ({ taskId: r.taskId })), alreadyAccepted: true });
  if (claimedWaves.has(waveId)) return alreadyAccepted();
  if (storeConfigured()) {
    const prior = await readAppCache<{ user: string; at: number }>(waveKey);
    if (prior) return alreadyAccepted();
  }
  if (!storeConfigured()) return bad("task_store_not_configured_wave_not_fired", 503);
  const res = await acceptServerJobs(
    { username: user, role: session.role ?? null, sub: session.sub },
    "sn",
    waveId,
    resolved.map((r) => ({
      taskId: r.taskId,
      kind: "sn.launch" as const,
      body: { shot: r.pump.shot, ctx: r.pump.ctx, waveId },
      // The key the board previewed rides in `gcm` until the job claims one (the core overwrites it).
      row: { name: r.row.name, gcm: r.row.key, geo: r.row.geo, budget: r.row.budget, bid: r.row.bid },
      account: null,
    })),
  );
  if (!res.ok) return bad(res.status === 503 ? "task_store_unavailable_wave_not_fired" : res.error, res.status);
  await writeAppCache(waveKey, { user, at: Date.now() });
  rememberWave(waveId);
  // The pump's budget runs from the request's first instant (t0) — see handleSnapLaunch.
  for (const lane of res.lanes) after(() => pumpLane(lane, { origin, startedAt: t0 }));
  return NextResponse.json({ ok: true, queued: res.accepted.length, rows: resolved.map((r) => ({ taskId: r.taskId })), ...(res.failed.length ? { failed: res.failed } : {}) });
}
