import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Calendar } from "#shared/model.ts";
import { calendarOf, draftOf, draftYearDays, sameCalendar, startingRows, weekNames, type CalendarDraft } from "./calendarDraft.ts";

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
