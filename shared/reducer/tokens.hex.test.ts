import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { GridShape, PathStop, RoomState, Viewer } from "../model.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { placedOnHex, type PlacedToken } from "../rules/footprint.ts";
import { gridOfShape } from "../rules/grid.ts";
import { hexDistance, type Hex, type HexGrid } from "../rules/hex.ts";
import { DM, env, room, scene, token } from "../testutil.ts";

/**
 * A turn's path on a hex scene (docs/design-v1-hex-grids.md 4.2 and 4.3):
 * each leg records the hex steps between its ends' reference hexes, with
 * the room's rule only for height.
 */

const START: Op = { t: "encounter.start", entries: [{ id: "n1", tokenId: "ogre", value: 20 }, { id: "n2", tokenId: "gob", value: 10 }] };
const NEXT: Op = { t: "encounter.next" };

function at(g: HexGrid, size: PlacedToken["size"], hex: Hex): { x: number; y: number } {
  return placedOnHex(g, { size, x: 0, y: 0 }, hex);
}

function fight(shape: GridShape, size: PlacedToken["size"], from: Hex, setup?: (s: RoomState) => void) {
  const g = gridOfShape(shape) as HexGrid;
  let state = room({
    scenes: { s1: scene("s1", { gridShape: shape, bounds: { w: 30, h: 20 } }), s2: scene("s2") },
    tokens: { ogre: token("ogre", { size, ...at(g, size, from) }), gob: token("gob", { x: 20, y: 10 }) },
  });
  setup?.(state);
  let seq = 0;
  const run = (op: Op, who: Viewer = DM) => {
    const r = applyOp(state, op, who, env(++seq));
    assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
    state = r.state;
  };
  run(START);
  run(NEXT);
  return {
    g,
    move: (hex: Hex, extra: Partial<Extract<Op, { t: "token.move" }>> = {}) => run({ t: "token.move", tokenId: "ogre", ...at(g, state.tokens.ogre!.size, hex), ...extra }),
    stops: (): PathStop[] => state.tokens.ogre!.path!.stops,
  };
}

for (const shape of ["hexRows", "hexColumns"] as const) {
  describe(`${shape}: a turn's legs`, () => {
    test("a drag of 4 hexes on the active creature's turn records 20 ft", () => {
      const f = fight(shape, "medium", { col: 3, row: 3 });
      f.move({ col: 7, row: 3 });
      assert.deepEqual([f.stops()[1]!.moved, f.stops()[1]!.cost], [20, 20]);
    });

    test("a Large creature moved 3 hexes moved 15 ft, counted between its top hexes", () => {
      const f = fight(shape, "large", { col: 4, row: 4 });
      f.move({ col: 7, row: 4 });
      assert.equal(hexDistance(f.g, { col: 4, row: 4 }, { col: 7, row: 4 }), 3);
      assert.equal(f.stops()[1]!.moved, 15);
    });

    test("a flier rising 10 ft a leg over one hex a leg carries its vertical count under 5-10-5", () => {
      const f = fight(shape, "medium", { col: 3, row: 3 }, (s) => (s.meta.settings.diagonal = "fiveTen"));
      f.move({ col: 4, row: 3 }, { elevation: 10 });
      f.move({ col: 5, row: 3 }, { elevation: 20 });
      assert.deepEqual(
        f.stops().slice(1).map((s) => [s.moved, s.diag]),
        [
          [10, [0, 1]],
          [15, [0, 1]],
        ],
      );
    });
  });
}
