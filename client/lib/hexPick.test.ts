import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MAX_HEIGHT_FT, MIN_HEIGHT_FT } from "#shared/model.ts";
import { encodeHeights } from "#shared/rules/heights.ts";
import { cornerAt, hexAt, hexCenter, hexCorners, hexInScene, sameHex, sceneHexes, snapAnchor, type HexGrid } from "#shared/rules/hex.ts";
import { mulberry32 } from "../features/areas/volumeTesting.ts";
import { boardPickFor, DrawnHeightsMemo, pressAt, pressHit } from "../canvas/boardPick.ts";
import { dragGround, dragLanding } from "../canvas/isoDrag.ts";
import { occupiedHexes } from "#shared/rules/footprint.ts";
import { viewToScreen, type Camera, type Point } from "./camera.ts";
import { cellAtPoint, cellPolygon, groundSurface, HIT_RECONCILE, neighborOf, polygonSide, ruleBoundPoint, type GroundCell } from "./groundCells.ts";
import { isometric, pickWalk, TOP_DOWN, toView, toWorld, type DrawnHeights, type Turn, type ViewPoint } from "./view.ts";

/*
 * Hex ground for the pointer (docs/design-v1-iso-hex-relief.md 5.1 and 7):
 * canonical polygons, the walk against a direct ray and prism oracle, and
 * the handoff from a hit on a rounded edge to the rules' hexAt.
 */

const ROWS: HexGrid = { shape: "hex", orient: "rows" };
const COLUMNS: HexGrid = { shape: "hex", orient: "columns" };
const TURNS: readonly Turn[] = [0, 1, 2, 3];
const CAM: Camera = { x: 211.5, y: 97.25, scale: 37 };

describe("canonical hex polygons (5.1)", () => {
  test("on the largest scene, both orientations and both parities, every side's two corners are its neighbor's same side, point for point", () => {
    for (const grid of [ROWS, COLUMNS]) {
      const bounds = { w: 200, h: 200 };
      let sides = 0;
      for (const h of sceneHexes(grid, bounds)) {
        const poly = cellPolygon(grid, h);
        for (let d = 0; d < 6; d++) {
          const n = neighborOf(grid, h, d);
          const np = cellPolygon(grid, n);
          // Side d runs between corners d + 1 and d + 2. The neighbor's opposite side, d + 3, runs between its corners d + 4 and d + 5, the other way.
          const a = poly[(d + 1) % 6]!;
          const b = poly[(d + 2) % 6]!;
          const c = np[(d + 4) % 6]!;
          const e = np[(d + 5) % 6]!;
          if (!(a.x === e.x && a.y === e.y && b.x === c.x && b.y === c.y)) assert.fail(`${grid.orient} ${h.col},${h.row} side ${d}`);
          sides++;
        }
      }
      assert.ok(sides > 200_000);
    }
  });

  test("the cell under a point is the canonical polygon that holds it, hexAt's guess everywhere but within the rounding of an edge", () => {
    const rand = mulberry32(0x5eed);
    for (const grid of [ROWS, COLUMNS]) {
      let differ = 0;
      for (let i = 0; i < 40_000; i++) {
        const p = { x: rand() * 30, y: rand() * 30 };
        const c = cellAtPoint(grid, p);
        assert.ok(polygonSide(cellPolygon(grid, c), p) >= 0, `${grid.orient} (${p.x}, ${p.y})`);
        if (!sameHex(hexAt(grid, p), c)) {
          differ++;
          // Only where rounding to the 1/64 lattice moved the edge: within half a lattice step of the ideal boundary.
          const q = ruleBoundPoint(grid, c, p);
          assert.ok(Math.hypot(q.x - p.x, q.y - p.y) <= HIT_RECONCILE + 1e-12);
        }
      }
      assert.ok(differ > 0, "rounding does move some edges");
    }
  });

  test("a hit near a rounded edge or a corner moves toward its hex's center only as far as hexAt needs, at most 1/64 cell", () => {
    const rand = mulberry32(0x1e6);
    for (const grid of [ROWS, COLUMNS]) {
      for (let i = 0; i < 20_000; i++) {
        const cell = { col: 2 + Math.floor(rand() * 20), row: 2 + Math.floor(rand() * 20) };
        const poly = cellPolygon(grid, cell);
        // A point on the polygon's boundary or a hair inside it, near a corner or along a side.
        const k = Math.floor(rand() * 6);
        const a = poly[k]!;
        const b = poly[(k + 1) % 6]!;
        const t = rand() < 0.2 ? rand() * 0.02 : rand();
        const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        const q = ruleBoundPoint(grid, cell, p);
        assert.ok(sameHex(hexAt(grid, q), cell), `${grid.orient} ${cell.col},${cell.row} at (${p.x}, ${p.y})`);
        const moved = Math.hypot(q.x - p.x, q.y - p.y);
        assert.ok(moved <= HIT_RECONCILE + 1e-12);
        // No further than it must: past the first 1/4096 cell step, a step short of it hexAt still names the neighbor.
        if (moved > (HIT_RECONCILE / 64) * 1.01) {
          const back = (moved - (HIT_RECONCILE / 64) * 1.0001) / moved;
          const short = { x: p.x + (q.x - p.x) * back, y: p.y + (q.y - p.y) * back };
          assert.ok(!sameHex(hexAt(grid, short), cell), `${grid.orient} ${cell.col},${cell.row}: moved ${moved} where less would do`);
        }
      }
    }
  });
});

