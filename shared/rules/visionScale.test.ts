import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LIMITS } from "../limits.ts";
import type { RoomState } from "../model.ts";
import { visionRules } from "../ruleHooks.ts";
import { actor, character, room, scene, token } from "../testutil.ts";
import { SQUARES } from "./grid.ts";

/**
 * Senses and lights in cells as well as feet (docs/design-v1-maps-vision.md
 * 2.4): on a grid finer than 5 ft per cell they stop at the cells their
 * feet caps make at 5 ft, 30 for a sense and 24 for each light radius, so
 * sight costs what the server-box gate measured at every scale.
 */
function open(feetPerCell: number): RoomState {
  const state = room();
  state.meta.settings = { ...state.meta.settings, feetPerCell };
  state.scenes.s1 = scene("s1", { bounds: { w: 200, h: 200 }, vision: { on: true, light: "dark" } });
  return state;
}

/** Whether the party sees a Medium goblin standing with its west edge `dx` cells east of the cell at `x`. */
function seesAt(state: RoomState, x: number, y: number, dx: number): boolean {
  return visionRules.partySight(state, "s1").seesToken(token("gob", { x: x + dx, y }), SQUARES);
}

describe("senses and lights on a fine grid", () => {
  test("the caps in cells are the feet caps at 5 ft per cell", () => {
    assert.equal(LIMITS.senseMaxCells * 5, LIMITS.senseMaxFt);
    assert.equal(LIMITS.lightRadiusMaxCells * 5, 120);
  });

  test("darkvision reaches its feet on a 5 ft and a 2 ft grid, and at most 30 cells on a 1 ft grid", () => {
    for (const [fpc, reach] of [
      [5, 24],
      [2, 30],
      [1, 30],
    ] as const) {
      const state = open(fpc);
      state.characters.c1 = character("c1", { actor: actor({ senses: "darkvision 120 ft" }) });
      state.tokens.pc = token("pc", { kind: "pc", actor: { ref: "c1" }, x: 20, y: 100 });
      // The eye is the middle of the cell at x = 20, so a goblin whose near edge is `reach - 1` cells off is inside the circle and one at `reach + 1` is not.
      assert.equal(seesAt(state, 20, 100, reach - 1), true, `${fpc} ft per cell, inside`);
      assert.equal(seesAt(state, 20, 100, reach + 1), false, `${fpc} ft per cell, outside`);
    }
  });

  test("a light's radii stop at 24 cells each on a 1 ft grid, and keep their feet on a 5 ft grid", () => {
    for (const [fpc, reach] of [
      [5, 48],
      [1, 48],
    ] as const) {
      const state = open(fpc);
      state.characters.c1 = character("c1", { actor: actor({ senses: "" }) });
      state.tokens.pc = token("pc", { kind: "pc", actor: { ref: "c1" }, x: 100, y: 100 });
      state.lights.l1 = { id: "l1", rev: 0, sceneId: "s1", x: 100.5, y: 100.5, bright: 120, dim: 120, on: true, walls: true };
      assert.equal(seesAt(state, 100, 100, reach - 2), true, `${fpc} ft per cell, lit`);
      assert.equal(seesAt(state, 100, 100, reach + 2), false, `${fpc} ft per cell, dark`);
    }
  });
});
