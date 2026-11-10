import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { hexCenter, hexInScene, hexNeighbors, sceneHexSpan } from "#shared/rules/hex.ts";
import { hexGridOf, latticeFor } from "./lattice.ts";

const ROWS = hexGridOf("hexRows");
const COLUMNS = hexGridOf("hexColumns");

describe("the plan's lattice (phase 3, 2.1)", () => {
  test("squares are the bounds, with 4 neighbors and every outside side on the border", () => {
    const l = latticeFor("squares", { w: 5, h: 4 });
    assert.deepEqual([l.W, l.H], [5, 4]);
    assert.deepEqual([...l.halo(0)].sort((a, b) => a - b), [1, 5]);
    assert.equal(l.halo(6).length, 4);
    assert.equal(l.step(6, 1, 2), 8);
    assert.equal(l.step(6, 0, 2), null);
    assert.ok(l.border(0, 0) && l.border(0, 3) && !l.border(0, 1));
    assert.deepEqual(l.pointOf(2, 3), [2.5, 3.5]);
    assert.equal(l.keyOf(7), "2,1");
  });

  test("Hex rows: W the even row's hexes, H the rows, odd rows one shorter, as sceneHexSpan and hexInScene say", () => {
    for (const bounds of [
      { w: 30, h: 20 },
      { w: 50, h: 50 },
      { w: 21, h: 87 },
    ]) {
      const l = latticeFor("hexRows", bounds);
      const span = sceneHexSpan(ROWS, bounds);
      assert.deepEqual([l.W, l.H], [span.cols, span.rows]);
      for (let y = -1; y <= l.H; y++) for (let x = -1; x <= l.W; x++) assert.equal(l.inMap(x, y), hexInScene(ROWS, bounds, { col: x, row: y }), `${x},${y}`);
    }
  });

  test("87 cells down hold exactly 100 rows (MAX_HEX_ROWS), 86 hold 98", () => {
    assert.equal(latticeFor("hexRows", { w: 50, h: 87 }).H, 100);
    assert.equal(latticeFor("hexRows", { w: 50, h: 86 }).H, 98);
    assert.equal(latticeFor("hexColumns", { w: 87, h: 50 }).H, 100);
  });

  test("a hex step is the neighbor hexNeighbors gives, on rows and through the mirror on columns, and keys a row or column apart are neighbors", () => {
    for (const grid of ["hexRows", "hexColumns"] as const) {
      const g = grid === "hexRows" ? ROWS : COLUMNS;
      const bounds = { w: 12, h: 12 };
      const l = latticeFor(grid, bounds);
      for (let y = 0; y < l.H; y++) {
        for (let x = 0; x < l.W; x++) {
          if (!l.inMap(x, y)) continue;
          const k = y * l.W + x;
          const world = grid === "hexRows" ? { col: x, row: y } : { col: y, row: x };
          const want = hexNeighbors(g, world).map((h) => (grid === "hexRows" ? `${h.col},${h.row}` : `${h.col},${h.row}`));
          for (let d = 0; d < 6; d++) {
            const n = l.step(k, d, 1);
            if (n === null) continue;
            assert.equal(l.keyOf(n), want[d], `${grid} ${x},${y} toward ${d}`);
          }
          for (const n of [k - 1, k + 1, k - l.W, k + l.W]) {
            const nx = n % l.W;
            const ny = Math.floor(n / l.W);
            if (n < 0 || n >= l.W * l.H || Math.abs(nx - x) + Math.abs(ny - y) !== 1 || !l.inMap(nx, ny)) continue;
            assert.ok(l.halo(k).includes(n), `${grid} ${x},${y} and ${nx},${ny} are hex neighbors`);
          }
        }
      }
    }
  });

  test("only an even row's west side at x 0 and east side at x W are on the border", () => {
    const l = latticeFor("hexRows", { w: 10, h: 10 });
    assert.ok(l.border(0, 3));
    assert.ok(l.border(l.W - 1, 0));
    assert.ok(!l.border(l.W, 3), "an odd row's west side is half a hex in");
    assert.ok(!l.border(2 * l.W - 2, 0), "an odd row's east side is half a hex in");
    assert.ok(!l.border(3, 4) && !l.border(3, 5), "the top row's slants face the scene's top slivers");
  });

  test("pointOf is the hex's center on the 1/64 lattice, mirrored on columns, and keyOf mirrors the key", () => {
    const rows = latticeFor("hexRows", { w: 10, h: 10 });
    const c = hexCenter(ROWS, { col: 3, row: 5 });
    const [px, py] = rows.pointOf(3, 5);
    assert.ok(Math.abs(px - c.x) <= 1 / 128 && Math.abs(py - c.y) <= 1 / 128);
    assert.ok(Number.isInteger(px * 64) && Number.isInteger(py * 64));
    const cols = latticeFor("hexColumns", { w: 10, h: 10 });
    assert.deepEqual(cols.pointOf(3, 5), [py, px]);
    assert.equal(cols.keyOf(5 * cols.W + 3), "5,3");
    assert.equal(rows.keyOf(5 * rows.W + 3), "3,5");
  });
});
