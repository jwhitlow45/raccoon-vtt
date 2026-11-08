import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  CLOCK_TOO_FAR,
  DAYLIGHT,
  DAYLIGHT_BOUNDS,
  DAY_SECONDS,
  clockNow,
  composeDate,
  dateOf,
  dateText,
  fightSeconds,
  fightStarted,
  lightAt,
  lineDate,
  nextDawn,
  partOfDay,
  spanText,
  timeText,
  yearDays,
} from "./calendar.ts";
import { LIMITS } from "./limits.ts";
import type { Calendar } from "./model.ts";

const H = 3_600;
const DAY: Calendar = { kind: "days" };
/** Twelve months of 30 days, a festival day after them, a week of seven and an era. */
const MONTHS: Calendar = {
  kind: "months",
  months: [...Array.from({ length: 12 }, (_, i) => ({ name: i === 0 ? "Deepwinter" : `Month ${i + 1}`, days: 30 })), { name: "Midwinter", days: 1 }],
  week: ["Moonday", "Tuesday", "Wodensday", "Thorsday", "Freyday", "Starday", "Sunday"],
  era: "AF",
};
const fight = (round: number, activeEntryId: string | null = "e1", started?: boolean) => ({ round, activeEntryId, ...(started !== undefined ? { started } : {}) });

describe("reading a moment (docs/design/design-v1-calendar.md 5)", () => {
  test("Day count starts at Day 1 at midnight and reads Day N", () => {
    assert.equal(dateText(0, DAY, "full"), "Day 1");
    assert.equal(dateText(3 * DAY_SECONDS + 6 * H, DAY, "short"), "Day 4");
    assert.equal(lineDate(3 * DAY_SECONDS + 6 * H, DAY), "Day 4, 6:00 AM");
    assert.deepEqual(dateOf(8 * H, DAY), { dayIndex: 0, time: 8 * H, day: 1 });
  });

  test("days before the first one read by floor, never as negative parts of a day", () => {
    assert.deepEqual(dateOf(-1, DAY), { dayIndex: -1, time: DAY_SECONDS - 1, day: 0 });
    assert.equal(lineDate(-1, DAY), "Day 0, 11:59 PM");
    assert.equal(dateText(-DAY_SECONDS - 1, DAY, "full"), "Day -1");
  });

  test("Months reads the weekday, the month and day, and the year with its era", () => {
    const t = (1204 * 361 + 2) * DAY_SECONDS + 6 * H;
    assert.equal(yearDays((MONTHS as Extract<Calendar, { kind: "months" }>).months), 361);
    assert.equal(dateText(t, MONTHS, "full"), `${MONTHS.week![(1204 * 361 + 2) % 7]}, Deepwinter 3, 1204 AF`);
    assert.equal(dateText(t, MONTHS, "short"), "Deepwinter 3");
    assert.equal(lineDate(t, MONTHS), `${dateText(t, MONTHS, "full")}, 6:00 AM`);
  });

  test("a month of one day reads by its name alone, as a festival day does", () => {
    const t = (1204 * 361 + 360) * DAY_SECONDS;
    assert.equal(dateOf(t, MONTHS).month, 12);
    assert.match(dateText(t, MONTHS, "full"), /, Midwinter, 1204 AF$/);
    assert.equal(dateText(t, MONTHS, "short"), "Midwinter");
  });

  test("a year turns at its last day, and years before 0 read by floor too", () => {
    assert.deepEqual(dateOf(361 * DAY_SECONDS - 1, MONTHS), { dayIndex: 360, time: DAY_SECONDS - 1, day: 1, month: 12, year: 0, weekday: 360 % 7 });
    assert.deepEqual(dateOf(361 * DAY_SECONDS, MONTHS), { dayIndex: 361, time: 0, day: 1, month: 0, year: 1, weekday: 361 % 7 });
    assert.deepEqual(dateOf(-1, MONTHS), { dayIndex: -1, time: DAY_SECONDS - 1, day: 1, month: 12, year: -1, weekday: 6 });
    assert.equal(dateText(-361 * DAY_SECONDS, MONTHS, "full"), "Thorsday, Deepwinter 1, -1 AF");
  });

  test("no week, no weekday, and no era, a bare year", () => {
    const plain: Calendar = { kind: "months", months: [{ name: "Dry", days: 100 }, { name: "Wet", days: 100 }] };
    assert.equal(dateText(150 * DAY_SECONDS, plain, "full"), "Wet 51, 0");
    assert.equal(dateOf(150 * DAY_SECONDS, plain).weekday, undefined);
  });

  test("a moment at the first midnight reads the same however it was reached", () => {
    assert.deepEqual(dateOf(-0, MONTHS), dateOf(0, MONTHS));
    assert.ok(Object.is(dateOf(-0, MONTHS).dayIndex, 0));
  });
});

