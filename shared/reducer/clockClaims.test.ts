import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ClockLogEvent, LogEntry, Viewer } from "../model.ts";
import { projectState } from "../project.ts";
import type { Op } from "../protocol.ts";
import { DM, P1 } from "../testutil.ts";
import { DAYS, H, base, clockLines, restore, run, withClock } from "./clockTesting.ts";

/**
 * Each clock line names the op that wrote it (docs/design/design-v1-calendar-c2c3.md
 * 4.6, CALBUILD-ASTRA-05): the client's claim on a clock op, the head of
 * the history step on a DM's Undo or Redo, and no claim in a player's or a
 * table display's copy.
 */
const CLAIM = "7d1f0b4e-3c2a-4e5b-9a6d-8c7b6a5f4e3d";
const HEAD = "0f9e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f";
const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };

function claims(log: readonly LogEntry[]): (string | undefined)[] {
  return clockLines(log).map((line) => (line.data as ClockLogEvent).claim);
}

describe("a clock op's claim goes on the line it writes (4.6)", () => {
  test("start, set, a step and a Calendar save that moves the time each copy their claim", () => {
    assert.deepEqual(claims(run(base(), { t: "clock.start", id: "c1", at: 0, shown: true, calendar: DAYS, claim: CLAIM }).log), [CLAIM]);
    for (const op of [
      { t: "clock.set", at: 5 * H, claim: CLAIM },
      { t: "clock.advance", by: H, claim: CLAIM },
      { t: "clock.advance", by: 8 * H, why: "longRest", claim: CLAIM },
      { t: "clock.update", at: 5 * H, calendar: DAYS, claim: CLAIM },
    ] as Op[]) {
      assert.deepEqual(claims(run(withClock(0), op).log), [CLAIM], op.t);
    }
  });

  test("an op without one writes its line without one, and a save that keeps the time writes no line", () => {
    assert.deepEqual(claims(run(withClock(0), { t: "clock.advance", by: H }).log), [undefined]);
    assert.deepEqual(claims(run(withClock(0), { t: "clock.update", shown: false, claim: CLAIM }).log), []);
  });

  test("a DM's Undo or Redo puts the head it named on its clock line, and a restore that names none writes none", () => {
    const step = run(withClock(0), { t: "clock.advance", by: 8 * H });
    const undone = restore(step.state, step.inverse!, "undo", 5);
    assert.deepEqual(claims(undone.log), [undefined]);
    const op: Op = { t: "sys.restore", entries: step.inverse!, from: "undo", deps: true, scope: "play", correction: { label: "moving the clock on 8 hours" }, claim: HEAD };
    const claimed = run(step.state, op, 5);
    assert.deepEqual(claims(claimed.log), [HEAD]);
    const redo = run(claimed.state, { ...op, entries: claimed.inverse!, from: "redo" } as Op, 6);
    assert.deepEqual(claims(redo.log), [HEAD]);
  });

  test("the DM's copy keeps a line's claim, and a player's and a display's copy holds none", () => {
    const r = run(withClock(0), { t: "clock.advance", by: H, claim: CLAIM });
    assert.deepEqual(claims(projectState(r.state, DM, { sceneId: "s1" }).log), [CLAIM]);
    for (const who of [P1, DISPLAY]) {
      const lines = clockLines(projectState(r.state, who, { sceneId: "s1" }).log);
      for (const line of lines) assert.equal("claim" in (line.data as ClockLogEvent), false, who.memberId);
    }
    assert.equal(clockLines(projectState(r.state, P1, { sceneId: "s1" }).log).length, 1, "the player still gets the line");
  });
});
