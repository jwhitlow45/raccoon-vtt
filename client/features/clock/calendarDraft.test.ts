import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LIMITS } from "#shared/limits.ts";
import type { Calendar } from "#shared/model.ts";
import { calendarOf, calendarUpdate, draftOf, followMonth, pickStartKind, savedToStart, START_DATE, START_FORM, draftYearDays, sameCalendar, startingRows, weekNames, type CalendarDraft } from "./calendarDraft.ts";

let key = 0;
const next = () => ++key;
const months = (rows: [string, string][], over: Partial<CalendarDraft> = {}): CalendarDraft => ({ kind: "months", rows: rows.map(([name, days]) => ({ key: next(), name, days })), week: "", era: "", ...over });

describe("the Calendar dialog's draft", () => {
  test("new Months calendars start with 12 rows of 30 days", () => {
    const rows = startingRows(next);
    assert.equal(rows.length, 12);
    assert.deepEqual([rows[0]!.name, rows[11]!.name, rows[0]!.days], ["Month 1", "Month 12", "30"]);
    assert.equal(draftYearDays(rows), 360);
  });

  test("a calendar becomes a draft and back", () => {
    const cal: Calendar = { kind: "months", months: [{ name: "Thaw", days: 31 }, { name: "Frost", days: 1 }], week: ["Sun", "Mon"], era: "AF" };
    const result = calendarOf(draftOf(cal, next));
    assert.deepEqual(result, { ok: true, calendar: cal });
    assert.deepEqual(calendarOf(draftOf({ kind: "days" }, next)), { ok: true, calendar: { kind: "days" } });
  });

  test("names are trimmed, an empty week and era are left out", () => {
    const result = calendarOf(months([[" Thaw ", "30"]], { week: " , ,", era: "  " }));
    assert.deepEqual(result, { ok: true, calendar: { kind: "months", months: [{ name: "Thaw", days: 30 }] } });
    assert.deepEqual(weekNames("Mon, Tue ,,Wed"), ["Mon", "Tue", "Wed"]);
  });

  test("the row at fault is named with the reason", () => {
    assert.deepEqual(calendarOf(months([["Thaw", "30"], ["", "30"]])), { ok: false, reason: "Name month 2 with 1 to 24 characters.", row: 1 });
    assert.deepEqual(calendarOf(months([["Thaw", "0"]])), { ok: false, reason: "Give Thaw 1 to 400 days.", row: 0 });
    assert.deepEqual(calendarOf(months([["Thaw", "401"]])), { ok: false, reason: "Give Thaw 1 to 400 days.", row: 0 });
    assert.equal(calendarOf(months([["Thaw", "3.5"]])).ok, false);
    assert.equal(calendarOf(months([["a\u202Eb", "30"]])).ok, false);
    assert.equal(calendarOf(months([])).ok, false);
  });

  test("the limits: months, year length, week, names and era", () => {
    const many = Array.from({ length: 25 }, (_, i): [string, string] => [`M${i}`, "1"]);
    assert.equal(calendarOf(months(many)).ok, false);
    assert.equal(calendarOf(months(many.slice(0, 24))).ok, true);
    assert.equal(calendarOf(months([["A", "400"], ["B", "400"], ["C", "201"]])).ok, false);
    assert.equal(calendarOf(months([["A", "400"], ["B", "400"], ["C", "200"]])).ok, true);
    assert.equal(calendarOf(months([["A", "30"]], { week: Array.from({ length: 15 }, (_, i) => `d${i}`).join(",") })).ok, false);
    assert.equal(calendarOf(months([["A", "30"]], { week: "x".repeat(25) })).ok, false);
    assert.equal(calendarOf(months([["A", "30"]], { era: "x".repeat(13) })).ok, false);
    assert.equal(calendarOf(months([["x".repeat(25), "30"]])).ok, false);
  });

  test("a year's days count the rows as they are edited, a bad row as none", () => {
    assert.equal(draftYearDays(months([["A", "30"], ["B", "x"], ["C", "5"]]).rows), 35);
  });

  test("two calendars are the same when they read alike", () => {
    assert.equal(sameCalendar({ kind: "days" }, { kind: "days" }), true);
    assert.equal(sameCalendar({ kind: "days" }, { kind: "months", months: [{ name: "A", days: 1 }] }), false);
  });
});

