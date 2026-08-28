import { NextResponse } from "next/server";
import { FbError, hasFbToken, tokenAdAccounts } from "@/lib/fb-graph";
import { resolveMoChannel } from "@/lib/mo-soc";
import { filterAccountsFor } from "@/lib/acct-assignments";
import { sessionFromCookieHeader } from "@/lib/session";

export const runtime = "nodejs";
// Cold refresh = paginated account list + one pixels call per account; warm calls answer from
// the shared cache instantly.
export const maxDuration = 60;

/**
 * GET /api/adaccounts[?channel=soc:<name>]
 *
 * ACTIVE ad accounts the launch token can use, each with its pixel list — feeds the account
 * picker (and its per-account pixel picker) on the launcher. The launch route validates the
 * picked account/pixel against the same server-cached data. Gated by the proxy.
 *
 * `channel` picks the signer the catalog is read from: absent/system = the MO system-user
 * token, `soc:<name>` = that personal token from FB_MO_SOC_TOKENS (own cache identity —
 * a soc may see a different account set than the system user).
 *
 * Degrades quietly (ok:false, 200) when the token is absent; real API failures return their
 * mapped status (429 rate-limited / 502 otherwise).
 */
export async function GET(req: Request) {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const channel = resolveMoChannel(new URL(req.url).searchParams.get("channel"));
  if (!channel) return NextResponse.json({ ok: false, reason: "channel_unknown", accounts: [] });
  if (channel.kind === "system" && !hasFbToken()) {
    return NextResponse.json({ ok: false, reason: "no_token", accounts: [] });
  }
  try {
    // Owner assignments: a non-owner sees only accounts assigned to them (unassigned = shared).
    const accounts = await filterAccountsFor(
      session,
      await tokenAdAccounts(channel.kind === "soc" ? channel.cat : undefined),
      (a) => a.id,
    );
    return NextResponse.json({ ok: true, accounts });
  } catch (e) {
    const err = e as FbError;
    return NextResponse.json(
      { ok: false, reason: "api", error: err.message ?? String(e), accounts: [] },
      { status: err.status === 429 ? 429 : 502 },
    );
  }
}
