// Snapchat rail — the KYIV WORKING HOURS of our campaigns, done on SNAPCHAT'S side (owner rule
// 22.09: "19:45–00:15 stop, 00:15–19:45 active", Kyiv wall clock, every day; "it must live on
// Snapchat, no cron"). Pure and dependency-free (node --test).
//
// Snap's ad squads take `ad_scheduling_config` — per weekday a list of whole hours
// (`hour_of_day`, 0–23). Read live 22.09 on our paused test ad squad: the key parses; an ad squad
// with a schedule MUST carry a lifetime budget (E2764 "requires ad squad life time budget"), and an
// existing daily-budget ad squad cannot be switched to lifetime (E2759) — so the schedule is set at
// BIRTH, and a launch with it is born on a lifetime budget (the buyer's daily amount × the flight
// length; the campaign is capped at the daily amount). Hours are whole, so the owner's quarter
// hours land on the nearest hour: an hour runs when its midpoint (hh:30) falls inside the Kyiv
// window — 00:15–19:45 Kyiv becomes 00:00–20:00 Kyiv, 20 hours a day. Snap's docs say the hours
// run in each viewer's local timezone; the owner chose this knowingly — the hours are computed in
// the AD ACCOUNT's timezone (all ten are America/Los_Angeles) so they coincide with Kyiv.

export const SNAP_SCHEDULE_TZ = "Europe/Kyiv";
/** Active from this Kyiv minute of day (inclusive) … */
export const SNAP_SCHEDULE_ACTIVE_FROM = "00:15";
/** … until this one (exclusive): 19:45 → paused. */
export const SNAP_SCHEDULE_ACTIVE_UNTIL = "19:45";
/** The flight of a scheduled ad squad: lifetime budget = daily × this, end_time = start + this. */
export const SNAP_SCHEDULE_FLIGHT_DAYS = 90;
export const SNAP_SCHEDULE_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

const hm = (s: string): number => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};
const ACTIVE_FROM_MIN = hm(SNAP_SCHEDULE_ACTIVE_FROM);
const ACTIVE_UNTIL_MIN = hm(SNAP_SCHEDULE_ACTIVE_UNTIL);

function clockIn(tz: string, at: Date): { hour: number; minute: number } {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" })
    .formatToParts(at)
    .reduce<Record<string, string>>((acc, x) => ((acc[x.type] = x.value), acc), {});
  return { hour: Number(p.hour) % 24, minute: Number(p.minute) };
}

/** Kyiv wall clock of `at`, as minutes of day and "HH:MM" (Node's ICU knows Europe/Kyiv; an
 *  older ICU spells it Europe/Kiev). */
export function kyivMinuteOfDay(at: Date): { minute: number; hhmm: string } {
  let c: { hour: number; minute: number };
  try {
    c = clockIn(SNAP_SCHEDULE_TZ, at);
  } catch {
    c = clockIn("Europe/Kiev", at);
  }
  return { minute: c.hour * 60 + c.minute, hhmm: `${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}` };
}

/** Is the Kyiv clock inside the active window at `at`? */
export const kyivWindowActive = (at: Date): boolean => {
  const m = kyivMinuteOfDay(at).minute;
  return m >= ACTIVE_FROM_MIN && m < ACTIVE_UNTIL_MIN;
};

/**
 * The hours of the ad account's day (0–23, ascending) during which the Kyiv window is open —
 * an hour counts when its midpoint is inside the window. Walked over the 24 hours that follow
 * `now`, so the Kyiv↔account offset is the one in force at launch (DST on either side is taken
 * as it stands that day). Every weekday gets the same list: the window is daily.
 */
export function snapScheduleHours(accountTz: string, now: Date = new Date()): number[] {
  const on = new Set<number>();
  const top = new Date(now);
  top.setUTCMinutes(0, 0, 0);
  for (let k = 0; k < 24; k++) {
    const mid = new Date(top.getTime() + k * 3_600_000 + 30 * 60_000);
    if (kyivWindowActive(mid)) on.add(clockIn(accountTz, mid).hour);
  }
  return [...on].sort((a, b) => a - b);
}

/** Snap's `ad_scheduling_config`: the same hours on every weekday. */
export function snapAdSchedulingConfig(hours: number[]): Record<(typeof SNAP_SCHEDULE_DAYS)[number], { hour_of_day: number[] }> {
  return Object.fromEntries(SNAP_SCHEDULE_DAYS.map((d) => [d, { hour_of_day: [...hours] }])) as Record<(typeof SNAP_SCHEDULE_DAYS)[number], { hour_of_day: number[] }>;
}

/** "14–24, 0–10" — the account-clock ranges a hour list covers (for the card and the row). */
export function snapScheduleRanges(hours: number[]): string {
  const set = new Set(hours);
  const out: string[] = [];
  let start: number | null = null;
  for (let h = 0; h <= 24; h++) {
    const on = h < 24 && set.has(h);
    if (on && start === null) start = h;
    if (!on && start !== null) {
      out.push(`${start}–${h}`);
      start = null;
    }
  }
  return out.join(", ");
}

/** What snapLaunchWire takes as `resolved.schedule`: the account-clock hours at `now`, the flight,
 *  Snap's config. */
export function snapResolvedSchedule(accountTz: string, now: Date = new Date()): { hours: number[]; tz: string; flightDays: number; config: ReturnType<typeof snapAdSchedulingConfig> } {
  const hours = snapScheduleHours(accountTz, now);
  return { hours, tz: accountTz, flightDays: SNAP_SCHEDULE_FLIGHT_DAYS, config: snapAdSchedulingConfig(hours) };
}

/** The one line the launcher prints beside the budget. */
export const SNAP_SCHEDULE_NOTE = `Kyiv hours ${SNAP_SCHEDULE_ACTIVE_FROM}–${SNAP_SCHEDULE_ACTIVE_UNTIL} (rounded to whole hours by Snap: 00:00–20:00)`;
