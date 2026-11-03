import { composeDate, DAY_SECONDS, dateOf, dateText, lineDate, nextDawn, partOfDay, timeText, type ComposedDate, type DateFields } from "#shared/calendar.ts";
import { LIMITS } from "#shared/limits.ts";
import type { Calendar, LongRestStamp } from "#shared/model.ts";

/**
 * The words and small rules of the Time panel (docs/design/design-v1-calendar.md
 * 4 and 9), pure, so the panel, its dialogs and the tests read them alike.
 */

export const HOUR_SECONDS = 3_600;

/** The three fixed steps. To dawn is the fourth, and depends on the time (toDawn). */
export const STEPS = [
  { id: "m10", label: "10 minutes", by: 10 * 60 },
  { id: "h1", label: "1 hour", by: HOUR_SECONDS },
  { id: "h8", label: "8 hours", by: 8 * HOUR_SECONDS },
] as const;

export function stepName(label: string): string {
  return `Move the clock on ${label}`;
}

/** To dawn: the seconds to the next 6:00 AM, and the button's name. */
export function toDawn(now: number): { by: number; name: string } {
  const dawn = nextDawn(now);
  return { by: dawn - now, name: `Move the clock on to dawn, ${timeText(dawn)}` };
}

export type AmountUnit = "minutes" | "hours" | "days";

export const AMOUNT_UNITS: readonly { value: AmountUnit; label: string; seconds: number }[] = [
  { value: "minutes", label: "Minutes", seconds: 60 },
  { value: "hours", label: "Hours", seconds: HOUR_SECONDS },
  { value: "days", label: "Days", seconds: DAY_SECONDS },
];

export const AMOUNT_HELP = "Pick a whole number of 1 or more.";
export const TOO_FAR = "The clock can't go that far.";

/** Other amount: the seconds a count of a unit makes, or why it is not a step. */
export function amountBy(text: string, unit: AmountUnit): { ok: true; by: number } | { ok: false; reason: string } {
  const trimmed = text.trim();
  if (!/^\d{1,12}$/.test(trimmed)) return { ok: false, reason: AMOUNT_HELP };
  const count = Number(trimmed);
  if (count < 1) return { ok: false, reason: AMOUNT_HELP };
  const by = count * AMOUNT_UNITS.find((u) => u.value === unit)!.seconds;
  if (by > LIMITS.clockStepMax) return { ok: false, reason: TOO_FAR };
  return { ok: true, by };
}

/** The top bar chip's text: "Day 4, 6:00 AM" or "Deepwinter 3, 6:00 AM". */
export function chipText(t: number, calendar: Calendar): string {
  return `${dateText(t, calendar, "short")}, ${timeText(t)}`;
}

/** The chip's name and tooltip, and the panel's date block read aloud. */
export function chipName(t: number, calendar: Calendar): string {
  return `Time: ${dateText(t, calendar, "short")}, ${timeText(t)}, ${partOfDay(t)}`;
}

/** The panel's second line: "6:00 AM, Dawn". */
export function timeLine(t: number): string {
  return `${timeText(t)}, ${partOfDay(t)}`;
}

/** What the Calendar button shows beside it: "Day count", or "12 months, 7-day week". */
export function calendarSummary(calendar: Calendar): string {
  if (calendar.kind === "days") return "Day count";
  const count = calendar.months.length;
  const months = `${count} ${count === 1 ? "month" : "months"}`;
  const week = calendar.week?.length ? `, ${calendar.week.length}-day week` : "";
  return `${months}${week}`;
}

/** The fields of Set for a moment, in the calendar's own terms. */
export function fieldsOf(t: number, calendar: Calendar): DateFields {
  const date = dateOf(t, calendar);
  return calendar.kind === "days" ? { day: date.day, time: date.time } : { day: date.day, month: date.month ?? 0, year: date.year ?? 0, time: date.time };
}

/** "A Tuesday." under Set's fields, with "An" before a vowel. Empty for a calendar with no week. */
export function weekdayLine(t: number, calendar: Calendar): string {
  if (calendar.kind !== "months") return "";
  const weekday = dateOf(t, calendar).weekday;
  const name = weekday === undefined ? undefined : calendar.week?.[weekday];
  if (name === undefined) return "";
  return `${/^[aeiou]/i.test(name) ? "An" : "A"} ${name}.`;
}

