// Server-only. Owners manage the team's logins from the launcher — /users (owner ask 20.10: "роль
// овнер могла управлять акаунтами, например добавлять новый акаунт дизайнера или овнера или же
// удалять или редактировать … в менюшках соответствующих сделай такой функционал"). Until then a login
// was only ever made or changed by hand (scripts/add-user, set-password, rename-user).
//
// The directory is this deployment's `up_users` (lib/team toolsDirectory): the first team's is the
// shared tools directory — the same accounts as Amazon Tools — every later team's is its own.
//
//   • the fields (pure): a name, a password, an e-mail, a role — what may be stored;
//   • what an owner may NOT do (pure, adminRefusal): delete / block / demote / sign out their own login,
//     or take the team's last active owner away — the team can never lock itself out;
//   • the store: create / edit / delete a login, and everything filed under its NAME follows a rename
//     (account assignments, task and queue rows, templates, held registry keys — the same moves as
//     scripts/rename-user.mjs) or a deletion (its account assignments go: an account it held alone is
//     visible to everyone again). The launch history stays.
//
// Sessions: a block, a deletion, a new password and "sign out everywhere" end the login's open sessions
// within seconds — lib/session-live reads `blocked` / the user / `sessions_valid_after` on every
// proxied request. A rename or a role change re-issues the cookie in place (no sign-out).
//
// Relative `.ts` imports: `node --test` loads this straight from disk.

import { createHash } from "node:crypto";
import { hash } from "bcryptjs";
import type { Document } from "mongodb";
import { coll } from "./mongo.ts";
import { APP_CACHES, LAUNCH_TASKS, STORE_TIMEOUT_MS, UP_USERS, bounded, dupKeyField, insertFresh } from "./store.ts";
import { LAUNCH_JOBS } from "./launch-queue-store.ts";
import { LAUNCH_TEMPLATES } from "./template-store.ts";
import { BCRYPT_COST } from "./auth-users.ts";
import { isOwnerIdentity } from "./roles.ts";
import { TEAM, type TeamId } from "./team.ts";
import type { NewUserInput, UserPatch } from "./user-fields.ts";

export * from "./user-fields.ts";

// ---- the e-mail a login nobody typed one for ---------------------------------------------------------

/** The address a login nobody typed an e-mail for carries — `email` is UNIQUE and not sparse, so every
 *  row needs one. Byte-for-byte what scripts/add-user.mjs makes (usernames are exact: "Alex" and "alex"
 *  are two people, so the address carries a short hash of the name as typed). */
export function placeholderEmail(username: string, team: TeamId = TEAM.id): string {
  const slug = username.toLowerCase().replace(/[^a-z0-9._-]+/g, ".").replace(/^\.+|\.+$/g, "") || "user";
  const tag = createHash("sha256").update(username).digest("hex").slice(0, 6);
  return `${slug}.${tag}@${team}.adlauncher.local`;
}

export const isPlaceholderEmail = (email: unknown): boolean => typeof email === "string" && email.endsWith(".adlauncher.local");

// ---- what an owner may not do ---------------------------------------------------------------------

export type RosterEntry = { id: number; username: string; role: string | null; blocked: boolean };

export type AdminChange = UserPatch & { delete?: boolean };

export type AdminRefusal = "self_delete" | "self_block" | "self_demote" | "self_sign_out" | "last_owner";

/**
 * Why this change may not be made, or null. An owner never deletes, blocks, demotes or signs out
 * their OWN login (they would lock themselves out mid-change), and the team always keeps one active
 * owner — whoever does it. `roster` is the whole directory as it is now.
 */
