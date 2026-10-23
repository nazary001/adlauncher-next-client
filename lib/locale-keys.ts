// Meta ad-locale keys for the card's language list (lib/catalog LOCALES) — a static table, so a launch
// can target languages without a Graph token (VC through TOOL, owner ask 23.10). Read 23.10.2026 from
// GET /search?type=adlocale&locale=en_US (92 locales; the keys are Meta's stable ids). The "(all)"
// entries mean "no language restriction" and map to nothing; a name Meta has no ad locale for
// (Amharic, Zulu) maps to null — a launch must refuse it rather than silently target every language.
// Pure and import-free: node --test loads it straight.

export const LOCALE_KEYS: Readonly<Record<string, readonly number[] | null>> = {
  "English (US)": [6],
  "English (UK)": [24],
  "Portuguese (Brazil)": [16],
  "Portuguese (Portugal)": [31],
  "Spanish (Spain)": [7],
  German: [5],
  Italian: [10],
  Dutch: [14],
  Polish: [15],
  Romanian: [32],
  Greek: [39],
  Czech: [2],
  Hungarian: [30],
  Slovak: [33],
  Bulgarian: [37],
  Croatian: [38],
  Serbian: [42],
  Swedish: [18],
  Danish: [4],
  // Meta splits Norwegian; bokmål is what "Norwegian" means for ads.
  Norwegian: [13],
  Finnish: [8],
  Turkish: [19],
  Arabic: [28],
  Hebrew: [29],
  Russian: [17],
  Ukrainian: [52],
  Hindi: [46],
  Bengali: [45],
  Urdu: [90],
  Indonesian: [25],
  Malay: [41],
  Thai: [35],
  Vietnamese: [27],
  Filipino: [26],
  Japanese: [11],
  Korean: [12],
  "Chinese (simplified)": [20],
  // Traditional = Hong Kong + Taiwan.
  "Chinese (traditional)": [21, 22],
  Swahili: [88],
  Afrikaans: [36],
  Amharic: null,
  Zulu: null,
};

/** "(all)" = no restriction (the broadest pick, by design). */
const isAll = (name: string): boolean => /\(all\)/i.test(name);

/**
 * The ad-locale keys for a card's languages: `ids` (deduped) and `unknown` — names with no Meta ad
 * locale or not in the table. A caller refuses a launch with unknowns instead of dropping them (that
 * would broaden the targeting without anyone noticing).
 */
export function localeKeysOf(names: readonly string[]): { ids: number[]; unknown: string[] } {
  const ids = new Set<number>();
  const unknown: string[] = [];
  for (const raw of names ?? []) {
    const name = String(raw ?? "").trim();
    if (!name || isAll(name)) continue;
    const keys = Object.prototype.hasOwnProperty.call(LOCALE_KEYS, name) ? LOCALE_KEYS[name] : undefined;
    if (!keys) unknown.push(name);
    else for (const k of keys) ids.add(k);
  }
  return { ids: [...ids], unknown };
}
