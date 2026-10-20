import { NextResponse } from "next/server";
import { TEAM } from "@/lib/team";
import { ownerGate, unavailable } from "@/lib/user-admin-gate";
import { createManagedUser, listManagedUsers, parseNewUser } from "@/lib/user-admin";

export const runtime = "nodejs";

/**
 * Team logins (owner ask 20.10) — the team's user directory, owner-only (lib/user-admin-gate).
 *
 * GET  → { ok, users: ManagedUser[], me: <the acting login's id>, team: { label, sharedDirectory } }
 *        `sharedDirectory`: the logins are the shared tools directory (the Amazon Tools accounts).
 * POST { username, password, role?, email? } → 201 { ok, user }
 *        400 <field error> · 409 username_taken / email_taken · 502 store_unavailable
 */
export async function GET(req: Request) {
  const g = await ownerGate(req);
  if ("refuse" in g) return g.refuse;
  try {
    const users = await listManagedUsers();
    return NextResponse.json(
      { ok: true, users, me: g.actor.id, team: { label: TEAM.label, sharedDirectory: TEAM.toolsDirectory } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return unavailable(e);
  }
}

export async function POST(req: Request) {
  const g = await ownerGate(req);
  if ("refuse" in g) return g.refuse;
  const parsed = parseNewUser(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  try {
    const r = await createManagedUser(parsed.input, g.actor.username);
    if (!r.ok) return NextResponse.json(r, { status: 409 });
    return NextResponse.json({ ok: true, user: r.user }, { status: 201 });
  } catch (e) {
    return unavailable(e);
  }
}
