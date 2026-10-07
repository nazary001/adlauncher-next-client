// lib/mongo.ts — shared MongoDB access layer (source of truth: docs/strapi-to-mongo/templates/mongo.ts).
// Copy into each project unchanged. Requires: npm i mongodb@^6
import { MongoClient, type Db, type Collection, type Document } from 'mongodb';
import { randomBytes } from 'node:crypto';

const DB_NAME = process.env.MONGODB_DB || 'gc';

declare global {
  // Cached across hot reloads / serverless invocations in the same container.
  // eslint-disable-next-line no-var
  var __gcMongoClient: Promise<MongoClient> | undefined;
}

export function getClient(): Promise<MongoClient> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  if (!globalThis.__gcMongoClient) {
    const client = new MongoClient(uri, {
      maxPoolSize: Number(process.env.MONGODB_POOL || 10),
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
      appName: process.env.MONGODB_APP_NAME || 'gc-app',
    });
    globalThis.__gcMongoClient = client.connect().catch((err) => {
      globalThis.__gcMongoClient = undefined;
      throw err;
    });
  }
  return globalThis.__gcMongoClient;
}

export async function getDb(): Promise<Db> {
  return (await getClient()).db(DB_NAME);
}

export async function coll<T extends Document = Document>(name: string): Promise<Collection<T>> {
  return (await getDb()).collection<T>(name);
}

/** Next Strapi-style numeric id for a collection (atomic counter). */
export async function nextId(collection: string): Promise<number> {
  const db = await getDb();
  const r = await db
    .collection<{ _id: string; seq: number }>('counters')
    .findOneAndUpdate({ _id: collection }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  if (!r) throw new Error(`counters: no seq for ${collection}`);
  return r.seq;
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
/** Strapi v5-style documentId: 24 chars [a-z0-9]. */
export function newDocumentId(): string {
  const b = randomBytes(24);
  let s = '';
  for (let i = 0; i < 24; i++) s += ALPHABET[b[i] % 36];
  return s;
}

/** True when an insert/update hit a unique index (the old Strapi "unique → HTTP 400" branch). */
export function isDupKey(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: number }).code === 11000;
}

export function stamp(now: Date = new Date()) {
  return { createdAt: now, updatedAt: now };
}

/**
 * Build a new document with Strapi-compatible envelope (id, documentId, timestamps).
 * `publish: true` sets publishedAt/strapiStatus for Draft&Publish collections.
 */
export async function newDoc<T extends Record<string, unknown>>(
  collection: string,
  data: T,
  opts: { publish?: boolean; now?: Date } = {},
) {
  const now = opts.now ?? new Date();
  const doc: Record<string, unknown> = {
    id: await nextId(collection),
    documentId: newDocumentId(),
    ...data,
    createdAt: now,
    updatedAt: now,
  };
  if (opts.publish !== undefined) {
    doc.publishedAt = opts.publish ? now : null;
    doc.strapiStatus = opts.publish ? 'published' : 'draft';
  }
  return doc;
}

/** Strip Mongo internals before sending a document to a browser. */
export function pub<T extends Document>(doc: T | null): Omit<T, '_id'> | null {
  if (!doc) return null;
  const { _id: _omit, ...rest } = doc as T & { _id?: unknown };
  void _omit;
  return rest;
}
