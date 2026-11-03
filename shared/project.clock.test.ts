import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys } from "./keys.ts";
import type { Calendar, LogEntry, RoomState, Viewer } from "./model.ts";
import { allKeys, projectArchivedLog, projectEntity, projectState } from "./project.ts";
import type { Op } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import { clockNow } from "./calendar.ts";
import { DM, P1, P2, character, entry, env, room, token } from "./testutil.ts";

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

describe("behind a blackout (ASTRA-06, CALB-O-05, D-261102-429)", () => {
  /** A shown clock at 8:00 AM stored, in round 11 of a fight: the current time is 60 s past it. */
  function inFight(): RoomState {
    const state = step(base(), { t: "clock.start", id: "c1", at: 8 * 3_600, shown: true, calendar: MONTHS }, 1);
    return { ...state, encounter: { rev: 1, round: 11, activeEntryId: "e2", entries: [entry("e1", { tokenId: "bree", value: 15 }), entry("e2", { tokenId: "bree", value: 5, tieOrder: 1 })] } };
  }

  test("players and a table display get no clock and no clock line, by snapshot, by key or from the archive", () => {
    let state = step(inFight(), { t: "view.blackout", blackout: true }, 2);
    state = step(state, { t: "clock.advance", by: 3 * 86_400 }, 3);
    for (const who of PLAYERS) {
      const view = seen(state, who);
      assert.ok(!("clock" in view), who.memberId);
      assert.equal(projectEntity(keys.clock, state, who, { sceneId: "s1" }), null, who.memberId);
      assert.deepEqual(clockLines(view.log), [], who.memberId);
      assert.deepEqual(clockLines(projectArchivedLog(state, state.log, who, { sceneId: "s1" })), [], who.memberId);
      for (const line of state.log) assert.equal(projectEntity(keys.log(line.id), state, who, { sceneId: "s1" }), null, `${who.memberId} ${line.id}`);
      assert.ok(!JSON.stringify(view).includes("Deepwinter"), who.memberId);
    }
    assert.ok(seen(state, DM).clock, "the DM keeps the clock");
    assert.deepEqual(clockLines(seen(state, DM).log), ["1:0", "3:0"]);
  });

  test("a line written while shared behind a blackout reaches players at the lift, though sharing went off meanwhile (D-261102-530)", () => {
    let state = step(inFight(), { t: "view.blackout", blackout: true }, 2);
    state = step(state, { t: "clock.advance", by: 600 }, 3);
    state = step(state, { t: "clock.update", shown: false }, 4);
    state = step(state, { t: "view.blackout", blackout: false }, 5);
    for (const who of MEMBERS) {
      assert.ok(!("clock" in seen(state, who)), who.memberId);
      assert.deepEqual(clockLines(seen(state, who).log), ["1:0", "3:0"], who.memberId);
    }
  });

  test("when it ends the clock comes back at the fight's time with every line, and a round after it reaches the clock", () => {
    let state = step(inFight(), { t: "view.blackout", blackout: true }, 2);
    state = step(state, { t: "clock.advance", by: 600 }, 3);
    const lifted = applyOp(state, { t: "view.blackout", blackout: false }, DM, env(4));
    assert.ok(lifted.ok);
    assert.ok(lifted.global, "a blackout's end re-projects every key, the clock's and the encounter's together");
    state = lifted.state;
    const dmNow = clockNow(state.clock!, state.encounter);
    assert.equal(dmNow, 8 * 3_600 + 600 + 60);
    for (const who of PLAYERS) {
      const view = seen(state, who);
      assert.equal(clockNow(view.clock!, view.encounter), dmNow, `${who.memberId} reads the DM's time, the fight's seconds included`);
    }
    for (const who of MEMBERS) assert.deepEqual(clockLines(seen(state, who).log), ["1:0", "3:0"], who.memberId);
    const next = applyOp(state, { t: "encounter.next" }, DM, env(5));
    assert.ok(next.ok);
    assert.ok(next.touched.includes(keys.encounter), "the round's change reaches players by the encounter's key");
    for (const who of PLAYERS) {
      const encounter = projectEntity(keys.encounter, next.state, who, { sceneId: "s1" }) as RoomState["encounter"];
      const clock = projectEntity(keys.clock, next.state, who, { sceneId: "s1" }) as RoomState["clock"];
      assert.equal(clockNow(clock!, encounter), clockNow(next.state.clock!, next.state.encounter), who.memberId);
      assert.equal(clockNow(clock!, encounter), dmNow + 6);
    }
  });
});
