import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HARD } from "#shared/limits.ts";
import { DM_LINE_BASE, lineAudience, liveStart } from "#shared/logRings.ts";
import type { LogEntry, RoomState, Viewer } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { AT, DM, env, P1, randomOp, randomState, rng, room, token } from "#shared/testutil.ts";
import { fullRoom } from "./limitsTesting.ts";
import { farWidthsByFloor, measuredFromStored, measuredStateBytes, numberingAdjust, shedOf, storedBytes } from "./sizeGuard.ts";

/*
 * The stored bound's measure and shed (design 1.4): storedBytes is the
 * snapshot's own size, the shed's bookkeeping sits outside both measures,
 * and shedOf takes the oldest archived DM lines, then the oldest steps the
 * room held before the batch, only until the room fits.
 */

const snapshotBytes = (state: RoomState) => Buffer.byteLength(JSON.stringify(state));
const SERVER: Viewer = { memberId: "server", role: "dm" };
const ALL = (state: RoomState) => new Set(state.log.map((e) => e.id));
const dmIds = (state: RoomState) => state.log.filter((e) => lineAudience(e) === "dm").map((e) => e.id);

/** `state` with `shed` applied as the actor appends it. */
function shedState(state: RoomState, shed: { lines: string[]; steps: number }): RoomState {
  const r = applyOp(state, { t: "sys.shed", ...shed } as Op, SERVER, { seq: 9_000, at: AT, uncounted: true });
  assert.ok(r.ok, r.ok ? "" : r.message);
  return r.state;
}

describe("storedBytes is the snapshot's size, from the sizes kept per entity", () => {
  test("on the full fixture with a fight and without, random rooms, and a room with a shed line's id", () => {
    const states: [string, RoomState][] = [["full, fight", fullRoom().state], ["full, no fight", fullRoom({ fight: false }).state]];
    for (let seed = 1; seed <= 30; seed++) states.push([`random ${seed}`, randomState(rng(seed))]);
    const marked = room();
    marked.dmLogShed = `12:${DM_LINE_BASE + 3}`;
    states.push(["shed", marked]);
    for (const [what, state] of states) assert.equal(storedBytes(state), snapshotBytes(state), what);
  });

  test("along random ops, each room's size, numbers and widths stepped from the room before it read as summed whole", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const r = rng(seed);
      let state = randomState(r);
      // More creatures than a stepped sum reads apart, so a copy of a room, every entry a new object, is summed whole.
      for (let k = 0; k < 150; k++) state.tokens[`many${k}`] = token(`many${k}`, { sceneId: k % 3 === 0 ? "s2" : "s1", kind: k % 2 === 0 ? "monster" : "npc", x: k % 30, y: Math.floor(k / 30) });
      const steps: { state: RoomState; stored: number; numbering: number; widths: [string, number][] }[] = [];
      for (let i = 0; i < 40; i++) {
        const who = i % 4 === 3 ? P1 : DM;
        const result = applyOp(state, randomOp(r, state, who), who, env(100 + i));
        if (!result.ok) continue;
        state = result.state;
        steps.push({ state, stored: storedBytes(state), numbering: numberingAdjust(state), widths: [...farWidthsByFloor(state)].sort() });
      }
      assert.ok(steps.length > 20, `seed ${seed}: ${steps.length} ops applied`);
      // Read after the walk, so no copy stands between one room and the next as the last one summed.
      for (const [i, step] of steps.entries()) {
        const whole = structuredClone(step.state);
        assert.equal(step.stored, snapshotBytes(step.state), `seed ${seed} step ${i}: stored`);
        assert.equal(step.numbering, numberingAdjust(whole), `seed ${seed} step ${i}: numbering`);
        assert.deepEqual(step.widths, [...farWidthsByFloor(whole)].sort(), `seed ${seed} step ${i}: widths`);
      }
    }
  });

  test("the shed line's id is outside both measures", () => {
    const state = fullRoom().state;
    const marked = { ...state, dmLogShed: `7:${DM_LINE_BASE}` };
    assert.equal(measuredStateBytes(marked), measuredStateBytes(state));
    assert.equal(measuredFromStored(snapshotBytes(marked), marked), measuredStateBytes(state));
  });
});

