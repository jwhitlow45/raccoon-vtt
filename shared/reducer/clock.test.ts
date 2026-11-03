import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CLOCK_TOO_FAR, DAY_SECONDS, clockNow, nextDawn } from "../calendar.ts";
import { keys } from "../keys.ts";
import { LIMITS } from "../limits.ts";
import { lineAudience } from "../logRings.ts";
import { clockText } from "../logText.ts";
import type { ClockLogEvent, Viewer } from "../model.ts";
import type { Op } from "../protocol.ts";
import { projectState } from "../project.ts";
import { P1 } from "../testutil.ts";
import { DAYS, H, MONTHS, base, clockLines, fight, refusal, restore, run, texts, withClock } from "./clockTesting.ts";

describe("starting the clock (docs/design/design-v1-calendar.md 4.1)", () => {
  test("a Day count clock at Day 1, 8:00 AM, shown: the clock and one shared line", () => {
    const r = run(base(), { t: "clock.start", id: "c1", at: 8 * H, shown: true, calendar: DAYS });
    assert.deepEqual(r.state.clock, { id: "c1", rev: 1, t: 8 * H, shown: true, calendar: DAYS });
    assert.deepEqual(texts(r.log), ["The DM starts the clock: Day 1, 8:00 AM."]);
    assert.equal(lineAudience(clockLines(r.log)[0]!), "shared");
    assert.ok(r.touched.includes(keys.clock));
  });

  test("is refused while a clock exists, and every other clock op while none does", () => {
    assert.match(refusal(withClock(0), { t: "clock.start", id: "c2", at: 0, shown: true, calendar: DAYS }), /already running/);
    for (const op of [{ t: "clock.stop" }, { t: "clock.update", shown: false }, { t: "clock.set", at: 0 }, { t: "clock.advance", by: 60 }] as Op[]) {
      assert.match(refusal(base(), op), /clock is not here/, op.t);
    }
  });

  test("a hidden Months clock writes its start line for the DM alone", () => {
    const r = run(base(), { t: "clock.start", id: "c1", at: 8 * H, shown: false, calendar: MONTHS });
    const [line] = clockLines(r.log);
    assert.equal(lineAudience(line!), "dm");
    assert.equal(clockText(line!.data as ClockLogEvent), "The DM starts the clock: One, Month 1 1, 0 AF, 8:00 AM.");
    for (const who of [P1, { memberId: "display:table", role: "player" } as Viewer]) {
      const seen = projectState(r.state, who, { sceneId: "s1" });
      assert.equal(seen.clock, undefined);
      assert.equal(clockLines(seen.log).length, 0);
    }
  });
});

describe("moving the clock on (4.2)", () => {
  test("8 hours at 10:00 PM reads Day 2, 6:00 AM, Dawn, in one shared line", () => {
    const r = run(withClock(22 * H), { t: "clock.advance", by: 8 * H });
    assert.equal(r.state.clock!.t, DAY_SECONDS + 6 * H);
    assert.deepEqual(texts(r.log), ["8 hours pass. It is now Day 2, 6:00 AM."]);
    assert.equal(lineAudience(clockLines(r.log)[0]!), "shared");
  });

  test("a step past the bound is refused", () => {
    assert.equal(refusal(withClock(LIMITS.clockSecondsMax - 10), { t: "clock.advance", by: 11 }), CLOCK_TOO_FAR);
    assert.equal(run(withClock(LIMITS.clockSecondsMax - 10), { t: "clock.advance", by: 10 }).state.clock!.t, LIMITS.clockSecondsMax);
  });

  test("a step is refused where the current time a fight holds at the bound would pass it, though the stored time would not", () => {
    const state = withClock(LIMITS.clockSecondsMax - 30, {}, { encounter: fight(11) });
    assert.equal(refusal(state, { t: "clock.advance", by: 10 }), CLOCK_TOO_FAR);
  });

  test("To dawn in round 11 counts from the current time, the fight's seconds included", () => {
    const state = withClock(6 * H - 30, {}, { encounter: fight(11) });
    const now = clockNow(state.clock!, state.encounter);
    assert.equal(now, 6 * H + 30);
    const r = run(state, { t: "clock.advance", by: nextDawn(now) - now });
    assert.equal(clockNow(r.state.clock!, r.state.encounter), DAY_SECONDS + 6 * H);
    assert.deepEqual(texts(r.log), ["23 hours and 59 minutes pass. It is now Day 2, 6:00 AM."]);
  });

  test("a Long Rest's step says so", () => {
    const r = run(withClock(22 * H), { t: "clock.advance", by: 8 * H, why: "longRest" });
    assert.deepEqual(texts(r.log), ["8 hours pass in a Long Rest. It is now Day 2, 6:00 AM."]);
  });
});

