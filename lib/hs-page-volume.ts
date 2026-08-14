// Server-only. HS fanpage fill counts — Meta's own limit meter first, LION tally as fallback.
//
// The LION metrics tally (lionPageAdCounts) counts EVERY ad inside ACTIVE campaigns, but Meta's
// per-page limit meters "ads running or in review" — disapproved/dead ads inside still-ACTIVE
// campaigns don't occupy the limit, so the tally overcounts badly (live 08-14: tally 451 vs
// Meta 184 on the same page). Our launch tokens can't read HS pool pages (Graph answers
// "Unsupported request" for pages outside the token's business), but the partner-side user token
// (FB_HS_VOLUME_TOKEN, "Gcforhs2") sits inside the HS pool BM and reads the real counter via
// `act_<any pool account>/ads_volume?page_id=` (cross-account total, verified live 08-14).
//
// Sweep shape mirrors MO's /api/fanpages/volume (one ads_volume call per page) with one twist:
// the vantage account ROTATES across the pool accounts the token sees. The ads_volume quota is
// per ad account — a single-account sweep of ~220 pages tripped code 17 mid-sweep on the first
// live run (08-14); spread over ~30 accounts each carries a handful of calls. An account that
// answers code 17 drops out of the rotation and its page retries on the next one. Per page: a
// positive Graph count wins; a 0/failed read falls back to the LION tally — Meta's counters have
// gone dark before (all-zero episode ~08-10) and an overcount errs in the safe direction, never
// paints a full page as free.

import { lionPageAdCounts } from "./lion";

const FB = "https://graph.facebook.com/v21.0";
const TOKEN = process.env.FB_HS_VOLUME_TOKEN ?? "";

const COUNTS_TTL_MS = 15 * 60_000;
const ACCOUNT_TTL_MS = 60 * 60_000;
// ~220 pages spread over ~30 rotation accounts = a handful of calls per account, so the sweep
// can afford more parallelism than MO's single-account one (cold sweep ~15-20s, not ~50s).
const SWEEP_CONCURRENCY = 6;
const SWEEP_STAGGER_MS = 80;
const CALL_TIMEOUT_MS = 10_000;
// Meta throttle codes — once one appears every remaining call would fail too; stop burning quota.
const RATE_LIMIT_CODES = new Set([4, 17, 613, 80004, 80014]);

let countsCache: { at: number; counts: Record<string, number> } | null = null;
let accountsCache: { at: number; ids: string[] } | null = null;
let inflight: Promise<Record<string, number>> | null = null;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fbGet(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${FB}/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(TOKEN)}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  return (await res.json()) as Record<string, unknown>;
}

/** Pool accounts the token sees — the rotation set for ads_volume vantage points (the count is
 *  the page's cross-account total, so ANY account answers the same number). Resolved live
 *  because pool accounts churn (bans/disables). */
async function sweepAccountIds(): Promise<string[]> {
  if (accountsCache && Date.now() - accountsCache.at < ACCOUNT_TTL_MS) return accountsCache.ids;
  try {
    const body = await fbGet("me/adaccounts?fields=id&limit=50");
    const ids = ((body.data as Array<{ id?: string }> | undefined) ?? [])
      .map((a) => String(a.id ?? "").replace(/^act_/, ""))
      .filter(Boolean);
    if (ids.length === 0) return [];
    accountsCache = { at: Date.now(), ids };
    return ids;
  } catch {
    return [];
  }
}

/** One ads_volume read; null = unreadable (error/timeout), -1 = rate-limited (rotate account). */
async function pageCount(accountId: string, pageId: string): Promise<number | null> {
  try {
    const body = await fbGet(`act_${accountId}/ads_volume?page_id=${pageId}&fields=ads_running_or_in_review_count`);
    const err = body.error as { code?: number } | undefined;
    if (err) return RATE_LIMIT_CODES.has(err.code ?? 0) ? -1 : null;
    const n = (body.data as Array<Record<string, unknown>> | undefined)?.[0]?.ads_running_or_in_review_count;
    return typeof n === "number" && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Fill counts for every page the team currently has ads on (the LION tally's key set — a page
 * with zero team ads isn't swept and reads as 0 on the client, same contract as before).
 */
export async function hsPageAdCounts(): Promise<Record<string, number>> {
  const tally = await lionPageAdCounts(); // throws on LION hiccup — route surfaces it, as before
  if (!TOKEN) return tally;
  if (countsCache && Date.now() - countsCache.at < COUNTS_TTL_MS) return countsCache.counts;
  if (inflight) return inflight;

  inflight = (async () => {
    const healthy = new Set(await sweepAccountIds());
    if (healthy.size === 0) return tally;

    const pageIds = Object.keys(tally);
    const merged: Record<string, number> = { ...tally };
    let next = 0;
    const worker = async () => {
      while (healthy.size > 0) {
        const i = next++;
        if (i >= pageIds.length) return;
        const id = pageIds[i];
        // Try up to 3 rotation slots for this page — a throttled account drops out of the
        // rotation and the page moves to the next; all-throttled ends the sweep (tally stays).
        for (let hop = 0; hop < 3 && healthy.size > 0; hop++) {
          const accounts = [...healthy];
          const acct = accounts[(i + hop) % accounts.length];
          const n = await pageCount(acct, id);
          if (n === -1) {
            healthy.delete(acct);
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