describe("shedOf (design 1.4)", () => {
  const full = fullRoom().state;

  test("a room at the far lines fits the stored bound and sheds nothing", () => {
    assert.ok(storedBytes(full) <= HARD.storedBytes, `${storedBytes(full)}`);
    assert.equal(shedOf(full, storedBytes(full), ALL(full), full), null);
  });

  test("past the bound, the oldest DM lines go first and only until it fits: one line fewer would not", () => {
    const stored = storedBytes(full);
    const dm = dmIds(full);
    for (const over of [1, 20_000, 300_000]) {
      const bound = stored - over;
      const shed = shedOf(full, stored, ALL(full), full, bound)!;
      assert.equal(shed.steps, 0, `${over}: the lines were enough`);
      assert.deepEqual(shed.lines, dm.slice(0, shed.lines.length), `${over}: an oldest prefix`);
      const after = shedState(full, shed);
      assert.ok(storedBytes(after) <= bound, `${over}: fits`);
      assert.equal(after.dmLogShed, shed.lines.at(-1));
      if (shed.lines.length > 1) assert.ok(storedBytes(shedState(full, { lines: shed.lines.slice(0, -1), steps: 0 })) > bound, `${over}: minimal`);
    }
  });

  test("the lines stop at the first line the archive lacks, of any audience, and the oldest steps go next, never the newest or one the batch wrote", () => {
    const stored = storedBytes(full);
    const dm = dmIds(full);
    const firstShared = full.log.find((e) => lineAudience(e) === "shared" && full.log.indexOf(e) > full.log.findIndex((x) => x.id === dm[2]))!;
    const archived = new Set(full.log.filter((e) => e !== firstShared).map((e) => e.id));
    const before = { ...full, encounterHistory: full.encounterHistory.slice(0, -2) };
    const shed = shedOf(full, stored, archived, before, 0)!;
    const stop = full.log.indexOf(firstShared);
    assert.deepEqual(shed.lines, full.log.slice(0, stop).filter((e) => lineAudience(e) === "dm").map((e) => e.id), "every DM line before the unarchived one, none after");
    assert.equal(shed.steps, full.encounterHistory.length - 2, "every step the room held before the batch, the batch's two kept");
    const unarchivedDm = new Set(full.log.filter((e) => e.id !== dm[1]).map((e) => e.id));
    assert.deepEqual(shedOf(full, stored, unarchivedDm, full, 0)!.lines, [dm[0]], "an unarchived DM line stops the prefix at itself");
    const oneStep = { ...full, encounterHistory: full.encounterHistory.slice(-1) };
    assert.equal(shedOf(oneStep, storedBytes(oneStep), new Set(), oneStep, 0), null, "the newest step stays, so nothing may go");
  });

  test("sys.shed refuses a line the log lacks or one players read, and a shed of every step", () => {
    const dm = dmIds(full);
    const shared = full.log.find((e) => lineAudience(e) === "shared")!.id;
    const cases: [string, { lines: string[]; steps: number }][] = [
      ["a line the log lacks", { lines: [`1:${DM_LINE_BASE + 77}`], steps: 0 }],
      ["a line players read", { lines: [shared], steps: 0 }],
      ["every step", { lines: [], steps: full.encounterHistory.length }],
    ];
    for (const [what, op] of cases) {
      const r = applyOp(full, { t: "sys.shed", ...op } as Op, SERVER, { seq: 9_000, at: AT, uncounted: true });
      assert.equal(r.ok, false, what);
    }
    assert.ok(dm.length > 0);
  });
});

describe("the DM's live log after a shed (logRings.ts liveStarts)", () => {
  const line = (id: string, text: string): LogEntry => ({ id, at: AT, kind: "chat", from: "dm1", text });

  test("starts just past the newest shed line, defined when no DM line is left, and a player's start does not move", () => {
    const state = room();
    state.log = [line("3:0", "a"), line(`4:${DM_LINE_BASE}`, "dm"), line("5:0", "b"), line(`6:${DM_LINE_BASE}`, "dm2"), line("7:0", "c")];
    const p1: Viewer = { memberId: "p1", role: "player" };
    assert.equal(liveStart(state, DM), null);
    const shed = shedState(state, { lines: [`4:${DM_LINE_BASE}`, `6:${DM_LINE_BASE}`], steps: 0 });
    assert.equal(shed.dmLogShed, `6:${DM_LINE_BASE}`);
    assert.equal(liveStart(shed, DM), `6:${DM_LINE_BASE + 1}`, "past the newest shed line, though no DM line is left");
    assert.equal(liveStart(shed, p1), liveStart(state, p1));
    const partial = shedState(state, { lines: [`4:${DM_LINE_BASE}`], steps: 0 });
    assert.equal(liveStart(partial, DM), `4:${DM_LINE_BASE + 1}`);
    assert.equal(liveStart({ ...partial, dmLogShed: undefined }, DM), null, "the start follows the field, not the log alone");
  });
});
