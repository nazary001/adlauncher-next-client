// Project-side helpers over lib/mongo.ts (the shared template, copied unchanged): the Strapi-shaped
// envelope every new document carries, duplicate-key classification for the claim protocol, and the
// 8 s bound every store call keeps (the old strapiFetch abort — a hung store must fail FAST, never pin
// a Vercel function to its maxDuration). Server-only. Relative `.ts` imports on purpose: the modules
// built on this file are loaded by `node --test` straight from disk, where the `@/` alias is unknown.

import type { Document } from "mongodb";
import { coll, getDb, isDupKey, newDocumentId, nextId } from "./mongo.ts";

/** Every store call is bounded to this (the former STRAPI_TIMEOUT_MS). */
export const STORE_TIMEOUT_MS = 8_000;

/** The store is usable only with a connection string; routes answer "not_configured" without it. */
export const storeConfigured = (): boolean => Boolean(process.env.MONGODB_URI);

/** Collection names (= Strapi `collectionName`, CONVENTIONS §2). */
export const LAUNCH_TASKS = "launch_tasks";
export const APP_CACHES = "app_caches";
export const GCM_MAPS = "gcm_maps";
export const GCM_BINDING_LOGS = "gcm_binding_logs";
export const AIF_MAPS = "aif_maps";
export const MO_LANDING_JOBS = "mo_landing_jobs";
export const MO_LANDINGS = "mo_landings";
export const UP_USERS = "up_users";

/** Race a store promise against the bound: rejects with `<what> timeout` when the store stalls. The
 *  underlying operation is not cancelled (the driver has no abort), the CALLER just stops waiting. */
export function bounded<T>(p: Promise<T>, what = "store", ms = STORE_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timeout after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** The unique-index field a duplicate-key error hit ("ckey", "gcm", "task_id", "id", …), or null when
 *  the error is not E11000. The driver exposes the server's keyPattern; the message is the fallback. */
export function dupKeyField(e: unknown): string | null {
  if (!isDupKey(e)) return null;
  const err = e as { keyPattern?: Record<string, unknown>; message?: string; errmsg?: string };
  const fromPattern = err.keyPattern && Object.keys(err.keyPattern);
  if (fromPattern && fromPattern.length > 0) return fromPattern[0];
  const m = /index: ([A-Za-z0-9_.]+?)_-?1\b/.exec(String(err.message ?? err.errmsg ?? ""));
  return m ? m[1] : null;
}

/** Did the write collide on THIS unique field? The claim primitive: the branch that used to be
 *  Strapi's "unique → HTTP 400" (CONVENTIONS §3.1). */
export const dupKeyOn = (e: unknown, field: string): boolean => dupKeyField(e) === field;

export type Envelope = { id: number; documentId: string; createdAt: Date; updatedAt: Date; publishedAt: Date };

/** A new document with the Strapi v5 envelope the migrated rows carry: counter id, documentId and the
 *  three timestamps (Strapi stamps publishedAt on non-Draft&Publish types too — the loaded rows have
 *  it, so new rows keep the same shape). */
export async function freshDoc<T extends Document>(collection: string, data: T, now: Date = new Date()): Promise<T & Envelope> {
  return { id: await bounded(nextId(collection), "counter"), documentId: newDocumentId(), ...data, createdAt: now, updatedAt: now, publishedAt: now };
}

/** Re-align a collection's counter with its data (`$max`, never backwards): a delta-synced row can
 *  carry an id above the seeded counter, and an id collision must never read as a lost claim. */
export async function resyncCounter(collection: string): Promise<void> {
  const db = await getDb();
  const top = await db.collection(collection).find({}, { projection: { id: 1 }, sort: { id: -1 }, limit: 1 }).toArray();
  const max = Number(top[0]?.id) || 0;
  await db.collection<{ _id: string; seq: number }>("counters").updateOne({ _id: collection }, { $max: { seq: max } }, { upsert: true });
}

/**
 * insertOne with a fresh envelope. A collision on `id`/`documentId` (counter behind the data) re-syncs
 * the counter and retries; a collision on any OTHER unique field (the claim fields) is rethrown as-is so
 * the caller's `dupKeyOn(e, "<field>")` branch sees it. Bounded.
 */
export async function insertFresh<T extends Document>(collection: string, data: T): Promise<T & Envelope> {
  const c = await coll(collection);
  for (let attempt = 0; ; attempt++) {
    const doc = await freshDoc(collection, data);
    try {
      await bounded(c.insertOne(doc as Document), `${collection} insert`);
      return doc;
    } catch (e) {
      const field = dupKeyField(e);
      if ((field === "id" || field === "documentId") && attempt < 2) {
        await resyncCounter(collection).catch(() => {});
        continue;
      }
      throw e;
    }
  }
}

/** A stored document as the old REST layer presented it: no `_id`, BSON dates as ISO strings. The
 *  route-level mappers (toClient, formatJob, …) keep reading exactly what they read before. */
export function strapiRow<T extends Document>(doc: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k === "_id") continue;
    out[k] = v instanceof Date ? v.toISOString() : v;
  }
  return out;
}

/** biginteger columns (CONVENTIONS §2 typing): a numeric string becomes a Number when it is a safe
 *  integer; numbers pass; null/"" → null; anything else is left alone (never "fixed"). */
export function toBigint(v: unknown): unknown {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) {
    const n = Number(v.trim());
    return Number.isSafeInteger(n) ? n : v.trim();
  }
  return v;
}

/** datetime columns: ISO strings (what the old callers posted) become BSON Dates; Dates pass; null stays. */
export function toDatetime(v: unknown): unknown {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return v;
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : d;
  }
  return v;
}

/** Keep only the schema's attributes (Strapi refused unknown attributes with a 400 for the whole
 *  write; here they are simply not persisted) and apply the column typing. */
export function pickSchema(
  data: Record<string, unknown>,
  fields: readonly string[],
  typing: { bigint?: readonly string[]; datetime?: readonly string[] } = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of fields) {
    if (!(k in data) || data[k] === undefined) continue;
    let v: unknown = data[k];
    if (typing.bigint?.includes(k)) v = toBigint(v);
    if (typing.datetime?.includes(k)) v = toDatetime(v);
    out[k] = v;
  }
  return out;
}

/** Escape a literal for use inside a RegExp (prefix scans on ckey). */
export const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `{ckey: /^prefix/}` — the former `filters[ckey][$startsWith]`. */
export const prefixFilter = (prefix: string) => ({ $regex: `^${escapeRegex(prefix)}` });
