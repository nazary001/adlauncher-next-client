// TikTok rail — the shared wave handlers behind POST /api/tiktok/launch, /clone and /juro.
// Same skeleton as the Google / HS wave routes: session → gates → parse → validate EVERY shot →
// stamp rows into the shared store → claim the wave (idempotency) → after(pump) → answer at once.

import { NextResponse, after } from "next/server";
import { type Session, sessionFromCookieHeader } from "./session";
import { readAppCacheDetailed, writeAppCache } from "./app-cache";
import { storeConfigured } from "./task-store";
import { acceptServerJobs, pumpLane, selfOrigin } from "./launch-queue-run";
import { TT_FOLLOW_MAX_MS, type QueueKind } from "./launch-queue-types";
import { LION_ACR, lionTokenConfigured } from "./lion";
import { lionTiktokFindCampaigns } from "./lion-tiktok";
import { parseTiktokName, type LionTiktokRow } from "./tiktok-source";
import {
  TIKTOK_ADVERTISER_ID_RE,
  TIKTOK_CAMPAIGN_ID_RE,
  TIKTOK_WAVE_ID_RE,
  isTiktokLaunchAccount,
  tiktokCloneWire,
  tiktokGeoLabel,
  tiktokJuroWire,
  tiktokLaunchWire,
  tiktokNameHeadPreview,
  tiktokNamePreview,
  tiktokNameSuffix,
  tiktokResolvePixel,
  tiktokShotTaskId,
  todaySaoPauloDotDDMM,
  type TiktokCloneShotIn,
  type TiktokCloneWire,
  type TiktokJuroWire,
  type TiktokKind,
  type TiktokLaunchShotIn,
  type TiktokLaunchWire,
} from "./tiktok-launch";
import {
  TIKTOK_LIVE_LAUNCH_BLOCKED,
  tiktokLiveLaunchAllowed,
  tiktokRailEnabled,
  tiktokWeaponConfigured,
  twAdvertiserConfig,
  twAdvertisers,
  type TwAdvertiser,
  type TwConfig,
} from "./tiktok-weapon";
export const TIKTOK_MAX_SHOTS = 45;
const CONFIG_CONCURRENCY = 5;

const bad = (error: string, status = 400, extra: Record<string, unknown> = {}) => NextResponse.json({ ok: false, error, ...extra }, { status });
const s = (v: unknown): string => (v == null ? "" : String(v)).trim();

/** Waves this instance has accepted → how many shots each carried (the store's claim row is the
 *  truth across instances; this only saves the read for an immediate repeat). */
const claimedWaves = new Map<string, number>();
const rememberWave = (id: string, shots: number) => {
  claimedWaves.set(id, shots);
  if (claimedWaves.size > 500) claimedWaves.delete(claimedWaves.keys().next().value as string);
};

/** The advertisers the console OFFERS and ACCEPTS as launch targets (owner decision 18.09: every
 *  `launch_eligible` one). Read-only lookups (a source's account name) keep twAdvertisers. */
export async function tiktokLaunchableAdvertisers(): Promise<TwAdvertiser[]> {
  return (await twAdvertisers()).filter(isTiktokLaunchAccount);
}

/** Session + the rail's gates, in the order every TikTok launch route shares. */
function gate(req: Request): { user: string; session: Session } | NextResponse {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session?.username) return bad("unauthorized", 401);
  if (!tiktokRailEnabled()) return bad("tiktok_rail_disabled", 404);
  if (!tiktokWeaponConfigured()) return bad("tiktok_weapon_not_configured", 500);
  // Refused before a single row is stamped: this instance must not fire at the live partner.
  if (!tiktokLiveLaunchAllowed()) return bad(TIKTOK_LIVE_LAUNCH_BLOCKED, 403);
  return { user: String(session.username), session };
}

/** Configs of the distinct target advertisers, ≤5 reads in flight; a failed read is kept as its
 *  sentence so the shot that needs it is refused by name. */
async function loadConfigs(ids: string[]): Promise<Map<string, TwConfig | { error: string }>> {
  const out = new Map<string, TwConfig | { error: string }>();
  const list = [...new Set(ids)];
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const id = list[next++];
      try {
        out.set(id, await twAdvertiserConfig(id));
      } catch (e) {
        out.set(id, { error: e instanceof Error ? e.message : String(e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONFIG_CONCURRENCY, list.length) }, worker));
  return out;
}