describe("the time and the part of the day", () => {
  test("12-hour times, noon and midnight at 12", () => {
    assert.deepEqual([0, 6 * H, 12 * H, 12 * H + 59 * 60, 13 * H, DAY_SECONDS - 1].map(timeText), ["12:00 AM", "6:00 AM", "12:00 PM", "12:59 PM", "1:00 PM", "11:59 PM"]);
    assert.equal(timeText(-60), "11:59 PM");
  });

  test("Dawn 6 to 7, Morning to noon, Afternoon to 6, Dusk to 7, Night to 6", () => {
    const at = (h: number, m = 0) => partOfDay(h * H + m * 60);
    assert.deepEqual([at(5, 59), at(6), at(6, 59), at(7), at(11, 59), at(12), at(17, 59), at(18), at(18, 59), at(19), at(0)], ["Night", "Dawn", "Dawn", "Morning", "Morning", "Afternoon", "Afternoon", "Dusk", "Dusk", "Night", "Night"]);
    assert.equal(partOfDay(-H), "Night");
  });

  test("To dawn is the next 6:00 AM, the next day's at 6:00 AM exactly", () => {
    assert.equal(nextDawn(6 * H), DAY_SECONDS + 6 * H);
    assert.equal(nextDawn(6 * H - 1), 6 * H);
    assert.equal(nextDawn(22 * H), DAY_SECONDS + 6 * H);
    assert.equal(nextDawn(-1), 6 * H);
    assert.equal(nextDawn(-DAY_SECONDS), -DAY_SECONDS + 6 * H);
  });

  test("absent dawn and dusk read as 6:00 AM and 6:00 PM", () => {
    assert.deepEqual(DAYLIGHT, { dawn: 6 * H, dusk: 18 * H });
    for (let t = -DAY_SECONDS; t < 2 * DAY_SECONDS; t += 60) {
      assert.equal(partOfDay(t, DAYLIGHT), partOfDay(t));
      assert.equal(nextDawn(t, DAYLIGHT), nextDawn(t));
    }
  });

  test("dawn and dusk move every part of the day's edge, to the second", () => {
    const daylight = { dawn: 5 * H + 30 * 60, dusk: 20 * H };
    const at = (s: number) => partOfDay(DAY_SECONDS * 3 + s, daylight);
    assert.deepEqual(
      [daylight.dawn - 1, daylight.dawn, daylight.dawn + H - 1, daylight.dawn + H, 12 * H - 1, 12 * H, daylight.dusk - 1, daylight.dusk, daylight.dusk + H - 1, daylight.dusk + H, 0].map(at),
      ["Night", "Dawn", "Dawn", "Morning", "Morning", "Afternoon", "Afternoon", "Dusk", "Dusk", "Night", "Night"],
    );
    assert.equal(partOfDay(daylight.dawn - DAY_SECONDS, daylight), "Dawn");
  });

  test("at the bounds no part overlaps and the empty ones read as none", () => {
    const earliest = { dawn: DAYLIGHT_BOUNDS.dawn.min, dusk: DAYLIGHT_BOUNDS.dusk.min };
    assert.deepEqual([0, H - 1, H, 12 * H - 1, 12 * H, 13 * H - 1, 13 * H, DAY_SECONDS - 1].map((t) => partOfDay(t, earliest)), [
      "Dawn",
      "Dawn",
      "Morning",
      "Morning",
      "Dusk",
      "Dusk",
      "Night",
      "Night",
    ]);
    const latest = { dawn: DAYLIGHT_BOUNDS.dawn.max, dusk: DAYLIGHT_BOUNDS.dusk.max };
    assert.deepEqual([11 * H - 1, 11 * H, 12 * H - 1, 12 * H, 23 * H - 1, 23 * H, DAY_SECONDS - 1, 0].map((t) => partOfDay(t, latest)), [
      "Night",
      "Dawn",
      "Dawn",
      "Afternoon",
      "Afternoon",
      "Dusk",
      "Dusk",
      "Night",
    ]);
  });

  test("Time of day light: Dim at dawn and dusk, Bright by day, Dark at night", () => {
    const daylight = { dawn: 5 * H, dusk: 19 * H };
    assert.deepEqual([4 * H, 5 * H, 6 * H, 13 * H, 19 * H, 20 * H].map((t) => lightAt(t, daylight)), ["dark", "dim", "bright", "bright", "dim", "dark"]);
    assert.deepEqual([5 * H, 6 * H, 7 * H, 18 * H, 19 * H].map((t) => lightAt(t)), ["dark", "dim", "bright", "dim", "dark"]);
  });

  test("To dawn follows the dawn set, the next day's at dawn exactly", () => {
    const daylight = { dawn: 5 * H + 30 * 60, dusk: 18 * H };
    assert.equal(nextDawn(daylight.dawn, daylight), DAY_SECONDS + daylight.dawn);
    assert.equal(nextDawn(daylight.dawn - 1, daylight), daylight.dawn);
    assert.equal(nextDawn(6 * H, daylight), DAY_SECONDS + daylight.dawn);
    assert.equal(nextDawn(-1, { dawn: 0, dusk: 12 * H }), 0);
    assert.equal(nextDawn(0, { dawn: 0, dusk: 12 * H }), DAY_SECONDS);
  });
});

