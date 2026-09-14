// Server-only. The owner-managed Facebook token registry — I/O layer over lib/fb-token-registry
// (model + reducers) and lib/fb-token-vault (sealing). Owner ask 2026-09-14: add / remove FB
// tokens from the app and pick, per partner (MO · AIF · HS) and per rail (launches · clones),
// which token signs — no more Vercel env edits + redeploys per rotation.
//
// Storage: ONE `app-cache` row (ckey FB_TOKEN_REGISTRY_KEY). Bearers sit in it SEALED (AES-GCM
// under a key derived from AUTH_SECRET) and never leave this process in clear: the rails get a
// decrypted bearer through resolveSlot(); every API answer carries labels, fingerprints and
// identities only. Writes are owner-only and rare (read-modify-write; a row that could not be
// read is never written over — same discipline as lib/acct-assignments). Readers (every launch/
// clone/catalog call) go through a short per-instance cache.
//
// Resolution contract (lib/fb-token-registry effectiveSlot): an ASSIGNED slot is the owner's
// word — if its token is gone/unreadable the rail fails with a clean config error, never a silent
// fallback to another signer; an UNASSIGNED slot resolves to today's env default, so deploying
// the registry changes nothing until an owner assigns.

import { readAppCacheDetailed, writeAppCache } from "@/lib/app-cache";
import { openToken, sealToken, tokenFingerprint, vaultKey } from "@/lib/fb-token-vault";
import {
  type Outcome,
  type SeedEntry,
  type SlotId,
  type TokenIdentity,
  type TokenPartner,
  type TokenRegistry,
  SLOT_IDS,
  SLOT_META,
  describeSlot,
  effectiveSlot,
  emptyRegistry,
  envSeeds,
  sanitizeRegistry,
} from "@/lib/fb-token-registry";

export const FB_TOKEN_REGISTRY_KEY = "fb-token-registry:v1";

type Json = Record<string, unknown>;
const GRAPH = "https://graph.facebook.com/v21.0";

// ---- vault key ------------------------------------------------------------------------------

let keyCache: Buffer | null | undefined;
function key(): Buffer | null {
  if (keyCache === undefined) keyCache = vaultKey(process.env.AUTH_SECRET ?? "");
  return keyCache;
}
/** False when AUTH_SECRET is unset/too short — then nothing can be sealed or opened (sessions
 *  are disabled in that state anyway, see lib/session). */
export const vaultOpen = (): boolean => key() !== null;

// ---- env seeds --------------------------------------------------------------------------------

let seedsCache: SeedEntry[] | null = null;
/** The bearers Vercel env still provides, as read-only seeds (computed once per instance). */
export function envTokenSeeds(): SeedEntry[] {
  if (!seedsCache) seedsCache = envSeeds(process.env as Record<string, string | undefined>, tokenFingerprint);
  return seedsCache;
}

// ---- the row ----------------------------------------------------------------------------------

export type RegistryRow = { data: TokenRegistry; documentId: string | null };

/** Uncached read (owner API + every write). null = store unavailable; a MISSING row comes back
 *  as an empty registry (documentId null). */
export async function readRegistry(): Promise<RegistryRow | null> {
  const r = await readAppCacheDetailed<TokenRegistry>(FB_TOKEN_REGISTRY_KEY);
  if (!r.ok) return null;
  if (!r.row) return { data: emptyRegistry(), documentId: null };
  return { data: sanitizeRegistry(r.row.value), documentId: r.row.documentId };
}

// Rail-path cache: a launch tolerates ~15s of staleness (an owner's re-assignment lands on every
// instance within that window); writes bust it on this instance right away.
const TTL_MS = 15_000;
let cache: { at: number; row: RegistryRow | null } | null = null;
let inflightRead: Promise<RegistryRow | null> | null = null;

async function cachedRegistry(): Promise<RegistryRow | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.row;
  if (inflightRead) return inflightRead;
  inflightRead = (async () => {
    try {
      const row = await readRegistry();
      // A store blip must not blank the registry for 15s: keep serving the last good row.
      if (row === null && cache?.row) return cache.row;
      cache = { at: Date.now(), row };
      return row;
    } finally {
      inflightRead = null;
    }
  })();
  return inflightRead;
}

export function bustRegistryCache(): void {
  cache = null;
}

/**
 * Read-modify-write the row under one reducer. Store unreadable → REFUSE (writing over an
 * unreadable row would replace the whole registry with one patch — silent wipe of every token).
 */
