import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANA, BREE, GROUND, UPPER } from "./floorLinksTestutil.ts";
import type { GridShape, RoomState } from "./model.ts";
import { goblin, levelGrid, openTower, pc, withAll } from "./openingsTestutil.ts";
import { projectState } from "./project.ts";
import { coldSightFor, visionRules } from "./ruleHooks.ts";
import { footprintSubcells } from "./rules/footprint.ts";
import { gridOfShape } from "./rules/grid.ts";
import { hexCenter, hexSubcells, type HexGrid } from "./rules/hex.ts";
import { openingJoins } from "./rules/openingSight.ts";
import { BRIGHT, NOT_SEEN } from "./rules/vision.ts";

/*
 * An opening on a hex scene (docs/design/design-v1-floors.md phase 4, 7.1):
 * its squares are the hexes its rect names, and the join is the sub-cells
 * whose centers lie inside them (hex.ts hexSubcells), as a creature on
 * hexes is read (docs/design/design-v1-hex-grids.md HX-D10). The square
 * sub-cells of the rect's box outside those hexes stay each floor's own.
 */

for (const shape of ["hexRows", "hexColumns"] as const satisfies readonly GridShape[]) {
  describe(`an opening on ${shape}`, () => {
    const g = gridOfShape(shape) as HexGrid;
    const hexes = [6, 7].flatMap((row) => [6, 7].map((col) => ({ col, row })));
    const inside = new Set(hexes.flatMap((h) => hexSubcells(g, h)).map(([sx, sy]) => `${sx},${sy}`));
    const hexTower = (state: RoomState): RoomState => ({ ...state, scenes: Object.fromEntries(Object.entries(state.scenes).map(([id, s]) => [id, s.floor ? { ...s, gridShape: shape } : s])) });
    const thorn = pc("thorn", "p1", UPPER, 2.4, 2.3);
    const center = hexCenter(g, { col: 6, row: 6 });
    const under = goblin("g1", GROUND, center.x - 0.5, center.y - 0.5);
    const room = withAll(hexTower(openTower({ ground: "bright", upper: "dark" })), [thorn, under, goblin("g2", GROUND, 14.2, 14.1)]);

    test("the join is the sub-cells inside the opening's hexes", () => {
      const [join] = openingJoins(room, UPPER);
      assert.ok(join);
      assert.deepEqual(new Set(join.subs.map(([sx, sy]) => `${sx},${sy}`)), inside);
    });

    test("the hall's light lights those sub-cells upstairs and no other, and a creature under them is seen by its hexes", () => {
      const levels = levelGrid(visionRules.sightFor(room, UPPER, "shared"));
      for (let sy = 0; sy < 80; sy++) {
        for (let sx = 0; sx < 80; sx++) {
          const v = levels[sy * 80 + sx]!;
          if (inside.has(`${sx},${sy}`)) assert.equal(v, BRIGHT, `${sx},${sy}`);
          else assert.equal(v, NOT_SEEN, `${sx},${sy}`);
        }
      }
      const below = visionRules.sightFor(room, GROUND, "shared");
      assert.ok(footprintSubcells(g, under).some(([sx, sy]) => inside.has(`${sx},${sy}`)), "the goblin stands in a hex of the opening");
      assert.equal(below.seesToken(under, g), true);
      assert.equal(below.seesToken(room.tokens.g2!, g), false);
      assert.deepEqual(Object.keys(projectState(room, ANA, { sceneId: null }).tokens).sort(), ["g1", "thorn"]);
      assert.deepEqual(Object.keys(projectState(room, BREE, { sceneId: null }).tokens).sort(), ["g1", "thorn"]);
    });

    test("warm equals cold", () => {
      for (const sceneId of [GROUND, UPPER]) for (const cls of ["shared", "union"] as const) assert.deepEqual([...visionRules.sightFor(room, sceneId, cls).tiles], [...coldSightFor(room, sceneId, cls).tiles]);
    });
  });
}

describe("the same squares on each hex shape, both floors bright", () => {
  test("each shape's column is its own hexes, whichever shape was asked first", () => {
    for (const shape of ["hexRows", "hexColumns", "hexRows"] as const) {
      const g = gridOfShape(shape) as HexGrid;
      const inside = new Set([6, 7].flatMap((row) => [6, 7].flatMap((col) => hexSubcells(g, { col, row }))).map(([sx, sy]) => `${sx},${sy}`));
      const tower = openTower({ ground: "bright", upper: "bright" });
      const hexes: RoomState = { ...tower, scenes: Object.fromEntries(Object.entries(tower.scenes).map(([id, s]) => [id, s.floor ? { ...s, gridShape: shape } : s])) };
      const room = withAll(hexes, [pc("thorn", "p1", GROUND, 2.4, 2.3)]);
      const levels = levelGrid(visionRules.sightFor(room, UPPER, "shared"));
      const lit = new Set<string>();
      levels.forEach((v, i) => {
        if (v > 0) lit.add(`${i % 80},${Math.floor(i / 80)}`);
      });
      assert.deepEqual(lit, inside, shape);
    }
  });
});
