// Per-account launch rate limit: at most ACCT_LIMIT campaigns may be created in one ad account
// within ACCT_WINDOW_MS, the window ANCHORED at the first launch (owner pick 2026-08-18). Every
// campaign-creating route claims a slot here right before it builds; the UI reads the snapshot to
// badge account pickers and drive the header timer. State lives in the shared `app_caches`
// collection (UNIQUE ckey — the same store the HS wave claim already uses), because Vercel
// serverless instances share nothing and several users launch at once:
//   acct-window:<actId>            → { ws }                       — the window anchor
//   acct-slot:<actId>:<ws>:<n>     → { user, partner, channel, name, accountName, ts }
// Claims are atomic: an insert against the unique ckey either lands (the slot is ours) or fails with
// E11000 (someone holds it — walk on) — plus an anchor re-check, because two claims racing across the
// window boundary could otherwise split onto two anchors. Server-only.
//
// Bounded store calls (8 s): FAIL CLOSED must also mean fail FAST — a hung registry refuses the
// launch in seconds instead of pinning the function to its maxDuration.

import type { Document } from "mongodb";
import { coll } from "./mongo.ts";
import { APP_CACHES, STORE_TIMEOUT_MS, bounded, dupKeyOn, insertFresh, prefixFilter, storeConfigured } from "./store.ts";

export const ACCT_LIMIT = 5;
export const ACCT_WINDOW_MS = 30 * 60_000;
/** Expired rows linger this long before the snapshot sweep deletes them (a just-expired window
 *  must not be churned by a claim re-creating it mid-sweep). */
const SWEEP_GRACE_MS = 5 * 60_000;
/** At most this many row deletions per snapshot call — the sweep piggybacks on a UI poll and
 *  must never turn it into a bulk-delete stall. */
const SWEEP_MAX_DELETES = 20;
/** Rows a prefix scan reads at most (the old 5 pages × 100). */
const LIST_LIMIT = 500;

const W_PREFIX = "acct-window:";
const S_PREFIX = "acct-slot:";

/** Canonical account key: numeric id, `act_` prefix stripped. */
export function acctKey(raw: string): string {
  return String(raw ?? "").trim().replace(/^act_/, "");
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number.NaN);

/** Is a window anchored at `ws` still open at `now`? Garbage/zero anchors are never active. */
export function windowActive(ws: number, now: number): boolean {
  return Number.isFinite(ws) && ws > 0 && now < ws + ACCT_WINDOW_MS;
}

/** The human refusal every surface shows — countdown included so nobody has to guess. */
export function acctLimitMessage(resetAt: number, now: number = Date.now()): string {
  const left = Math.max(0, resetAt - now);
  const mm = Math.floor(left / 60_000);
  const ss = Math.floor((left % 60_000) / 1000);
  return `Account limit: ${ACCT_LIMIT} campaigns / 30 min — resets in ${mm}:${String(ss).padStart(2, "0")}`;
}

export class AcctLimitedError extends Error {
  resetAt: number;
  accountId: string;
  constructor(accountId: string, resetAt: number) {
    super(acctLimitMessage(resetAt));
    this.name = "AcctLimitedError";
    this.resetAt = resetAt;
    this.accountId = accountId;
  }
}

export type AcctWindowInfo = { count: number; resetAt: number; name?: string };
export type AcctLimitSnapshot = {
  now: number;
  limit: number;
  windowMs: number;
  accounts: Record<string, AcctWindowInfo>;
};

type KeyedValue = { ckey: string; value: unknown };

/**
 * Pure snapshot derivation (unit-tested): active windows only, slots counted strictly against
 * their window's CURRENT anchor (stale-anchor slots are dead rows awaiting the sweep), account
 * display name from the latest slot's meta.
 */
export function deriveSnapshot(
  windows: KeyedValue[],
  slots: KeyedValue[],
  now: number,
): AcctLimitSnapshot {
  const accounts: Record<string, AcctWindowInfo> = {};
  const wsById = new Map<string, number>();
  for (const w of windows) {
    if (!w.ckey.startsWith(W_PREFIX)) continue;
    const id = w.ckey.slice(W_PREFIX.length);
    const ws = num((w.value as { ws?: unknown } | null)?.ws);
    if (!id || !windowActive(ws, now)) continue;
    wsById.set(id, ws);
    accounts[id] = { count: 0, resetAt: ws + ACCT_WINDOW_MS };
  }
  const nameTs = new Map<string, number>();
  for (const s of slots) {
    if (!s.ckey.startsWith(S_PREFIX)) continue;
    const [id, wsStr, nStr] = s.ckey.slice(S_PREFIX.length).split(":");
    if (!id || wsById.get(id) !== Number(wsStr) || !/^\d+$/.test(nStr ?? "")) continue;
    const a = accounts[id];
    a.count = Math.min(ACCT_LIMIT, a.count + 1);
    const v = s.value as { accountName?: unknown; ts?: unknown } | null;
    const nm = typeof v?.accountName === "string" ? v.accountName.trim() : "";
    const ts = Number(v?.ts) || 0;
    if (nm && ts >= (nameTs.get(id) ?? -1)) {
      nameTs.set(id, ts);
      a.name = nm;
    }
  }
  return { now, limit: ACCT_LIMIT, windowMs: ACCT_WINDOW_MS, accounts };
}

