import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { int, pick, rng } from "../testutil.ts";
import { occupiedHexes, type PlacedToken, type SizeCategory } from "./footprint.ts";
import { SQUARES } from "./grid.ts";
import { hexCenter, hexInScene, sceneHexes, type HexGrid } from "./hex.ts";
import { pulledInside, standsInScene } from "./sceneEdge.ts";

/**
 * The scene's edge for a plain move (DROP-OFF-MAP): which footprints lie
 * inside, and where a drop that does not is pulled to.
 */

const BOUNDS = { w: 20, h: 14 };
const ROWS: HexGrid = { shape: "hex", orient: "rows" };
const COLUMNS: HexGrid = { shape: "hex", orient: "columns" };
const medium = (x: number, y: number): PlacedToken => ({ size: "medium", x, y });
const sized = (size: SizeCategory, x: number, y: number): PlacedToken => ({ size, x, y });

describe("standsInScene", () => {
  test("squares: the whole box lies on the scene, edges included", () => {
    for (const [x, y] of [[0, 0], [19, 13], [19, 0], [0, 13]] as const) assert.equal(standsInScene(SQUARES, BOUNDS, medium(x, y)), true, `${x},${y}`);
    for (const [x, y] of [[-1, 0], [0, -1], [20, 0], [0, 14], [19.5, 5], [-0.5, 5]] as const) assert.equal(standsInScene(SQUARES, BOUNDS, medium(x, y)), false, `${x},${y}`);
    assert.equal(standsInScene(SQUARES, BOUNDS, sized("large", 18, 12)), true);
    assert.equal(standsInScene(SQUARES, BOUNDS, sized("large", 19, 12)), false);
    assert.equal(standsInScene(SQUARES, BOUNDS, sized("tiny", 19.5, 13.5)), true);
  });

  test("squares: a squeezed creature stands on its squeezed box, centered in the full one", () => {
    // A Large one squeezed to 1 by 1 at y = -0.5 stands in row 0, and at -1.5 in no row.
    assert.equal(standsInScene(SQUARES, BOUNDS, { ...sized("large", 3, -0.5), squeeze: true }), true);
    assert.equal(standsInScene(SQUARES, BOUNDS, { ...sized("large", 3, -0.5) }), false);
    assert.equal(standsInScene(SQUARES, BOUNDS, { ...sized("large", 3, -1.5), squeeze: true }), false);
    assert.equal(standsInScene(SQUARES, BOUNDS, { ...sized("large", 19.5, 3), squeeze: true }), false);
    assert.equal(standsInScene(SQUARES, BOUNDS, { ...sized("large", 18.5, 3), squeeze: true }), true);
  });

  for (const [name, g] of [["hex rows", ROWS], ["hex columns", COLUMNS]] as const) {
    test(`${name}: every hex it stands on is the scene's`, () => {
      const hexes = sceneHexes(g, BOUNDS);
      assert.ok(hexes.length > 100);
      for (const hex of hexes) {
        const c = hexCenter(g, hex);
        assert.equal(standsInScene(g, BOUNDS, medium(c.x - 0.5, c.y - 0.5)), true);
      }
      const far = hexCenter(g, { col: 3, row: -10 });
      assert.equal(standsInScene(g, BOUNDS, medium(far.x - 0.5, far.y - 0.5)), false);
      const left = hexCenter(g, { col: -1, row: 3 });
      assert.equal(standsInScene(g, BOUNDS, medium(left.x - 0.5, left.y - 0.5)), false);
    });
  }
});

