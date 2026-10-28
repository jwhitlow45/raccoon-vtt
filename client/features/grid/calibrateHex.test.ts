import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { gridOfShape, type Grid } from "#shared/rules/grid.ts";
import { HEX_R, HEX_S, hexAt, hexCenter, type HexGrid } from "#shared/rules/hex.ts";
import { rng } from "#shared/testutil.ts";
import { boxAt, boxCorner, boxFromDrag, boxSides, calibrationFromBox, calibrationFromHexFind, canonicalToWorld, HEX_BOX_DEPTH, insideBox, nudgeBox, resizeBox, type Calibration } from "./calibrate.ts";

const ROWS = gridOfShape("hexRows") as HexGrid;
const COLUMNS = gridOfShape("hexColumns") as HexGrid;

const near = (a: number, b: number, eps = 0.02) => Math.abs(a - b) <= eps;

/** Whether two calibrations draw the same hex lattice: every hex center of one is a hex center of the other. */
function sameLattice(g: HexGrid, a: Calibration, b: Calibration): boolean {
  if (!near(a.cellPx, b.cellPx, 1e-3)) return false;
  for (const h of [{ col: 0, row: 0 }, { col: 3, row: 1 }, { col: 5, row: 4 }]) {
    const c = hexCenter(g, h);
    const px = { x: c.x * a.cellPx + a.originPx.x, y: c.y * a.cellPx + a.originPx.y };
    const back = canonicalToWorld(b, px);
    const on = hexCenter(g, hexAt(g, back));
    if (!near(on.x, back.x, 1e-3) || !near(on.y, back.y, 1e-3)) return false;
  }
  return true;
}

