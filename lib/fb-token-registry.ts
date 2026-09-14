// The owner-managed Facebook token registry — MODEL + pure reducers (owner ask 2026-09-14: add /
// remove FB tokens in the app and pick, per partner and per rail, which token signs). The I/O
// (Strapi row, sealing, Graph probes) lives in lib/fb-tokens; this file carries the decisions and
// is deliberately dependency-free (node:crypto only, no "@/" imports) so
// `node --test tests/fb-token-registry.test.ts` runs it straight off Node's type stripping.
//
// Shape (one Strapi app-cache row, see lib/fb-tokens):
//   tokens — sealed bearers with their tags (partners they may sign for, personal-soc flag,
//            label, who added them, last identity probe);
//   slots  — per PARTNER×RAIL ("mo.launch" … "hs.clone") an ORDERED list of token ids. MO/AIF
//            rails take exactly one token; the HS rails are POOLS (first = primary, the rest =
//            failover order — same-user bearers issued through different FB apps dodge the
//            app-level (#4) limit, the 08-20 design, now owner-editable).
//   Slot lists may also name ENV SEEDS (`env:…` ids): the bearers Vercel env still provides show
//   up read-only and are assignable like any other. An UNASSIGNED slot resolves to today's env
//   default (envDefaultIds), so shipping the registry changes nothing until an owner assigns.

import { randomBytes } from "node:crypto";

export type TokenPartner = "mo" | "aif" | "hs";
export type TokenRail = "launch" | "clone";
export type SlotId = "mo.launch" | "mo.clone" | "aif.launch" | "aif.clone" | "hs.launch" | "hs.clone";

export const TOKEN_PARTNERS: readonly TokenPartner[] = ["mo", "aif", "hs"];
export const SLOT_IDS: readonly SlotId[] = ["mo.launch", "mo.clone", "aif.launch", "aif.clone", "hs.launch", "hs.clone"];

export const PARTNER_LABEL: Record<TokenPartner, string> = { mo: "MO", aif: "AIF", hs: "HS" };
export const PARTNER_TITLE: Record<TokenPartner, string> = {
  mo: "MO · Magicoffers (direct Graph)",
  aif: "AIF · Airfind Rewarded Web (direct Graph)",
  hs: "HS · FB Token rails (LION stays on its own token)",
};

export type SlotMeta = { partner: TokenPartner; rail: TokenRail; title: string; hint: string; pool: boolean };
export const SLOT_META: Record<SlotId, SlotMeta> = {
  "mo.launch": { partner: "mo", rail: "launch", title: "Launches", hint: "Launcher board · new campaigns + auto-landing launches", pool: false },
  "mo.clone": { partner: "mo", rail: "clone", title: "Clones", hint: "Clone board · reads the sources and builds the copies", pool: false },
  "aif.launch": { partner: "aif", rail: "launch", title: "Launches", hint: "AIF launcher board", pool: false },
  "aif.clone": { partner: "aif", rail: "clone", title: "Clones", hint: "AIF clone board", pool: false },
  "hs.launch": { partner: "hs", rail: "launch", title: "Launches (FB Token rail)", hint: "Failover pool · first = primary, the rest take over on an app-level limit", pool: true },
  "hs.clone": { partner: "hs", rail: "clone", title: "Duplicates & JURO (FB Token rails)", hint: "Failover pool · also signs the geo-override patch of LION clones", pool: true },
};

export const slotOf = (partner: TokenPartner, rail: TokenRail): SlotId => `${partner}.${rail}` as SlotId;
export const slotPartner = (slot: SlotId): TokenPartner => SLOT_META[slot].partner;
export const slotRail = (slot: SlotId): TokenRail => SLOT_META[slot].rail;
export const isSlotId = (v: unknown): v is SlotId => typeof v === "string" && (SLOT_IDS as readonly string[]).includes(v);
export const describeSlot = (slot: SlotId): string => `${PARTNER_LABEL[SLOT_META[slot].partner]} · ${SLOT_META[slot].title}`;

