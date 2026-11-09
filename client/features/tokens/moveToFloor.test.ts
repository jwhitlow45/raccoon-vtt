import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CHUNK_CELLS, type BuildChunk, type RoomState } from "#shared/model.ts";
import { applyOp } from "#shared/reducer.ts";
import { encodeHeights } from "#shared/rules/heights.ts";
import { DM, env, room, scene, token } from "#shared/testutil.ts";
import { fitsOn, floorChoices, movedTokens, moveToFloorOps, nameList } from "./moveToFloor.ts";

/*
 * Move to floor (docs/design/design-v1-floors.md 7.4): which floors a move
 * can go to, what it warns, and the ops it sends.
 */

/** Tower: Ground (main, 30 by 20), Upper (the same) and Attic (a smaller floor), the players starting on Ground. */
function tower(over: (s: RoomState) => void = () => {}): RoomState {
  const state = room({
    scenes: {
      g: scene("g", { name: "Tower", bounds: { w: 30, h: 20 }, floor: { of: "g", level: 0, name: "Ground floor" } }),
      u: scene("u", { name: "Tower", bounds: { w: 30, h: 20 }, floor: { of: "g", level: 1, name: "Upper floor", height: 10 } }),
      a: scene("a", { name: "Tower", bounds: { w: 10, h: 10 }, floor: { of: "g", level: 2, name: "Attic", height: 10 } }),
    },
  });
  state.meta = { ...state.meta, playerSceneId: "g" };
  over(state);
  return state;
}

const thorn = (over = {}) => token("thorn", { sceneId: "g", kind: "pc", name: "Thorn", partyVision: true, x: 4, y: 4, ...over });

/** A chunk of `sceneId` with the ground at `feet` over its first cell. */
function platform(sceneId: string, feet: number): BuildChunk {
  const heights = new Int16Array(CHUNK_CELLS * CHUNK_CELLS).fill(feet);
  return { sceneId, cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, heights: encodeHeights(heights) };
}

describe("the floors a move can go to", () => {
  test("every floor of the scene but the one they stand on, top first", () => {
    const state = tower((s) => void (s.tokens.thorn = thorn()));
    assert.deepEqual(floorChoices(state, [state.tokens.thorn!]).map((c) => c.name), ["Attic", "Upper floor"]);
    const onUpper = tower((s) => void (s.tokens.thorn = thorn({ sceneId: "u" })));
    assert.deepEqual(floorChoices(onUpper, [onUpper.tokens.thorn!]).map((c) => c.name), ["Attic", "Ground floor"]);
  });

  test("a floor is off where the full space of a creature lies outside it", () => {
    const state = tower((s) => void (s.tokens.thorn = thorn({ x: 12, y: 4 })));
    const attic = floorChoices(state, [state.tokens.thorn!]).find((c) => c.name === "Attic")!;
    assert.equal(attic.off, "Outside Attic");
    const upper = floorChoices(state, [state.tokens.thorn!]).find((c) => c.name === "Upper floor")!;
    assert.equal(upper.off, null);
  });

  test("a large creature's whole box counts, and a squeezed one counts full size", () => {
    const edge = token("ogre", { sceneId: "g", size: "large", x: 9, y: 4 });
    assert.equal(fitsOn(scene("a", { bounds: { w: 10, h: 10 } }), edge), false, "9 + 2 > 10");
    assert.equal(fitsOn(scene("a", { bounds: { w: 11, h: 10 } }), edge), true);
    const squeezed = token("ogre2", { sceneId: "g", size: "large", x: 9, y: 4, squeeze: true });
    assert.equal(fitsOn(scene("a", { bounds: { w: 10, h: 10 } }), squeezed), false, "it lands unsqueezed");
  });

  test("an unhidden party member bound for a floor players have not reached warns in one line", () => {
    const state = tower((s) => void (s.tokens.thorn = thorn()));
    const [attic, upper] = floorChoices(state, [state.tokens.thorn!]);
    assert.equal(attic!.warning, "Players haven't reached Attic. Moving Thorn there opens it to them.");
    assert.equal(upper!.warning, "Players haven't reached Upper floor. Moving Thorn there opens it to them.");
  });

  test("no warning for a floor already reached, a monster, or a hidden party member", () => {
    const reached = tower((s) => {
      s.tokens.thorn = thorn();
      s.openFloors = { a: { sceneId: "a", rev: 0 } };
    });
    assert.equal(floorChoices(reached, [reached.tokens.thorn!])[0]!.warning, null, "Attic is reached");
    const goblin = tower((s) => void (s.tokens.gob = token("gob", { sceneId: "g", x: 2, y: 2 })));
    assert.deepEqual(floorChoices(goblin, [goblin.tokens.gob!]).map((c) => c.warning), [null, null]);
    const hidden = tower((s) => void (s.tokens.thorn = thorn({ visibility: "dm" })));
    assert.deepEqual(floorChoices(hidden, [hidden.tokens.thorn!]).map((c) => c.warning), [null, null]);
    const prepared = tower((s) => {
      s.tokens.thorn = thorn();
      s.meta = { ...s.meta, playerSceneId: "elsewhere" };
    });
    assert.deepEqual(floorChoices(prepared, [prepared.tokens.thorn!]).map((c) => c.warning), [null, null], "a scene the players are not on opens nothing");
  });

  test("a mount's rider is part of the move: the warning names the rider and the mount that carries them", () => {
    const state = tower((s) => {
      s.tokens.horse = token("horse", { sceneId: "g", name: "Horse", size: "large", x: 4, y: 4 });
      s.tokens.thorn = thorn({ attached: { to: "horse", kind: "ride" } });
    });
    const horse = state.tokens.horse!;
    assert.deepEqual(movedTokens(state, [horse]).map((t) => t.id), ["horse", "thorn"]);
    assert.equal(floorChoices(state, [horse])[1]!.warning, "Players haven't reached Upper floor. Moving Thorn there opens it to them.");
  });

  test("a scene with one floor offers none, and names read as a list", () => {
    const plain = room({ scenes: { s1: scene("s1") }, tokens: { t: token("t") } });
    assert.deepEqual(floorChoices(plain, [plain.tokens.t!]), []);
    assert.deepEqual([nameList([]), nameList(["Thorn"]), nameList(["Thorn", "Bree"]), nameList(["Thorn", "Bree", "Mira"])], ["", "Thorn", "Thorn and Bree", "Thorn, Bree and Mira"]);
  });
});

