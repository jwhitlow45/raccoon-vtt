import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { GridShape, PathStop, RoomState, Viewer } from "../model.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { placedOnHex, tokenRefHex, type PlacedToken } from "../rules/footprint.ts";
import { rasterizeFogOps } from "../rules/fog.ts";
import { gridOfShape, SQUARES } from "../rules/grid.ts";
import { hexDistance, hexKey, hexSubcells, type Hex, type HexGrid } from "../rules/hex.ts";
import { ownWalk } from "../rules/movement.ts";
import { routeWalk } from "../rules/route.ts";
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

describe("a leg through one fogged hex (section 9)", () => {
  /** Fog on, every sub-cell revealed but those of `hex`. */
  function allBut(state: RoomState, g: HexGrid, hex: Hex): void {
    state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: true };
    const ops = [
      { id: "all", mode: "reveal" as const, shape: { kind: "rect" as const, x: 0, y: 0, w: 30, h: 20 } },
      ...hexSubcells(g, hex).map(([sx, sy], i) => ({ id: `h${i}`, mode: "hide" as const, shape: { kind: "rect" as const, x: sx / 4, y: sy / 4, w: 0.25, h: 0.25 } })),
    ];
    for (const [key, tile] of Object.entries(rasterizeFogOps(state.fogTiles, "s1", state.scenes.s1.bounds, ops))) {
      if (tile === null) delete state.fogTiles[key];
      else state.fogTiles[key] = tile;
    }
  }

  test("is not routeSeen, though its ends are seen, and the square samples of the same leg miss that hex", () => {
    // Two rows straight down on hex rows: the line passes hex 4,3 of the odd row between, by its nudge.
    const f = fight("hexRows", "medium", { col: 4, row: 2 }, (s) => allBut(s, gridOfShape("hexRows") as HexGrid, { col: 4, row: 3 }));
    f.move({ col: 4, row: 4 });
    const stop = f.stops()[1]!;
    assert.deepEqual([f.stops()[0]!.seen, stop.seen, stop.routeSeen], [true, true, undefined]);
    // Without the hex line, the leg's top-left samples stand on hex 3,3 between, so every spot would read as seen.
    const from = ownWalk({ ...token("o", { size: "medium" }), ...placedOnHex(f.g, { size: "medium", x: 0, y: 0 }, { col: 4, row: 2 }) });
    const to = { ...from, ...placedOnHex(f.g, from, { col: 4, row: 4 }) };
    const squares = routeWalk(SQUARES, [from, to], { buildChunks: {} }).map((p) => hexKey(tokenRefHex(f.g, { size: "medium", x: p.x, y: p.y })));
    assert.ok(!squares.includes("4,3"), squares.join(" "));
  });

  test("a leg beside it is routeSeen", () => {
    const f = fight("hexRows", "medium", { col: 4, row: 2 }, (s) => allBut(s, gridOfShape("hexRows") as HexGrid, { col: 8, row: 3 }));
    f.move({ col: 4, row: 4 });
    assert.equal(f.stops()[1]!.routeSeen, true);
  });
});
