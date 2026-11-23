import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { int, pick, rng } from "../testutil.ts";
import { occupiedHexes, placedOnHex, type PlacedToken, type SizeCategory } from "./footprint.ts";
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

describe("pulledInside on hexes against the scan of every hex (DROPMAP-OPUS-2)", () => {
  /** The nearest spot of the scene's hexes whose footprint stands inside: what the ring search must match in distance. */
  function scanned(g: HexGrid, bounds: { w: number; h: number }, token: PlacedToken, to: { x: number; y: number }): number | null {
    let best: number | null = null;
    for (const hex of sceneHexes(g, bounds)) {
      const p = placedOnHex(g, token, hex);
      if (!standsInScene(g, bounds, { ...token, x: p.x, y: p.y })) continue;
      const d = (p.x - to.x) ** 2 + (p.y - to.y) ** 2;
      if (best === null || d < best) best = d;
    }
    return best;
  }

  test("the nearest spot by distance, on scenes of random sizes and aims far and near, both orientations and every size", () => {
    const r = rng(0x51de);
    for (let i = 0; i < 600; i++) {
      const g = pick(r, [ROWS, COLUMNS] as const);
      const bounds = { w: int(r, 2, 40), h: int(r, 2, 40) };
      // A custom size draws any box from half a cell to 20, larger than the scene too, on the hexes of its size category (DROPMAP-SOL-02).
      const token: PlacedToken = r() < 0.4 ? { size: "custom", w: 0.5 + r() * 19.5, h: 0.5 + r() * 19.5, x: 0, y: 0 } : sized(pick(r, ["tiny", "small", "medium", "large", "huge", "gargantuan"] as const), 0, 0);
      const to = { x: r() * (bounds.w + 60) - 30, y: r() * (bounds.h + 60) - 30 };
      const at = pulledInside(g, bounds, token, to);
      const want = scanned(g, bounds, token, to);
      if (want === null) continue;
      assert.equal(standsInScene(g, bounds, { ...token, ...at }), true, JSON.stringify({ bounds, token, to, at }));
      if (!standsInScene(g, bounds, { ...token, ...to })) assert.ok(Math.abs((at.x - to.x) ** 2 + (at.y - to.y) ** 2 - want) < 1e-6, `run ${i}: ${JSON.stringify({ g, bounds, token, to, at, want })}`);
    }
  });

  test("a custom size is searched by its category's hexes: the reviewers' two repros return the nearest valid spot", () => {
    const custom: PlacedToken = { size: "custom", w: 20, h: 20, x: 0, y: 0 };
    const small = pulledInside(COLUMNS, { w: 10, h: 10 }, custom, { x: 50, y: -50 });
    assert.equal(standsInScene(COLUMNS, { w: 10, h: 10 }, { ...custom, ...small }), true, `on ${small.x}, ${small.y}`);
    const wide = pulledInside(COLUMNS, { w: 30, h: 30 }, custom, { x: -50, y: 5 });
    const want = scanned(COLUMNS, { w: 30, h: 30 }, custom, { x: -50, y: 5 });
    assert.ok(Math.abs((wide.x + 50) ** 2 + (wide.y - 5) ** 2 - want!) < 1e-6, `on ${wide.x}, ${wide.y}`);
  });

  test("a drop far past the edge of the largest scene reads a few dozen hexes, not all 40,000", () => {
    const bounds = { w: 200, h: 200 };
    for (const size of ["medium", "large", "gargantuan"] as const) {
      for (const to of [{ x: -50, y: 700 }, { x: 900, y: -40 }, { x: 100, y: -300 }]) {
        const probe = { read: 0 };
        const at = pulledInside(COLUMNS, bounds, sized(size, 0, 0), to, probe);
        assert.equal(standsInScene(COLUMNS, bounds, { ...sized(size, 0, 0), ...at }), true);
        assert.ok(probe.read < 600, `${size}: ${probe.read} hexes read`);
      }
    }
  });
});
