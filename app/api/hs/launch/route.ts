import { NextResponse } from "next/server";
import type { Campaign } from "@/lib/types";
import { hsCampaignError, hsCountryCodes, hsCreatePayload, todaySaoPauloDDMM } from "@/lib/hs-launch";
import { reportPagesUsed } from "@/lib/hs-pages";
import { sessionFromCookieHeader } from "@/lib/session";
import { stampHsTaskRow } from "@/lib/task-store";
import { AcctLimitedError, acctKey, claimAcctSlot, releaseAcctSlot } from "@/lib/acct-limit";
import { ACCOUNT_NOT_ASSIGNED_MSG, accountAllowedFor } from "@/lib/acct-assignments";
import {
  LION_ACR,
  LionError,
  lionAccountPixels,
  lionConfigured,
  lionCreateCampaign,
  lionProfileData,
} from "@/lib/lion";

export const runtime = "nodejs";
// One create POST + (cold) profile-data reads — LION lags at times, keep headroom.
export const maxDuration = 60;

const MAX_CREATIVES = 50;

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

/**
 * Submit ONE campaign to LION's create weapon. The server is authoritative for everything LION
 * validates hard: the campaign name is rebuilt here from the same pure builder the card preview
 * uses, and the profile/account/page/pixel binds are checked against LION's own catalog (cached)
 * before anything is sent — a task fired into a disabled account or a foreign page dies invisibly
 * on the weapon side, so it gets refused here instead.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) {
    return bad("unauthorized", 401);
  }
  if (!lionConfigured()) return bad("lion_not_configured", 500);

  let body: { campaign?: Campaign; creatives?: unknown; taskId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return bad("bad_json");
  }
  const taskId = typeof body.taskId === "string" && /^[\w-]{6,64}$/.test(body.taskId) ? body.taskId : null;
  const c = body.campaign;
  if (!c || typeof c !== "object") return bad("campaign_required");
  const creatives = Array.isArray(body.creatives)
    ? (body.creatives as unknown[]).filter((u): u is string => typeof u === "string")
    : [];
  if (creatives.length > MAX_CREATIVES) return bad("too_many_creatives");

  const invalid = hsCampaignError(c, creatives);
  if (invalid) return bad(invalid);
  if (!c.profile) return bad("profile_required");
  if (!c.account) return bad("account_required");
  if (!c.page) return bad("page_required");
  if (!c.pixel) return bad("pixel_required");

  // ---- bind validation against LION's own data (cached 10 min) ----
  let data;
  try {
    data = await lionProfileData(c.profile);
  } catch (e) {
    // A 4xx/empty answer means the slug isn't the token's; anything else is LION being down.
    const lionSide = e instanceof LionError && (e.status === undefined || e.status < 500);
    return bad(lionSide ? "profile_invalid" : `lion_unreachable: ${(e as Error).message}`, lionSide ? 400 : 502);
  }
  const account = data.accounts.find((a) => a.id === c.account);
  if (!account) return bad("account_not_on_profile");
  if (account.status !== 1) return bad("account_disabled");
  if (!data.pages.some((p) => p.id === c.page)) return bad("page_not_on_profile");
  let pixels;
  try {
    pixels = await lionAccountPixels(c.profile, c.account);
  } catch (e) {
    return bad(`lion_unreachable: ${(e as Error).message}`, 502);
  }
  if (!pixels.some((p) => p.id === c.pixel)) return bad("pixel_not_on_account");
  // Fire-time belt over the picker filter: /accounts assignments hold even for a crafted POST.
  if (!(await accountAllowedFor(session, c.account))) return bad(ACCOUNT_NOT_ASSIGNED_MSG, 403);

  // ---- build + submit ----
  const payload = hsCreatePayload(c, creatives, data.locales, LION_ACR, todaySaoPauloDDMM());

  // Account launch slot (5 campaigns / 30 min per ad account, every channel — owner rule
  // 2026-08-18), claimed right before the LION submit. Kept once LION accepts (a campaign will
  // exist); released on a clean LION rejection; KEPT on an ambiguous submit error — the create
  // may have landed (same exactly-once philosophy as the duplicate pump).
  let acctSlot: { documentId: string } | null = null;
  try {
    acctSlot = await claimAcctSlot(acctKey(c.account), {
      user: session.username,
      partner: "br",
      channel: "hs-lion",
      name: String(payload.campaign_name ?? ""),
      accountName: account.name || "",
    });
  } catch (e) {
    if (e instanceof AcctLimitedError) return bad(e.message, 429);
    return bad((e as Error).message ?? String(e), 503);
  }

  try {
    const result = await lionCreateCampaign({
      profile_slug: c.profile,
      account_id: c.account,
      page_id: c.page,
      pixel_id: c.pixel,
      campaign: payload,
    });
    if (result.result === "success" && result.task_id) {
      const lionTaskId = String(result.task_id);
      const name = String(payload.campaign_name);
      // Durability: record the row server-side the instant LION accepts it, so the team sees the
      // launch and its poll can resume from the LION id even if this browser closes now.
      if (taskId) {
        await stampHsTaskRow(session.username, {
          taskId,
          name,
          geo: hsCountryCodes(c.countries).join(", "),
          budget: c.budget,
          lionTaskId,
          kind: "launch",
        });
      }
      // Registry ledger, optimistically at submit: the weapon builds one ad per creative URL on
      // this fanka (fire-safe; a failed LION task is reconciled by the box's next Facebook sweep).
      await reportPagesUsed("br", [{ pageId: c.page, delta: creatives.length }]);
      return NextResponse.json({ ok: true, lionTaskId, name, currency: account.currency || "USD" });
    }
    // Per-campaign rejection — LION's reason is the actionable text (name mismatch, missing field…).
    // No campaign was created → the account slot goes back to the pool.
    await releaseAcctSlot(acctSlot.documentId);
    return bad(result.reason || `LION rejected the campaign (${result.result})`);
  } catch (e) {
    // Ambiguous outcome (network/5xx) — the create may have landed on LION, so the slot is KEPT.
    return bad(`lion_create_failed: ${(e as Error).message}`, 502);
  }
}
