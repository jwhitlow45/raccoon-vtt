import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { detectGrid, type GridDetection } from "./detect.ts";
import { drawMap, toRgba, type SynthMap } from "./synthetic.ts";

// Every map here is drawn by code (synthetic.ts): noise, patterns and a
// grid of known size and offset. The wider evaluation, with textures and
// openly licensed real maps, is in docs/design-v1-grid-detect.md.
const W = 760;
const H = 600;
const ART = [{ kind: "noise" as const, scale: 40, amp: 60 }];

function map(spec: Partial<SynthMap>): SynthMap {
  return { width: W, height: H, seed: 7, art: ART, noise: 4, ...spec };
}

/** The distance between two positions on a repeating grid. */
function apart(a: number, b: number, period: number): number {
  const t = (((a - b) % period) + period) % period;
  return Math.min(t, period - t);
}

function assertGrid(r: GridDetection, cell: number, origin: { x: number; y: number }) {
  assert.ok(r.found, `no grid found: ${JSON.stringify(r)}`);
  assert.ok(Math.abs(r.cellPx - cell) / cell < 0.005, `cellPx ${r.cellPx} is not ${cell}`);
  assert.ok(apart(r.originPx.x, origin.x, cell) < 0.5, `origin x ${r.originPx.x} is not ${origin.x}`);
  assert.ok(apart(r.originPx.y, origin.y, cell) < 0.5, `origin y ${r.originPx.y} is not ${origin.y}`);
}

function assertNone(r: GridDetection) {
  assert.equal(r.found, false, r.found ? `found ${r.cellPx} px squares at ${JSON.stringify(r.originPx)}` : "");
}

describe("finding a map's drawn grid", () => {
  test("squares a fraction of a pixel wide, lines off the image's edge", () => {
    const r = detectGrid(drawMap(map({ grid: { cellPx: 47.3, origin: { x: 13.4, y: 29.8 } } })));
    assertGrid(r, 47.3, { x: 13.4, y: 29.8 });
    assert.ok(r.found && r.confidence >= 0.6);
  });

  test("RGBA pixels, as a canvas hands them over, give the same grid", () => {
    const gray = drawMap(map({ grid: { cellPx: 52, origin: { x: 20, y: 7 } } }));
    assertGrid(detectGrid(toRgba(gray)), 52, { x: 20, y: 7 });
  });

  test("light lines on dark art", () => {
    const r = detectGrid(drawMap(map({ base: 60, grid: { cellPx: 40, origin: { x: 5, y: 33 }, gray: 255, opacity: 0.3 } })));
    assertGrid(r, 40, { x: 5, y: 33 });
    assert.ok(r.found && r.polarity === "light");
  });

  test("a faint grid under busy art", () => {
    const r = detectGrid(drawMap(map({ art: [{ kind: "noise", scale: 20, amp: 110 }], grid: { cellPx: 38.5, origin: { x: 11, y: 2 }, opacity: 0.08 }, noise: 8 })));
    assertGrid(r, 38.5, { x: 11, y: 2 });
  });

  test("a grid drawn only on the floor of rooms", () => {
    const r = detectGrid(drawMap(map({ art: [...ART, { kind: "rooms", count: 4, wall: 5 }], grid: { cellPx: 36, origin: { x: 9, y: 21 }, floorOnly: true, opacity: 0.4 } })));
    assertGrid(r, 36, { x: 9, y: 21 });
  });

  test("a grid inside a margin, its first line well in from the edge", () => {
    const r = detectGrid(drawMap(map({ grid: { cellPx: 44, origin: { x: 90, y: 70 }, within: { x: 90, y: 70, w: 572, h: 440 } } })));
    assertGrid(r, 44, { x: 90, y: 70 });
    assert.ok(r.found && Math.abs(r.across.from - 90) < 1 && Math.abs(r.down.from - 70) < 1);
  });

  test("dashed lines", () => {
    assertGrid(detectGrid(drawMap(map({ grid: { cellPx: 50, origin: { x: 31, y: 12 }, dash: 5 } }))), 50, { x: 31, y: 12 });
  });

  test("the grid, not the floor tiles half a square wide under it", () => {
    const art = [...ART, { kind: "tiles" as const, size: 30, grout: 1.5, depth: 25 }];
    assertGrid(detectGrid(drawMap(map({ art, grid: { cellPx: 60, origin: { x: 0, y: 0 }, opacity: 0.6, width: 2 } }))), 60, { x: 0, y: 0 });
  });

  test("no grid on art without one", () => {
    assertNone(detectGrid(drawMap(map({ art: [{ kind: "noise", scale: 30, amp: 100 }], noise: 6 }))));
  });

  test("no grid on JPEG-like blocks of 8 px", () => {
    assertNone(detectGrid(drawMap(map({ noise: 3, blocks: 8 }))));
  });

  test("no grid on staggered bricks, whose joints stop at every course", () => {
    assertNone(detectGrid(drawMap(map({ art: [{ kind: "bricks", width: 60, height: 30, depth: 50 }] }))));
  });

  test("no grid on staggered planks", () => {
    assertNone(detectGrid(drawMap(map({ art: [{ kind: "planks", height: 28, length: 170, depth: 45 }] }))));
  });

  test("no grid on a hex grid, which the app does not have", () => {
    assertNone(detectGrid(drawMap(map({ art: [...ART, { kind: "hex", size: 30, depth: 80, width: 1.5 }] }))));
  });

  test("no grid when the grid is turned on the map", () => {
    assertNone(detectGrid(drawMap(map({ grid: { cellPx: 50, origin: { x: 0, y: 0 }, rotate: 3 } }))));
  });

  test("no grid when the squares are taller than they are wide", () => {
    const r = detectGrid(drawMap(map({ grid: { cellPx: 50, cellPxY: 60, origin: { x: 0, y: 0 } } })));
    assertNone(r);
  });

  test("a size from the file name agrees, and the image says where the lines fall", () => {
    const r = detectGrid(drawMap(map({ grid: { cellPx: 45, origin: { x: 17, y: 3 } } })), { hintCellPx: 45 });
    assertGrid(r, 45, { x: 17, y: 3 });
    assert.ok(r.found && r.hint === "agrees");
  });

  test("a size from the file name that the image does not bear out loses to the drawn grid", () => {
    const r = detectGrid(drawMap(map({ grid: { cellPx: 45, origin: { x: 17, y: 3 } } })), { hintCellPx: 90 });
    assertGrid(r, 45, { x: 17, y: 3 });
    assert.ok(r.found && r.hint === "differs");
  });

  test("an image too small for a grid", () => {
    assert.deepEqual(detectGrid(drawMap({ width: 50, height: 40, seed: 1, art: ART })), { found: false, reason: "small" });
  });
});
