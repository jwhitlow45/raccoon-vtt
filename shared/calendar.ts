import { LIMITS } from "./limits.ts";
import type { Calendar, CalendarMonth, Encounter, RoomClock } from "./model.ts";

/**
 * Calendar math for the room's clock (docs/design/design-v1-calendar.md 5),
 * pure, so the reducer, the server and every device read a moment alike.
 *
 * `t` is whole seconds from the calendar's first moment at midnight: Day 1
 * for Day count, the first day of year 0 for Months. Every split is by
 * floor, so moments before it read as earlier days and years rather than
 * as negative parts. The calendar changes only how `t` reads: `t`, a rest
 * stamp and a stored line keep their meaning when it changes.
 */

export const DAY_SECONDS = 86_400;
/** SRD 5.2.1, "The Order of Combat": "A round represents about 6 seconds in the game world." */
export const ROUND_SECONDS = 6;
const HOUR = 3_600;
const DAWN = 6 * HOUR;

function floorMod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** The days of a year of these months. */
export function yearDays(months: readonly CalendarMonth[]): number {
  let days = 0;
  for (const month of months) days += month.days;
  return days;
}

/** A moment read through a calendar. */
export type ClockDate = {
  /** Whole days from the calendar's first day: 0 is Day 1, or the first day of year 0. */
  dayIndex: number;
  /** Seconds since midnight, 0 to 86,399. */
  time: number;
  /** Day count: the day's number, `dayIndex + 1`. Months: the day of the month, 1 first. */
  day: number;
  /** Months only: the month's place in the calendar, 0 first. */
  month?: number;
  /** Months only. */
  year?: number;
  /** The weekday's place in the week, with a week only. */
  weekday?: number;
};

export function dateOf(t: number, calendar: Calendar): ClockDate {
  // Adding 0 turns a -0 into 0, so a moment at the first midnight reads the same however it was reached.
  const dayIndex = Math.floor(t / DAY_SECONDS) + 0;
  const time = Math.floor(t) - dayIndex * DAY_SECONDS;
  if (calendar.kind === "days") return { dayIndex, time, day: dayIndex + 1 };
  const total = Math.max(1, yearDays(calendar.months));
  const year = Math.floor(dayIndex / total) + 0;
  let left = dayIndex - year * total;
  let month = 0;
  while (month < calendar.months.length - 1 && left >= calendar.months[month]!.days) left -= calendar.months[month++]!.days;
  const week = calendar.week;
  return { dayIndex, time, day: left + 1, month, year, ...(week && week.length > 0 ? { weekday: floorMod(dayIndex, week.length) } : {}) };
}

