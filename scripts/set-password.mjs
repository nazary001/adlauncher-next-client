#!/usr/bin/env node
// Owner tooling: set (or reset) a user's password directly in `up_users` — the way to give a password
// to a user whose bcrypt hash never left Strapi (no `password` field after the migration) once the old
// Strapi is gone, or to reset anyone's password without an admin UI.
//
//   npm run set-password -- <username> --password '<new password>'
//   NEW_PASSWORD='<new password>' node scripts/set-password.mjs <username>
//   node scripts/set-password.mjs <username>            (prompts on the terminal)
//
// Reads MONGODB_URI / MONGODB_DB from the environment or .env.local. Prints no secrets. The hash is
// bcrypt cost 10 — exactly what Strapi stored, so a migrated and a reset user look the same.
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
const username = args.find((a) => !a.startsWith("--"));
const flagIx = args.indexOf("--password");
let password = flagIx >= 0 ? args[flagIx + 1] : process.env.NEW_PASSWORD;
if (!username) {
  console.error("usage: node scripts/set-password.mjs <username> [--password <new password>]");
  process.exit(2);
}
if (!password) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  password = (await rl.question(`New password for ${username}: `)).trim();
  rl.close();
}
if (!password || password.length < 6) {
  console.error("password must be at least 6 characters (Strapi's minimum)");
  process.exit(2);
}

const { setUserPassword } = await import("../lib/auth-users.ts");
const { getClient } = await import("../lib/mongo.ts");
try {
  const ok = await setUserPassword(username, password);
  if (!ok) {
    console.error(`no user named "${username}" in ${process.env.MONGODB_DB || "gc"}.up_users (usernames are exact, case-sensitive)`);
    process.exit(1);
  }
  console.log(`password set for ${username} (bcrypt, cost 10) in ${process.env.MONGODB_DB || "gc"}.up_users`);
} finally {
  await (await getClient()).close();
}
