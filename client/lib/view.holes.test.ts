import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANA, ATTIC, GROUND, UPPER, putOpeningOp, run, tower, withStairs } from "#shared/floorLinksTestutil.ts";
import { MIN_HEIGHT_FT, type RoomState, type Scene } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { gridOfShape, SQUARES } from "#shared/rules/grid.ts";
import { reveal } from "#shared/testutil.ts";
import { BLIND_DROP_FT, floorHoles, holeFloors, holesKey, holesOfKey, type DrawnSource, type Hole } from "./view.ts";

/*
 * The holes Isometric draws as drops onto the floor below
 * (docs/design/design-v1-floors.md phase 4, 9.1), read from a device's own
 * copy: the DM's whole room, and a player's projection, so a player's drop
 * and the floor below's tone come only from what they were sent.
 */

const RECT = { x: 6, y: 6, w: 2, h: 2 };
const CELLS = ["6,6", "7,6", "6,7", "7,7"];

/** The tower with an opening from Upper floor down to Ground floor over RECT, Upper floor open to players, and each floor's ground there in feet. */
function holed(upperGround = 0, groundGround = 0, height = 10): RoomState {
  let s = tower();
  s = { ...s, scenes: { ...s.scenes, [UPPER]: { ...s.scenes[UPPER]!, floor: { ...s.scenes[UPPER]!.floor!, height } }, [GROUND]: { ...s.scenes[GROUND]!, background: "#123456" } } };
  if (upperGround !== 0) s = run(s, { t: "build.height", sceneId: UPPER, cells: CELLS, height: upperGround });
  if (groundGround !== 0) s = run(s, { t: "build.height", sceneId: GROUND, cells: CELLS, height: groundGround });
  s = run(s, putOpeningOp({ rect: RECT }));
  return { ...s, openFloors: { ...s.openFloors, [UPPER]: { sceneId: UPPER, rev: 0 } } };
}

const anaCopy = (s: RoomState, sceneId = UPPER) => projectState(s, ANA, { sceneId }) as unknown as RoomState;

describe("a floor's holes from the device's copy (9.1)", () => {
  test("the DM's: the floor's height plus the hole's ground less the far end's, and the floor below's background", () => {
    assert.deepEqual(floorHoles(holed(), UPPER), [{ id: "o1", rect: RECT, drop: 10, below: "#123456" }]);
    assert.equal(floorHoles(holed(5, -5), UPPER)[0]!.drop, 20, "10 ft, 5 ft up there, 5 ft down below");
    assert.equal(floorHoles(holed(0, 0, 15), UPPER)[0]!.drop, 15, "the upper floor's own height");
    assert.equal(floorHoles(holed(-5, 15), UPPER)[0]!.drop, 0, "never below 0");
  });

  test("a player's: the same drop from the end's rise and their own build, while they hold the floor below and its end", () => {
    for (const [up, down, height] of [
      [0, 0, 10],
      [5, -5, 10],
      [0, 0, 15],
    ] as const) {
      const s = holed(up, down, height);
      assert.deepEqual(floorHoles(anaCopy(s), UPPER), floorHoles(s, UPPER), `${up} ${down} ${height}`);
    }
  });

  test("each hole reads its own far end, the one over its squares, among others on the floor below", () => {
    let s = holed(0, -5);
    // A second opening from Upper floor down to Ground floor, over squares 5 ft up below, with an id that sorts first.
    s = run(s, { t: "build.height", sceneId: GROUND, cells: ["12,12", "13,12", "12,13", "13,13"], height: 5 });
    s = run(s, putOpeningOp({ id: "a1", pairId: "a2", rect: { x: 12, y: 12, w: 2, h: 2 } }));
    const drops = Object.fromEntries(floorHoles(s, UPPER).map((h) => [h.id, h.drop]));
    assert.deepEqual(drops, { a1: 5, o1: 15 });
    assert.deepEqual(Object.fromEntries(floorHoles(anaCopy(s), UPPER).map((h) => [h.id, h.drop])), drops, "and a player's, which names no pair");
  });

  test("only an opening's upper end is a hole: not its lower end, nor stairs", () => {
    assert.deepEqual(floorHoles(holed(), GROUND), []);
    assert.deepEqual(floorHoles(withStairs(tower()), GROUND), []);
    assert.deepEqual(floorHoles(withStairs(tower()), UPPER), []);
  });

  test("a player who does not hold the floor below: a black bottom 10 ft down, whatever lies there", () => {
    // Attic's hole leads to Upper floor, which Ana has not reached.
    const at = (upper: number) => {
      let s = tower();
      s = run(s, { t: "build.height", sceneId: ATTIC, cells: CELLS, height: 5 });
      if (upper !== 0) s = run(s, { t: "build.height", sceneId: UPPER, cells: CELLS, height: upper });
      s = run(s, putOpeningOp({ sceneId: ATTIC, to: UPPER, rect: RECT }));
      return { ...s, openFloors: { ...s.openFloors, [ATTIC]: { sceneId: ATTIC, rev: 0 } } };
    };
    const holes = floorHoles(anaCopy(at(0), ATTIC), ATTIC);
    assert.deepEqual(holes, [{ id: "o1", rect: RECT, drop: BLIND_DROP_FT, below: null }]);
    assert.deepEqual(floorHoles(anaCopy(at(-20), ATTIC), ATTIC), holes, "the ground below changes nothing");
    assert.equal(floorHoles(at(0), ATTIC)[0]!.drop, 15, "the DM's is real");
  });

  test("a player who holds the floor below but not its end there: 10 ft, onto the floor below's tone", () => {
    const s = holed(0, -20);
    const fogged = { ...s, scenes: { ...s.scenes, [GROUND]: { ...s.scenes[GROUND]!, fogEnabled: true } } };
    const ana = anaCopy(fogged);
    assert.equal(Object.values(ana.floorLinks ?? {}).some((l) => l?.sceneId === GROUND), false, "the far end is under full fog");
    assert.deepEqual(floorHoles(ana, UPPER), [{ id: "o1", rect: RECT, drop: BLIND_DROP_FT, below: "#123456" }]);
    // A new fog record, as the store makes one: the projection keeps what it read of the old one.
    const shown = { ...fogged, fogTiles: { ...fogged.fogTiles } };
    reveal(shown, GROUND, RECT);
    assert.equal(floorHoles(anaCopy(shown), UPPER)[0]!.drop, 30, "the end revealed, its ground reads");
  });

  test("squares not of one height there: 10 ft", () => {
    const s = run(holed(), { t: "build.height", sceneId: GROUND, cells: ["6,6"], height: 5 });
    assert.equal(floorHoles(s, UPPER)[0]!.drop, BLIND_DROP_FT);
  });

  test("the key is one string while nothing changes, empty for no hole, and names the holes back", () => {
    const s = holed();
    const key = holesKey(s, UPPER);
    assert.equal(holesKey({ ...s }, UPPER), key, "a new copy with the same collections");
    assert.deepEqual(holesOfKey(key), floorHoles(s, UPPER));
    assert.equal(holesKey(s, GROUND), "");
    assert.deepEqual(holesOfKey(""), []);
    const deeper = { ...s, scenes: { ...s.scenes, [UPPER]: { ...s.scenes[UPPER]!, floor: { ...s.scenes[UPPER]!.floor!, height: 20 } } } };
    assert.notEqual(holesKey(deeper, UPPER), key, "a floor's height is in it");
    const below = { ...s, scenes: { ...s.scenes, [GROUND]: { ...s.scenes[GROUND]!, background: "#654321" } } };
    assert.notEqual(holesKey(below, UPPER), holesKey(deeper, UPPER), "and the floor below's background");
  });
});

