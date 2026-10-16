#!/usr/bin/env node
// Owner tooling: give a login another name on THIS launcher — and take everything filed under the
// old one along. The console writes the login into campaign names, so a login that is not the name the
// team calls its buyer by puts two names into one campaign (owner 12.10: `Katya_M` launching "DEVICH").
//
//   npm run rename-user -- <old> <new>              (dry run: what would change, nothing is written)
//   npm run rename-user -- <old> <new> --apply
//
// What moves: the user's `username` (the old one is kept in `former_usernames`, so the buyer can still
// sign in under the name they have always typed), the account assignments of /accounts, the registry
// rows the login holds (Snapchat / AV keys, wave claims), their campaign templates and the owner of their task and queue rows —
// their history stays theirs. Campaign names already launched are NOT rewritten: they are what the
// platforms show. The buyer's open tab picks the new name up by itself (components/session-watch asks
// /api/auth/session, which re-issues the cookie) — the launcher build that has that must be live first.
//
// Refuses while the login has work in the queue, and when the new name is taken (in any letter case —
// account assignments compare names without it). Safe to run again after an interruption. Reads
// MONGODB_URI / MONGODB_DB / NEXT_PUBLIC_ADL_TEAM from the environment or .env.local — run it from the
// launcher's own folder. Prints no secrets.
import { existsSync } from "node:fs";
import path from "node:path";

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
const apply = args.includes("--apply");
const [oldName, newName] = args.filter((a) => !a.startsWith("--"));

// The lib modules read the team from the environment when they load — import them only now.
const { TEAM } = await import("../lib/team.ts");
const { coll, getClient } = await import("../lib/mongo.ts");
const { APP_CACHES, LAUNCH_TASKS, UP_USERS } = await import("../lib/store.ts");
const { LAUNCH_JOBS } = await import("../lib/launch-queue-store.ts");
const { LAUNCH_TEMPLATES } = await import("../lib/template-store.ts");

/** lib/acct-assignments ACCT_ASSIGN_KEY (that module imports through "@/", which plain node cannot). */
const ACCT_ASSIGN_KEY = "fb-acct-assignments";
const where = `${process.env.MONGODB_DB || "gc"} (${TEAM.label})`;
const same = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
const exactly = (s) => new RegExp(`^${String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");

/** Does the work and answers the process exit code (the connection is closed by the caller). */
async function main() {
  if (!oldName || !newName) {
    console.error("usage: node scripts/rename-user.mjs <old username> <new username> [--apply]");
    return 2;
  }
  if (newName !== newName.trim() || newName.length > 60) {
    console.error("the username may not start or end with a space, and is at most 60 characters");
    return 2;
  }
  if (oldName === newName) {
    console.error("the two names are the same");
    return 2;
  }

  const users = await coll(UP_USERS);
  // The user under the old name — or already under the new one, when an earlier run stopped half-way.
  const user = (await users.findOne({ username: oldName })) ?? (await users.findOne({ username: newName, former_usernames: oldName }));
  if (!user) {
    console.error(`no user named "${oldName}" in ${where} (usernames are exact, case-sensitive)`);
    return 1;
  }
  const taken = await users.findOne({ documentId: { $ne: user.documentId }, $or: [{ username: exactly(newName) }, { former_usernames: exactly(newName) }] }, { projection: { _id: 0, username: 1 } });
  if (taken) {
    console.error(`"${newName}" is taken: user "${taken.username}" has that name now or had it before`);
    return 1;
  }

  const jobs = await coll(LAUNCH_JOBS);
  const busy = await jobs.countDocuments({ owner: oldName, status: { $in: ["queued", "running"] } });
  if (busy) {
    console.error(`${oldName} has ${busy} launch(es) in the queue right now — rename when it is empty`);
    return 1;
  }

  const caches = await coll(APP_CACHES);
  const tasks = await coll(LAUNCH_TASKS);

  // Account assignments: one registry row, account → usernames. The old name gives its place to the new.
  const assign = await caches.findOne({ ckey: ACCT_ASSIGN_KEY });
  const accounts = assign?.cvalue?.accounts && typeof assign.cvalue.accounts === "object" ? assign.cvalue.accounts : {};
  const nextAccounts = {};
  let moved = 0;
  for (const [acct, list] of Object.entries(accounts)) {
    if (!Array.isArray(list) || !list.some((u) => same(u, oldName))) {
      nextAccounts[acct] = list;
      continue;
    }
    moved++;
    const out = [];
    for (const u of list.map((x) => (same(x, oldName) ? newName : x))) if (!out.some((y) => same(y, u))) out.push(u);
    nextAccounts[acct] = out;
  }

  const templates = await coll(LAUNCH_TEMPLATES);
  const ownTemplates = await templates.countDocuments({ owner: oldName });
  const held = await caches.countDocuments({ "cvalue.user": oldName });
  const ownTasks = await tasks.countDocuments({ owner: oldName });
  const ownJobs = await jobs.countDocuments({ owner: oldName });
  const renamed = user.username === newName;

  console.log(`${oldName} → ${newName} in ${where}${apply ? "" : "   (dry run — add --apply to write)"}`);
  console.log(`  user id ${user.id}: ${renamed ? "already renamed" : "username changes; the old name stays valid at sign-in"}`);
  console.log(`  account assignments: ${moved} account(s)`);
  console.log(`  registry rows held (keys, wave claims): ${held}`);
  console.log(`  task rows: ${ownTasks}   queue rows: ${ownJobs}`);
  console.log(`  campaign templates: ${ownTemplates}`);
  if (!apply) return 0;

  const now = new Date();
  if (moved) {
    // Guarded on the registry not having moved since it was read: /accounts writes the whole row.
    const r = await caches.updateOne(
      { _id: assign._id, "cvalue.updatedAt": assign.cvalue.updatedAt ?? null },
      { $set: { "cvalue.accounts": nextAccounts, "cvalue.updatedAt": Date.now(), "cvalue.updatedBy": "rename-user", refreshed_at: Date.now(), updatedAt: now } },
    );
    if (!r.matchedCount) {
      console.error("the account assignments changed while this ran — nothing was written; run it again");
      return 1;
    }
  }
  if (!renamed) {
    const former = [...new Set([...(Array.isArray(user.former_usernames) ? user.former_usernames : []), oldName])].filter((n) => n !== newName);
    await users.updateOne({ documentId: user.documentId }, { $set: { username: newName, former_usernames: former, updatedAt: now } });
  }
  if (held) await caches.updateMany({ "cvalue.user": oldName }, { $set: { "cvalue.user": newName, updatedAt: now } });
  if (ownTasks) await tasks.updateMany({ owner: oldName }, { $set: { owner: newName } });
  if (ownJobs) await jobs.updateMany({ owner: oldName, status: { $nin: ["queued", "running"] } }, { $set: { owner: newName } });
  // Templates: the creator (the one-name-per-buyer key moves with them) and the last-editor stamp.
  if (ownTemplates) await templates.updateMany({ owner: oldName }, { $set: { owner: newName } });
  await templates.updateMany({ updated_by: oldName }, { $set: { updated_by: newName } });
  console.log(`done — ${newName} can sign in as "${newName}", "${oldName}" or the e-mail; an open tab switches by itself within minutes`);
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
