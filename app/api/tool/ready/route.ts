import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { sanitizePartnerId } from "@/lib/partners";
import { railParam, resolveMoSigner } from "@/lib/mo-soc";
import { aifRail } from "@/lib/aif-launch";
import { tokenAdAccounts } from "@/lib/fb-graph";
import { filterAccountsFor } from "@/lib/acct-assignments";
import { toolLaunchReady } from "@/lib/tool-run";

export const runtime = "nodejs";
// The MO/AIF catalog read is a paginated Graph sweep (warm from cache); the TOOL /accounts + /me
// reads are cached 60s in tool-run.
export const maxDuration = 60;

/**
 * GET /api/tool/ready?partner=br|in|us[&rail=launch|clone]
 *
 * Is the TOOL launch channel ready FOR THIS PARTNER AND THIS BUYER (owner ask 28.09)? TOOL is
 * "ready" only when: the server has the key + the right scopes + ≥1 live account (toolLaunchReady),
 * AND at least one of those live accounts is also in this partner's own catalog AND assigned to the
 * buyer. Pages / pixels / locales still come from the partner's own catalog (TOOL has no page/pixel
 * list) — this endpoint only settles the ACCOUNT axis + the readiness verdict.
 *
 *   MO (in):  TOOL accounts ∩ the rail signer's token accounts ∩ filterAccountsFor(session).
 *   AIF (us): TOOL accounts ∩ the rail token's accounts ∩ filterAccountsFor(session).
 *   HS (br):  TOOL accounts ∩ filterAccountsFor(session) — the per-profile intersection happens in
 *             the card/board (LION profile bind space), not here.
 *
 * Any session (buyers launch through TOOL — NOT owner-gated). Response:
 *   { ok, ready, reason?, message?, accounts: string[] (bare digits), live: number }
 * where `live` is the TOOL-visible count BEFORE the partner filter (so the UI can say "TOOL sees N
 * but none of yours"). Never cached (Cache-Control: no-store).
 */
export async function GET(req: Request) {
  const noStore = { headers: { "Cache-Control": "no-store" } };
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401, headers: noStore.headers });

  const params = new URL(req.url).searchParams;
  const partner = sanitizePartnerId(params.get("partner"));
  const rail = railParam(params.get("rail"));

  // AV has NO TOOL channel: its cabinets live on AV's own FB token, the TOOL sessions are the HS
  // team's Ads Manager sessions. Without this the partner would fall into the HS branch below
  // (catalogIds null = "every live TOOL account") and report ready with the HS team's accounts.
  if (partner === "av") {
    return NextResponse.json(
      { ok: true, ready: false, reason: "not_available", message: "AV launches only on the AV token — TOOL is the HS team's Ads Manager sessions", accounts: [], live: 0 },
      noStore,
    );
  }

  const ready = await toolLaunchReady();
  if (!ready.ok) {
    // Key / scope / reachability / no-live-session — all before any partner catalog work.
    return NextResponse.json({ ok: true, ready: false, reason: ready.reason, message: ready.message, accounts: [], live: 0 }, noStore);
  }
  const live = ready.accounts.length;
  const liveIds = ready.accounts.map((a) => a.account_id); // bare digits (toAccount strips act_)

  // The partner's own catalog ids (null = HS: no catalog intersection here). A catalog read that
  // cannot resolve a signer / token is a config verdict — surface it as not-ready with the reason.
  let catalogIds: string[] | null = null;
  if (partner === "in") {
    const signer = await resolveMoSigner(rail);
    if (!signer.ok) {
      return NextResponse.json(
        { ok: true, ready: false, reason: "no_live_session", message: `MO launch token is not assigned on /tokens (${signer.error}) — TOOL still needs the MO catalog to map its accounts`, accounts: [], live },
        noStore,
      );
    }
    try {
      catalogIds = (await tokenAdAccounts(signer.signer.cat)).map((a) => a.id);
    } catch {
      catalogIds = [];
    }
  } else if (partner === "us") {
    const r = await aifRail(rail);
    if (!r.ok) {
      return NextResponse.json(
        { ok: true, ready: false, reason: "no_live_session", message: `AIF token is not assigned on /tokens (${r.error}) — TOOL still needs the AIF catalog to map its accounts`, accounts: [], live },
        noStore,
      );
    }
    try {
      catalogIds = (await r.rail.tokenAdAccounts()).map((a) => a.id);
    } catch {
      catalogIds = [];
    }
  }

  // TOOL ∩ partner catalog, then the owner's per-buyer assignment filter. HS has no cheap catalog
  // (LION lists accounts per profile only), so its axis is the HS cabinet NAME — every HS account is
  // "GC-HS-…" (302/302 on glo-01). Without it a TOOL session carrying ANOTHER partner's cabinets
  // (av-01 → GC-AV-LA-*, live 28.09) lit the HS TOOL segment with 11 accounts that no LION profile
  // holds — an enabled rail with an empty picker. The card still intersects with the profile.
  const canon = (id: string): string => String(id).replace(/^act_/, "");
  const intersected =
    catalogIds === null
      ? ready.accounts.filter((a) => /^GC-HS-/i.test(String(a.name ?? "").trim())).map((a) => a.account_id)
      : (() => {
          const cat = new Set(catalogIds.map(canon));
          return liveIds.filter((id) => cat.has(id));
        })();
  const filtered = await filterAccountsFor(session, intersected, (id) => id);

  if (filtered.length === 0) {
    // Two distinct causes → two distinct, actionable sentences.
    const label = partner === "in" ? "MO" : partner === "us" ? "AIF" : "HS";
    if (intersected.length === 0) {
      // TOOL has live accounts, but none overlap this partner's cabinets (e.g. 28.09 the only live
      // session carries ActiveView cabinets) — not-ready until a session seeing this partner's is added.
      return NextResponse.json(
        {
          ok: true,
          ready: false,
          reason: "no_live_session",
          message: `TOOL sees ${live} live account${live === 1 ? "" : "s"} but none of ${label}'s — an owner adds a TOOL session that sees ${label}'s cabinets on Ads Manager sessions`,
          accounts: [],
          live,
        },
        noStore,
      );
    }
    // Overlap exists (or HS) but none of it is assigned to this buyer.
    return NextResponse.json(
      { ok: true, ready: false, message: "None of TOOL's live accounts are assigned to you — pick one of yours on /accounts", accounts: [], live },
      noStore,
    );
  }

  return NextResponse.json({ ok: true, ready: true, accounts: filtered, live }, noStore);
}