/** One resolved shot, ready to stamp + pump. */
type ResolvedShot = {
  taskId: string;
  kind: TiktokKind;
  campaignId: string;
  rowKey: string;
  wire: TiktokLaunchWire | TiktokCloneWire | TiktokJuroWire;
  row: { name: string; geo: string; budget: string; advertiser: string; currency: string; bid: string };
};

const KIND_TAG: Record<TiktokKind, string> = { launch: "t-launch", clone: "t-clone", juro: "t-juro" };

/** What a wave's claim row holds: who fired it, when, which request wrote it, and how many shots
 *  it carried (a re-POST of the id with ANOTHER shot count is not a retry). */
type WaveClaim = { user: string; at: number; nonce: string; n: number };

/** Waves being accepted by THIS instance right now — taken synchronously, before the first await,
 *  so a twin request can never queue the same wave twice on one instance (the queue's own unique
 *  job ids make the second attempt a no-op anyway). */
const inflightWaves = new Set<string>();

const KIND_QUEUE: Record<TiktokKind, QueueKind> = { launch: "tt.launch", clone: "tt.clone", juro: "tt.juro" };

/**
 * The accepted-wave tail every TikTok launch shares. In order:
 *  1. idempotency — this instance's memory, then the claim row in the shared store. A store that
 *     can't be READ refuses the wave BEFORE anything is queued (a blip must not read as "never
 *     accepted" and let a retry re-queue a wave); a re-POST with another shot count is refused;
 *  2. the hand-off to the DURABLE queue (09.10): one job per shot in the buyer's TikTok lane —
 *     rows stamped "queued" before the inserts, a task id that already exists reported accepted
 *     (the queue's unique job ids are the per-shot exactly-once), the store being down refusing
 *     the whole wave (fail CLOSED) — plus the wave's tt.follow job (the settle pass);
 *  3. the claim row (what /api/wave-status answers a board whose answer was lost), after(pump), answer.
 */
async function acceptTiktokWave(session: Session, waveId: string, resolved: ResolvedShot[], startedAt: number, origin: string): Promise<NextResponse> {
  const user = String(session.username);
  const waveKey = `tiktok-wave:${waveId}`;
  const rows = resolved.map((r) => ({ taskId: r.taskId, campaignId: r.campaignId }));
  const alreadyAccepted = () => NextResponse.json({ ok: true, queued: resolved.length, rows, alreadyAccepted: true });
  // A re-POST is a RETRY only when it carries what the accepted wave carried; the same id with
  // another shot count would otherwise be told "already accepted" for campaigns never launched.
  const contentChanged = (n: number) =>
    bad(`wave_content_changed: this wave was already accepted with ${n} campaign${n === 1 ? "" : "s"}, not ${resolved.length} — check the Task Manager before firing anything again`, 409);
  const known = claimedWaves.get(waveId);
  if (known !== undefined) return known === resolved.length ? alreadyAccepted() : contentChanged(known);
  if (!storeConfigured()) return bad("task_store_not_configured_wave_not_fired", 503);
  if (inflightWaves.has(waveId)) return bad("wave_in_progress: this wave is being accepted right now — check the Task Manager instead of firing it again", 409);
  inflightWaves.add(waveId);
  try {
    const prior = await readAppCacheDetailed<WaveClaim>(waveKey);
    if (!prior.ok) return bad("task_store_unavailable_wave_not_fired: the task store can't be read — nothing was sent; try again in a moment", 503);
    if (prior.row) {
      const n = Number(prior.row.value?.n);
      if (Number.isFinite(n) && n !== resolved.length) return contentChanged(n);
      return alreadyAccepted();
    }

    const now = Date.now();
    const res = await acceptServerJobs(
      { username: user, role: session.role ?? null, sub: session.sub },
      "tt",
      waveId,
      resolved.map((r) => ({
        taskId: r.taskId,
        kind: KIND_QUEUE[r.kind],
        body: { kind: r.kind, campaignId: r.campaignId, wire: r.wire, rowKey: r.rowKey, waveId },
        row: { name: r.row.name, gcm: KIND_TAG[r.kind], geo: r.row.geo, budget: r.row.budget, bid: r.row.bid },
        // TikTok-specific display columns: the target advertiser id in adset_id, its currency in ad_id.
        rowExtra: { adset_id: r.row.advertiser, ad_id: r.row.currency },
        account: null,
      })),
      { kind: "tt.follow", body: { waveId, until: now + TT_FOLLOW_MAX_MS } },
    );
    if (!res.ok) return bad(res.status === 503 ? "task_store_unavailable_wave_not_fired: nothing was sent; try again in a moment" : res.error, res.status);
    await writeAppCache<WaveClaim>(waveKey, { user, at: now, nonce: crypto.randomUUID(), n: resolved.length });
    rememberWave(waveId, resolved.length);
    // The pump's budget is anchored at the REQUEST (validation already spent part of it).
    for (const lane of res.lanes) after(() => pumpLane(lane, { origin, startedAt }));

    return NextResponse.json({ ok: true, queued: res.accepted.length, rows, ...(res.failed.length ? { failed: res.failed } : {}) });
  } finally {
    inflightWaves.delete(waveId);
  }
}

