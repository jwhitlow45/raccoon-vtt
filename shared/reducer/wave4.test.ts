import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decodeHeights, decodeStairs, heightAt, stairMarkAt } from "../heightCodec.ts";
import { rangeGround } from "../rules/heights.ts";
import { chunkKey, keys, tileKey } from "../keys.ts";
import type { FogTile, FreeWall, RoomState } from "../model.ts";
import type { Op } from "../protocol.ts";
import { projectState } from "../project.ts";
import { applyOp, type Applied } from "../reducer.ts";
import { decodeTile, encodeTile, getBit, TILE_BYTES } from "../rules/fog.ts";
import { DM, P1, actor, apply, entry, env, refused, reveal, room, scene, token } from "../testutil.ts";
import { guardMatches } from "./misc.ts";

/**
 * The wave 4 reducer (docs/design-v1-maps-vision.md section 4): doors,
 * heights and stairs with the tokens standing on them, squeezes and
 * teleports, carried lights and party members, vision settings and phase
 * light, and the party's explored layer beside the DM's fog.
 */

function run(state: RoomState, op: Op, seq = 1, who = DM): Applied {
  const result = applyOp(state, op, who, env(seq));
  assert.ok(result.ok, `expected ${op.t} to apply, got ${result.ok ? "" : `${result.code}: ${result.message}`}`);
  return result;
}

function undo(state: RoomState, applied: Applied, seq = 50): Applied {
  assert.ok(applied.inverse, "the op has an inverse");
  return run(state, { t: "sys.restore", entries: applied.inverse, from: "undo", deps: true }, seq);
}

/** A tile of explored bits with the sub-cells of one cell rectangle set, in tile-local cells. */
function bitsOf(cells: { x0: number; y0: number; x1: number; y1: number }): string {
  const bytes = new Uint8Array(TILE_BYTES);
  for (let sy = cells.y0 * 4; sy < cells.y1 * 4; sy++) {
    for (let sx = cells.x0 * 4; sx < cells.x1 * 4; sx++) {
      const i = sy * 64 + sx;
      bytes[i >> 3] = bytes[i >> 3]! | (1 << (i & 7));
    }
  }
  return encodeTile(bytes);
}

function explore(state: RoomState, sceneId: string, tiles: { tx: number; ty: number; bits: string }[], seq = 10): Applied {
  return run(state, { t: "sys.explore", sceneId, tiles }, seq);
}

function cellSeen(tile: FogTile | undefined, x: number, y: number): boolean {
  const bits = tile ? decodeTile(tile.bits) : null;
  return bits !== null && getBit(bits, (x % 16) * 4 + 1, (y % 16) * 4 + 1);
}

const DOOR = { kind: "door", state: "closed", secret: false, discovered: false } as const;
const freeDoor: FreeWall = { id: "doordoordoor", a: [2.5, 1], b: [2.5, 2], f: DOOR };

describe("door.set", () => {
  function withDoors(): RoomState {
    const state = room();
    state.buildChunks[chunkKey("s1", 0, 0)] = {
      sceneId: "s1",
      cx: 0,
      cy: 0,
      rev: 0,
      cells: { "3,3": "stone" },
      edges: { "3,3,n": DOOR, "4,3,w": { kind: "door", state: "locked", secret: true, discovered: false }, "5,3,w": { kind: "wall" } },
      walls: [freeDoor],
    };
    return state;
  }

  test("sets an edge door's state and a secret door's found mark, and moves the walls version", () => {
    const state = withDoors();
    const opened = run(state, { t: "door.set", sceneId: "s1", door: { edge: "3,3,n" }, state: "open" });
    assert.deepEqual(opened.state.buildChunks[chunkKey("s1", 0, 0)]!.edges["3,3,n"], { ...DOOR, state: "open" });
    assert.equal(opened.state.scenes.s1!.wallsVersion, 1);
    const found = apply(state, { t: "door.set", sceneId: "s1", door: { edge: "4,3,w" }, state: "closed", found: true });
    assert.deepEqual(found.buildChunks[chunkKey("s1", 0, 0)]!.edges["4,3,w"], { kind: "door", state: "closed", secret: true, discovered: true });
    const hidden = apply(found, { t: "door.set", sceneId: "s1", door: { edge: "4,3,w" }, state: "locked", found: false });
    assert.deepEqual(hidden.buildChunks[chunkKey("s1", 0, 0)]!.edges["4,3,w"], { kind: "door", state: "locked", secret: true, discovered: false });
  });

  test("sets a free door by its chunk and id", () => {
    const next = apply(withDoors(), { t: "door.set", sceneId: "s1", door: { cx: 0, cy: 0, id: freeDoor.id }, state: "locked" });
    assert.deepEqual(next.buildChunks[chunkKey("s1", 0, 0)]!.walls, [{ ...freeDoor, f: { ...DOOR, state: "locked" } }]);
  });

  test("anything that is not a door is not there", () => {
    const state = withDoors();
    for (const door of [{ edge: "5,3,w" }, { edge: "6,3,w" }, { edge: "40,3,w" }, { cx: 0, cy: 0, id: "nonenonenone" }, { cx: 1, cy: 0, id: freeDoor.id }]) {
      assert.equal(refused(state, { t: "door.set", sceneId: "s1", door, state: "open" }).code, "gone", JSON.stringify(door));
    }
  });

  test("a door already so writes nothing, and the DM's undo puts the chunk back without the walls version", () => {
    const state = withDoors();
    const same = run(state, { t: "door.set", sceneId: "s1", door: { edge: "3,3,n" }, state: "closed" });
    assert.deepEqual(same.touched, []);
    const opened = run(state, { t: "door.set", sceneId: "s1", door: { edge: "3,3,n" }, state: "open" });
    assert.deepEqual(
      opened.inverse!.map((e) => e.key),
      [keys.chunk("s1", 0, 0)],
    );
    const back = undo(opened.state, opened);
    assert.deepEqual(back.state.buildChunks[chunkKey("s1", 0, 0)]!.edges["3,3,n"], DOOR);
    assert.ok(back.state.scenes.s1!.wallsVersion > opened.state.scenes.s1!.wallsVersion);
  });
});

