#!/usr/bin/env node
// Owner tooling: give someone a login on THIS launcher — add a user to its own directory (`up_users`
// of MONGODB_DB) or update one that is already there. This is how logins are handed out on a team
// whose launcher keeps its own user list (lib/team.ts `toolsDirectory: false`); the first team's
// users are the shared tools directory instead, and get passwords through set-password.mjs.
//
//   npm run add-user -- <username> --password '<password>' [--role owner|designer] [--email <e-mail>]
//   NEW_PASSWORD='<password>' node scripts/add-user.mjs <username>
//   node scripts/add-user.mjs <username>              (prompts for the password on the terminal)
//   npm run add-user -- <username> --block            (login refused from now on)   ·   --unblock
//   npm run add-user -- --list                        (who can log in here)
//
// Reads MONGODB_URI / MONGODB_DB / NEXT_PUBLIC_ADL_TEAM from the environment or .env.local — run it
// from the launcher's own folder so it lands in that team's database (lib/mongo.ts refuses the wrong
// one). Prints no secrets. The hash is bcrypt cost 10, the same as every other stored password.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

if (!process.env.MONGODB_URI) {
  for (const f of [".env.local", ".env"]) {
    const p = path.resolve(process.cwd(), f);
    if (existsSync(p)) {
      process.loadEnvFile(p);
      break;
    }
  }
}
if (!process.env.MONGODB_URI) {
  console.error("MONGODB_URI is not set (env or .env.local)");
  process.exit(2);
}

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const VALUE_FLAGS = new Set(["--password", "--role", "--email"]);
const username = args.find((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(args[i - 1]));

// The lib modules read the team from the environment when they load — import them only now.
const { TEAM } = await import("../lib/team.ts");
const { coll, getClient } = await import("../lib/mongo.ts");
const { UP_USERS, insertFresh } = await import("../lib/store.ts");
const { BCRYPT_COST } = await import("../lib/auth-users.ts");
const { hash } = await import("bcryptjs");

const where = `${process.env.MONGODB_DB || "gc"}.${UP_USERS} (${TEAM.label})`;

/** Does the work and answers the process exit code (the connection is closed by the caller). */
async function main() {
  const c = await coll(UP_USERS);

  if (flag("list")) {
    const rows = await c.find({}, { projection: { _id: 0, username: 1, app_role: 1, blocked: 1, password: 1 } }).sort({ username: 1 }).toArray();
    console.log(`${rows.length} user(s) in ${where}:`);
    for (const r of rows) {
      const marks = [r.app_role || "no role", r.blocked ? "BLOCKED" : null, typeof r.password === "string" && r.password ? null : "no password yet"].filter(Boolean);
      console.log(`  ${r.username}  —  ${marks.join(", ")}`);
    }
    return 0;
  }

  if (!username) {
    console.error("usage: node scripts/add-user.mjs <username> [--password <password>] [--role owner|designer] [--email <e-mail>] [--block|--unblock]   |   --list");
    return 2;
  }
  if (username !== username.trim() || username.length > 60) {
    console.error("the username may not start or end with a space, and is at most 60 characters");
    return 2;
  }

  const existing = await c.findOne({ username }, { projection: { _id: 0, documentId: 1 } });

  if (flag("block") || flag("unblock")) {
    if (!existing) {
      console.error(`no user named "${username}" in ${where} (usernames are exact, case-sensitive)`);
      return 1;
    }
    await c.updateOne({ username }, { $set: { blocked: flag("block"), updatedAt: new Date() } });
    console.log(`${username}: ${flag("block") ? "blocked — the login is refused from now on" : "unblocked"} in ${where}`);
    return 0;
  }

  const role = value("role");
  let password = value("password") ?? process.env.NEW_PASSWORD;
  // An existing user may be given just a new role; a new one always needs a password.
  if (!password && !(existing && role)) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    password = (await rl.question(`Password for ${username}: `)).trim();
    rl.close();
  }
  if (password !== undefined && password.length < 6) {
    console.error("the password must be at least 6 characters");
    return 2;
  }

  if (existing) {
    const set = { updatedAt: new Date() };
    if (password) set.password = await hash(password, BCRYPT_COST);
    if (role) set.app_role = role;
    await c.updateOne({ username }, { $set: set });
    console.log(`${username}: updated in ${where} —${[password ? " new password" : "", role ? ` role ${role}` : ""].filter(Boolean).join(",")}`);
    return 0;
  }

  // The directory's own claim indexes (idempotent — ensure-indexes creates the same ones): without
  // them two users could share a name. E-mail is UNIQUE and not sparse, so every user carries one;
  // a login nobody types an e-mail for gets a placeholder that can never collide with a real address
  // — nor with another user's: usernames are exact ("Alex" and "alex" are two people), so the
  // placeholder carries a short hash of the username as it was typed.
  await c.createIndex({ username: 1 }, { unique: true });
  await c.createIndex({ email: 1 }, { unique: true });
  const slug = username.toLowerCase().replace(/[^a-z0-9._-]+/g, ".").replace(/^\.+|\.+$/g, "") || "user";
  const tag = createHash("sha256").update(username).digest("hex").slice(0, 6);
  const email = (value("email") ?? `${slug}.${tag}@${TEAM.id}.adlauncher.local`).trim().toLowerCase();
  const doc = await insertFresh(UP_USERS, {
    username,
    email,
    provider: "local",
    confirmed: true,
    blocked: false,
    app_role: role || "designer",
    password: await hash(password, BCRYPT_COST),
    source: "add-user",
  });
  console.log(`${username}: added to ${where} — role ${doc.app_role}, id ${doc.id}`);
  return 0;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error(`failed: ${e?.message ?? e}`);
} finally {
  await (await getClient().catch(() => null))?.close();
}
process.exit(code);
