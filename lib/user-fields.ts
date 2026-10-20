// What a login of the launcher may be: its name, password, e-mail and role (owner ask 20.10 — owners
// add and edit the team's logins on /users). Pure and import-free: the server's checks (lib/user-admin,
// the /api/users routes) and the /users form (components/users-board) read the same rules.

/** The roles an owner hands out from the launcher (lib/roles: "owner" opens Owner tools). */
export const USER_ROLES = ["designer", "owner"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USERNAME_MAX = 60;
export const PASSWORD_MIN = 6;
/** bcrypt reads at most 72 BYTES of a password — anything past them would be silently ignored. */
export const PASSWORD_MAX_BYTES = 72;
const EMAIL_MAX = 254;

type Check<T, E extends string> = { ok: true; value: T } | { ok: false; error: E };

export type UserFieldError =
  | "username_required"
  | "username_too_long"
  | "username_invalid"
  | "password_required"
  | "password_too_short"
  | "password_too_long"
  | "email_invalid"
  | "role_invalid"
  | "blocked_invalid";

/** A login name: trimmed, at most 60 characters, no "@" (the sign-in reads a name with "@" as an
 *  e-mail) and no control characters. Spaces inside and any alphabet are fine ("Vlad YouTube"). */
export function checkUsername(raw: unknown): Check<string, "username_required" | "username_too_long" | "username_invalid"> {
  const v = typeof raw === "string" ? raw.trim() : "";
  if (!v) return { ok: false, error: "username_required" };
  if (v.length > USERNAME_MAX) return { ok: false, error: "username_too_long" };
  if (/[@\p{Cc}]/u.test(v)) return { ok: false, error: "username_invalid" };
  return { ok: true, value: v };
}

/** A password: trimmed (the sign-in trims what is typed), 6 characters to 72 bytes. */
export function checkPassword(raw: unknown): Check<string, "password_required" | "password_too_short" | "password_too_long"> {
  const v = typeof raw === "string" ? raw.trim() : "";
  if (!v) return { ok: false, error: "password_required" };
  if (v.length < PASSWORD_MIN) return { ok: false, error: "password_too_short" };
  if (new TextEncoder().encode(v).length > PASSWORD_MAX_BYTES) return { ok: false, error: "password_too_long" };
  return { ok: true, value: v };
}

/** An e-mail: optional (empty → null), lower-cased — the sign-in compares it lower-cased. */
export function checkEmail(raw: unknown): Check<string | null, "email_invalid"> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: "email_invalid" };
  const v = raw.trim().toLowerCase();
  if (!v) return { ok: true, value: null };
  if (v.length > EMAIL_MAX || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { ok: false, error: "email_invalid" };
  return { ok: true, value: v };
}

export function checkRole(raw: unknown): Check<UserRole, "role_invalid"> {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return (USER_ROLES as readonly string[]).includes(v) ? { ok: true, value: v as UserRole } : { ok: false, error: "role_invalid" };
}

export type NewUserInput = { username: string; password: string; role: UserRole; email: string | null };

/** POST /api/users — a new login. The role defaults to designer, as scripts/add-user's does. */
export function parseNewUser(body: unknown): { ok: true; input: NewUserInput } | { ok: false; error: UserFieldError } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const username = checkUsername(b.username);
  if (!username.ok) return username;
  const password = checkPassword(b.password);
  if (!password.ok) return password;
  const role = b.role === undefined || b.role === null || b.role === "" ? ({ ok: true, value: "designer" } as const) : checkRole(b.role);
  if (!role.ok) return role;
  const email = checkEmail(b.email);
  if (!email.ok) return email;
  return { ok: true, input: { username: username.value, password: password.value, role: role.value, email: email.value } };
}

export type UserPatch = {
  username?: string;
  password?: string;
  role?: UserRole;
  blocked?: boolean;
  /** null = no real address (a placeholder is stored). */
  email?: string | null;
  /** End every open session of the login (they sign in again). */
  signOutEverywhere?: boolean;
};

/** PATCH /api/users/:id — only what is sent changes; an empty password means "keep it". */
export function parseUserPatch(body: unknown): { ok: true; patch: UserPatch } | { ok: false; error: UserFieldError | "nothing_to_change" } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const patch: UserPatch = {};
  if (b.username !== undefined) {
    const v = checkUsername(b.username);
    if (!v.ok) return v;
    patch.username = v.value;
  }
  if (b.password !== undefined && b.password !== null && b.password !== "") {
    const v = checkPassword(b.password);
    if (!v.ok) return v;
    patch.password = v.value;
  }
  if (b.role !== undefined) {
    const v = checkRole(b.role);
    if (!v.ok) return v;
    patch.role = v.value;
  }
  if (b.blocked !== undefined) {
    if (typeof b.blocked !== "boolean") return { ok: false, error: "blocked_invalid" };
    patch.blocked = b.blocked;
  }
  if (b.email !== undefined) {
    const v = checkEmail(b.email);
    if (!v.ok) return v;
    patch.email = v.value;
  }
  if (b.signOutEverywhere === true) patch.signOutEverywhere = true;
  return Object.keys(patch).length ? { ok: true, patch } : { ok: false, error: "nothing_to_change" };
}

// Letters and digits a person can read off a screen and type without guessing: no 0/O, 1/l/I.
const PASSWORD_ALPHABET = {
  lower: "abcdefghijkmnopqrstuvwxyz",
  upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  digit: "23456789",
};

/** A fresh password for a new login or a reset: 14 characters, at least one of each kind, from the
 *  platform's CSPRNG (browser or Node). */
export function generatePassword(length = 14): string {
  const all = PASSWORD_ALPHABET.lower + PASSWORD_ALPHABET.upper + PASSWORD_ALPHABET.digit;
  const pick = (set: string): string => {
    // Rejection sampling: a byte past the last full multiple of the set size would bias the pick.
    const limit = 256 - (256 % set.length);
    const b = new Uint8Array(1);
    for (;;) {
      crypto.getRandomValues(b);
      if (b[0] < limit) return set[b[0] % set.length];
    }
  };
  for (;;) {
    let out = "";
    for (let i = 0; i < length; i++) out += pick(all);
    if (/[a-z]/.test(out) && /[A-Z]/.test(out) && /[2-9]/.test(out)) return out;
  }
}
