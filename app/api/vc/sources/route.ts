import { NextResponse } from "next/server";
import { FbError } from "@/lib/fb-graph";
import { vcCloneRail, vcRailEnabled } from "@/lib/vc-launch";
import { VC_SOURCE_FIELDS, type VcCloneSource, vcCloneSourceOf } from "@/lib/vc-clone";
import { filterAccountsFor } from "@/lib/acct-assignments";
import { sessionFromCookieHeader } from "@/lib/session";

export const runtime = "nodejs";
// One paged Graph read per VC cabinet (21 on 05.11, ~0.5 s each) — well inside the window.
export const maxDuration = 60;

type Json = Record<string, unknown>;
const PAGE = 50;
const MAX_PAGES = 20;
const noStore = { headers: { "Cache-Control": "no-store" } };

/** Cabinet order: numeric by name (GC-for-VC-BR-742 … -762), then the campaign's birth. */
function order(a: VcCloneSource, b: VcCloneSource): number {
  return a.accountName.localeCompare(b.accountName, "en", { numeric: true }) || a.createdTime.localeCompare(b.createdTime) || a.campaignId.localeCompare(b.campaignId);
}

/**
 * GET /api/vc/sources[?ids=<campaignId>,…]
 *
 * The VC clone board's sources (owner ask 05.11): every ACTIVE campaign on the VC cabinets the clone
 * signer holds (the owner's VC · Clones token, else VC · Launches — lib/vc-launch vcCloneRail) that the
 * buyer is assigned to; or, with `ids`, exactly those campaigns (a deep link) — each must live on such a
 * cabinet. Every tree is ONE Graph read (lib/vc-clone VC_SOURCE_FIELDS) mapped by vcCloneSourceOf. Also
 * the cabinets with their pixels (the board warns where the picked pixel is not shared) and the signer.
 * Degrades quietly (ok:false, 200) without a token; real API failures carry their mapped status.
 */
export async function GET(req: Request) {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!vcRailEnabled()) return NextResponse.json({ ok: false, error: "vc_rail_disabled" }, { status: 404 });
  const r = await vcCloneRail();
  if (!r.ok) return NextResponse.json({ ok: false, reason: "no_token", error: r.error, sources: [], accounts: [] }, noStore);
  const rail = r.rail;

  const url = new URL(req.url);
  const ids = [
    ...new Set(
      (url.searchParams.get("ids") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => /^\d{5,}$/.test(s)),
    ),
  ];
  if (ids.length > 50) return NextResponse.json({ ok: false, error: "too_many_ids", max: 50 }, { status: 400 });

  try {
    // Owner assignments: a non-owner sees only the cabinets assigned to them (unassigned = shared).
    const accounts = await filterAccountsFor(session, await rail.tokenAdAccounts(), (a) => a.id);
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const sources: VcCloneSource[] = [];
    const failed: string[] = [];
    const failures: Record<string, string> = {};
    if (ids.length) {
      for (const id of ids) {
        try {
          const tree = await rail.fbGet(`${id}?fields=${encodeURIComponent(VC_SOURCE_FIELDS)}`);
          const src = vcCloneSourceOf(tree);
          const acct = byId.get(src.accountId);
          if (!acct) {
            failed.push(id);
            failures[id] = `not on a VC cabinet of the clone signer (act_${src.accountId || "?"})`;
            continue;
          }
          sources.push({ ...src, accountName: acct.name });
        } catch (e) {
          const err = e as FbError;
          if (err.status === 429) throw err; // rate-limited → abort the whole read
          failed.push(id);
          failures[id] = String(err.message ?? e).slice(0, 300);
        }
      }
    } else {
      for (const acct of accounts) {
        let after = "";
        for (let page = 0; page < MAX_PAGES; page++) {
          const body = await rail.fbGet(
            `act_${acct.id}/campaigns?effective_status=${encodeURIComponent('["ACTIVE"]')}&limit=${PAGE}&fields=${encodeURIComponent(VC_SOURCE_FIELDS)}${after ? `&after=${encodeURIComponent(after)}` : ""}`,
          );
          for (const tree of (Array.isArray(body.data) ? body.data : []) as Json[]) sources.push(vcCloneSourceOf(tree, acct.name));
          const paging = (body.paging ?? {}) as Json;
          after = String(((paging.cursors ?? {}) as Json).after ?? "");
          if (!paging.next || !after) break;
        }
      }
    }
    sources.sort(order);
    return NextResponse.json(
      { ok: true, sources, accounts: accounts.map((a) => ({ id: a.id, name: a.name, pixels: a.pixels })), signer: rail.label, failed, failures },
      noStore,
    );
  } catch (e) {
    const err = e as FbError;
    return NextResponse.json({ ok: false, reason: "api", error: err.message ?? String(e), sources: [], accounts: [] }, { status: err.status === 429 ? 429 : 502 });
  }
}
