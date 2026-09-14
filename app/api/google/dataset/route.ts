import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { GOOGLE_CAMPAIGN_ID_RE } from "@/lib/google-bid";
import { GoogleWeaponError, googleRailEnabled, googleWeaponConfigured, gwDatasetFetch, gwDatasetStatus } from "@/lib/google-weapon";

export const runtime = "nodejs";
// A poll (status) or a re-snapshot (force) of a handful of ids — a short cap keeps an abandoned
// poll from idling a long window.
export const maxDuration = 60;

const MAX_IDS = 30;
const CONCURRENCY = 5;

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

type DatasetState = { state: "ready" | "fetching" | "missing" | "error"; fetchedAt: string | null; error?: string };

async function eachLimit<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await run(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * POST { ids, force? } → the current dataset state per id. Default = a cheap status poll (never an
 * error — an unknown id reads "fetching"); `force:true` re-snapshots a changed source through
 * `dataset/fetch/?force` (which CAN throw: 404 LION-never-saw-it → "missing", other → "error").
 * Feeds the board's dataset chip + the "re-fetch" button.
 */
export async function POST(req: Request): Promise<NextResponse> {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) return bad("unauthorized", 401);
  if (!googleRailEnabled()) return NextResponse.json({ ok: false, error: "google_rail_disabled" }, { status: 404 });
  if (!googleWeaponConfigured()) return bad("google_weapon_not_configured", 500);

  let body: { ids?: unknown; force?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return bad("bad_json");
  }
  const ids = [
    ...new Set(
      (Array.isArray(body.ids) ? body.ids : [])
        .map((x) => String(x).trim())
        .filter((x) => GOOGLE_CAMPAIGN_ID_RE.test(x)),
    ),
  ];
  if (ids.length === 0) return bad("no_ids");
  if (ids.length > MAX_IDS) return bad(`too_many_ids (max ${MAX_IDS})`);
  const force = body.force === true;

  const datasets: Record<string, DatasetState> = {};
  await eachLimit(ids, CONCURRENCY, async (id) => {
    try {
      if (force) {
        const r = await gwDatasetFetch(id, true);
        datasets[id] = { state: r.state, fetchedAt: r.fetchedAt };
      } else {
        const s = await gwDatasetStatus(id);
        datasets[id] = { state: s.ready ? "ready" : "fetching", fetchedAt: s.fetchedAt };
      }
    } catch (e) {
      const err = e instanceof GoogleWeaponError ? e : null;
      const message = e instanceof Error ? e.message : String(e);
      datasets[id] = { state: err?.status === 404 ? "missing" : "error", fetchedAt: null, error: message };
    }
  });

  return NextResponse.json({ ok: true, datasets });
}
