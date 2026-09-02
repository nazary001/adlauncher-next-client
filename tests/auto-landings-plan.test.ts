// Node's built-in runner (v24 strips types natively): `node --test tests/auto-landings-plan.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeScheduleSlots,
  dayInTz,
  normalizeDraftItems,
  parseScheduleSpec,
  weekdayInTz,
  zonedTimeToMs,
} from "../lib/auto-landings-plan.ts";

// ---- zonedTimeToMs: Kyiv wall clock → epoch --------------------------------------------------

test("kyiv summer time is UTC+3", () => {
  // 2026-08-15 09:00 Kyiv (EEST) = 06:00 UTC
  assert.equal(zonedTimeToMs("2026-08-15", "09:00"), Date.UTC(2026, 7, 15, 6, 0));
});

test("kyiv winter time is UTC+2", () => {
  // 2026-01-15 09:00 Kyiv (EET) = 07:00 UTC
  assert.equal(zonedTimeToMs("2026-01-15", "09:00"), Date.UTC(2026, 0, 15, 7, 0));
});

test("malformed day/time → NaN", () => {
  assert.ok(Number.isNaN(zonedTimeToMs("2026-13-01", "09:00")));
  assert.ok(Number.isNaN(zonedTimeToMs("2026-01-01", "25:00")));
});

test("dayInTz and weekdayInTz agree with the wall clock", () => {
  // 2026-08-31 23:30 UTC = 2026-09-01 02:30 Kyiv (Tue)
  const ms = Date.UTC(2026, 7, 31, 23, 30);
  assert.equal(dayInTz(ms), "2026-09-01");
  assert.equal(weekdayInTz("2026-09-01"), 2);
});

// ---- computeScheduleSlots --------------------------------------------------------------------

const NOW = Date.UTC(2026, 8, 2, 6, 0); // 2026-09-02 09:00 Kyiv (Wed)

test("now → every item due immediately", () => {
  assert.deepEqual(computeScheduleSlots(3, { mode: "now" }, NOW), [NOW, NOW, NOW]);
});

test("at → every item at that moment", () => {
  const at = NOW + 3_600_000;
  assert.deepEqual(computeScheduleSlots(2, { mode: "at", at }, NOW), [at, at]);
});

test("spread fills day slots in order, skipping past slots", () => {
  // Start today (Wed 2026-09-02); slots 08:00 (already past at 09:00 Kyiv) and 15:00.
  const slots = computeScheduleSlots(
    3,
    { mode: "spread", startDay: "2026-09-02", days: [], times: ["08:00", "15:00"] },
    NOW,
  );
  assert.ok(slots);
  // 1st → today 15:00, then tomorrow 08:00 + 15:00.
  assert.equal(slots![0], zonedTimeToMs("2026-09-02", "15:00"));
  assert.equal(slots![1], zonedTimeToMs("2026-09-03", "08:00"));
  assert.equal(slots![2], zonedTimeToMs("2026-09-03", "15:00"));
});

test("spread honors weekday filter", () => {
  // Only Mondays (v=1) from Wed 2026-09-02 → first slot Mon 2026-09-07.
  const slots = computeScheduleSlots(
    2,
    { mode: "spread", startDay: "2026-09-02", days: [1], times: ["10:00"] },
    NOW,
  );
  assert.ok(slots);
  assert.equal(slots![0], zonedTimeToMs("2026-09-07", "10:00"));
  assert.equal(slots![1], zonedTimeToMs("2026-09-14", "10:00"));
});

test("spread slot ordering is chronological even when times arrive unsorted", () => {
  const slots = computeScheduleSlots(
    2,
    { mode: "spread", startDay: "2026-09-03", days: [], times: ["21:00", "07:00"] },
    NOW,
  );
  assert.ok(slots);
  assert.equal(slots![0], zonedTimeToMs("2026-09-03", "07:00"));
  assert.equal(slots![1], zonedTimeToMs("2026-09-03", "21:00"));
});

test("unplannable spread (no valid times) → null", () => {
  assert.equal(
    computeScheduleSlots(1, { mode: "spread", startDay: "2026-09-02", days: [], times: ["nope"] }, NOW),
    null,
  );
});

test("bad count → null", () => {
  assert.equal(computeScheduleSlots(0, { mode: "now" }, NOW), null);
});

// ---- normalizeDraftItems ---------------------------------------------------------------------

test("normalize trims, defaults and de-dupes", () => {
  const res = normalizeDraftItems([
    { title: "  What   Hotel Staff Never Tell Guests  ", lang: "es", niche: "" },
    { title: "Second Fine Headline", lang: "xx", niche: " Travel " },
  ]);
  assert.ok(res.ok);
  if (res.ok) {
    assert.deepEqual(res.items[0], { title: "What Hotel Staff Never Tell Guests", lang: "es", niche: "Auto" });
    assert.deepEqual(res.items[1], { title: "Second Fine Headline", lang: "en", niche: "Travel" });
  }
});

test("normalize rejects short titles and duplicates with row indexes", () => {
  const res = normalizeDraftItems([
    { title: "ok", lang: "en" },
    { title: "A Perfectly Good Headline", lang: "en" },
    { title: "a perfectly good headline", lang: "en" },
  ]);
  assert.ok(!res.ok);
  if (!res.ok) {
    assert.deepEqual(
      res.problems.map((p) => p.index),
      [0, 2],
    );
  }
});

test("normalize rejects an empty batch", () => {
  assert.equal(normalizeDraftItems([]).ok, false);
  assert.equal(normalizeDraftItems(undefined).ok, false);
});

// ---- parseScheduleSpec -----------------------------------------------------------------------

test("parse accepts the three modes and rejects junk", () => {
  assert.deepEqual(parseScheduleSpec({ mode: "now" }), { mode: "now" });
  assert.deepEqual(parseScheduleSpec({ mode: "at", at: 123 }), { mode: "at", at: 123 });
  assert.deepEqual(parseScheduleSpec({ mode: "spread", startDay: "2026-09-02", days: [1, "2"], times: ["09:00"] }), {
    mode: "spread",
    startDay: "2026-09-02",
    days: [1, 2],
    times: ["09:00"],
  });
  assert.equal(parseScheduleSpec({ mode: "at", at: "soon" }), null);
  assert.equal(parseScheduleSpec({ mode: "spread", startDay: "junk", days: [], times: [] }), null);
  assert.equal(parseScheduleSpec({ mode: "whenever" }), null);
  assert.equal(parseScheduleSpec(null), null);
});