/** The oracle's polygon: hex.ts's canonical corners. */
function poly(grid: HexGrid, c: GroundCell): Point[] {
  return hexCorners(grid, c).map((k) => cornerAt(grid, k));
}

/** The parameters of a + t·d inside a convex polygon, by plain half-plane clipping. */
function clip(pts: Point[], a: Point, d: Point): [number, number] | null {
  let area = 0;
  for (let i = 0; i < pts.length; i++) area += pts[i]!.x * pts[(i + 1) % pts.length]!.y - pts[(i + 1) % pts.length]!.x * pts[i]!.y;
  const s = area > 0 ? 1 : -1;
  let lo = -1e12;
  let hi = 1e12;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    const nx = -s * (q.y - p.y);
    const ny = s * (q.x - p.x);
    const num = nx * (a.x - p.x) + ny * (a.y - p.y);
    const den = nx * d.x + ny * d.y;
    if (Math.abs(den) < 1e-15) {
      if (num < 0) return null;
      continue;
    }
    const t = -num / den;
    if (den > 0) lo = Math.max(lo, t);
    else hi = Math.min(hi, t);
  }
  return lo <= hi ? [lo, hi] : null;
}

/** The nearest prism the ray under a view point meets, every hex of the lattice around the scene tried: its height and hex, or ties. */
function rayOracle(grid: HexGrid, bounds: { w: number; h: number }, ground: (c: GroundCell) => number, turn: Turn, v: ViewPoint): { z: number; cell: GroundCell; tie: boolean } {
  const view = isometric(turn);
  const a = toWorld(view, v, 0);
  const one = toWorld(view, v, 1);
  const d = { x: one.x - a.x, y: one.y - a.y };
  const hits: { z: number; cell: GroundCell }[] = [];
  // The scene's hexes and a ring of the lattice round them, at 0, where a pit's side meets the ground past the scene.
  const pad = 3;
  let under = false;
  for (let row = -pad; row < bounds.h + pad + 3; row++) {
    for (let col = -pad; col < bounds.w + pad + 3; col++) {
      const c = { col, row };
      const pts = poly(grid, c);
      const iv = clip(pts, a, d);
      const inside = hexInScene(grid, bounds, c);
      if (inside && iv && iv[0] <= 0 && iv[1] >= 0) under = true;
      if (!iv || iv[1] - iv[0] < 1e-12) continue;
      const g = inside ? ground(c) : 0;
      const z = Math.min(g, iv[1]);
      if (z >= iv[0]) hits.push({ z, cell: c });
    }
  }
  // Everywhere past the scene's hexes the ground is 0, however far the trace runs from them.
  if (!under) hits.push({ z: 0, cell: cellAtPoint(grid, a) });
  hits.sort((p, q) => q.z - p.z);
  return { z: hits[0]!.z, cell: hits[0]!.cell, tie: hits.length > 1 && hits[1]!.z > hits[0]!.z - 1e-7 };
}

