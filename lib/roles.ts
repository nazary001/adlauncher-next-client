// Server-only. Owner-role gate for the account-access feature (menu, /accounts page, the
// assignment API and the picker filters). The role string comes from the tools-Strapi user
// field `app_role`, stamped into the session AT LOGIN — changing a role in Strapi takes
// effect on that user's next login.
//
// Both knobs are env-overridable so a mismatched role string never needs a code change:
//   ADL_OWNER_ROLES  — comma-separated app_role values that count as owner (default "owner,admin")
//   ADL_OWNER_USERS  — comma-separated usernames granted owner regardless of role (bootstrap /
//                      fallback while app_role isn't set in Strapi yet)

import type { Session } from "@/lib/session";

const csv = (v: string | undefined, fallback: string): Set<string> =>
  new Set(
    (v ?? fallback)
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

const OWNER_ROLES = csv(process.env.ADL_OWNER_ROLES, "owner,admin");
const OWNER_USERS = csv(process.env.ADL_OWNER_USERS, "");

/** Does a login with this name and directory role count as an owner? (The session check below and
 *  lib/user-admin's "the team keeps one owner" rule read the same two knobs.) */
export function isOwnerIdentity(username: string | null | undefined, role: string | null | undefined): boolean {
  const r = String(role ?? "").trim().toLowerCase();
  if (r && OWNER_ROLES.has(r)) return true;
  return OWNER_USERS.has(String(username ?? "").trim().toLowerCase());
}

export function isOwnerSession(s: Session | null | undefined): boolean {
  if (!s) return false;
  return isOwnerIdentity(s.username, s.role);
}
