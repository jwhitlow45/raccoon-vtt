import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SceneMap } from "#shared/model.ts";
import { mapWorldRect } from "../../lib/scene.ts";
import {
  boxAtCell,
  boxFromDrag,
  calibrationFromBox,
  calibrationFromCounts,
  calibrationFromFind,
  canonicalToWorld,
  fitBounds,
  imageSquares,
  nudgeBox,
  resizeBox,
  sameCalibration,
  worldToCanonical,
  type Calibration,
} from "./calibrate.ts";

// The dev fixture's map: an 80 px grid printed 40 px in and 50 px down.
const TRUTH = { cellPx: 80, originPx: { x: 40, y: 50 } };
const SIZE = { widthPx: 2440, heightPx: 1690 };
// A first guess from the upload, before anyone aligned anything.
const GUESS: SceneMap = { assetId: "a", ...SIZE, cellPx: 70, originPx: { x: 0, y: 0 } };

function near(actual: number, expected: number, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
}

describe("grid calibration", () => {
  test("world and canonical pixels convert both ways through the calibration", () => {
    const p = worldToCanonical(TRUTH, { x: 2, y: 3 });
    assert.deepEqual(p, { x: 200, y: 290 });
    assert.deepEqual(canonicalToWorld(TRUTH, p), { x: 2, y: 3 });
  });

  test("a 3x3 box dragged over printed squares gives cellPx and originPx", () => {
    // Under the wrong guess, the printed squares at canonical (200, 290) to
    // (440, 530) sit at these world points.
    const from = canonicalToWorld(GUESS, { x: 200, y: 290 });
    const to = canonicalToWorld(GUESS, { x: 440, y: 530 });
    const box = boxFromDrag(GUESS, from, to);
    near(box.x, 200);
    near(box.y, 290);
    near(box.size, 240);
    const cal = calibrationFromBox(box);
    assert.equal(cal.cellPx, 80);
    // The origin moves to the first intersection inside the image.
    assert.deepEqual(cal.originPx, { x: 40, y: 50 });
  });

  test("a drag up and to the left draws the same box", () => {
    const from = canonicalToWorld(GUESS, { x: 440, y: 530 });
    const to = canonicalToWorld(GUESS, { x: 200, y: 290 });
    const cal = calibrationFromBox(boxFromDrag(GUESS, from, to));
    assert.ok(sameCalibration(cal, TRUTH));
  });

  test("the box stays square, sized by the longer side of the drag", () => {
    const box = boxFromDrag(TRUTH, { x: 0, y: 0 }, { x: 3, y: 2 });
    assert.equal(box.size, 240);
    assert.deepEqual({ x: box.x, y: box.y }, { x: 40, y: 50 });
  });

  test("the math is in canonical pixels when the phone shows the mobile variant", () => {
    // The mobile variant is half size, 1220 x 845, and is stretched to the
    // same world rectangle as the full image. Its printed squares are 40 of
    // its own pixels, at (100, 145) for the one canonical (200, 290) holds.
    const rect = mapWorldRect(GUESS);
    assert.ok(rect);
    const mobile = { width: 1220, height: 845 };
    const onScreen = (q: { x: number; y: number }) => ({
      x: rect.x + (q.x / mobile.width) * rect.width,
      y: rect.y + (q.y / mobile.height) * rect.height,
    });
    const box = boxFromDrag(GUESS, onScreen({ x: 100, y: 145 }), onScreen({ x: 220, y: 265 }));
    const cal = calibrationFromBox(box);
    assert.ok(sameCalibration(cal, TRUTH), JSON.stringify(cal));
    // Not the mobile image's own 40 px.
    assert.notEqual(cal.cellPx, 40);
  });

  test("dragging a corner keeps the opposite corner fixed and the box square", () => {
    const box = boxAtCell(TRUTH, 2, 3);
    assert.deepEqual(box, { x: 200, y: 290, size: 240 });
    const grown = resizeBox(TRUTH, box, "se", { x: 6, y: 5.5 });
    assert.equal(grown.x, 200);
    assert.equal(grown.y, 290);
    assert.equal(grown.size, 320);
    const fromNw = resizeBox(TRUTH, box, "nw", { x: 1, y: 2 });
    assert.equal(fromNw.x + fromNw.size, 440);
    assert.equal(fromNw.y + fromNw.size, 530);
    assert.equal(fromNw.size, 320);
  });

  test("nudges move by canonical pixels and grow about the center", () => {
    const box = { x: 200, y: 290, size: 240 };
    assert.deepEqual(nudgeBox(box, 1, -1), { x: 201, y: 289, size: 240 });
    assert.deepEqual(nudgeBox(box, 0, 0, 2), { x: 199, y: 289, size: 242 });
    // Never smaller than one pixel per square.
    assert.equal(nudgeBox({ x: 0, y: 0, size: 3 }, 0, 0, -10).size, 3);
  });

  test("cells across by cells down fit the squares edge to edge", () => {
    const cal = calibrationFromCounts({ widthPx: 3000, heightPx: 2000 }, 30, 20);
    assert.equal(cal.cellPx, 100);
    assert.deepEqual(cal.originPx, { x: 0, y: 0 });
    assert.equal(cal.mismatch, 0);
    const off = calibrationFromCounts({ widthPx: 3000, heightPx: 2000 }, 30, 25);
    assert.equal(off.cellPx, 90);
    assert.ok(off.mismatch > 0.15);
  });

  test("the scene size covers the whole squares after the origin", () => {
    assert.deepEqual(fitBounds({ ...SIZE, ...TRUTH }), { w: 30, h: 20 });
    // Float error short of a whole square still counts it.
    assert.deepEqual(fitBounds({ widthPx: 2999.5, heightPx: 2000, cellPx: 100, originPx: { x: 0, y: 0 } }), { w: 30, h: 20 });
    // Never past the 200-cell limit, never below one cell.
    assert.deepEqual(fitBounds({ widthPx: 8192, heightPx: 10, cellPx: 20, originPx: { x: 0, y: 0 } }), { w: 200, h: 1 });
  });

  test("the counts start from the image's squares, not the scene's", () => {
    // A 20 x 14 square import whose origin falls half a square into the grid: its scene is 21 x 15.
    const imported = { widthPx: 1400, heightPx: 980, cellPx: 70, originPx: { x: -35, y: -35 } };
    const seed = imageSquares(imported);
    assert.deepEqual(seed, { across: 20, down: 14 });
    assert.equal(calibrationFromCounts(imported, seed.across, seed.down).mismatch, 0);
    assert.deepEqual(imageSquares({ widthPx: 8192, heightPx: 10, cellPx: 20, originPx: { x: 0, y: 0 } }), { across: 200, down: 1 });
  });

  test("after lining up the grid, the counts are the squares it covers from its first line (LP3-TABLE-3)", () => {
    // 24 x 16 squares of 70 px printed 20 px in and 12 px down, with a 15 px and a 9 px margin after them.
    const aligned = { widthPx: 1715, heightPx: 1141, cellPx: 70, originPx: { x: 20, y: 12 } };
    assert.deepEqual(imageSquares(aligned), { across: 24, down: 16 });
    assert.deepEqual(imageSquares(aligned), (({ w, h }) => ({ across: w, down: h }))(fitBounds(aligned)));
  });

  test("a box a hair off the lines of art whose squares start at its edge keeps every square (LP5-OPS-4)", () => {
    // 20 x 14 squares of 70 px, edge to edge. The box should cover the squares from (140, 140) to (350, 350).
    const map = { widthPx: 1400, heightPx: 980 };
    for (const corner of [139.5, 140.5]) {
      const cal = calibrationFromBox({ x: corner, y: corner, size: 210 });
      assert.deepEqual(cal, { cellPx: 70, originPx: { x: 0, y: 0 } }, `a box at ${corner}`);
      assert.deepEqual(fitBounds({ ...map, ...cal }), { w: 20, h: 14 });
    }
    // Rounding that lands exactly on a whole cell is 0 too.
    assert.deepEqual(calibrationFromBox({ x: 139.996, y: 140, size: 210 }).originPx, { x: 0, y: 0 });
  });

  test("an origin a tenth of a cell in is a real margin, and is kept (LP5-OPS-4)", () => {
    const cal = calibrationFromBox({ x: 147, y: 140 + 63, size: 210 });
    assert.deepEqual(cal.originPx, { x: 7, y: 63 });
    assert.deepEqual(fitBounds({ widthPx: 1400, heightPx: 980, ...cal }), { w: 19, h: 13 });
  });

  test("a found grid keeps its measured origin, and only one just under a whole square folds to the edge", () => {
    // 140 px squares on a 2000 x 1600 map, found at each of these origins.
    const map = { widthPx: 2000, heightPx: 1600 };
    const kept = (o: number) => calibrationFromFind({ cellPx: 140, originPx: { x: o, y: o } }).originPx;
    for (const o of [1, 6, 7.5, 133]) assert.deepEqual(kept(o), { x: o, y: o }, `an origin of ${o} stays on its lines`);
    assert.deepEqual(kept(6.0006), { x: 6, y: 6 }, "rounded as the app stores it");
    // 1.4 px is 1% of a square here. A line that close before the edge starts the first square at the edge.
    for (const o of [139, 139.9, -0.5]) assert.deepEqual(kept(o), { x: 0, y: 0 }, `an origin of ${o} is on the edge`);
    assert.deepEqual(fitBounds({ ...map, ...calibrationFromFind({ cellPx: 140, originPx: { x: 139.9, y: 139.9 } }) }), { w: 14, h: 11 }, "the first column and row stay in the scene");
    // A small square still folds a whole pixel: 1% of 40 px is less.
    assert.deepEqual(calibrationFromFind({ cellPx: 40, originPx: { x: 39.2, y: 38.9 } }).originPx, { x: 0, y: 38.9 });
    // Where a box the DM drew snaps, a find does not.
    assert.deepEqual(calibrationFromBox({ x: 6, y: 133, size: 420 }).originPx, { x: 0, y: 0 });
  });

  test("a calibration from a box stays inside the schema", () => {
    const tiny: Calibration = calibrationFromBox({ x: -5, y: -5, size: 0.5 });
    assert.equal(tiny.cellPx, 1);
    assert.ok(tiny.originPx.x >= 0 && tiny.originPx.x < 1);
  });
});
