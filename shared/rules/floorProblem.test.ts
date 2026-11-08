import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Scene } from "../model.ts";
import { room, scene } from "../testutil.ts";
import { FLOOR_WORDS, floorProblem } from "./floors.ts";

/*
 * floorProblem (docs/design/design-v1-floors.md 9, D-261107-221): the floor
 * invariants the actor checks beside the limits, after every op, undo, redo
 * and restore, and the import checks, in the DM's words.
 */

const floor = (id: string, level: number, name: string, over: Partial<Scene> = {}): Scene =>
  scene(id, { name: "Tower", floor: { of: "g", level, name, height: 10 }, ...over });
const tower = (scenes: Scene[], over: Partial<RoomState> = {}): RoomState =>
  room({ scenes: { s2: scene("s2", { order: 1 }), ...Object.fromEntries(scenes.map((s) => [s.id, s])) }, ...over });
const good = () => [floor("g", 0, "Ground floor"), floor("u", 1, "Upper floor")];

describe("floorProblem", () => {
  test("a sound tower and a plain scene pass, from any floor", () => {
    const state = tower(good());
    assert.equal(floorProblem(state, "g"), null);
    assert.equal(floorProblem(state, "u"), null);
    assert.equal(floorProblem(state, "s2"), null);
    assert.equal(floorProblem(state, "gone"), null);
  });

  test("a ninth floor", () => {
    const nine = Array.from({ length: 9 }, (_, i) => floor(i === 0 ? "g" : `f${i}`, i, `Floor ${i}`));
    assert.equal(floorProblem(tower(nine), "g"), FLOOR_WORDS.tooMany("Tower"));
  });

  test("a hex floor among square ones, as an undo of a grid change would leave it", () => {
    assert.equal(floorProblem(tower([floor("g", 0, "Ground floor"), floor("u", 1, "Upper floor", { gridShape: "hexRows" })]), "u"), "Floors share one grid shape, so it can't change while Tower has more than one floor.");
  });

  test("a name two floors share", () => {
    assert.equal(floorProblem(tower([floor("g", 0, "Hall"), floor("u", 1, "Hall")]), "g"), "Tower already has a floor named Hall.");
  });

  test("levels that skip or repeat, a main floor that is not its own, a lone floor, floors of a scene that is gone", () => {
    const broken = FLOOR_WORDS.broken("Tower");
    assert.equal(floorProblem(tower([floor("g", 0, "Ground floor"), floor("u", 2, "Upper floor")]), "g"), broken);
    assert.equal(floorProblem(tower([floor("g", 0, "Ground floor"), floor("u", 0, "Upper floor")]), "g"), broken);
    assert.equal(floorProblem(tower([floor("g", 0, "Ground floor", { floor: { of: "u", level: 0, name: "Ground floor" } }), floor("u", 1, "Upper floor")]), "g"), broken);
    assert.equal(floorProblem(tower([floor("g", 0, "Ground floor")]), "g"), broken);
    assert.equal(floorProblem(tower([floor("u", 1, "Upper floor"), floor("a", 0, "Attic")]), "g"), broken, "the main floor is gone");
    assert.equal(floorProblem(tower([floor("g", 0, "Ground floor"), floor("u", 1, "Upper floor", { name: "Spire" })]), "u"), broken, "every floor carries the scene's name");
  });

  test("an opened mark on a scene without floors, or on one that is gone", () => {
    assert.equal(floorProblem(tower(good(), { openFloors: { s2: { sceneId: "s2", rev: 0 } } }), "s2"), FLOOR_WORDS.broken("s2"));
    assert.equal(floorProblem(tower(good(), { openFloors: { gone: { sceneId: "gone", rev: 0 } } }), "gone"), FLOOR_WORDS.broken("This scene"));
    assert.equal(floorProblem(tower(good(), { openFloors: { u: { sceneId: "u", rev: 0 } } }), "u"), null);
  });
});
