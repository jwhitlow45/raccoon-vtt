import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { EdgeFeature, FogTile, FreeWall } from "#shared/model.ts";
import { encodeTile, fullTileBits } from "#shared/rules/fog.ts";
import { encodeTileFrom } from "../../lib/fogTiles.ts";
import { planOne, stopText } from "../movement/drop.ts";
import { CLOSED, line, OPEN, thorn, world } from "../movement/testing.ts";
import { doorActions, doorName, doorsInReach, doorsNear, doorUnder, findDoor, noteDoor, seenDoor, segmentDistance } from "./doors.ts";

const FREE_DOOR: FreeWall = { id: "abcdefghijkl", a: [12, 2], b: [13, 3], f: { kind: "door", state: "closed", secret: false, discovered: false } };

/** A wall along x = 6 with closed doors at (6, 5) and (6, 6), and a free door on a slant. */
function hall(extra: Record<string, EdgeFeature> = {}) {
  return world({ edges: { ...line("w", 6, 0, 12), "6,5,w": CLOSED, "6,6,w": CLOSED, ...extra }, walls: [FREE_DOOR] });
}

describe("finding doors", () => {
  test("edge doors and free doors near a box", () => {
    const doors = doorsNear(hall().buildChunks, "s1", { x0: 0, y0: 0, x1: 20, y1: 20 });
    assert.deepEqual(doors.map((d) => d.ref), [{ edge: "6,5,w" }, { edge: "6,6,w" }, { cx: 0, cy: 0, id: "abcdefghijkl" }]);
    assert.deepEqual(doors[0]!.mid, { x: 6, y: 5.5 });
    assert.deepEqual(doors[2]!.mid, { x: 12.5, y: 2.5 });
  });

  test("a tap reaches the nearest door within its slop, and nothing farther", () => {
    const chunks = hall().buildChunks;
    const under = (x: number, y: number) => doorUnder({ chunks, sceneId: "s1", at: { x, y }, slop: 0.3, fog: null })?.ref ?? null;
    assert.deepEqual(under(6.05, 5.5), { edge: "6,5,w" });
    assert.deepEqual(under(6.1, 5.95), { edge: "6,5,w" });
    assert.deepEqual(under(5.9, 6.2), { edge: "6,6,w" });
    assert.deepEqual(under(12.6, 2.45), { cx: 0, cy: 0, id: "abcdefghijkl" });
    assert.equal(under(6.5, 5.5), null);
    assert.equal(under(6.05, 2.5), null);
  });

  test("a player reaches only a door with ground out of the fog beside it", () => {
    const chunks = hall().buildChunks;
    const fogged: Record<string, FogTile> = {};
    const revealed: Record<string, FogTile> = { "s1:0,0": { sceneId: "s1", tx: 0, ty: 0, rev: 1, bits: encodeTile(fullTileBits()) } };
    assert.equal(doorUnder({ chunks, sceneId: "s1", at: { x: 6, y: 5.5 }, slop: 0.3, fog: fogged }), null);
    assert.deepEqual(doorUnder({ chunks, sceneId: "s1", at: { x: 6, y: 5.5 }, slop: 0.3, fog: revealed })?.ref, { edge: "6,5,w" });
  });

  test("a door found by how ops name it, and nothing where the view holds none", () => {
    const chunks = hall().buildChunks;
    assert.deepEqual(findDoor(chunks, "s1", { edge: "6,6,w" })?.mid, { x: 6, y: 6.5 });
    assert.deepEqual(findDoor(chunks, "s1", { cx: 0, cy: 0, id: "abcdefghijkl" })?.a, { x: 12, y: 2 });
    assert.equal(findDoor(chunks, "s1", { edge: "6,7,w" }), null);
    assert.equal(findDoor(chunks, "s1", { cx: 0, cy: 0, id: "zzzzzzzzzzzz" }), null);
    assert.equal(findDoor(chunks, "s1", { edge: "40,40,w" }), null);
  });

  test("an open pill keeps its door only while the player can see it", () => {
    const chunks = hall().buildChunks;
    const revealed: Record<string, FogTile> = { "s1:0,0": { sceneId: "s1", tx: 0, ty: 0, rev: 1, bits: encodeTile(fullTileBits()) } };
    assert.deepEqual(seenDoor(chunks, "s1", { edge: "6,5,w" }, null)?.mid, { x: 6, y: 5.5 });
    assert.deepEqual(seenDoor(chunks, "s1", { edge: "6,5,w" }, revealed)?.mid, { x: 6, y: 5.5 });
    // The DM's fog covered the ground on both sides again.
    assert.equal(seenDoor(chunks, "s1", { edge: "6,5,w" }, {}), null);
    assert.equal(seenDoor(chunks, "s1", { edge: "6,7,w" }, null), null);
  });

  test("the distance to a door's line", () => {
    assert.equal(segmentDistance({ x: 0, y: 1 }, { x: 0, y: 0 }, { x: 2, y: 0 }), 1);
    assert.equal(segmentDistance({ x: 3, y: 0 }, { x: 0, y: 0 }, { x: 2, y: 0 }), 1);
  });
});

