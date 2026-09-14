import { NextResponse } from "next/server";
import { FbError, tokenAdAccounts } from "@/lib/fb-graph";
import { railParam, resolveMoSigner } from "@/lib/mo-soc";
import { filterAccountsFor } from "@/lib/acct-assignments";
import { sessionFromCookieHeader } from "@/lib/session";

export const runtime = "nodejs";
// Cold refresh = paginated account list + one pixels call per account; warm calls answer from
// the shared cache instantly.
export const maxDuration = 60;

/**
 * GET /api/adaccounts[?rail=launch|clone]
 *
 * ACTIVE ad accounts the MO signer can use, each with its pixel list — feeds the account picker
 * (and its per-account pixel picker) on the launcher / clone board. The launch route validates
 * the picked account/pixel against the same server-cached data. Gated by the proxy.
 *
 * `rail` picks WHICH MO signer's catalog is read — the owner's assignment on /tokens for
 * launches (default) or clones (a different bearer may see a different account set; own cache
 * identity per bearer).
 *
 * Degrades quietly (ok:false, 200) when no token is assigned; real API failures return their
 * mapped status (429 rate-limited / 502 otherwise).
 */
export async function GET(req: Request) {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const signer = await resolveMoSigner(railParam(new URL(req.url).searchParams.get("rail")));
  if (!signer.ok) return NextResponse.json({ ok: false, reason: "no_token", error: signer.error, accounts: [] });
  try {
    // Owner assignments: a non-owner sees only accounts assigned to them (unassigned = shared).
    const accounts = await filterAccountsFor(session, await tokenAdAccounts(signer.signer.cat), (a) => a.id);
    return NextResponse.json({ ok: true, accounts, signer: signer.signer.name });
  } catch (e) {
    const err = e as FbError;
    return NextResponse.json(
      { ok: false, reason: "api", error: err.message ?? String(e), accounts: [] },
      { status: err.status === 429 ? 429 : 502 },
    );
  }
}
