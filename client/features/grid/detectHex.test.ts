import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { HexOrient } from "#shared/rules/hex.ts";
import { boxSides, HEX_BOX_DEPTH } from "./calibrate.ts";
import { detectGrid, MIN_CONFIDENCE, type GridDetection, type Pixels } from "./detect.ts";
import { detectHex, pickShape, UNCHECKED_MAX, type HexDetection } from "./detectHex.ts";
import { HIGH_CONFIDENCE } from "./findGrid.ts";
import { drawMap, rng, toRgba, type SynthHexGrid, type SynthMap } from "./synthetic.ts";

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

/** The image squeezed across by `k`, as `stretched` squeezes it down. */
function stretchedAcross(px: Pixels, k: number): Pixels {
  const width = Math.round(px.width / k);
  const out = new Uint8Array(width * px.height);
  for (let x = 0; x < width; x++) {
    const sx = (x + 0.5) * k - 0.5;
    const x0 = Math.max(0, Math.floor(sx));
    const x1 = Math.min(px.width - 1, x0 + 1);
    const t = sx - x0;
    for (let y = 0; y < px.height; y++) out[y * width + x] = Math.round(px.data[y * px.width + x0]! * (1 - t) + px.data[y * px.width + x1]! * t);
  }
  return { width, height: px.height, data: out, channels: 1 };
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

  test("lines wider still, missed at full and half size, found on a third look at a quarter of the size (D-261029-51)", () => {
    // Lines 14 and 18 px wide on 100 px hexes: past the filter's reach at half size too, as the Trebia map's are at 4096 px.
    for (const width of [14, 18]) {
      for (const orient of ["rows", "columns"] as const) {
        const g = hexes(orient, 100, { x: 9, y: 4 }, { width, opacity: 0.6 });
        const looks: number[] = [];
        const r = detectHex(drawMap(map({ width: 1520, height: 1200, hexGrid: g })), { orient, onLook: (k) => looks.push(k) });
        assert.deepEqual(looks, [1, 2, 4], `width ${width}, ${orient}: the first two looks miss them`);
        assert.ok(r.found && Math.abs(r.cellPx - 100) / 100 < 0.005 && offCenter(g, r.center) < 1, `width ${width}, ${orient}: ${JSON.stringify(r.found ? [r.cellPx, r.center] : r)}`);
        // Measured again at half size, a find stands as that measure says. One the half size cannot see is only offered.
        assert.ok(r.found && (r.checked ? r.confidence >= MIN_CONFIDENCE : r.confidence <= UNCHECKED_MAX), `width ${width}, ${orient}: ${r.found ? r.confidence : ""}`);
      }
    }
    // On 1300 by 1000 the first look reads these lines' sides at different sizes, as the Trebia map's first look does, and the third still finds them.
    const g = hexes("rows", 100, { x: 9, y: 4 }, { width: 14, opacity: 0.6 });
    const r = detectHex(drawMap(map({ width: 1300, height: 1000, hexGrid: g })), { orient: "rows" });
    assert.ok(r.found && Math.abs(r.cellPx - 100) / 100 < 0.005, JSON.stringify(r.found ? r.cellPx : r));
  });

  test("a third look's find is measured again at half size: hexes 1.1% out of shape are refused, a sure find applies, and one the half size cannot see is only offered (D-261029-55)", () => {
    // Astra's fixture (review FU35B-ASTRA-03): 150 px hex rows of 18 px lines squeezed 1.1%, which the quarter size alone took at 0.83.
    const tall = drawMap(map({ height: Math.round(H * 1.011), hexGrid: hexes("rows", 150, { x: 380, y: 300 }, { width: 18, opacity: 0.6 }) }));
    const looks: number[] = [];
    const r = detectHex(stretched(tall, 1.011), { orient: "rows", onLook: (k) => looks.push(k) });
    assert.deepEqual(looks, [1, 2, 4]);
    assert.equal(!r.found && r.failed, "hexes out of shape");
    // Round 2's fixtures: 100 px hex rows squeezed 1.1%, which the half measure reads 0.64% and 0.96% off a 300 px frame. Too near the limit to apply.
    for (const width of [14, 18]) {
      const squeezed = drawMap(map({ height: Math.round(H * 1.011), hexGrid: hexes("rows", 100, { x: 9, y: 4 }, { width, opacity: 0.6 }) }));
      const near = detectHex(stretched(squeezed, 1.011), { orient: "rows" });
      assert.ok(!near.found || (!near.checked && near.confidence <= UNCHECKED_MAX), `width ${width}: ${JSON.stringify(near.found ? [near.confidence, near.checked] : near)}`);
    }
    const at = (width: number, orient: HexOrient) => detectHex(drawMap(map({ width: 1520, height: 1200, hexGrid: hexes(orient, 100, { x: 9, y: 4 }, { width, opacity: 0.6 }) })), { orient });
    const sure = at(18, "columns");
    assert.ok(sure.found && sure.checked && sure.confidence >= HIGH_CONFIDENCE, `measured at half size: ${JSON.stringify(sure.found ? [sure.confidence, sure.checked] : sure)}`);
    const unseen = at(14, "rows");
    assert.ok(unseen.found && !unseen.checked && unseen.confidence <= UNCHECKED_MAX, `the half size cannot measure these: ${JSON.stringify(unseen.found ? [unseen.confidence, unseen.checked] : unseen)}`);
  });

  test("a third look's find applies by itself only on a half frame 600 px down or more, its stretch under the limit by more than the measure's error (review FU35B-ASTRA-03, round 3, D-261029-151)", () => {
    const offered = (r: HexDetection, what: string) => assert.ok(!r.found || (!r.checked && r.confidence <= UNCHECKED_MAX), `${what}: ${JSON.stringify(r.found ? [r.confidence, r.checked] : r)}`);
    // Astra's fixture: 100 px hex columns from (85.85, 18.55), 14 px lines, drawn 1.1% too tall on 760 by 593. The half measure read 0.2% and applied it at 0.73.
    const looks: number[] = [];
    const tall = drawMap(map({ height: 593, hexGrid: hexes("columns", 100, { x: 85.85, y: 18.55 }, { width: 14, opacity: 0.6 }) }));
    offered(detectHex(stretched(tall, 0.989), { orient: "columns", onLook: (k) => looks.push(k) }), "astra's");
    assert.deepEqual(looks, [1, 2, 4]);
    // Regular hexes on a half frame 629 px across and 458 px down, measured as regular: under 600 px down the frame decides (the floor).
    offered(detectHex(drawMap(map({ width: 1259, height: 916, seed: 98029, hexGrid: hexes("rows", 133.5, { x: 74.1, y: 259.2 }, { width: 16.2, opacity: 0.56 }) })), { orient: "rows" }), "a 458 px frame");
    // Regular hexes on a 1600 px frame read 0.47% out of shape, their lines' leans scattered: two standard errors reach the limit.
    offered(detectHex(drawMap(map({ width: 3200, height: 1179, seed: 76917, hexGrid: hexes("columns", 197.2, { x: 345.5, y: 2.2 }, { width: 15.8, opacity: 0.6 }) })), { orient: "columns" }), "scattered leans");
    // Hexes 0.9% out of shape on a 1230 px frame read 0.92%, their leans close together: a pixel's error over half the frame reaches the limit.
    const near = drawMap(map({ width: 1664, height: Math.round(2461 * 1.009), seed: 32831, hexGrid: hexes("rows", 269.8, { x: 165.5, y: 240.5 }, { width: 18.8, opacity: 0.78 }) }));
    offered(detectHex(stretched(near, 1.009), { orient: "rows" }), "a pixel from the limit");
    // A small seeded sweep of the kind that proved it (both orientations, so both of the frame's axes, squeezed and stretched, 1.0 to 1.3%):
    // no third-look find of hexes out of shape applies.
    const random = rng(151);
    let third = 0;
    for (let i = 0; i < 10; i++) {
      const width = Math.round(1200 + 250 * random());
      const height = Math.round(1200 + 250 * random());
      const orient = random() < 0.5 ? "rows" : "columns";
      const cell = Math.min(width, height) / (5 + 4 * random());
      const k = 1 + (random() < 0.5 ? 1 : -1) * (0.01 + 0.003 * random());
      const g = hexes(orient, cell, { x: 2 * cell * random(), y: 2 * cell * random() }, { width: cell * (0.08 + 0.08 * random()), opacity: 0.45 + 0.35 * random() });
      const seen: number[] = [];
      const r = detectHex(stretched(drawMap(map({ width, height: Math.round(height * k), seed: 1 + Math.floor(100000 * random()), hexGrid: g })), k), { orient, onLook: (q) => seen.push(q) });
      if (seen.at(-1) !== 4) continue;
      third++;
      assert.ok(!r.found || r.confidence < HIGH_CONFIDENCE, `${i}: ${width} x ${height} ${orient}, ${k}: ${r.found ? r.confidence : ""}`);
    }
    assert.ok(third >= 3, `${third} reached the third look`);
  });

  test("every look holds a stretch within its measure's error of the limit as not measured, so hexes 1.0 to 1.1% out of shape are only offered on the first and second looks too (FU35B-HALF-MARGIN)", () => {
    const offered = (r: HexDetection, what: string) => assert.ok(!r.found || (!r.checked && r.confidence <= UNCHECKED_MAX), `${what}: ${JSON.stringify(r.found ? [r.confidence, r.checked] : r)}`);
    // Runs of round 3's sweep that applied at 0.67 to 0.82 without it: drawn out of proportion down the image (y) or across it (x), then resized to its size.
    const runs = [
      { width: 760, height: 593, k: 0.98976, axis: "y", seed: 6189, looks: [1], g: hexes("rows", 90.99, { x: 96.16, y: 143.57 }, { width: 6.05, opacity: 0.686 }) },
      { width: 760, height: 600, k: 1.010314, axis: "x", seed: 55991, looks: [1], g: hexes("columns", 73.028, { x: 100.832, y: 105.781 }, { width: 5.265, opacity: 0.787 }) },
      { width: 593, height: 760, k: 1.010325, axis: "y", seed: 57633, looks: [1, 2], g: hexes("rows", 108.977, { x: 125.439, y: 12.086 }, { width: 10.027, opacity: 0.69 }) },
      { width: 700, height: 1100, k: 1.01002, axis: "x", seed: 11894, looks: [1, 2], g: hexes("columns", 70.66, { x: 17.12, y: 116.95 }, { width: 8.87, opacity: 0.768 }) },
      // Read 0.79% on a frame 852 px across and 1701 px down: a pixel over half its height is 0.12%, but its sloped lines' parts lie 254 px apart.
      { width: 1701, height: 852, k: 0.98944, axis: "x", seed: 38948, looks: [1], g: hexes("columns", 133.64, { x: 149.13, y: 158.39 }, { width: 8.17, opacity: 0.797 }) },
    ] as const;
    for (const run of runs) {
      const down = run.axis === "y";
      const drawn = drawMap(map({ width: down ? run.width : Math.round(run.width * run.k), height: down ? Math.round(run.height * run.k) : run.height, seed: run.seed, hexGrid: run.g }));
      const looks: number[] = [];
      const r = detectHex(down ? stretched(drawn, run.k) : stretchedAcross(drawn, run.k), { orient: run.g.orient, onLook: (k) => looks.push(k) });
      const what = `${run.g.orient} ${run.width} x ${run.height}, ${run.axis} ${run.k}`;
      assert.deepEqual(looks, run.looks, what);
      offered(r, what);
    }
    // Thin lines 0.9% out of shape on a 600 px frame read within a pixel's error of the limit, so they are offered where 10.2's build applied them.
    offered(detectHex(stretched(drawMap(map({ height: Math.round(H * 0.991), hexGrid: hexes("rows", 100, { x: W / 2, y: H / 2 }) })), 0.991), { orient: "rows" }), "0.9% on 600 px");
    // The same hexes drawn regular apply on the first look.
    const regular = detectHex(drawMap(map({ hexGrid: hexes("rows", 100, { x: W / 2, y: H / 2 }) })), { orient: "rows" });
    assert.ok(regular.found && regular.checked && regular.confidence >= HIGH_CONFIDENCE, JSON.stringify(regular.found ? [regular.confidence, regular.checked] : regular));
    // Regular hexes read 0.11% on a 2789 px frame, a pixel well inside the limit, but their leans scattered: two standard errors reach it.
    offered(detectHex(drawMap(map({ width: 1786, height: 2789, seed: 40903, hexGrid: hexes("rows", 180.33, { x: 167.87, y: 249.84 }, { width: 12.04, opacity: 0.584 }) })), { orient: "rows" }), "scattered leans on a first look");
  });

  test("thick lines turned a third of a degree, seen only at a quarter of the size, are refused there as in the image's own pixels", () => {
    // The lines move about 5 px across this map. A quarter of the size, the limits in pixels (the meeting point, the turn) are a quarter too.
    assertNone(detectHex(drawMap(map({ width: 1300, height: 1000, hexGrid: hexes("rows", 100, { x: 9, y: 4 }, { width: 14, opacity: 0.6, rotate: 0.3 }) })), { orient: "rows" }));
  });

  test("the third look comes only when the first two find nothing, and never after a grid seen turned or measured out of shape twice", () => {
    const looksOf = (spec: Partial<SynthMap>, orient: HexOrient, px = drawMap(map(spec))) => {
      const looks: number[] = [];
      detectHex(px, { orient, onLook: (k) => looks.push(k) });
      return looks;
    };
    assert.deepEqual(looksOf({ hexGrid: hexes("rows", 70, { x: 9, y: 4 }) }, "rows"), [1], "found on the first look");
    assert.deepEqual(looksOf({ hexGrid: hexes("rows", 70, { x: 9, y: 4 }, { width: 7, opacity: 0.6 }) }, "rows"), [1, 2], "found on the second");
    assert.deepEqual(looksOf({ hexGrid: hexes("rows", 50, { x: 0, y: 0 }, { rotate: 0.35 }) }, "rows"), [1], "seen turned");
    assert.deepEqual(looksOf({ hexGrid: hexes("rows", 70, { x: 9, y: 4 }, { width: 9, opacity: 0.6, rotate: 0.4 }) }, "rows"), [1, 2], "thick lines seen turned at half size");
    // Hexes 3.6% out of shape: the three families' sizes differ at full and at half size, so a quarter, which measures them less finely, is not asked.
    const tall = drawMap(map({ height: Math.round(H * 1.036), hexGrid: hexes("rows", 100, { x: 380, y: 300 }) }));
    assert.deepEqual(looksOf({}, "rows", stretched(tall, 1.036)), [1, 2]);
    // A gradient without lines is looked at three times.
    assert.deepEqual(looksOf({ art: [{ kind: "gradient", from: 60, to: 200 }] }, "rows"), [1, 2, 4]);
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

  test("large hexes on a small map, too few lines to measure their lean, are only offered: 1.1% out of shape at 150 px on 760 by 600", () => {
    assert.ok(UNCHECKED_MAX < HIGH_CONFIDENCE);
    for (const orient of ["rows", "columns"] as const) {
      for (const k of [1.011, 1]) {
        const drawn = drawMap(map({ height: Math.round(H * k), hexGrid: hexes(orient, 150, { x: 380, y: 300 }) }));
        const r = detectHex(k === 1 ? drawn : stretched(drawn, k), { orient });
        assert.ok(r.found, `${orient}, ${k}: the hexes are there to offer`);
        assert.ok(!r.checked && r.confidence <= UNCHECKED_MAX, `${orient}, ${k}: offered at ${r.confidence.toFixed(2)}, never applied`);
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
        // Its 380 by 300 frame cannot measure their shape to 1%: the sloped lines' parts lie under 100 px apart, so it is offered.
        assert.ok(r.found && r.confidence === UNCHECKED_MAX && !r.checked, "the second look finds the hexes");
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
