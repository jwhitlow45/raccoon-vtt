import { CLOCK_TOO_FAR, clockNow, fightSeconds, lineDate } from "../calendar.ts";
import { keys } from "../keys.ts";
import { LIMITS } from "../limits.ts";
import type { ClockLogEvent, RoomClock } from "../model.ts";
import type { OpOf } from "../protocol.ts";
import { gone, invalid, type Tx } from "./tx.ts";

/**
 * The room's clock (docs/design/design-v1-calendar.md 6.3), the DM's alone.
 *
 * The clock stores `t` without the running fight's rounds, which `clockNow`
 * adds while the fight runs and its end stores (4.6). So a time an op names,
 * the time as the DM read it, is stored less the fight's seconds so far,
 * and `clockNow` then reads back the time typed (5.1). Each change that
 * moves the time writes one line, its date as `lineDate` reads the new
 * current time, and lineReader freezes its audience by whether the clock is
 * shown once the op is done (6.4).
 */

function within(t: number): boolean {
  return Number.isSafeInteger(t) && Math.abs(t) <= LIMITS.clockSecondsMax;
}

/** The stored baseline for a time the DM named, refused unless both lie within the bound (6.2). */
function storedFor(tx: Tx, at: number): number {
  const t = at - fightSeconds(tx.state.encounter, false);
  if (!within(at) || !within(t)) throw invalid(CLOCK_TOO_FAR);
  return t;
}

function clockOf(tx: Tx): RoomClock {
  const clock = tx.state.clock;
  if (!clock) throw gone("the clock");
  return clock;
}

function line(tx: Tx, clock: RoomClock, data: Omit<ClockLogEvent, "type" | "date">): void {
  tx.addEvent({ type: "clock", date: lineDate(clockNow(clock, tx.state.encounter), clock.calendar), ...data });
}

/** The clock as written, so the line reads the rev and all that Tx gave it. */
function written(tx: Tx, clock: RoomClock): RoomClock {
  tx.write(keys.clock, clock);
  return tx.state.clock!;
}

export function clockStart(tx: Tx, op: OpOf<"clock.start">): void {
  if (tx.state.clock) throw invalid("the clock is already running");
  const clock = written(tx, { id: op.id, rev: 0, t: storedFor(tx, op.at), shown: op.shown, calendar: op.calendar });
  line(tx, clock, { why: "start" });
}

/** No line: the date and time go, and Undo setup brings them back (4.2, 4.7). */
export function clockStop(tx: Tx): void {
  clockOf(tx);
  tx.write(keys.clock, null);
}

/**
 * The calendar, the sharing switch and the time, from the Calendar dialog
 * and the switch (4.3). A save that moved the time writes the Set line. One
 * that kept it, a rename or the switch writes none (4.7).
 */
export function clockUpdate(tx: Tx, op: OpOf<"clock.update">): void {
  const before = clockOf(tx);
  const next: RoomClock = { ...before };
  if (op.calendar !== undefined) next.calendar = op.calendar;
  if (op.shown !== undefined) next.shown = op.shown;
  if (op.at !== undefined) next.t = storedFor(tx, op.at);
  const clock = written(tx, next);
  if (clock.t !== before.t) line(tx, clock, { why: "set" });
}

export function clockSet(tx: Tx, op: OpOf<"clock.set">): void {
  const before = clockOf(tx);
  const clock = written(tx, { ...before, t: storedFor(tx, op.at) });
  line(tx, clock, { why: "set" });
}

/**
 * A step forward (4.2). Refused unless both the current time and the stored
 * `t` stay within the bound after it, so a clock a long fight already holds
 * at the limit takes no step it cannot show (CAL-ASTRA-08).
 */
export function clockAdvance(tx: Tx, op: OpOf<"clock.advance">): void {
  const before = clockOf(tx);
  const t = before.t + op.by;
  if (!within(clockNow(before, tx.state.encounter) + op.by) || !within(t)) throw invalid(CLOCK_TOO_FAR);
  const clock = written(tx, { ...before, t });
  line(tx, clock, { by: op.by, ...(op.why ? { why: op.why } : {}) });
}
