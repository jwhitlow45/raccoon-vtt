import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Calendar } from "#shared/model.ts";
import { LIMITS } from "#shared/limits.ts";
import { amountBy, calendarSummary, chipName, chipText, composeDraft, DAY_FROM_ONE, draftDate, firstDay, keptSeconds, reconcileDate, joinNames, partyRestNotes, remapMonth, restNote, setAt, stepName, STEPS, timeSeconds, timeValue, toDawn, weekdayLine } from "./words.ts";

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

  test("a month the calendar no longer has reads as none, and composing it names the month (ASTRA-04)", () => {
    const draft = { day: "1", month: "2", year: "1", time: "08:00" };
    const two: Calendar = { kind: "months", months: [{ name: "Deepwinter", days: 30 }, { name: "Midwinter", days: 1 }] };
    assert.equal(reconcileDate(draft, MONTHS), draft);
    assert.deepEqual(reconcileDate(draft, two), { ...draft, month: "" });
    assert.deepEqual(composeDraft(reconcileDate(draft, two), two), { ok: false, field: "month", reason: "Pick a month." });
    assert.equal(reconcileDate(draft, DAYS), draft);
  });

  test("a month changed elsewhere is followed by its name, and cleared where that is in doubt (ASTRA-04, round 2)", () => {
    const cal = (...names: string[]): Extract<Calendar, { kind: "months" }> => ({ kind: "months", months: names.map((name) => ({ name, days: 30 })) });
    const may = { day: "6", month: "1", year: "1204", time: "08:00" };
    const spring = cal("April", "May", "June");
    assert.equal(remapMonth(may, spring, cal("April", "June")).month, "", "May removed from the middle: never June");
    assert.equal(remapMonth(may, spring, cal("May", "June")).month, "0", "an earlier month removed");
    assert.equal(remapMonth(may, spring, cal("June", "April", "May")).month, "2", "reordered");
    assert.equal(remapMonth(may, spring, cal("April", "Maia", "June")).month, "", "renamed");
    assert.equal(remapMonth(may, spring, cal("April", "May", "May")).month, "", "doubled");
    assert.equal(remapMonth(may, cal("May", "May", "June"), cal("May", "June")).month, "", "a name the old calendar held twice");
    assert.equal(remapMonth(may, spring, { ...spring, era: "AF" }), may, "the months unchanged");
    assert.equal(remapMonth(may, spring, DAYS), may, "a kind change is not its to follow");
    const doubled = cal("May", "May", "June");
    const sameDoubled = { day: "6", month: "0", year: "1204", time: "08:00" };
    assert.equal(remapMonth(sameDoubled, doubled, { ...doubled, era: "AF" }), sameDoubled, "doubled names, only the era changed (CALB-O-14)");
  });

  test("Day count refuses a day under 1 (CALB-O-06)", () => {
    for (const day of ["0", "-3"]) assert.deepEqual(composeDraft({ ...draftDate(0, DAYS), day }, DAYS), { ok: false, field: "day", reason: DAY_FROM_ONE });
    assert.deepEqual(composeDraft({ ...draftDate(0, DAYS), day: "1" }, DAYS), { ok: true, t: 0 });
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

describe("a clock holding seconds (CALB-O-02)", () => {
  // A 3-round fight ended at 8:00 AM: the clock reads 8:00:18, which the fields show as 08:00.
  const now = 3 * DAY + 8 * H + 18;

  test("an untouched draft names the clock's own moment, seconds and all, so Set sends nothing", () => {
    for (const cal of [DAYS, MONTHS]) {
      const draft = draftDate(now, cal);
      assert.equal(draft.time, "08:00");
      assert.equal(keptSeconds(draft, now), 18);
      assert.deepEqual(composeDraft(draft, cal, keptSeconds(draft, now)), { ok: true, t: now });
    }
    const draft = draftDate(now, DAYS);
    assert.equal(setAt(false, composeDraft(draft, DAYS, keptSeconds(draft, now)), now), null);
    assert.equal(setAt(true, composeDraft(draft, DAYS, keptSeconds(draft, now)), now), null, "edited back to where it was");
    assert.equal(setAt(false, { ok: true, t: now - 600 }, now), null, "another device moved the clock while Set was open");
  });

  test("a date edited alone keeps the seconds, a time typed is that minute exactly", () => {
    const draft = { ...draftDate(now, DAYS), day: "6" };
    assert.equal(setAt(true, composeDraft(draft, DAYS, keptSeconds(draft, now)), now), 5 * DAY + 8 * H + 18);
    const timed = { ...draftDate(now, DAYS), time: "09:30" };
    assert.equal(setAt(true, composeDraft(timed, DAYS, keptSeconds(timed, now)), now), 3 * DAY + 9 * H + 30 * 60);
  });

  test("a kind change's first day keeps the time of day with its seconds", () => {
    const first = firstDay(((now % DAY) + DAY) % DAY);
    assert.deepEqual(composeDraft(first, MONTHS, keptSeconds(first, now)), { ok: true, t: 61 * DAY + 8 * H + 18 }, "the first day of year 1, a year of 61 days");
  });

  test("the lower bound saves unchanged", () => {
    const low = -LIMITS.clockSecondsMax;
    assert.notEqual(low % 60, 0, "the bound is not on a whole minute");
    const draft = draftDate(low, MONTHS);
    assert.deepEqual(composeDraft(draft, MONTHS, keptSeconds(draft, low)), { ok: true, t: low });
    // Day count reads it as a day under 1, which its fields refuse, so only a Set left as it opened passes it.
    const days = draftDate(low, DAYS);
    assert.equal(setAt(false, composeDraft(days, DAYS, keptSeconds(days, low)), low), null);
  });
});

describe("the note on a character's last Long Rest (4.5)", () => {
  const stamp = { at: 3 * DAY + 6 * H, clock: "c1" };
  const note = (now: number, movesClock: boolean, over: Partial<{ clockId: string; stamp: typeof stamp | undefined }> = {}) =>
    restNote({ name: "Bree", stamp: "stamp" in over ? over.stamp : stamp, clockId: over.clockId ?? "c1", now, calendar: DAYS, movesClock });

  test("gives the last finish and the earliest next start", () => {
    assert.equal(note(stamp.at + 6 * H, true), "Bree finished a Long Rest at Day 4, 6:00 AM. The next can start from Day 4, 10:00 PM.");
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
    assert.equal(text, "Bree finished a Long Rest at Day 4, 6:00 AM. The next can start from Day 4, 10:00 PM.");
    assert.ok(!text!.includes("-"));
  });

  test("a stamp from another clock, or none, gives no note", () => {
    assert.equal(note(stamp.at + H, true, { clockId: "c2" }), null);
    assert.equal(note(stamp.at + H, true, { stamp: undefined }), null);
  });

  test("a date in the clock's own year drops its weekday and year", () => {
    const text = restNote({ name: "Bree", stamp: { at: DAY + 6 * H, clock: "c1" }, clockId: "c1", now: DAY + 7 * H, calendar: MONTHS, movesClock: true });
    assert.equal(text, "Bree finished a Long Rest at Deepwinter 2, 6:00 AM. The next can start from Deepwinter 2, 10:00 PM.");
  });

  test("a festival day reads by its name alone", () => {
    const at = 30 * DAY + 17 * H;
    const text = restNote({ name: "Bree", stamp: { at, clock: "c1" }, clockId: "c1", now: at + H, calendar: MONTHS, movesClock: true });
    assert.equal(text, "Bree finished a Long Rest at Midwinter, 5:00 PM. The next can start from Thaw 1, 9:00 AM.");
  });

  test("a date in another year than the clock's keeps its weekday and year", () => {
    const at = 60 * DAY + 20 * H;
    const text = restNote({ name: "Bree", stamp: { at, clock: "c1" }, clockId: "c1", now: at + H, calendar: MONTHS, movesClock: true });
    assert.match(text!, /^Bree finished a Long Rest at Thaw 30, 8:00 PM\. The next can start from \w+, Deepwinter 1, 1 AF, 12:00 PM\.$/);
  });
});

describe("the party's Long Rest notes", () => {
  const o = { clockId: "c1", now: 3 * DAY + 7 * H, calendar: DAYS, movesClock: true };
  const at = 3 * DAY + 6 * H;
  const who = (id: string, name: string, over: Partial<{ at: number; clock: string }> | null = {}) => ({
    id,
    name,
    stamp: over === null ? undefined : { at, clock: "c1", ...over },
  });

  test("names join the way a sentence does", () => {
    assert.equal(joinNames([]), "");
    assert.equal(joinNames(["Bree"]), "Bree");
    assert.equal(joinNames(["Bree", "Thorn"]), "Bree and Thorn");
    assert.equal(joinNames(["Bree", "Thorn", "Ash"]), "Bree, Thorn and Ash");
  });

  test("characters with one stamp share one sentence", () => {
    const notes = partyRestNotes([who("a", "Bree"), who("b", "Thorn")], o);
    assert.deepEqual(notes, [{ id: "a", note: "Bree and Thorn finished a Long Rest at Day 4, 6:00 AM. The next can start from Day 4, 10:00 PM." }]);
  });

  test("different stamps give a sentence each, in the order the first of each appears", () => {
    const notes = partyRestNotes([who("a", "Bree"), who("b", "Thorn", { at: at + H }), who("c", "Ash")], o);
    assert.equal(notes.length, 2);
    assert.match(notes[0]!.note, /^Bree and Ash finished/);
    assert.match(notes[1]!.note, /^Thorn finished/);
  });

  test("no stamp, another clock's stamp, or a spent window adds nothing", () => {
    const notes = partyRestNotes([who("a", "Bree", null), who("b", "Thorn", { clock: "c2" }), who("c", "Ash", { at: at - 2 * DAY }), who("d", "Moss")], o);
    assert.deepEqual(notes.map((n) => n.id), ["d"]);
    assert.match(notes[0]!.note, /^Moss finished/);
  });
});
