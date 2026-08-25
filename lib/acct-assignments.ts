// Server-only. FB ad-account → users assignment registry (owner feature, 2026-08-21): the owner
// splits accounts between the team on /accounts, and every account picker then shows a non-owner
// only the accounts assigned to them. One flat map for ALL rails (MO / AIF / HS) — FB account ids
// are globally unique, so an account keeps its assignment even when it surfaces on another rail.
//
// Visibility contract (enforced by filterAccountsFor, shown verbatim on /accounts):
//   • account NOT in the map (or with an empty user list) → visible to EVERYONE (unassigned);
//   • account assigned to [A, B]                          → visible only to A, B and owners;
//   • owners always see everything;
//   • registry unreachable → NO filtering (fail open) — a Strapi blip must never hide every
//     account and strand the team un-launchable. Same degrade philosophy as lib/app-cache.
//
// Storage: ONE `app-cache` row (ckey ACCT_ASSIGN_KEY, cvalue = AcctAssignments). Writes are
// owner-only and rare; readers (the pickers) go through a short module cache so a launcher full
// of cards costs one Strapi read per instance per TTL, not one per picker.

import { readAppCacheDetailed, writeAppCache } from "@/lib/app-cache";
import type { Session } from "@/lib/session";
import { isOwnerSession } from "@/lib/roles";

export const ACCT_ASSIGN_KEY = "fb-acct-assignments";

export type AcctAssignments = {
  v: 1;
  /** account digits (act_ stripped) → usernames the account is assigned to. */
  accounts: Record<string, string[]>;
  updatedAt?: number;
  updatedBy?: string;
};

/** Canonical account key: digits only, `act_` prefix stripped (LION ids carry it, Graph ids don't). */
export const acctAssignKey = (raw: string): string => String(raw ?? "").trim().replace(/^act_/, "");

const normUser = (u: string): string => String(u ?? "").trim().toLowerCase();

/** Shape-guard a stored cvalue (a foreign/corrupt row must not crash every picker). */
function sanitize(value: unknown): AcctAssignments {
  const v = (value ?? {}) as Partial<AcctAssignments>;
  const out: Record<string, string[]> = {};
  if (v.accounts && typeof v.accounts === "object") {
    for (const [k, users] of Object.entries(v.accounts)) {
      const key = acctAssignKey(k);
      if (!key || !Array.isArray(users)) continue;
      const list = [...new Set(users.map((u) => String(u ?? "").trim()).filter(Boolean))];
      if (list.length) out[key] = list;
    }
  }
  return { v: 1, accounts: out, updatedAt: Number(v.updatedAt) || undefined, updatedBy: v.updatedBy };
}

export type AssignRow = { data: AcctAssignments; documentId: string | null };

/** Uncached read (the owner API + writes go through this — they must see the freshest row).
 *  null = store unavailable; a MISSING row comes back as an empty map (documentId null). */
export async function readAssignments(): Promise<AssignRow | null> {
  const r = await readAppCacheDetailed<AcctAssignments>(ACCT_ASSIGN_KEY);
  if (!r.ok) return null;
  if (!r.row) return { data: { v: 1, accounts: {} }, documentId: null };
  return { data: sanitize(r.row.value), documentId: r.row.documentId };
}

// Picker-path cache: pickers tolerate ~20s of staleness; writes bust it on this instance and the
// TTL catches every other serverless instance.
const TTL_MS = 20_000;
let cache: { at: number; row: AssignRow | null } | null = null;
let inflightRead: Promise<AssignRow | null> | null = null;

async function cachedAssignments(): Promise<AssignRow | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.row;
  if (inflightRead) return inflightRead;
  inflightRead = (async () => {
    try {
      const row = await readAssignments();
      cache = { at: Date.now(), row };
      return row;
    } finally {
      inflightRead = null;
    }
  })();
  return inflightRead;
}

export function bustAssignmentsCache(): void {
  cache = null;
}

/**
 * Merge-patch the registry: for each entry set the account's user list; an EMPTY list removes the
 * key (back to "visible to everyone"). Read-modify-write on the single row — the writer is the
 * owner UI (rare, effectively single-writer), so last-write-wins is acceptable here.
 * Returns the updated map, or null when the store refused the write.
 */
export async function patchAssignments(
  set: Record<string, string[]>,
  updatedBy: string,
): Promise<AcctAssignments | null> {
  const existing = await readAssignments();
  // Store unreadable → REFUSE the write: patching over an unreadable row would replace the whole
  // registry with just this patch (silent wipe of every other assignment).
  if (!existing) return null;
  const data: AcctAssignments = existing.data;
  for (const [rawKey, users] of Object.entries(set)) {
    const key = acctAssignKey(rawKey);
    if (!key) continue;
    const list = [...new Set(users.map((u) => String(u ?? "").trim()).filter(Boolean))];
    if (list.length) data.accounts[key] = list;
    else delete data.accounts[key];
  }
  data.v = 1;
  data.updatedAt = Date.now();
  data.updatedBy = updatedBy;
  const docId = await writeAppCache(ACCT_ASSIGN_KEY, data, existing.documentId);
  bustAssignmentsCache();
  return docId ? data : null;
}

/**
 * Filter an account list down to what `session` may see (the picker contract above).
 * `idOf` extracts the account id from a row ("act_…" accepted). Owner sessions and an
 * unavailable registry both pass the list through untouched.
 */
export async function filterAccountsFor<T>(
  session: Session | null,
  rows: T[],
  idOf: (row: T) => string,
): Promise<T[]> {
  if (!session || isOwnerSession(session)) return rows;
  const reg = await cachedAssignments();
  if (!reg) return rows; // store unreachable → fail open
  const me = normUser(session.username);
  const map = reg.data.accounts;
  return rows.filter((r) => {
    const users = map[acctAssignKey(idOf(r))];
    if (!users || users.length === 0) return true; // unassigned = shared
    return users.some((u) => normUser(u) === me);
  });
}

/**
 * Fire-time belt over the picker filter (owner ask 08-25): may `session` launch/clone INTO this
 * ad account? Same visibility contract as filterAccountsFor — owner, unassigned account or an
 * unreachable registry all answer yes — so a crafted POST can never reach an account the picker
 * would not have shown. Every campaign-creating route checks this before any claim or stamp.
 */
export async function accountAllowedFor(session: Session | null, accountId: string): Promise<boolean> {
  if (!session || isOwnerSession(session)) return true;
  const reg = await cachedAssignments();
  if (!reg) return true; // store unreachable → fail open (same as the pickers)
  const users = reg.data.accounts[acctAssignKey(accountId)];
  if (!users || users.length === 0) return true; // unassigned = shared
  const me = normUser(session.username);
  return users.some((u) => normUser(u) === me);
}

/** The refusal every fire-time gate answers with (403) — names the fix, not just the block. */
export const ACCOUNT_NOT_ASSIGNED_MSG =
  "account_not_assigned — this ad account is assigned to other buyers on /accounts; pick one of yours";