// ---------------------------------------------------------------------------
// Store I/O — own helpers, NOT lib/app-cache's: a claim must distinguish "unique violation"
// (someone holds the slot → walk on) from "store down" (FAIL CLOSED → the launch refuses),
// and app-cache's best-effort writer collapses both into one null.
// ---------------------------------------------------------------------------

type Row = { documentId: string; ckey: string; value: unknown };

function storeDown(detail: string): Error {
  return new Error(`acct_limit_unavailable — launch registry unreachable (${detail})`);
}

function assertConfigured(): void {
  if (!storeConfigured()) throw storeDown("no MONGODB_URI env");
}

const errMsg = (e: unknown): string => (e as Error)?.message ?? String(e);
const PROJECTION = { _id: 0, documentId: 1, ckey: 1, cvalue: 1 } as const;

function shapeRow(r: Document | null | undefined): Row | null {
  if (!r?.documentId || typeof r.ckey !== "string") return null;
  return { documentId: String(r.documentId), ckey: r.ckey, value: r.cvalue ?? null };
}

/** All rows whose ckey starts with `prefix` (bounded; throws `acct_limit_unavailable` on a failure). */
async function listRows(prefix: string): Promise<Row[]> {
  try {
    const c = await coll(APP_CACHES);
    const docs = await bounded(
      c.find({ ckey: prefixFilter(prefix) }, { projection: PROJECTION, maxTimeMS: STORE_TIMEOUT_MS }).limit(LIST_LIMIT).toArray(),
      "acct-limit list",
    );
    return docs.map(shapeRow).filter((r): r is Row => r !== null);
  } catch (e) {
    throw storeDown(`list: ${errMsg(e)}`);
  }
}

async function readRow(ckey: string): Promise<Row | null> {
  try {
    const c = await coll(APP_CACHES);
    return shapeRow(await bounded(c.findOne({ ckey }, { projection: PROJECTION, maxTimeMS: STORE_TIMEOUT_MS }), "acct-limit read"));
  } catch (e) {
    throw storeDown(`read: ${errMsg(e)}`);
  }
}

/** Insert a row. `{unique:true}` when the ckey is taken (E11000 — the atomic signal); throws when
 *  the store itself fails. */
async function postRow(
  ckey: string,
  cvalue: unknown,
): Promise<{ documentId: string; unique?: never } | { unique: true }> {
  try {
    const doc = await insertFresh(APP_CACHES, { ckey, cvalue, refreshed_at: Date.now() });
    return { documentId: doc.documentId };
  } catch (e) {
    if (dupKeyOn(e, "ckey")) return { unique: true };
    throw storeDown(`post: ${errMsg(e)}`);
  }
}

async function putRow(documentId: string, cvalue: unknown): Promise<void> {
  // Deliberately WITHOUT ckey: it is immutable, so an update never needs it (partial update).
  let matched = 0;
  try {
    const c = await coll(APP_CACHES);
    matched = (await bounded(c.updateOne({ documentId }, { $set: { cvalue, refreshed_at: Date.now(), updatedAt: new Date() } }), "acct-limit update")).matchedCount;
  } catch (e) {
    throw storeDown(`put: ${errMsg(e)}`);
  }
  if (matched === 0) throw storeDown("put: row missing");
}

/** Best-effort delete — releasing/sweeping must never fail a launch. */
async function deleteRow(documentId: string): Promise<void> {
  try {
    const c = await coll(APP_CACHES);
    await bounded(c.deleteOne({ documentId }), "acct-limit delete");
  } catch {
    /* best-effort */
  }
}

