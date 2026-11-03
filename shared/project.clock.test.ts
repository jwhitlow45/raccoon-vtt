import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys } from "./keys.ts";
import type { Calendar, LogEntry, RoomState, Viewer } from "./model.ts";
import { allKeys, projectArchivedLog, projectEntity, projectState } from "./project.ts";
import type { Op } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import { DM, P1, P2, character, env, room, token } from "./testutil.ts";

/** The clock's projection and its lines (docs/design/design-v1-calendar.md 6.4). */
const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };
const MONTHS: Calendar = { kind: "months", months: [{ name: "Deepwinter", days: 30 }, { name: "Thaw", days: 30 }], week: ["Moonday", "Tuesday"], era: "AF" };
const PLAYERS = [P1, P2, DISPLAY];
/** A table display reads no log line at all (project.ts projectLogEntryCtx), so the lines' tests read the players'. */
const MEMBERS = [P1, P2];

function step(state: RoomState, op: Op, seq: number, who: Viewer = DM): RoomState {
  const r = applyOp(state, op, who, env(seq));
  assert.ok(r.ok, r.ok ? "" : `${op.t}: ${r.message}`);
  return r.state;
}

function base(): RoomState {
  return room({ characters: { bree: character("bree", { ownerIds: ["p1"] }) }, tokens: { bree: token("bree", { kind: "pc", actor: { ref: "bree" }, ownerIds: ["p1"] }) } });
}

function clockLines(log: readonly LogEntry[]): string[] {
  return log.filter((line) => line.data?.type === "clock").map((line) => line.id);
}

const seen = (state: RoomState, who: Viewer) => projectState(state, who, { sceneId: "s1" });

describe("the clock reaches the DM whole and players only while shown (6.4)", () => {
  test("shown: players and a table display get its id, time and calendar with rev 0, and nothing else of it", () => {
    let state = step(base(), { t: "clock.start", id: "c1", at: 8 * 3_600, shown: true, calendar: MONTHS }, 1);
    state = step(state, { t: "clock.advance", by: 600 }, 2);
    assert.deepEqual(seen(state, DM).clock, state.clock);
    for (const who of PLAYERS) {
      assert.deepEqual(seen(state, who).clock, { id: "c1", rev: 0, t: 8 * 3_600 + 600, calendar: MONTHS }, who.memberId);
      assert.deepEqual(projectEntity(keys.clock, state, who, { sceneId: "s1" }), seen(state, who).clock);
    }
  });

  test("hidden: no player device gets the clock, by snapshot or by key, nor any line written while hidden", () => {
    let state = step(base(), { t: "clock.start", id: "c1", at: 0, shown: false, calendar: MONTHS }, 1);
    state = step(state, { t: "clock.advance", by: 3 * 86_400 }, 2);
    for (const who of PLAYERS) {
      const view = seen(state, who);
      assert.ok(!("clock" in view), who.memberId);
      assert.equal(projectEntity(keys.clock, state, who, { sceneId: "s1" }), null);
      assert.deepEqual(clockLines(view.log), []);
      assert.ok(!JSON.stringify(view).includes("Deepwinter"));
      assert.deepEqual(clockLines(projectArchivedLog(state, state.log, who, { sceneId: "s1" })), []);
    }
    assert.equal(clockLines(seen(state, DM).log).length, 2);
  });

  test("sharing on again: players get the clock as it is now and none of the lines written while it was hidden", () => {
    let state = step(base(), { t: "clock.start", id: "c1", at: 0, shown: false, calendar: MONTHS }, 1);
    state = step(state, { t: "clock.advance", by: 3_600 }, 2);
    state = step(state, { t: "clock.update", shown: true }, 3);
    for (const who of PLAYERS) {
      assert.equal(seen(state, who).clock?.t, 3_600);
      assert.deepEqual(clockLines(seen(state, who).log), []);
    }
    state = step(state, { t: "clock.advance", by: 3_600 }, 4);
    for (const who of MEMBERS) assert.deepEqual(clockLines(seen(state, who).log), ["4:0"]);
    assert.deepEqual(clockLines(seen(state, DISPLAY).log), []);
  });

  test("a player keeps every clock line that reached them, after a reload when sharing goes off and after Stop", () => {
    let state = step(base(), { t: "clock.start", id: "c1", at: 0, shown: true, calendar: MONTHS }, 1);
    state = step(state, { t: "clock.advance", by: 3_600 }, 2);
    const reached = clockLines(seen(state, P1).log);
    assert.deepEqual(reached, ["1:0", "2:0"]);
    state = step(state, { t: "clock.update", shown: false }, 3);
    assert.deepEqual(clockLines(seen(state, P1).log), reached, "after sharing goes off");
    state = step(state, { t: "clock.advance", by: 3_600 }, 4);
    assert.deepEqual(clockLines(seen(state, P1).log), reached, "and gets none written while hidden");
    state = step(state, { t: "clock.stop" }, 5);
    for (const who of MEMBERS) assert.deepEqual(clockLines(seen(state, who).log), reached, `after Stop, ${who.memberId}`);
    assert.deepEqual(clockLines(projectArchivedLog(state, state.log, P1, { sceneId: "s1" })), reached);
  });

  test("a Long Rest's stamp is the DM's, the character's owner included", () => {
    const state = step(base(), { t: "clock.start", id: "c1", at: 0, shown: true, calendar: MONTHS }, 1);
    state.characters.bree = { ...state.characters.bree!, longRest: { at: 0, clock: "c1" } };
    assert.deepEqual(seen(state, DM).characters.bree?.longRest, { at: 0, clock: "c1" });
    for (const who of PLAYERS) {
      assert.ok(!JSON.stringify(seen(state, who)).includes("longRest"), who.memberId);
      assert.ok(!JSON.stringify(projectEntity(keys.character("bree"), state, who, { sceneId: "s1" })).includes("longRest"));
    }
  });

  test("a room with no clock projects as it always did, and a global re-projection covers the clock's key", () => {
    for (const who of [DM, ...PLAYERS]) assert.ok(!("clock" in seen(base(), who)));
    assert.ok(allKeys(base()).includes(keys.clock));
  });
});
