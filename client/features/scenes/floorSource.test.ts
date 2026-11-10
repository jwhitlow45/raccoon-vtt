import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GROUND, UPPER, tower, withStairs } from "#shared/floorLinksTestutil.ts";
import { LIMITS } from "#shared/limits.ts";
import type { RoomState } from "#shared/model.ts";
import { clientOpSchema } from "#shared/protocol.ts";
import { FLOOR_WORDS } from "#shared/rules/floors.ts";
import { LINK_WORDS } from "#shared/rules/floorLinks.ts";
import { applyOp } from "#shared/reducer.ts";
import { DM, env, scene } from "#shared/testutil.ts";
import { builderScene, nameFromFile, playersSeeFields, withPlayersSee, type SceneInput } from "./create.ts";
import { SCENES_FULL, floorAddRefusal, floorCreateOf, floorNameOf } from "./floorSource.ts";

/*
 * A floor from a file or a dungeon (docs/design/design-v1-floors.md phase
 * 3, 3.6 and 3.7): its name, the one op that makes it, which sends the
 * light as intent and not as a difference, and the refusals the dialogs
 * ask before and after an upload.
 */

const MAP = { assetId: "a1", widthPx: 2800, heightPx: 2100, cellPx: 70, originPx: { x: 0, y: 0 } };
const TARGET = { beside: GROUND, side: "above" as const };
/** A scene as the Universal VTT import builds it before Players see (uvtt/batch.ts importScene). */
const fileScene = (over: Partial<SceneInput> = {}): SceneInput => ({
  id: "crypt",
  name: "Crypt level 2",
  bounds: { w: 40, h: 30 },
  background: "#1b1b20",
  grid: { show: true, color: "#ffffff", opacity: 0.25, lineWidth: 1 },
  fogEnabled: true,
  map: MAP,
  autoWalls: "off",
  gridFromFile: true,
  blockMovement: true,
  ...over,
});
const cp = (text: string) => Array.from(text).length;

describe("a floor's name from its file (3.6)", () => {
  test("a long file name is cut to 40 code points and trimmed", () => {
    const fromFile = nameFromFile("The_Sunken_Temple_of_the_Serpent_Lord_Level_2");
    assert.ok(cp(fromFile) > LIMITS.floorNameChars);
    assert.equal(floorNameOf(fromFile), "The Sunken Temple of the Serpent Lord Le");
    assert.equal(floorNameOf(`${"x".repeat(39)} yz`), "x".repeat(39), "a cut that ends on a space is trimmed");
  });

  test("an emoji at the cut stays whole, and an empty edit sends no name", () => {
    const dragon = `${"x".repeat(39)}\u{1F409}abc`;
    assert.equal(floorNameOf(dragon), `${"x".repeat(39)}\u{1F409}`);
    assert.equal(floorNameOf(`${"x".repeat(40)}\u{1F409}`), "x".repeat(40), "a dragon past the cut goes whole");
    const op = floorCreateOf(fileScene(), TARGET, "   ", "like");
    assert.equal(op.floor?.name, undefined);
    assert.ok(!("name" in op.floor!));
    assert.equal(floorCreateOf(fileScene(), TARGET, dragon, "like").floor?.name, `${"x".repeat(39)}\u{1F409}`);
    assert.ok(clientOpSchema.safeParse(floorCreateOf(fileScene(), TARGET, dragon, "like")).success);
  });
});

