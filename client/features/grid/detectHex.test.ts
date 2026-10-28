import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { HexOrient } from "#shared/rules/hex.ts";
import { boxSides, HEX_BOX_DEPTH } from "./calibrate.ts";
import { detectGrid, MIN_CONFIDENCE, type GridDetection, type Pixels } from "./detect.ts";
import { detectHex, pickShape, type HexDetection } from "./detectHex.ts";
import { drawMap, toRgba, type SynthHexGrid, type SynthMap } from "./synthetic.ts";

// Every map here is drawn by code (synthetic.ts). The wider evaluation,
// with JPEG copies and openly licensed real maps, is in
// docs/design-v1-grid-detect.md, Hex grids.
const W = 760;
const H = 600;
const ART = [{ kind: "noise" as const, scale: 40, amp: 60 }];
const S = Math.sqrt(3) / 2;

function map(spec: Partial<SynthMap>): SynthMap {
  return { width: W, height: H, seed: 7, art: ART, noise: 4, ...spec };
}

function hexes(orient: HexOrient, cellPx: number, center: { x: number; y: number }, extra: Partial<SynthHexGrid> = {}): SynthHexGrid {
  return { orient, cellPx, center, ...extra };
}

/** The distance from a point to the nearest center of a drawn hex grid, px. */
function offCenter(g: SynthHexGrid, p: { x: number; y: number }): number {
  const [u, v] = g.orient === "rows" ? [p.x - g.center.x, p.y - g.center.y] : [p.y - g.center.y, p.x - g.center.x];
  const row = S * g.cellPx;
  let best = Infinity;
  for (let j = Math.round(v / row) - 1; j <= Math.round(v / row) + 1; j++) {
    const shift = (((j % 2) + 2) % 2) * (g.cellPx / 2);
    const i = Math.round((u - shift) / g.cellPx);
    for (let k = i - 1; k <= i + 1; k++) best = Math.min(best, Math.hypot(u - shift - k * g.cellPx, v - j * row));
  }
  return best;
}

function assertHexes(r: HexDetection, g: SynthHexGrid) {
  assert.ok(r.found, `no hexes found: ${JSON.stringify(r)}`);
  assert.equal(r.orient, g.orient);
  assert.ok(Math.abs(r.cellPx - g.cellPx) / g.cellPx < 0.005, `cellPx ${r.cellPx} is not ${g.cellPx}`);
  assert.ok(offCenter(g, r.center) < 0.5, `center ${JSON.stringify(r.center)} is ${offCenter(g, r.center)} px off a hex center`);
}

function assertNone(r: HexDetection) {
  assert.equal(r.found, false, r.found ? `found ${r.orient} of ${r.cellPx} px at ${JSON.stringify(r.center)}` : "");
}

/** The image squeezed down by `k`, as a picture resized out of proportion: its hexes are no longer regular. */
function stretched(px: Pixels, k: number): Pixels {
  const height = Math.round(px.height / k);
  const out = new Uint8Array(px.width * height);
  for (let y = 0; y < height; y++) {
    const sy = (y + 0.5) * k - 0.5;
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(px.height - 1, y0 + 1);
    const t = sy - y0;
    for (let x = 0; x < px.width; x++) out[y * px.width + x] = Math.round(px.data[y0 * px.width + x]! * (1 - t) + px.data[y1 * px.width + x]! * t);
  }
  return { width: px.width, height, data: out, channels: 1 };
}

/**
 * Lines in the three directions of a hex grid's sides, running on through
 * every hex: a triangle grid. `shift` moves the last family's lines along
 * its normal, so the three no longer cross at common points. `strength`
 * is how much a line darkens what is under it.
 */