/** Result of one Graph identity probe (lib/fb-tokens probeTokenIdentity). */
export type TokenIdentity = {
  ok: boolean;
  error?: string;
  userId: string;
  userName: string;
  appId: string;
  appName: string;
  /** epoch ms; 0 = never / unknown */
  expiresAt: number;
  dataAccessExpiresAt: number;
  scopes: string[];
  /** visible ad accounts / ADVERTISE pages (null = not counted); *Capped = count hit the sweep ceiling */
  accounts: number | null;
  accountsCapped?: boolean;
  pages: number | null;
  pagesCapped?: boolean;
  checkedAt: number;
};

export type TokenEntry = {
  id: string;
  label: string;
  /** lib/fb-token-vault envelope — the bearer itself never sits in the row in clear. */
  sealed: string;
  fp: string;
  partners: TokenPartner[];
  /** Personal soc profile (vs a system user) → MO campaign names carry the SOC marker. */
  personal: boolean;
  note: string;
  addedBy: string;
  addedAt: number;
  identity?: TokenIdentity | null;
};

export type RegistryEventKind = "add" | "remove" | "assign" | "update" | "recheck";
export type RegistryEvent = { at: number; by: string; kind: RegistryEventKind; text: string };

export type TokenRegistry = {
  v: 1;
  tokens: TokenEntry[];
  slots: Record<SlotId, string[]>;
  events: RegistryEvent[];
  updatedAt?: number;
  updatedBy?: string;
};

export const MAX_EVENTS = 40;
export const MAX_TOKENS = 60;

const EVENT_KINDS: readonly RegistryEventKind[] = ["add", "remove", "assign", "update", "recheck"];

export const isRegistryTokenId = (id: unknown): id is string => typeof id === "string" && /^t_[a-z0-9]{10}$/.test(id);
export const isEnvTokenId = (id: unknown): id is string => typeof id === "string" && /^env:[\w.:-]{1,64}$/.test(id);