export async function mutateRegistry(
  fn: (reg: TokenRegistry, seeds: SeedEntry[]) => Outcome,
): Promise<{ ok: true; reg: TokenRegistry } | { ok: false; error: string; status: number }> {
  const existing = await readRegistry();
  if (!existing) return { ok: false, error: "store_unavailable — Strapi did not answer; nothing was changed", status: 502 };
  const out = fn(existing.data, envTokenSeeds());
  if (!out.ok) return { ok: false, error: out.error, status: 400 };
  const docId = await writeAppCache(FB_TOKEN_REGISTRY_KEY, out.reg, existing.documentId);
  bustRegistryCache();
  if (!docId) return { ok: false, error: "store_write_failed — Strapi refused the write; nothing was changed", status: 502 };
  cache = { at: Date.now(), row: { data: out.reg, documentId: docId } };
  return { ok: true, reg: out.reg };
}

/** Seal a bearer for storage (null when the vault is closed). */
export function sealForVault(token: string): { sealed: string; fp: string } | null {
  const k = key();
  if (!k) return null;
  return { sealed: sealToken(token, k), fp: tokenFingerprint(token) };
}

// ---- slot resolution (what the rails call) ------------------------------------------------------

export type ResolvedToken = {
  id: string;
  label: string;
  /** The bearer — server-only, never serialize. */
  token: string;
  fp: string;
  source: "registry" | "env";
  personal: boolean;
  partners: TokenPartner[];
  /** Catalog cache identity (lib/fb-graph TokenCatalog.cacheKey) — one per bearer, so two
   *  signers' account/page lists never bleed. Env seeds keep their historical keys. */
  cacheKey: string;
  envVar?: string;
};

export type SlotResolution = {
  slot: SlotId;
  source: "assigned" | "env" | "none";
  tokens: ResolvedToken[];
  /** Labels of assigned registry tokens that could not be opened (secret rotated / row damaged). */
  unreadable: string[];
  ok: boolean;
  error?: string;
};

function cacheKeyFor(id: string, fp: string, seed?: SeedEntry): string {
  if (seed) {
    if (seed.id.startsWith("env:mo-soc:")) return `mo-soc-${seed.label}`;
    if (seed.id === "env:FB_LAUNCH_TOKEN") return "mo";
    if (seed.id === "env:FB_AIF_LAUNCH_TOKEN") return "aif";
    return `env-${fp}`;
  }
  return `tok-${fp}`;
}

function resolveFrom(reg: TokenRegistry, seeds: SeedEntry[], slot: SlotId): SlotResolution {
  const eff = effectiveSlot(reg, seeds, slot);
  const k = key();
  const tokens: ResolvedToken[] = [];
  const unreadable: string[] = [];
  for (const id of eff.ids) {
    const seed = seeds.find((s) => s.id === id);
    if (seed) {
      tokens.push({
        id,
        label: seed.label,
        token: seed.token,
        fp: seed.fp,
        source: "env",
        personal: seed.personal,
        partners: seed.partners,
        cacheKey: cacheKeyFor(id, seed.fp, seed),
        envVar: seed.envVar,
      });
      continue;
    }
    const t = reg.tokens.find((x) => x.id === id);
    if (!t) continue; // effectiveSlot already pruned; belt
    const bearer = k ? openToken(t.sealed, k) : null;
    if (!bearer) {
      unreadable.push(t.label);
      continue;
    }
    tokens.push({
      id,
      label: t.label,
      token: bearer,
      fp: t.fp,
      source: "registry",
      personal: t.personal,
      partners: t.partners,
      cacheKey: cacheKeyFor(id, t.fp),
    });
  }
  if (tokens.length > 0) return { slot, source: eff.source, tokens, unreadable, ok: true };
  const where = describeSlot(slot);
  const error =
    unreadable.length > 0
      ? `token_unreadable — the token assigned to ${where} ("${unreadable.join('", "')}") cannot be opened (app secret rotated?); an owner must re-add it under FB tokens`
      : `no_token — no token is assigned to ${where} and the env provides no default; an owner assigns one under FB tokens (menu → FB tokens)`;
  return { slot, source: eff.source, tokens: [], unreadable, ok: false, error };
}

/** The signer(s) of one slot right now — decrypted, in failover order. Store unreachable and no
 *  cached row → env defaults only (fail as open as the env allows). */
