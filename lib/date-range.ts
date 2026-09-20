// Date-range arithmetic for the report date picker (components/date-range-picker.tsx). Pure and
// dependency-free (node --test). A day is a plain `YYYY-MM-DD` string and NOTHING here reads a
// clock or a timezone: "today" is always handed in by the caller, who knows whose day it is (the
// Snapchat report's day is São Paulo's — lib/snap-report.ts). Weeks start on Monday. All labels
// are English by construction (fixed name tables, no Intl locale lookups), whatever the browser's
// language is — the native <input type="date"> this replaces drew its calendar in the OS language.

export type DateRange = { from: string; to: string };

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

const utc = (iso: string): number => {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const pad = (n: number): string => String(n).padStart(2, "0");

/** A real calendar day in `YYYY-MM-DD` (2026-02-31 is not one). */
export function isISODate(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = ISO_RE.exec(s);
  if (!m) return false;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return false;
  return iso(Date.UTC(Number(m[1]), month - 1, Number(m[3]))) === s;
}

export const addDays = (day: string, n: number): string => iso(utc(day) + n * DAY_MS);
/** Whole days from `a` to `b` (negative when `b` is earlier). */
export const diffDays = (a: string, b: string): number => Math.round((utc(b) - utc(a)) / DAY_MS);
/** Days in the range, both ends included. */
export const rangeDays = (r: DateRange): number => diffDays(r.from, r.to) + 1;
export const orderedRange = (a: string, b: string): DateRange => (a <= b ? { from: a, to: b } : { from: b, to: a });
export const inRange = (day: string, r: DateRange): boolean => day >= r.from && day <= r.to;

export function eachDay(r: DateRange): string[] {
  const out: string[] = [];
  for (let d = r.from; d <= r.to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The Monday of the day's week. */
export const startOfWeek = (day: string): string => addDays(day, -((new Date(utc(day)).getUTCDay() + 6) % 7));

// ---------- months (`YYYY-MM`) ----------

export const monthOf = (day: string): string => day.slice(0, 7);
export const monthStart = (ym: string): string => `${ym}-01`;
export function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}`;
}
export const monthEnd = (ym: string): string => addDays(monthStart(addMonths(ym, 1)), -1);

/** Six Monday-first weeks covering the month — always six, so the calendar never changes height
 *  while the months are paged. Days outside the month are included (the picker leaves them blank). */
export function monthGrid(ym: string): string[][] {
  const first = startOfWeek(monthStart(ym));
  return Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (_, d) => addDays(first, w * 7 + d)));
}

// ---------- presets ----------

export const RANGE_PRESETS = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "last3", label: "Last 3 days" },
  { id: "last7", label: "Last 7 days" },
  { id: "last14", label: "Last 14 days" },
  { id: "last30", label: "Last 30 days" },
  { id: "thisWeek", label: "This week" },
  { id: "lastWeek", label: "Last week" },
  { id: "thisMonth", label: "This month" },
  { id: "lastMonth", label: "Last month" },
] as const;
export type RangePresetId = (typeof RANGE_PRESETS)[number]["id"];
const PRESET_IDS = new Set<string>(RANGE_PRESETS.map((p) => p.id));
export const isRangePresetId = (s: unknown): s is RangePresetId => typeof s === "string" && PRESET_IDS.has(s);
export const presetLabel = (id: RangePresetId): string => RANGE_PRESETS.find((p) => p.id === id)?.label ?? id;

export type PresetOptions = {
  /** Rolling and running presets end on today (default) or on yesterday — the last CLOSED day. */
  includeToday?: boolean;
  /** The first day there is data for; a preset never reaches before it. */
  min?: string;
};

const LAST_N: Partial<Record<RangePresetId, number>> = { last3: 3, last7: 7, last14: 14, last30: 30 };

/** The preset's days as of `today`. */
export function presetRange(id: RangePresetId, today: string, opts: PresetOptions = {}): DateRange {
  const includeToday = opts.includeToday !== false;
  const end = includeToday ? today : addDays(today, -1);
  // A running week / month that has no closed day yet (its first day, today excluded) is that one day.
  const running = (from: string): DateRange => (from <= end ? { from, to: end } : { from: today, to: today });
  let r: DateRange;
  const n = LAST_N[id];
  if (n) r = { from: addDays(end, -(n - 1)), to: end };
  else if (id === "yesterday") r = { from: addDays(today, -1), to: addDays(today, -1) };
  else if (id === "thisWeek") r = running(startOfWeek(today));
  else if (id === "lastWeek") r = { from: addDays(startOfWeek(today), -7), to: addDays(startOfWeek(today), -1) };
  else if (id === "thisMonth") r = running(monthStart(monthOf(today)));
  else if (id === "lastMonth") r = { from: monthStart(addMonths(monthOf(today), -1)), to: monthEnd(addMonths(monthOf(today), -1)) };
  else r = { from: today, to: today };
  const min = opts.min;
  if (!min || r.from >= min) return r;
  return r.to < min ? { from: min, to: min } : { from: min, to: r.to };
}

/** True when every day of the preset is before the data — it has nothing to show. */
export const presetEmpty = (id: RangePresetId, today: string, opts: PresetOptions = {}): boolean =>
  Boolean(opts.min && presetRange(id, today, { includeToday: opts.includeToday }).to < opts.min);

/** The first preset (in list order) that IS this range today, or null. An empty preset names
 *  nothing: cut to the data it collapses onto the first day, which is not what it means. */
export function matchPreset(r: DateRange, today: string, opts: PresetOptions = {}): RangePresetId | null {
  for (const p of RANGE_PRESETS) {
    if (presetEmpty(p.id, today, opts)) continue;
    const pr = presetRange(p.id, today, opts);
    if (pr.from === r.from && pr.to === r.to) return p.id;
  }
  return null;
}

// ---------- moving and clamping ----------

export type RangeBounds = { min?: string; max: string; maxDays?: number };

/** The range moved one whole length back (-1) or forward (+1). A step that would cross a bound
 *  slides so the window keeps its length and touches the bound; null when it already touches it. */
export function shiftRange(r: DateRange, dir: -1 | 1, bounds: RangeBounds): DateRange | null {
  const n = rangeDays(r);
  if (dir === 1) {
    if (r.to >= bounds.max) return null;
    const to = addDays(r.to, n) > bounds.max ? bounds.max : addDays(r.to, n);
    return { from: addDays(to, -(n - 1)), to };
  }
  if (bounds.min && r.from <= bounds.min) return null;
  const from = bounds.min && addDays(r.from, -n) < bounds.min ? bounds.min : addDays(r.from, -n);
  return { from, to: addDays(from, n - 1) };
}

/** The range cut to the bounds; an overlong one keeps its END (the recent days are the ones asked
 *  about). Null when nothing of it is inside the bounds. */
export function clampRange(r: DateRange, bounds: RangeBounds): DateRange | null {
  let from = bounds.min && r.from < bounds.min ? bounds.min : r.from;
  const to = r.to > bounds.max ? bounds.max : r.to;
  if (from > to) return null;
  if (bounds.maxDays && diffDays(from, to) + 1 > bounds.maxDays) from = addDays(to, -(bounds.maxDays - 1));
  return { from, to };
}

// ---------- typed input ----------

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const MONTH_NAMES: readonly string[] = MONTHS;
/** Monday-first two-letter column heads. */
export const WEEKDAY_HEADS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as const;

function monthIndex(word: string): number {
  const w = word.toLowerCase().replace(/\.$/, "");
  if (w.length < 3) return -1;
  if (w === "sept") return 8;
  return MONTHS.findIndex((m) => m.toLowerCase().startsWith(w));
}

/** What a person types into the From / To fields → a day, or null. Accepts `2026-09-18`,
 *  day-first `18.09.2026` / `18/09/26` / `18.09`, `Sep 18`, `18 September 2025`, `today`,
 *  `yesterday`. A day typed without a year is the latest such day that is not after `today`. */
export function parseDateInput(text: string, today: string): string | null {
  const t = String(text ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!t) return null;
  if (t === "today") return today;
  if (t === "yesterday") return addDays(today, -1);
  if (isISODate(t)) return t;

  let day = 0;
  let month = 0;
  let year: number | null = null;
  const numeric = /^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2}|\d{4}))?$/.exec(t);
  const nameFirst = /^([a-z]{3,9}\.?) (\d{1,2})(?:,? (\d{4}))?$/.exec(t);
  const dayFirst = /^(\d{1,2}) ([a-z]{3,9}\.?)(?:,? (\d{4}))?$/.exec(t);
  if (numeric) {
    day = Number(numeric[1]);
    month = Number(numeric[2]);
    if (numeric[3]) year = numeric[3].length === 2 ? 2000 + Number(numeric[3]) : Number(numeric[3]);
  } else if (nameFirst || dayFirst) {
    const m = (nameFirst ?? dayFirst)!;
    month = monthIndex(nameFirst ? m[1] : m[2]) + 1;
    day = Number(nameFirst ? m[2] : m[1]);
    if (m[3]) year = Number(m[3]);
  } else return null;
  if (month < 1) return null;

  const build = (y: number) => `${y}-${pad(month)}-${pad(day)}`;
  if (year != null) return isISODate(build(year)) ? build(year) : null;
  const thisYear = Number(today.slice(0, 4));
  const guess = build(thisYear);
  if (isISODate(guess) && guess <= today) return guess;
  return isISODate(build(thisYear - 1)) ? build(thisYear - 1) : null;
}

// ---------- labels ----------

/** "Sep 20, 2026" · `{year:false}` → "Sep 20" · `{weekday:true}` → "Sun, Sep 20, 2026". */
export function formatDay(day: string, opts: { year?: boolean; weekday?: boolean } = {}): string {
  const [y, m, d] = day.split("-").map(Number);
  const head = opts.weekday ? `${WEEKDAYS[new Date(utc(day)).getUTCDay()].slice(0, 3)}, ` : "";
  return `${head}${MONTHS[m - 1].slice(0, 3)} ${d}${opts.year === false ? "" : `, ${y}`}`;
}

/** "Sep 20, 2026" · "Sep 14 – 20, 2026" · "Aug 28 – Sep 3, 2026" · "Dec 29, 2025 – Jan 4, 2026". */
export function formatRange(r: DateRange): string {
  if (r.from === r.to) return formatDay(r.from);
  if (r.from.slice(0, 4) !== r.to.slice(0, 4)) return `${formatDay(r.from)} – ${formatDay(r.to)}`;
  if (monthOf(r.from) !== monthOf(r.to)) return `${formatDay(r.from, { year: false })} – ${formatDay(r.to)}`;
  return `${formatDay(r.from, { year: false })} – ${Number(r.to.slice(8))}, ${r.to.slice(0, 4)}`;
}

/** "September 2026". */
export const formatMonth = (ym: string): string => `${MONTHS[Number(ym.slice(5)) - 1]} ${ym.slice(0, 4)}`;

// ---------- the URL form ----------

/** What is picked: a preset stays RELATIVE (a bookmarked "last 7 days" is still the last seven
 *  days next week), a hand-picked range stays the days it was. */
export type RangeSel = { kind: "preset"; id: RangePresetId } | { kind: "custom"; from: string; to: string };

/** `range=last7` · `from=…&to=…` · `from=…` (one day); `&today=0` while the switch is off. */
export function rangeQuery(sel: RangeSel, includeToday: boolean): string {
  const q = sel.kind === "preset" ? `range=${sel.id}` : sel.from === sel.to ? `from=${sel.from}` : `from=${sel.from}&to=${sel.to}`;
  return includeToday ? q : `${q}&today=0`;
}

/** The page's search params → the selection they name; `sel: null` = nothing valid, use the default. */
export function parseRangeQuery(q: Record<string, string | string[] | undefined>): { sel: RangeSel | null; includeToday: boolean } {
  const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));
  const includeToday = one(q.today) !== "0";
  const range = one(q.range);
  if (isRangePresetId(range)) return { sel: { kind: "preset", id: range }, includeToday };
  const from = one(q.from);
  const to = one(q.to) || from;
  if (isISODate(from) && isISODate(to)) return { sel: { kind: "custom", ...orderedRange(from, to) }, includeToday };
  return { sel: null, includeToday };
}

/** The days a selection means today, cut to the bounds (never empty: a selection wholly outside
 *  them falls back to today). */
export function resolveSel(sel: RangeSel, today: string, opts: PresetOptions & { maxDays?: number } = {}): DateRange {
  const r = sel.kind === "preset" ? presetRange(sel.id, today, opts) : { from: sel.from, to: sel.to };
  return clampRange(r, { min: opts.min, max: today, maxDays: opts.maxDays }) ?? { from: today, to: today };
}