export function adminRefusal(actor: { id: number; username: string }, target: RosterEntry, change: AdminChange, roster: readonly RosterEntry[]): AdminRefusal | null {
  const wasOwner = isOwnerIdentity(target.username, target.role);
  const staysOwner = change.role === undefined ? wasOwner : isOwnerIdentity(target.username, change.role);
  if (actor.id === target.id) {
    if (change.delete) return "self_delete";
    if (change.blocked === true) return "self_block";
    if (wasOwner && !staysOwner) return "self_demote";
    if (change.signOutEverywhere) return "self_sign_out";
  }
  const takesOwnerAway = wasOwner && !target.blocked && (Boolean(change.delete) || change.blocked === true || !staysOwner);
  if (takesOwnerAway) {
    const others = roster.filter((r) => r.id !== target.id && !r.blocked && isOwnerIdentity(r.username, r.role));
    if (others.length === 0) return "last_owner";
  }
  return null;
}

// ---- account assignments follow the login ------------------------------------------------------------

const sameName = (a: unknown, b: unknown): boolean => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

/** The /accounts map with `oldName` replaced by `newName` (letter case ignored, as /accounts compares). */
export function renameInAssignments(accounts: Record<string, string[]>, oldName: string, newName: string): { accounts: Record<string, string[]>; touched: number } {
  const out: Record<string, string[]> = {};
  let touched = 0;
  for (const [acct, list] of Object.entries(accounts)) {
    if (!Array.isArray(list) || !list.some((u) => sameName(u, oldName))) {
      out[acct] = list;
      continue;
    }
    touched++;
    const next: string[] = [];
    for (const u of list.map((x) => (sameName(x, oldName) ? newName : x))) if (!next.some((y) => sameName(y, u))) next.push(u);
    out[acct] = next;
  }
  return { accounts: out, touched };
}

/** The /accounts map without `name`; an account left with nobody is visible to everyone again (freed). */
export function dropFromAssignments(accounts: Record<string, string[]>, name: string): { accounts: Record<string, string[]>; touched: number; freed: number } {
  const out: Record<string, string[]> = {};
  let touched = 0;
  let freed = 0;
  for (const [acct, list] of Object.entries(accounts)) {
    if (!Array.isArray(list) || !list.some((u) => sameName(u, name))) {
      out[acct] = list;
      continue;
    }
    touched++;
    const next = list.filter((u) => !sameName(u, name));
    if (next.length) out[acct] = next;
    else freed++;
  }
  return { accounts: out, touched, freed };
}

// ---- the store --------------------------------------------------------------------------------------

/** A login as /users shows it — never the hash, never a placeholder e-mail. */
export type ManagedUser = {
  id: number;
  username: string;
  role: string | null;
  /** Counts as an owner (lib/roles — the role, or ADL_OWNER_USERS). */
  owner: boolean;
  blocked: boolean;
  email: string | null;
  /** false: a migrated login that has not signed in since the move (no hash stored yet). */
  hasPassword: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  createdBy: string | null;
};

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === "string" && v ? v : null);

function managedUserOf(doc: Document): ManagedUser {
  const username = String(doc.username ?? "");
  const role = doc.app_role == null ? null : String(doc.app_role);
  return {
    id: Number(doc.id),
    username,
    role,
    owner: isOwnerIdentity(username, role),
    blocked: Boolean(doc.blocked),
    email: typeof doc.email === "string" && !isPlaceholderEmail(doc.email) ? doc.email : null,
    hasPassword: typeof doc.password === "string" && doc.password.length > 0,
    createdAt: iso(doc.createdAt),
    updatedAt: iso(doc.updatedAt),
    createdBy: typeof doc.created_by === "string" ? doc.created_by : null,
  };
}

const USER_PROJECTION = {
  _id: 0,
  id: 1,
  documentId: 1,
  username: 1,
  email: 1,
  app_role: 1,
  blocked: 1,
  password: 1,
  former_usernames: 1,
  createdAt: 1,
  updatedAt: 1,
  created_by: 1,
} as const;

const exactly = (s: string): RegExp => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");

