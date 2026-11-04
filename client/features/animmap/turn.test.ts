import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import type { VideoFacts } from "#shared/model.ts";
import { VIDEO_MATRIX_ROWS, drawnSize, orientationFacts, type VideoMatrixRow } from "#shared/videoGeometry.ts";
import { placementTransform, videoPlacement, type PlaceRect, type VideoPlacement } from "./turn.ts";

/*
 * One placement for a turned, mirrored or stretched video
 * (docs/design/design-v1-video-turns.md 7 and 14): for each of the table's
 * eight rows and any rectangle, the frame's corners land on the
 * rectangle's corners in the order the row's matrix puts them, applied
 * here directly, and the Konva attributes, the canvas matrix and the CSS
 * transform agree.
 */

type Point = [number, number];

/** A row applied to a point, then moved into the positive quadrant by the smallest shift that does it, worked out here rather than read from the table. */
function tableAt(row: Pick<VideoMatrixRow, "a" | "b" | "c" | "d">, w: number, h: number, x: number, y: number): Point {
  const at = (px: number, py: number): Point => [row.a * px + row.c * py, row.b * px + row.d * py];
  const corners = [at(0, 0), at(w, 0), at(0, h), at(w, h)];
  const minX = Math.min(...corners.map((c) => c[0]));
  const minY = Math.min(...corners.map((c) => c[1]));
  const [dx, dy] = at(x, y);
  return [dx - minX, dy - minY];
}

/** Konva's node transform: translate, rotate, scale, then the offset taken off. */
function konvaAt(p: VideoPlacement, x: number, y: number): Point {
  const sx = (x - p.offsetX) * p.scaleX;
  const sy = (y - p.offsetY) * p.scaleY;
  const r = (p.rotation * Math.PI) / 180;
  return [p.x + sx * Math.cos(r) - sy * Math.sin(r), p.y + sx * Math.sin(r) + sy * Math.cos(r)];
}

function matrixAt(m: readonly number[], x: number, y: number): Point {
  const [a, b, c, d, e, f] = m as [number, number, number, number, number, number];
  return [a * x + c * y + e, b * x + d * y + f];
}

/** A CSS transform about the element's center, as a browser applies it to a point of the element. */
function cssAt(element: PlaceRect, css: string, x: number, y: number): Point {
  if (css === "none") return [element.x + x, element.y + y];
  const parts = /^matrix\((-?\d), (-?\d), (-?\d), (-?\d), 0, 0\)$/.exec(css);
  assert.ok(parts, css);
  const [a, b, c, d] = parts.slice(1).map(Number) as [number, number, number, number];
  const cx = element.width / 2;
  const cy = element.height / 2;
  return [element.x + cx + a * (x - cx) + c * (y - cy), element.y + cy + b * (x - cx) + d * (y - cy)];
}

function near(actual: Point, expected: Point, what: string): void {
  const tolerance = 1e-6 * Math.max(1, ...expected.map(Math.abs));
  assert.ok(Math.abs(actual[0] - expected[0]) <= tolerance && Math.abs(actual[1] - expected[1]) <= tolerance, `${what}: ${actual.join(", ")} for ${expected.join(", ")}`);
}

const FACTS: VideoFacts = { widthPx: 1920, heightPx: 1080, container: "mp4", video: "avc1.640028", fps: 30, durationMs: 2000, kbps: 1000 };

