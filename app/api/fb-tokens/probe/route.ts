import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { isOwnerSession } from "@/lib/roles";
import { envTokenSeeds, probeTokenIdentity, readRegistry } from "@/lib/fb-tokens";
import { tokenFingerprint } from "@/lib/fb-token-vault";
import { looksLikeFbToken, normalizeToken } from "@/lib/fb-token-registry";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/fb-tokens/probe — owner-only "Check token" step of the add flow: who is behind a
 * pasted bearer (user, FB app, expiry, scopes, how many ad accounts / ADVERTISE pages it sees)
 * BEFORE it is stored, plus whether the same bearer already sits in the vault or the env. The
 * token travels to this server once and is never echoed back or logged.
 */
export async function POST(req: Request) {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!isOwnerSession(session)) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
  const token = normalizeToken(body?.token);
  if (!looksLikeFbToken(token)) {
    return NextResponse.json({ ok: false, error: "token_invalid — paste the full access token (letters/digits only, 40+ chars)" }, { status: 400 });
  }
  const fp = tokenFingerprint(token);
  const [identity, row] = await Promise.all([probeTokenIdentity(token), readRegistry()]);
  const inVault = row?.data.tokens.find((t) => t.fp === fp)?.label ?? null;
  const inEnv = envTokenSeeds().find((s) => s.fp === fp)?.label ?? null;
  return NextResponse.json({ ok: true, identity, fp, duplicate: inVault ? { where: "vault", label: inVault } : inEnv ? { where: "env", label: inEnv } : null });
}
