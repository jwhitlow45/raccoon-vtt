import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Calendar } from "#shared/model.ts";
import { LIMITS } from "#shared/limits.ts";
import { amountBy, calendarSummary, chipName, chipText, composeDraft, draftDate, restNote, stepName, STEPS, timeSeconds, timeValue, toDawn, weekdayLine } from "./words.ts";

const DAY = 86_400;
const H = 3_600;
const MONTHS: Calendar = {
  kind: "months",
  months: [
    { name: "Deepwinter", days: 30 },
    { name: "Midwinter", days: 1 },
    { name: "Thaw", days: 30 },
  ],
  week: ["Moonday", "Tuesday", "Octday"],
  era: "AF",
};
const DAYS: Calendar = { kind: "days" };

describe("the steps' names", () => {
  test("each step says what it does", () => {
    assert.deepEqual(STEPS.map((s) => stepName(s.label)), ["Move the clock on 10 minutes", "Move the clock on 1 hour", "Move the clock on 8 hours"]);
    assert.deepEqual(STEPS.map((s) => s.by), [600, 3600, 28_800]);
  });

  test("To dawn is the next 6:00 AM, the next day's at exactly 6:00 AM", () => {
    assert.deepEqual(toDawn(22 * H), { by: 8 * H, name: "Move the clock on to dawn, 6:00 AM" });
    assert.equal(toDawn(6 * H).by, DAY);
    assert.equal(toDawn(5 * H + 59 * 60).by, 60);
  });
});

describe("Other amount", () => {
  test("whole counts of a unit become seconds", () => {
    assert.deepEqual(amountBy("90", "minutes"), { ok: true, by: 5_400 });
    assert.deepEqual(amountBy(" 2 ", "hours"), { ok: true, by: 7_200 });
    assert.deepEqual(amountBy("3", "days"), { ok: true, by: 3 * DAY });
  });

  test("anything else names a reason", () => {
    for (const text of ["", "0", "-1", "1.5", "two", "1e3"]) assert.equal(amountBy(text, "hours").ok, false, text);
  });

  test("a step past the limit is refused with the clock's own words", () => {
    const days = Math.floor(LIMITS.clockStepMax / DAY);
    assert.equal(amountBy(String(days), "days").ok, true);
    assert.deepEqual(amountBy(String(days + 1), "days"), { ok: false, reason: "The clock can't go that far." });
  });
});

describe("the chip and the summary", () => {
  test("Day count and Months read short in the chip, with the part of the day in its name", () => {
    assert.equal(chipText(3 * DAY + 6 * H, DAYS), "Day 4, 6:00 AM");
    assert.equal(chipName(3 * DAY + 6 * H, DAYS), "Time: Day 4, 6:00 AM, Dawn");
    assert.equal(chipText(2 * DAY + 6 * H, MONTHS), "Deepwinter 3, 6:00 AM");
  });

  test("the calendar's value beside its button", () => {
    assert.equal(calendarSummary(DAYS), "Day count");
    assert.equal(calendarSummary(MONTHS), "3 months, 3-day week");
    assert.equal(calendarSummary({ kind: "months", months: [{ name: "Year", days: 360 }] }), "1 month");
  });
});

describe("the date fields", () => {
  test("a moment's fields compose back to it, for both calendars", () => {
    for (const [t, cal] of [[3 * DAY + 8 * H, DAYS], [75 * DAY + 14 * H + 30 * 60, MONTHS], [-5 * DAY + H, MONTHS]] as const) {
      const composed = composeDraft(draftDate(t, cal), cal);
      assert.deepEqual(composed, { ok: true, t });
    }
  });

  test("a day past the month, or no time, names the field and why", () => {
    const draft = draftDate(0, MONTHS);
    assert.deepEqual(composeDraft({ ...draft, day: "31" }, MONTHS), { ok: false, field: "day", reason: "Pick a day from 1 to 30." });
    assert.deepEqual(composeDraft({ ...draft, month: "1", day: "2" }, MONTHS), { ok: false, field: "day", reason: "Pick a day from 1 to 1." });
    assert.deepEqual(composeDraft({ ...draft, time: "" }, MONTHS), { ok: false, field: "time", reason: "Pick a time." });
    assert.equal(composeDraft({ ...draft, year: "abc" }, MONTHS).ok, false);
  });

  test("the weekday reads out under the date, An before a vowel, nothing with no week", () => {
    assert.equal(weekdayLine(DAY, MONTHS), "A Tuesday.");
    assert.equal(weekdayLine(2 * DAY, MONTHS), "An Octday.");
    assert.equal(weekdayLine(0, { kind: "months", months: [{ name: "Year", days: 360 }] }), "");
    assert.equal(weekdayLine(0, DAYS), "");
  });

  test("a time field's value and seconds", () => {
    assert.equal(timeValue(8 * H), "08:00");
    assert.equal(timeValue(23 * H + 59 * 60), "23:59");
    assert.equal(timeSeconds("08:00"), 8 * H);
    assert.equal(timeSeconds("08:00:30"), 8 * H);
    assert.equal(timeSeconds("24:00"), null);
    assert.equal(timeSeconds(""), null);
  });
});

describe("the note on a character's last Long Rest (4.5)", () => {
  const stamp = { at: 3 * DAY + 6 * H, clock: "c1" };
  const note = (now: number, movesClock: boolean, over: Partial<{ clockId: string; stamp: typeof stamp | undefined }> = {}) =>
    restNote({ name: "Bree", stamp: "stamp" in over ? over.stamp : stamp, clockId: over.clockId ?? "c1", now, calendar: DAYS, movesClock });

  test("gives the last finish and the earliest next start", () => {
    assert.equal(note(stamp.at + 6 * H, true), "Bree finished a Long Rest at Day 4, 6:00 AM. The rules let the next start from Day 4, 10:00 PM.");
  });

  test("a rest that moves the clock: a line at 15 h 59 min after the stamp, none at 16 h", () => {
    assert.notEqual(note(stamp.at + 16 * H - 60, true), null);
    assert.equal(note(stamp.at + 16 * H, true), null);
  });

  test("a rest that does not move the clock began about 8 hours back: a line at 23 h 59 min, none at 24 h", () => {
    assert.notEqual(note(stamp.at + 24 * H - 60, false), null);
    assert.equal(note(stamp.at + 24 * H, false), null);
  });

  test("a stamp after now reads the same two times, never a negative age", () => {
    const text = note(stamp.at - 2 * DAY, true);
    assert.equal(text, "Bree finished a Long Rest at Day 4, 6:00 AM. The rules let the next start from Day 4, 10:00 PM.");
    assert.ok(!text!.includes("-"));
  });

  test("a stamp from another clock, or none, gives no note", () => {
    assert.equal(note(stamp.at + H, true, { clockId: "c2" }), null);
    assert.equal(note(stamp.at + H, true, { stamp: undefined }), null);
  });

  test("it reads the date the way the calendar does today", () => {
    const text = restNote({ name: "Bree", stamp: { at: DAY + 6 * H, clock: "c1" }, clockId: "c1", now: DAY + 7 * H, calendar: MONTHS, movesClock: true });
    assert.equal(text, "Bree finished a Long Rest at Tuesday, Deepwinter 2, 0 AF, 6:00 AM. The rules let the next start from Tuesday, Deepwinter 2, 0 AF, 10:00 PM.");
  });
});