describe("setting the date and time (4.3, 5.1)", () => {
  test("Set to 9:00 AM in round 11 reads 9:00 AM and stores less the fight's seconds", () => {
    const r = run(withClock(0, {}, { encounter: fight(11) }), { t: "clock.set", at: 9 * H });
    assert.equal(r.state.clock!.t, 9 * H - 60);
    assert.equal(clockNow(r.state.clock!, r.state.encounter), 9 * H);
    assert.deepEqual(texts(r.log), ["The DM sets the date and time: Day 1, 9:00 AM."]);
  });

  test("a start mid-fight reads the time typed, and the fight's later rounds add on", () => {
    const r = run(base({ encounter: fight(5) }), { t: "clock.start", id: "c1", at: 8 * H, shown: true, calendar: DAYS });
    assert.equal(r.state.clock!.t, 8 * H - 24);
    assert.deepEqual(texts(r.log), ["The DM starts the clock: Day 1, 8:00 AM."]);
  });

  test("the time named and the stored baseline must both lie within the bound", () => {
    assert.equal(refusal(withClock(0, {}, { encounter: fight(11) }), { t: "clock.set", at: -LIMITS.clockSecondsMax }), CLOCK_TOO_FAR);
    assert.equal(refusal(base({ encounter: fight(11) }), { t: "clock.start", id: "c1", at: -LIMITS.clockSecondsMax, shown: true, calendar: DAYS }), CLOCK_TOO_FAR);
    assert.equal(refusal(withClock(0, {}, { encounter: fight(11) }), { t: "clock.update", at: -LIMITS.clockSecondsMax + 59 }), CLOCK_TOO_FAR);
    assert.equal(run(withClock(0, {}, { encounter: fight(11) }), { t: "clock.update", at: -LIMITS.clockSecondsMax + 60 }).state.clock!.t, -LIMITS.clockSecondsMax);
    assert.equal(run(withClock(0), { t: "clock.set", at: -LIMITS.clockSecondsMax }).state.clock!.t, -LIMITS.clockSecondsMax);
  });
});

describe("the calendar and sharing (4.3, 4.7)", () => {
  test("a calendar saved with the date changed writes the Set line, one kept or only renamed writes none", () => {
    const state = withClock(3 * DAY_SECONDS + 6 * H);
    const moved = run(state, { t: "clock.update", calendar: MONTHS, at: 361 * DAY_SECONDS + 6 * H });
    assert.deepEqual(texts(moved.log), ["The DM sets the date and time: Two, Month 1 2, 1 AF, 6:00 AM."]);
    const kept = run(state, { t: "clock.update", calendar: MONTHS, at: 3 * DAY_SECONDS + 6 * H });
    assert.deepEqual(texts(kept.log), []);
    assert.deepEqual(kept.state.clock!.calendar, MONTHS);
    const renamed = run(withClock(0, { calendar: MONTHS }), { t: "clock.update", calendar: { ...MONTHS, era: "BF" } });
    assert.deepEqual(texts(renamed.log), []);
  });

  test("the sharing switch and Stop write no line, and Stop takes the clock's field away", () => {
    const hidden = run(withClock(0), { t: "clock.update", shown: false });
    assert.equal(hidden.state.clock!.shown, false);
    assert.deepEqual(texts(hidden.log), []);
    const stopped = run(withClock(0), { t: "clock.stop" });
    assert.ok(!("clock" in stopped.state));
    assert.deepEqual(texts(stopped.log), []);
  });

  test("a change while hidden is the DM's line, and turning sharing on in the same op as a new time shares it", () => {
    const hidden = run(withClock(0, { shown: false }), { t: "clock.advance", by: 3 * DAY_SECONDS });
    assert.equal(lineAudience(clockLines(hidden.log)[0]!), "dm");
    assert.equal(clockLines(projectState(hidden.state, P1, { sceneId: "s1" }).log).length, 0);
    const off = run(withClock(0), { t: "clock.update", shown: false, at: H });
    assert.equal(lineAudience(clockLines(off.log)[0]!), "dm", "the audience is the clock's as the op leaves it");
    const on = run(withClock(0, { shown: false }), { t: "clock.update", shown: true, at: H });
    assert.equal(lineAudience(clockLines(on.log)[0]!), "shared");
  });
});

