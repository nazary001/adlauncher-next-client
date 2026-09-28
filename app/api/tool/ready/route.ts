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
 *   { ok, ready, reason?, message?, accounts: string[] (bare digits), rows: {id,name,currency}[], live }
 * where `live` is the TOOL-visible count BEFORE the partner filter (so the UI can say "TOOL sees N
 * but none of yours"), and `rows` (owner ask 28.09) carries the same ids as `accounts`, in the same
 * order, with their TOOL-side name + currency so the card can label the picker by cabinet name.
 * Never cached (Cache-Control: no-store).
 */
type ReadyRow = { id: string; name: string; currency: string };

export async function GET(req: Request) {
  const noStore = { headers: { "Cache-Control": "no-store" } };
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401, headers: noStore.headers });

  const params = new URL(req.url).searchParams;
  const partner = sanitizePartnerId(params.get("partner"));
  const rail = railParam(params.get("rail"));

  // AV NOW launches through TOOL (owner ask 28.09: "сделай чтобы лаунчер оттуда кабинеты тянул") —
  // AV has no FB token yet, but a live TOOL session sees its ActiveView cabinets, which carry the
  // NAME prefix GC-AV-. So AV's account axis here is the TOOL-visible accounts named GC-AV-… (no
  // partner catalog to intersect — TOOL is AV's only account source), then the buyer's assignment
  // filter. Clones still can NOT run through TOOL: a clone must READ the source campaign, and only
  // the AV token can do that (TOOL sessions are the HS team's, they cannot see AV's source).
  if (partner === "av") {
    if (rail === "clone") {
      return NextResponse.json(
        {
          ok: true,
          ready: false,
          reason: "not_available",
          message: "AV clones read the source campaign with the AV token — add it on /tokens (TOOL cannot read sources)",
          accounts: [],
          rows: [],
          live: 0,
        },
        noStore,
      );
    }
    const readyAv = await toolLaunchReady();
    if (!readyAv.ok) {
      return NextResponse.json({ ok: true, ready: false, reason: readyAv.reason, message: readyAv.message, accounts: [], rows: [], live: 0 }, noStore);
    }
    const liveAv = readyAv.accounts.length;
    const avAccounts = readyAv.accounts.filter((a) => /^GC-AV-/i.test(String(a.name ?? "").trim()));
    const avFiltered = await filterAccountsFor(session, avAccounts.map((a) => a.account_id), (id) => id);
    if (avFiltered.length === 0) {
      if (avAccounts.length === 0) {
        // TOOL is up and sees accounts, but none are AV's cabinets — an owner adds a session that does.
        return NextResponse.json(
          {
            ok: true,
            ready: false,
            reason: "no_live_session",
            message: `TOOL sees ${liveAv} live account${liveAv === 1 ? "" : "s"} but none of AV's (GC-AV-…) — an owner adds a TOOL session that sees AV's cabinets on Ads Manager sessions`,
            accounts: [],
            rows: [],
            live: liveAv,
          },
          noStore,
        );
      }
      return NextResponse.json(
        { ok: true, ready: false, message: "None of TOOL's live AV accounts are assigned to you — pick one of yours on /accounts", accounts: [], rows: [], live: liveAv },
        noStore,
      );
    }
    const avById = new Map(avAccounts.map((a) => [a.account_id, a]));
    const avRows: ReadyRow[] = avFiltered.map((id) => {
      const a = avById.get(id);
      return { id, name: a?.name ?? "", currency: a?.currency ?? "" };
    });
    return NextResponse.json({ ok: true, ready: true, accounts: avFiltered, rows: avRows, live: liveAv }, noStore);
  }

  const ready = await toolLaunchReady();
  if (!ready.ok) {
    // Key / scope / reachability / no-live-session — all before any partner catalog work.
    return NextResponse.json({ ok: true, ready: false, reason: ready.reason, message: ready.message, accounts: [], rows: [], live: 0 }, noStore);
  }
  const live = ready.accounts.length;
  const liveIds = ready.accounts.map((a) => a.account_id); // bare digits (toAccount strips act_)
  // rows (owner ask 28.09) carry the TOOL-side name + currency of each returned id, same order.
  const acctById = new Map(ready.accounts.map((a) => [a.account_id, a]));
  const rowsFor = (ids: string[]): ReadyRow[] =>
    ids.map((id) => {
      const a = acctById.get(id);
      return { id, name: a?.name ?? "", currency: a?.currency ?? "" };
    });

  // The partner's own catalog ids (null = HS: no catalog intersection here). A catalog read that
  // cannot resolve a signer / token is a config verdict — surface it as not-ready with the reason.
  let catalogIds: string[] | null = null;
  if (partner === "in") {
    const signer = await resolveMoSigner(rail);
    if (!signer.ok) {
      return NextResponse.json(
        { ok: true, ready: false, reason: "no_live_session", message: `MO launch token is not assigned on /tokens (${signer.error}) — TOOL still needs the MO catalog to map its accounts`, accounts: [], rows: [], live },
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
        { ok: true, ready: false, reason: "no_live_session", message: `AIF token is not assigned on /tokens (${r.error}) — TOOL still needs the AIF catalog to map its accounts`, accounts: [], rows: [], live },
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
          rows: [],
          live,
        },
        noStore,
      );
    }
    // Overlap exists (or HS) but none of it is assigned to this buyer.
    return NextResponse.json(
      { ok: true, ready: false, message: "None of TOOL's live accounts are assigned to you — pick one of yours on /accounts", accounts: [], rows: [], live },
      noStore,
    );
  }

  return NextResponse.json({ ok: true, ready: true, accounts: filtered, rows: rowsFor(filtered), live }, noStore);
}