/** Every login of the directory, by name. Throws on a store failure. */
export async function listManagedUsers(): Promise<ManagedUser[]> {
  const c = await coll(UP_USERS);
  const docs = await bounded(c.find({}, { projection: USER_PROJECTION, maxTimeMS: STORE_TIMEOUT_MS }).limit(1000).toArray(), "users list");
  return docs.map(managedUserOf).sort((a, b) => a.username.localeCompare(b.username, undefined, { sensitivity: "base" }));
}

/** The roster adminRefusal judges against. Throws on a store failure. */
export async function readRoster(): Promise<RosterEntry[]> {
  return (await listManagedUsers()).map((u) => ({ id: u.id, username: u.username, role: u.role, blocked: u.blocked }));
}

/** One login, as /users shows it, or null. Throws on a store failure. */
export async function findManagedUser(id: number): Promise<ManagedUser | null> {
  const c = await coll(UP_USERS);
  const doc = await bounded(c.findOne({ id: { $in: [id, String(id)] } }, { projection: USER_PROJECTION, maxTimeMS: STORE_TIMEOUT_MS }), "user read");
  if (!doc) return null;
  return managedUserOf(doc);
}

async function userDoc(id: number): Promise<Document | null> {
  const c = await coll(UP_USERS);
  return bounded(c.findOne({ id: { $in: [id, String(id)] } }, { projection: USER_PROJECTION, maxTimeMS: STORE_TIMEOUT_MS }), "user read");
}

/** Is the name somebody's — now or before (a former name still signs in) — in any letter case? */
async function nameTaken(name: string, exceptDocumentId: string | null = null): Promise<boolean> {
  const c = await coll(UP_USERS);
  const filter: Document = { $or: [{ username: exactly(name) }, { former_usernames: exactly(name) }] };
  if (exceptDocumentId) filter.documentId = { $ne: exceptDocumentId };
  return Boolean(await bounded(c.findOne(filter, { projection: { _id: 1 }, maxTimeMS: STORE_TIMEOUT_MS }), "user read"));
}

async function emailTaken(email: string, exceptDocumentId: string | null = null): Promise<boolean> {
  const c = await coll(UP_USERS);
  const filter: Document = { email };
  if (exceptDocumentId) filter.documentId = { $ne: exceptDocumentId };
  return Boolean(await bounded(c.findOne(filter, { projection: { _id: 1 }, maxTimeMS: STORE_TIMEOUT_MS }), "user read"));
}

/** Launches of this login waiting or running in the queue — the queue runs them under its name. */
async function activeJobs(username: string): Promise<number> {
  const jobs = await coll(LAUNCH_JOBS);
  return bounded(jobs.countDocuments({ owner: username, status: { $in: ["queued", "running"] } }, { maxTimeMS: STORE_TIMEOUT_MS }), "queue read");
}

/** On the shared tools directory a login carries the users-permissions role Strapi gave every account
 *  ("Authenticated") — Amazon Tools reads the same rows; copied from an existing login. */
async function toolsRoleRelation(): Promise<Document> {
  if (!TEAM.toolsDirectory) return {};
  const c = await coll(UP_USERS);
  const row = await bounded(c.findOne({ "role.type": "authenticated" }, { projection: { _id: 0, role: 1 }, maxTimeMS: STORE_TIMEOUT_MS }), "user read");
  return row?.role ? { role: row.role } : {};
}

export type CreateResult = { ok: true; user: ManagedUser } | { ok: false; error: "username_taken" | "email_taken" };