describe("heights and stairs", () => {
  test("paints heights in their chunk's stored form, clears them with 0, and drops an empty chunk", () => {
    const state = room();
    let next = apply(state, { t: "build.height", sceneId: "s1", cells: ["2,3", "17,3"], height: 10 });
    assert.equal(heightAt(next.buildChunks, "s1", 2, 3), 10);
    assert.equal(heightAt(next.buildChunks, "s1", 17, 3), 10);
    assert.equal(heightAt(next.buildChunks, "s1", 3, 3), 0);
    const chunk = next.buildChunks[chunkKey("s1", 0, 0)]!;
    assert.equal(chunk.heights!.length, 684);
    assert.deepEqual(chunk.cells, {});
    assert.equal(decodeHeights(chunk.heights)[3 * 16 + 2], 10);
    next = apply(next, { t: "build.height", sceneId: "s1", cells: ["17,3"], height: -20 });
    assert.equal(heightAt(next.buildChunks, "s1", 17, 3), -20);
    next = apply(next, { t: "build.height", sceneId: "s1", cells: ["2,3", "17,3"], height: 0 });
    assert.deepEqual(next.buildChunks, {});
    assert.equal(next.scenes.s1!.wallsVersion, 3);
  });

  test("a height paint lifts and lowers the tokens standing on the ground there, and leaves fliers and the buried", () => {
    const state = room();
    state.tokens.walker = token("walker", { x: 2, y: 2 });
    state.tokens.big = token("big", { size: "large", x: 3, y: 2, elevation: 0 });
    state.tokens.flier = token("flier", { x: 2, y: 3, elevation: 30 });
    state.tokens.burrower = token("burrower", { x: 4, y: 4, elevation: -10 });
    state.tokens.away = token("away", { x: 10, y: 10 });
    state.tokens.other = token("other", { x: 2, y: 2, sceneId: "s2" });
    const raised = run(state, { t: "build.height", sceneId: "s1", cells: ["2,2", "2,3", "4,3", "4,4"], height: 10 });
    const t = raised.state.tokens;
    assert.equal(t.walker!.elevation, 10);
    // A Large creature's ground is the highest under it.
    assert.equal(t.big!.elevation, 10);
    assert.equal(t.flier!.elevation, 30);
    assert.equal(t.burrower!.elevation, -10);
    assert.equal(t.away!.elevation, 0);
    assert.equal(t.other!.elevation, 0);
    assert.equal(t.walker!.path, undefined, "a lift is no leg");
    const lowered = apply(raised.state, { t: "build.height", sceneId: "s1", cells: ["2,2"], height: 5 });
    assert.equal(lowered.tokens.walker!.elevation, 5);
    // The Large one still has 10 ft ground under its other cells.
    assert.equal(lowered.tokens.big!.elevation, 10);
    assert.equal(rangeGround(lowered.buildChunks, "s1", { x0: 2, y0: 2, x1: 5, y1: 4 }), 10);
  });

  test("a squeezed creature stands on the ground of its squeezed footprint", () => {
    const state = room();
    // Stored half a cell off the grid, squeezed to the 1 x 1 cell (3, 5) in a corridor.
    state.tokens.ogre = token("ogre", { size: "large", x: 2.5, y: 4.5, squeeze: true });
    const beside = apply(state, { t: "build.height", sceneId: "s1", cells: ["2,4"], height: 10 });
    assert.equal(beside.tokens.ogre!.elevation, 0, "a cell its full size covers but its squeeze does not");
    const under = apply(state, { t: "build.height", sceneId: "s1", cells: ["3,5"], height: 10 });
    assert.equal(under.tokens.ogre!.elevation, 10);
  });

  test("undoing a height paint puts its tokens back, and refuses once one of them was moved", () => {
    const state = room();
    state.tokens.walker = token("walker", { x: 2, y: 2 });
    const raised = run(state, { t: "build.height", sceneId: "s1", cells: ["2,2"], height: 10 });
    const back = undo(raised.state, raised);
    assert.equal(back.state.tokens.walker!.elevation, 0);
    assert.equal(heightAt(back.state.buildChunks, "s1", 2, 2), 0);
    const moved = apply(raised.state, { t: "token.move", tokenId: "walker", x: 2, y: 2, elevation: 15 });
    const r = applyOp(moved, { t: "sys.restore", entries: raised.inverse!, from: "undo", deps: true }, DM, env(60));
    assert.ok(!r.ok);
  });

  test("marks stairs by the rule or one way, clears them with null, and paints no terrain", () => {
    const state = room();
    let next = apply(state, { t: "build.stairs", sceneId: "s1", cells: ["1,1", "1,2"], up: "a" });
    next = apply(next, { t: "build.stairs", sceneId: "s1", cells: ["1,2"], up: "n" });
    assert.equal(stairMarkAt(next.buildChunks, "s1", 1, 1), "a");
    assert.equal(stairMarkAt(next.buildChunks, "s1", 1, 2), "n");
    assert.equal(stairMarkAt(next.buildChunks, "s1", 2, 2), ".");
    const chunk = next.buildChunks[chunkKey("s1", 0, 0)]!;
    assert.equal(chunk.up!.length, 256);
    assert.deepEqual(chunk.cells, {});
    assert.equal(decodeStairs(chunk.up)[2 * 16 + 1], "n");
    next = apply(next, { t: "build.stairs", sceneId: "s1", cells: ["1,1", "1,2"], up: null });
    assert.deepEqual(next.buildChunks, {});
  });

  test("cells outside the scene are refused", () => {
    const state = room();
    assert.equal(refused(state, { t: "build.height", sceneId: "s1", cells: ["40,0"], height: 5 }).message, "cell outside the scene");
    assert.equal(refused(state, { t: "build.stairs", sceneId: "s1", cells: ["0,30"], up: "a" }).message, "cell outside the scene");
  });

  test("erase clears heights and stair marks in its cells and Clear takes them all, landing the tokens that stood there", () => {
    let state = room();
    state.tokens.walker = token("walker", { x: 2, y: 2 });
    state.tokens.beside = token("beside", { x: 3, y: 2 });
    state.tokens.flier = token("flier", { x: 3, y: 3, elevation: 40 });
    state.tokens.mole = token("mole", { x: 3, y: 4, elevation: -15 });
    state = apply(state, { t: "build.height", sceneId: "s1", cells: ["2,2", "3,2", "3,3", "3,4"], height: 10 });
    state = apply(state, { t: "build.stairs", sceneId: "s1", cells: ["2,2", "4,2"], up: "e" });
    assert.deepEqual([state.tokens.walker!.elevation, state.tokens.beside!.elevation], [10, 10]);
    const erased = run(state, { t: "build.erase", sceneId: "s1", cells: ["2,2", "3,3", "3,4"] });
    const e = erased.state;
    assert.equal(heightAt(e.buildChunks, "s1", 2, 2), 0);
    assert.equal(heightAt(e.buildChunks, "s1", 3, 2), 10);
    assert.equal(stairMarkAt(e.buildChunks, "s1", 2, 2), ".");
    assert.equal(stairMarkAt(e.buildChunks, "s1", 4, 2), "e");
    assert.equal(e.tokens.walker!.elevation, 0, "it stood on the erased ground, so it lands on what is left");
    assert.equal(e.tokens.walker!.path, undefined, "a landing is no leg");
    assert.equal(e.tokens.beside!.elevation, 10, "its ground was not erased");
    assert.equal(e.tokens.flier!.elevation, 40, "a flier keeps its height");
    assert.equal(e.tokens.mole!.elevation, -15, "so does a burrower");
    // Erase's undo puts the ground and the tokens back together.
    const back = undo(e, erased);
    assert.equal(back.state.tokens.walker!.elevation, 10);
    assert.equal(heightAt(back.state.buildChunks, "s1", 2, 2), 10);
    // An erased rectangle and shape land them too.
    assert.equal(apply(state, { t: "build.rect", sceneId: "s1", terrain: null, x: 2, y: 2, w: 1, h: 1 }).tokens.walker!.elevation, 0);
    const cleared = run(state, { t: "build.clear", sceneId: "s1" });
    assert.deepEqual(cleared.state.buildChunks, {});
    assert.deepEqual(
      ["walker", "beside", "flier", "mole"].map((id) => cleared.state.tokens[id]!.elevation),
      [0, 0, 40, -15],
    );
    const unclear = undo(cleared.state, cleared);
    assert.deepEqual([unclear.state.tokens.walker!.elevation, unclear.state.tokens.beside!.elevation], [10, 10]);
    // Moved since, the token makes the undo refuse, as any restore does.
    const moved = apply(cleared.state, { t: "token.move", tokenId: "walker", x: 5, y: 5 });
    assert.equal(applyOp(moved, { t: "sys.restore", entries: cleared.inverse!, from: "undo", deps: true }, DM, env(70)).ok, false);
  });

  test("a stored erase of a chunk from before wave 4 replays to the same chunk", () => {
    const state = room();
    state.buildChunks[chunkKey("s1", 0, 0)] = { sceneId: "s1", cx: 0, cy: 0, rev: 3, cells: { "1,1": "stone", "2,1": "wood" }, edges: {} };
    const next = apply(state, { t: "build.erase", sceneId: "s1", cells: ["1,1"] });
    assert.deepEqual(next.buildChunks[chunkKey("s1", 0, 0)], { sceneId: "s1", cx: 0, cy: 0, rev: 4, cells: { "2,1": "wood" }, edges: {} });
  });
});