describe("a video's placement (docs/design/design-v1-video-turns.md 7)", () => {
  test("for every row, size, stretch and rectangle, the frame's corners land where the row's matrix puts them, by Konva, the canvas and CSS alike", () => {
    const rect = fc.record({
      x: fc.double({ min: -5000, max: 5000, noNaN: true }),
      y: fc.double({ min: -5000, max: 5000, noNaN: true }),
      width: fc.double({ min: 0.5, max: 8000, noNaN: true }),
      height: fc.double({ min: 0.5, max: 8000, noNaN: true }),
    });
    const coded = fc.record({ widthPx: fc.integer({ min: 256, max: 4096 }), heightPx: fc.integer({ min: 256, max: 4096 }), stretch: fc.option(fc.double({ min: 0.5, max: 2, noNaN: true }), { nil: undefined }) });
    fc.assert(
      fc.property(fc.constantFrom(...VIDEO_MATRIX_ROWS), coded, rect, (row, size, r) => {
        const displayWidthPx = size.stretch === undefined ? undefined : Math.round(size.widthPx * size.stretch);
        const facts = { ...FACTS, widthPx: size.widthPx, heightPx: size.heightPx, ...(displayWidthPx !== undefined ? { displayWidthPx } : {}), ...orientationFacts(row) };
        const placement = videoPlacement(r, facts);
        const transform = placementTransform(r, facts);
        const drawn = drawnSize(facts);
        // The picture before the turn: its stretched width by its height.
        const pw = displayWidthPx ?? size.widthPx;
        const ph = size.heightPx;
        for (const [i, j] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ] as const) {
          const [dx, dy] = tableAt(row, pw, ph, i * pw, j * ph);
          const want: Point = [r.x + (dx / drawn.widthPx) * r.width, r.y + (dy / drawn.heightPx) * r.height];
          // The frame fills the box, whatever the browser's own size for it.
          const bx = i * transform.box.width;
          const by = j * transform.box.height;
          assert.deepEqual([placement.width, placement.height], [transform.box.width, transform.box.height], "Konva's box is the canvas's");
          near(konvaAt(placement, i * placement.width, j * placement.height), want, `Konva, turn ${row.turn} mirror ${row.mirror}, corner ${i}${j}`);
          near(matrixAt(transform.matrix, bx, by), want, `the canvas, turn ${row.turn} mirror ${row.mirror}, corner ${i}${j}`);
          near(cssAt(transform.element, transform.css, bx, by), want, `CSS, turn ${row.turn} mirror ${row.mirror}, corner ${i}${j}`);
        }
      }),
      { numRuns: 4000 },
    );
  });

  test("a plain video gets the rectangle itself, as before turns, and no CSS transform", () => {
    const rect = { x: 3, y: 4, width: 32, height: 18 };
    assert.deepEqual(videoPlacement(rect, FACTS), { x: 3, y: 4, width: 32, height: 18, offsetX: 0, offsetY: 0, rotation: 0, scaleX: 1, scaleY: 1 });
    const t = placementTransform(rect, FACTS);
    assert.equal(t.css, "none");
    assert.deepEqual(t.element, rect);
    assert.deepEqual(t.matrix, [1, 0, 0, 1, 3, 4]);
  });

  test("Konva's mirror is scaleX at none and 180, scaleY at 90 and 270, since it scales before it turns", () => {
    const rect = { x: 0, y: 0, width: 9, height: 16 };
    const at = (turn: 0 | 90 | 180 | 270) => videoPlacement(rect, { ...(turn ? { turn } : {}), mirror: true });
    assert.deepEqual([at(0).scaleX, at(0).scaleY, at(180).scaleX, at(180).scaleY], [-1, 1, -1, 1]);
    assert.deepEqual([at(90).scaleX, at(90).scaleY, at(270).scaleX, at(270).scaleY], [1, -1, 1, -1]);
    assert.deepEqual([at(90).rotation, at(270).rotation], [90, 270]);
  });

  test("the Library viewer of the 90 fixture: the 640 × 360 element turns onto the 360 × 640 page box", () => {
    const video = { ...FACTS, widthPx: 640, heightPx: 360, turn: 90 as const };
    const drawn = drawnSize(video);
    const page = { x: 10, y: 20, width: drawn.widthPx, height: drawn.heightPx };
    assert.deepEqual([page.width, page.height], [360, 640]);
    const t = placementTransform({ x: page.x, y: page.y, width: page.width, height: page.height }, video);
    assert.deepEqual(t.element, { x: 10 - 140, y: 20 + 140, width: 640, height: 360 });
    assert.equal(t.css, "matrix(0, 1, -1, 0, 0, 0)");
    const corners = [cssAt(t.element, t.css, 0, 0), cssAt(t.element, t.css, 640, 360)];
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    assert.deepEqual([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], [10, 20, 370, 660], "its box on screen is the page box");
    // The frame's top-left corner shows at the page's top-right, as a clockwise quarter turn puts it.
    assert.deepEqual(cssAt(t.element, t.css, 0, 0), [370, 20]);
  });
});
