import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Box } from "../lib/boardText.ts";
import type { ViewToken } from "../lib/scene.ts";
import { PLATE_PAD, PLATE_STROKE, placedTextBoxes, plateRect } from "./textBoxes.ts";
import type { TokenText } from "./useBoardText.ts";

function overlaps(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

const block = { lines: [], x: -10, y: 50, width: 60, height: 20 };
const token = { id: "t", x: 2, y: 3 } as unknown as ViewToken;

function text(part: "label" | "plate"): Map<string, TokenText> {
  return new Map([["t", { [part]: block, label: part === "label" ? block : null } as unknown as TokenText]]);
}

describe("the text boxes the layers under the decor keep clear of", () => {
  test("a plate's box is the plate as drawn, its padding and outline included", () => {
    const rect = plateRect(block);
    assert.deepEqual(rect, { x: -10, y: 50 - PLATE_PAD, width: 60, height: 20 + 2 * PLATE_PAD });
    const [box] = placedTextBoxes([token], text("plate"), 40);
    const out = PLATE_STROKE / 2;
    assert.deepEqual(box, { x0: 80 - 10 - out, y0: 120 + 50 - PLATE_PAD - out, x1: 80 + 50 + out, y1: 120 + 70 + PLATE_PAD + out });
  });

  test("a mark over only the plate's top padding is caught", () => {
    const [box] = placedTextBoxes([token], text("plate"), 40);
    // 2 px tall, ending at the lines' top edge: it covers the padding and nothing of the text.
    const candidate = { x0: 90, y0: 120 + 48, x1: 110, y1: 120 + 50 };
    assert.ok(overlaps(candidate, box!));
    const lines = { x0: 80 - 10, y0: 120 + 50, x1: 80 + 50, y1: 120 + 70 };
    assert.ok(!overlaps(candidate, lines), "the lines alone would have let it through");
  });

  test("a label without a plate is its own block, offset by the token's place at this zoom", () => {
    assert.deepEqual(placedTextBoxes([token], text("label"), 40), [{ x0: 70, y0: 170, x1: 130, y1: 190 }]);
    assert.deepEqual(placedTextBoxes([token], new Map(), 40), []);
  });

  test("a name's halo extends beyond its measured block on every edge", () => {
    const label = { ...block, lines: [{ text: "Raised", px: 12, kind: "name" as const }] };
    const placed = new Map([["t", { label } as unknown as TokenText]]);
    assert.deepEqual(placedTextBoxes([token], placed, 40), [{ x0: 68.5, y0: 168.5, x1: 131.5, y1: 191.5 }]);
  });

  // The marks draw over the layers under the decor as the labels do: an elevation badge half over a height pill left neither readable.
  test("a token's chips, elevation badge and HP bar are boxes too, beside its label or plate", () => {
    const badge = { x0: 30, y0: -9, x1: 62, y1: 9 };
    const bar = { x0: 4, y0: 43, x1: 36, y1: 48 };
    const marked = (part: "label" | "plate") =>
      new Map([["t", { [part]: block, label: part === "label" ? block : null, marks: { boxes: [badge, bar] } } as unknown as TokenText]]);
    const ox = 80;
    const oy = 120;
    const marks = [
      { x0: ox + 30, y0: oy - 9, x1: ox + 62, y1: oy + 9 },
      { x0: ox + 4, y0: oy + 43, x1: ox + 36, y1: oy + 48 },
    ];
    assert.deepEqual(placedTextBoxes([token], marked("label"), 40), [...marks, { x0: 70, y0: 170, x1: 130, y1: 190 }]);
    const withPlate = placedTextBoxes([token], marked("plate"), 40);
    assert.deepEqual(withPlate.slice(0, 2), marks);
    assert.deepEqual(withPlate[2], placedTextBoxes([token], text("plate"), 40)[0], "the plate keeps its padding and outline");
  });

  test("a token too small for marks adds only its label", () => {
    const small = new Map([["t", { label: block, plate: null, marks: null } as unknown as TokenText]]);
    assert.deepEqual(placedTextBoxes([token], small, 40), [{ x0: 70, y0: 170, x1: 130, y1: 190 }]);
  });
});
