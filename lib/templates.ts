// Campaign templates — the pure rules (owner ask 16.10: "каждый может создать свой темплейт кампании …
// все поля необходимые кроме креатива … применять его на все свои запуски … все должны видеть
// темплейты всех, но свои … подсвечены … разбито по имени кто их создал … каждый может управлять
// только своими … овнер роли могут всех").
//
// A template is a named snapshot of a launcher card's settings — every field but the creatives —
// saved on the server (lib/template-store), owned by the buyer who saved it, applicable by anyone on
// the team to any card of the same partner. This module says WHAT a template may carry, HOW a card
// takes it, WHO may change it and how the picker groups and finds them. No React, no store: `node
// --test tests/templates.test.ts` loads it straight off disk (imports only lib/types / lib/catalog /
// lib/publisher-platforms, all import-free).

import type { Campaign } from "./types.ts";
import { bidTag, moneyLabel } from "./types.ts";
import {
  AGES,
  BID_STRATEGIES,
  CATEGORIES,
  CONVERSION_EVENTS,
  CTAS,
  EVENTS_BY_OBJECTIVE,
  OBJECTIVES,
  OPTIMIZATIONS,
  OS_OPTIONS,
  PLACEMENTS,
  REDIRECT_TYPES,
  geoSummary,
} from "./catalog.ts";
import { DEFAULT_PLATFORM_CHOICE, PLATFORM_CHOICES } from "./publisher-platforms.ts";

export type TemplatePartner = "br" | "in" | "us" | "av";
export const TEMPLATE_PARTNERS: readonly TemplatePartner[] = ["br", "in", "us", "av"];

/** The card settings a template may carry. NEVER: `files` (creatives — owner rule), `gcm` (every card
 *  claims its own marker), `id` / `collapsed` (the board's), `namePrefix` (the partner's and the day's),
 *  `autoPage` (the board's fill memory), `paramMode` (no card field reads it any more). */
export const TEMPLATE_KEYS = [
  "name",
  "profile",
  "account",
  "page",
  "pixel",
  "toolSession",
  "objective",
  "optimization",
  "bidStrategy",
  "conversionEvent",
  "budget",
  "bidCap",
  "landing",
  "link",
  "title",
  "copy",
  "cta",
  "redirectType",
  "headline",
  "countries",
  "locales",
  "category",
  "placement",
  "platforms",
  "ageMin",
  "userOs",
] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];
export type TemplateFields = Partial<Pick<Campaign, TemplateKey>>;

const KEY_SET: ReadonlySet<string> = new Set(TEMPLATE_KEYS);
const LIST_KEYS: ReadonlySet<string> = new Set(["countries", "locales"]);

export const TEMPLATE_NAME_MAX = 60;
export const TEMPLATE_DESCRIPTION_MAX = 240;
/** Per buyer, per partner — a cap against a runaway client, not a product limit. */
export const TEMPLATES_PER_USER_MAX = 100;
/** A geo / language list is cut here (the catalogs are far smaller). */
const LIST_MAX = 300;
/** The card's own maxLength per text field; the default covers ids, codes and money. */
const TEXT_MAX: Partial<Record<TemplateKey, number>> = { name: 400, title: 255, copy: 2000, link: 2000, landing: 2000, headline: 255 };
const TEXT_MAX_DEFAULT = 200;

/** A template as the API hands it to the browser (lib/template-store templateFromRow). */
export type CampaignTemplate = {
  id: number;
  documentId: string;
  partner: TemplatePartner;
  /** The login that saved it — exact spelling. */
  owner: string;
  name: string;
  description: string;
  fields: TemplateFields;
  uses: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
};

export type TemplateInput = { name: string; description: string; partner: TemplatePartner; fields: TemplateFields };
export type TemplatePatch = { name?: string; description?: string; fields?: TemplateFields };

const norm = (s: unknown): string => String(s ?? "").trim().toLowerCase();

