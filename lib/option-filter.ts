// What a picker (components/search-select) lists, and what its filter bar counts — the pure part of the
// article / landing / quiz menu. A row is kept by three things that compose: the typed query, the niche
// picked in the menu's left column (the option's `group`) and the language picked in the row of segments
// above the list (the option's `segment`, else its `tag`). Each facet's count is the number of rows it
// WOULD show under the other two — so with Spanish picked the column says where the Spanish rows are.
import type { RichOption } from "./catalog";

/** The words of a tag, lower-cased: "ES · Lead" → ["es", "lead"]. A tag without the separator is one word. */
export function tagWords(tag: string | undefined): string[] {
  return (tag ?? "")
    .split(" · ")
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
}

/** The language segment a row belongs to: its own `segment`, else its whole tag. */
export function segmentOf(o: RichOption): string | undefined {
  return o.segment ?? o.tag;
}

export type OptionFilter = {
  query: string;
  group: string | null;
  segment: string | null;
  /** A query that IS a tag word (or a segment) filters by that alone — "pt" is the Portuguese rows, not
   *  "Captcha". For a list whose tag is a language; every other list matches such a query everywhere. */
  tagQuery?: boolean;
};

function tagHit(o: RichOption, q: string): boolean {
  return o.tag?.toLowerCase() === q || o.segment?.toLowerCase() === q || tagWords(o.tag).includes(q);
}

/** The query's own test, built once per filter pass (whether it reads as a tag is a fact of the whole list). */
function queryTest(opts: readonly RichOption[], f: OptionFilter): (o: RichOption) => boolean {
  const q = f.query.trim().toLowerCase();
  if (!q) return () => true;
  if (f.tagQuery && opts.some((o) => tagHit(o, q))) return (o) => tagHit(o, q);
  return (o) =>
    o.label.toLowerCase().includes(q) ||
    Boolean(o.meta?.toLowerCase().includes(q)) ||
    o.value.toLowerCase().includes(q) ||
    Boolean(o.group?.toLowerCase().includes(q)) ||
    tagHit(o, q);
}

/** The rows the list shows, in the catalog's order. */
export function filterOptions(opts: readonly RichOption[], f: OptionFilter): RichOption[] {
  const hit = queryTest(opts, f);
  return opts.filter((o) => (!f.group || o.group === f.group) && (!f.segment || segmentOf(o) === f.segment) && hit(o));
}

/** One niche or one language of the filter bar: all its rows, and how many the list would show now. */
export type Facet = { name: string; total: number; count: number };
export type FacetBar = {
  groups: Facet[];
  segments: Facet[];
  /** Rows in the catalog / rows in the list right now. */
  total: number;
  shown: number;
};

/** The filter bar's inventory, in catalog order. A niche's `count` follows the query and the language
 *  (not the picked niche — or picking one would zero the others); a language's follows the query and the
 *  niche. A facet that would show nothing stays in the bar at 0: the bar never reshuffles under the hand. */
export function facetBar(opts: readonly RichOption[], f: OptionFilter): FacetBar {
  const hit = queryTest(opts, f);
  const groups = new Map<string, Facet>();
  const segments = new Map<string, Facet>();
  const slot = (map: Map<string, Facet>, name: string): Facet => {
    let it = map.get(name);
    if (!it) map.set(name, (it = { name, total: 0, count: 0 }));
    return it;
  };
  let shown = 0;
  for (const o of opts) {
    const seg = segmentOf(o);
    const q = hit(o);
    const inGroup = !f.group || o.group === f.group;
    const inSegment = !f.segment || seg === f.segment;
    if (o.group) {
      const g = slot(groups, o.group);
      g.total++;
      if (q && inSegment) g.count++;
    }
    if (seg) {
      const s = slot(segments, seg);
      s.total++;
      if (q && inGroup) s.count++;
    }
    if (q && inGroup && inSegment) shown++;
  }
  return { groups: [...groups.values()], segments: [...segments.values()], total: opts.length, shown };
}