describe("spans", () => {
  test("days, hours and minutes, the smallest shown a minute", () => {
    assert.equal(spanText(8 * H), "8 hours");
    assert.equal(spanText(H), "1 hour");
    assert.equal(spanText(10 * 60), "10 minutes");
    assert.equal(spanText(2 * DAY_SECONDS + 3 * H), "2 days and 3 hours");
    assert.equal(spanText(DAY_SECONDS + 3 * H + 60 + 59), "1 day, 3 hours and 1 minute");
    assert.equal(spanText(59), "less than a minute");
    assert.equal(spanText(LIMITS.clockStepMax), "36,500 days");
  });
});

describe("composing a date", () => {
  test("Day count: the day and the time, any whole day within the bound", () => {
    assert.deepEqual(composeDate({ day: 4, time: 6 * H }, DAY), { ok: true, t: 3 * DAY_SECONDS + 6 * H });
    assert.deepEqual(composeDate({ day: 0, time: 0 }, DAY), { ok: true, t: -DAY_SECONDS });
    assert.deepEqual(composeDate({ day: 1.5, time: 0 }, DAY), { ok: false, field: "day", reason: "Pick a whole day." });
    assert.deepEqual(composeDate({ day: 200_000_000, time: 0 }, DAY), { ok: false, field: "day", reason: CLOCK_TOO_FAR });
  });

  test("Months: a day past the month's length, a month not there, a year out of range and a bad time each name their field", () => {
    assert.deepEqual(composeDate({ month: 0, day: 3, year: 1204, time: 6 * H }, MONTHS), { ok: true, t: (1204 * 361 + 2) * DAY_SECONDS + 6 * H });
    assert.deepEqual(composeDate({ month: 0, day: 31, year: 1204, time: 0 }, MONTHS), { ok: false, field: "day", reason: "Pick a day from 1 to 30." });
    assert.deepEqual(composeDate({ month: 12, day: 2, year: 1204, time: 0 }, MONTHS), { ok: false, field: "day", reason: "Pick a day from 1 to 1." });
    assert.deepEqual(composeDate({ month: 13, day: 1, year: 1204, time: 0 }, MONTHS), { ok: false, field: "month", reason: "Pick a month." });
    assert.deepEqual(composeDate({ day: 1, year: 1204, time: 0 }, MONTHS), { ok: false, field: "month", reason: "Pick a month." });
    assert.deepEqual(composeDate({ month: 0, day: 1, year: 10_000_000, time: 0 }, MONTHS), { ok: false, field: "year", reason: CLOCK_TOO_FAR });
    assert.deepEqual(composeDate({ month: 0, day: 1, year: 0.5, time: 0 }, MONTHS), { ok: false, field: "year", reason: "Pick a whole year." });
    assert.deepEqual(composeDate({ month: 0, day: 1, year: 1, time: DAY_SECONDS }, MONTHS), { ok: false, field: "time", reason: "Pick a time." });
    assert.deepEqual(composeDate({ month: 0, day: 1, year: -1, time: 0 }, MONTHS), { ok: true, t: -361 * DAY_SECONDS });
  });

  test("each end of the bound composes, and one second past it does not", () => {
    const last = dateOf(LIMITS.clockSecondsMax, DAY);
    assert.deepEqual(composeDate({ day: last.day, time: last.time }, DAY), { ok: true, t: LIMITS.clockSecondsMax });
    const first = dateOf(-LIMITS.clockSecondsMax, MONTHS);
    assert.deepEqual(composeDate({ day: first.day, month: first.month, year: first.year, time: first.time }, MONTHS), { ok: true, t: -LIMITS.clockSecondsMax });
    assert.equal(composeDate({ day: first.day, month: first.month, year: first.year, time: first.time - 1 }, MONTHS).ok, false);
  });
});