/** One name per buyer per partner: trimmed, inner spaces collapsed, lower-cased. */
export const templateNameKey = (name: string): string => String(name ?? "").trim().replace(/\s+/g, " ").toLowerCase();

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// ---- the snapshot -------------------------------------------------------------------------------

/** The template a card yields for the ticked keys: template keys only, absent optionals left out,
 *  arrays copied (a template must never share an array with the card it came from). */
export function templateFieldsFrom(c: Campaign, keys: readonly TemplateKey[]): TemplateFields {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (!KEY_SET.has(k)) continue;
    const v = (c as unknown as Record<string, unknown>)[k];
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? [...v] : v;
  }
  return out as TemplateFields;
}

// ---- the server's whitelist ---------------------------------------------------------------------

export type SanitizeResult = { ok: true; fields: TemplateFields; dropped: string[] } | { ok: false; error: string };

/** The fields a request may store: unknown keys dropped (reported), every value the shape the card
 *  keeps — a string (numbers tolerated, cut at the card's maxLength), a string list for geo /
 *  languages (trimmed, de-duplicated, capped), the optimization enum. A wrong shape refuses the
 *  whole write — a template that would put an object into a text field must never be saved. */
export function sanitizeTemplateFields(raw: unknown): SanitizeResult {
  if (!isPlainObject(raw)) return { ok: false, error: "fields_required" };
  const fields: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (!KEY_SET.has(k)) {
      dropped.push(k);
      continue;
    }
    if (v === undefined) continue;
    const key = k as TemplateKey;
    if (LIST_KEYS.has(key)) {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return { ok: false, error: `bad_field:${key}` };
      const seen = new Set<string>();
      const list: string[] = [];
      for (const x of v as string[]) {
        const s = x.trim();
        const n = s.toLowerCase();
        if (!s || seen.has(n)) continue;
        seen.add(n);
        list.push(s);
        if (list.length >= LIST_MAX) break;
      }
      fields[key] = list;
      continue;
    }
    if (key === "optimization") {
      if (v !== "conversions" && v !== "clicks") return { ok: false, error: "bad_field:optimization" };
      fields[key] = v;
      continue;
    }
    if (typeof v === "string") {
      fields[key] = v.slice(0, TEXT_MAX[key] ?? TEXT_MAX_DEFAULT);
      continue;
    }
    if (typeof v === "number" && Number.isFinite(v)) {
      fields[key] = String(v);
      continue;
    }
    return { ok: false, error: `bad_field:${key}` };
  }
  return { ok: true, fields: fields as TemplateFields, dropped };
}

function parseName(v: unknown): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof v !== "string") return { ok: false, error: "name_required" };
  const name = v.trim().replace(/\s+/g, " ");
  if (!name) return { ok: false, error: "name_required" };
  if (name.length > TEMPLATE_NAME_MAX) return { ok: false, error: "name_too_long" };
  return { ok: true, name };
}

function parseDescription(v: unknown): { ok: true; description: string } | { ok: false; error: string } {
  if (v === undefined || v === null) return { ok: true, description: "" };
  if (typeof v !== "string") return { ok: false, error: "bad_body" };
  const description = v.trim();
  if (description.length > TEMPLATE_DESCRIPTION_MAX) return { ok: false, error: "description_too_long" };
  return { ok: true, description };
}

/** A create request: name (trimmed, ≤ 60), description (≤ 240, "" when absent), a partner of the
 *  team (`partners` — lib/team TEAM.partners), at least one template field. */
