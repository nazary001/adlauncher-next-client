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