function heightsFor(grid: HexGrid, bounds: { w: number; h: number }, cells: Map<string, number>): DrawnHeights {
  const surface = groundSurface(grid, bounds, (c) => cells.get(`${c.col},${c.row}`) ?? 0);
  const values = [...cells.entries()].filter(([k]) => hexInScene(grid, bounds, { col: Number(k.split(",")[0]), row: Number(k.split(",")[1]) })).map(([, z]) => z);
  return { ...surface, low: Math.min(0, ...values), high: Math.max(0, ...values), at: (x, y) => surface.atCell({ col: x, row: y }) };
}

describe("the hex ray walk (7)", () => {
  for (const feetPerCell of [5, 1]) {
    test(`at ${feetPerCell} ft a cell, over the full supported heights, both orientations and every turn, the walk meets what a direct ray and prism oracle meets, in finitely many steps`, () => {
      const rand = mulberry32(feetPerCell === 5 ? 0x7a1 : 0x7a2);
      for (const grid of [ROWS, COLUMNS]) {
        for (let m = 0; m < 120; m++) {
          const bounds = { w: 6 + Math.floor(rand() * 14), h: 6 + Math.floor(rand() * 14) };
          const cells = new Map<string, number>();
          for (let row = -1; row < bounds.h + 3; row++) {
            for (let col = -1; col < bounds.w + 3; col++) {
              if (rand() < 0.5) continue;
              // Whole feet from the lowest to the highest a cell may hold, in cells of height.
              const feet = m % 4 === 0 ? MIN_HEIGHT_FT + Math.floor(rand() * (MAX_HEIGHT_FT - MIN_HEIGHT_FT + 1)) : Math.floor(rand() * 41) - 15;
              cells.set(`${col},${row}`, feet / feetPerCell);
            }
          }
          const heights = heightsFor(grid, bounds, cells);
          for (const turn of TURNS) {
            const view = isometric(turn);
            for (let i = 0; i < 8; i++) {
              const ground = { x: -1 + rand() * (bounds.w + 2), y: -1 + rand() * (bounds.h + 2) };
              const v = toView(view, ground, rand() * heights.high);
              const screen = viewToScreen(CAM, v);
              const hit = pickWalk({ camera: CAM, view, grid, heights }, screen);
              const want = rayOracle(grid, bounds, (c) => cells.get(`${c.col},${c.row}`) ?? 0, turn, v);
              const at = `${grid.orient} map ${m} turn ${turn} view (${v.x}, ${v.y})`;
              assert.ok(Math.abs(hit.z - want.z) < 1e-6 * Math.max(1, Math.abs(want.z)), `${at}: z ${hit.z}, the oracle's ${want.z}`);
              if (!want.tie) assert.deepEqual([hit.cell.col, hit.cell.row], [want.cell.col, want.cell.row], `${at}: hit cell`);
              // The trace crosses at most its length over the box's hexes, a hex taking at least about half a cell of it.
              const span = 2 * 0.8660254037844386 * Math.SQRT2 * (Math.max(0, heights.high) - Math.min(0, heights.low));
              assert.ok(hit.visited <= Math.min(span, 2 * (bounds.w + bounds.h)) * 3 + 8, `${at}: ${hit.visited} visited`);
            }
          }
        }
      }
    });
  }

  test("a ray through a corner moves on into the hex it enters, a face hit names the hex whose side it is, and a top hit the hex under it", () => {
    for (const grid of [ROWS, COLUMNS]) {
      const bounds = { w: 12, h: 12 };
      const target = { col: 5, row: 5 };
      const cells = new Map<string, number>([[`${target.col},${target.row}`, 2]]);
      const heights = heightsFor(grid, bounds, cells);
      for (const turn of TURNS) {
        const view = isometric(turn);
        const pts = poly(grid, target);
        // Every corner of the raised hex at 0, at 1 (on its side) and at 2 (its top's corner).
        for (const p of pts) {
          for (const z of [0, 1, 2]) {
            const v = toView(view, p, z);
            const hit = pickWalk({ camera: CAM, view, grid, heights }, viewToScreen(CAM, v));
            const want = rayOracle(grid, bounds, (c) => cells.get(`${c.col},${c.row}`) ?? 0, turn, v);
            // A ray grazing the top's own corner at its height touches both the top and what lies past it: either is the surface there.
            if (z === 2 && (Math.abs(hit.z - 2) < 1e-9 || Math.abs(hit.z - want.z) < 1e-6)) continue;
            assert.ok(Math.abs(hit.z - want.z) < 1e-6, `${grid.orient} turn ${turn} corner z ${z}: walk ${hit.z} at ${hit.cell.col},${hit.cell.row}, oracle ${want.z} at ${want.cell.col},${want.cell.row}`);
          }
        }
        // The middle of each near side at height 1 is a face hit on this hex.
        const c = hexCenter(grid, target);
        for (let k = 0; k < 6; k++) {
          const a = pts[k]!;
          const b = pts[(k + 1) % 6]!;
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          const out = { x: mid.x - c.x, y: mid.y - c.y };
          if (out.x * Math.SQRT1_2 * [1, 1, -1, -1][turn]! + out.y * Math.SQRT1_2 * [1, -1, -1, 1][turn]! <= 0) continue;
          const hit = pickWalk({ camera: CAM, view, grid, heights }, viewToScreen(CAM, toView(view, mid, 1)));
          assert.deepEqual([hit.cell.col, hit.cell.row, Math.round(hit.z * 1e6) / 1e6], [target.col, target.row, 1], `${grid.orient} turn ${turn} side ${k}`);
        }
      }
    }
  });

  test("past the scene's perimeter the ground is 0: its top when the ray is still above it, and the unused strip by the last whole hexes reads 0", () => {
    for (const grid of [ROWS, COLUMNS]) {
      const bounds = { w: 9, h: 9 };
      const cells = new Map<string, number>([["4,4", 3]]);
      const heights = heightsFor(grid, bounds, cells);
      for (const turn of TURNS) {
        const view = isometric(turn);
        for (const p of [
          { x: -3, y: 4 },
          { x: 12, y: 4 },
          { x: 4, y: 8.98 },
          { x: 8.98, y: 4 },
        ]) {
          const hit = pickWalk({ camera: CAM, view, grid, heights }, viewToScreen(CAM, toView(view, p, 0)));
          const want = rayOracle(grid, bounds, (c) => cells.get(`${c.col},${c.row}`) ?? 0, turn, toView(view, p, 0));
          assert.ok(Math.abs(hit.z - want.z) < 1e-6, `${grid.orient} turn ${turn} (${p.x}, ${p.y})`);
        }
      }
    }
  });
});