export function parseTemplateInput(raw: unknown, partners: readonly string[]): { ok: true; value: TemplateInput } | { ok: false; error: string } {
  if (!isPlainObject(raw)) return { ok: false, error: "bad_body" };
  const name = parseName(raw.name);
  if (!name.ok) return name;
  const description = parseDescription(raw.description);
  if (!description.ok) return description;
  const partner = norm(raw.partner);
  if (!partner) return { ok: false, error: "partner_required" };
  if (!partners.includes(partner) || !(TEMPLATE_PARTNERS as readonly string[]).includes(partner)) return { ok: false, error: "partner_not_available" };
  const fields = sanitizeTemplateFields(raw.fields);
  if (!fields.ok) return fields;
  if (Object.keys(fields.fields).length === 0) return { ok: false, error: "fields_empty" };
  return { ok: true, value: { name: name.name, description: description.description, partner: partner as TemplatePartner, fields: fields.fields } };
}

/** An edit: only the parts given, each under the create rules; the partner never moves (a template
 *  is its partner's: the pickers differ). Nothing given = nothing to change. */
export function parseTemplatePatch(raw: unknown): { ok: true; patch: TemplatePatch } | { ok: false; error: string } {
  if (!isPlainObject(raw)) return { ok: false, error: "bad_body" };
  const patch: TemplatePatch = {};
  if (raw.name !== undefined) {
    const name = parseName(raw.name);
    if (!name.ok) return name;
    patch.name = name.name;
  }
  if (raw.description !== undefined) {
    const description = parseDescription(raw.description);
    if (!description.ok) return description;
    patch.description = description.description;
  }
  if (raw.fields !== undefined) {
    const fields = sanitizeTemplateFields(raw.fields);
    if (!fields.ok) return fields;
    if (Object.keys(fields.fields).length === 0) return { ok: false, error: "fields_empty" };
    patch.fields = fields.fields;
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: "nothing_to_change" };
  return { ok: true, patch };
}

// ---- how a card takes a template ---------------------------------------------------------------

/**
 * The name with every " - " / " | " segment that is nothing but `from` (any letter case) replaced by
 * `to` — a template saved by Tima as "Tima - CARS" lands on Devich's card as "Devich - CARS" (the
 * lib/own-name grammar: a login inside a longer segment, "TimaBest", is not the login). Unchanged
 * when either name is missing or they are the same login.
 */
export function swapOwnName(name: string, from: string, to: string): string {
  const n = String(name ?? "");
  const f = norm(from);
  const t = String(to ?? "").trim();
  if (!n || !f || !t || f === norm(t)) return n;
  return n
    .split(/(\s+[-|]\s+)/)
    .map((part, i) => (i % 2 === 0 && norm(part) === f ? t : part))
    .join("");
}

/**
 * The card after the template: the template's keys land on it (arrays as fresh copies), everything
 * else stays — `id`, `files`, `gcm`, `namePrefix`, `collapsed` never move. `objective` ↔
 * `conversionEvent` are kept a valid pair whenever the template touched either (an event the
 * objective does not allow falls back to that objective's first — the card's own rule). A carried
 * `page` becomes the buyer's own pick (the board's auto-fill memory is cleared, so the least-filled
 * fill never moves it). A carried `name` that repeats the template owner's login gets the applying
 * buyer's (`me`) instead.
 */
export function applyTemplate(c: Campaign, t: { fields: TemplateFields; owner?: string }, me?: string): Campaign {
  const out = { ...c } as Campaign;
  // Writes go through an untyped view: the keys are the whitelist above, the values come from
  // sanitizeTemplateFields (the store) or templateFieldsFrom (the form) — the card's own shapes.
  const w = out as unknown as Record<string, unknown>;
  const fields = t.fields ?? {};
  let touchedPage = false;
  let touchedPair = false;
  for (const k of TEMPLATE_KEYS) {
    const v = (fields as Record<string, unknown>)[k];
    if (v === undefined) continue;
    if (LIST_KEYS.has(k)) w[k] = Array.isArray(v) ? [...v] : [];
    else if (k === "name") out.name = t.owner && me ? swapOwnName(String(v), t.owner, me) : String(v);
    else w[k] = v;
    if (k === "page") touchedPage = true;
    if (k === "objective" || k === "conversionEvent") touchedPair = true;
  }
  if (touchedPair) {
    const allowed = EVENTS_BY_OBJECTIVE[out.objective] ?? EVENTS_BY_OBJECTIVE.OUTCOME_SALES;
    if (!allowed.includes(out.conversionEvent)) out.conversionEvent = allowed[0];
  }
  if (touchedPage) delete w.autoPage;
  return out;
}

