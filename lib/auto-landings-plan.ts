// Auto-landings scheduling MATH — deliberately dependency-free (no "@/" imports) so
// `node --test tests/auto-landings-plan.test.ts` runs it straight off Node's type stripping,
// and so the SAME slot computation runs on the client (schedule preview) and the server
// (authoritative scheduled_at) — the two can never disagree.

/** Site-ops wall clock for the scheduler UI ("9:00" means 9:00 in Kyiv, not the buyer's TZ). */
export const SCHEDULE_TZ = "Europe/Kyiv";

export type ScheduleSpec =
  | { mode: "now" }
  | { mode: "at"; at: number } // epoch ms
  | {
      mode: "spread";
      /** First day slots may land on, "YYYY-MM-DD" in SCHEDULE_TZ. */
      startDay: string;
      /** Allowed weekdays, 0=Sun..6=Sat (Intl convention); empty = every day. */
      days: number[];
      /** Wall-clock slots per allowed day, "HH:mm", chronological or not (sorted here). */
      times: string[];
    };

export type LandingLang = "en" | "es";

export type DraftItem = { title: string; lang: LandingLang; niche: string; notes?: string };

const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** True when "YYYY-MM-DD" names a real calendar day (regex passes Feb 30 — Date rollover doesn't). */
function isRealDay(day: string): boolean {
  if (!DAY_RE.test(day)) return false;
  const [y, mo, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** What a timestamp looks like on the wall clock of `tz`. */
function wallParts(ms: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number; wd: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(ms)) parts[p.type] = p.value;
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    y: Number(parts.year),
    mo: Number(parts.month),
    d: Number(parts.day),
    h: Number(parts.hour) % 24, // "24" for midnight in some ICU versions
    mi: Number(parts.minute),
    wd: wdMap[parts.weekday ?? "Sun"] ?? 0,
  };
}

/**
 * Epoch ms of a wall-clock moment in `tz` (DST-correct to the minute): start from the UTC guess,
 * measure how the guess renders on the tz wall clock, correct by the difference, re-check once.
 */
export function zonedTimeToMs(day: string, time: string, tz: string = SCHEDULE_TZ): number {
  const tm = TIME_RE.exec(time);
  if (!isRealDay(day) || !tm) return NaN;
  const [y, mo, d] = day.split("-").map(Number);
  const h = Number(tm[1]);
  const mi = Number(tm[2]);
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const w = wallParts(guess, tz);
    const rendered = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
    const want = Date.UTC(y, mo - 1, d, h, mi);
    if (rendered === want) break;
    guess += want - rendered;
  }
  return guess;
}

/** "YYYY-MM-DD" of `ms` on the `tz` wall clock. */
export function dayInTz(ms: number, tz: string = SCHEDULE_TZ): string {
  const w = wallParts(ms, tz);
  return `${w.y}-${String(w.mo).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
}

/** Weekday (0=Sun..6=Sat) of a "YYYY-MM-DD" day in `tz`. */
export function weekdayInTz(day: string, tz: string = SCHEDULE_TZ): number {
  return wallParts(zonedTimeToMs(day, "12:00", tz), tz).wd;
}

function addDays(day: string, n: number): string {
  const [y, mo, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d + n, 12));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/**
 * One scheduled_at (epoch ms) per item, in item order. "now" → all due immediately (the worker
 * serializes). "at" → everyone at that moment. "spread" → walk days from startDay keeping only
 * the allowed weekdays, fill that day's (sorted, deduped) time slots in order, next day, … —
 * slots already in the past (before `now`) are skipped so "today 09:00" never lands a job in
 * the past. Hard horizon of 366 days guards a days/times combo that can never fill.
 * Returns null when the spec cannot place every item (bad input / horizon exhausted).
 */
export function computeScheduleSlots(
  count: number,
  spec: ScheduleSpec,
  now: number,
  tz: string = SCHEDULE_TZ,
): number[] | null {
  if (!Number.isInteger(count) || count <= 0) return null;
  if (spec.mode === "now") return Array.from({ length: count }, () => now);
  if (spec.mode === "at") {
    if (!Number.isFinite(spec.at)) return null;
    return Array.from({ length: count }, () => spec.at);
  }
  if (!isRealDay(spec.startDay)) return null;
  const days = [...new Set(spec.days)].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  const allowAll = days.length === 0;
  const times = [...new Set(spec.times)].filter((t) => TIME_RE.test(t)).sort();
  if (times.length === 0) return null;

  const out: number[] = [];
  let day = spec.startDay;
  for (let i = 0; i < 366 && out.length < count; i++, day = addDays(day, 1)) {
    if (!allowAll && !days.includes(weekdayInTz(day, tz))) continue;
    for (const t of times) {
      if (out.length >= count) break;
      const ms = zonedTimeToMs(day, t, tz);
      if (!Number.isFinite(ms) || ms < now) continue;
      out.push(ms);
    }
  }
  return out.length === count ? out : null;
}

// ---- input validation (shared by the board's compose panel and the POST route) ---------------

export const MAX_BATCH = 40;
export const TITLE_MIN = 8;
export const TITLE_MAX = 180;
export const NICHE_MAX = 40;
export const NOTES_MAX = 600;

export type DraftProblem = { index: number; error: string };

/** Normalize + validate a compose batch; returns clean items or the per-row problems. */
export function normalizeDraftItems(
  raw: unknown,
): { ok: true; items: DraftItem[] } | { ok: false; problems: DraftProblem[] } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, problems: [{ index: -1, error: "no titles" }] };
  }
  if (raw.length > MAX_BATCH) {
    return { ok: false, problems: [{ index: -1, error: `max ${MAX_BATCH} titles per batch` }] };
  }
  const problems: DraftProblem[] = [];
  const items: DraftItem[] = [];
  const seen = new Set<string>();
  raw.forEach((r, index) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const title = String(o.title ?? "").replace(/\s+/g, " ").trim();
    const lang = o.lang === "es" ? "es" : "en";
    const niche = String(o.niche ?? "").replace(/\s+/g, " ").trim().slice(0, NICHE_MAX);
    const notes = String(o.notes ?? "").trim().slice(0, NOTES_MAX);
    if (title.length < TITLE_MIN) return problems.push({ index, error: "title too short" }), undefined;
    if (title.length > TITLE_MAX) return problems.push({ index, error: "title too long" }), undefined;
    const key = `${lang}:${title.toLowerCase()}`;
    if (seen.has(key)) return problems.push({ index, error: "duplicate title in batch" }), undefined;
    seen.add(key);
    items.push({ title, lang, niche: niche || "Auto", ...(notes ? { notes } : {}) });
  });
  return problems.length ? { ok: false, problems } : { ok: true, items };
}

/** Parse an untrusted schedule payload into a ScheduleSpec (or null). */
export function parseScheduleSpec(raw: unknown): ScheduleSpec | null {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (o.mode === "now") return { mode: "now" };
  if (o.mode === "at") {
    const at = Number(o.at);
    return Number.isFinite(at) && at > 0 ? { mode: "at", at } : null;
  }
  if (o.mode === "spread") {
    const startDay = String(o.startDay ?? "");
    const days = Array.isArray(o.days) ? o.days.map(Number) : [];
    const times = Array.isArray(o.times) ? o.times.map(String) : [];
    if (!isRealDay(startDay)) return null;
    return { mode: "spread", startDay, days, times };
  }
  return null;
}
