import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ATTIC, GROUND, UPPER, putOp, run, tower as towerOf3, withStairs } from "../floorLinksTestutil.ts";
import type { FloorLink, RoomState, Scene } from "../model.ts";
import type { Op } from "../protocol.ts";
import { room, scene } from "../testutil.ts";
import { FLOOR_WORDS, floorProblem } from "./floors.ts";
// floorProblem asks the rules of stairs through the hook this file sets as it loads (floors.ts floorLinkRules).
import "./floorLinks.ts";

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

/*
 * The stairs' half (docs/design/design-v1-floors.md phase 2, 3): an end and
 * its pair whole, on floors next to each other, of their floors' shape,
 * inside both, apart from every other end, at most 16 pairs, and on its
 * floor no wall, no pit and the ground it keeps. Each edit a DM makes after
 * placing stairs reads 7.3's words. The ops that would break one are
 * refused in the actor, which runs this after every op.
 */
describe("floorProblem's stairs", () => {
  const stairs = () => withStairs(towerOf3());
  const edit = (s: RoomState, op: Op) => run(s, op);
  const ends = (s: RoomState, patch: Partial<FloorLink>, which: "l1" | "both" = "both"): RoomState => {
    const links = { ...s.floorLinks! };
    for (const id of which === "both" ? ["l1", "l2"] : [which]) links[id] = { ...links[id]!, ...patch };
    return { ...s, floorLinks: links };
  };

  test("stairs as placed pass, from either floor and from the floor above them", () => {
    const s = stairs();
    for (const id of [GROUND, UPPER, ATTIC]) assert.equal(floorProblem(s, id), null, id);
  });

  test("a height, paint or erase that changes the ground under an end", () => {
    const want = "That would change the ground under the stairs to Upper floor. Remove them first.";
    assert.equal(floorProblem(edit(stairs(), { t: "build.height", sceneId: GROUND, cells: ["4,3"], height: 5 }), GROUND), want);
    assert.equal(floorProblem(edit(stairs(), { t: "build.height", sceneId: UPPER, cells: ["3,3"], height: 5 }), UPPER), "That would change the ground under the stairs to Ground floor. Remove them first.");
    // Beside the squares nothing changes under them.
    assert.equal(floorProblem(edit(stairs(), { t: "build.height", sceneId: GROUND, cells: ["5,3"], height: 5 }), GROUND), null);
  });

  test("a wall through them, a floor shrunk past them, a pit set under them", () => {
    const want = "That would block the stairs to Upper floor. Remove them first.";
    assert.equal(floorProblem(edit(stairs(), { t: "build.edge", sceneId: GROUND, edges: [{ key: "4,3,w", feature: { kind: "wall" } }] }), GROUND), want);
    const s = stairs();
    const shrunk = { ...s, scenes: { ...s.scenes, [GROUND]: { ...s.scenes[GROUND]!, bounds: { w: 4, h: 20 } } } };
    assert.equal(floorProblem(shrunk, GROUND), want);
    const rig = { on: ["enter" as const], who: "any" as const, floor: true, resets: "never" as const, stops: true, foundOnSpring: true, pit: { floor: -10 }, hits: "trigger" as const, actions: [], find: [], notice: false };
    const pit = { ...s, traps: { p: { id: "p", rev: 1, sceneId: GROUND, name: "Pit", zone: { cells: [{ x: 4, y: 3, w: 1, h: 1 }] }, state: "armed" as const, found: false, rig } } };
    assert.equal(floorProblem(pit, GROUND), want);
  });

  test("an add or a reorder that puts a floor between linked floors", () => {
    const want = "Stairs join Ground floor and Upper floor. Remove them before putting a floor between.";
    const added = edit(stairs(), { t: "scene.create", scene: { id: "mid", name: "Tower", bounds: { w: 20, h: 20 } }, floor: { beside: GROUND, side: "above" } });
    assert.equal(floorProblem(added, GROUND), want);
    const reordered = edit(stairs(), { t: "floor.order", sceneId: GROUND, floors: [UPPER, ATTIC, GROUND] });
    assert.equal(floorProblem(reordered, GROUND), "Stairs join Upper floor and Ground floor. Remove them before putting a floor between.");
    // A swap keeps them next to each other.
    assert.equal(floorProblem(edit(stairs(), { t: "floor.order", sceneId: GROUND, floors: [UPPER, GROUND, ATTIC] }), GROUND), null);
  });

  test("another end over them, as an undone delete under stairs placed since would leave", () => {
    const s = stairs();
    const over = { ...s, floorLinks: { ...s.floorLinks!, l3: { ...s.floorLinks!.l1!, id: "l3", pair: "l4", rect: { x: 4, y: 3, w: 1, h: 1 } }, l4: { ...s.floorLinks!.l2!, id: "l4", pair: "l3", rect: { x: 4, y: 3, w: 1, h: 1 } } } };
    assert.equal(floorProblem(over, GROUND), "That would block the stairs to Upper floor. Remove them first.");
  });

  test("a pair that is not whole, ends that differ, a grid not their floors', and ends on a floor that is gone", () => {
    const broken = "Tower's stairs and ladders don't fit its floors any more.";
    const s = stairs();
    const { l2: _l2, ...lone } = s.floorLinks!;
    assert.equal(floorProblem({ ...s, floorLinks: lone }, GROUND), broken);
    for (const patch of [{ rev: 3 }, { kind: "ladder" as const }, { locked: true as const }, { made: 7 }, { rect: { x: 3, y: 3, w: 1, h: 1 } }]) assert.equal(floorProblem(ends(s, patch, "l1"), GROUND), broken, JSON.stringify(patch));
    assert.equal(floorProblem(ends(s, { grid: "hexRows" }), GROUND), broken);
    const { [UPPER]: _upper, ...noUpper } = s.scenes;
    assert.match(floorProblem({ ...s, scenes: noUpper }, GROUND)!, /don't fit/);
  });

  test("a 17th pair", () => {
    let s = towerOf3();
    for (let i = 0; i < 16; i++) s = run(s, putOp({ id: `a${i}`, pairId: `b${i}`, rect: { x: i, y: 10, w: 1, h: 1 } }));
    assert.equal(floorProblem(s, GROUND), null);
    const links = { ...s.floorLinks! };
    links.a16 = { ...links.a0!, id: "a16", pair: "b16", rect: { x: 0, y: 12, w: 1, h: 1 } };
    links.b16 = { ...links.b0!, id: "b16", pair: "a16", rect: { x: 0, y: 12, w: 1, h: 1 } };
    assert.equal(floorProblem({ ...s, floorLinks: links }, GROUND), "Tower has 16 stairs and ladders, the most a scene can hold.");
  });
});
