import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { boxTouchesCell, labelBox, type LabelBox } from "./labels.ts";

describe("label boxes", () => {
  test("the box follows the measured text, with the halo", () => {
    assert.deepEqual(labelBox({ x: 0, y: 0, text: "WW", size: 1 }, () => 2), { x0: -1.08, y0: -0.5, x1: 1.08, y1: 0.5 });
  });

  test("a label covers every cell its text reaches, not only its anchor's", () => {
    const touched = (box: LabelBox) => {
      const out: string[] = [];
      for (let y = -2; y < 6; y++) for (let x = 5; x < 20; x++) if (boxTouchesCell(box, x, y)) out.push(`${x},${y}`);
      return out;
    };
    // "Great hall" at size 0.7 is about 4.3 cells wide, centered on 13.5.
    assert.deepEqual(touched(labelBox({ x: 13.5, y: 1.5, text: "Great hall", size: 0.7 })), ["11,1", "12,1", "13,1", "14,1", "15,1"]);
    // A short label in the middle of a cell stays in it.
    assert.deepEqual(touched(labelBox({ x: 12.5, y: 1.5, text: "Hi", size: 0.45 })), ["12,1"]);
  });

  test("a box that ends on a grid line does not reach the cell past it", () => {
    const box = { x0: 2, y0: 3, x1: 4, y1: 5 };
    assert.equal(boxTouchesCell(box, 1, 3), false);
    assert.equal(boxTouchesCell(box, 2, 3), true);
    assert.equal(boxTouchesCell(box, 3, 4), true);
    assert.equal(boxTouchesCell(box, 4, 4), false);
    assert.equal(boxTouchesCell(box, 3, 5), false);
  });
});