/** The time of day, to the minute: "6:00 AM", "12:00 PM" for noon, "12:00 AM" for midnight. */
export function timeText(t: number): string {
  const minutes = Math.floor(floorMod(Math.floor(t), DAY_SECONDS) / 60);
  const hour = Math.floor(minutes / 60);
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${String(minutes % 60).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

export type PartOfDay = "Dawn" | "Morning" | "Afternoon" | "Dusk" | "Night";

/** Fixed in phase C1 (4.2): Dawn 6 to 7 AM, Morning to noon, Afternoon to 6 PM, Dusk to 7 PM, Night to 6 AM. */
export function partOfDay(t: number): PartOfDay {
  const hour = Math.floor(floorMod(Math.floor(t), DAY_SECONDS) / HOUR);
  if (hour === 6) return "Dawn";
  if (hour >= 7 && hour < 12) return "Morning";
  if (hour >= 12 && hour < 18) return "Afternoon";
  if (hour === 18) return "Dusk";
  return "Night";
}

/**
 * The date: "Day 4" for Day count. For Months, "full" is "Tuesday,
 * Deepwinter 3, 1204 AF" and "short" "Deepwinter 3", a month of one day
 * reading by its name alone, as a festival day does ("Midwinter, 1204 AF").
 */
export function dateText(t: number, calendar: Calendar, form: "full" | "short"): string {
  const date = dateOf(t, calendar);
  if (calendar.kind === "days") return `Day ${date.day}`;
  const month = calendar.months[date.month!];
  const monthDay = month === undefined ? `${date.day}` : month.days === 1 ? month.name : `${month.name} ${date.day}`;
  if (form === "short") return monthDay;
  const year = calendar.era ? `${date.year} ${calendar.era}` : `${date.year}`;
  const weekday = date.weekday === undefined ? undefined : calendar.week?.[date.weekday];
  return weekday === undefined ? `${monthDay}, ${year}` : `${weekday}, ${monthDay}, ${year}`;
}

/**
 * The date and time a clock line stores (4.7): "Day 4, 6:00 AM". Every
 * name is bounded, so the longest reads under 90 characters. The cap only
 * guards that sum.
 */
export function lineDate(t: number, calendar: Calendar): string {
  const text = `${dateText(t, calendar, "full")}, ${timeText(t)}`;
  return text.length <= LIMITS.clockDateChars ? text : Array.from(text).slice(0, LIMITS.clockDateChars).join("");
}

/** A length of time to the minute: "2 days and 3 hours", "1 hour", "less than a minute". */
export function spanText(seconds: number): string {
  const minutes = Math.floor(Math.abs(seconds) / 60);
  if (minutes < 1) return "less than a minute";
  const counts: [number, string][] = [
    [Math.floor(minutes / 1_440), "day"],
    [Math.floor((minutes % 1_440) / 60), "hour"],
    [minutes % 60, "minute"],
  ];
  const parts = counts.filter(([n]) => n > 0).map(([n, unit]) => `${n.toLocaleString("en-US")} ${unit}${n === 1 ? "" : "s"}`);
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)!}`;
}

/** The fields of a date as the DM types them: `month` and `year` for Months only, `time` in seconds since midnight. */
export type DateFields = { day: number; month?: number; year?: number; time: number };

export type ComposedDate = { ok: true; t: number } | { ok: false; field: "day" | "month" | "year" | "time"; reason: string };

/**
 * The fields as `t`, or the field that is out of range and why ("Pick a day
 * from 1 to 30."). A date past `clockSecondsMax` names the year, or for Day
 * count the day, with the reducer's own refusal. `composeDate(dateOf(t))`
 * gives `t` back for every `t` within the bound.
 */
export function composeDate(fields: DateFields, calendar: Calendar): ComposedDate {
  const { day, time } = fields;
  if (!Number.isInteger(time) || time < 0 || time >= DAY_SECONDS) return { ok: false, field: "time", reason: "Pick a time." };
  let dayIndex: number;
  let far: "day" | "year";
  if (calendar.kind === "days") {
    if (!Number.isSafeInteger(day)) return { ok: false, field: "day", reason: "Pick a whole day." };
    dayIndex = day - 1;
    far = "day";
  } else {
    const month = fields.month === undefined ? undefined : calendar.months[fields.month];
    if (fields.month === undefined || !Number.isInteger(fields.month) || month === undefined) return { ok: false, field: "month", reason: "Pick a month." };
    if (!Number.isInteger(day) || day < 1 || day > month.days) return { ok: false, field: "day", reason: `Pick a day from 1 to ${month.days}.` };
    const year = fields.year;
    if (year === undefined || !Number.isSafeInteger(year)) return { ok: false, field: "year", reason: "Pick a whole year." };
    let before = 0;
    for (let i = 0; i < fields.month; i++) before += calendar.months[i]!.days;
    dayIndex = year * yearDays(calendar.months) + before + day - 1;
    far = "year";
  }
  const t = dayIndex * DAY_SECONDS + time;
  if (!Number.isSafeInteger(t) || Math.abs(t) > LIMITS.clockSecondsMax) return { ok: false, field: far, reason: CLOCK_TOO_FAR };
  return { ok: true, t: t + 0 };
}

/** The reducer's refusal for a time or step past `clockSecondsMax`, and composeDate's for a date past it. */
export const CLOCK_TOO_FAR = "The clock can't go that far.";

/** The next 6:00 AM after `t`. At 6:00 AM exactly, the next day's. */
export function nextDawn(t: number): number {
  const dawn = Math.floor(t / DAY_SECONDS) * DAY_SECONDS + DAWN;
  return dawn > t ? dawn : dawn + DAY_SECONDS;
}

type FightView = Pick<Encounter, "round" | "activeEntryId" | "started">;

/**
 * Whether a fight has started (4.6): past round 1, or a row acting. A
 * player's projection names no active row while a row they cannot see
 * acts, and says `started` instead. A fight started and then emptied of
 * every row in round 1 reads as never started, at most 6 seconds lost.
 */
export function fightStarted(encounter: FightView | null | undefined): boolean {
  return encounter != null && (encounter.round > 1 || encounter.activeEntryId !== null || encounter.started === true);
}

/**
 * A fight's seconds, 6 a round. While it runs, the rounds before the
 * current one. At its end (`ended`), every round it ran, the current one
 * counted whole. A fight never started counts none.
 */
export function fightSeconds(encounter: FightView | null | undefined, ended: boolean): number {
  if (!fightStarted(encounter)) return 0;
  return ROUND_SECONDS * (ended ? encounter!.round : encounter!.round - 1);
}

/**
 * The one current time (5.1): the stored `t` plus the running fight's
 * seconds, held within the clock's bound for a long fight near it. Every
 * reader of "now" calls it, the reducer and every device alike.
 */
export function clockNow(clock: Pick<RoomClock, "t">, encounter: FightView | null | undefined): number {
  const now = clock.t + fightSeconds(encounter, false);
  return Math.min(LIMITS.clockSecondsMax, Math.max(-LIMITS.clockSecondsMax, now));
}