describe("what the Calendar dialog's Save sends (CALB-O-02, ASTRA-01)", () => {
  const MONTHS: Calendar = { kind: "months", months: [{ name: "Deepwinter", days: 30 }, { name: "Thaw", days: 30 }] };
  const RENAMED: Calendar = { kind: "months", months: [{ name: "Frost", days: 30 }, { name: "Thaw", days: 30 }] };
  // After a 3-round fight: 8:00:18 on the clock, 8:00 in the fields.
  const now = 8 * 3_600 + 18;

  test("a rename sends the calendar alone, whatever Today reads through it", () => {
    assert.deepEqual(calendarUpdate({ before: MONTHS, calendar: RENAMED, today: { ok: true, t: now - 18 }, todayTouched: false, now }), { calendar: RENAMED });
  });

  test("an unchanged calendar sends nothing, at the lower bound too", () => {
    assert.equal(calendarUpdate({ before: MONTHS, calendar: MONTHS, today: { ok: true, t: now - 18 }, todayTouched: false, now }), null);
    const low = -LIMITS.clockSecondsMax;
    assert.equal(calendarUpdate({ before: { kind: "days" }, calendar: { kind: "days" }, today: { ok: false, field: "day", reason: "Pick a day from 1." }, todayTouched: false, now: low }), null);
  });

  test("an edited Today sends its moment only when it names another", () => {
    assert.deepEqual(calendarUpdate({ before: MONTHS, calendar: MONTHS, today: { ok: true, t: now + 86_400 }, todayTouched: true, now }), { at: now + 86_400 });
    assert.equal(calendarUpdate({ before: MONTHS, calendar: MONTHS, today: { ok: true, t: now }, todayTouched: true, now }), null);
  });

  test("a kind change sends the first day's moment, untouched or not", () => {
    assert.deepEqual(calendarUpdate({ before: { kind: "days" }, calendar: MONTHS, today: { ok: true, t: 60 * 86_400 + now }, todayTouched: false, now }), { calendar: MONTHS, at: 60 * 86_400 + now });
  });
});

describe("a date as the calendar is edited (ASTRA-03, ASTRA-04)", () => {
  const rows = [{ key: 1, name: "Deepwinter", days: "30" }, { key: 2, name: "Thaw", days: "30" }, { key: 3, name: "Bloom", days: "30" }];
  const date = { day: "4", month: "1", year: "1204", time: "06:00" };

  test("its month follows its row as rows move, and reads as none once the row goes", () => {
    assert.equal(followMonth(date, rows, [rows[1]!, rows[0]!, rows[2]!]).month, "0");
    assert.equal(followMonth(date, rows, [rows[0]!, rows[2]!]).month, "");
    assert.equal(followMonth(date, rows, rows).month, "1");
    assert.equal(followMonth({ ...date, month: "" }, rows, rows).month, "");
  });
});

describe("the start form (ASTRA-02, ASTRA-03)", () => {
  const MONTHS: Calendar = { kind: "months", months: [{ name: "Deepwinter", days: 30 }, { name: "Thaw", days: 30 }] };
  const keep = (d: typeof START_DATE) => d;

  test("Months with no calendar yet asks for one, and Day count saved from that dialog keeps Months asking", () => {
    assert.equal(pickStartKind(START_FORM, "months"), "ask");
    const days = savedToStart(START_FORM, { kind: "days" }, keep);
    assert.equal(days.months, null);
    assert.equal(pickStartKind(days, "months"), "ask");
  });

  test("a Day count save keeps the Months calendar, so Months picks it again", () => {
    const months = savedToStart(START_FORM, MONTHS, keep);
    assert.deepEqual(months.calendar, MONTHS);
    const days = savedToStart(months, { kind: "days" }, keep);
    assert.deepEqual(days.calendar, { kind: "days" });
    assert.deepEqual(days.months, MONTHS);
    const again = pickStartKind(days, "months");
    assert.notEqual(again, "ask");
    assert.deepEqual(again !== "ask" && again.calendar, MONTHS);
  });

  test("a same-kind save keeps the date chosen, and one a shorter month no longer holds shows its error", () => {
    const months = { ...savedToStart(START_FORM, MONTHS, keep), date: { day: "30", month: "1", year: "1204", time: "06:00" } };
    const renamed: Calendar = { kind: "months", months: [{ name: "Frost", days: 30 }, { name: "Thaw", days: 30 }] };
    const kept = savedToStart(months, renamed, keep);
    assert.deepEqual(kept.date, months.date);
    assert.equal(kept.tried, false);
    const shorter = savedToStart(months, { kind: "months", months: [{ name: "Frost", days: 30 }, { name: "Thaw", days: 28 }] }, keep);
    assert.deepEqual(shorter.date, months.date);
    assert.equal(shorter.tried, true, "Pick a day from 1 to 28 shows at once");
    const removed = savedToStart(months, { kind: "months", months: [{ name: "Frost", days: 30 }] }, (d) => ({ ...d, month: "" }));
    assert.equal(removed.date.month, "");
    assert.equal(removed.tried, true);
  });

  test("a kind change starts the date again from the first day", () => {
    const months = { ...savedToStart(START_FORM, MONTHS, keep), date: { day: "9", month: "1", year: "1204", time: "06:00" } };
    assert.deepEqual(savedToStart(months, { kind: "days" }, keep).date, START_DATE);
  });
});