// ---- who may manage -----------------------------------------------------------------------------

/** The creator (any letter case) or an owner-role login (`owner` is the SERVER's verdict — lib/roles). */
export function canManageTemplate(me: { username: string; owner?: boolean } | null | undefined, t: { owner: string }): boolean {
  if (!me) return false;
  if (me.owner) return true;
  const mine = norm(me.username);
  return mine !== "" && mine === norm(t.owner);
}

// ---- the picker ---------------------------------------------------------------------------------

export type TemplateGroup<T> = { owner: string; mine: boolean; items: T[] };

/** The buyer's own templates first (marked), then one group per other creator A→Z; inside a group
 *  the most recently updated first. The own group is named with the session's own spelling; another
 *  creator's with the first spelling seen. */
export function groupTemplates<T extends { owner: string; name: string; updatedAt: string }>(list: readonly T[], me: string): TemplateGroup<T>[] {
  const meKey = norm(me);
  const groups = new Map<string, TemplateGroup<T>>();
  for (const t of list) {
    const key = norm(t.owner);
    let g = groups.get(key);
    if (!g) {
      const mine = key !== "" && key === meKey;
      g = { owner: mine ? String(me).trim() : String(t.owner ?? "").trim(), mine, items: [] };
      groups.set(key, g);
    }
    g.items.push(t);
  }
  const at = (t: T): number => Date.parse(t.updatedAt) || 0;
  const out = [...groups.values()];
  for (const g of out) g.items.sort((a, b) => at(b) - at(a) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  out.sort((a, b) => Number(b.mine) - Number(a.mine) || a.owner.localeCompare(b.owner, undefined, { sensitivity: "base" }));
  return out;
}

/** Every typed word must be found in the name, the description or the creator (any letter case). */
export function filterTemplates<T extends { owner: string; name: string; description: string }>(list: readonly T[], query: string): T[] {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...list];
  return list.filter((t) => {
    const hay = `${t.name}\n${t.description}\n${t.owner}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

const optLabel = (arr: readonly { value: string; label: string }[], v: string | undefined): string => (v === undefined ? "" : (arr.find((o) => o.value === v)?.label ?? v));

/** The chips a picker row shows for what the template carries, in a fixed order: geo, daily budget,
 *  how it bids, what it optimizes (objective · event, else the optimization), the LION profile, the
 *  bound things (account · page · pixel). */
export function templateSummary(f: TemplateFields): string[] {
  const out: string[] = [];
  if (f.countries && f.countries.length > 0) out.push(geoSummary(f.countries));
  if (f.budget !== undefined && String(f.budget).trim() !== "") out.push(`$${moneyLabel(f.budget)}/day`);
  if (f.bidStrategy !== undefined) {
    const tag = bidTag(f.bidStrategy, f.bidCap);
    if (tag) out.push(tag);
  }
  const delivery = [optLabel(OBJECTIVES, f.objective), optLabel(CONVERSION_EVENTS, f.conversionEvent)].filter(Boolean);
  if (delivery.length) out.push(delivery.join(" · "));
  else if (f.optimization !== undefined) out.push(optLabel(OPTIMIZATIONS, f.optimization));
  if (f.profile) out.push(f.profile);
  const binds = [f.account ? "account" : "", f.page ? "page" : "", f.pixel ? "pixel" : ""].filter(Boolean);
  if (binds.length) out.push(binds.join(" · "));
  return out;
}

/** How many settings the template carries. */
export const templateFieldCount = (f: TemplateFields): number => Object.keys(f).filter((k) => KEY_SET.has(k) && (f as Record<string, unknown>)[k] !== undefined).length;

/** A short relative age for "updated …": just now / N min ago / N h ago / N d ago / DD.MM (Kyiv day). */
export function agoLabel(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diff = now - t;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} d ago`;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit" }).formatToParts(new Date(t));
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  return `${day}.${month}`;
}

// ---- the field catalog (the save form's checklist, the row's detail view) -----------------------

/** The partner facts the field list depends on (a structural slice of lib/partners PartnerConfig —
 *  that module imports React icons, so this one takes the booleans). */
export type TemplatePartnerLike = {
  usesGcm?: boolean;
  usesProfile?: boolean;
  lionLaunch?: boolean;
  aifLaunch?: boolean;
  avLaunch?: boolean;
  fanpagesFromToken?: boolean;
  accountsFromToken?: boolean;
  lockedAccount?: unknown;
  lockedPixel?: unknown;
};

export type TemplateFieldGroup = "Setup" | "Delivery" | "Creative" | "Targeting";
export type TemplateFieldDef = {
  key: TemplateKey;
  label: string;
  group: TemplateFieldGroup;
  /** The partner renders this field (missing = every partner). Entries sharing a key must be
   *  mutually exclusive, so a partner's list has one entry per key. */
  when?: (p: TemplatePartnerLike) => boolean;
  /** What the template carries for it — "—" when nothing. */
  preview: (f: TemplateFields) => string;
  /** Ticked when the save form opens (missing = yes). */
  defaultOn?: boolean;
};

export const TEMPLATE_FIELD_GROUPS: readonly TemplateFieldGroup[] = ["Setup", "Delivery", "Creative", "Targeting"];

const text = (v: string | undefined): string => (v === undefined || v === "" ? "—" : v);
const list = (arr: readonly string[] | undefined, n = 3): string => (!arr || arr.length === 0 ? "—" : arr.slice(0, n).join(", ") + (arr.length > n ? ` +${arr.length - n}` : ""));
const pick = (arr: readonly { value: string; label: string }[]) => (v: string | undefined): string => (v === undefined || v === "" ? "—" : optLabel(arr, v));

export const TEMPLATE_FIELD_DEFS: readonly TemplateFieldDef[] = [
  { key: "name", label: "Campaign name (tail)", group: "Setup", preview: (f) => text(f.name), defaultOn: false },
  { key: "profile", label: "Profile", group: "Setup", when: (p) => Boolean(p.usesProfile), preview: (f) => text(f.profile) },
  { key: "account", label: "Account", group: "Setup", when: (p) => !p.lockedAccount, preview: (f) => text(f.account) },
  { key: "toolSession", label: "TOOL profile", group: "Setup", when: (p) => Boolean(p.avLaunch), preview: (f) => (f.toolSession === undefined ? "—" : f.toolSession ? `session #${f.toolSession}` : "Auto") },
  { key: "page", label: "Page / fanpage", group: "Setup", when: (p) => !p.lockedAccount || Boolean(p.fanpagesFromToken), preview: (f) => text(f.page) },
  { key: "pixel", label: "Pixel", group: "Setup", when: (p) => !p.lockedPixel && !p.avLaunch, preview: (f) => text(f.pixel) },

  { key: "objective", label: "Objective", group: "Delivery", when: (p) => !p.aifLaunch && !p.avLaunch, preview: (f) => pick(OBJECTIVES)(f.objective) },
  { key: "optimization", label: "Optimization", group: "Delivery", when: (p) => !p.lionLaunch, preview: (f) => pick(OPTIMIZATIONS)(f.optimization) },
  { key: "bidStrategy", label: "Bid strategy", group: "Delivery", preview: (f) => pick(BID_STRATEGIES)(f.bidStrategy) },
  { key: "conversionEvent", label: "Conversion event", group: "Delivery", when: (p) => !p.aifLaunch && !p.avLaunch, preview: (f) => pick(CONVERSION_EVENTS)(f.conversionEvent) },
  { key: "budget", label: "Daily budget", group: "Delivery", preview: (f) => (f.budget === undefined || f.budget === "" ? "—" : `$${moneyLabel(f.budget)}`) },
  { key: "bidCap", label: "Bid cap / ROAS goal", group: "Delivery", preview: (f) => (f.bidCap === undefined || f.bidCap === "" ? "—" : f.bidStrategy === "LOWEST_COST_WITH_MIN_ROAS" ? `ROAS ${f.bidCap}` : `$${moneyLabel(f.bidCap)}`) },

  { key: "landing", label: "Landing", group: "Creative", when: (p) => Boolean(p.usesGcm), preview: (f) => text(f.landing) },
  { key: "landing", label: "Destination article", group: "Creative", when: (p) => Boolean(p.aifLaunch), preview: (f) => text(f.landing) },
  { key: "landing", label: "Destination", group: "Creative", when: (p) => Boolean(p.avLaunch), preview: (f) => text(f.landing) },
  { key: "link", label: "Destination link", group: "Creative", when: (p) => !p.usesGcm && !p.aifLaunch && !p.avLaunch, preview: (f) => text(f.link) },
  { key: "title", label: "Title", group: "Creative", preview: (f) => text(f.title) },
  { key: "copy", label: "Primary text", group: "Creative", preview: (f) => text(f.copy) },
  { key: "cta", label: "CTA", group: "Creative", preview: (f) => pick(CTAS)(f.cta) },
  { key: "redirectType", label: "Redirect type", group: "Creative", when: (p) => Boolean(p.lionLaunch), preview: (f) => pick(REDIRECT_TYPES)(f.redirectType) },
  { key: "headline", label: "Headline", group: "Creative", when: (p) => !p.lionLaunch, preview: (f) => text(f.headline) },

  { key: "countries", label: "Geo", group: "Targeting", preview: (f) => (!f.countries || f.countries.length === 0 ? "—" : f.countries[0] === "WW" ? "World" : f.countries.length <= 2 ? geoSummary(f.countries) : list(f.countries, 4)) },
  { key: "locales", label: "Languages", group: "Targeting", preview: (f) => list(f.locales, 3) },
  { key: "category", label: "Special category", group: "Targeting", preview: (f) => pick(CATEGORIES)(f.category) },
  { key: "placement", label: "Placement", group: "Targeting", preview: (f) => pick(PLACEMENTS)(f.placement) },
  { key: "platforms", label: "Platforms", group: "Targeting", when: (p) => Boolean(p.avLaunch), preview: (f) => (f.platforms === undefined ? "—" : optLabel(PLATFORM_CHOICES, f.platforms || DEFAULT_PLATFORM_CHOICE)) },
  { key: "ageMin", label: "Age", group: "Targeting", preview: (f) => pick(AGES)(f.ageMin) },
  { key: "userOs", label: "Devices", group: "Targeting", preview: (f) => pick(OS_OPTIONS)(f.userOs) },
];

/** The partner's own fields, in card order — one entry per key. */
export function templateFieldDefsFor(p: TemplatePartnerLike): TemplateFieldDef[] {
  const seen = new Set<TemplateKey>();
  const out: TemplateFieldDef[] = [];
  for (const d of TEMPLATE_FIELD_DEFS) {
    if (d.when && !d.when(p)) continue;
    if (seen.has(d.key)) continue;
    seen.add(d.key);
    out.push(d);
  }
  return out;
}

/** The field label a partner uses for a key (the row's detail view) — the key itself when unknown. */
export function templateFieldLabel(p: TemplatePartnerLike, key: string): string {
  return templateFieldDefsFor(p).find((d) => d.key === key)?.label ?? TEMPLATE_FIELD_DEFS.find((d) => d.key === key)?.label ?? key;
}
