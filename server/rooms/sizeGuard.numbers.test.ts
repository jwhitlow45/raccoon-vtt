import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys, type EntityKey } from "#shared/keys.ts";
import { serializedBytes } from "#shared/limits.ts";
import type { RoomState, Token, Viewer } from "#shared/model.ts";
import { NUMBER_NAMES_MOST, NUMBERS_MOST, registerBytesMost } from "#shared/numbering.ts";
import { projectState } from "#shared/project.ts";
import { MAX_NAME, type Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { room, scene, token } from "#shared/testutil.ts";
import { MEMORY_CAP } from "./memorySize.ts";
import { Room } from "./numberingTesting.ts";
import { checkWholeScenes, growthBound, measuredFromStored, measuredStateBytes, numberingAdjust, projectedSceneBytes, projectionNumbering, roomLevelBytes, sceneOwnBytes, scenesOverByNumbering, SizeGuard, TOKEN_NUMBERING } from "./sizeGuard.ts";

/*
 * Creature numbers are written by `sys.meet` after admission, so the
 * measures count every monster's and NPC's number, group and rev, and every
 * scene's rev, at their widest, and the scenes' numbers and the room's group
 * count not at all (numberingAdjust). These tests write what a meeting
 * writes, field by field, and read every measure before and after.
 */

const DM: Viewer = { memberId: "dm1", role: "dm" };
const AT = "2026-11-10T00:00:00.000Z";

/** Two Goblins and an NPC on s1 at rev 9, one rev short of a second digit, beside an object and a character, which are never numbered. */
function unmet(): RoomState {
  const state = room();
  state.scenes.s1 = { ...state.scenes.s1!, rev: 9 };
  state.tokens.g1 = token("g1", { rev: 9 });
  state.tokens.g2 = token("g2", { rev: 9, x: 5 });
  state.tokens.n1 = token("n1", { rev: 9, kind: "npc", name: "Sister Garaele", x: 7 });
  state.tokens.o1 = token("o1", { rev: 9, kind: "object", name: "Crate", x: 9 });
  state.tokens.pc = token("pc", { rev: 9, kind: "pc", name: "Ayla", ownerIds: ["p1"], x: 11 });
  return state;
}

/**
 * A meeting's writes as `sys.meet` makes them: each creature takes `met` and
 * a number with its rev bumped, the scene's numbers gain the names with the
 * scene's rev bumped, and the room's group count goes up. `number` of null
 * leaves a creature met alone, with no number.
 */
function meet(state: RoomState, met: Record<string, { met: number; number: number | null }>, names: Record<string, [number, number]>, groups: number): { state: RoomState; touched: EntityKey[] } {
  const tokens = { ...state.tokens };
  for (const [id, mark] of Object.entries(met)) {
    const { number: _number, ...was } = tokens[id]!;
    tokens[id] = { ...was, rev: was.rev + 1, met: mark.met, ...(mark.number === null ? {} : { number: mark.number }) };
  }
  const s1 = state.scenes.s1!;
  const scenes = { ...state.scenes, s1: { ...s1, rev: s1.rev + 1, numbers: { names: { ...s1.numbers?.names, ...names } } } };
  const numbering = { rev: (state.numbering?.rev ?? 0) + 1, groups };
  return { state: { ...state, tokens, scenes, numbering }, touched: [...Object.keys(met).map((id) => keys.token(id)), keys.scene("s1"), keys.numbering] };
}

/** Every measure the guard reads, for a room. */
function measures(state: RoomState): Record<string, number> {
  return {
    state: measuredStateBytes(state),
    stored: measuredFromStored(serializedBytes(state), state),
    room: roomLevelBytes(state),
    s1: sceneOwnBytes(state, "s1"),
    s2: sceneOwnBytes(state, "s2"),
    projected: projectedSceneBytes(state, "s1"),
  };
}

function applied(state: RoomState, op: Op, seq = 1): { state: RoomState; growth: number; touched: EntityKey[] } {
  const result = applyOp(state, op, DM, { seq, at: AT });
  assert.ok(result.ok, result.ok ? "" : result.message);
  return { state: result.state, growth: growthBound(state, result.state, result.touched), touched: result.touched };
}

describe("creature numbers in the size guard", () => {
  test("a monster's or NPC's number and group count as the most numbers a name gives and the widest group id", () => {
    assert.equal(TOKEN_NUMBERING, `,"number":${NUMBERS_MOST}`.length + `,"met":${Number.MAX_SAFE_INTEGER}`.length);
    assert.equal(TOKEN_NUMBERING, 38);
  });

  test("a meeting moves no measure and grows nothing, its revs crossing a digit, at every number and group a meeting can give", () => {
    const before = unmet();
    const first = meet(before, { g1: { met: 1, number: null }, n1: { met: 2, number: null } }, { Goblin: [1, 1], "Sister Garaele": [2, 1] }, 2);
    const second = meet(first.state, { g2: { met: 1, number: 2 }, g1: { met: 1, number: 1 } }, { Goblin: [1, 2] }, 2);
    const widest = meet(second.state, { g2: { met: Number.MAX_SAFE_INTEGER, number: NUMBERS_MOST } }, { Goblin: [Number.MAX_SAFE_INTEGER, NUMBERS_MOST] }, Number.MAX_SAFE_INTEGER);
    assert.equal(second.state.tokens.g1!.rev, 11);
    assert.ok(serializedBytes(widest.state) > serializedBytes(before) + 100, "the stored room grew");
    let was = before;
    for (const step of [first, second, widest]) {
      assert.deepEqual(measures(step.state), measures(before));
      assert.equal(growthBound(was, step.state, step.touched), 0);
      was = step.state;
    }
    // At the widest, revs already 16 digits long, the measure still holds every stored byte but the scene's numbers and
    // the group count.
    const old = unmet();
    for (const id of ["g1", "g2", "n1"]) old.tokens[id] = { ...old.tokens[id]!, rev: 10 ** 15 };
    const most = { met: Number.MAX_SAFE_INTEGER, number: NUMBERS_MOST };
    const all = meet(old, { g1: most, g2: most, n1: most }, { Goblin: [Number.MAX_SAFE_INTEGER, NUMBERS_MOST] }, Number.MAX_SAFE_INTEGER);
    const { numbers: _numbers, ...s1 } = all.state.scenes.s1!;
    const { numbering: _numbering, ...rest } = all.state;
    assert.ok(measuredStateBytes(all.state) >= serializedBytes({ ...rest, scenes: { ...rest.scenes, s1 } }));
    assert.equal(measuredStateBytes(all.state), measuredStateBytes(old));
  });

  test("a room at its state cap and at its scene cap answers the same after a meeting, after an exact remeasure, and for the next op", () => {
    const before = unmet();
    const met = meet(before, { g1: { met: 1, number: 1 }, g2: { met: 1, number: 2 } }, { Goblin: [1, 2] }, 1);
    const stateLimit = measuredStateBytes(before);
    const sceneLimit = projectedSceneBytes(before, "s1");
    const guard = new SizeGuard({ stateLimit, sceneLimit });
    guard.stateMeasured(measuredFromStored(serializedBytes(before), before), before);
    assert.deepEqual(guard.check(met.state, ["s1"], growthBound(before, met.state, met.touched), before), { ok: true });
    // A restart measures the stored room exactly, as the actor does from a snapshot.
    const restarted = new SizeGuard({ stateLimit, sceneLimit });
    restarted.stateMeasured(measuredFromStored(serializedBytes(met.state), met.state), met.state);
    // The whole-scene check an import makes holds no reserve for players' copies, which only a DM's op adds, so its
    // limit is the scene's measure for a player.
    const wholeLimit = projectedSceneBytes(before, "s1", undefined, "player");
    assert.equal(checkWholeScenes(met.state, wholeLimit).ok, true);
    assert.equal(checkWholeScenes(met.state, wholeLimit - 1).ok, false);
    for (const g of [guard, restarted]) {
      // One byte more on the scene is refused and one byte less passes, as before the meeting.
      const longer = applied(met.state, { t: "token.update", tokenId: "o1", patch: { name: "Crates" } });
      assert.equal(new SizeGuard({ stateLimit, sceneLimit }).check(longer.state, ["s1"], longer.growth, met.state).ok, false);
      assert.equal(g.check(longer.state, ["s1"], longer.growth, met.state).ok, false);
      const shorter = applied(met.state, { t: "token.update", tokenId: "o1", patch: { name: "Box" } });
      assert.deepEqual(g.check(shorter.state, ["s1"], shorter.growth, met.state), { ok: true });
    }
  });

  test("two rooms of one measure, their creatures' revs and notes apart, answer every op alike after the same meeting", () => {
    // A: Goblin 2 at rev 9 and a third Goblin only the DM sees. B: Goblin 2 at rev 2, no third Goblin, and a note on the
    // crate as long as A's measure needs.
    const a = unmet();
    a.tokens.g3 = token("g3", { visibility: "dm", x: 20, notes: "lurks" });
    const b = unmet();
    b.tokens.g2 = { ...b.tokens.g2!, rev: 2 };
    b.tokens.o1 = { ...b.tokens.o1!, visibility: "dm", notes: "" };
    a.tokens.o1 = { ...a.tokens.o1!, visibility: "dm", notes: "" };
    b.tokens.o1 = { ...b.tokens.o1, notes: "x".repeat(measuredStateBytes(a) - measuredStateBytes(b)) };
    assert.equal(measuredStateBytes(a), measuredStateBytes(b));
    assert.equal(projectedSceneBytes(a, "s1"), projectedSceneBytes(b, "s1"));
    const p1: Viewer = { memberId: "p1", role: "player" };
    assert.deepEqual(projectState(a, p1, { sceneId: "s1" }).tokens, projectState(b, p1, { sceneId: "s1" }).tokens, "the party's copies match");
    const marks = { g1: { met: 1, number: 1 }, g2: { met: 1, number: 2 } };
    const metA = meet(a, marks, { Goblin: [1, 2] }, 1);
    const metB = meet(b, marks, { Goblin: [1, 2] }, 1);
    assert.notEqual(serializedBytes(metA.state) - serializedBytes(a), serializedBytes(metB.state) - serializedBytes(b), "only A's rev gained a digit");
    for (const delta of [-1, 0, 1]) {
      const limits = { stateLimit: measuredStateBytes(a) + delta, sceneLimit: projectedSceneBytes(a, "s1") + delta };
      const answer = (was: RoomState, met: { state: RoomState; touched: EntityKey[] }) => {
        const guard = new SizeGuard(limits);
        guard.stateMeasured(measuredFromStored(serializedBytes(was), was), was);
        guard.grew(growthBound(was, met.state, met.touched), ["s1"]);
        const next = applied(met.state, { t: "token.update", tokenId: "pc", patch: { name: "Aylah" } });
        return [guard.check(next.state, ["s1"], next.growth, met.state).ok, new SizeGuard(limits).check(next.state, ["s1"], next.growth, met.state).ok];
      };
      assert.deepEqual(answer(a, metA), answer(b, metB), `limits ${delta} from the measure`);
    }
  });

  test("a kind change into a monster brings the reserve inside its own op's check, and a change out of it gives the reserve back", () => {
    const before = unmet();
    const made = applied(before, { t: "token.update", tokenId: "o1", patch: { kind: "monster" } });
    const reserve = measuredStateBytes(made.state) - measuredStateBytes(before);
    // Its number and group at their widest, and its rev, now 10, at 16 digits.
    assert.equal(made.state.tokens.o1!.rev, 10);
    assert.equal(reserve, TOKEN_NUMBERING + 14 + (serializedBytes(made.state) - serializedBytes(before)));
    assert.ok(made.growth >= reserve, `the bound ${made.growth} holds the reserve ${reserve}`);
    const stateLimit = measuredStateBytes(made.state) - 1;
    const guard = new SizeGuard({ stateLimit });
    guard.stateMeasured(measuredStateBytes(before), before);
    assert.equal(guard.check(made.state, ["s1"], made.growth, before).ok, false, "a room one byte short refuses the change");
    const back = applied(made.state, { t: "token.update", tokenId: "o1", patch: { kind: "object" } }, 2);
    assert.ok(measuredStateBytes(back.state) < measuredStateBytes(made.state));
    // An object carrying a number from before its change counts as it is stored, and a meeting never writes one.
    const kept = { ...before, tokens: { ...before.tokens, o1: { ...before.tokens.o1!, number: 3, met: 1 } } };
    assert.equal(measuredStateBytes(kept) - measuredStateBytes(before), serializedBytes(kept) - serializedBytes(before));
  });

  test("a scene's numbers at their caps and the room's group count add nothing to any measure", () => {
    const before = unmet();
    const names: Record<string, [number, number]> = {};
    for (let i = 0; i < NUMBER_NAMES_MOST; i++) names[String.fromCharCode(0xd800 + i).repeat(MAX_NAME)] = [Number.MAX_SAFE_INTEGER, NUMBERS_MOST];
    const full = meet(before, {}, names, Number.MAX_SAFE_INTEGER);
    assert.deepEqual(measures(full.state), measures(before));
    assert.equal(growthBound(before, full.state, full.touched), 0);
    assert.equal(numberingAdjust(full.state) - numberingAdjust(before), -(serializedBytes(full.state) - serializedBytes(before)));
    // A DM's snapshot holds them beyond the measure, within the bound the caps give.
    const shown = projectState(full.state, DM, { sceneId: "s1" }).scenes.s1!;
    assert.ok(shown.numbers, "a DM's copy holds the scene's numbers");
    const { numbers: _numbers, ...bare } = shown;
    assert.ok(serializedBytes(shown) - serializedBytes(bare) <= registerBytesMost(), `${serializedBytes(shown) - serializedBytes(bare)} over ${registerBytesMost()}`);
  });
});

describe("a room's load names each scene creature numbers put over its limit", () => {
  /** The Goblins on s1, and s2 with no creature, whose measures read no players' memory, so any share gives them. */
  const measured = (state: RoomState, sceneId: string) => {
    const bytes = projectedSceneBytes(state, sceneId, MEMORY_CAP);
    assert.equal(projectedSceneBytes(state, sceneId, 0), bytes, `${sceneId} reads no players' memory`);
    return bytes;
  };

  test("a scene over its limit only once numbers count is named by its main floor, one within it or over it anyway is not", () => {
    const state = unmet();
    const s1 = measured(state, "s1");
    const numbers = projectionNumbering(state, "s1");
    assert.ok(numbers > 0 && measured(state, "s2") < s1 - numbers, "the Goblins' numbers are what s1 counts beyond s2");
    assert.deepEqual(scenesOverByNumbering(state, MEMORY_CAP, s1 - 1), ["s1"]);
    assert.deepEqual(scenesOverByNumbering(state, MEMORY_CAP, s1 - numbers), ["s1"], "within it by a byte without them");
    assert.deepEqual(scenesOverByNumbering(state, MEMORY_CAP, s1), [], "within it with them");
    assert.deepEqual(scenesOverByNumbering(state, MEMORY_CAP, s1 - numbers - 1), [], "over it without them");
    // A scene of two floors counts as one, named by its main floor, with the numbers of the creatures on either.
    const floors = unmet();
    floors.scenes.s1 = { ...floors.scenes.s1!, floor: { of: "s1", level: 0, name: "Ground" } };
    floors.scenes.up = scene("up", { floor: { of: "s1", level: 1, name: "Upper" } });
    floors.tokens.g2 = { ...floors.tokens.g2!, sceneId: "up" };
    const whole = measured(floors, "up");
    assert.equal(measured(floors, "s1"), whole);
    assert.deepEqual(scenesOverByNumbering(floors, MEMORY_CAP, whole - 1), ["s1"]);
    assert.deepEqual(scenesOverByNumbering(floors, MEMORY_CAP, whole - projectionNumbering(floors, "up")), ["s1"]);
  });

  test("the room's load warns once for that scene, with the room's and the scene's ids and no name", async (t) => {
    const state = unmet();
    const sceneLimit = measured(state, "s1") - 1;
    const room = new Room(t, "A", state, { sizeLimits: { sceneLimit } });
    await room.load();
    const warned = () => room.logged.filter((line) => line.startsWith("a scene is over its size limit"));
    assert.deepEqual(warned(), ['a scene is over its size limit once creature numbers are reserved {"roomId":"UNDOSCOPE","sceneId":"s1"}']);
    await room.restart(false);
    assert.equal(warned().length, 2, "and once again at the next load");
  });
});