describe("a press on hexes reaches the rules as the hex it showed (7)", () => {
  test("Top-down keeps a press where it fell, so a rounded edge's sliver still names hexAt's hex, as before the relief (review HXR1-ASTRA-5)", () => {
    const room = { buildChunks: {}, fogTiles: {}, meta: { settings: { feetPerCell: 5 } } } as never;
    const pick = boardPickFor({ room, scene: { id: "s1", bounds: { w: 12, h: 12 }, gridShape: "hexRows" }, role: "dm", fog: false, view: TOP_DOWN, camera: CAM, lowPower: false }, new DrawnHeightsMemo());
    const world = { x: 3.993, y: 2.598 };
    assert.deepEqual(hexAt(ROWS, world), { col: 3, row: 2 });
    const screen = viewToScreen(CAM, toView(TOP_DOWN, world, 0));
    const at = pressAt(pick, screen);
    assert.ok(Math.hypot(at.x - world.x, at.y - world.y) < 1e-9, `moved to (${at.x}, ${at.y})`);
    assert.deepEqual(hexAt(ROWS, at), { col: 3, row: 2 });
    // A sweep of presses on rounded edges: Top-down never moves one.
    const rand = mulberry32(0x7d0);
    for (let i = 0; i < 2000; i++) {
      const h = { col: 1 + Math.floor(rand() * 9), row: 1 + Math.floor(rand() * 9) };
      const pts = poly(ROWS, h);
      const k = Math.floor(rand() * 6);
      const t = rand();
      const p = { x: pts[k]!.x + (pts[(k + 1) % 6]!.x - pts[k]!.x) * t, y: pts[k]!.y + (pts[(k + 1) % 6]!.y - pts[k]!.y) * t };
      const got = pressAt(pick, viewToScreen(CAM, toView(TOP_DOWN, p, 0)));
      assert.ok(Math.hypot(got.x - p.x, got.y - p.y) < 1e-9, `(${p.x}, ${p.y}) moved to (${got.x}, ${got.y})`);
    }
  });

  test("every face and top hit near rounded edges, both orientations and every turn: pressAt names the hit hex for hexAt and a Medium's snap, within 1/64 cell of the hit", () => {
    const rand = mulberry32(0xface);
    for (const [orient, grid] of [
      ["hexRows", ROWS],
      ["hexColumns", COLUMNS],
    ] as const) {
      const bounds = { w: 14, h: 14 };
      const chunkFeet: Record<string, number> = {};
      const heightCells = new Map<string, number>();
      for (const h of sceneHexes(grid, bounds)) {
        if (rand() < 0.4) continue;
        const feet = 5 * Math.floor(rand() * 5);
        chunkFeet[`${h.col},${h.row}`] = feet;
        heightCells.set(`${h.col},${h.row}`, feet / 5);
      }
      const feet = new Array<number>(256).fill(0);
      for (const [k, v] of Object.entries(chunkFeet)) {
        const [x, y] = k.split(",").map(Number) as [number, number];
        feet[y * 16 + x] = v;
      }
      const room = {
        buildChunks: { "s1:0,0": { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, heights: encodeHeights(feet) } },
        fogTiles: {},
        meta: { settings: { feetPerCell: 5 } },
      } as never;
      for (const turn of TURNS) {
        const pick = boardPickFor({ room, scene: { id: "s1", bounds, gridShape: orient }, role: "dm", fog: false, view: isometric(turn), camera: CAM, lowPower: false }, new DrawnHeightsMemo());
        let near = 0;
        for (let i = 0; i < 600; i++) {
          // A point on a hex's side or a hair off it, at its top or partway down its side.
          const h = sceneHexes(grid, bounds)[Math.floor(rand() * sceneHexes(grid, bounds).length)]!;
          const pts = poly(grid, h);
          const k = Math.floor(rand() * 6);
          const t = rand();
          const p = { x: pts[k]!.x + (pts[(k + 1) % 6]!.x - pts[k]!.x) * t, y: pts[k]!.y + (pts[(k + 1) % 6]!.y - pts[k]!.y) * t };
          const z = (heightCells.get(`${h.col},${h.row}`) ?? 0) * (rand() < 0.5 ? 1 : rand());
          const screen = viewToScreen(CAM, toView(isometric(turn), p, z));
          const hit = pressHit(pick, screen);
          const rule = pressAt(pick, screen);
          assert.deepEqual(rule, hit.rule);
          if (!hexInScene(grid, bounds, hit.cell)) continue;
          assert.ok(sameHex(hexAt(grid, rule), hit.cell), `${orient} turn ${turn}: hexAt of the rule point is the hit hex`);
          assert.ok(Math.hypot(rule.x - hit.point.x, rule.y - hit.point.y) <= HIT_RECONCILE + 1e-12);
          // A Medium placed by the press stands on the hex whose surface showed there.
          const anchor = snapAnchor(grid, "medium", rule);
          const c = hexCenter(grid, hit.cell);
          assert.ok(Math.abs(anchor.x - c.x) < 1e-12 && Math.abs(anchor.y - c.y) < 1e-12, `${orient} turn ${turn}: Medium placement`);
          if (!sameHex(hexAt(grid, hit.point), hit.cell)) near++;
        }
        assert.ok(near > 0, `${orient} turn ${turn}: some presses landed where hexAt alone names the neighbor`);
      }
    }
  });
});

