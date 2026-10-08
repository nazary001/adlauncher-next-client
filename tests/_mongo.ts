// Shared setup for the LIVE store tests (tests/mongo-*.test.ts, the live halves of snap-keys /
// av-keys / auth-users). They run ONLY against the `gc_test` database on the same cluster — never
// `gc` — skip entirely when MONGODB_URI is absent (the pure tests still run), and clean up after
// themselves. Import this module FIRST in a test file: it pins MONGODB_DB before lib/mongo.ts reads it.
import { fileURLToPath } from "node:url";

if (!process.env.MONGODB_URI) {
  for (const f of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(fileURLToPath(new URL(`../${f}`, import.meta.url)));
      break;
    } catch {
      /* no env file — the live tests skip */
    }
  }
}
process.env.MONGODB_DB = "gc_test"; // after the env file — it may carry MONGODB_DB=gc
process.env.MONGODB_APP_NAME = "adlauncher-tests";

export const HAVE_DB = Boolean(process.env.MONGODB_URI);
export const TEST_DB = "gc_test";
/** Per-run marker: every test row carries it, so concurrent test files never see each other's rows. */
export const RUN = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

type Mongo = typeof import("../lib/mongo.ts");
let mongo: Mongo | null = null;
async function lib(): Promise<Mongo> {
  if (!mongo) mongo = await import("../lib/mongo.ts");
  return mongo;
}

/** The claim indexes the app relies on (the loader creates them in `gc`; `gc_test` gets them here). */
export async function ensureTestIndexes(): Promise<void> {
  const { getDb } = await lib();
  const db = await getDb();
  if (db.databaseName !== TEST_DB) throw new Error(`refusing to run live tests against "${db.databaseName}" — only ${TEST_DB}`);
  const plan: Array<[string, Record<string, 1 | -1>]> = [
    ["launch_tasks", { task_id: 1 }],
    ["app_caches", { ckey: 1 }],
    ["gcm_maps", { gcm: 1 }],
    ["aif_maps", { brand: 1 }],
    ["up_users", { username: 1 }],
    ["up_users", { email: 1 }],
    // The launch-queue job collection: job_id is the hand-off idempotency key AND the claim/finish
    // precondition, so the live queue tests need its unique index (+ the Strapi envelope).
    ["launch_jobs", { job_id: 1 }],
  ];
  for (const [name, key] of plan) {
    await db.collection(name).createIndex(key, { unique: true });
    await db.collection(name).createIndex({ id: 1 }, { unique: true });
    await db.collection(name).createIndex({ documentId: 1 }, { unique: true });
  }
  for (const name of ["gcm_binding_logs", "mo_landing_jobs", "mo_landings"]) {
    await db.collection(name).createIndex({ id: 1 }, { unique: true });
    await db.collection(name).createIndex({ documentId: 1 }, { unique: true });
  }
  // launch_jobs TTL + query indexes (the unique job_id + envelope were created in the loop above).
  await db.collection("launch_jobs").createIndex({ expire_at: 1 }, { expireAfterSeconds: 0 });
  await db.collection("launch_jobs").createIndex({ lane: 1, status: 1, seq: 1 });
  await db.collection("launch_jobs").createIndex({ status: 1, lease_until: 1 });
  await db.collection("launch_jobs").createIndex({ status: 1, account: 1 });
  // Lane locks + the Meta-video cache: NO envelope (no id / documentId) — only their own unique keys,
  // or a unique index on a missing field would collide on the second document.
  await db.collection("launch_lanes").createIndex({ lane: 1 }, { unique: true });
  await db.collection("fb_media_cache").createIndex({ ckey: 1 }, { unique: true });
  await db.collection("fb_media_cache").createIndex({ expire_at: 1 }, { expireAfterSeconds: 0 });
}

export async function col(name: string) {
  const { getDb } = await lib();
  const db = await getDb();
  if (db.databaseName !== TEST_DB) throw new Error(`refusing to touch "${db.databaseName}"`);
  return db.collection(name);
}

/** Delete the rows matching `filter` — only ever in gc_test. */
export async function wipe(name: string, filter: Record<string, unknown>): Promise<number> {
  const c = await col(name);
  return (await c.deleteMany(filter)).deletedCount;
}

export async function closeDb(): Promise<void> {
  if (!mongo) return;
  const client = await mongo.getClient().catch(() => null);
  await client?.close();
}
