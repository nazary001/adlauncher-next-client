// Node's built-in runner (v24 strips types natively): `node --test tests/date-range.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// The date picker's arithmetic: ISO days as plain strings (no timezone anywhere — "today" is handed
// in by the caller, who knows whose day it is), Monday-first month grids, presets, the ‹ › shift,
// clamping to the report's bounds, typed input, English labels.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RANGE_PRESETS,
  addDays,
  addMonths,
  clampRange,
  diffDays,
  eachDay,
  formatDay,
  formatRange,
  isISODate,
  matchPreset,
  monthEnd,
  monthGrid,
  monthOf,
  orderedRange,
  parseDateInput,
  parseRangeQuery,
  presetRange,
  rangeDays,
  rangeQuery,
  resolveSel,
  shiftRange,
  startOfWeek,
} from "../lib/date-range.ts";

const TODAY = "2026-09-20"; // a Sunday

test("isISODate: real calendar days only", () => {
  assert.equal(isISODate("2026-09-20"), true);
  assert.equal(isISODate("2024-02-29"), true);
  assert.equal(isISODate("2026-02-29"), false);
  assert.equal(isISODate("2026-13-01"), false);
  assert.equal(isISODate("2026-9-1"), false);
  assert.equal(isISODate("20.09.2026"), false);
  assert.equal(isISODate(null), false);
});