describe("the stand threshold on hexes, Low power's too (10.3, review HXREL1-OPUS-9)", () => {
  test("both orientations: a raised hex stands from 12 px a hex and lies flat at 11, and in Low power from 24 px and flat at 23, for the drawn heights and a press alike", () => {
    for (const orient of ["hexRows", "hexColumns"] as const) {
      const grid: HexGrid = { shape: "hex", orient: orient === "hexRows" ? "rows" : "columns" };
      const h = { col: 5, row: 5 };
      const feet = new Array<number>(256).fill(0);
      feet[h.row * 16 + h.col] = 20;
      const room = { buildChunks: { "s1:0,0": { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, heights: encodeHeights(feet) } }, fogTiles: {}, meta: { settings: { feetPerCell: 5 } } } as never;
      for (const [scale, lowPower, stands] of [
        [11, false, false],
        [12, false, true],
        [23, true, false],
        [24, true, true],
      ] as const) {
        const camera = { x: 200, y: 100, scale };
        const pick = boardPickFor({ room, scene: { id: "s1", bounds: { w: 16, h: 16 }, gridShape: orient }, role: "dm", fog: false, view: isometric(0), camera, lowPower }, new DrawnHeightsMemo());
        const label = `${orient} at ${scale} px${lowPower ? " in Low power" : ""}`;
        assert.equal(pick.heights.atCell(h), stands ? 4 : 0, `${label}: the hex's drawn height`);
        assert.equal(pick.heights.high, stands ? 4 : 0, label);
        // A press on the hex's center as its top would draw: on the top when it stands, else on the flat ground under the same screen point.
        const c = hexCenter(grid, h);
        const hit = pressHit(pick, viewToScreen(camera, toView(isometric(0), c, 4)));
        assert.equal(hit.z, stands ? 4 : 0, `${label}: the press meets ${stands ? "the top" : "the ground"}`);
      }
    }
  });
});

