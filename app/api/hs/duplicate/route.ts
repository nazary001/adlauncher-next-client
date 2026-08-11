import { NextResponse } from "next/server";
import { parseMoney } from "@/lib/types";
import { sessionFromCookieHeader } from "@/lib/session";
import {
  LionError,
  lionAccountPixels,
  lionConfigured,
  lionDuplicate,
  lionProfileData,
} from "@/lib/lion";

export const runtime = "nodejs";
// One duplicate POST + (cold) profile-data reads — LION lags at times, keep headroom.
export const maxDuration = 60;

const MAX_COPIES = 20;

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

/**
 * Clone ONE existing LION campaign into the picked binds (the playbook-proven duplicate weapon).
 * Same authority split as /api/hs/launch: the binds are validated against LION's own catalog
 * (cached) BEFORE anything is sent — a shot into a disabled account or a foreign page dies
 * invisibly on the weapon side, so it gets refused here with a readable reason instead. LION's
 * preflight rejections (object-story creatives, dead sources) come back as the actionable text.
 */
export async function POST(req: Request): Promise<NextResponse> {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return bad("unauthorized", 401);
  }
  if (!lionConfigured()) return bad("lion_not_configured", 500);

  let body: {
    profile?: string;
    account?: string;
    page?: string;
    pixel?: string;
    campaignId?: string;
    copies?: number;
    budget?: string;
    /** Optional bid override, LION-UI semantics (plain number; ROAS decimal for MIN_ROAS
     *  sources). Empty/absent = inherit from the source — the safe default. */
    bid?: string;
    nameSuffix?: string;
    /** Full clone name (fixed grammar prefix + edited tail); absent = LION rebuilds it. */
    name?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return bad("bad_json");
  }

  const profile = String(body.profile ?? "").trim();
  const account = String(body.account ?? "").trim();
  const page = String(body.page ?? "").trim();
  const pixel = String(body.pixel ?? "").trim();
  const campaignId = String(body.campaignId ?? "").trim();
  const copies = Number(body.copies ?? 1);
  const nameSuffix = String(body.nameSuffix ?? "").trim().slice(0, 80);
  const name = String(body.name ?? "").trim().slice(0, 200);

  if (!profile) return bad("profile_required");
  if (!account) return bad("account_required");
  if (!page) return bad("page_required");
  if (!pixel) return bad("pixel_required");
  // LION campaign ids are the REAL FB ids — digits only.
  if (!/^\d{5,}$/.test(campaignId)) return bad("campaign_id_invalid");
  if (!Number.isInteger(copies) || copies < 1 || copies > MAX_COPIES) return bad("copies_invalid");
  // $1 floor mirrors the launch guard; budget rides as integer CENTS of the account currency.
  const budget = parseMoney(String(body.budget ?? ""));
  if (budget < 1 || budget > 10000) return bad("budget_invalid");
  const bidRaw = String(body.bid ?? "").trim();
  const bid = bidRaw ? parseMoney(bidRaw) : null;
  if (bidRaw && (!Number.isFinite(bid) || (bid as number) <= 0 || (bid as number) > 10000)) {
    return bad("bid_invalid");
  }

  // ---- bind validation against LION's own data (cached 10 min) ----
  let data;
  try {
    data = await lionProfileData(profile);
  } catch (e) {
    const lionSide = e instanceof LionError && (e.status === undefined || e.status < 500);
    return bad(lionSide ? "profile_invalid" : `lion_unreachable: ${(e as Error).message}`, lionSide ? 400 : 502);
  }
  const acct = data.accounts.find((a) => a.id === account);
  if (!acct) return bad("account_not_on_profile");
  if (acct.status !== 1) return bad("account_disabled");
  if (!data.pages.some((p) => p.id === page)) return bad("page_not_on_profile");
  let pixels;
  try {
    pixels = await lionAccountPixels(profile, account);
  } catch (e) {
    return bad(`lion_unreachable: ${(e as Error).message}`, 502);
  }
  if (!pixels.some((p) => p.id === pixel)) return bad("pixel_not_on_account");

  // ---- submit ----
  try {
    const result = await lionDuplicate({
      profile_slug: profile,
      account_id: account,
      page_id: page,
      pixel_id: pixel,
      campaign_id: campaignId,
      starting_budget: Math.round(budget * 100),
      number_of_copies: copies,
      name_suffix: nameSuffix,
      ...(bid != null ? { starting_bid: bid } : {}),
      ...(name ? { name } : {}),
    });
    const taskIds = (result.task_ids ?? []).map(String).filter(Boolean);
    if ((result.result === "success" || taskIds.length > 0) && taskIds.length > 0) {
      return NextResponse.json({ ok: true, taskIds, currency: acct.currency || "USD" });
    }
    // Preflight rejection — LION's reason is the actionable text ("No valid creative URL found
    // in campaign ads" = object-story source → not duplicable; dead/unreadable source; …).
    return bad(result.reason || `LION rejected the duplicate (${result.result ?? "no result"})`);
  } catch (e) {
    // 404 plain-text bodies ("Page not found in account data", "Pixel not found for account")
    // surface verbatim — they are the actionable reason, not a transport failure.
    const status = e instanceof LionError && e.status && e.status < 500 ? 400 : 502;
    return bad(`lion_duplicate_failed: ${(e as Error).message}`, status);
  }
}
