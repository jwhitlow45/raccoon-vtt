import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { liftSubs } from "#shared/discoveryTestutil.ts";
import type { Op } from "#shared/protocol.ts";
import { gridOfShape } from "#shared/rules/grid.ts";
import { hexCenter, hexKey, hexSubcells, type Hex, type HexGrid } from "#shared/rules/hex.ts";
import { apply, room, scene } from "#shared/testutil.ts";
import { groundSource, seenGround } from "../builder/heights/ground.ts";
import { freeStop, type GroundReader } from "./ruler.ts";

/**
 * A straight ruler's free stop on a hex scene stands on the ground of the
 * hex it sits on, read by its key, and a player's fog is read on that hex
 * (docs/design-v1-hex-grids.md H3), never on the hex whose key the stop's
 * floored world point happens to spell.
 */

for (const shape of ["hexRows", "hexColumns"] as const) {
  describe(`${shape}: a free stop's ground`, () => {
    const g = gridOfShape(shape) as HexGrid;
    // Built on hex rows and mirrored onto columns, whose keys and bounds swap.
    const m = (h: Hex): Hex => (g.orient === "rows" ? h : { col: h.row, row: h.col });
    const H = m({ col: 4, row: 12 });
    const c = hexCenter(g, H);
    // The hex named by the floored center: another hex, so a reading by squares would land there.
    const W: Hex = { col: Math.floor(c.x), row: Math.floor(c.y) };
    const bounds = g.orient === "rows" ? { w: 20, h: 14 } : { w: 14, h: 20 };
    let s = room({ scenes: { s1: scene("s1", { gridShape: shape, bounds, fogEnabled: true }) } });
    s = apply(s, { t: "build.height", sceneId: "s1", cells: [hexKey(H)], height: 20 } as Op);
    s = apply(s, { t: "build.height", sceneId: "s1", cells: [hexKey(W)], height: 10 } as Op);
    const reader = (state: typeof s, role: "dm" | "player"): GroundReader => {
      const src = groundSource(state, state.scenes.s1!, role);
      return (cell) => seenGround(src, cell) ?? 0;
    };
    const revealing = (hex: Hex) => {
      const out = { ...s, fogTiles: {} };
      liftSubs(out, "dm", hexSubcells(g, hex));
      return out;
    };

    test("the DM's stop stands on its own hex's ground", () => {
      assert.notEqual(hexKey(W), hexKey(H));
      assert.deepEqual(freeStop(g, { x: c.x + 0.1, y: c.y - 0.1 }, reader(s, "dm")), { x: c.x, y: c.y, z: 20 });
    });

    test("a player's stop reads its own hex through the fog: 20 ft where it is revealed, 0 where it is hidden and the other is not", () => {
      assert.equal(freeStop(g, c, reader(revealing(H), "player")).z, 20);
      assert.equal(freeStop(g, c, reader(revealing(W), "player")).z, undefined, "its hex is under the fog");
    });
  });
}