describe("squeezes and teleports", () => {
  function inFight(): RoomState {
    const state = room();
    state.tokens.ogre = token("ogre", { size: "large", x: 2, y: 2 });
    state.encounter = { rev: 0, round: 1, activeEntryId: "n1", entries: [entry("n1", { tokenId: "ogre" })], turnStart: { entryId: "n1", tokenId: "ogre", sceneId: "s1", x: 2, y: 2, elevation: 0, seq: 5 } };
    return state;
  }

  test("a move with the flag squeezes, any move without it stands full size, and moveMany clears it", () => {
    let state = inFight();
    state = apply(state, { t: "token.move", tokenId: "ogre", x: 2.5, y: 4, squeeze: true });
    assert.equal(state.tokens.ogre!.squeeze, true);
    const walked = apply(state, { t: "token.move", tokenId: "ogre", x: 2.5, y: 6 });
    assert.ok(!("squeeze" in walked.tokens.ogre!));
    const many = apply(state, { t: "token.moveMany", moves: [{ tokenId: "ogre", x: 3, y: 3 }] });
    assert.ok(!("squeeze" in many.tokens.ogre!));
  });

  test("an edit of size, scene or position clears a squeeze, and of anything else keeps it", () => {
    const state = apply(inFight(), { t: "token.move", tokenId: "ogre", x: 2.5, y: 4, squeeze: true });
    for (const patch of [{ size: "huge" as const }, { w: 2 }, { h: null }, { sceneId: "s2" }, { x: 2.5 }, { y: 4 }]) {
      assert.ok(!("squeeze" in apply(state, { t: "token.update", tokenId: "ogre", patch }).tokens.ogre!), JSON.stringify(patch));
    }
    for (const patch of [{ elevation: 5 }, { rotation: 90 }, { name: "Grog" }, { light: { bright: 20, dim: 20 } }]) {
      assert.equal(apply(state, { t: "token.update", tokenId: "ogre", patch }).tokens.ogre!.squeeze, true, JSON.stringify(patch));
    }
  });

  test("a teleport on its creature's turn adds one uncounted leg and a DM log line", () => {
    const moved = run(inFight(), { t: "token.move", tokenId: "ogre", x: 8, y: 2, teleport: "wall" });
    const path = moved.state.tokens.ogre!.path!;
    assert.deepEqual(
      path.stops.map((s) => [s.x, s.y, s.uncounted === true]),
      [
        [2, 2, false],
        [8, 2, true],
      ],
    );
    assert.deepEqual(moved.log.map((e) => e.data), [{ type: "teleport", tokenId: "ogre", past: "wall" }]);
    // The undo takes the move back and leaves the line.
    const back = undo(moved.state, moved);
    assert.equal(back.state.tokens.ogre!.x, 2);
    assert.ok(back.state.log.some((e) => e.data?.type === "teleport"));
  });

  test("a teleport outside a turn has no leg to mark and still writes the line, the same on replay", () => {
    const state = room();
    state.tokens.thorn = token("thorn", { x: 1, y: 1, ownerIds: ["p1"] });
    const op: Op = { t: "token.move", tokenId: "thorn", x: 6, y: 1, teleport: "ledge" };
    const a = run(state, op, 7, P1);
    const b = run(state, op, 7, P1);
    assert.equal(a.state.tokens.thorn!.path, undefined);
    assert.deepEqual(a.state.log, b.state.log);
    assert.deepEqual(a.log.map((e) => e.data), [{ type: "teleport", tokenId: "thorn", past: "ledge" }]);
  });
});