export async function resolveSlot(slot: SlotId): Promise<SlotResolution> {
  const row = await cachedRegistry();
  return resolveFrom(row?.data ?? emptyRegistry(), envTokenSeeds(), slot);
}

// ---- live health (tiny raw `/me`, cached per fingerprint) ----------------------------------------

export type TokenHealth = { ok: boolean; error?: string; checkedAt: number };
const healthCache = new Map<string, TokenHealth>();
const HEALTH_TTL_MS = 60_000;

function fmtGraphError(err: { message?: string; code?: number; error_subcode?: number } | undefined, fallback: string): string {
  if (!err) return fallback;
  return `(#${err.code ?? "?"}${err.error_subcode ? `/${err.error_subcode}` : ""}) ${err.message ?? "token rejected"}`;
}

/** One raw Graph GET on a bearer, bounded; the body's own `error` rides through untouched. */
async function graphGet(path: string, token: string, timeoutMs = 10_000): Promise<Json> {
  try {
    const res = await fetch(`${GRAPH}/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json().catch(() => null)) as Json | null;
    if (body && typeof body === "object") return body;
    return { error: { message: `HTTP ${res.status}`, code: res.status } };
  } catch (e) {
    return { error: { message: (e as Error)?.name === "TimeoutError" ? "probe timeout — Graph unreachable" : String((e as Error)?.message ?? e), transient: true } };
  }
}

export async function tokenHealth(fp: string, token: string): Promise<TokenHealth> {
  const hit = healthCache.get(fp);
  if (hit && Date.now() - hit.checkedAt < HEALTH_TTL_MS) return hit;
  const body = await graphGet("me?fields=id", token, 8_000);
  const err = body.error as { message?: string; code?: number; error_subcode?: number; transient?: boolean } | undefined;
  const res: TokenHealth = body.id ? { ok: true, checkedAt: Date.now() } : { ok: false, error: fmtGraphError(err, "token rejected"), checkedAt: Date.now() };
  if (!err?.transient) healthCache.set(fp, res); // a network blip is reported, never cached
  return res;
}

/** Forget a bearer's cached verdict (after an explicit re-check). */
export const forgetTokenHealth = (fp: string): void => {
  healthCache.delete(fp);
};

// ---- identity probe (add / re-check) -----------------------------------------------------------

/**
 * Who is behind a bearer and what it can reach: `/me` (the user), `/app` (the FB app it was
 * issued through — the (#4) limit is app-level), `/me/permissions` (granted scopes),
 * `/debug_token` (expiry; best-effort — some app setups refuse it), plus bounded counts of the
 * ad accounts and ADVERTISE pages it sees. Everything after `/me` runs in parallel and is
 * decoration: a dead `/me` is the verdict, a failed count just answers null.
 */
export async function probeTokenIdentity(token: string): Promise<TokenIdentity> {
  const checkedAt = Date.now();
  const blank: TokenIdentity = {
    ok: false,
    userId: "",
    userName: "",
    appId: "",
    appName: "",
    expiresAt: 0,
    dataAccessExpiresAt: 0,
    scopes: [],
    accounts: null,
    pages: null,
    checkedAt,
  };
  const me = await graphGet("me?fields=id,name", token);
  if (!me.id) {
    return { ...blank, error: fmtGraphError(me.error as { message?: string; code?: number } | undefined, "token rejected") };
  }
  const [app, perms, dbg, accounts, pages] = await Promise.all([
    graphGet("app?fields=id,name", token),
    graphGet("me/permissions?limit=200", token),
    graphGet(`debug_token?input_token=${encodeURIComponent(token)}`, token),
    countEdge(token, "me/adaccounts?fields=account_id&limit=500", 3),
    countEdge(token, "me/accounts?fields=id,tasks&limit=100", 3, (row) => Array.isArray(row.tasks) && (row.tasks as string[]).includes("ADVERTISE")),
  ]);
  const permRows = (perms.data as Array<{ permission?: string; status?: string }> | undefined) ?? [];
  const scopes = permRows.filter((p) => p?.status === "granted" && p.permission).map((p) => String(p.permission));
  const d = (dbg.data ?? {}) as { expires_at?: number; data_access_expires_at?: number; scopes?: string[]; app_id?: string; application?: string };
  const dbgScopes = Array.isArray(d.scopes) ? d.scopes.map(String) : [];
  return {
    ok: true,
    userId: String(me.id),
    userName: String(me.name ?? ""),
    appId: String(app.id ?? d.app_id ?? ""),
    appName: String(app.name ?? d.application ?? ""),
    expiresAt: typeof d.expires_at === "number" && d.expires_at > 0 ? d.expires_at * 1000 : 0,
    dataAccessExpiresAt: typeof d.data_access_expires_at === "number" && d.data_access_expires_at > 0 ? d.data_access_expires_at * 1000 : 0,
    scopes: scopes.length ? scopes : dbgScopes,
    accounts: accounts.count,
    ...(accounts.capped ? { accountsCapped: true } : {}),
    pages: pages.count,
    ...(pages.capped ? { pagesCapped: true } : {}),
    checkedAt,
  };
}

/** Count rows of a paginated edge, up to `maxHops` pages; null when the first hop fails. */
async function countEdge(
  token: string,
  path: string,
  maxHops: number,
  keep: (row: Json) => boolean = () => true,
): Promise<{ count: number | null; capped: boolean }> {
  let count = 0;
  let after = "";
  for (let hop = 0; hop < maxHops; hop++) {
    const body = await graphGet(`${path}${after ? `&after=${encodeURIComponent(after)}` : ""}`, token);
    if (body.error) return hop === 0 ? { count: null, capped: false } : { count, capped: true };
    const rows = (body.data as Json[] | undefined) ?? [];
    for (const r of rows) if (keep(r)) count++;
    const paging = body.paging as { next?: string; cursors?: { after?: string } } | undefined;
    const next = paging?.next && paging.cursors?.after ? String(paging.cursors.after) : "";
    if (!next || next === after) return { count, capped: false };
    after = next;
  }
  return { count, capped: true };
}

// Env seeds carry no stored identity — a light probe (`/me` + `/app`) resolves it once per instance.
const seedIdentityCache = new Map<string, TokenIdentity>();
const SEED_IDENTITY_TTL_MS = 10 * 60_000;
async function seedIdentity(seed: SeedEntry): Promise<TokenIdentity> {
  const hit = seedIdentityCache.get(seed.fp);
  if (hit && Date.now() - hit.checkedAt < SEED_IDENTITY_TTL_MS) return hit;
  const checkedAt = Date.now();
  const me = await graphGet("me?fields=id,name", seed.token, 8_000);
  let ident: TokenIdentity;
  if (!me.id) {
    ident = { ok: false, error: fmtGraphError(me.error as { message?: string; code?: number } | undefined, "token rejected"), userId: "", userName: "", appId: "", appName: "", expiresAt: 0, dataAccessExpiresAt: 0, scopes: [], accounts: null, pages: null, checkedAt };
  } else {
    const app = await graphGet("app?fields=id,name", seed.token, 8_000);
    ident = { ok: true, userId: String(me.id), userName: String(me.name ?? ""), appId: String(app.id ?? ""), appName: String(app.name ?? ""), expiresAt: 0, dataAccessExpiresAt: 0, scopes: [], accounts: null, pages: null, checkedAt };
  }
  if (!(me.error as { transient?: boolean } | undefined)?.transient) seedIdentityCache.set(seed.fp, ident);
  return ident;
}

// ---- views (what the APIs serialize — no bearer material) --------------------------------------

export type VaultTokenView = {
  id: string;
  label: string;
  fp: string;
  partners: TokenPartner[];
  personal: boolean;
  note: string;
  addedBy: string;
  addedAt: number;
  identity: TokenIdentity | null;
  source: "registry" | "env";
  envVar?: string;
  /** Registry tokens only: false when the sealed bearer cannot be opened with this secret. */
  readable: boolean;
  health: TokenHealth;
  usedIn: SlotId[];
};

export type SlotView = {
  slot: SlotId;
  source: "assigned" | "env" | "none";
  /** The owner's raw assignment (ids), including ids that no longer resolve. */
  assigned: string[];
  /** What actually signs right now, in failover order. */
  tokens: { id: string; label: string; source: "registry" | "env"; fp: string; personal: boolean }[];
  unreadable: string[];
  ok: boolean;
  error?: string;
};

export type RegistryView = {
  vaultOpen: boolean;
  tokens: VaultTokenView[];
  slots: Record<SlotId, SlotView>;
  events: TokenRegistry["events"];
  updatedAt: number | null;
  updatedBy: string | null;
};

/** The owner page's whole picture (fresh row, live health for every bearer — probes are cached
 *  60s per fingerprint, so a page of ten tokens costs ten tiny `/me` reads a minute at most). */
export async function registryView(): Promise<RegistryView | null> {
  const row = await readRegistry();
  if (!row) return null;
  const reg = row.data;
  const seeds = envTokenSeeds();
  const k = key();
  const usedIn = (id: string): SlotId[] => SLOT_IDS.filter((s) => reg.slots[s].includes(id));
  const tokens: VaultTokenView[] = await Promise.all([
    ...reg.tokens.map(async (t): Promise<VaultTokenView> => {
      const bearer = k ? openToken(t.sealed, k) : null;
      const health: TokenHealth = bearer
        ? await tokenHealth(t.fp, bearer)
        : { ok: false, error: k ? "sealed with another secret — re-add this token" : "vault closed (AUTH_SECRET missing)", checkedAt: Date.now() };
      return {
        id: t.id,
        label: t.label,
        fp: t.fp,
        partners: t.partners,
        personal: t.personal,
        note: t.note,
        addedBy: t.addedBy,
        addedAt: t.addedAt,
        identity: t.identity ?? null,
        source: "registry",
        readable: Boolean(bearer),
        health,
        usedIn: usedIn(t.id),
      };
    }),
    ...seeds.map(async (s): Promise<VaultTokenView> => {
      const [health, identity] = await Promise.all([tokenHealth(s.fp, s.token), seedIdentity(s)]);
      return {
        id: s.id,
        label: s.label,
        fp: s.fp,
        partners: s.partners,
        personal: s.personal,
        note: "",
        addedBy: "",
        addedAt: 0,
        identity,
        source: "env",
        envVar: s.envVar,
        readable: true,
        health,
        usedIn: usedIn(s.id),
      };
    }),
  ]);
  const slots = {} as Record<SlotId, SlotView>;
  for (const slot of SLOT_IDS) {
    const r = resolveFrom(reg, seeds, slot);
    slots[slot] = {
      slot,
      source: r.source,
      assigned: [...reg.slots[slot]],
      tokens: r.tokens.map((t) => ({ id: t.id, label: t.label, source: t.source, fp: t.fp, personal: t.personal })),
      unreadable: r.unreadable,
      ok: r.ok,
      ...(r.error ? { error: r.error } : {}),
    };
  }
  return { vaultOpen: k !== null, tokens, slots, events: reg.events, updatedAt: reg.updatedAt ?? null, updatedBy: reg.updatedBy ?? null };
}

export type SignerView = {
  slot: SlotId;
  source: "assigned" | "env" | "none";
  pool: boolean;
  /** The primary signer (null = the rail is blocked until an owner assigns a token). */
  primary: { id: string; label: string; source: "registry" | "env"; personal: boolean; user: string; app: string; ok: boolean; error?: string } | null;
  /** Failover bearers behind the primary (HS pools). */
  extra: number;
  error?: string;
};

/** Per-slot effective signer for the boards' "Signs as …" badges (any session; no bearers). */
export async function signersView(): Promise<Record<SlotId, SignerView>> {
  const row = await cachedRegistry();
  const reg = row?.data ?? emptyRegistry();
  const seeds = envTokenSeeds();
  const out = {} as Record<SlotId, SignerView>;
  await Promise.all(
    SLOT_IDS.map(async (slot) => {
      const r = resolveFrom(reg, seeds, slot);
      const first = r.tokens[0];
      let primary: SignerView["primary"] = null;
      if (first) {
        const seed = seeds.find((s) => s.id === first.id);
        const stored = reg.tokens.find((t) => t.id === first.id)?.identity ?? null;
        const [health, ident] = await Promise.all([tokenHealth(first.fp, first.token), seed ? seedIdentity(seed) : Promise.resolve(stored)]);
        primary = {
          id: first.id,
          label: first.label,
          source: first.source,
          personal: first.personal,
          user: ident?.userName ?? "",
          app: ident?.appName ?? "",
          ok: health.ok,
          ...(health.error ? { error: health.error } : {}),
        };
      }
      out[slot] = {
        slot,
        source: r.source,
        pool: SLOT_META[slot].pool,
        primary,
        extra: Math.max(0, r.tokens.length - 1),
        ...(r.error ? { error: r.error } : {}),
      };
    }),
  );
  return out;
}
