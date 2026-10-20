// Server-only. Who may use the Team logins API (/api/users — lib/user-admin): an owner, as the
// DIRECTORY has them right now — the cookie's role is only the first filter. The acting login must
// still exist, must not be blocked and must still be an owner, so an owner demoted or blocked a moment
// ago cannot change anybody's login on a cookie that has not caught up yet.

import { NextResponse } from "next/server";
import { sessionFromCookieHeader, type Session } from "@/lib/session";
import { isOwnerSession } from "@/lib/roles";
import { storeConfigured } from "@/lib/store";
import { liveIdOf } from "@/lib/session-live";
import { findManagedUser, type ManagedUser } from "@/lib/user-admin";

export const unavailable = (e?: unknown) =>
  NextResponse.json({ ok: false, error: "store_unavailable", message: e instanceof Error ? e.message : undefined }, { status: 502 });

export type OwnerGate = { refuse: NextResponse } | { session: Session; actor: ManagedUser };

export async function ownerGate(req: Request): Promise<OwnerGate> {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return { refuse: NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 }) };
  if (!isOwnerSession(session)) return { refuse: NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 }) };
  if (!storeConfigured()) return { refuse: unavailable() };
  const id = liveIdOf(session.sub);
  if (id === null) return { refuse: NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 }) };
  let actor: ManagedUser | null;
  try {
    actor = await findManagedUser(id);
  } catch (e) {
    return { refuse: unavailable(e) };
  }
  if (!actor || actor.blocked || !actor.owner) return { refuse: NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 }) };
  return { session, actor };
}