/** A drawn source over a 20 by 20 floor of squares. */
function source(over: Partial<DrawnSource> = {}): DrawnSource {
  return { chunks: {}, sceneId: UPPER, bounds: { w: 20, h: 20 }, grid: SQUARES, fog: null, stand: true, ...over };
}

const hole = (over: Partial<Hole> = {}): Hole => ({ id: "o1", rect: RECT, drop: 10, below: "#123456", ...over });

describe("each cell's bottom (9.1)", () => {
  test("drop feet below its seen ground, in cells of height, only inside the hole", () => {
    const s = run(tower(), { t: "build.height", sceneId: UPPER, cells: ["6,6"], height: 5 });
    const floors = holeFloors(source({ chunks: s.buildChunks }), [hole()], 5);
    assert.equal(floors.at(6, 6)?.z, -1, "5 ft up, 10 ft down: 5 ft below 0");
    assert.equal(floors.at(7, 7)?.z, -2);
    assert.equal(floors.at(6, 6)?.hole.id, "o1");
    assert.equal(floors.at(5, 6), undefined);
    assert.equal(floors.at(8, 7), undefined);
  });

  test("never below the lowest ground", () => {
    assert.equal(holeFloors(source(), [hole({ drop: 300 })], 5).at(6, 6)?.z, MIN_HEIGHT_FT / 5);
  });

  test("nothing while heights lie flat, on a cell under the fog, or with no hole", () => {
    assert.equal(holeFloors(source({ stand: false }), [hole()], 5).at(6, 6), undefined);
    const s = { ...tower(), scenes: { ...tower().scenes, [UPPER]: { ...tower().scenes[UPPER]!, fogEnabled: true } as Scene } };
    reveal(s, UPPER, { x: 6, y: 6, w: 1, h: 2 });
    const fogged = holeFloors(source({ fog: s.fogTiles }), [hole()], 5);
    assert.equal(fogged.at(6, 7)?.z, -2, "a revealed cell");
    assert.equal(fogged.at(7, 7), undefined, "a fogged one draws nothing of the hole");
    assert.equal(holeFloors(source(), [], 5).at(6, 6), undefined);
  });

  test("on hexes, by the hexes' keys inside the scene", () => {
    const grid = gridOfShape("hexRows");
    const floors = holeFloors(source({ grid, bounds: { w: 8, h: 8 } }), [hole({ rect: { x: 6, y: 6, w: 3, h: 2 } })], 5);
    assert.equal(floors.at(6, 6)?.z, -2);
    assert.equal(floors.at(8, 7), undefined, "a key past the scene's hexes");
  });
});
