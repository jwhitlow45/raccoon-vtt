import { yearDays } from "#shared/calendar.ts";
import { LIMITS } from "#shared/limits.ts";
import type { Calendar } from "#shared/model.ts";

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
