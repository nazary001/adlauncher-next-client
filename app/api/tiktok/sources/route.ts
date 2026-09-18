import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { TIKTOK_CAMPAIGN_ID_RE, tiktokGeoLabel } from "@/lib/tiktok-launch";
import { parseTiktokName, type LionTiktokRow, type TiktokSourceInfo } from "@/lib/tiktok-source";
import { TiktokWeaponError, tiktokRailEnabled, tiktokWeaponConfigured, twDatasetFetch } from "@/lib/tiktok-weapon";
import { lionTokenConfigured } from "@/lib/lion";
import { lionTiktokFindCampaigns } from "@/lib/lion-tiktok";

export const runtime = "nodejs";
// A dataset-fetch trigger per id (pre-warms the partner's snapshot) + a LION metrics scan — keep
// the cap generous but bounded so an abandoned board read can't idle a long window.
export const maxDuration = 120;

const MAX_IDS = 30;
const DATASET_CONCURRENCY = 5;

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

/** Run a batch of async jobs with at most `limit` in flight. */
async function eachLimit<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await run(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * POST { ids } → per-source board facts for the TikTok clone board. Facts come from LION's TikTok
 * metrics (name, status, advertiser, budget, bid); geo / language / landing path / Smart+ are read
 * from LION's own name grammar. Each id ALSO gets a dataset fetch triggered now, so by the time the
 * buyer fires the source is usually in the partner's launch dataset (tiktok-weapon has no status
 * read — "fetching" means "accepted", the pump's launch-first retry is the real gate).
 *
 * Resilience: a LION metrics failure must NOT fail the request — the ids come back known=false.
 * A per-id fetch 404 (LION never saw it) → "missing"; any other fetch throw → "error".
 */
export async function POST(req: Request): Promise<NextResponse> {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) return bad("unauthorized", 401);
  if (!tiktokRailEnabled()) return bad("tiktok_rail_disabled", 404);
  if (!tiktokWeaponConfigured()) return bad("tiktok_weapon_not_configured", 500);

  let body: { ids?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return bad("bad_json");
  }
  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((x) => String(x).trim()).filter((x) => TIKTOK_CAMPAIGN_ID_RE.test(x)))];
  if (ids.length === 0) return bad("no_ids");
  if (ids.length > MAX_IDS) return bad(`too_many_ids (max ${MAX_IDS})`);

  const emptyKnown: Record<string, LionTiktokRow> = {};
  const dataset = new Map<string, TiktokSourceInfo["dataset"]>();
  const [known] = await Promise.all([
    lionTokenConfigured() ? lionTiktokFindCampaigns(ids).catch(() => emptyKnown) : Promise.resolve(emptyKnown),
    eachLimit(ids, DATASET_CONCURRENCY, async (id) => {
      try {
        await twDatasetFetch(id);
        dataset.set(id, { state: "fetching" });
      } catch (e) {
        const st = e instanceof TiktokWeaponError ? e.status : undefined;
        dataset.set(id, { state: st === 404 ? "missing" : "error", error: e instanceof Error ? e.message : String(e) });
      }
    }),
  ]);

  const sources: TiktokSourceInfo[] = ids.map((id) => {
    const src = known[id];
    const parts = parseTiktokName(src?.name ?? "");
    return {
      campaignId: id,
      known: Boolean(src),
      name: src?.name ?? "",
      status: src?.status ?? "",
      delivery: src?.delivery ?? "",
      accountId: src?.accountId ?? "",
      accountName: src?.accountName ?? "",
      currency: src?.currency ?? "",
      budget: src?.budget ?? null,
      bid: src?.bid ?? null,
      geo: tiktokGeoLabel(parts.geo),
      language: parts.language,
      landingPath: parts.landingPath,
      smartPlus: parts.smartPlus,
      dataset: dataset.get(id) ?? { state: "unknown" },
    };
  });
  return NextResponse.json({ ok: true, sources });
}
