#!/usr/bin/env node
// Idempotent index plan for the collections adlauncher reads and writes (CONVENTIONS §2 + the
// query patterns in docs/strapi-to-mongo/data/consumers_adlauncher.json). The migration loader creates
// the same indexes; run this after a restore or on a fresh database, and before the switch to be sure
// the UNIQUE claim indexes exist — without them two launches could share a gcm / brand / key / slot.
//
//   MONGODB_URI=... MONGODB_DB=gc node scripts/ensure-indexes.mjs        (or: npm run ensure-indexes)
//   Reads .env.local when MONGODB_URI is not in the environment. Never prints the URI.
import { MongoClient } from "mongodb";
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
const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "gc";
if (!uri) {
  console.error("MONGODB_URI is not set (env or .env.local)");
  process.exit(2);
}

const envelope = [
  { key: { id: 1 }, unique: true },
  { key: { documentId: 1 }, unique: true },
  { key: { createdAt: -1 } },
  { key: { updatedAt: -1 } },
];

/** collection → indexes (the unique ones are the claim primitives — never drop them while the app runs). */
const PLAN = {
  launch_tasks: [
    ...envelope,
    { key: { task_id: 1 }, unique: true },
    { key: { queued_at: -1 } },
    { key: { partner: 1, queued_at: -1 } },
    { key: { status: 1, createdAt: -1 } },
    { key: { campaign_id: 1 } },
    { key: { owner: 1, updatedAt: -1 } },
  ],
  app_caches: [...envelope, { key: { ckey: 1 }, unique: true }],
  gcm_maps: [...envelope, { key: { gcm: 1 }, unique: true }, { key: { status: 1 } }],
  aif_maps: [...envelope, { key: { brand: 1 }, unique: true }, { key: { status: 1 } }],
  gcm_binding_logs: [
    ...envelope,
    { key: { gcm: 1, released_at: 1, createdAt: -1 } },
    { key: { bound_at: 1 } },
    { key: { released_at: 1 } },
  ],
  mo_landing_jobs: [...envelope, { key: { status: 1, scheduled_at: 1 } }, { key: { status: 1, started_at: 1 } }],
  mo_landings: [...envelope, { key: { slug: 1 } }, { key: { lang: 1, createdAt: -1 } }, { key: { niche: 1, createdAt: -1 } }],
  up_users: [...envelope, { key: { username: 1 }, unique: true }, { key: { email: 1 }, unique: true }],
};

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000, appName: "adlauncher-ensure-indexes" });
try {
  await client.connect();
  const db = client.db(dbName);
  let created = 0;
  let failed = 0;
  for (const [name, indexes] of Object.entries(PLAN)) {
    const coll = db.collection(name);
    for (const ix of indexes) {
      try {
        await coll.createIndex(ix.key, ix.unique ? { unique: true } : {});
        created++;
      } catch (e) {
        failed++;
        // 85 IndexOptionsConflict / 86 IndexKeySpecsConflict: same key with other options — report, do not force.
        console.error(`  ! ${name} ${JSON.stringify(ix.key)}: ${e.codeName ?? e.code ?? ""} ${e.message}`);
      }
    }
    const names = (await coll.indexes()).map((i) => `${i.name}${i.unique ? "(unique)" : ""}`).join(", ");
    console.log(`${dbName}.${name}: ${names}`);
  }
  await db.collection("counters").createIndex({ seq: 1 }).catch(() => {});
  console.log(`done: ${created} ensured, ${failed} conflicts`);
  process.exit(failed ? 1 : 0);
} finally {
  await client.close();
}