describe("carried lights and party members", () => {
  test("a token's light is set and put out, and party membership is stored only while it holds", () => {
    const state = room();
    state.tokens.npc = token("npc", { kind: "npc" });
    let next = apply(state, { t: "token.update", tokenId: "npc", patch: { light: { bright: 20, dim: 20 }, partyVision: true } });
    assert.deepEqual(next.tokens.npc!.light, { bright: 20, dim: 20 });
    assert.equal(next.tokens.npc!.partyVision, true);
    next = apply(next, { t: "token.update", tokenId: "npc", patch: { light: null, partyVision: false } });
    assert.ok(!("light" in next.tokens.npc!) && !("partyVision" in next.tokens.npc!));
    const created = apply(state, {
      t: "token.create",
      token: { id: "torch", sceneId: "s1", kind: "pc", name: "Torchbearer", size: "medium", x: 1, y: 1, actor: { inline: actor() }, light: { bright: 20, dim: 20 }, partyVision: false },
    });
    assert.deepEqual(created.tokens.torch!.light, { bright: 20, dim: 20 });
    assert.ok(!("partyVision" in created.tokens.torch!));
  });
});

describe("vision settings", () => {
  test("turning vision on turns fog on, unless the patch says otherwise, and is global with its undo", () => {
    const state = room();
    const on = run(state, { t: "scene.update", sceneId: "s1", patch: { vision: { on: true, light: "dark" } } });
    assert.deepEqual(on.state.scenes.s1!.vision, { on: true, light: "dark" });
    assert.equal(on.state.scenes.s1!.fogEnabled, true);
    assert.equal(on.global, true);
    const back = undo(on.state, on);
    assert.equal(back.global, true);
    assert.equal(back.state.scenes.s1!.vision, undefined);
    assert.equal(back.state.scenes.s1!.fogEnabled, false);
    const fogless = apply(state, { t: "scene.update", sceneId: "s1", patch: { vision: { on: true, light: "dim" }, fogEnabled: false } });
    assert.equal(fogless.scenes.s1!.fogEnabled, false);
    // The DM turns fog off on a vision scene, and a light change keeps it off.
    const off = apply(on.state, { t: "scene.update", sceneId: "s1", patch: { fogEnabled: false } });
    const dimmer = run(off, { t: "scene.update", sceneId: "s1", patch: { vision: { on: true, light: "dim" } } });
    assert.equal(dimmer.state.scenes.s1!.fogEnabled, false);
    assert.equal(dimmer.global, true, "a light change is global");
    const renamed = run(on.state, { t: "scene.update", sceneId: "s1", patch: { name: "Crypt" } });
    assert.equal(renamed.global, false);
  });

  test("blockMovement is a scene setting, and scene.create takes both", () => {
    const state = room();
    assert.equal(apply(state, { t: "scene.update", sceneId: "s1", patch: { blockMovement: true } }).scenes.s1!.blockMovement, true);
    const made = apply(state, { t: "scene.create", scene: { id: "s3", name: "Cave", bounds: { w: 10, h: 10 }, blockMovement: true, vision: { on: true, light: "dark" } } });
    assert.equal(made.scenes.s3!.blockMovement, true);
    assert.equal(made.scenes.s3!.fogEnabled, true);
  });

  test("removing the showing phase gives the scene the replacement's light, and its undo puts the light back", () => {
    const map = { assetId: "day", widthPx: 1000, heightPx: 800, cellPx: 50, originPx: { x: 0, y: 0 } };
    const state = room({ scenes: { s1: scene("s1", { map, fogEnabled: true, vision: { on: true, light: "dim" } }), s2: scene("s2", { order: 1 }) } });
    const day = { id: "d", name: "Day", assetId: "day", widthPx: 1000, heightPx: 800, light: "bright" as const };
    const night = { id: "n", name: "Night", assetId: "night", widthPx: 1000, heightPx: 800, light: "dark" as const };
    const plain = { id: "p", name: "Fog", assetId: "fog", widthPx: 1000, heightPx: 800 };
    let next = apply(state, { t: "scene.update", sceneId: "s1", patch: { phases: [day, night, plain] } });
    assert.deepEqual(next.scenes.s1!.vision, { on: true, light: "dim" }, "the showing phase stays, so the light does too");
    next = apply(next, { t: "scene.setPhase", sceneId: "s1", phaseId: "n" });
    assert.deepEqual(next.scenes.s1!.vision, { on: true, light: "dark" });
    const removed = run(next, { t: "scene.update", sceneId: "s1", patch: { phases: [day, plain] } });
    assert.equal(removed.state.scenes.s1!.phaseId, "d");
    assert.deepEqual(removed.state.scenes.s1!.vision, { on: true, light: "bright" }, "Day shows Day's light");
    assert.equal(removed.global, true, "a light change re-projects the scene");
    const back = undo(removed.state, removed);
    assert.equal(back.state.scenes.s1!.phaseId, "n");
    assert.deepEqual(back.state.scenes.s1!.vision, { on: true, light: "dark" });
    assert.equal(back.global, true);
    // The reverse: removing a bright phase while it shows, with a dark one first, makes the scene dark.
    const brightShowing = apply(apply(state, { t: "scene.update", sceneId: "s1", patch: { phases: [night, day] } }), { t: "scene.setPhase", sceneId: "s1", phaseId: "d" });
    assert.deepEqual(apply(brightShowing, { t: "scene.update", sceneId: "s1", patch: { phases: [night] } }).scenes.s1!.vision, { on: true, light: "dark" });
    // A replacement without a light level leaves the level as it was.
    const toPlain = apply(next, { t: "scene.update", sceneId: "s1", patch: { phases: [plain, day] } });
    assert.equal(toPlain.scenes.s1!.phaseId, "p");
    assert.deepEqual(toPlain.scenes.s1!.vision, { on: true, light: "dark" });
    // Editing the list while the showing phase stays changes no light.
    const renamed = apply(next, { t: "scene.update", sceneId: "s1", patch: { phases: [day, { ...night, name: "Midnight" }, plain] } });
    assert.deepEqual(renamed.scenes.s1!.vision, { on: true, light: "dark" });
  });

  test("a light level set on the showing phase applies at once, its undo puts the old level back, and taking it away leaves the level", () => {
    const map = { assetId: "day", widthPx: 1000, heightPx: 800, cellPx: 50, originPx: { x: 0, y: 0 } };
    const state = room({ scenes: { s1: scene("s1", { map, fogEnabled: true, vision: { on: true, light: "bright" } }), s2: scene("s2", { order: 1 }) } });
    const day = { id: "d", name: "Day", assetId: "day", widthPx: 1000, heightPx: 800 };
    const night = { id: "n", name: "Night", assetId: "night", widthPx: 1000, heightPx: 800 };
    const listed = apply(state, { t: "scene.update", sceneId: "s1", patch: { phases: [day, night] } });
    const darkDay = run(listed, { t: "scene.update", sceneId: "s1", patch: { phases: [{ ...day, light: "dark" }, night] } });
    assert.deepEqual(darkDay.state.scenes.s1!.vision, { on: true, light: "dark" });
    assert.equal(darkDay.global, true);
    const back = undo(darkDay.state, darkDay);
    assert.deepEqual(back.state.scenes.s1!.vision, { on: true, light: "bright" });
    assert.equal(back.state.scenes.s1!.phases![0]!.light, undefined);
    assert.equal(back.global, true);
    // A level set on a phase not showing waits for the switch.
    const nightDim = apply(listed, { t: "scene.update", sceneId: "s1", patch: { phases: [day, { ...night, light: "dim" }] } });
    assert.deepEqual(nightDim.scenes.s1!.vision, { on: true, light: "bright" });
    assert.deepEqual(apply(nightDim, { t: "scene.setPhase", sceneId: "s1", phaseId: "n" }).scenes.s1!.vision, { on: true, light: "dim" });
    // Taking the showing phase's level away keeps the scene's.
    const plainAgain = apply(darkDay.state, { t: "scene.update", sceneId: "s1", patch: { phases: [day, night] } });
    assert.deepEqual(plainAgain.scenes.s1!.vision, { on: true, light: "dark" });
    // A scene without vision gets the level with vision still off.
    const noVision = room({ scenes: { s1: scene("s1", { map }), s2: scene("s2", { order: 1 }) } });
    const dusk = apply(apply(noVision, { t: "scene.update", sceneId: "s1", patch: { phases: [day, night] } }), { t: "scene.update", sceneId: "s1", patch: { phases: [{ ...day, light: "dim" }, night] } });
    assert.deepEqual(dusk.scenes.s1!.vision, { on: false, light: "dim" });
  });

  test("a phase with a light level gives it to the scene's vision, and one without leaves it", () => {
    const map = { assetId: "day", widthPx: 1000, heightPx: 800, cellPx: 50, originPx: { x: 0, y: 0 } };
    const state = room({ scenes: { s1: scene("s1", { map }), s2: scene("s2", { order: 1 }) } });
    let next = apply(state, {
      t: "scene.update",
      sceneId: "s1",
      patch: { phases: [{ id: "d", name: "Day", assetId: "day", widthPx: 1000, heightPx: 800 }, { id: "n", name: "Night", assetId: "night", widthPx: 1000, heightPx: 800, light: "dark" }, { id: "f", name: "Fog", assetId: "fog", widthPx: 1000, heightPx: 800 }] },
    });
    assert.equal(next.scenes.s1!.phases![1]!.light, "dark");
    const night = run(next, { t: "scene.setPhase", sceneId: "s1", phaseId: "n" });
    assert.deepEqual(night.state.scenes.s1!.vision, { on: false, light: "dark" });
    assert.equal(night.global, true);
    next = apply(night.state, { t: "scene.update", sceneId: "s1", patch: { vision: { on: true, light: "dark" } } });
    const foggy = apply(next, { t: "scene.setPhase", sceneId: "s1", phaseId: "f" });
    assert.deepEqual(foggy.scenes.s1!.vision, { on: true, light: "dark" });
  });
});