/** Copies of one board row differ only by `client_reference` — the refusal key ignores it. */
const rowKeyOf = (wire: object): string => JSON.stringify({ ...wire, client_reference: undefined });

// ---------- fresh launches ----------

export type TiktokLaunchWaveBody = { waveId?: string; shots?: TiktokLaunchShotIn[] };

/**
 * POST /api/tiktok/launch — fresh TikTok campaigns (one shot = one campaign; copies are expanded
 * by the board). Every asset must already be a public HTTPS URL (Vercel Blob); the wire is built
 * and validated by lib/tiktok-launch tiktokLaunchWire against the target advertiser's LIVE config
 * (pixels and their modes, countries, languages).
 */
export async function handleTiktokLaunch(req: Request): Promise<NextResponse> {
  const startedAt = Date.now();
  const g = gate(req);
  if (g instanceof NextResponse) return g;
  const { user, session } = g;

  let body: TiktokLaunchWaveBody;
  try {
    body = (await req.json()) as TiktokLaunchWaveBody;
  } catch {
    return bad("bad_json");
  }
  const shotsIn = Array.isArray(body.shots) ? body.shots : [];
  if (shotsIn.length === 0) return bad("no_shots");
  if (shotsIn.length > TIKTOK_MAX_SHOTS) return bad(`too_many_shots (max ${TIKTOK_MAX_SHOTS})`);
  const waveId = TIKTOK_WAVE_ID_RE.test(s(body.waveId)) ? s(body.waveId) : crypto.randomUUID();

  let advertisers: TwAdvertiser[];
  try {
    advertisers = await tiktokLaunchableAdvertisers();
  } catch (e) {
    return bad(`tiktok_weapon_unreachable: ${(e as Error).message}`, 502);
  }
  const advertiserById = new Map(advertisers.map((a) => [a.advertiserId, a]));
  for (let i = 0; i < shotsIn.length; i++) {
    const id = s(shotsIn[i]?.advertiser);
    if (!TIKTOK_ADVERTISER_ID_RE.test(id)) return bad(`shot ${i + 1}: pick an advertiser`);
    if (!advertiserById.has(id)) return bad(`shot ${i + 1}: advertiser ${id} is not launch-eligible on LION`, 400, { advertiserId: id });
  }
  const configs = await loadConfigs(shotsIn.map((x) => s(x.advertiser)));
  const ddmm = todaySaoPauloDotDDMM();

  const resolved: ResolvedShot[] = [];
  for (let i = 0; i < shotsIn.length; i++) {
    const x = shotsIn[i];
    const at = `shot ${i + 1}`;
    const advertiserId = s(x.advertiser);
    const target = advertiserById.get(advertiserId) as TwAdvertiser;
    const cfg = configs.get(advertiserId);
    if (!cfg || "error" in cfg) return bad(`${at}: couldn't read ${target.name}'s config — ${cfg && "error" in cfg ? cfg.error : "no answer"}`, 502);
    const px = tiktokResolvePixel(cfg.pixels, s(x.pixel), target.name);
    if ("refusal" in px) return bad(`${at}: ${px.refusal}`, 400, { availablePixels: cfg.pixels.map((p) => p.pixelCode) });
    const taskId = tiktokShotTaskId("launch", waveId, i);
    const nameSuffix = tiktokNameSuffix({ user, ddmm, tail: s(x.suffix) });
    const built = tiktokLaunchWire(x, {
      advertiserId,
      pixelCode: px.pixelCode,
      supportedModes: px.supportedModes,
      nameSuffix,
      clientReference: taskId,
      config: { countries: cfg.countries.map((c) => c.code), languages: cfg.languages.map((l) => l.code) },
    });
    if ("refusal" in built) return bad(`${at}: ${built.refusal}`);
    const w = built.wire;
    const head = tiktokNameHeadPreview({ acr: LION_ACR, countries: w.locales.countries, language: w.locales.language, landing: w.landing_page_url });
    resolved.push({
      taskId,
      kind: "launch",
      campaignId: "",
      rowKey: rowKeyOf(w),
      wire: w,
      row: {
        // Provisional: LION generates the real campaign name; the pump's settle pass swaps it in.
        name: tiktokNamePreview({ head, suffix: nameSuffix, kind: "launch", smartPlus: w.campaign_kind ? (w.budget_level === "campaign" ? "campaign" : "adgroup") : "" }).slice(0, 250),
        geo: tiktokGeoLabel(w.locales.countries),
        budget: w.budget.replace(".", ","),
        advertiser: advertiserId,
        currency: target.currency || cfg.currency,
        bid: built.label,
      },
    });
  }
  return acceptTiktokWave(session, waveId, resolved, startedAt, selfOrigin(req));
}