/** Add a login. Throws on a store failure. */
export async function createManagedUser(input: NewUserInput, actor: string): Promise<CreateResult> {
  if (await nameTaken(input.username)) return { ok: false, error: "username_taken" };
  if (input.email && (await emailTaken(input.email))) return { ok: false, error: "email_taken" };
  const email = input.email ?? placeholderEmail(input.username);
  let doc: Document;
  try {
    doc = await insertFresh(UP_USERS, {
      username: input.username,
      email,
      provider: "local",
      confirmed: true,
      blocked: false,
      app_role: input.role,
      password: await hash(input.password, BCRYPT_COST),
      source: "launcher",
      created_by: actor,
      ...(await toolsRoleRelation()),
    });
  } catch (e) {
    const field = dupKeyField(e);
    if (field === "username") return { ok: false, error: "username_taken" };
    if (field === "email") return { ok: false, error: "email_taken" };
    throw e;
  }
  return { ok: true, user: managedUserOf(doc) };
}

export type MovedCounts = { accounts: number; tasks: number; jobs: number; templates: number; held: number };

export type UpdateResult =
  | { ok: true; user: ManagedUser; moved?: MovedCounts }
  | { ok: false; error: "not_found" | "username_taken" | "email_taken" }
  | { ok: false; error: "user_busy"; busy: number };

const ACCT_ASSIGN_KEY = "fb-acct-assignments"; // = lib/acct-assignments (that module imports through "@/")

/** Rewrite the /accounts registry row with `edit`, guarded on it not having moved since it was read
 *  (/accounts writes the whole row) — re-read and retried a few times. Answers what `edit` reported. */
async function editAssignments<R extends { accounts: Record<string, string[]>; touched: number }>(
  edit: (accounts: Record<string, string[]>) => R,
  actor: string,
): Promise<R | null> {
  const caches = await coll(APP_CACHES);
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await bounded(caches.findOne({ ckey: ACCT_ASSIGN_KEY }, { maxTimeMS: STORE_TIMEOUT_MS }), "assignments read");
    const accounts = row?.cvalue?.accounts && typeof row.cvalue.accounts === "object" ? (row.cvalue.accounts as Record<string, string[]>) : {};
    const result = edit(accounts);
    if (!row || result.touched === 0) return result;
    const r = await bounded(
      caches.updateOne(
        { _id: row._id, "cvalue.updatedAt": row.cvalue?.updatedAt ?? null },
        { $set: { "cvalue.accounts": result.accounts, "cvalue.updatedAt": Date.now(), "cvalue.updatedBy": actor, refreshed_at: Date.now(), updatedAt: new Date() } },
      ),
      "assignments update",
    );
    if (r.matchedCount > 0) return result;
  }
  return null;
}

/** Everything filed under a login's name moves to its new one — the moves of scripts/rename-user. */
async function moveUserData(oldName: string, newName: string, actor: string): Promise<MovedCounts> {
  const assigned = await editAssignments((a) => renameInAssignments(a, oldName, newName), actor);
  if (!assigned) throw new Error("the account assignments kept changing — the login was renamed, its accounts were not moved; rename it again");
  const caches = await coll(APP_CACHES);
  const tasks = await coll(LAUNCH_TASKS);
  const jobs = await coll(LAUNCH_JOBS);
  const templates = await coll(LAUNCH_TEMPLATES);
  const held = await bounded(caches.updateMany({ "cvalue.user": oldName }, { $set: { "cvalue.user": newName, updatedAt: new Date() } }), "held keys update");
  const ownTasks = await bounded(tasks.updateMany({ owner: oldName }, { $set: { owner: newName } }), "tasks update");
  const ownJobs = await bounded(jobs.updateMany({ owner: oldName, status: { $nin: ["queued", "running"] } }, { $set: { owner: newName } }), "queue update");
  const ownTemplates = await bounded(templates.updateMany({ owner: oldName }, { $set: { owner: newName } }), "templates update");
  await bounded(templates.updateMany({ updated_by: oldName }, { $set: { updated_by: newName } }), "templates update");
  return {
    accounts: assigned.touched,
    tasks: ownTasks.modifiedCount,
    jobs: ownJobs.modifiedCount,
    templates: ownTemplates.modifiedCount,
    held: held.modifiedCount,
  };
}

