// TikTok rail — the shared wave handlers behind POST /api/tiktok/launch, /clone and /juro.
// Same skeleton as the Google / HS wave routes: session → gates → parse → validate EVERY shot →
// stamp rows into the shared store → claim the wave (idempotency) → after(pump) → answer at once.

import { NextResponse, after } from "next/server";
import { sessionFromCookieHeader } from "./session";
import { readAppCache, writeAppCache } from "./app-cache";
import { storeConfigured, upsertTaskRow } from "./task-store";
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
import { TIKTOK_PARTNER, TIKTOK_PUMP_BUDGET_MS, pumpTiktokWave, type TiktokPumpShot } from "./tiktok-pump";

export const TIKTOK_MAX_SHOTS = 45;
const CONFIG_CONCURRENCY = 5;

const bad = (error: string, status = 400, extra: Record<string, unknown> = {}) => NextResponse.json({ ok: false, error, ...extra }, { status });
const s = (v: unknown): string => (v == null ? "" : String(v)).trim();

const claimedWaves = new Set<string>();
const rememberWave = (id: string) => {
  claimedWaves.add(id);
  if (claimedWaves.size > 500) claimedWaves.delete(claimedWaves.values().next().value as string);
};

/** The advertisers the console OFFERS and ACCEPTS as launch targets (owner decision 18.09: every
 *  `launch_eligible` one). Read-only lookups (a source's account name) keep twAdvertisers. */
export async function tiktokLaunchableAdvertisers(): Promise<TwAdvertiser[]> {
  return (await twAdvertisers()).filter(isTiktokLaunchAccount);
}

/** Session + the rail's gates, in the order every TikTok launch route shares. */
function gate(req: Request): { user: string } | NextResponse {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session?.username) return bad("unauthorized", 401);
  if (!tiktokRailEnabled()) return bad("tiktok_rail_disabled", 404);
  if (!tiktokWeaponConfigured()) return bad("tiktok_weapon_not_configured", 500);
  // Refused before a single row is stamped: this instance must not fire at the live partner.
  if (!tiktokLiveLaunchAllowed()) return bad(TIKTOK_LIVE_LAUNCH_BLOCKED, 403);
  return { user: String(session.username) };
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

/**
 * The accepted-wave tail every TikTok launch shares: idempotency (same-instance set + app-cache
 * claim), stamp rows BEFORE the claim and the answer (the team sees queued rows even if the
 * browser dies now; a crash before the claim re-stamps the SAME task ids on retry), claim (fail
 * CLOSED when unwritable — a retry could otherwise pump twice), after(pump), answer.
 */
async function acceptTiktokWave(user: string, waveId: string, resolved: ResolvedShot[], startedAt: number): Promise<NextResponse> {
  const waveKey = `tiktok-wave:${waveId}`;
  const rows = resolved.map((r) => ({ taskId: r.taskId, campaignId: r.campaignId }));
  const alreadyAccepted = () => NextResponse.json({ ok: true, queued: resolved.length, rows, alreadyAccepted: true });
  if (claimedWaves.has(waveId)) return alreadyAccepted();
  if (!storeConfigured()) return bad("task_store_not_configured_wave_not_fired", 503);
  const prior = await readAppCache<{ user: string; at: number }>(waveKey);
  if (prior) return alreadyAccepted();
  const now = Date.now();
  await Promise.all(
    resolved.map((r) =>
      upsertTaskRow(user, r.taskId, {
        partner: TIKTOK_PARTNER,
        name: r.row.name,
        geo: r.row.geo,
        budget: r.row.budget,
        status: "running",
        stage: "submit",
        gcm: KIND_TAG[r.kind],
        adset_id: r.row.advertiser,
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
  // The claim is a POST of a UNIQUE key, so exactly one of two racing requests gets a row back.
  const claim = await writeAppCache(waveKey, { user, at: now });
  if (!claim) {
    // Lost the race to a twin request (a double submit, a retry that overlapped): the winner is
    // pumping these very task ids — answer like any other repeat.
    if (await readAppCache(waveKey)) return alreadyAccepted();
    // The store really refused the claim: nothing will pump the rows stamped above, so they must
    // not sit "running" for the team to wonder about (a stuck row invites a blind re-fire).
    await Promise.all(
      resolved.map((r) =>
        upsertTaskRow(user, r.taskId, { partner: TIKTOK_PARTNER, status: "error", stage: "submit", error: "Not fired — the task store refused the wave claim; nothing was sent to LION. Fire the wave again.", finished_at: Date.now() }),
      ),
    );
    return bad("task_store_unavailable_wave_not_fired", 503);
  }
  rememberWave(waveId);

  const shots: TiktokPumpShot[] = resolved.map((r) => ({ taskId: r.taskId, kind: r.kind, campaignId: r.campaignId, body: r.wire, rowKey: r.rowKey }));
  // The budget is anchored at the REQUEST (validation + stamping already spent part of it).
  const deadline = startedAt + TIKTOK_PUMP_BUDGET_MS;
  after(() => pumpTiktokWave(user, shots, deadline));

  return NextResponse.json({ ok: true, queued: resolved.length, rows });
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
  const { user } = g;

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
  return acceptTiktokWave(user, waveId, resolved, startedAt);
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
  const { user } = g;

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
  return acceptTiktokWave(user, waveId, resolved, startedAt);
}