describe("a drag on hexes reads the hexes it would stand on (7)", () => {
  test("a Medium dragged over a raised hex lands on its top under the finger, and a Large across a ledge stands on its highest own hex, never one its box only touches", () => {
    for (const grid of [ROWS, COLUMNS]) {
      const bounds = { w: 14, h: 14 };
      const raised = { col: 6, row: 6 };
      const cells = new Map<string, number>([[`${raised.col},${raised.row}`, 2]]);
      const heights = heightsFor(grid, bounds, cells);
      const medium = { id: "m", sceneId: "s1", size: "medium" as const, x: 0, y: 0, elevation: 0 };
      const ground = dragGround(heights, medium, grid);
      assert.deepEqual(ground.levels, [2, 0]);
      const plan = { w: 1, h: 1, own: { kind: "walk" as const }, seat: null, drawn: (b: number) => b };
      for (const turn of TURNS) {
        const view = isometric(turn);
        const c = hexCenter(grid, raised);
        const at = dragLanding(view, ground, plan, toView(view, c, 2));
        assert.equal(at.z, 2, `${grid.orient} turn ${turn}: on the top`);
        const snapped = ground.snap(at);
        assert.ok(sameHex(hexAt(grid, { x: snapped.x + 0.5, y: snapped.y + 0.5 }), raised), `${grid.orient} turn ${turn}: on the raised hex`);
      }
      // A Large on three hexes, one of them raised: its foot reads 2. A hex only its box touches, raised instead, reads nothing.
      const large = { id: "l", sceneId: "s1", size: "large" as const, x: 0, y: 0, elevation: 0 };
      const corner = cornerAt(grid, { hex: raised, k: 1 });
      const box = { x: corner.x - 1, y: corner.y - 1 };
      const own = occupiedHexes(grid, { ...large, ...box });
      assert.ok(own.some((h) => sameHex(h, raised)));
      assert.equal(dragGround(heights, large, grid).footGround(box), 2);
      const touches = cellAtPoint(grid, { x: box.x + 0.05, y: box.y + 1 });
      if (!own.some((h) => sameHex(h, touches))) {
        const only = heightsFor(grid, bounds, new Map([[`${touches.col},${touches.row}`, 4]]));
        assert.equal(dragGround(only, large, grid).footGround(box), 0, `${grid.orient}: a hex outside its three never lifts it`);
      }
    }
  });
});