export function newTokenId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(10);
  let out = "t_";
  for (let i = 0; i < 10; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export function emptyRegistry(): TokenRegistry {
  const slots = {} as Record<SlotId, string[]>;
  for (const s of SLOT_IDS) slots[s] = [];
  return { v: 1, tokens: [], slots, events: [] };
}

// ---- input validation -----------------------------------------------------------------------

/** Tolerant paste: "Bearer …", surrounding quotes, stray whitespace/newlines all stripped. */
export function normalizeToken(raw: unknown): string {
  let s = String(raw ?? "").trim();
  s = s.replace(/^bearer\s+/i, "");
  s = s.replace(/^["'`]+|["'`]+$/g, "");
  return s.replace(/\s+/g, "");
}

/** Graph bearers are long opaque [A-Za-z0-9_-] strings (the EAA… user tokens run 150–250 chars). */
export const looksLikeFbToken = (token: string): boolean => /^[A-Za-z0-9_-]{40,1024}$/.test(token);

const LABEL_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._()#/+-]{0,39}$/u;
export function validateLabel(raw: unknown): string | null {
  const s = String(raw ?? "").trim().replace(/\s+/g, " ");
  return LABEL_RE.test(s) ? s : null;
}

export function validatePartners(raw: unknown): TokenPartner[] | null {
  if (!Array.isArray(raw)) return null;
  const out: TokenPartner[] = [];
  for (const p of raw) {
    if ((TOKEN_PARTNERS as readonly string[]).includes(String(p)) && !out.includes(p as TokenPartner)) out.push(p as TokenPartner);
  }
  return out.length ? out : null;
}

export const validateNote = (raw: unknown): string => String(raw ?? "").trim().slice(0, 200);

// ---- sanitize ---------------------------------------------------------------------------------

function sanitizeIdentity(v: unknown): TokenIdentity | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Partial<TokenIdentity>;
  const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  const cnt = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
  return {
    ok: o.ok === true,
    ...(o.error ? { error: String(o.error).slice(0, 300) } : {}),
    userId: String(o.userId ?? ""),
    userName: String(o.userName ?? ""),
    appId: String(o.appId ?? ""),
    appName: String(o.appName ?? ""),
    expiresAt: num(o.expiresAt),
    dataAccessExpiresAt: num(o.dataAccessExpiresAt),
    scopes: Array.isArray(o.scopes) ? o.scopes.map((s) => String(s)).filter(Boolean).slice(0, 60) : [],
    accounts: cnt(o.accounts),
    ...(o.accountsCapped === true ? { accountsCapped: true } : {}),
    pages: cnt(o.pages),
    ...(o.pagesCapped === true ? { pagesCapped: true } : {}),
    checkedAt: num(o.checkedAt),
  };
}

/** Shape-guard a stored cvalue (a foreign/corrupt row must not crash every launch route). */
export function sanitizeRegistry(value: unknown): TokenRegistry {
  const out = emptyRegistry();
  const v = (value ?? {}) as Partial<TokenRegistry>;
  const seenIds = new Set<string>();
  if (Array.isArray(v.tokens)) {
    for (const raw of v.tokens) {
      if (!raw || typeof raw !== "object") continue;
      const t = raw as Partial<TokenEntry>;
      if (!isRegistryTokenId(t.id) || seenIds.has(t.id)) continue;
      const label = validateLabel(t.label);
      const partners = validatePartners(t.partners);
      const sealed = String(t.sealed ?? "");
      const fp = String(t.fp ?? "");
      if (!label || !partners || !sealed || !fp) continue;
      seenIds.add(t.id);
      out.tokens.push({
        id: t.id,
        label,
        sealed,
        fp,
        partners,
        personal: t.personal === true,
        note: validateNote(t.note),
        addedBy: String(t.addedBy ?? ""),
        addedAt: Number(t.addedAt) || 0,
        identity: sanitizeIdentity(t.identity),
      });
      if (out.tokens.length >= MAX_TOKENS) break;
    }
  }
  if (v.slots && typeof v.slots === "object") {
    for (const slot of SLOT_IDS) {
      const list = (v.slots as Record<string, unknown>)[slot];
      if (!Array.isArray(list)) continue;
      const ids: string[] = [];
      for (const id of list) {
        // Registry ids must exist; env ids are validated against the LIVE seeds at resolve time
        // (an env var may come and go between deploys — effectiveSlot drops what is gone).
        if (isRegistryTokenId(id) ? seenIds.has(id) : isEnvTokenId(id)) {
          if (!ids.includes(id)) ids.push(id);
        }
      }
      out.slots[slot] = ids;
    }
  }
  if (Array.isArray(v.events)) {
    for (const raw of v.events) {
      const e = (raw ?? {}) as Partial<RegistryEvent>;
      if (!EVENT_KINDS.includes(e.kind as RegistryEventKind)) continue;
      out.events.push({ at: Number(e.at) || 0, by: String(e.by ?? ""), kind: e.kind as RegistryEventKind, text: String(e.text ?? "").slice(0, 300) });
      if (out.events.length >= MAX_EVENTS) break;
    }
  }
  if (Number(v.updatedAt)) out.updatedAt = Number(v.updatedAt);
  if (v.updatedBy) out.updatedBy = String(v.updatedBy);
  return out;
}

// ---- env seeds (the bearers Vercel env still provides) ---------------------------------------

export type SeedEntry = {
  /** `env:mo-soc:<name>` | `env:<VAR>` */
  id: string;
  label: string;
  token: string;
  fp: string;
  partners: TokenPartner[];
  personal: boolean;
  envVar: string;
  /** MO soc entries flagged `system:true` (an alternate SYSTEM user, not a personal soc). */
  system?: boolean;
};

/** FB_MO_SOC_TOKENS = JSON array of { name, token, system? } (lib/mo-soc's historical shape). */
export function parseMoSocTokensEnv(raw: string | undefined): { name: string; token: string; system: boolean }[] {
  if (!raw || !raw.trim()) return [];
  try {
    const j = JSON.parse(raw) as unknown;
    const list = Array.isArray(j) ? j : [];
    const out: { name: string; token: string; system: boolean }[] = [];
    const seen = new Set<string>();
    for (const e of list) {
      const name = String((e as { name?: unknown } | null)?.name ?? "").trim();
      const token = String((e as { token?: unknown } | null)?.token ?? "").trim();
      const system = (e as { system?: unknown } | null)?.system === true;
      // Names travel in URLs, cache keys and registry notes — keep them boring.
      if (!/^[\w.-]{1,24}$/.test(name) || !token || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, token, system });
    }
    return out;
  } catch {
    return []; // malformed env = channel simply not provisioned
  }
}

const HS_LAUNCH_VARS = ["FB_HS_LAUNCH_TOKEN", "FB_HS_LAUNCH_TOKEN_2", "FB_HS_LAUNCH_TOKEN_3", "FB_HS_LAUNCH_TOKEN_4"];

/**
 * Every env-provided bearer as a read-only seed. Order matters for the HS pool (T1 → T4 by
 * priority); duplicate bearers collapse onto their first appearance (the pool rule).
 */
export function envSeeds(env: Record<string, string | undefined>, fpOf: (token: string) => string): SeedEntry[] {
  const out: SeedEntry[] = [];
  const seenFp = new Set<string>();
  const push = (s: Omit<SeedEntry, "fp">) => {
    const fp = fpOf(s.token);
    if (seenFp.has(fp)) return;
    seenFp.add(fp);
    out.push({ ...s, fp });
  };
  for (const soc of parseMoSocTokensEnv(env.FB_MO_SOC_TOKENS)) {
    push({ id: `env:mo-soc:${soc.name}`, label: soc.name, token: soc.token, partners: ["mo"], personal: !soc.system, envVar: "FB_MO_SOC_TOKENS", system: soc.system });
  }
  if (env.FB_LAUNCH_TOKEN) {
    push({ id: "env:FB_LAUNCH_TOKEN", label: "FB_LAUNCH_TOKEN (legacy MO)", token: env.FB_LAUNCH_TOKEN, partners: ["mo"], personal: false, envVar: "FB_LAUNCH_TOKEN" });
  }
  if (env.FB_AIF_LAUNCH_TOKEN) {
    push({ id: "env:FB_AIF_LAUNCH_TOKEN", label: "AIF token (env)", token: env.FB_AIF_LAUNCH_TOKEN, partners: ["aif"], personal: false, envVar: "FB_AIF_LAUNCH_TOKEN" });
  }
  HS_LAUNCH_VARS.forEach((v, i) => {
    // Legacy pool rule: the volume token stands in for T1 when the launch var is absent.
    const token = i === 0 ? env[v] || env.FB_HS_VOLUME_TOKEN : env[v];
    if (token) push({ id: `env:${v}`, label: `HS T${i + 1} (env)`, token, partners: ["hs"], personal: false, envVar: v });
  });
  if (env.FB_HS_DUP_TOKEN) {
    push({ id: "env:FB_HS_DUP_TOKEN", label: "HS duplicate signer (env)", token: env.FB_HS_DUP_TOKEN, partners: ["hs"], personal: false, envVar: "FB_HS_DUP_TOKEN" });
  }
  return out;
}

/** Today's behaviour for an UNASSIGNED slot, expressed as seed ids. */
export function envDefaultIds(seeds: SeedEntry[], slot: SlotId): string[] {
  const partner = slotPartner(slot);
  if (partner === "mo") {
    // Owner rule 09-08: the MO system user is retired — the system-CLASS soc entry first, else the
    // first soc; the legacy launch token NEVER signs MO by default.
    const socs = seeds.filter((s) => s.id.startsWith("env:mo-soc:"));
    const pick = socs.find((s) => s.system) ?? socs[0];
    return pick ? [pick.id] : [];
  }
  if (partner === "aif") return seeds.filter((s) => s.id === "env:FB_AIF_LAUNCH_TOKEN").map((s) => s.id);
  const pool = seeds.filter((s) => s.id.startsWith("env:FB_HS_LAUNCH_TOKEN")).map((s) => s.id);
  if (slotRail(slot) === "clone") {
    const dup = seeds.find((s) => s.id === "env:FB_HS_DUP_TOKEN");
    return dup ? [dup.id] : pool;
  }
  return pool;
}

export type Assignable = { id: string; partners: TokenPartner[]; label?: string };

/**
 * The ids a slot resolves to right now: the owner's assignment when it names at least one
 * token that still exists (registry entries are pruned by sanitize; env ids by the live seeds),
 * else the env default, else nothing.
 */
export function effectiveSlot(
  reg: TokenRegistry,
  seeds: SeedEntry[],
  slot: SlotId,
): { ids: string[]; source: "assigned" | "env" | "none" } {
  const live = new Set<string>([...reg.tokens.map((t) => t.id), ...seeds.map((s) => s.id)]);
  const assigned = (reg.slots[slot] ?? []).filter((id) => live.has(id));
  if (assigned.length > 0) return { ids: assigned, source: "assigned" };
  const dflt = envDefaultIds(seeds, slot);
  return dflt.length > 0 ? { ids: dflt, source: "env" } : { ids: [], source: "none" };
}

// ---- reducers (pure; every one returns a NEW registry) ---------------------------------------

export type Outcome = { ok: true; reg: TokenRegistry } | { ok: false; error: string };

const clone = (reg: TokenRegistry): TokenRegistry => ({
  ...reg,
  tokens: reg.tokens.map((t) => ({ ...t, partners: [...t.partners], identity: t.identity ? { ...t.identity, scopes: [...t.identity.scopes] } : t.identity ?? null })),
  slots: Object.fromEntries(SLOT_IDS.map((s) => [s, [...(reg.slots[s] ?? [])]])) as Record<SlotId, string[]>,
  events: [...reg.events],
});

function stamp(reg: TokenRegistry, by: string, now: number, kind: RegistryEventKind, text: string): TokenRegistry {
  reg.events = [{ at: now, by, kind, text: text.slice(0, 300) }, ...reg.events].slice(0, MAX_EVENTS);
  reg.updatedAt = now;
  reg.updatedBy = by;
  reg.v = 1;
  return reg;
}

const sameLabel = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

export function addToken(
  reg: TokenRegistry,
  entry: Omit<TokenEntry, "id">,
  id: string,
  seeds: SeedEntry[],
  now: number,
): Outcome {
  if (!isRegistryTokenId(id)) return { ok: false, error: "bad_token_id" };
  if (reg.tokens.length >= MAX_TOKENS) return { ok: false, error: `vault_full — at most ${MAX_TOKENS} tokens` };
  const label = validateLabel(entry.label);
  if (!label) return { ok: false, error: "label_invalid — 1–40 chars: letters, digits, space . _ ( ) # / + -" };
  const partners = validatePartners(entry.partners);
  if (!partners) return { ok: false, error: "partners_required — tag at least one partner (MO / AIF / HS)" };
  if (!entry.sealed || !entry.fp) return { ok: false, error: "token_required" };
  const dupReg = reg.tokens.find((t) => t.fp === entry.fp);
  if (dupReg) return { ok: false, error: `duplicate_token — this token is already in the vault as "${dupReg.label}"` };
  const dupEnv = seeds.find((s) => s.fp === entry.fp);
  if (dupEnv) return { ok: false, error: `duplicate_token — this token is already provided by the Vercel env as "${dupEnv.label}" (${dupEnv.envVar})` };
  if (reg.tokens.some((t) => sameLabel(t.label, label))) return { ok: false, error: `duplicate_label — another token is already called "${label}"` };
  const next = clone(reg);
  next.tokens.push({
    id,
    label,
    sealed: entry.sealed,
    fp: entry.fp,
    partners,
    personal: entry.personal === true,
    note: validateNote(entry.note),
    addedBy: String(entry.addedBy ?? ""),
    addedAt: Number(entry.addedAt) || now,
    identity: entry.identity ?? null,
  });
  return { ok: true, reg: stamp(next, String(entry.addedBy ?? ""), now, "add", `added "${label}" for ${partners.map((p) => PARTNER_LABEL[p]).join("+")}`) };
}

export function removeToken(
  reg: TokenRegistry,
  id: string,
  by: string,
  now: number,
): (Outcome & { removedFrom?: SlotId[] }) {
  const t = reg.tokens.find((x) => x.id === id);
  if (!t) return { ok: false, error: "unknown_token" };
  const next = clone(reg);
  next.tokens = next.tokens.filter((x) => x.id !== id);
  const removedFrom: SlotId[] = [];
  for (const slot of SLOT_IDS) {
    if (next.slots[slot].includes(id)) {
      removedFrom.push(slot);
      next.slots[slot] = next.slots[slot].filter((x) => x !== id);
    }
  }
  const where = removedFrom.length ? ` (unassigned from ${removedFrom.map(describeSlot).join(", ")})` : "";
  return { ok: true, reg: stamp(next, by, now, "remove", `removed "${t.label}"${where}`), removedFrom };
}

export function updateToken(
  reg: TokenRegistry,
  id: string,
  patch: { label?: unknown; partners?: unknown; personal?: unknown; note?: unknown },
  by: string,
  now: number,
): Outcome {
  const idx = reg.tokens.findIndex((x) => x.id === id);
  if (idx < 0) return { ok: false, error: "unknown_token" };
  const next = clone(reg);
  const t = next.tokens[idx];
  const changes: string[] = [];
  if (patch.label !== undefined) {
    const label = validateLabel(patch.label);
    if (!label) return { ok: false, error: "label_invalid — 1–40 chars: letters, digits, space . _ ( ) # / + -" };
    if (next.tokens.some((x) => x.id !== id && sameLabel(x.label, label))) {
      return { ok: false, error: `duplicate_label — another token is already called "${label}"` };
    }
    if (label !== t.label) changes.push(`renamed "${t.label}" → "${label}"`);
    t.label = label;
  }
  if (patch.partners !== undefined) {
    const partners = validatePartners(patch.partners);
    if (!partners) return { ok: false, error: "partners_required — tag at least one partner (MO / AIF / HS)" };
    const dropped = t.partners.filter((p) => !partners.includes(p));
    for (const p of dropped) {
      for (const slot of SLOT_IDS) {
        if (slotPartner(slot) === p) next.slots[slot] = next.slots[slot].filter((x) => x !== id);
      }
    }
    if (dropped.length || partners.some((p) => !t.partners.includes(p))) changes.push(`partners → ${partners.map((p) => PARTNER_LABEL[p]).join("+")}`);
    t.partners = partners;
  }
  if (patch.personal !== undefined) {
    const personal = patch.personal === true;
    if (personal !== t.personal) changes.push(personal ? "marked personal soc" : "marked system user");
    t.personal = personal;
  }
  if (patch.note !== undefined) {
    const note = validateNote(patch.note);
    if (note !== t.note) changes.push("note edited");
    t.note = note;
  }
  return { ok: true, reg: stamp(next, by, now, "update", `"${t.label}": ${changes.join("; ") || "no change"}`) };
}

export function setSlot(
  reg: TokenRegistry,
  slot: SlotId,
  ids: unknown,
  assignables: Assignable[],
  by: string,
  now: number,
): Outcome {
  if (!isSlotId(slot)) return { ok: false, error: "unknown_slot" };
  if (!Array.isArray(ids)) return { ok: false, error: "ids_required" };
  const partner = slotPartner(slot);
  const clean: string[] = [];
  for (const raw of ids) {
    const id = String(raw ?? "").trim();
    if (!id || clean.includes(id)) continue;
    const a = assignables.find((x) => x.id === id);
    if (!a) return { ok: false, error: `unknown token "${id}" — it may have been removed; reload the page` };
    if (!a.partners.includes(partner)) {
      return { ok: false, error: `token "${id}" is not tagged for ${PARTNER_LABEL[partner]} — edit its partners first` };
    }
    clean.push(id);
  }
  if (!SLOT_META[slot].pool && clean.length > 1) {
    return { ok: false, error: `${describeSlot(slot)} takes exactly one token (only the HS rails are failover pools)` };
  }
  const next = clone(reg);
  next.slots[slot] = clean;
  const labelOf = (id: string): string =>
    next.tokens.find((t) => t.id === id)?.label ?? assignables.find((a) => a.id === id)?.label ?? id.replace(/^env:(mo-soc:)?/, "");
  const text = clean.length ? `${describeSlot(slot)} → ${clean.map(labelOf).join(" › ")}` : `${describeSlot(slot)} → env default`;
  return { ok: true, reg: stamp(next, by, now, "assign", text) };
}

export function setIdentity(reg: TokenRegistry, id: string, identity: TokenIdentity, by: string, now: number): Outcome {
  const idx = reg.tokens.findIndex((x) => x.id === id);
  if (idx < 0) return { ok: false, error: "unknown_token" };
  const next = clone(reg);
  next.tokens[idx].identity = sanitizeIdentity(identity);
  const t = next.tokens[idx];
  const verdict = identity.ok ? `live · ${identity.userName || "?"}${identity.appName ? ` (${identity.appName})` : ""}` : `DEAD · ${identity.error ?? "rejected"}`;
  return { ok: true, reg: stamp(next, by, now, "recheck", `"${t.label}": ${verdict}`) };
}
