import { yearDays, type ComposedDate } from "#shared/calendar.ts";
import { LIMITS } from "#shared/limits.ts";
import type { Calendar } from "#shared/model.ts";
import { composeDraft, firstDay, reconcileDate, type DateDraft } from "./words.ts";

/**
 * The Calendar dialog's draft (docs/design/design-v1-calendar.md 4.3): the
 * rows as the DM types them, as text, until Save turns them into a Calendar
 * the ops accept.
 */

export type MonthRow = { key: number; name: string; days: string };
export type CalendarDraft = { kind: "days" | "months"; rows: MonthRow[]; week: string; era: string };

/** The same rule as the op's names (shared/protocol.ts NAME_CHARS): no control or text direction characters. */
const NAME_CHARS = /^[^\p{Cc}\u2028\u2029\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]*$/u;

/** New Months calendars start with 12 months of 30 days. */
export function startingRows(nextKey: () => number): MonthRow[] {
  return Array.from({ length: 12 }, (_, i) => ({ key: nextKey(), name: `Month ${i + 1}`, days: "30" }));
}

export function draftOf(calendar: Calendar, nextKey: () => number): CalendarDraft {
  if (calendar.kind === "days") return { kind: "days", rows: startingRows(nextKey), week: "", era: "" };
  return {
    kind: "months",
    rows: calendar.months.map((m) => ({ key: nextKey(), name: m.name, days: String(m.days) })),
    week: (calendar.week ?? []).join(", "),
    era: calendar.era ?? "",
  };
}

/** The days of a year as the rows read now, counting only rows that hold a whole number of days. */
export function draftYearDays(rows: readonly MonthRow[]): number {
  return yearDays(rows.map((r) => ({ name: r.name, days: /^\d{1,4}$/.test(r.days.trim()) ? Number(r.days) : 0 })));
}

export function weekNames(text: string): string[] {
  return text
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n !== "");
}

export type DraftResult = { ok: true; calendar: Calendar } | { ok: false; reason: string; row?: number };

/** The draft as a Calendar, or the first reason it is not one. `row` is the month row at fault. */
export function calendarOf(draft: CalendarDraft): DraftResult {
  if (draft.kind === "days") return { ok: true, calendar: { kind: "days" } };
  if (draft.rows.length < 1) return { ok: false, reason: "Add at least one month." };
  if (draft.rows.length > LIMITS.calendarMonths) return { ok: false, reason: `Use at most ${LIMITS.calendarMonths} months.` };
  const months = [];
  for (const [i, row] of draft.rows.entries()) {
    const name = row.name.trim();
    if (name === "" || name.length > LIMITS.calendarNameChars || !NAME_CHARS.test(name)) {
      return { ok: false, reason: `Name month ${i + 1} with 1 to ${LIMITS.calendarNameChars} characters.`, row: i };
    }
    if (!/^\d{1,4}$/.test(row.days.trim()) || Number(row.days) < 1 || Number(row.days) > LIMITS.calendarMonthDays) {
      return { ok: false, reason: `Give ${name} 1 to ${LIMITS.calendarMonthDays} days.`, row: i };
    }
    months.push({ name, days: Number(row.days) });
  }
  if (yearDays(months) > LIMITS.calendarYearDays) return { ok: false, reason: `A year can hold at most ${LIMITS.calendarYearDays.toLocaleString("en-US")} days.` };
  const week = weekNames(draft.week);
  if (week.length > LIMITS.calendarWeekDays) return { ok: false, reason: `Use at most ${LIMITS.calendarWeekDays} day names.` };
  if (week.some((n) => n.length > LIMITS.calendarNameChars || !NAME_CHARS.test(n))) return { ok: false, reason: `Keep each day name to ${LIMITS.calendarNameChars} characters.` };
  const era = draft.era.trim();
  if (era.length > LIMITS.calendarEraChars || !NAME_CHARS.test(era)) return { ok: false, reason: `Keep the words after the year to ${LIMITS.calendarEraChars} characters.` };
  return { ok: true, calendar: { kind: "months", months, ...(week.length > 0 ? { week } : {}), ...(era !== "" ? { era } : {}) } };
}

export function sameCalendar(a: Calendar, b: Calendar): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * What the Calendar dialog's Save sends with a clock running (4.3): the
 * calendar when it changed, and a time only when the DM edited Today or the
 * kind changed and Today then names another moment than the clock's own.
 * Today read through a new calendar alone never moves the clock, so a
 * rename keeps the clock's seconds and writes no line (CALB-O-02). Null
 * when nothing changed.
 */
export function calendarUpdate(o: { before: Calendar; calendar: Calendar; today: ComposedDate | null; todayTouched: boolean; now: number }): { calendar?: Calendar; at?: number } | null {
  const calendarChanged = !sameCalendar(o.calendar, o.before);
  const kindChanged = o.calendar.kind !== o.before.kind;
  const at = (o.todayTouched || kindChanged) && o.today?.ok === true && o.today.t !== o.now ? o.today.t : undefined;
  if (!calendarChanged && at === undefined) return null;
  return { ...(calendarChanged ? { calendar: o.calendar } : {}), ...(at !== undefined ? { at } : {}) };
}

/**
 * A date's month as rows move or go (ASTRA-04): the month it named by its
 * row, wherever that row now is, or none once the row is removed. So a
 * date the DM chose keeps naming the same month as the calendar is edited.
 */
export function followMonth(date: DateDraft, before: readonly MonthRow[], after: readonly MonthRow[]): DateDraft {
  if (date.month === "") return date;
  const key = before[Number(date.month)]?.key;
  const at = key === undefined ? -1 : after.findIndex((r) => r.key === key);
  return { ...date, month: at < 0 ? "" : String(at) };
}

export type MonthsCalendar = Extract<Calendar, { kind: "months" }>;

/**
 * The start form's calendar and date (4.1). `months` is the last Months
 * calendar saved on the form, so picking Months again brings it back, and
 * only a Months save replaces it (ASTRA-02). `tried` shows the date's
 * errors.
 */
export type StartForm = { calendar: Calendar; months: MonthsCalendar | null; date: DateDraft; tried: boolean };

/** The start form's first date: the first day, at 8:00 AM. */
export const START_DATE: DateDraft = firstDay(8 * 3_600);
export const START_FORM: StartForm = { calendar: { kind: "days" }, months: null, date: START_DATE, tried: false };

/** A kind picked on the start form: the form with it, or "ask" when Months has no calendar yet and the Calendar dialog names one. */
export function pickStartKind(form: StartForm, kind: Calendar["kind"]): StartForm | "ask" {
  if (kind === form.calendar.kind) return form;
  if (kind === "months" && !form.months) return "ask";
  return { ...form, calendar: kind === "days" ? { kind: "days" } : form.months!, date: START_DATE, tried: false };
}

/**
 * The Calendar dialog's Save on the start form. A new kind starts the date
 * again from the first day. The same kind saved again, a rename or new
 * month lengths, keeps the date chosen with its month followed to its row,
 * and checks it against the months as they are now (ASTRA-03).
 */
export function savedToStart(form: StartForm, saved: Calendar, follow: (date: DateDraft) => DateDraft): StartForm {
  const months = saved.kind === "months" ? saved : form.months;
  if (saved.kind !== form.calendar.kind) return { calendar: saved, months, date: START_DATE, tried: false };
  const date = reconcileDate(follow(form.date), saved);
  return { calendar: saved, months, date, tried: !composeDraft(date, saved).ok };
}