describe("the ops of the move", () => {
  test("one token.update a creature, new floor in the patch, and the reducer lands it there with what it carries", () => {
    const state = tower((s) => {
      s.tokens.horse = token("horse", { sceneId: "g", name: "Horse", size: "large", x: 4, y: 4 });
      s.tokens.thorn = thorn({ attached: { to: "horse", kind: "ride" } });
    });
    const ops = moveToFloorOps(state, [state.tokens.horse!], state.scenes.u!);
    assert.deepEqual(ops, [{ t: "token.update", tokenId: "horse", patch: { sceneId: "u" } }]);
    const r = applyOp(state, ops[0]!, DM, env(1));
    assert.ok(r.ok);
    assert.equal(r.state.tokens.horse!.sceneId, "u");
    assert.equal(r.state.tokens.thorn!.sceneId, "u", "the rider goes with the mount");
  });

  test("a creature already on the floor is left out", () => {
    const state = tower((s) => void (s.tokens.thorn = thorn({ sceneId: "u" })));
    assert.deepEqual(moveToFloorOps(state, [state.tokens.thorn!], state.scenes.u!), []);
  });

  test("a creature on the ground lands on the ground of the floor, one flying keeps its height", () => {
    const state = tower((s) => {
      s.buildChunks["u:0,0"] = platform("u", 10);
      s.tokens.thorn = thorn({ x: 4, y: 4, elevation: 0 });
      s.tokens.bird = token("bird", { sceneId: "g", x: 6, y: 6, elevation: 30 });
    });
    const [thorn1] = moveToFloorOps(state, [state.tokens.thorn!], state.scenes.u!);
    assert.deepEqual(thorn1, { t: "token.update", tokenId: "thorn", patch: { sceneId: "u", elevation: 10 } });
    const [bird] = moveToFloorOps(state, [state.tokens.bird!], state.scenes.u!);
    assert.deepEqual(bird, { t: "token.update", tokenId: "bird", patch: { sceneId: "u" } });
  });
});
