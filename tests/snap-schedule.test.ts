// Node's built-in runner (v24 strips types natively): `node --test tests/snap-schedule.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// Snapchat rail — lib/snap-schedule.ts: the Kyiv working hours (owner rule 22.09: paused
// 19:45–00:15 Kyiv, running 00:15–19:45) as SNAP'S OWN ad schedule — the hour list computed in
// the ad account's clock, the ad_scheduling_config shape Snap parses (`hour_of_day`), the flight.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SNAP_SCHEDULE_ACTIVE_FROM,
  SNAP_SCHEDULE_ACTIVE_UNTIL,
  SNAP_SCHEDULE_DAYS,
  SNAP_SCHEDULE_FLIGHT_DAYS,
  kyivMinuteOfDay,
  kyivWindowActive,
  snapAdSchedulingConfig,
  snapScheduleHours,
  snapScheduleRanges,
} from "../lib/snap-schedule.ts";

test("the window is the owner's: active 00:15–19:45 Kyiv, paused 19:45–00:15", () => {
  assert.equal(SNAP_SCHEDULE_ACTIVE_FROM, "00:15");
  assert.equal(SNAP_SCHEDULE_ACTIVE_UNTIL, "19:45");
  assert.equal(SNAP_SCHEDULE_FLIGHT_DAYS, 90);
});

test("the Kyiv clock through DST: UTC+3 in September, UTC+2 in January; the boundaries are exact", () => {
  assert.deepEqual(kyivMinuteOfDay(new Date("2026-09-22T16:45:00Z")), { minute: 19 * 60 + 45, hhmm: "19:45" });
  assert.deepEqual(kyivMinuteOfDay(new Date("2027-01-15T17:45:00Z")), { minute: 19 * 60 + 45, hhmm: "19:45" });
  assert.equal(kyivMinuteOfDay(new Date("2026-09-22T21:00:00Z")).hhmm, "00:00"); // midnight prints 00, never 24
  assert.equal(kyivWindowActive(new Date("2026-09-22T16:44:00Z")), true); // 19:44 — running
  assert.equal(kyivWindowActive(new Date("2026-09-22T16:45:00Z")), false); // 19:45 — stop
  assert.equal(kyivWindowActive(new Date("2026-09-22T21:14:00Z")), false); // 00:14 — stop
  assert.equal(kyivWindowActive(new Date("2026-09-22T21:15:00Z")), true); // 00:15 — run
});

test("Los Angeles (all ten accounts): the Kyiv window is LA 14–24 + 0–10 — stop 10:00–14:00 LA = 20:00–00:00 Kyiv, 20 hours a day", () => {
  const la = snapScheduleHours("America/Los_Angeles", new Date("2026-09-22T12:00:00Z")); // Kyiv UTC+3, LA UTC−7 → 10 h apart
  assert.deepEqual(la, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
  assert.equal(la.length, 20);
  assert.equal(snapScheduleRanges(la), "0–10, 14–24");
  // the same list whatever hour of the day the launch happens
  assert.deepEqual(snapScheduleHours("America/Los_Angeles", new Date("2026-09-22T23:30:00Z")), la);
  assert.deepEqual(snapScheduleHours("America/Los_Angeles", new Date("2026-09-23T03:05:00Z")), la);
  // winter: both sides off DST, still 10 h apart → the same hours
  assert.deepEqual(snapScheduleHours("America/Los_Angeles", new Date("2027-01-15T12:00:00Z")), la);
  // the one week Europe has left DST and the US has not (25.10–01.11.2026): 9 h apart → shifted by one
  assert.deepEqual(snapScheduleHours("America/Los_Angeles", new Date("2026-10-28T12:00:00Z")), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
});

test("other account clocks: São Paulo (the mock) and Kyiv itself", () => {
  assert.deepEqual(snapScheduleHours("America/Sao_Paulo", new Date("2026-09-22T12:00:00Z")), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 18, 19, 20, 21, 22, 23]); // 6 h apart
  // in Kyiv's own clock the window rounds to 00:00–20:00 (00:15 → hour 0 runs, 19:45 → hour 19 runs, 20 stops)
  assert.deepEqual(snapScheduleHours("Europe/Kyiv", new Date("2026-09-22T12:00:00Z")), Array.from({ length: 20 }, (_, h) => h));
  assert.equal(snapScheduleRanges(snapScheduleHours("Europe/Kyiv", new Date("2026-09-22T12:00:00Z"))), "0–20");
});

test("ad_scheduling_config is Snap's shape: seven weekdays, each { hour_of_day: [...] } (read live 22.09 — hours_of_day is E1001)", () => {
  const cfg = snapAdSchedulingConfig([0, 1, 14]);
  assert.deepEqual(Object.keys(cfg), [...SNAP_SCHEDULE_DAYS]);
  assert.deepEqual(SNAP_SCHEDULE_DAYS, ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);
  for (const d of SNAP_SCHEDULE_DAYS) {
    assert.deepEqual(cfg[d], { hour_of_day: [0, 1, 14] });
    assert.equal("hours_of_day" in cfg[d], false);
  }
  assert.notEqual(cfg.monday.hour_of_day, cfg.tuesday.hour_of_day); // no shared array between days
});

test("snapScheduleRanges prints contiguous runs in the account clock", () => {
  assert.equal(snapScheduleRanges([]), "");
  assert.equal(snapScheduleRanges([5]), "5–6");
  assert.equal(snapScheduleRanges([22, 23, 0, 1]), "0–2, 22–24");
  assert.equal(snapScheduleRanges(Array.from({ length: 24 }, (_, h) => h)), "0–24");
});
