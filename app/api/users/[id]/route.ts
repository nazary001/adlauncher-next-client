import { NextResponse } from "next/server";
import { SESSION_COOKIE, SESSION_TTL_SEC, sessionCookieOptions, signSession } from "@/lib/session";
import { forgetLiveUser } from "@/lib/session-live";
import { bustAssignmentsCache } from "@/lib/acct-assignments";
import { ownerGate, unavailable } from "@/lib/user-admin-gate";
import { adminRefusal, deleteManagedUser, parseUserPatch, readRoster, updateManagedUser, type AdminChange } from "@/lib/user-admin";

export const runtime = "nodejs";

/**
 * One login of the team, by its directory id — owner-only (lib/user-admin-gate).
 *
 * PATCH  { username?, password?, role?, blocked?, email?, signOutEverywhere? } → { ok, user, moved? }
 * DELETE → { ok, username, accounts, freed }
 *
 * 403 self_delete / self_block / self_demote / self_sign_out / last_owner (lib/user-admin adminRefusal —
 * the team never locks itself out) · 404 not_found · 409 username_taken / email_taken / user_busy (the
 * login has launches in the queue) · 400 <field error> · 502 store_unavailable.
 * The changed login's sessions follow within seconds (lib/session-live); this instance forgets its
 * remembered answer at once. An owner who changes their OWN password gets a fresh cookie here — the
 * new password ends every older session, theirs included.
 */
type Ctx = { params: Promise<{ id: string }> };

const parseId = (raw: string | undefined): number | null => (raw && /^\d{1,12}$/.test(raw) ? Number(raw) : null);
const refused = (error: string, status: number, extra: Record<string, unknown> = {}) => NextResponse.json({ ok: false, error, ...extra }, { status });

async function targetOf(ctx: Ctx, change: AdminChange, actor: { id: number; username: string }) {
  const id = parseId((await ctx.params).id);
  if (id === null) return { refuse: refused("bad_id", 400) };
  let roster;
  try {
    roster = await readRoster();
  } catch (e) {
    return { refuse: unavailable(e) };
  }
  const target = roster.find((r) => r.id === id);
  if (!target) return { refuse: refused("not_found", 404) };
  const why = adminRefusal(actor, target, change, roster);
  if (why) return { refuse: refused(why, 403) };
  return { id };
}

export async function PATCH(req: Request, ctx: Ctx) {
  const g = await ownerGate(req);
  if ("refuse" in g) return g.refuse;
  const parsed = parseUserPatch(await req.json().catch(() => null));
  if (!parsed.ok) return refused(parsed.error, 400);
  const t = await targetOf(ctx, parsed.patch, g.actor);
  if ("refuse" in t) return t.refuse;
  try {
    const r = await updateManagedUser(t.id, parsed.patch, g.actor.username);
    forgetLiveUser(t.id);
    if (!r.ok) return NextResponse.json(r, { status: r.error === "not_found" ? 404 : 409 });
    if (r.moved) bustAssignmentsCache();
    const out = NextResponse.json({ ok: true, user: r.user, ...(r.moved ? { moved: r.moved } : {}) });
    if (t.id === g.actor.id) {
      // Their own login: a fresh cookie under what the directory says now (a new password voided the old one).
      const { sub, email } = g.session;
      out.cookies.set(SESSION_COOKIE, signSession({ sub, username: r.user.username, email, role: r.user.role }), sessionCookieOptions(SESSION_TTL_SEC));
    }
    return out;
  } catch (e) {
    forgetLiveUser(t.id);
    return unavailable(e);
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  const g = await ownerGate(req);
  if ("refuse" in g) return g.refuse;
  const t = await targetOf(ctx, { delete: true }, g.actor);
  if ("refuse" in t) return t.refuse;
  try {
    const r = await deleteManagedUser(t.id, g.actor.username);
    forgetLiveUser(t.id);
    if (!r.ok) return NextResponse.json(r, { status: r.error === "not_found" ? 404 : 409 });
    bustAssignmentsCache();
    return NextResponse.json(r);
  } catch (e) {
    forgetLiveUser(t.id);
    return unavailable(e);
  }
}