describe("the explored layer", () => {
  function visionScene(): RoomState {
    const state = room();
    state.scenes.s1 = scene("s1", { fogEnabled: true, vision: { on: true, light: "dark" } });
    return state;
  }

  test("explore only adds, writes nothing it already holds, is not global, and is no one's undo step", () => {
    const state = visionScene();
    const first = explore(state, "s1", [{ tx: 0, ty: 0, bits: bitsOf({ x0: 0, y0: 0, x1: 2, y1: 2 }) }]);
    assert.equal(first.global, false);
    assert.equal(first.inverse?.length ?? 0, 1, "the reducer's inverse exists, but no stack records a sys op");
    const tile = first.state.exploredTiles[tileKey("s1", 0, 0)];
    assert.ok(cellSeen(tile, 1, 1) && !cellSeen(tile, 3, 3));
    // Bits it lacks are added to what it held, never taken away.
    const second = explore(first.state, "s1", [{ tx: 0, ty: 0, bits: bitsOf({ x0: 3, y0: 3, x1: 4, y1: 4 }) }], 11);
    const merged = second.state.exploredTiles[tileKey("s1", 0, 0)];
    assert.ok(cellSeen(merged, 1, 1) && cellSeen(merged, 3, 3));
    const again = explore(second.state, "s1", [{ tx: 0, ty: 0, bits: bitsOf({ x0: 0, y0: 0, x1: 1, y1: 1 }) }], 12);
    assert.deepEqual(again.touched, []);
    assert.equal(refused(state, { t: "sys.explore", sceneId: "s1", tiles: [{ tx: 3, ty: 0, bits: bitsOf({ x0: 0, y0: 0, x1: 1, y1: 1 }) }] }).message, "explored tile outside the scene");
  });

  test("a hide clears explored bits under it, outside its undo step, and its undo brings back the DM's fog only", () => {
    let state = visionScene();
    reveal(state, "s1", { x: 0, y: 0, w: 4, h: 4 });
    state = explore(state, "s1", [{ tx: 0, ty: 0, bits: bitsOf({ x0: 0, y0: 0, x1: 8, y1: 8 }) }]).state;
    const hide = run(state, { t: "fog.live", sceneId: "s1", ops: [{ id: "h", mode: "hide", shape: { kind: "rect", x: 0, y: 0, w: 6, h: 6 } }] }, 20);
    assert.equal(hide.global, true);
    const tile = hide.state.exploredTiles[tileKey("s1", 0, 0)];
    assert.ok(!cellSeen(tile, 2, 2) && cellSeen(tile, 7, 7));
    assert.ok(hide.inverse!.every((e) => !e.key.startsWith("explored:")), "the explored layer is not in the undo step");
    const back = undo(hide.state, hide);
    assert.ok(!cellSeen(back.state.exploredTiles[tileKey("s1", 0, 0)], 2, 2), "undoing the hide does not bring back what it cleared");
    assert.equal(back.state.fogTiles[tileKey("s1", 0, 0)]!.bits, state.fogTiles[tileKey("s1", 0, 0)]!.bits);
  });

  test("a hide over ground the DM's fog already hides only clears exploration, so its undo step is empty", () => {
    let state = visionScene();
    state = explore(state, "s1", [{ tx: 0, ty: 0, bits: bitsOf({ x0: 0, y0: 0, x1: 8, y1: 8 }) }]).state;
    const hide = run(state, { t: "fog.live", sceneId: "s1", ops: [{ id: "h", mode: "hide", shape: { kind: "all" } }] }, 20);
    assert.equal(hide.inverse, null);
    assert.equal(hide.global, true);
    assert.deepEqual(hide.state.exploredTiles, {});
  });

  test("a reveal leaves the layer, and a reset to hidden clears the scene's layer outside its undo step", () => {
    let state = visionScene();
    state.scenes.s2 = scene("s2", { order: 1, fogEnabled: true, vision: { on: true, light: "dim" } });
    state = explore(state, "s1", [{ tx: 0, ty: 0, bits: bitsOf({ x0: 0, y0: 0, x1: 8, y1: 8 }) }]).state;
    state = explore(state, "s2", [{ tx: 0, ty: 0, bits: bitsOf({ x0: 0, y0: 0, x1: 2, y1: 2 }) }], 11).state;
    const revealed = apply(state, { t: "fog.reset", sceneId: "s1", to: "revealed" });
    assert.equal(revealed.exploredTiles, state.exploredTiles);
    const hidden = run(revealed, { t: "fog.reset", sceneId: "s1", to: "hidden" }, 30);
    assert.deepEqual(Object.keys(hidden.state.exploredTiles), [tileKey("s2", 0, 0)]);
    assert.ok(hidden.inverse!.every((e) => !e.key.startsWith("explored:")));
    const back = undo(hidden.state, hidden);
    assert.deepEqual(Object.keys(back.state.exploredTiles), [tileKey("s2", 0, 0)]);
  });

  test("deleting a scene takes both layers, and undoing a scene's creation is not refused for its explored tiles", () => {
    let state = visionScene();
    state = explore(state, "s1", [{ tx: 0, ty: 0, bits: bitsOf({ x0: 0, y0: 0, x1: 1, y1: 1 }) }]).state;
    const deleted = apply(state, { t: "scene.delete", sceneId: "s1" });
    assert.deepEqual(deleted.exploredTiles, {});
    const made = run(room(), { t: "scene.create", scene: { id: "s3", name: "Cave", bounds: { w: 10, h: 10 }, vision: { on: true, light: "dark" } } });
    const explored = explore(made.state, "s3", [{ tx: 0, ty: 0, bits: bitsOf({ x0: 0, y0: 0, x1: 1, y1: 1 }) }]).state;
    const back = undo(explored, made);
    assert.equal(back.state.scenes.s3, undefined);
    assert.deepEqual(back.state.exploredTiles, {});
  });

  test("a duplicate with fog copies the layer as bookkeeping, and its undo takes it with the copy", () => {
    let state = visionScene();
    state = explore(state, "s1", [{ tx: 0, ty: 0, bits: bitsOf({ x0: 0, y0: 0, x1: 1, y1: 1 }) }]).state;
    const copied = run(state, { t: "scene.duplicate", sceneId: "s1", newSceneId: "copy", name: "Copy", include: { creatures: true, characters: true, fog: true, drawings: true } });
    const tile = copied.state.exploredTiles[tileKey("copy", 0, 0)]!;
    assert.equal(tile.sceneId, "copy");
    assert.ok(copied.inverse!.every((e) => !e.key.startsWith("explored:")));
    const plain = apply(state, { t: "scene.duplicate", sceneId: "s1", newSceneId: "copy", name: "Copy", include: { creatures: true, characters: true, fog: false, drawings: true } });
    assert.equal(plain.exploredTiles[tileKey("copy", 0, 0)], undefined);
    const explored = explore(copied.state, "copy", [{ tx: 0, ty: 0, bits: bitsOf({ x0: 2, y0: 2, x1: 3, y1: 3 }) }], 40).state;
    const back = undo(explored, copied);
    assert.equal(back.state.scenes.copy, undefined);
    assert.deepEqual(Object.keys(back.state.exploredTiles), [tileKey("s1", 0, 0)]);
  });

  test("the DM's fog undo is guarded by the DM's layer alone, so exploring between never breaks it", () => {
    // Two fog steps by one DM with exploration between and after, undone in order (section 6, Undo).
    let state = visionScene();
    const first = run(state, { t: "fog.live", sceneId: "s1", ops: [{ id: "a", mode: "reveal", shape: { kind: "rect", x: 0, y: 0, w: 1, h: 1 } }] }, 1);
    state = explore(first.state, "s1", [{ tx: 0, ty: 0, bits: bitsOf({ x0: 1, y0: 0, x1: 2, y1: 1 }) }], 2).state;
    const second = run(state, { t: "fog.live", sceneId: "s1", ops: [{ id: "b", mode: "reveal", shape: { kind: "rect", x: 2, y: 0, w: 1, h: 1 } }] }, 3);
    state = explore(second.state, "s1", [{ tx: 0, ty: 0, bits: bitsOf({ x0: 3, y0: 0, x1: 4, y1: 1 }) }], 4).state;
    for (const entry of second.inverse!) assert.ok(guardMatches(entry, state.fogTiles[tileKey("s1", 0, 0)] ?? null));
    state = undo(state, second, 5).state;
    state = undo(state, first, 6).state;
    assert.deepEqual(state.fogTiles, {});
    // What the party explored stays: the cell revealed by the first step and seen, too, would have been recorded by explore.
    const kept = state.exploredTiles[tileKey("s1", 0, 0)];
    assert.ok(cellSeen(kept, 1, 0) && cellSeen(kept, 3, 0));
  });

  test("undoing a reveal leaves players what the party explored, the revealed ground included, and a reset undoes at once", () => {
    // Bit 1 revealed by the DM, bit 2 explored, the party gone, the reveal undone: players keep bit 2.
    let state = visionScene();
    const shown = (s: RoomState, x: number) => cellSeen(projectState(s, P1, { sceneId: "s1" }).fogTiles[tileKey("s1", 0, 0)], x, 0);
    const reveal1 = run(state, { t: "fog.live", sceneId: "s1", ops: [{ id: "a", mode: "reveal", shape: { kind: "rect", x: 1, y: 0, w: 1, h: 1 } }] }, 1);
    state = explore(reveal1.state, "s1", [{ tx: 0, ty: 0, bits: bitsOf({ x0: 2, y0: 0, x1: 3, y1: 1 }) }], 2).state;
    state = undo(state, reveal1, 3).state;
    assert.ok(!shown(state, 1) && shown(state, 2));
    // A reveal the party then sees, leaving and undone, leaves players that ground.
    state = visionScene();
    const reveal2 = run(state, { t: "fog.live", sceneId: "s1", ops: [{ id: "b", mode: "reveal", shape: { kind: "rect", x: 4, y: 0, w: 1, h: 1 } }] }, 1);
    state = explore(reveal2.state, "s1", [{ tx: 0, ty: 0, bits: bitsOf({ x0: 4, y0: 0, x1: 5, y1: 1 }) }], 2).state;
    state = undo(state, reveal2, 3).state;
    assert.ok(shown(state, 4));
    // The DM's immediate undo of a reset to hidden applies.
    state = visionScene();
    state = run(state, { t: "fog.reset", sceneId: "s1", to: "revealed" }, 1).state;
    state = explore(state, "s1", [{ tx: 0, ty: 0, bits: bitsOf({ x0: 0, y0: 0, x1: 2, y1: 2 }) }], 2).state;
    const reset = run(state, { t: "fog.reset", sceneId: "s1", to: "hidden" }, 3);
    const back = undo(reset.state, reset, 4);
    assert.ok(shown(back.state, 8), "the DM's layer is back");
    assert.deepEqual(back.state.exploredTiles, {}, "what the reset cleared stays cleared");
  });

  test("one DM's hide-all under another's reveal undoes after the reveal's undo, and refuses while the reveal stands", () => {
    let state = visionScene();
    state = run(state, { t: "fog.reset", sceneId: "s1", to: "revealed" }, 1).state;
    state = explore(state, "s1", [{ tx: 0, ty: 0, bits: bitsOf({ x0: 0, y0: 0, x1: 3, y1: 3 }) }], 2).state;
    const hideAll = run(state, { t: "fog.live", sceneId: "s1", ops: [{ id: "h", mode: "hide", shape: { kind: "all" } }] }, 3);
    assert.ok(hideAll.inverse);
    const revealB = run(hideAll.state, { t: "fog.live", sceneId: "s1", ops: [{ id: "r", mode: "reveal", shape: { kind: "rect", x: 0, y: 0, w: 5, h: 5 } }] }, 4);
    state = explore(revealB.state, "s1", [{ tx: 0, ty: 0, bits: bitsOf({ x0: 0, y0: 0, x1: 1, y1: 1 }) }], 5).state;
    assert.equal(applyOp(state, { t: "sys.restore", entries: hideAll.inverse, from: "undo", deps: true }, DM, env(6)).ok, false, "A's undo refuses while B's reveal stands");
    state = undo(state, revealB, 7).state;
    const back = undo(state, hideAll, 8);
    assert.ok(cellSeen(back.state.fogTiles[tileKey("s1", 0, 0)], 10, 10), "A's undo brings the whole scene's fog back to revealed");
  });
});