function triangles(px: Pixels, cell: number, shift = 0, orient: HexOrient = "rows", strength = 0.5): Pixels {
  const p = cell / 2;
  const out = new Uint8Array(px.data);
  for (let y = 0; y < px.height; y++) {
    for (let x = 0; x < px.width; x++) {
      const [a, b] = orient === "rows" ? [x + 0.5, y + 0.5] : [y + 0.5, x + 0.5];
      const near = Math.min(...[a, -0.5 * a + S * b, 0.5 * a + S * b + shift].map((u) => Math.abs(u - p * Math.round(u / p))));
      const cover = Math.min(1, Math.max(0, 1.25 - near)) * strength;
      out[y * px.width + x] = Math.round(out[y * px.width + x]! * (1 - cover));
    }
  }
  return { ...px, data: out };
}

describe("finding a map's drawn hex grid", () => {
  test("hex rows a fraction of a pixel wide, the first center off the image's edge", () => {
    const g = hexes("rows", 47.3, { x: 13.4, y: 29.8 });
    const r = detectHex(drawMap(map({ hexGrid: g })), { orient: "rows" });
    assertHexes(r, g);
    assert.ok(r.found && r.confidence >= 0.6, "a clean grid is sure");
  });

  test("hex columns, read as rows with x and y swapped", () => {
    const g = hexes("columns", 61.7, { x: 40.2, y: 5.5 });
    assertHexes(detectHex(drawMap(map({ hexGrid: g })), { orient: "columns" }), g);
  });

  test("the box is Line up grid's: 3 by 2.89 cells on rows, 2.89 by 3 on columns, its middle on the hex found", () => {
    for (const orient of ["rows", "columns"] as const) {
      const g = hexes(orient, 52.4, { x: 21, y: 9 });
      const r = detectHex(drawMap(map({ hexGrid: g })), { orient });
      assert.ok(r.found);
      assert.ok(Math.abs(r.box.size - 3 * r.cellPx) < 1e-9);
      const { w, h } = boxSides(r.box, { shape: "hex", orient });
      assert.ok(Math.abs(Math.min(w, h) / Math.max(w, h) - HEX_BOX_DEPTH) < 1e-12);
      assert.equal(orient === "rows" ? w > h : h > w, true, `${orient}: the long side runs along the rows`);
      const mid = { x: r.box.x + w / 2, y: r.box.y + h / 2 };
      assert.ok(Math.hypot(mid.x - r.center.x, mid.y - r.center.y) < 1e-9);
      assert.ok(offCenter(g, mid) < 0.5);
      assert.ok(r.box.x >= 0 && r.box.y >= 0 && r.box.x + w <= W && r.box.y + h <= H, "the box lies on the map");
      assert.ok(Math.hypot(r.center.x - W / 2, r.center.y - H / 2) <= r.cellPx * 0.58, "the hex nearest the map's middle");
    }
  });

  test("RGBA pixels, as a canvas hands them over, give the same hexes", () => {
    const g = hexes("rows", 38, { x: 7, y: 11 });
    const px = drawMap(map({ hexGrid: g }));
    const a = detectHex(px, { orient: "rows" });
    const b = detectHex(toRgba(px), { orient: "rows" });
    assert.ok(a.found && b.found);
    assert.equal(a.cellPx, b.cellPx);
    assert.deepEqual(a.center, b.center);
  });

  test("light lines on dark art", () => {
    const g = hexes("columns", 44, { x: 3, y: 17 }, { gray: 235, opacity: 0.5 });
    const r = detectHex(drawMap(map({ base: 70, hexGrid: g })), { orient: "columns" });
    assertHexes(r, g);
    assert.ok(r.found && r.polarity === "light");
  });

  test("a faint grid under busy art, thin lines and thick", () => {
    for (const width of [1, 3]) {
      const g = hexes("rows", 57.5, { x: 30, y: 2 }, { opacity: 0.2, width });
      assertHexes(detectHex(drawMap(map({ art: [{ kind: "noise", scale: 30, amp: 80 }], hexGrid: g })), { orient: "rows" }), g);
    }
  });

  test("lines wider than the line filter's reach, found on a second look at half the size", () => {
    for (const width of [7, 9]) {
      const g = hexes("rows", 70, { x: 9, y: 4 }, { width, opacity: 0.6 });
      const r = detectHex(drawMap(map({ hexGrid: g })), { orient: "rows" });
      assert.ok(r.found && Math.abs(r.cellPx - 70) / 70 < 0.005 && offCenter(g, r.center) < 1, `width ${width}: ${JSON.stringify(r.found ? [r.cellPx, r.center] : r)}`);
    }
  });

  test("small hexes and large ones", () => {
    for (const cell of [16.3, 20, 150]) {
      const g = hexes("rows", cell, { x: 4, y: 9 });
      assertHexes(detectHex(drawMap(map({ hexGrid: g })), { orient: "rows" }), g);
    }
  });

  test("hexes drawn only on the floor of rooms", () => {
    const g = hexes("columns", 40, { x: 12, y: 30 }, { floorOnly: true, opacity: 0.6 });
    assertHexes(detectHex(drawMap(map({ art: [...ART, { kind: "rooms", count: 5, wall: 6 }], hexGrid: g })), { orient: "columns" }), g);
  });

  test("the older hex art of synthetic.ts is hex rows of its corner radius times the square root of 3", () => {
    const r = detectHex(drawMap(map({ art: [...ART, { kind: "hex", size: 30, depth: 80, width: 1.5 }] })), { orient: "rows" });
    assertHexes(r, hexes("rows", 30 * Math.sqrt(3), { x: 0, y: 0 }));
  });

  test("no hexes for the other orientation: hex rows are not hex columns", () => {
    const rows = drawMap(map({ hexGrid: hexes("rows", 50, { x: 0, y: 0 }) }));
    const columns = drawMap(map({ hexGrid: hexes("columns", 50, { x: 0, y: 0 }) }));
    assertNone(detectHex(rows, { orient: "columns" }));
    assertNone(detectHex(columns, { orient: "rows" }));
  });

  test("never hexes on a square grid, at any size against the hexes'", () => {
    for (const cellPx of [25, 40, 50, 86.6]) {
      const px = drawMap(map({ grid: { cellPx, origin: { x: 6, y: 13 } } }));
      assert.ok(detectGrid(px).found, `the squares of ${cellPx} px are there`);
      for (const orient of ["rows", "columns"] as const) assertNone(detectHex(px, { orient }));
    }
  });

  test("never squares on a hex grid", () => {
    for (const orient of ["rows", "columns"] as const) {
      for (const cellPx of [30, 50, 75]) assert.equal(detectGrid(drawMap(map({ hexGrid: hexes(orient, cellPx, { x: 5, y: 5 }) }))).found, false);
    }
  });

  test("no hexes in lines that run on through them: a triangle grid", () => {
    for (const cell of [40, 55, 60, 66, 90]) {
      const px = triangles(drawMap(map({})), cell);
      for (const orient of ["rows", "columns"] as const) {
        const r = detectHex(px, { orient });
        assertNone(r);
        if (orient === "rows" && cell === 60) assert.equal(!r.found && r.failed, "lines run on through the hexes");
      }
    }
    // Their crossings stand in rows in the other orientation's directions, dots a hex's side apart.
    for (const drawn of ["rows", "columns"] as const) {
      const px = triangles(drawMap(map({ width: 1400, height: 1000 })), 109, 0, drawn);
      for (const orient of ["rows", "columns"] as const) assertNone(detectHex(px, { orient }));
    }
  });

  test("no hexes in three directions of lines that never meet at the same points", () => {
    const r = detectHex(triangles(drawMap(map({})), 60, 15), { orient: "rows" });
    assert.equal(!r.found && r.failed, "sides do not meet as hexes");
  });

  test("no hexes when the picture was resized out of proportion, since the app's hexes are regular", () => {
    const px = stretched(drawMap(map({ height: 630, hexGrid: hexes("columns", 50, { x: 0, y: 0 }) })), 1.05);
    assert.equal(px.height, H);
    const r = detectHex(px, { orient: "columns" });
    assert.equal(!r.found && r.failed, "sides of different sizes");
  });

  test("hexes 1.1% out of shape answer no grid and 0.9% are found, at every hex size and both orientations", () => {
    for (const orient of ["rows", "columns"] as const) {
      for (const [cell, width, height] of [[60, W, H], [100, W, H], [150, 1200, 900]] as const) {
        // Squeezed and stretched down the map, which is across the hex rows and along the hex columns.
        for (const k of [1.011, 0.989, 1.009, 0.991]) {
          const drawn = drawMap(map({ width, height: Math.round(height * k), hexGrid: hexes(orient, cell, { x: width / 2, y: height / 2 }) }));
          const r = detectHex(stretched(drawn, k), { orient });
          const label = `${orient}, ${cell} px, ${k}: ${r.found ? `found at ${r.confidence.toFixed(2)}` : r.failed}`;
          if (Math.abs(k - 1) > 0.01) assert.equal(!r.found && r.failed, "hexes out of shape", label);
          else assert.ok(r.found, label);
        }
      }
    }
  });

  test("a find whose sides barely break at the corners is refused under the cutoff, and looked for again at half size", () => {
    const g = hexes("rows", 60, { x: 0, y: 0 }, { opacity: 0.5 });
    for (const strength of [0.25, 0.27]) {
      const seen: { confidence: number; failed: string | null }[] = [];
      const r = detectHex(triangles(drawMap(map({ hexGrid: g })), 60, 0, "rows", strength), { orient: "rows", onCandidate: (c) => seen.push(c) });
      assertHexes(r, g);
      assert.ok(r.found && r.confidence >= MIN_CONFIDENCE, `${strength}: never a find under the cutoff`);
      for (const c of seen) assert.ok(c.failed !== null || c.confidence >= MIN_CONFIDENCE);
      if (strength === 0.27) {
        assert.ok(seen.some((c) => c.failed === "low confidence"), "the first look's finds fall under the cutoff");
        assert.ok(r.found && r.confidence >= 0.6, "the second look finds the hexes cleanly");
      }
    }
  });

  test("of several finds, the surest after the look along the lines", () => {
    const seen: { confidence: number; failed: string | null }[] = [];
    const r = detectHex(drawMap(map({ hexGrid: hexes("rows", 90, { x: 3, y: 5 }, { width: 2 }) })), { orient: "rows", onCandidate: (c) => seen.push(c) });
    const finds = seen.filter((c) => c.failed === null).map((c) => c.confidence);
    assert.ok(finds.length >= 2 && new Set(finds).size >= 2, "the pool holds finds of different confidence");
    assert.ok(r.found && r.confidence === Math.max(...finds));
  });

  test("the center found is the hex center nearest the map's middle, which may be in the next row", () => {
    const g = hexes("rows", 60, { x: 20, y: 20 });
    const r = detectHex(drawMap(map({ hexGrid: g })), { orient: "rows" });
    assert.ok(r.found);
    let nearest = Infinity;
    for (let j = -2; j < 14; j++) for (let i = -2; i < 16; i++) nearest = Math.min(nearest, Math.hypot(20 + (i + (j % 2) / 2) * 60 - W / 2, 20 + j * S * 60 - H / 2));
    assert.ok(Math.abs(Math.hypot(r.center.x - W / 2, r.center.y - H / 2) - nearest) < 0.5, `${JSON.stringify(r.center)} is not the nearest, ${nearest.toFixed(2)} px from the middle`);
  });

  test("no hexes on art without them", () => {
    const arts: Partial<SynthMap>[] = [
      {},
      { noise: 3, blocks: 8 },
      { art: [{ kind: "bricks", width: 60, height: 30, depth: 50 }] },
      { art: [{ kind: "planks", height: 28, length: 170, depth: 45 }] },
      { art: [{ kind: "tiles", size: 50, grout: 2, depth: 40 }] },
      { art: [{ kind: "checker", size: 40, amp: 30 }] },
    ];
    for (const a of arts) for (const orient of ["rows", "columns"] as const) assertNone(detectHex(drawMap(map(a)), { orient }));
  });

  test("no hexes when the grid is turned on the map, which the app cannot follow", () => {
    assertNone(detectHex(drawMap(map({ hexGrid: hexes("rows", 50, { x: 0, y: 0 }, { rotate: 2 }) })), { orient: "rows" }));
    // A third of a degree moves the lines about 4 px across this map: every other check passes.
    const r = detectHex(drawMap(map({ hexGrid: hexes("rows", 50, { x: 0, y: 0 }, { rotate: 0.35 }) })), { orient: "rows" });
    assert.equal(!r.found && r.failed, "lines turned");
  });

  test("a thick grid turned a third of a degree is refused on the second look too, by the same 3 px across the map", () => {
    const r = detectHex(drawMap(map({ hexGrid: hexes("rows", 70, { x: 9, y: 4 }, { width: 8, opacity: 0.6, rotate: 0.3 }) })), { orient: "rows" });
    assertNone(r);
  });

  test("hexes turned a hair, their lines within 3 px across the map, are found", () => {
    const g = hexes("rows", 60, { x: 380, y: 300 }, { rotate: 0.2 });
    assertHexes(detectHex(drawMap(map({ hexGrid: g })), { orient: "rows" }), g);
  });

  test("squares drawn over a floor of hex tiles are squares: both finders see a grid, the surer wins and is only offered", () => {
    const px = drawMap(map({ art: [...ART, { kind: "hex", size: 30, depth: 60, width: 1.5 }], grid: { cellPx: 70, origin: { x: 10, y: 20 }, opacity: 0.6 } }));
    const squares = detectGrid(px);
    const rows = detectHex(px, { orient: "rows" });
    const columns = detectHex(px, { orient: "columns" });
    assert.ok(squares.found && Math.abs(squares.cellPx - 70) < 0.5, "the drawn squares");
    assert.ok(rows.found && Math.abs(rows.cellPx - 30 * Math.sqrt(3)) < 0.5, "the hex tiles read as hexes");
    assert.ok(squares.found && rows.found && squares.confidence > rows.confidence);
    assert.deepEqual(pickShape(squares, rows, columns), { shape: "squares", confidence: squares.confidence, contested: true });
  });

  test("the shape picked: the surest find, contested whenever another shape was found too", () => {
    const none: GridDetection = { found: false, reason: "none" };
    const noHex: HexDetection = { found: false, reason: "none" };
    const sq = (confidence: number) => ({ ...(detectGrid(drawMap(map({ grid: { cellPx: 50, origin: { x: 0, y: 0 } } }))) as Extract<GridDetection, { found: true }>), confidence });
    const hx = (confidence: number) => ({ ...(detectHex(drawMap(map({ hexGrid: hexes("rows", 50, { x: 0, y: 0 }) })), { orient: "rows" }) as Extract<HexDetection, { found: true }>), confidence });
    assert.equal(pickShape(none, noHex, noHex), null);
    assert.deepEqual(pickShape(none, hx(0.9), noHex), { shape: "hexRows", confidence: 0.9, contested: false });
    assert.deepEqual(pickShape(sq(0.7), noHex, noHex), { shape: "squares", confidence: 0.7, contested: false });
    assert.deepEqual(pickShape(sq(0.7), noHex, hx(0.8)), { shape: "hexColumns", confidence: 0.8, contested: true });
    assert.deepEqual(pickShape(sq(0.9), hx(0.4), noHex), { shape: "squares", confidence: 0.9, contested: true });
  });

  test("an image too small for hexes", () => {
    assert.deepEqual(detectHex(drawMap(map({ width: 60, height: 60 })), { orient: "rows" }), { found: false, reason: "small" });
  });
});