test("addDays / diffDays / rangeDays / eachDay cross months and years", () => {
  assert.equal(addDays("2026-09-30", 1), "2026-10-01");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(diffDays("2026-09-14", "2026-09-20"), 6);
  assert.equal(diffDays("2026-09-20", "2026-09-14"), -6);
  assert.equal(rangeDays({ from: "2026-09-14", to: "2026-09-20" }), 7);
  assert.equal(rangeDays({ from: TODAY, to: TODAY }), 1);
  assert.deepEqual(eachDay({ from: "2026-09-29", to: "2026-10-02" }), ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
});

test("weeks start on Monday; months know their ends", () => {
  assert.equal(startOfWeek("2026-09-20"), "2026-09-14"); // Sunday → the Monday before
  assert.equal(startOfWeek("2026-09-14"), "2026-09-14");
  assert.equal(startOfWeek("2026-09-16"), "2026-09-14");
  assert.equal(monthOf("2026-09-20"), "2026-09");
  assert.equal(monthEnd("2026-09"), "2026-09-30");
  assert.equal(monthEnd("2024-02"), "2024-02-29");
  assert.equal(addMonths("2026-09", 1), "2026-10");
  assert.equal(addMonths("2026-01", -1), "2025-12");
  assert.equal(addMonths("2026-11", 3), "2027-02");
});

test("monthGrid: six Monday-first weeks that contain the whole month", () => {
  const g = monthGrid("2026-09"); // 1 Sep 2026 is a Tuesday
  assert.equal(g.length, 6);
  assert.ok(g.every((w) => w.length === 7));
  assert.equal(g[0][0], "2026-08-31");
  assert.equal(g[0][1], "2026-09-01");
  assert.equal(g[4][2], "2026-09-30");
  assert.equal(g[5][6], "2026-10-11");
  const feb = monthGrid("2027-02"); // 1 Feb 2027 is a Monday
  assert.equal(feb[0][0], "2027-02-01");
});

test("presets: today-inclusive by default, ending yesterday when today is excluded", () => {
  assert.deepEqual(presetRange("today", TODAY), { from: TODAY, to: TODAY });
  assert.deepEqual(presetRange("yesterday", TODAY), { from: "2026-09-19", to: "2026-09-19" });
  assert.deepEqual(presetRange("last7", TODAY), { from: "2026-09-14", to: TODAY });
  assert.deepEqual(presetRange("last7", TODAY, { includeToday: false }), { from: "2026-09-13", to: "2026-09-19" });
  assert.deepEqual(presetRange("last3", TODAY), { from: "2026-09-18", to: TODAY });
  assert.deepEqual(presetRange("last30", TODAY), { from: "2026-08-22", to: TODAY });
  assert.deepEqual(presetRange("thisWeek", TODAY), { from: "2026-09-14", to: TODAY });
  assert.deepEqual(presetRange("lastWeek", TODAY), { from: "2026-09-07", to: "2026-09-13" });
  assert.deepEqual(presetRange("thisMonth", TODAY), { from: "2026-09-01", to: TODAY });
  assert.deepEqual(presetRange("lastMonth", TODAY), { from: "2026-08-01", to: "2026-08-31" });
  // today / yesterday ignore the switch — they are named days
  assert.deepEqual(presetRange("today", TODAY, { includeToday: false }), { from: TODAY, to: TODAY });
});

test("presets excluding today: the running week/month on its first day falls back to that one day", () => {
  // Monday 14.09 with today excluded — "this week" has no closed day yet.
  assert.deepEqual(presetRange("thisWeek", "2026-09-14", { includeToday: false }), { from: "2026-09-14", to: "2026-09-14" });
  assert.deepEqual(presetRange("thisMonth", "2026-09-01", { includeToday: false }), { from: "2026-09-01", to: "2026-09-01" });
  assert.deepEqual(presetRange("thisMonth", TODAY, { includeToday: false }), { from: "2026-09-01", to: "2026-09-19" });
});

test("presets respect the first day of the data", () => {
  assert.deepEqual(presetRange("last30", TODAY, { min: "2026-09-16" }), { from: "2026-09-16", to: TODAY });
  // wholly before the data → the first day itself, never an inverted range
  assert.deepEqual(presetRange("lastMonth", TODAY, { min: "2026-09-16" }), { from: "2026-09-16", to: "2026-09-16" });
});

test("matchPreset names a range only under the same today-switch", () => {
  // On a Sunday "this week" and "last 7 days" are the same seven days — the first listed names it.
  assert.equal(matchPreset({ from: "2026-09-14", to: TODAY }, TODAY), "last7");
  assert.equal(matchPreset({ from: "2026-09-14", to: "2026-09-16" }, "2026-09-16"), "last3");
  assert.equal(matchPreset({ from: "2026-09-14", to: "2026-09-17" }, "2026-09-17"), "thisWeek");
  assert.equal(matchPreset({ from: "2026-09-13", to: "2026-09-19" }, TODAY, { includeToday: false }), "last7");
  assert.equal(matchPreset({ from: "2026-09-13", to: "2026-09-19" }, TODAY), null);
  assert.equal(matchPreset({ from: TODAY, to: TODAY }, TODAY), "today");
  assert.equal(matchPreset({ from: "2026-09-02", to: "2026-09-05" }, TODAY), null);
  // a preset whose days are all before the data names nothing (its clamp is the first day itself)
  assert.equal(matchPreset({ from: "2026-09-16", to: "2026-09-16" }, TODAY, { min: "2026-09-16" }), null);
  assert.equal(matchPreset({ from: "2026-09-16", to: "2026-09-16" }, "2026-09-16", { min: "2026-09-16" }), "today");
  assert.ok(RANGE_PRESETS.length >= 10);
});

test("shiftRange moves by the range's own length and never past the bounds", () => {
  assert.deepEqual(shiftRange({ from: TODAY, to: TODAY }, -1, { max: TODAY }), { from: "2026-09-19", to: "2026-09-19" });
  assert.equal(shiftRange({ from: TODAY, to: TODAY }, 1, { max: TODAY }), null);
  assert.deepEqual(shiftRange({ from: "2026-09-07", to: "2026-09-13" }, 1, { max: TODAY }), { from: "2026-09-14", to: TODAY });
  // a forward step that would overshoot slides back so the window keeps its length and ends on max
  assert.deepEqual(shiftRange({ from: "2026-09-10", to: "2026-09-16" }, 1, { max: TODAY }), { from: "2026-09-14", to: TODAY });
  assert.deepEqual(shiftRange({ from: "2026-09-18", to: "2026-09-19" }, -1, { min: "2026-09-16", max: TODAY }), { from: "2026-09-16", to: "2026-09-17" });
  assert.equal(shiftRange({ from: "2026-09-16", to: "2026-09-17" }, -1, { min: "2026-09-16", max: TODAY }), null);
});

test("clampRange: bounds and the longest allowed window (keeps the END of an overlong range)", () => {
  assert.deepEqual(clampRange({ from: "2026-09-01", to: "2026-09-25" }, { min: "2026-09-16", max: TODAY }), { from: "2026-09-16", to: TODAY });
  assert.deepEqual(clampRange({ from: "2026-06-01", to: "2026-09-20" }, { max: TODAY, maxDays: 31 }), { from: "2026-08-21", to: TODAY });
  assert.equal(clampRange({ from: "2026-09-21", to: "2026-09-25" }, { max: TODAY }), null);
  assert.equal(clampRange({ from: "2026-09-01", to: "2026-09-10" }, { min: "2026-09-16", max: TODAY }), null);
  assert.deepEqual(orderedRange("2026-09-20", "2026-09-14"), { from: "2026-09-14", to: "2026-09-20" });
});

test("parseDateInput: ISO, dotted / slashed day-first, English month names, today / yesterday", () => {
  assert.equal(parseDateInput("2026-09-18", TODAY), "2026-09-18");
  assert.equal(parseDateInput("18.09.2026", TODAY), "2026-09-18");
  assert.equal(parseDateInput("18/09/26", TODAY), "2026-09-18");
  assert.equal(parseDateInput(" 8.9 ", TODAY), "2026-09-08");
  assert.equal(parseDateInput("Sep 18", TODAY), "2026-09-18");
  assert.equal(parseDateInput("18 september 2025", TODAY), "2025-09-18");
  assert.equal(parseDateInput("sept 5, 2026", TODAY), "2026-09-05");
  assert.equal(parseDateInput("today", TODAY), TODAY);
  assert.equal(parseDateInput("Yesterday", TODAY), "2026-09-19");
  // a yearless day later than today means last year's (nothing is in the future here)
  assert.equal(parseDateInput("25.12", TODAY), "2025-12-25");
  assert.equal(parseDateInput("31.02.2026", TODAY), null);
  assert.equal(parseDateInput("soon", TODAY), null);
  assert.equal(parseDateInput("", TODAY), null);
});

test("labels are English and drop what repeats", () => {
  assert.equal(formatDay("2026-09-20"), "Sep 20, 2026");
  assert.equal(formatDay("2026-09-05", { year: false }), "Sep 5");
  assert.equal(formatDay("2026-09-20", { weekday: true }), "Sun, Sep 20, 2026");
  assert.equal(formatRange({ from: TODAY, to: TODAY }), "Sep 20, 2026");
  assert.equal(formatRange({ from: "2026-09-14", to: "2026-09-20" }), "Sep 14 – 20, 2026");
  assert.equal(formatRange({ from: "2026-08-28", to: "2026-09-03" }), "Aug 28 – Sep 3, 2026");
  assert.equal(formatRange({ from: "2025-12-29", to: "2026-01-04" }), "Dec 29, 2025 – Jan 4, 2026");
});

test("the URL form round-trips: presets stay relative, custom ranges stay absolute", () => {
  assert.equal(rangeQuery({ kind: "preset", id: "last7" }, true), "range=last7");
  assert.equal(rangeQuery({ kind: "preset", id: "last7" }, false), "range=last7&today=0");
  assert.equal(rangeQuery({ kind: "custom", from: "2026-09-14", to: "2026-09-18" }, true), "from=2026-09-14&to=2026-09-18");
  assert.equal(rangeQuery({ kind: "custom", from: TODAY, to: TODAY }, true), "from=2026-09-20");
  // the switch survives a reload whatever is picked
  assert.equal(rangeQuery({ kind: "custom", from: "2026-09-14", to: "2026-09-18" }, false), "from=2026-09-14&to=2026-09-18&today=0");
  assert.deepEqual(parseRangeQuery({ from: "2026-09-14", to: "2026-09-18", today: "0" }), { sel: { kind: "custom", from: "2026-09-14", to: "2026-09-18" }, includeToday: false });
  assert.deepEqual(parseRangeQuery({ range: "last7", today: "0" }), { sel: { kind: "preset", id: "last7" }, includeToday: false });
  assert.deepEqual(parseRangeQuery({ from: "2026-09-18", to: "2026-09-14" }), { sel: { kind: "custom", from: "2026-09-14", to: "2026-09-18" }, includeToday: true });
  assert.deepEqual(parseRangeQuery({ from: "2026-09-18" }), { sel: { kind: "custom", from: "2026-09-18", to: "2026-09-18" }, includeToday: true });
  assert.deepEqual(parseRangeQuery({ range: "nonsense" }), { sel: null, includeToday: true });
  assert.deepEqual(parseRangeQuery({ from: "18.09.2026" }), { sel: null, includeToday: true });
  assert.deepEqual(parseRangeQuery({}), { sel: null, includeToday: true });
});

test("resolveSel: a preset follows today, a custom range is cut to the bounds, nothing valid falls back to today", () => {
  assert.deepEqual(resolveSel({ kind: "preset", id: "last7" }, TODAY, { min: "2026-09-16" }), { from: "2026-09-16", to: TODAY });
  assert.deepEqual(resolveSel({ kind: "preset", id: "yesterday" }, "2026-09-21"), { from: TODAY, to: TODAY });
  assert.deepEqual(resolveSel({ kind: "custom", from: "2026-09-10", to: "2026-09-25" }, TODAY, { min: "2026-09-16" }), { from: "2026-09-16", to: TODAY });
  assert.deepEqual(resolveSel({ kind: "custom", from: "2026-01-01", to: "2026-09-20" }, TODAY, { maxDays: 31 }), { from: "2026-08-21", to: TODAY });
  assert.deepEqual(resolveSel({ kind: "custom", from: "2026-10-01", to: "2026-10-05" }, TODAY), { from: TODAY, to: TODAY });
});