/**
 * Change a login. A rename is refused while the login has launches in the queue (they run under its
 * name) and onto a name somebody has or had; the OLD name does not keep signing in (owner 15.10 on
 * Taras → Tarass: "старое Taras работать не должно"). A new password or signOutEverywhere ends the
 * login's open sessions. Throws on a store failure.
 */
export async function updateManagedUser(id: number, patch: UserPatch, actor: string): Promise<UpdateResult> {
  const c = await coll(UP_USERS);
  const doc = await userDoc(id);
  if (!doc) return { ok: false, error: "not_found" };
  const oldName = String(doc.username ?? "");
  const set: Document = { updatedAt: new Date(), updated_by: actor };

  const renaming = patch.username !== undefined && patch.username !== oldName;
  if (renaming) {
    const newName = patch.username as string;
    if (await nameTaken(newName, String(doc.documentId))) return { ok: false, error: "username_taken" };
    const busy = await activeJobs(oldName);
    if (busy > 0) return { ok: false, error: "user_busy", busy };
    set.username = newName;
    const former = Array.isArray(doc.former_usernames) ? (doc.former_usernames as unknown[]).map(String) : null;
    if (former && former.some((n) => sameName(n, newName))) set.former_usernames = former.filter((n) => !sameName(n, newName));
    // A placeholder address follows the name it was made from.
    if (patch.email === undefined && isPlaceholderEmail(doc.email)) set.email = placeholderEmail(newName);
  }
  if (patch.email !== undefined) {
    const email = patch.email ?? (isPlaceholderEmail(doc.email) && !renaming ? String(doc.email) : placeholderEmail(String(set.username ?? oldName)));
    if (email !== doc.email) {
      if (patch.email && (await emailTaken(email, String(doc.documentId)))) return { ok: false, error: "email_taken" };
      set.email = email;
    }
  }
  if (patch.role !== undefined) set.app_role = patch.role;
  if (patch.blocked !== undefined) set.blocked = patch.blocked;
  if (patch.password !== undefined) set.password = await hash(patch.password, BCRYPT_COST);
  if (patch.password !== undefined || patch.signOutEverywhere) set.sessions_valid_after = Math.floor(Date.now() / 1000);

  try {
    await bounded(c.updateOne({ documentId: doc.documentId }, { $set: set }), "user update");
  } catch (e) {
    const field = dupKeyField(e);
    if (field === "username") return { ok: false, error: "username_taken" };
    if (field === "email") return { ok: false, error: "email_taken" };
    throw e;
  }
  const moved = renaming ? await moveUserData(oldName, String(set.username), actor) : undefined;
  const fresh = await userDoc(id);
  if (!fresh) return { ok: false, error: "not_found" };
  return moved ? { ok: true, user: managedUserOf(fresh), moved } : { ok: true, user: managedUserOf(fresh) };
}

export type DeleteResult =
  | { ok: true; username: string; accounts: number; freed: number }
  | { ok: false; error: "not_found" }
  | { ok: false; error: "user_busy"; busy: number };

/**
 * Delete a login: refused while it has launches in the queue; it leaves the account assignments first
 * (an account it held alone becomes visible to everyone), then the directory. Its launch history,
 * templates and task rows stay. Throws on a store failure.
 */
export async function deleteManagedUser(id: number, actor = "launcher"): Promise<DeleteResult> {
  const c = await coll(UP_USERS);
  const doc = await userDoc(id);
  if (!doc) return { ok: false, error: "not_found" };
  const username = String(doc.username ?? "");
  const busy = await activeJobs(username);
  if (busy > 0) return { ok: false, error: "user_busy", busy };
  const dropped = await editAssignments((a) => dropFromAssignments(a, username), actor);
  if (!dropped) throw new Error("the account assignments kept changing — nothing was deleted; try again");
  await bounded(c.deleteOne({ documentId: doc.documentId }), "user delete");
  return { ok: true, username, accounts: dropped.touched, freed: dropped.freed };
}
