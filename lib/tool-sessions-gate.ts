// Server-only. The one gate every /api/tool-sessions/* route passes: a valid app session AND the
// owner role (lib/roles). Non-owners get 403 — the TOOL key signs for the whole HS team, so only
// an owner may drive it. Also turns a TOOL failure into our JSON error shape (status carried over,
// message verbatim — TOOL's sentences are already meant for a human).

import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { isOwnerSession } from "@/lib/roles";
import type { ToolFailure } from "@/lib/tool-sessions";

export function ownerGate(req: Request): { username: string } | NextResponse {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!isOwnerSession(session)) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  return { username: session.username };
}

/** A TOOL failure → our answer. Upstream 4xx keep their status (the owner mistyped something,
 *  the key lost a scope, the session is gone); 5xx / unreachable become 502 so a client can
 *  tell "TOOL is down" from "our route broke". */
export function toolError(f: ToolFailure): NextResponse {
  const status = f.error === "not_configured" ? 500 : f.status >= 500 || f.status === 0 ? 502 : f.status;
  return NextResponse.json({ ok: false, error: f.error, message: f.message, field: f.field ?? null, problems: f.problems ?? null, upstream: f.status }, { status });
}