async function deleteRows(documentIds: string[]): Promise<void> {
  if (documentIds.length === 0) return;
  try {
    const c = await coll(APP_CACHES);
    await bounded(c.deleteMany({ documentId: { $in: documentIds } }), "acct-limit sweep");
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type AcctSlotMeta = {
  user?: string;
  partner?: string;
  channel?: string;
  /** Campaign name (display only — the header panel's tooltip material). */
  name?: string;
  /** Account display name when the route has it from its catalog (display only). */
  accountName?: string;
};

/**
 * Claim one launch slot for the account, or throw:
 *  - AcctLimitedError — all ACCT_LIMIT slots of the current window are taken (carries resetAt);
 *  - Error("acct_limit_unavailable…") — the store is unreachable (FAIL CLOSED by design).
 * The caller keeps the slot once a campaign exists and releases it when the launch died earlier.
 */
export async function claimAcctSlot(
  accountId: string,
  meta: AcctSlotMeta,
): Promise<{ documentId: string; count: number }> {
  const id = acctKey(accountId);
  if (!/^\d{5,}$/.test(id)) throw new Error(`acct_limit: bad account id "${accountId}"`);
  assertConfigured();
  const wkey = `${W_PREFIX}${id}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    const now = Date.now();
    let wrow = await readRow(wkey);
    if (!wrow) {
      const res = await postRow(wkey, { ws: now });
      wrow = "documentId" in res ? { documentId: res.documentId, ckey: wkey, value: { ws: now } } : await readRow(wkey);
      if (!wrow) continue; // lost the race AND the winner's row isn't visible yet — retry
    }
    let ws = num((wrow.value as { ws?: unknown } | null)?.ws);
    if (!windowActive(ws, now)) {
      // Expired (or garbage) anchor → move it, then ADOPT whatever concurrent writers settled on:
      // last-write-wins converges, and every claimant keys its slots off the stored value.
      await putRow(wrow.documentId, { ws: now });
      const re = await readRow(wkey);
      if (!re) continue;
      wrow = re;
      ws = num((wrow.value as { ws?: unknown } | null)?.ws);
      if (!windowActive(ws, Date.now())) continue; // still not settled — retry
    }

    const sPrefix = `${S_PREFIX}${id}:${ws}:`;
    const taken = new Set(
      (await listRows(sPrefix))
        .map((r) => Number(r.ckey.slice(sPrefix.length)))
        .filter((x) => Number.isFinite(x)),
    );
    let anchorMoved = false;
    for (let slot = 1; slot <= ACCT_LIMIT; slot++) {
      if (taken.has(slot)) continue;
      const skey = `${sPrefix}${slot}`;
      const res = await postRow(skey, { ...meta, ts: Date.now() });
      if ("unique" in res) continue; // someone else holds n — walk on
      // Anchor re-check: a claim racing the window boundary may have moved the anchor between our
      // read and this win — a slot keyed on the dead anchor would not count against the new
      // window, quietly widening the limit. Orphan it and retry on the fresh anchor.
      const wcheck = await readRow(wkey).catch(() => null);
      if (wcheck && num((wcheck.value as { ws?: unknown } | null)?.ws) !== ws) {
        await deleteRow(res.documentId);
        anchorMoved = true;
        break;
      }
      return { documentId: res.documentId, count: slot };
    }
    if (!anchorMoved) throw new AcctLimitedError(id, ws + ACCT_WINDOW_MS);
  }
  throw storeDown("claim did not settle");
}

/** Release a claimed slot (launch died before any campaign existed). Best-effort. */
export async function releaseAcctSlot(documentId: string | null | undefined): Promise<void> {
  if (documentId) await deleteRow(documentId);
}

/**
 * The live picture for the UI: every account with an active window. Also sweeps a bounded number
 * of expired rows (grace-delayed) so the collection never accumulates dead windows.
 */
export async function acctLimitSnapshot(): Promise<AcctLimitSnapshot> {
  assertConfigured();
  const now = Date.now();
  const [wins, slots] = await Promise.all([listRows(W_PREFIX), listRows(S_PREFIX)]);
  const snap = deriveSnapshot(wins, slots, now);

  // Sweep: window rows past anchor+window+grace, and slot rows whose ckey anchor is past the same
  // cutoff. Bounded and awaited (one deleteMany) — only runs when there IS garbage.
  // NOTE the direction: grace is measured PAST the window's end (a garbage/zero anchor is dead
  // immediately) — never by shifting `now`, which would extend the window instead.
  const deadStamp = (ws: number): boolean =>
    !(Number.isFinite(ws) && ws > 0) || now >= ws + ACCT_WINDOW_MS + SWEEP_GRACE_MS;
  const dead: string[] = [];
  for (const w of wins) {
    const ws = num((w.value as { ws?: unknown } | null)?.ws);
    if (deadStamp(ws)) dead.push(w.documentId);
    if (dead.length >= SWEEP_MAX_DELETES) break;
  }
  for (const s of slots) {
    if (dead.length >= SWEEP_MAX_DELETES) break;
    if (deadStamp(Number(s.ckey.slice(S_PREFIX.length).split(":")[1]))) dead.push(s.documentId);
  }
  await deleteRows(dead);
  return snap;
}