describe("Line up grid's box on hexes (docs/design-v1-hex-grids.md HX-D12)", () => {
  test("holds 7 hexes: 3 by 2.89 cells on hex rows, 2.89 by 3 on hex columns", () => {
    assert.ok(near(3 * HEX_BOX_DEPTH, 2 * HEX_S + 2 * HEX_R, 1e-12));
    assert.ok(near(3 * HEX_BOX_DEPTH, 2.89, 0.01));
    assert.deepEqual(boxSides({ x: 0, y: 0, size: 300 }, ROWS), { w: 300, h: 300 * HEX_BOX_DEPTH });
    assert.deepEqual(boxSides({ x: 0, y: 0, size: 300 }, COLUMNS), { w: 300 * HEX_BOX_DEPTH, h: 300 });
    assert.deepEqual(boxSides({ x: 0, y: 0, size: 300 }, { shape: "squares" }), { w: 300, h: 300 });
  });

  test("keeps its shape as it is dragged, resized by a corner and nudged", () => {
    const cal: Calibration = { cellPx: 50, originPx: { x: 0, y: 0 } };
    for (const g of [ROWS, COLUMNS]) {
      const ratio = (b: { size: number }) => boxSides({ x: 0, y: 0, size: b.size }, g);
      const dragged = boxFromDrag(cal, { x: 2, y: 2 }, { x: 4, y: 7 }, g);
      const s = ratio(dragged);
      assert.ok(near(Math.min(s.w, s.h) / Math.max(s.w, s.h), HEX_BOX_DEPTH, 1e-9));
      // The drag pulls 5 cells down and 2 across: the side down follows the finger, the side across the shape.
      assert.ok(near(s.h, 250, 1e-9), `${g.orient}: the farther pull sets the box`);
      const se = boxCorner(dragged, "se", g);
      const resized = resizeBox(cal, dragged, "nw", { x: 0, y: 0 }, g);
      assert.deepEqual(boxCorner(resized, "se", g), se, "the opposite corner stays");
      const grown = nudgeBox(dragged, 0, 0, 10, g);
      const before = boxSides(dragged, g);
      const after = boxSides(grown, g);
      assert.ok(near(grown.x + after.w / 2, dragged.x + before.w / 2, 1e-9) && near(grown.y + after.h / 2, dragged.y + before.h / 2, 1e-9), "it grows about its middle");
    }
  });

  test("a tap puts the box over the hex there and its six neighbors, and a point inside reads inside", () => {
    const cal: Calibration = { cellPx: 40, originPx: { x: 12, y: 7 } };
    for (const g of [ROWS, COLUMNS]) {
      const box = boxAt(cal, g, { x: 6.2, y: 4.9 });
      const { w, h } = boxSides(box, g);
      const mid = canonicalToWorld(cal, { x: box.x + w / 2, y: box.y + h / 2 });
      const c = hexCenter(g, hexAt(g, { x: 6.2, y: 4.9 }));
      assert.ok(near(mid.x, c.x, 1e-9) && near(mid.y, c.y, 1e-9));
      assert.equal(insideBox(box, g, { x: box.x + w - 1, y: box.y + h - 1 }), true);
      assert.equal(insideBox(box, g, { x: box.x + w + 1, y: box.y }), false);
    }
  });

  test("a box over any 7 hexes of drawn art finds that art's lattice, its origin at or after the image's corner and never past a row (property)", () => {
    const random = rng(4242);
    for (const g of [ROWS, COLUMNS] as const) {
      for (let i = 0; i < 2000; i++) {
        const cellPx = 20 + Math.round(random() * 1300) / 10;
        // Clear of the edge snap (ORIGIN_SNAP), which moves an origin within a twentieth of a cell onto the edge on purpose.
        const slack = 0.06 * cellPx;
        const rowPx = HEX_S * cellPx;
        // A row down shifts half a hex, so the origin along a row stays clear of the snap on either parity.
        const along = (random() < 0.5 ? 0 : cellPx / 2) + slack + random() * (cellPx / 2 - 2 * slack);
        const across = (random() < 0.5 ? 0 : rowPx) + slack + random() * (rowPx - 2 * slack);
        const art: Calibration = { cellPx, originPx: g.orient === "rows" ? { x: along, y: across } : { x: across, y: along } };
        const hex = { col: 1 + Math.floor(random() * 20), row: 1 + Math.floor(random() * 20) };
        const c = hexCenter(g, hex);
        const mid = { x: c.x * cellPx + art.originPx.x, y: c.y * cellPx + art.originPx.y };
        const size = 3 * cellPx;
        const { w, h } = boxSides({ x: 0, y: 0, size }, g);
        const cal = calibrationFromBox({ x: mid.x - w / 2, y: mid.y - h / 2, size }, g);
        assert.ok(sameLattice(g, art, cal), `${g.orient} ${i}: ${JSON.stringify(art)} -> ${JSON.stringify(cal)}`);
        const [a, b] = g.orient === "rows" ? [cal.originPx.x, cal.originPx.y] : [cal.originPx.y, cal.originPx.x];
        assert.ok(a >= 0 && a < cellPx && b >= 0 && b < HEX_S * cellPx, `${g.orient} ${i}: origin ${JSON.stringify(cal.originPx)} in the first row`);
      }
    }
  });

  test("art whose hexes start at the image's edge starts there, though the box sits a hair off", () => {
    const g: Grid = ROWS;
    const cellPx = 70;
    // Hex (2, 2) of art whose hex (0, 0) touches the top-left corner, the box 1 px up and left.
    const c = hexCenter(ROWS, { col: 2, row: 2 });
    const size = 3 * cellPx;
    const { w, h } = boxSides({ x: 0, y: 0, size }, g);
    assert.deepEqual(calibrationFromBox({ x: c.x * cellPx - w / 2 - 1, y: c.y * cellPx - h / 2 - 1, size }, g).originPx, { x: 0, y: 0 });
    assert.deepEqual(calibrationFromBox({ x: c.x * cellPx - w / 2 + 1, y: c.y * cellPx - h / 2 + 1, size }, g).originPx, { x: 0, y: 0 });
  });
});

