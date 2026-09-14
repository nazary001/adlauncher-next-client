import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { GOOGLE_CAMPAIGN_ID_RE } from "@/lib/google-bid";
import { googleGeoFromName, type GoogleSourceInfo, type LionGoogleRow } from "@/lib/google-source";
import { GoogleWeaponError, googleRailEnabled, googleWeaponConfigured, gwCustomers, gwDatasetFetch } from "@/lib/google-weapon";
import { lionConfigured } from "@/lib/lion";
import { lionGoogleFindCampaigns } from "@/lib/lion-google";

export const runtime = "nodejs";
// It triggers a non-force dataset fetch per id (pre-warms the snapshot) + a LION metrics scan —
// keep the cap generous but bounded so an abandoned board read can't idle a long window.
export const maxDuration = 120;

const MAX_IDS = 30;
const DATASET_CONCURRENCY = 5;

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

/** Run a batch of async jobs with at most `limit` in flight. */
async function eachLimit<T>(items: T[], limit: number, run: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await run(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * POST { ids } → per-source board facts for the Google clone board. Source facts come from LION's
 * Google metrics (there is no google-weapon read for them); currency comes from the customers list
 * by account id; geo is read from the name. Each id is ALSO pre-warmed with a non-force dataset
 * fetch so the board's dataset chip is truthful before the buyer fires.
 *
 * Resilience: a LION metrics failure must NOT fail the request — the ids come back known=false but
 * still carry dataset info (the dataset fetch is the real launch gate). A per-id dataset 404
 * (LION never saw it) → "missing"; any other dataset throw → "error".
 */
export async function POST(req: Request): Promise<NextResponse> {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) return bad("unauthorized", 401);
  if (!googleRailEnabled()) return NextResponse.json({ ok: false, error: "google_rail_disabled" }, { status: 404 });
  if (!googleWeaponConfigured()) return bad("google_weapon_not_configured", 500);

  let body: { ids?: unknown };
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

  // Facts (LION) and account currency (customers) load in parallel; NEITHER can sink the request.
  const emptyKnown: Record<string, LionGoogleRow> = {};
  const [known, customers] = await Promise.all([
    lionConfigured() ? lionGoogleFindCampaigns(ids).catch(() => emptyKnown) : Promise.resolve(emptyKnown),
    gwCustomers().catch(() => []),
  ]);
  const currencyByAccount = new Map(customers.map((c) => [c.customerId, c.currency]));

  // Non-force dataset fetch per id (≤5 parallel) — a 404 means LION never saw it → "missing".
  const dataset = new Map<string, GoogleSourceInfo["dataset"]>();
  await eachLimit(ids, DATASET_CONCURRENCY, async (id) => {
    try {
      const r = await gwDatasetFetch(id);
      dataset.set(id, { state: r.state, fetchedAt: r.fetchedAt });
    } catch (e) {
      const err = e instanceof GoogleWeaponError ? e : null;
      const message = e instanceof Error ? e.message : String(e);
      dataset.set(id, { state: err?.status === 404 ? "missing" : "error", fetchedAt: null, error: message });
    }
  });

  const sources: GoogleSourceInfo[] = ids.map((id) => {
    const src = known[id];
    const name = src?.name ?? "";
    return {
      campaignId: id,
      known: Boolean(src),
      name,
      status: src?.status ?? "",
      accountId: src?.accountId ?? "",
      accountName: src?.accountName ?? "",
      currency: (src?.accountId && currencyByAccount.get(src.accountId)) || "",
      budget: src?.budget ?? null,
      bid: src?.bid ?? null,
      geo: googleGeoFromName(name),
      dataset: dataset.get(id) ?? { state: "error", fetchedAt: null, error: "dataset check did not run" },
    };
  });

  return NextResponse.json({ ok: true, sources });
}