describe("Stop and a new clock (6.1)", () => {
  test("Undo setup of the stop brings the clock back whole, and a new clock has another id", () => {
    const state = withClock(5 * H);
    const stopped = run(state, { t: "clock.stop" });
    const back = restore(stopped.state, stopped.inverse!, "undo", 3, { scope: "setup" });
    assert.deepEqual(back.state.clock, state.clock);
    assert.deepEqual(texts(back.log), [], "no clock before the restore, so no clock line");
    const fresh = run(stopped.state, { t: "clock.start", id: "c2", at: 0, shown: true, calendar: DAYS }, 4);
    assert.notEqual(fresh.state.clock!.id, state.clock!.id);
    const undone = restore(fresh.state, fresh.inverse!, "undo", 5, { scope: "setup" });
    assert.ok(!("clock" in undone.state), "an undone start leaves the room as it was");
  });
});

describe("Undo and Redo of a clock change (4.7, 6.3)", () => {
  test("the DM's undo and redo of an 8-hour step each write a line players get while it is shown", () => {
    const step = run(withClock(22 * H), { t: "clock.advance", by: 8 * H });
    const undo = restore(step.state, step.inverse!, "undo", 3);
    assert.deepEqual(texts(undo.log), ["The DM undid a clock change. It is now Day 1, 10:00 PM."]);
    assert.equal(lineAudience(clockLines(undo.log)[0]!), "shared");
    const redo = restore(undo.state, undo.inverse!, "redo", 4);
    assert.deepEqual(texts(redo.log), ["The DM redid a clock change. It is now Day 2, 6:00 AM."]);
    assert.equal(clockLines(projectState(redo.state, P1, { sceneId: "s1" }).log).length, 3, "the step, its undo and its redo");
  });

  test("a player's restore, one outside the correction gate and a replay of a v40 restore in a room with no clock write none", () => {
    const step = run(withClock(22 * H), { t: "clock.advance", by: 8 * H });
    assert.deepEqual(texts(restore(step.state, step.inverse!, "undo", 3, { who: P1, gate: false }).log), []);
    assert.deepEqual(texts(restore(step.state, step.inverse!, "undo", 3, { gate: false }).log), []);
    const hp = run(base(), { t: "actor.hp", target: { characterId: "bree" }, change: { kind: "heal", amount: 2 } });
    assert.deepEqual(texts(restore(hp.state, hp.inverse!, "undo", 3, { opVersion: 40 }).log), []);
  });

  test("a replay of the DM's undo from op version 42 writes the same line again", () => {
    const step = run(withClock(22 * H), { t: "clock.advance", by: 8 * H });
    const live = restore(step.state, step.inverse!, "undo", 3);
    const replay = restore(step.state, step.inverse!, "undo", 3, { opVersion: 42 });
    assert.deepEqual(replay.log, live.log);
  });

  test("an undo whose date text does not change writes none", () => {
    const step = run(withClock(22 * H), { t: "clock.advance", by: 20 });
    assert.deepEqual(texts(restore(step.state, step.inverse!, "undo", 3).log), []);
  });

  test("an undo while hidden is the DM's line", () => {
    const step = run(withClock(22 * H, { shown: false }), { t: "clock.advance", by: 8 * H });
    const undo = restore(step.state, step.inverse!, "undo", 3);
    assert.equal(lineAudience(clockLines(undo.log)[0]!), "dm");
  });
});