describe("a found hex grid's calibration (docs/design-v1-grid-detect.md 10.7)", () => {
  test("any found center gives the lattice drawn, its origin at or after the image's corner and never past a row, as the box's does (property)", () => {
    const random = rng(9191);
    for (const g of [ROWS, COLUMNS] as const) {
      for (let i = 0; i < 2000; i++) {
        const cellPx = 14 + Math.round(random() * 1400) / 10;
        // Clear of FOUND_SNAP's fold just under a whole row or cell.
        const slack = Math.max(1.1, 0.011 * cellPx);
        const rowPx = HEX_S * cellPx;
        const along = (random() < 0.5 ? 0 : cellPx / 2) + random() * (cellPx / 2 - slack);
        const across = (random() < 0.5 ? 0 : rowPx) + random() * (rowPx - slack);
        const art: Calibration = { cellPx, originPx: g.orient === "rows" ? { x: along, y: across } : { x: across, y: along } };
        const c = hexCenter(g, { col: Math.floor(random() * 20), row: Math.floor(random() * 20) });
        const center = { x: c.x * cellPx + art.originPx.x, y: c.y * cellPx + art.originPx.y };
        const cal = calibrationFromHexFind({ cellPx, center, orient: g.orient });
        assert.ok(sameLattice(g, art, cal), `${g.orient} ${i}: ${JSON.stringify(art)} -> ${JSON.stringify(cal)}`);
        const [a, b] = g.orient === "rows" ? [cal.originPx.x, cal.originPx.y] : [cal.originPx.y, cal.originPx.x];
        assert.ok(a >= 0 && a < cellPx && b >= 0 && b < rowPx, `${g.orient} ${i}: origin ${JSON.stringify(cal.originPx)} in the first row`);
      }
    }
  });

  test("a measured origin a few px in is kept where the box would snap it to the edge, and one just under a whole row folds to the edge", () => {
    const cellPx = 70;
    const rowPx = HEX_S * cellPx;
    // Hex (2, 2)'s center on art whose hex (0, 0) starts 3 px in, across and down.
    const c = hexCenter(ROWS, { col: 2, row: 2 });
    const center = { x: c.x * cellPx + 3, y: c.y * cellPx + 3 };
    assert.deepEqual(calibrationFromHexFind({ cellPx, center, orient: "rows" }).originPx, { x: 3, y: 3 });
    const size = 3 * cellPx;
    const { w, h } = boxSides({ x: 0, y: 0, size }, ROWS);
    assert.deepEqual(calibrationFromBox({ x: center.x - w / 2, y: center.y - h / 2, size }, ROWS).originPx, { x: 0, y: 0 }, "the box's 5% snap");
    // Art whose first row starts half a pixel before the image's top: that row is the scene's first, not cut off.
    const before = calibrationFromHexFind({ cellPx, center: { x: c.x * cellPx, y: c.y * cellPx - 0.5 }, orient: "rows" });
    assert.deepEqual(before.originPx, { x: 0, y: 0 });
    // A row's start just past the top is kept, unsnapped: 1.5 px down.
    assert.deepEqual(calibrationFromHexFind({ cellPx, center: { x: c.x * cellPx, y: c.y * cellPx + 1.5 }, orient: "rows" }).originPx, { x: 0, y: 1.5 });
    // Just under a whole row down, folded onto the edge: the found hex is then in an odd row, which shifts the origin half a hex along.
    assert.deepEqual(calibrationFromHexFind({ cellPx, center: { x: c.x * cellPx, y: c.y * cellPx + rowPx - 0.5 }, orient: "rows" }).originPx, { x: 35, y: 0 });
    // On columns the same, mirrored.
    const cc = hexCenter(COLUMNS, { col: 2, row: 2 });
    assert.deepEqual(calibrationFromHexFind({ cellPx, center: { x: cc.x * cellPx + 3, y: cc.y * cellPx + 3 }, orient: "columns" }).originPx, { x: 3, y: 3 });
  });
});
