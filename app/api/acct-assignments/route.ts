import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { isOwnerSession } from "@/lib/roles";
import { patchAssignments, readAssignments } from "@/lib/acct-assignments";

export const runtime = "nodejs";

/**
 * Owner-only FB account→users assignment registry (feeds the /accounts page).
 *
 * GET  → { ok, accounts: { "<acctDigits>": ["user", …] }, updatedAt?, updatedBy? }
 * PUT  → body { set: { "<acctId>": ["user", …] } } — merge patch; an EMPTY list clears the
 *        account back to "visible to everyone". Answers with the updated map.
 *
 * Non-owners get 403 — the pickers never call this; their filtering happens server-side inside
 * the account-catalog routes (lib/acct-assignments.filterAccountsFor).
 */
export async function GET(req: Request) {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!isOwnerSession(session)) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  const row = await readAssignments();
  if (!row) return NextResponse.json({ ok: false, error: "store_unavailable" }, { status: 502 });
  return NextResponse.json({
    ok: true,
    accounts: row.data.accounts,
    updatedAt: row.data.updatedAt ?? null,
    updatedBy: row.data.updatedBy ?? null,
  });
}

export async function PUT(req: Request) {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!isOwnerSession(session)) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as { set?: Record<string, unknown> } | null;
  const rawSet = body?.set;
  if (!rawSet || typeof rawSet !== "object" || Array.isArray(rawSet)) {
    return NextResponse.json({ ok: false, error: "set_required" }, { status: 400 });
  }
  const set: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(rawSet)) {
    if (!Array.isArray(v)) return NextResponse.json({ ok: false, error: "bad_set" }, { status: 400 });
    set[k] = v.map((u) => String(u ?? "").trim()).filter(Boolean);
  }
  if (Object.keys(set).length === 0) {
    return NextResponse.json({ ok: false, error: "empty_set" }, { status: 400 });
  }

  const updated = await patchAssignments(set, session.username);
  if (!updated) return NextResponse.json({ ok: false, error: "store_unavailable" }, { status: 502 });
  return NextResponse.json({ ok: true, accounts: updated.accounts, updatedAt: updated.updatedAt ?? null });
}