describe("pulledInside on squares", () => {
  test("a spot already inside is left alone, each axis held at its edge on its own", () => {
    assert.deepEqual(pulledInside(SQUARES, BOUNDS, medium(0, 0), { x: 7, y: 4 }), { x: 7, y: 4 });
    assert.deepEqual(pulledInside(SQUARES, BOUNDS, medium(0, 0), { x: -10, y: 4 }), { x: 0, y: 4 });
    assert.deepEqual(pulledInside(SQUARES, BOUNDS, medium(0, 0), { x: 7, y: 99 }), { x: 7, y: 13 });
    assert.deepEqual(pulledInside(SQUARES, BOUNDS, medium(0, 0), { x: 50, y: -3 }), { x: 19, y: 0 });
  });

  test("by size: a Large creature's box, a Tiny one on half cells, a custom size on whole cells", () => {
    assert.deepEqual(pulledInside(SQUARES, BOUNDS, sized("large", 0, 0), { x: 30, y: 30 }), { x: 18, y: 12 });
    assert.deepEqual(pulledInside(SQUARES, BOUNDS, sized("tiny", 0, 0), { x: 30, y: 30 }), { x: 19.5, y: 13.5 });
    assert.deepEqual(pulledInside(SQUARES, BOUNDS, { size: "custom", w: 2.5, h: 1, x: 0, y: 0 }, { x: 30, y: -3 }), { x: 17, y: 0 });
  });

  test("a token the scene is too small for is left where it was aimed", () => {
    assert.deepEqual(pulledInside(SQUARES, { w: 1, h: 1 }, sized("large", 0, 0), { x: 5, y: -5 }), { x: 5, y: -5 });
  });

  test("the pulled spot stands inside, on random sizes and aims", () => {
    const r = rng(0xed6e);
    for (let i = 0; i < 2000; i++) {
      const token: PlacedToken = r() < 0.2 ? { size: "custom", w: 0.5 + int(r, 0, 8) * 0.5, h: 0.5 + int(r, 0, 8) * 0.5, x: 0, y: 0 } : sized(pick(r, ["tiny", "small", "medium", "large", "huge", "gargantuan"] as const), 0, 0);
      const to = { x: Math.round((r() * 80 - 30) * 2) / 2 + 0, y: Math.round((r() * 80 - 30) * 2) / 2 + 0 };
      const at = pulledInside(SQUARES, BOUNDS, token, to);
      assert.equal(standsInScene(SQUARES, BOUNDS, { ...token, ...at }), true, JSON.stringify({ token, to, at }));
      if (standsInScene(SQUARES, BOUNDS, { ...token, ...to })) assert.deepEqual(at, to);
    }
  });
});

describe("pulledInside on hexes", () => {
  for (const [name, g] of [["hex rows", ROWS], ["hex columns", COLUMNS]] as const) {
    test(`${name}: a drop far past the edge lands on the nearest hex of the scene`, () => {
      const c = hexCenter(g, { col: 6, row: -10 });
      const aim = { x: c.x - 0.5, y: c.y - 0.5 };
      const at = pulledInside(g, BOUNDS, medium(0, 0), aim);
      assert.equal(standsInScene(g, BOUNDS, { ...medium(0, 0), ...at }), true);
      const near = (a: { x: number; y: number }) => (a.x - aim.x) ** 2 + (a.y - aim.y) ** 2;
      for (const hex of sceneHexes(g, BOUNDS)) {
        const h = hexCenter(g, hex);
        assert.ok(near(at) <= near({ x: h.x - 0.5, y: h.y - 0.5 }) + 1e-9, "no hex of the scene is nearer");
      }
    });

    test(`${name}: a spot inside is left alone, and Large, Huge and Gargantuan footprints are pulled whole`, () => {
      const inside = hexCenter(g, { col: 8, row: 6 });
      const here = { x: inside.x - 0.5, y: inside.y - 0.5 };
      assert.deepEqual(pulledInside(g, BOUNDS, medium(0, 0), here), here);
      const r = rng(0x4e8);
      for (let i = 0; i < 300; i++) {
        const token = sized(pick(r, ["small", "medium", "large", "huge", "gargantuan"] as const), 0, 0);
        const aim = { x: r() * 60 - 20, y: r() * 50 - 20 };
        const at = pulledInside(g, BOUNDS, token, aim);
        assert.equal(standsInScene(g, BOUNDS, { ...token, ...at }), true, JSON.stringify({ token, aim, at }));
        assert.ok(occupiedHexes(g, { ...token, ...at }).every((h) => hexInScene(g, BOUNDS, h)));
      }
    });
  }
});
