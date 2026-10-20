// Server-only. Is the login behind a session cookie still what the cookie says? (owner ask 20.10:
// owners add, edit and delete logins from the launcher — /users.) The cookie is signed once at sign-in
// and lives up to 30 days; without this a DELETED or BLOCKED login kept launching on it, a password the
// owner changed because it leaked kept its old sessions, and a role change only reached the cookie at
// the next sign-in. proxy.ts asks here on every proxied request, /api/auth/session on every tab's ask.
//
// The directory (`up_users`) is read by the session's `sub` (the user's numeric id) and the answer is
// remembered per instance for LIVE_TTL_MS, so a launcher full of polling tabs costs one read per user
// per instance per TTL — never one per request. The directory not answering (down, slow, not
// configured) changes NOTHING: the cookie stands, exactly as before this file existed. Only a definite
// answer revokes: no such user, blocked, or a cookie older than the owner's "sign out everywhere".
//
// Relative `.ts` imports: proxy.ts bundles this, and `node --test` loads it straight from disk.

import type { Session } from "./session.ts";
import { coll } from "./mongo.ts";
import { STORE_TIMEOUT_MS, UP_USERS, bounded, storeConfigured } from "./store.ts";

/** What the directory says about a login, as far as its sessions are concerned. */
export type LiveUser = {
  username: string;
  role: string | null;
  blocked: boolean;
  /** Epoch seconds: sessions signed in BEFORE this are void (set when the owner changes the password). */
  sessionsValidAfter: number | null;
};

export type RevokeReason = "gone" | "blocked" | "signed_out";

export type LiveVerdict =
  | { kind: "ok" }
  /** The login was deleted / blocked / signed out everywhere — the cookie must go. */
  | { kind: "revoked"; reason: RevokeReason }
  /** The login is fine but is called something else now, or has another role — re-issue the cookie. */
  | { kind: "refresh"; username: string; role: string | null };

/** A directory answer is remembered this long per instance. */
export const LIVE_TTL_MS = 15_000;
/** A failed read is remembered this long (the cookie stands meanwhile) — a down store is not hammered. */
export const LIVE_FAIL_TTL_MS = 10_000;
/** The proxy never waits longer than this for the directory; past it the cookie stands. */
export const LIVE_READ_TIMEOUT_MS = 1_500;

const sameRole = (a: string | null | undefined, b: string | null | undefined): boolean =>
  String(a ?? "").trim() === String(b ?? "").trim();

/**
 * The decision, pure. `live`: the directory's user (null = no such user, undefined = the directory
 * cannot say right now).
 */
export function judgeLiveSession(s: Session, live: LiveUser | null | undefined): LiveVerdict {
  if (live === undefined) return { kind: "ok" };
  if (live === null) return { kind: "revoked", reason: "gone" };
  if (live.blocked) return { kind: "revoked", reason: "blocked" };
  if (live.sessionsValidAfter !== null && (s.iat ?? 0) < live.sessionsValidAfter) return { kind: "revoked", reason: "signed_out" };
  const role = live.role === null || live.role.trim() === "" ? null : live.role;
  if (live.username !== s.username || !sameRole(role, s.role)) return { kind: "refresh", username: live.username, role };
  return { kind: "ok" };
}

/** The directory id a session's `sub` names, or null when it names none (then nothing is checked). */
export function liveIdOf(sub: string | number | null | undefined): number | null {
  const id = typeof sub === "number" ? sub : typeof sub === "string" && /^\d+$/.test(sub) ? Number(sub) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** The real read: the user by id (a migrated row may keep its id as a string — both are asked). */
async function loadLiveUser(id: number): Promise<LiveUser | null> {
  const c = await coll(UP_USERS);
  const doc = await c.findOne(
    { id: { $in: [id, String(id)] } },
    { projection: { _id: 0, username: 1, app_role: 1, blocked: 1, sessions_valid_after: 1 }, maxTimeMS: STORE_TIMEOUT_MS },
  );
  if (!doc) return null;
  const after = Number(doc.sessions_valid_after);
  return {
    username: String(doc.username ?? "").trim(),
    role: doc.app_role == null ? null : String(doc.app_role),
    blocked: Boolean(doc.blocked),
    sessionsValidAfter: Number.isFinite(after) && after > 0 ? after : null,
  };
}

type Remembered = { at: number; ttl: number; user: LiveUser | null | undefined };
const remembered = new Map<number, Remembered>();
const inflight = new Map<number, Promise<LiveUser | null | undefined>>();

/** Forget one user (this instance re-reads them on the next request) — called after an owner's change. */
export function forgetLiveUser(id: number): void {
  remembered.delete(id);
}

/** Forget everybody (tests). */
export function forgetLiveUsers(): void {
  remembered.clear();
  inflight.clear();
}

/**
 * The directory's answer for a user id, remembered per instance: a LiveUser, null (no such user) or
 * undefined (the directory could not answer in `timeoutMs`). Never throws.
 */
export async function readLiveUser(
  id: number,
  load: (id: number) => Promise<LiveUser | null> = loadLiveUser,
  now: number = Date.now(),
  timeoutMs: number = LIVE_READ_TIMEOUT_MS,
): Promise<LiveUser | null | undefined> {
  const hit = remembered.get(id);
  if (hit && now - hit.at < hit.ttl) return hit.user;
  const pending = inflight.get(id);
  if (pending) return pending;
  const read = (async (): Promise<LiveUser | null | undefined> => {
    let user: LiveUser | null | undefined;
    try {
      user = await bounded(load(id), "session check", timeoutMs);
    } catch {
      user = undefined;
    }
    remembered.set(id, { at: now, ttl: user === undefined ? LIVE_FAIL_TTL_MS : LIVE_TTL_MS, user });
    return user;
  })();
  inflight.set(id, read);
  try {
    return await read;
  } finally {
    inflight.delete(id);
  }
}

/** What the directory says about this session right now (see judgeLiveSession). Never throws.
 *  ADL_SESSION_LIVE=off turns the check off — ONLY for a local bench whose scripts sign their own
 *  cookies for logins that are not in its database (_e2e/*: sub 1 / 2 / 3); never set it on a deploy. */
export async function liveSessionVerdict(s: Session): Promise<LiveVerdict> {
  if (process.env.ADL_SESSION_LIVE === "off") return { kind: "ok" };
  const id = liveIdOf(s.sub);
  if (id === null || !storeConfigured()) return { kind: "ok" };
  const user = await readLiveUser(id);
  return judgeLiveSession(s, user);
}
