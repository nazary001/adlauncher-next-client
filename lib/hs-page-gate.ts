// Pure fanka-status gate for the HS rail (owner rule 2026-09-07): the launch tool works ONLY
// with fankas the hs-tools pages registry marks `state: "ok"` — every other registry state
// (banned / pub_stale / no_access / limited / stale / error / never …) AND every page the
// registry has no row for is discarded, in the pickers and at fire time alike.
//
// No env, no network here: lib/hs-pages.ts reads the registry, this file only judges — which
// is what lets the rule be unit-tested without the box. Registry states probed live 09-07
// (HS scope): ok 261 · pub_stale 17 · banned 2 · no_access 13; LION profiles also carry pages
// the box never registered (all RENT pools) — those read as "" here and are refused as
// unregistered until the box learns them.

export const HS_PAGE_OK_STATE = "ok";

/** Registry `state` per page id. A page absent from the map has no registry row at all. */
export type PageStates = Readonly<Record<string, string>>;

export type PageGateVerdict =
  | { ok: true; state: "ok" }
  /** `state` = the registry's word ("banned", "pub_stale", …); "" = no registry row. */
  | { ok: false; state: string; reason: string };

const normalizeState = (state: unknown): string => String(state ?? "").trim().toLowerCase();

/** One page's verdict. `name` (catalog display name) only decorates the refusal text. */
export function pageGateVerdict(pageId: string, states: PageStates, name?: string): PageGateVerdict {
  const state = normalizeState(states[pageId]);
  if (state === HS_PAGE_OK_STATE) return { ok: true, state: HS_PAGE_OK_STATE };
  const who = `fanka ${pageId}${name ? ` (${name})` : ""}`;
  const why = state
    ? `is ${state.toUpperCase()} in hs-tools`
    : "is not registered in hs-tools (no OK status)";
  return { ok: false, state, reason: `${who} ${why} — only OK fankas may launch` };
}

/**
 * Registry rows → page id → state. EVERY row counts, not just the ones the box has meter
 * numbers for (has_data): a `no_access` page has no numbers but very much has a state, and
 * that state is exactly what gates it. Rows without an id or a state are dropped (unknown ≠ ok).
 */
export function registryRowStates(
  rows: ReadonlyArray<{ page_id?: unknown; state?: unknown }>,
): Record<string, string> {
  const states: Record<string, string> = {};
  for (const r of rows) {
    const id = String(r?.page_id ?? "").trim();
    const state = normalizeState(r?.state);
    if (!id || !state) continue;
    states[id] = state;
  }
  return states;
}

/** A profile's page catalog split into what the pickers may offer (ok) and what they hide. */
export function gatePages<T extends { id: string }>(
  pages: readonly T[],
  states: PageStates,
): { offered: T[]; hidden: T[] } {
  const offered: T[] = [];
  const hidden: T[] = [];
  for (const p of pages) (pageGateVerdict(p.id, states).ok ? offered : hidden).push(p);
  return { offered, hidden };
}

/**
 * One refusal line for a launch's page set (a JURO source can carry several fankas) — the first
 * offender's reason, plus how many more there are. null = every page is ok.
 */
export function pageGateRefusal(
  pages: ReadonlyArray<{ id: string; name?: string }>,
  states: PageStates,
): string | null {
  const refused = pages
    .map((p) => pageGateVerdict(p.id, states, p.name))
    .filter((v): v is Extract<PageGateVerdict, { ok: false }> => !v.ok);
  if (refused.length === 0) return null;
  const more = refused.length - 1;
  return more > 0 ? `${refused[0].reason} (+${more} more)` : refused[0].reason;
}

// ---- the page NAME as a verdict (owner ask 16.10) -----------------------------------------------
// The HS team marks a fanpage Facebook will not let advertise by RENAMING it — "Lisa4 | (Not
// Eligible)" (live 16.10: three such pages were offered on every glo-01 profile — registry state ok,
// 0/250 — so the "least filled" default landed exactly on them). Such a page is hidden from the
// pickers like a non-OK registry row, on every team (the mark is in LION's own catalog, no registry
// needed), and counted next to the registry's hidden ones in the same line under the Page field.

const NAME_MARKS: ReadonlyArray<readonly [RegExp, string]> = [
  [/not[\s_-]*eligible|ineligible/i, "not eligible"],
  [/unavailable|not[\s_-]*available/i, "unavailable"],
  [/restricted/i, "restricted"],
  [/disabled/i, "disabled"],
  [/banned/i, "banned"],
  [/blocked/i, "blocked"],
];

/** The mark a page's name carries — "not eligible" for "Lisa4 | (Not Eligible)" — or null for a plain
 *  name. Only a SEPARATED tag counts: a parenthesised / bracketed part, or the last `|`-separated
 *  segment. A persona merely called "Blocker Jones" or "Unavailable Shop" is not marked. */
export function pageNameMark(name: unknown): string | null {
  const s = String(name ?? "");
  if (!s) return null;
  const tags: string[] = [];
  for (const m of s.matchAll(/[(\[]([^()[\]]*)[)\]]/g)) tags.push(m[1]);
  const segments = s.split("|");
  if (segments.length > 1) tags.push(segments[segments.length - 1]);
  for (const tag of tags) {
    const t = tag.trim();
    if (!t) continue;
    for (const [re, word] of NAME_MARKS) if (re.test(t)) return word;
  }
  return null;
}

/** A profile's page catalog split into the pages whose name carries no mark (offered, same objects,
 *  same order) and the marked ones (hidden). */
export function splitMarkedPages<T extends { name?: unknown }>(pages: readonly T[]): { offered: T[]; marked: T[] } {
  const offered: T[] = [];
  const marked: T[] = [];
  for (const p of pages) (pageNameMark(p.name) ? marked : offered).push(p);
  return { offered, marked };
}

export type HiddenFankas = {
  /** Hidden by the registry gate (not OK / unregistered in hs-tools). */
  hidden: number;
  /** Hidden for the mark in their name ("(Not Eligible)" …). */
  marked: number;
};

const count = (n: number): number => Math.max(0, Math.round(Number(n) || 0));

/** Why the hidden fankas are hidden — "4 not OK in hs-tools · 3 not eligible", one reason bare when
 *  it is the only one. null = nothing hidden. */
export function hiddenFankasWhy(c: HiddenFankas): string | null {
  const hidden = count(c.hidden);
  const marked = count(c.marked);
  if (hidden + marked === 0) return null;
  if (marked === 0) return "not OK in hs-tools";
  if (hidden === 0) return "not eligible";
  return `${hidden} not OK in hs-tools · ${marked} not eligible`;
}

/** The line under a Page picker that still offers pages: "7 fankas hidden — 4 not OK in hs-tools ·
 *  3 not eligible". null = nothing hidden (no line). */
export function hiddenFankasNote(c: HiddenFankas): string | null {
  const why = hiddenFankasWhy(c);
  if (!why) return null;
  const total = count(c.hidden) + count(c.marked);
  return `${total} fanka${total === 1 ? "" : "s"} hidden — ${why}`;
}

/** The empty-list hint when the rule hid EVERY page of the profile. null = nothing was hidden (the
 *  profile simply has no pages). */
export function noFankasOfferedNote(c: HiddenFankas): string | null {
  const why = hiddenFankasWhy(c);
  if (!why) return null;
  const total = count(c.hidden) + count(c.marked);
  return `No fankas offered on this profile — all ${total} hidden (${why})`;
}