// ---------- clone / JURO ----------

export type TiktokCloneWaveBody = {
  waveId?: string;
  /** Wave-level destination (clone); a shot's own advertiser / pixel wins. */
  advertiser?: string;
  pixel?: string;
  shots?: TiktokCloneShotIn[];
};

/** The name LION will build for a copy of `src`, as far as we can know it before the task runs. */
function provisionalCopyName(kind: "clone" | "juro", campaignId: string, sourceName: string, suffix: string): string {
  const parts = parseTiktokName(sourceName);
  const acr = (LION_ACR || "GLO-01").toUpperCase();
  // A clone may land on another advertiser → another cluster number; JURO stays where it was.
  const cl = kind === "juro" ? parts.cl || "cl" : "cl";
  const head = parts.geo.length
    ? `{HS-____} (${acr}) [${cl}|${parts.geo.join(",")}|${parts.language || "ALL"}] (${parts.landingPath || "<landing>"})`
    : sourceName || `campaign ${campaignId}`;
  return tiktokNamePreview({ head, suffix, kind, sourceId: campaignId, smartPlus: kind === "clone" ? parts.smartPlus : "" }).slice(0, 250);
}

export async function handleTiktokWave(req: Request, kind: "clone" | "juro"): Promise<NextResponse> {
  const startedAt = Date.now();
  const g = gate(req);
  if (g instanceof NextResponse) return g;
  const { user, session } = g;

  let body: TiktokCloneWaveBody;
  try {
    body = (await req.json()) as TiktokCloneWaveBody;
  } catch {
    return bad("bad_json");
  }
  const shotsIn = Array.isArray(body.shots) ? body.shots : [];
  if (shotsIn.length === 0) return bad("no_shots");
  if (shotsIn.length > TIKTOK_MAX_SHOTS) return bad(`too_many_shots (max ${TIKTOK_MAX_SHOTS})`);
  const waveId = TIKTOK_WAVE_ID_RE.test(s(body.waveId)) ? s(body.waveId) : crypto.randomUUID();
  for (let i = 0; i < shotsIn.length; i++) {
    if (!TIKTOK_CAMPAIGN_ID_RE.test(s(shotsIn[i]?.campaignId))) return bad(`shot ${i + 1}: bad campaignId`);
  }

  // ---- catalogs: advertisers (target validation) + LION metrics (names / geo / source accounts) --
  let advertisers: TwAdvertiser[];
  try {
    advertisers = await tiktokLaunchableAdvertisers();
  } catch (e) {
    return bad(`tiktok_weapon_unreachable: ${(e as Error).message}`, 502);
  }
  const advertiserById = new Map(advertisers.map((a) => [a.advertiserId, a]));
  let known: Record<string, LionTiktokRow> = {};
  if (lionTokenConfigured()) {
    try {
      known = await lionTiktokFindCampaigns([...new Set(shotsIn.map((x) => s(x.campaignId)))]);
    } catch {
      known = {}; // LION lag must not block a launch — the partner's dataset is the real gate
    }
  }

  const waveAdvertiser = s(body.advertiser);
  const wavePixel = s(body.pixel);
  const targetOf = (x: TiktokCloneShotIn): string => s(x.advertiser) || waveAdvertiser;
  let configs = new Map<string, TwConfig | { error: string }>();
  if (kind === "clone") {
    for (let i = 0; i < shotsIn.length; i++) {
      const id = targetOf(shotsIn[i]);
      if (!TIKTOK_ADVERTISER_ID_RE.test(id)) return bad(`shot ${i + 1}: target advertiser is required`);
      if (!advertiserById.has(id)) return bad(`shot ${i + 1}: target advertiser ${id} is not launch-eligible on LION`, 400, { advertiserId: id });
    }
    configs = await loadConfigs(shotsIn.map(targetOf));
  }

  const ddmm = todaySaoPauloDotDDMM();
  const resolved: ResolvedShot[] = [];
  for (let i = 0; i < shotsIn.length; i++) {
    const x = shotsIn[i];
    const at = `shot ${i + 1}`;
    const campaignId = s(x.campaignId);
    const src = known[campaignId];
    const sourceName = src?.name || s(x.sourceName);
    const parts = parseTiktokName(sourceName);
    const nameSuffix = tiktokNameSuffix({ user, ddmm, tail: s(x.suffix) });
    const taskId = tiktokShotTaskId(kind, waveId, i);

    let wire: TiktokCloneWire | TiktokJuroWire;
    let label: string;
    let advertiserId: string;
    let currency: string;
    if (kind === "clone") {
      advertiserId = targetOf(x);
      const target = advertiserById.get(advertiserId) as TwAdvertiser;
      const cfg = configs.get(advertiserId);
      if (!cfg || "error" in cfg) return bad(`${at}: couldn't read ${target.name}'s config — ${cfg && "error" in cfg ? cfg.error : "no answer"}`, 502);
      // The wave pixel rides only onto targets that actually carry it — a per-row override onto
      // another advertiser must resolve ITS pixel, not inherit the wave's foreign one.
      const picked = s(x.pixel) || (wavePixel && cfg.pixels.some((p) => p.pixelCode === wavePixel) ? wavePixel : "");
      const px = tiktokResolvePixel(cfg.pixels, picked, target.name);
      if ("refusal" in px) return bad(`${at}: ${px.refusal}`, 400, { availablePixels: cfg.pixels.map((p) => p.pixelCode) });
      const built = tiktokCloneWire(x, { advertiserId, pixelCode: px.pixelCode, supportedModes: px.supportedModes, nameSuffix });
      if ("refusal" in built) return bad(`${at}: ${built.refusal}`);
      wire = built.wire;
      label = built.label;
      currency = target.currency || cfg.currency;
    } else {
      // JURO always lands on the source's own advertiser; we know it only through LION metrics.
      if (parts.smartPlus) return bad(`${at}: JURO doesn't support Smart+ sources — clone campaign ${campaignId} instead`);
      advertiserId = src?.accountId || s(x.sourceAccount);
      const target = advertiserId ? advertiserById.get(advertiserId) : undefined;
      if (src?.accountId && !target) {
        return bad(`${at}: JURO lands on the source's own advertiser (${src.accountName || src.accountId}), which is not launch-eligible on LION — clone it onto another advertiser instead`);
      }
      const built = tiktokJuroWire(x, { nameSuffix });
      if ("refusal" in built) return bad(`${at}: ${built.refusal}`);
      wire = built.wire;
      label = built.label;
      currency = target?.currency || src?.currency || s(x.currency);
    }

    resolved.push({
      taskId,
      kind,
      campaignId,
      rowKey: rowKeyOf(wire),
      wire,
      row: {
        name: provisionalCopyName(kind, campaignId, sourceName, nameSuffix),
        geo: tiktokGeoLabel(parts.geo) || s(x.geo),
        budget: wire.budget.replace(".", ","),
        advertiser: advertiserId,
        currency,
        bid: label,
      },
    });
  }
  return acceptTiktokWave(session, waveId, resolved, startedAt, selfOrigin(req));
}