describe("the op that makes the floor (3.1, 3.6, 3.7)", () => {
  test("own takes the file's size, background, grid look, automatic walls, map and mark, and the scene only its id, name and size", () => {
    const op = floorCreateOf(fileScene(), TARGET, "Crypt level 2", "like");
    assert.deepEqual(op, {
      t: "scene.create",
      scene: { id: "crypt", name: "Crypt level 2", bounds: { w: 40, h: 30 } },
      floor: {
        beside: GROUND,
        side: "above",
        name: "Crypt level 2",
        own: { bounds: { w: 40, h: 30 }, background: "#1b1b20", grid: { show: true, color: "#ffffff", opacity: 0.25, lineWidth: 1 }, autoWalls: "off", map: MAP, gridFromFile: true },
      },
    });
    assert.ok(clientOpSchema.safeParse(op).success);
  });

  test("Like with its light untouched sends no fog or vision, so the add copies the floor beside, Per player and Time of day included", () => {
    const like = { fogEnabled: true, vision: { on: true, light: "dim" as const, perPlayer: true as const, byClock: true as const } };
    const op = floorCreateOf(withPlayersSee(fileScene(), { like }), TARGET, "Crypt", "like");
    assert.equal(op.floor?.own?.fogEnabled, undefined);
    assert.equal(op.floor?.own?.vision, undefined);
    const state = tower({ scenes: { ...tower().scenes, [GROUND]: { ...tower().scenes[GROUND]!, ...like } } });
    const made = applyOp(state, op, DM, env(1));
    assert.ok(made.ok);
    assert.deepEqual(made.state.scenes.crypt!.vision, like.vision);
  });

  test("any other pick is sent whole with byClock false, even one equal to the floor beside", () => {
    const explore = floorCreateOf(withPlayersSee(fileScene(), { preset: "explore" }), TARGET, "Crypt", "own");
    assert.equal(explore.floor?.own?.fogEnabled, true);
    assert.deepEqual(explore.floor?.own?.vision, { on: true, light: "bright", byClock: false });
    const lit = floorCreateOf(withPlayersSee(fileScene(), { preset: "explore" }, "dark"), TARGET, "Crypt", "own");
    assert.deepEqual(lit.floor?.own?.vision, { on: true, light: "dark", byClock: false });
    const likeLight = floorCreateOf(withPlayersSee(fileScene(), { like: { fogEnabled: true, vision: { on: true, light: "bright", perPlayer: true, byClock: true } } }, "dim"), TARGET, "Crypt", "own");
    assert.deepEqual(likeLight.floor?.own?.vision, { on: true, light: "dim", perPlayer: true, byClock: false }, "a light picked in the Like row is sent, Per player with it");
  });

  test("Keep it lit with the default New scenes sends vision off with the light of a new scene, fog on, and no Time of day", () => {
    const fields = playersSeeFields({ preset: "reveal" });
    assert.equal(fields.vision, undefined, "Reveal by hand names no vision");
    const op = floorCreateOf(withPlayersSee(builderScene({ id: "d", name: "Crypt", w: 30, h: 30 }), { preset: "reveal" }), TARGET, "Crypt", "own");
    assert.deepEqual(op.floor?.own?.vision, { on: false, light: "bright", byClock: false });
    assert.equal(op.floor?.own?.fogEnabled, true);
    const everything = floorCreateOf(withPlayersSee(builderScene({ id: "d", name: "Crypt", w: 30, h: 30 }), { preset: "all" }), TARGET, "Crypt", "own");
    assert.deepEqual([everything.floor?.own?.fogEnabled, everything.floor?.own?.vision], [false, { on: false, light: "bright", byClock: false }]);
  });

  test("a dungeon floor states its automatic walls, so a floor beside with them off never takes its walls away", () => {
    const op = floorCreateOf(builderScene({ id: "d", name: "Crypt", w: 30, h: 30 }), TARGET, "Crypt", "own");
    assert.equal(op.floor?.own?.autoWalls, "all");
    assert.deepEqual(op.floor?.own?.bounds, { w: 30, h: 30 });
    assert.equal(op.floor?.own?.background, "#141418");
    assert.equal(op.floor?.own?.map, undefined);
    assert.equal(op.floor?.own?.gridFromFile, undefined);
    assert.ok(clientOpSchema.safeParse(op).success);
  });

  test("a scene with no grid, background or fog of its own sends a new scene's", () => {
    const bare: SceneInput = { id: "b", name: "Bare", bounds: { w: 10, h: 10 } };
    const own = floorCreateOf(bare, TARGET, "", "own").floor?.own;
    assert.deepEqual(own, { bounds: { w: 10, h: 10 }, background: "#2b2b31", grid: { show: true, color: "#ffffff", opacity: 0.25, lineWidth: 1 }, autoWalls: "all", fogEnabled: false, vision: { on: false, light: "bright", byClock: false } });
    assert.equal(floorCreateOf({ ...bare, map: MAP }, TARGET, "", "own").floor?.own?.fogEnabled, true, "a map has something to hide");
  });
});

describe("the refusals the dialogs ask on the latest view (3.5, 3.6)", () => {
  test("a ninth floor, stairs between and a room of 50 scenes each stop the add with the group's words", () => {
    assert.equal(floorAddRefusal(tower(), TARGET), null);
    const eight = (n: number): RoomState => {
      const state = tower();
      for (let i = 3; i < n; i++) state.scenes[`f${i}`] = scene(`f${i}`, { name: "Tower", floor: { of: GROUND, level: i, name: `Floor ${i}`, height: 10 } });
      return state;
    };
    assert.equal(floorAddRefusal(eight(8), TARGET), FLOOR_WORDS.tooMany("Tower"));
    assert.equal(floorAddRefusal(eight(7), TARGET), null);
    const stairs = withStairs();
    assert.equal(floorAddRefusal(stairs, TARGET), LINK_WORDS.between("stairs", "Ground floor", "Upper floor"));
    assert.equal(floorAddRefusal(stairs, { beside: GROUND, side: "below" }), null);
    assert.equal(floorAddRefusal(stairs, { beside: UPPER, side: "below" }), LINK_WORDS.between("stairs", "Ground floor", "Upper floor"));
    const full = tower();
    for (let i = Object.keys(full.scenes).length; i < LIMITS.scenesPerRoom; i++) full.scenes[`x${i}`] = scene(`x${i}`, { order: i });
    assert.equal(Object.keys(full.scenes).length, 50);
    assert.equal(floorAddRefusal(full, TARGET), SCENES_FULL);
    assert.equal(SCENES_FULL, "A room holds at most 50 scenes. Delete one to add another.");
  });

  test("a floor beside that went is left to the server's refusal", () => {
    assert.equal(floorAddRefusal(tower(), { beside: "gone", side: "above" }), null);
  });
});
