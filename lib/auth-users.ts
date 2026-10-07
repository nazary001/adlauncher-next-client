// Server-only. The user directory (`up_users` — the same users as amazon-tools, migrated from the
// tools Strapi's users-permissions) and the login check with LAZY PASSWORD MIGRATION: Strapi's REST
// never exposed the bcrypt hashes, so a migrated user has NO `password` field. On that user's first
// login the password is verified against the old Strapi (`STRAPI_TOOLS_URL`, the only Strapi env left),
// hashed with bcrypt (cost 10 — what Strapi used) and stored; every later login is local. Once Strapi is
// gone, a user without a hash gets one from the owner (`npm run set-password -- <username>`).
//
// The pure decision (`authenticateWith`) takes its I/O as arguments so `node --test` covers every
// branch without a database; `authenticateUser` wires the real store.

import { compare, hash } from "bcryptjs";
import type { Document } from "mongodb";
import { coll } from "./mongo.ts";
import { STORE_TIMEOUT_MS, UP_USERS, bounded, storeConfigured } from "./store.ts";

/** Strapi hashed with bcrypt at this cost; new hashes match it. */
export const BCRYPT_COST = 10;

export type AppUser = {
  id: number;
  documentId: string;
  username: string;
  email: string | null;
  app_role: string | null;
  blocked: boolean;
  /** bcrypt hash, absent/null for a migrated user who has not logged in since the move. */
  password?: string | null;
};

export type AuthResult =
  | { ok: true; user: AppUser; migrated: boolean }
  | { ok: false; reason: "invalid" | "blocked" | "unavailable" };

export type LegacyVerdict = "ok" | "invalid" | "unavailable";

export type AuthDeps = {
  /** The user by username (exact) or e-mail (lower-cased) — null when none, throws when the store fails. */
  findUser: (identifier: string) => Promise<AppUser | null>;
  verifyHash: (password: string, hash: string) => Promise<boolean>;
  hashPassword: (password: string) => Promise<string>;
  /** Store a freshly made hash (best-effort: a failure here does not fail the login). */
  storeHash: (user: AppUser, hash: string) => Promise<void>;
  /** The old Strapi `/api/auth/local`, null when the fallback is not configured. */
  legacyLogin: ((identifier: string, password: string) => Promise<LegacyVerdict>) | null;
};

/**
 * The login decision. Hash present → bcrypt.compare. No hash → the old Strapi decides; on its "ok" the
 * password is hashed and stored (the migration), on "invalid" the login is refused, on "unavailable"
 * (Strapi down / not configured) the caller answers 502, never 401 — a reachable-later Strapi must not
 * read as a wrong password. A blocked user is refused before any password check, as Strapi did.
 */
export async function authenticateWith(identifier: string, password: string, deps: AuthDeps): Promise<AuthResult> {
  let user: AppUser | null;
  try {
    user = await deps.findUser(identifier);
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (!user) return { ok: false, reason: "invalid" };
  if (user.blocked) return { ok: false, reason: "blocked" };

  if (typeof user.password === "string" && user.password.length > 0) {
    const good = await deps.verifyHash(password, user.password);
    return good ? { ok: true, user, migrated: false } : { ok: false, reason: "invalid" };
  }

  if (!deps.legacyLogin) return { ok: false, reason: "unavailable" };
  const verdict = await deps.legacyLogin(identifier, password);
  if (verdict !== "ok") return { ok: false, reason: verdict };
  const hashed = await deps.hashPassword(password);
  try {
    await deps.storeHash(user, hashed);
  } catch {
    /* the next login migrates again */
  }
  return { ok: true, user: { ...user, password: hashed }, migrated: true };
}

// ---- real I/O ---------------------------------------------------------------------------------

const USER_PROJECTION = { _id: 0, id: 1, documentId: 1, username: 1, email: 1, app_role: 1, blocked: 1, password: 1 } as const;

function userOf(doc: Document | null): AppUser | null {
  if (!doc?.documentId) return null;
  return {
    id: Number(doc.id),
    documentId: String(doc.documentId),
    username: String(doc.username ?? ""),
    email: doc.email == null ? null : String(doc.email),
    app_role: doc.app_role == null ? null : String(doc.app_role),
    blocked: Boolean(doc.blocked),
    password: typeof doc.password === "string" ? doc.password : null,
  };
}

/** Strapi's users-permissions lookup: `identifier` is the e-mail (compared lower-cased) OR the exact
 *  username. Throws on a store failure. */
export async function findUserByIdentifier(identifier: string): Promise<AppUser | null> {
  const c = await coll(UP_USERS);
  const doc = await bounded(
    c.findOne({ $or: [{ email: identifier.toLowerCase() }, { username: identifier }] }, { projection: USER_PROJECTION, maxTimeMS: STORE_TIMEOUT_MS }),
    "user read",
  );
  return userOf(doc);
}

async function storeUserHash(user: AppUser, hashed: string): Promise<void> {
  const c = await coll(UP_USERS);
  await bounded(c.updateOne({ documentId: user.documentId }, { $set: { password: hashed, updatedAt: new Date() } }), "user update");
}

/** POST {identifier, password} to the old tools Strapi. 2xx with a user → ok; a 4xx → invalid; a
 *  network error / 5xx / no answer in 8 s → unavailable. */
export function legacyStrapiLogin(baseUrl: string) {
  const base = baseUrl.replace(/\/+$/, "");
  return async (identifier: string, password: string): Promise<LegacyVerdict> => {
    try {
      const res = await fetch(`${base}/api/auth/local`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as { user?: unknown };
        return data?.user ? "ok" : "invalid";
      }
      return res.status >= 500 ? "unavailable" : "invalid";
    } catch {
      return "unavailable";
    }
  };
}

/** The production login: the store + bcrypt + the Strapi fallback while `STRAPI_TOOLS_URL` is set. */
export async function authenticateUser(identifier: string, password: string): Promise<AuthResult> {
  if (!storeConfigured()) return { ok: false, reason: "unavailable" };
  const tools = (process.env.STRAPI_TOOLS_URL ?? "").trim();
  return authenticateWith(identifier, password, {
    findUser: findUserByIdentifier,
    verifyHash: (pw, h) => compare(pw, h),
    hashPassword: (pw) => hash(pw, BCRYPT_COST),
    storeHash: storeUserHash,
    legacyLogin: tools ? legacyStrapiLogin(tools) : null,
  });
}

/** Owner tooling (scripts/set-password.mjs mirrors this): set a user's password directly. True when the
 *  user exists and the hash landed. */
export async function setUserPassword(username: string, password: string): Promise<boolean> {
  const c = await coll(UP_USERS);
  const hashed = await hash(password, BCRYPT_COST);
  const r = await bounded(c.updateOne({ username }, { $set: { password: hashed, updatedAt: new Date() } }), "user update");
  return r.matchedCount > 0;
}

export type DirectoryUser = { username: string; app_role: string | null; blocked: boolean };

/** The roster for /api/team (non-PII fields only). Throws on a store failure. */
export async function listDirectoryUsers(limit = 300): Promise<DirectoryUser[]> {
  const c = await coll(UP_USERS);
  const docs = await bounded(
    c.find({}, { projection: { _id: 0, username: 1, app_role: 1, blocked: 1 }, maxTimeMS: STORE_TIMEOUT_MS }).limit(limit).toArray(),
    "users list",
  );
  return docs.map((d) => ({ username: String(d.username ?? ""), app_role: d.app_role == null ? null : String(d.app_role), blocked: Boolean(d.blocked) }));
}
