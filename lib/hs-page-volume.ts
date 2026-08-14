// Server-only. HS fanpage fill counts — Meta's own limit meter first, LION tally as fallback.
//
// The LION metrics tally (lionPageAdCounts) counts EVERY ad inside ACTIVE campaigns, but Meta's
// per-page limit meters "ads running or in review" — disapproved/dead ads inside still-ACTIVE
// campaigns don't occupy the limit, so the tally overcounts badly (live 08-14: tally 451 vs
// Meta 184 on the same page). Our launch tokens can't read HS pool pages (Graph answers
// "Unsupported request" for pages outside the token's business); the partner-side user tokens
// can, via `act_<pool account>/ads_volume?page_id=` (cross-account total, verified live 08-14).
//
// TWO vantage groups, because the pool spans businesses and a token only reads its own slice:
//   FB_HS_VOLUME_TOKEN       ("Gcforhs2") — ~30 VD-C1 accounts, covers the main API-launch pages;
//   FB_HS_VOLUME_TOKEN_FARM  ("userforhs") — the FARM business (single DS-* account), covers the
//                            34-page FARM pool (its pages carry warming ads LION never sees).
// Each page is asked ONLY through its group (FARM pages resolved from the LION FARM profile) —
// cross-group retries would double the load onto the FARM group's lone account for nothing.
//
// Sweep shape mirrors MO's /api/fanpages/volume (one ads_volume call per page) with one twist:
// the vantage account ROTATES across the group's accounts. The ads_volume quota is per ad
// account — a single-account sweep of ~220 pages tripped code 17 mid-sweep on the first live run
// (08-14); spread over ~30 accounts each carries a handful of calls. An account that answers
// code 17 drops out of the rotation and its page retries on the next one. Per page: a positive
// Graph count wins; a 0/failed read falls back to the LION tally — Meta's counters have gone
// dark before (all-zero episode ~08-10) and an overcount errs in the safe direction, never
// paints a full page as free.

import { lionPageAdCounts, lionProfileData, lionProfiles } from "./lion";

const FB = "https://graph.facebook.com/v21.0";
const MAIN_TOKEN = process.env.FB_HS_VOLUME_TOKEN ?? "";
const FARM_TOKEN = process.env.FB_HS_VOLUME_TOKEN_FARM ?? "";

const COUNTS_TTL_MS = 15 * 60_000;
const ACCOUNT_TTL_MS = 60 * 60_000;
// ~220 pages spread over ~30 rotation accounts = a handful of calls per account, so the sweep
// can afford more parallelism than MO's single-account one (cold sweep ~15-20s, not ~50s).
const SWEEP_CONCURRENCY = 6;
const SWEEP_STAGGER_MS = 80;
const CALL_TIMEOUT_MS = 10_000;
// Meta throttle codes — once one appears every remaining call would fail too; stop burning quota.
const RATE_LIMIT_CODES = new Set([4, 17, 613, 80004, 80014]);

type Vantage = { token: string; healthy: Set<string> };

let countsCache: { at: number; counts: Record<string, number> } | null = null;
const accountsCache = new Map<string, { at: number; ids: string[] }>();
let farmPagesCache: { at: number; ids: Set<string> } | null = null;
let inflight: Promise<Record<string, number>> | null = null;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fbGet(token: string, path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${FB}/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  return (await res.json()) as Record<string, unknown>;
}

/** Pool accounts a token sees — its rotation set of ads_volume vantage points (the count is the
 *  page's cross-account total, so ANY readable account answers the same number). Resolved live
 *  because pool accounts churn (bans/disables). */
async function sweepAccountIds(token: string): Promise<string[]> {
  const cached = accountsCache.get(token);
  if (cached && Date.now() - cached.at < ACCOUNT_TTL_MS) return cached.ids;
  try {
    const body = await fbGet(token, "me/adaccounts?fields=id&limit=50");
    const ids = ((body.data as Array<{ id?: string }> | undefined) ?? [])
      .map((a) => String(a.id ?? "").replace(/^act_/, ""))
      .filter(Boolean);
    if (ids.length === 0) return [];
    accountsCache.set(token, { at: Date.now(), ids });
    return ids;
  } catch {
    return [];
  }
}