/** A time field's value, "08:00", from seconds since midnight. */
export function timeValue(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Seconds since midnight from a time field's value, or null while it holds no time. */
export function timeSeconds(value: string): number | null {
  const m = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(value);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  return hour < 24 && minute < 60 ? hour * HOUR_SECONDS + minute * 60 : null;
}

/** The earliest start the rules give after a Long Rest that ended at the stamp (SRD 5.2.1, Rules Glossary, "Long Rest"). */
export const LONG_REST_GAP = 16 * HOUR_SECONDS;
/** A rest that does not move the clock is recorded as it finishes, so it began about 8 hours before now (4.5). */
const REST_LENGTH = 8 * HOUR_SECONDS;

/**
 * The DM's note on a character's last Long Rest (4.5), or null when there is
 * none to give. `movesClock` is whether the rest being chosen moves the
 * clock on 8 hours: it then starts now, so the note shows until the stamp
 * plus 16 hours. A rest that does not is recorded as it finishes, so it
 * began 8 hours before now and the note shows until the stamp plus 24. A
 * stamp after now (the clock was set back, or a step undone) reads the same.
 * The note names times only: it never says whether a rest was taken.
 */
export function restNote(o: { name: string; stamp: LongRestStamp | undefined; clockId: string; now: number; calendar: Calendar; movesClock: boolean }): string | null {
  const { stamp } = o;
  if (stamp === undefined || stamp.clock !== o.clockId) return null;
  const until = stamp.at + LONG_REST_GAP + (o.movesClock ? 0 : REST_LENGTH);
  if (o.now >= until) return null;
  return `${o.name} finished a Long Rest at ${lineDate(stamp.at, o.calendar)}. The rules let the next start from ${lineDate(stamp.at + LONG_REST_GAP, o.calendar)}.`;
}

/** The date fields of Set and Start as the DM types them: text, until composeDraft reads them. */
export type DateDraft = { day: string; month: string; year: string; time: string };

export function draftDate(t: number, calendar: Calendar): DateDraft {
  const f = fieldsOf(t, calendar);
  return { day: String(f.day), month: String(f.month ?? 0), year: String(f.year ?? 0), time: timeValue(f.time) };
}

/** The first moment of a date the DM has not chosen yet: the first day of year 1 for Months, Day 1 for Day count, at a time of day. */
export function firstDay(time: number): DateDraft {
  return { day: "1", month: "0", year: "1", time: timeValue(time) };
}

function whole(text: string): number {
  const trimmed = text.trim();
  return /^-?\d{1,15}$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/**
 * A draft as its calendar can show it (ASTRA-04): a month the calendar no
 * longer has, such as one another DM removed while Set was open, reads as
 * none, so its select asks for a month and Set names it, rather than the
 * select showing a month the draft does not hold.
 */
export function reconcileDate(draft: DateDraft, calendar: Calendar): DateDraft {
  if (calendar.kind !== "months" || draft.month === "") return draft;
  const month = whole(draft.month);
  return Number.isInteger(month) && month >= 0 && month < calendar.months.length ? draft : { ...draft, month: "" };
}

/** Day count names days from 1. composeDate takes any whole day, so a moment before Day 1 still reads back. */
export const DAY_FROM_ONE = "Pick a day from 1.";

/**
 * The draft as a moment, or the field at fault and why. `seconds` are the
 * seconds past the draft's minute it keeps (keptSeconds), added before the
 * bound is checked, so a clock at the lower bound composes back to itself.
 */
export function composeDraft(draft: DateDraft, calendar: Calendar, seconds = 0): ComposedDate {
  const time = timeSeconds(draft.time);
  const at = time === null ? -1 : time + seconds;
  if (calendar.kind === "days") {
    const day = whole(draft.day);
    if (day < 1) return { ok: false, field: "day", reason: DAY_FROM_ONE };
    return composeDate({ day, time: at }, calendar);
  }
  return composeDate({ day: whole(draft.day), month: whole(draft.month), year: whole(draft.year), time: at }, calendar);
}

/**
 * The seconds past the minute a draft keeps (CALB-O-02). The fields name a
 * moment to the minute, as a time field does, so the clock's own seconds,
 * such as a fight's 18, never show in them. While the time field still
 * reads the clock's minute, the draft keeps the clock's seconds: an
 * untouched draft then names the clock's own moment, and a date edited
 * alone moves the day and keeps the seconds. A time the DM typed is that
 * minute exactly.
 */
export function keptSeconds(draft: DateDraft, now: number): number {
  return draft.time === timeValue(floorMod(now, DAY_SECONDS)) ? floorMod(now, 60) : 0;
}

function floorMod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** What Set sends: a moment only when the DM edited the fields and they then name another than the clock's own. */
export function setAt(dirty: boolean, composed: ComposedDate, now: number): number | null {
  return dirty && composed.ok && composed.t !== now ? composed.t : null;
}
