import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { snapAccountAdsRaw, snapAccountCampaignsRaw, snapAccountStatsRaw, snapAdAccounts, snapConfigured, snapRailEnabled } from "@/lib/snap-api";
import { isSnapReportPartial, snapReportDate } from "@/lib/snap-report";
import { listSnapKeys } from "@/lib/snap-keys";
import { joinSnapLive, parseSnapAccountStats, parseSnapAdReviews, parseSnapCampaignStates, snapDayWindow, snapLiveTotals, type SnapAccountRead } from "@/lib/snap-stats";

export const runtime = "nodejs";
export const maxDuration = 60;

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

/** Accounts read at once. Each account is three sequential GETs, so at most this many requests are
 *  in flight — the token's 10 rps is shared with the launch pump and a launch must never meet a 429
 *  because somebody opened the keys page. */
const ACCOUNT_CONCURRENCY = 3;
/** No account is STARTED after this: the slowest admitted one is 3 × 12 s, inside maxDuration. */
const START_BUDGET_MS = 20_000;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 160);

/**
 * GET ?date= → the SNAPCHAT side of the keys report for that São Paulo day: per bound key what its
 * campaign spent / showed / was swiped (Marketing API stats over the same 24 hours LION's report
 * covers) plus where it stands now — campaign status, delivery flags, ad review counts. Read-only.
 * Every account is best-effort: a failed read leaves its keys with nulls and is named in `errors`,
 * the rest of the table still answers. The registry is NOT best-effort here — without the bindings
 * there is nothing to join the numbers to.
 */
export async function GET(req: Request): Promise<NextResponse> {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) return bad("unauthorized", 401);
  if (!snapRailEnabled()) return bad("snap_rail_disabled", 404);
  if (!snapConfigured()) return bad("snap_not_configured", 500);
  const date = snapReportDate(new URL(req.url).searchParams.get("date"));
  if (!date) return bad("bad_date (today | yesterday | YYYY-MM-DD, not in the future)");
  const startedAt = Date.now();

  let bindings;
  try {
    bindings = (await listSnapKeys()).filter((r) => r.campaign_id && r.ad_account);
  } catch (e) {
    return bad(`registry_unavailable: ${message(e)}`, 502);
  }
  const window = snapDayWindow(date);
  const accountIds = [...new Set(bindings.map((r) => String(r.ad_account)))];
  // Names only make the table and the error lines readable — never worth failing the report for.
  const names = new Map<string, string>();
  if (accountIds.length > 0) {
    try {
      // Bounded: the catalog read carries the launcher's patient 60 s × 2 policy, and a label is not
      // worth this route's budget. A slow read keeps running and fills the cache for the next call.
      const late = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("slow")), 6_000));
      for (const a of await Promise.race([snapAdAccounts(), late])) names.set(a.id, a.name);
    } catch {
      /* ids it is */
    }
  }

  const reads: Record<string, SnapAccountRead> = {};
  const errors: string[] = [];
  const queue = [...accountIds];
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const label = names.get(id) || id;
      const read: SnapAccountRead = { name: names.get(id) ?? "", stats: null, states: null, reviews: null };
      reads[id] = read;
      if (Date.now() - startedAt > START_BUDGET_MS) {
        errors.push(`${label}: not read — Snapchat is answering slowly`);
        continue;
      }
      try {
        read.stats = parseSnapAccountStats(await snapAccountStatsRaw(id, window.start, window.end));
      } catch (e) {
        errors.push(`${label}: stats — ${message(e)}`);
      }
      try {
        read.states = parseSnapCampaignStates(await snapAccountCampaignsRaw(id));
        read.reviews = parseSnapAdReviews(await snapAccountAdsRaw(id));
      } catch (e) {
        errors.push(`${label}: status — ${message(e)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ACCOUNT_CONCURRENCY, accountIds.length) }, worker));

  const keys = joinSnapLive(bindings, reads);
  return NextResponse.json({ ok: true, date, partial: isSnapReportPartial(date), window, totals: snapLiveTotals(keys), keys, ...(errors.length ? { errors } : {}) });
}