describe("a fight's seconds and the current time (4.6, 5.1)", () => {
  test("a fight has started past round 1 or with a row acting, or as a player's copy says", () => {
    assert.equal(fightStarted(null), false);
    assert.equal(fightStarted(undefined), false);
    assert.equal(fightStarted(fight(1, null)), false);
    assert.equal(fightStarted(fight(1, "e1")), true);
    assert.equal(fightStarted(fight(2, null)), true);
    assert.equal(fightStarted(fight(1, null, true)), true, "a player's copy while a row they cannot see acts");
  });

  test("6 seconds for each round before the current one while it runs, every round counted whole at its end", () => {
    assert.equal(fightSeconds(fight(11), false), 60);
    assert.equal(fightSeconds(fight(3), true), 18);
    assert.equal(fightSeconds(fight(1), false), 0);
    assert.equal(fightSeconds(fight(1), true), 6);
    assert.equal(fightSeconds(fight(1, null), true), 0, "a fight never started adds nothing");
    assert.equal(fightSeconds(null, true), 0);
  });

  test("the current time adds the running fight's seconds, held within the bound", () => {
    assert.equal(clockNow({ t: 100 }, null), 100);
    assert.equal(clockNow({ t: 100 }, fight(11)), 160);
    assert.equal(clockNow({ t: LIMITS.clockSecondsMax - 30 }, fight(11)), LIMITS.clockSecondsMax);
    assert.equal(clockNow({ t: -LIMITS.clockSecondsMax }, fight(11)), -LIMITS.clockSecondsMax + 60);
  });
});

describe("bounds", () => {
  test("the longest date a calendar within the limits can make fits a line", () => {
    const long = "W".repeat(LIMITS.calendarNameChars);
    const widest: Calendar = {
      kind: "months",
      months: [{ name: long, days: 1 }, { name: long, days: LIMITS.calendarMonthDays }],
      week: Array.from({ length: LIMITS.calendarWeekDays }, () => long),
      era: "E".repeat(LIMITS.calendarEraChars),
    };
    for (const t of [-LIMITS.clockSecondsMax, LIMITS.clockSecondsMax, -1, 12 * H]) {
      const text = lineDate(t, widest);
      assert.ok(text.length <= LIMITS.clockDateChars, text);
      assert.ok(!text.includes("undefined"), text);
    }
    const oneDayYear: Calendar = { kind: "months", months: [{ name: long, days: 1 }], week: [long], era: "E".repeat(LIMITS.calendarEraChars) };
    assert.ok(lineDate(-LIMITS.clockSecondsMax, oneDayYear).length <= LIMITS.clockDateChars);
  });
});