describe("a door's pill", () => {
  test("a player gets Open or Close, a locked door reading as the closed door they see", () => {
    assert.deepEqual(doorActions("s1", { ref: { edge: "6,5,w" }, door: CLOSED }, "player"), [{ label: "Open", op: { t: "door.set", sceneId: "s1", door: { edge: "6,5,w" }, state: "open" } }]);
    assert.deepEqual(doorActions("s1", { ref: { edge: "6,5,w" }, door: OPEN }, "player").map((a) => a.label), ["Close"]);
    assert.equal(doorName({ door: { kind: "door", state: "locked", secret: false, discovered: false } }, "player"), "Closed door");
  });

  test("the DM also locks and unlocks, and marks a secret door found or hides it", () => {
    const hidden = { kind: "door" as const, state: "locked" as const, secret: true, discovered: false };
    const actions = doorActions("s1", { ref: { edge: "6,5,w" }, door: hidden }, "dm");
    assert.deepEqual(actions.map((a) => [a.label, a.op.state, a.op.found]), [
      ["Open", "open", undefined],
      ["Unlock", "closed", undefined],
      ["Mark found", "locked", true],
    ]);
    const found = { ...hidden, state: "open" as const, discovered: true };
    assert.deepEqual(doorActions("s1", { ref: { edge: "6,5,w" }, door: found }, "dm").map((a) => [a.label, a.op.state, a.op.found]), [
      ["Close", "closed", undefined],
      ["Lock", "locked", undefined],
      ["Hide", "open", false],
    ]);
    assert.equal(doorName({ door: hidden }, "dm"), "Locked secret door, hidden");
    assert.equal(doorName({ door: found }, "dm"), "Open secret door, found");
  });
});

describe("the doors a token reaches (decided 2026-10-14)", () => {
  test("from a cell beside the door, nearest first", () => {
    const state = hall();
    assert.deepEqual(doorsInReach(state, thorn({ x: 5, y: 5 }), null).map((d) => d.ref), [{ edge: "6,5,w" }, { edge: "6,6,w" }]);
    assert.deepEqual(doorsInReach(state, thorn({ x: 7, y: 6 }), null).map((d) => d.ref), [{ edge: "6,6,w" }, { edge: "6,5,w" }]);
  });

  test("not from two cells away, nor flying 30 ft above it", () => {
    const state = hall();
    assert.deepEqual(doorsInReach(state, thorn({ x: 3, y: 5 }), null), []);
    assert.deepEqual(doorsInReach(state, thorn({ x: 5, y: 5, elevation: 30 }), null), []);
  });

  test("not through a wall between the token and the door", () => {
    // Diagonally beside the door at (6, 5), with a wall across the line from the token to it.
    assert.deepEqual(doorsInReach(hall(), thorn({ x: 5, y: 4 }), null).map((d) => d.ref), [{ edge: "6,5,w" }]);
    assert.deepEqual(doorsInReach(hall({ "5,5,n": { kind: "wall" } }), thorn({ x: 5, y: 4 }), null), []);
  });

  test("only a door the player can see, with ground beside it out of the fog", () => {
    // A token that lends no sight can stand on ground the party never saw: the door there stays hidden from the bar too.
    const fogged: Record<string, FogTile> = {};
    const revealed: Record<string, FogTile> = { "s1:0,0": { sceneId: "s1", tx: 0, ty: 0, rev: 1, bits: encodeTile(fullTileBits()) } };
    assert.deepEqual(doorsInReach(hall(), thorn({ x: 5, y: 5 }), fogged), []);
    assert.deepEqual(doorsInReach(hall(), thorn({ x: 5, y: 5 }), revealed).map((d) => d.ref), [{ edge: "6,5,w" }, { edge: "6,6,w" }]);
    // One side of the door out of the fog is enough, as for a tap.
    const west: Record<string, FogTile> = { "s1:0,0": { sceneId: "s1", tx: 0, ty: 0, rev: 1, bits: encodeTileFrom((sx) => sx < 6 * 4) } };
    assert.deepEqual(doorsInReach(hall(), thorn({ x: 5, y: 5 }), west).map((d) => d.ref), [{ edge: "6,5,w" }, { edge: "6,6,w" }]);
  });

  test("a free door from the cells on either side of its middle", () => {
    assert.deepEqual(doorsInReach(hall(), thorn({ x: 12, y: 3 }), null).map((d) => d.ref), [{ cx: 0, cy: 0, id: "abcdefghijkl" }]);
  });
});

describe("the note after a walk stopped at a door", () => {
  test("names only a door the player can see, so it never asks for a tap on a door under the fog", () => {
    const state = hall();
    const stop = planOne(state, thorn({ x: 3, y: 5 }), { x: 9, y: 5 }, "walk").stop!;
    assert.deepEqual(stop.door, { edge: "6,5,w" });
    const text = (fog: Record<string, FogTile> | null) => stopText({ blocker: stop.blocker, door: noteDoor(state.buildChunks, "s1", stop.door, fog) });
    assert.equal(text(null), "A door is in the way. Tap it to open.");
    assert.equal(text({ "s1:0,0": { sceneId: "s1", tx: 0, ty: 0, rev: 1, bits: encodeTile(fullTileBits()) } }), "A door is in the way. Tap it to open.");
    // Ground west of x = 6 out of the fog: one side of the door is enough, as for a tap.
    assert.equal(text({ "s1:0,0": { sceneId: "s1", tx: 0, ty: 0, rev: 1, bits: encodeTileFrom((sx) => sx < 6 * 4) } }), "A door is in the way. Tap it to open.");
    assert.equal(text({}), "Stopped at a wall. Drop at the corner first, then go on.");
    assert.equal(noteDoor(state.buildChunks, "s1", null, null), null);
  });
});