/** The FARM page pool — every globecoders-FARM-* profile mirrors the same ~34 pages, so the
 *  first one names the whole set. Empty set (LION hiccup / no FARM profile) just means no page
 *  routes to the FARM group this sweep. */
async function farmPageIds(): Promise<Set<string>> {
  if (farmPagesCache && Date.now() - farmPagesCache.at < COUNTS_TTL_MS) return farmPagesCache.ids;
  try {
    const slug = (await lionProfiles()).find((s) => /farm/i.test(s));
    if (!slug) return new Set();
    const ids = new Set((await lionProfileData(slug)).pages.map((p) => String(p.id)));
    farmPagesCache = { at: Date.now(), ids };
    return ids;
  } catch {
    return new Set();
  }
}

/** One ads_volume read; null = unreadable (error/timeout), -1 = rate-limited (rotate account). */
async function pageCount(v: Vantage, accountId: string, pageId: string): Promise<number | null> {
  try {
    const body = await fbGet(v.token, `act_${accountId}/ads_volume?page_id=${pageId}&fields=ads_running_or_in_review_count`);
    const err = body.error as { code?: number } | undefined;
    if (err) return RATE_LIMIT_CODES.has(err.code ?? 0) ? -1 : null;
    const n = (body.data as Array<Record<string, unknown>> | undefined)?.[0]?.ads_running_or_in_review_count;
    return typeof n === "number" && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Fill counts for every page the team currently has ads on (the LION tally's key set) plus the
 * FARM pool pages. A page in neither set isn't swept and reads as 0 on the client, same
 * contract as before.
 */
export async function hsPageAdCounts(): Promise<Record<string, number>> {
  const tally = await lionPageAdCounts(); // throws on LION hiccup — route surfaces it, as before
  if (!MAIN_TOKEN && !FARM_TOKEN) return tally;
  if (countsCache && Date.now() - countsCache.at < COUNTS_TTL_MS) return countsCache.counts;
  if (inflight) return inflight;

  inflight = (async () => {
    const farmPages = FARM_TOKEN ? await farmPageIds() : new Set<string>();
    const groups: { main?: Vantage; farm?: Vantage } = {};
    if (MAIN_TOKEN) {
      const ids = await sweepAccountIds(MAIN_TOKEN);
      if (ids.length) groups.main = { token: MAIN_TOKEN, healthy: new Set(ids) };
    }
    if (FARM_TOKEN && farmPages.size) {
      const ids = await sweepAccountIds(FARM_TOKEN);
      if (ids.length) groups.farm = { token: FARM_TOKEN, healthy: new Set(ids) };
    }
    if (!groups.main && !groups.farm) return tally;

    const pageIds = [...new Set([...Object.keys(tally), ...farmPages])];
    const merged: Record<string, number> = { ...tally };
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= pageIds.length) return;
        const id = pageIds[i];
        const v = farmPages.has(id) ? groups.farm : groups.main;
        if (!v || v.healthy.size === 0) continue; // group exhausted → fallback stays
        // Try up to 3 rotation slots for this page — a throttled account drops out of the
        // rotation and the page moves to the next; a fully-throttled group leaves its
        // remaining pages on the fallback numbers.
        for (let hop = 0; hop < 3 && v.healthy.size > 0; hop++) {
          const accounts = [...v.healthy];
          const acct = accounts[(i + hop) % accounts.length];
          const n = await pageCount(v, acct, id);
          if (n === -1) {
            v.healthy.delete(acct);
            continue;
          }
          if (n !== null && n > 0) merged[id] = n;
          break;
        }
        await pause(SWEEP_STAGGER_MS);
      }
    };
    await Promise.all(Array.from({ length: SWEEP_CONCURRENCY }, worker));
    countsCache = { at: Date.now(), counts: merged };
    return merged;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}
