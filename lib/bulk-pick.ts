// Bulk pick for the MultiSelect (every geo input on every rail shares it, plus languages/CTAs):
// a buyer pastes or types a LIST — "CI, CD, BF, MA, CM, SN, DZ, GN" — and every entry should land
// as a chip instead of the picker answering "No matches" (owner ask 24.09). Pure: no React, no DOM.
//
// A list is: text with a hard separator (comma, semicolon, pipe, newline, tab), OR words separated
// by spaces when EVERY word is an option value, an option label or a preset label ("CI CD BF",
// "PL CZ Portugal" — a two-word country name typed as a search stays a search). Tokens match an
// option by value or by label, case-insensitively; a preset label ("LATAM") expands to its codes.
// Unknown tokens are reported, never dropped silently, so the picker can say what it did not find.

export type BulkItem = { value: string; label: string };
export type BulkPreset = { label: string; codes: string[] };
export type BulkPick = { matched: string[]; unknown: string[] };

const HARD_SEP = /[,;|\r\n\t]/;

const norm = (s: string): string => s.trim().toLowerCase();

/** Resolve typed/pasted text as a list of option values; null when the text is ordinary search
 *  text (a single token, a multi-word name, blank). `matched` keeps the typed order, de-duplicated. */
export function resolveBulk(text: string, options: BulkItem[], presets: BulkPreset[] = []): BulkPick | null {
  const raw = text ?? "";
  if (!raw.trim()) return null;

  const byValue = new Map<string, string>();
  const byLabel = new Map<string, string>();
  for (const o of options) {
    byValue.set(norm(o.value), o.value);
    byLabel.set(norm(o.label), o.value);
  }
  const byPreset = new Map<string, string[]>();
  for (const p of presets) byPreset.set(norm(p.label), p.codes);

  let tokens: string[];
  if (HARD_SEP.test(raw)) {
    tokens = raw
      .split(HARD_SEP)
      .map((t) => t.trim())
      .filter(Boolean);
  } else {
    const parts = raw.trim().split(/\s+/);
    if (parts.length < 2) return null;
    if (!parts.every((p) => byValue.has(norm(p)) || byLabel.has(norm(p)) || byPreset.has(norm(p)))) return null;
    tokens = parts;
  }

  const matched: string[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  const seenUnknown = new Set<string>();
  const push = (v: string) => {
    if (seen.has(v)) return;
    seen.add(v);
    matched.push(v);
  };
  for (const t of tokens) {
    const k = norm(t);
    const v = byValue.get(k) ?? byLabel.get(k);
    if (v) {
      push(v);
      continue;
    }
    const codes = byPreset.get(k);
    if (codes) {
      for (const c of codes) push(c);
      continue;
    }
    if (!seenUnknown.has(k)) {
      seenUnknown.add(k);
      unknown.push(t);
    }
  }
  return { matched, unknown };
}

/** Union the list onto the current picks (current order first, no duplicates). An exclusive value
 *  (World) in the list replaces everything; a list of ordinary picks replaces a standing exclusive. */
export function mergeBulk(values: string[], matched: string[], exclusiveValues: string[] = []): string[] {
  const exclusive = matched.find((v) => exclusiveValues.includes(v));
  if (exclusive) return [exclusive];
  const out = values.filter((v) => !exclusiveValues.includes(v));
  for (const v of matched) if (!out.includes(v)) out.push(v);
  return out;
}
