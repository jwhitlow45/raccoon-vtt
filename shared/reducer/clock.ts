import { CLOCK_TOO_FAR, DAYLIGHT, clockNow, fightSeconds, lightAt, lineDate } from "../calendar.ts";
import { keys, parseKey } from "../keys.ts";
import { LIMITS } from "../limits.ts";
import type { ClockLogEvent, Daylight, RoomClock, RoomState, Scene } from "../model.ts";
import { ownEntry } from "../records.ts";
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

/** `claim` is the sending device's, so it knows the line for its own (docs/design/design-v1-calendar-c2c3.md 4.6). */
function line(tx: Tx, clock: RoomClock, data: Omit<ClockLogEvent, "type" | "date" | "claim">, claim: string | undefined): void {
  tx.addEvent({ type: "clock", date: lineDate(clockNow(clock, tx.state.encounter), clock.calendar), ...data, ...(claim !== undefined ? { claim } : {}) });
}

/** The clock as written, so the line reads the rev and all that Tx gave it. */
function written(tx: Tx, clock: RoomClock): RoomClock {
  tx.write(keys.clock, clock);
  return tx.state.clock!;
}

export function clockStart(tx: Tx, op: OpOf<"clock.start">): void {
  if (tx.state.clock) throw invalid("the clock is already running");
  const clock = written(tx, { id: op.id, rev: 0, t: storedFor(tx, op.at), shown: op.shown, calendar: op.calendar });
  line(tx, clock, { why: "start" }, op.claim);
}

/** No line: the date and time go, and Undo setup brings them back (4.2, 4.7). */
export function clockStop(tx: Tx): void {
  clockOf(tx);
  tx.write(keys.clock, null);
}

/**
 * The calendar, the sharing switch and the time, from the Calendar dialog
 * and the switch (4.3), and dawn and dusk from Time's own row
 * (docs/design/design-v1-calendar-c2c3.md 5.2). A save that moved the time
 * writes the Set line. One that kept it, a rename, the switch or dawn and
 * dusk writes none (4.7).
 */
export function clockUpdate(tx: Tx, op: OpOf<"clock.update">): void {
  const before = clockOf(tx);
  const next: RoomClock = { ...before };
  if (op.calendar !== undefined) next.calendar = op.calendar;
  if (op.shown !== undefined) next.shown = op.shown;
  if (op.at !== undefined) next.t = storedFor(tx, op.at);
  if (op.daylight !== undefined) next.daylight = op.daylight;
  const clock = written(tx, next);
  if (clock.t !== before.t) line(tx, clock, { why: "set" }, op.claim);
}

export function clockSet(tx: Tx, op: OpOf<"clock.set">): void {
  const before = clockOf(tx);
  const clock = written(tx, { ...before, t: storedFor(tx, op.at) });
  line(tx, clock, { why: "set" }, op.claim);
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
  line(tx, clock, { by: op.by, ...(op.why ? { why: op.why } : {}) }, op.claim);
}

function sameDaylight(a: Daylight | undefined, b: Daylight | undefined): boolean {
  const x = a ?? DAYLIGHT;
  const y = b ?? DAYLIGHT;
  return x.dawn === y.dawn && x.dusk === y.dusk;
}

/** A scene's light settings: what decides its level, and nothing a door, a build op or the weather writes. */
function sameLight(a: Scene, b: Scene): boolean {
  const x = a.vision;
  const y = b.vision;
  return a.phaseId === b.phaseId && x?.on === y?.on && x?.light === y?.light && x?.perPlayer === y?.perPlayer && x?.byClock === y?.byClock;
}

/**
 * Light that follows the time of day (docs/design/design-v1-calendar-c2c3.md
 * 6.3): every scene on Time of day takes `lightAt` the current time where
 * that differs. It runs for every such scene when the clock really changed
 * (it appeared, or its id, `t` or dawn and dusk differ) or a fight went
 * away, and for one scene when its own light settings changed or it is new.
 * Each test compares values, so a door's or a build op's walls version, the
 * weather and an unrelated Undo relight nothing. The trigger reads the
 * stored `t` on purpose, where time spans read `clockNow` (4.3): Next and
 * Previous move neither `t` nor a scene, so rounds alone never relight one,
 * and a dusk the rounds reach darkens the map when the fight ends. A fight
 * that goes without its end, by an Undo of its start, relights too, since
 * the rounds it counted leave the current time with it.
 */
export function followDaylight(tx: Tx, before: Pick<RoomState, "clock" | "encounter" | "scenes">): void {
  const clock = tx.state.clock;
  if (!clock) return;
  const was = before.clock;
  const every = !was || was.id !== clock.id || was.t !== clock.t || !sameDaylight(was.daylight, clock.daylight) || (before.encounter != null && tx.state.encounter == null);
  const ids = every ? Object.keys(tx.state.scenes).sort() : changedLight(tx, before);
  const level = lightAt(clockNow(clock, tx.state.encounter), clock.daylight);
  for (const id of ids) {
    const scene = ownEntry(tx.state.scenes, id);
    const vision = scene?.vision;
    if (!scene || vision?.byClock !== true || vision.light === level) continue;
    tx.write(keys.scene(id), { ...scene, vision: { ...vision, light: level } });
  }
}

/** The scenes the op wrote whose light settings changed by value, or that it made. */
function changedLight(tx: Tx, before: Pick<RoomState, "scenes">): string[] {
  const ids: string[] = [];
  for (const key of tx.touched()) {
    const parsed = parseKey(key);
    if (parsed?.kind !== "scene") continue;
    const was = ownEntry(before.scenes, parsed.id);
    const now = ownEntry(tx.state.scenes, parsed.id);
    if (now && (!was || !sameLight(was, now))) ids.push(parsed.id);
  }
  return ids;
}
