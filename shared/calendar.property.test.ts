import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { DAYLIGHT_BOUNDS, DAY_SECONDS, composeDate, dateOf, lightAt, lineDate, nextDawn, partOfDay, yearDays } from "./calendar.ts";
import { LIMITS } from "./limits.ts";
import type { Calendar } from "./model.ts";

/**
 * Random calendars within the limits and random moments within the clock's
 * bound (docs/design/design-v1-calendar.md 11): every date composes back to
 * its moment, its parts stay in range, a step of N days moves the weekday
 * by N, and a line's date stays within its cap.
 */
const name = fc.string({ minLength: 1, maxLength: LIMITS.calendarNameChars });
const months = fc
  .array(fc.record({ name, days: fc.integer({ min: 1, max: LIMITS.calendarMonthDays }) }), { minLength: 1, maxLength: LIMITS.calendarMonths })
  .filter((list) => yearDays(list) <= LIMITS.calendarYearDays);
const calendar: fc.Arbitrary<Calendar> = fc.oneof(
  fc.constant<Calendar>({ kind: "days" }),
  fc.record(
    {
      kind: fc.constant("months" as const),
      months,
      week: fc.array(name, { minLength: 1, maxLength: LIMITS.calendarWeekDays }),
      era: fc.string({ minLength: 1, maxLength: LIMITS.calendarEraChars }),
    },
    { requiredKeys: ["kind", "months"] },
  ),
);
const moment = fc.oneof(
  fc.integer({ min: -LIMITS.clockSecondsMax, max: LIMITS.clockSecondsMax }),
  fc.integer({ min: -5 * 1_000 * DAY_SECONDS, max: 5 * 1_000 * DAY_SECONDS }),
  fc.constantFrom(-LIMITS.clockSecondsMax, LIMITS.clockSecondsMax, 0, -1, DAY_SECONDS - 1),
);

const minutes = (bounds: { min: number; max: number }) => fc.integer({ min: bounds.min / 60, max: bounds.max / 60 }).map((m) => m * 60);
const daylight = fc.record({ dawn: minutes(DAYLIGHT_BOUNDS.dawn), dusk: minutes(DAYLIGHT_BOUNDS.dusk) });
const LIGHT = { Dawn: "dim", Morning: "bright", Afternoon: "bright", Dusk: "dim", Night: "dark" } as const;

test("with any dawn and dusk, the light agrees with the part of the day and To dawn lands on Dawn", () => {
  fc.assert(
    fc.property(daylight, fc.integer({ min: -5 * 1_000 * DAY_SECONDS, max: 5 * 1_000 * DAY_SECONDS }), (d, t) => {
      assert.equal(lightAt(t, d), LIGHT[partOfDay(t, d)]);
      const dawn = nextDawn(t, d);
      assert.ok(dawn > t && dawn - t <= DAY_SECONDS);
      assert.equal(partOfDay(dawn, d), "Dawn");
      assert.notEqual(partOfDay(dawn - 1, d), "Dawn");
    }),
    { numRuns: 2_000 },
  );
});

test("every date composes back to its moment, with its time of day", () => {
  fc.assert(
    fc.property(calendar, moment, (cal, t) => {
      const date = dateOf(t, cal);
      const back = composeDate({ day: date.day, time: date.time, ...(date.month !== undefined ? { month: date.month } : {}), ...(date.year !== undefined ? { year: date.year } : {}) }, cal);
      assert.deepEqual(back, { ok: true, t });
    }),
    { numRuns: 2_000 },
  );
});

test("months, days and weekdays are always in range", () => {
  fc.assert(
    fc.property(calendar, moment, (cal, t) => {
      const date = dateOf(t, cal);
      assert.ok(date.time >= 0 && date.time < DAY_SECONDS);
      if (cal.kind === "days") {
        assert.equal(date.day, date.dayIndex + 1);
        return;
      }
      const month = cal.months[date.month!];
      assert.ok(month !== undefined);
      assert.ok(date.day >= 1 && date.day <= month.days);
      assert.ok(Number.isInteger(date.year));
      if (cal.week) assert.ok(date.weekday! >= 0 && date.weekday! < cal.week.length);
    }),
    { numRuns: 2_000 },
  );
});

test("a step of N days moves the weekday by N", () => {
  fc.assert(
    fc.property(calendar, moment, fc.integer({ min: 0, max: 5_000 }), (cal, t, n) => {
      fc.pre(cal.kind === "months" && cal.week !== undefined);
      const later = t + n * DAY_SECONDS;
      fc.pre(later <= LIMITS.clockSecondsMax);
      const week = (cal as Extract<Calendar, { kind: "months" }>).week!.length;
      assert.equal(dateOf(later, cal).weekday, (dateOf(t, cal).weekday! + n) % week);
    }),
    { numRuns: 2_000 },
  );
});

test("a line's date stays within its cap", () => {
  fc.assert(
    fc.property(calendar, moment, (cal, t) => {
      assert.ok(lineDate(t, cal).length <= LIMITS.clockDateChars);
    }),
    { numRuns: 2_000 },
  );
});
