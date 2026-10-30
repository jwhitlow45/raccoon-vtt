import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveArea, type AreaTemplateInput } from "#shared/rules/aoe.ts";
import { SQUARES, type Grid } from "#shared/rules/grid.ts";
import { hexCenter, sceneHexes, type HexGrid } from "#shared/rules/hex.ts";
import { cellPolygon, groundSurface, type GroundCell } from "../../lib/groundCells.ts";

/** The canonical side between rows (3,3) and (4,3), x = 4.5: its two corners' y, rounded to the 1/64 lattice as every reader has them. */
function sideSpan(): [number, number] {
  const ys = cellPolygon({ shape: "hex", orient: "rows" }, { col: 3, row: 3 })
    .filter((p) => Math.abs(p.x - 4.5) < 1e-9)
    .map((p) => p.y);
  return [Math.min(...ys), Math.max(...ys)];
}
import { buildVolume, type Volume } from "./volume.ts";
import { assertClosed, ctxOf } from "./volumeTesting.ts";

/*
 * An area's ground cut on hexes (docs/design-v1-iso-hex-relief.md 8): each
 * face cut by the hexes it meets, a face along a hex side owned by the
 * one hex its solid lies in before any level cut, and squares' boundary
 * faces as they always were.
 */

const ROWS: HexGrid = { shape: "hex", orient: "rows" };
const COLUMNS: HexGrid = { shape: "hex", orient: "columns" };

function volumeOn(grid: Grid, template: Partial<AreaTemplateInput> & Pick<AreaTemplateInput, "shape" | "size" | "origin">, ground: Record<string, number>, bounds = { w: 12, h: 12 }): Volume {
  const area = resolveArea({ id: "a", rev: 1, yaw: 0, includeOrigin: true, ...template } as AreaTemplateInput, ctxOf(bounds, null, {}, grid));
  assert.ok(area);
  const at = (c: GroundCell) => ground[`${c.col},${c.row}`] ?? 0;
  const surface = grid.shape === "hex" ? groundSurface(grid, bounds, at) : undefined;
  const vol = buildVolume({ area, bounds, ground: (x, y) => at({ col: x, row: y }), surface, px: 40 });
  vol.ensureAll();
  return vol;
}

/** Each face's vertices. */
function facesOf(vol: Volume): [number, number, number][][] {
  return vol.faces().map((f) => [...f.v].map((i) => vol.vertex(i)));
}

/** The area of a planar polygon, by its projection on the plane its normal is largest across. */
function area(pts: [number, number, number][]): number {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return Math.hypot(nx, ny, nz) / 2;
}

/** The faces lying on the vertical line x = e (rows) or y = e (columns), within [lo, hi] along it. */
function onSide(vol: Volume, grid: Grid, e: number, lo: number, hi: number): [number, number, number][][] {
  const across = grid.shape === "hex" && grid.orient === "columns" ? 1 : 0;
  const along = 1 - across;
  return facesOf(vol).filter((f) => f.every((p) => Math.abs(p[across]! - e) < 1e-7 && p[along]! >= lo - 1e-7 && p[along]! <= hi + 1e-7));
}

describe("an area's ground cut on hexes (8)", () => {
  test("rows (3,3) at 2 beside (4,3) at 0: the cube face on their side, z 0 to 3, its solid in (3,3), stands once from 2 to 3 and nowhere below 2, mirrored on columns", () => {
    for (const grid of [ROWS, COLUMNS]) {
      const rows = grid.orient === "rows";
      // The side between (3,3) and (4,3) on rows: x = 4.5, from the center's y less R/2 to plus R/2.
      const c = hexCenter(ROWS, { col: 3, row: 3 });
      const [lo, hi] = sideSpan();
      const ground: Record<string, number> = rows ? { "3,3": 2, "4,3": 0 } : { "3,3": 2, "3,4": 0 };
      const origin = rows ? { x: 4.5, y: c.y, z: 7.5 } : { x: c.y, y: 4.5, z: 7.5 };
      const vol = volumeOn(grid, { shape: "cube", size: 15, origin, yaw: rows ? 180 : 270 }, ground);
      const faces = onSide(vol, grid, 4.5, lo, hi);
      assert.ok(faces.length > 0, `${grid.orient}: the face along the side stands`);
      const zs = faces.flatMap((f) => f.map((p) => p[2]));
      assert.ok(Math.min(...zs) >= 2 - 1e-7, `${grid.orient}: nothing below its owner's ground: ${Math.min(...zs)}`);
      const total = faces.reduce((t, f) => t + area(f), 0);
      assert.ok(Math.abs(total - (hi - lo) * 1) < 1e-6, `${grid.orient}: one z 2 to 3 face, area ${total}`);
      assertClosed(vol, `${grid.orient} cube on a side`);
    }
  });

  test("with equal and unequal neighbors on both orientations, a face along a side is emitted once, and no two faces cover the same piece of a plane", () => {
    for (const grid of [ROWS, COLUMNS]) {
      for (const pair of [
        [1, 1],
        [0, 2],
        [2, 0],
        [-1, 1],
      ]) {
        const rows = grid.orient === "rows";
        const c = hexCenter(ROWS, { col: 3, row: 3 });
        const ground: Record<string, number> = rows ? { "3,3": pair[0]!, "4,3": pair[1]! } : { "3,3": pair[0]!, "3,4": pair[1]! };
        const origin = rows ? { x: 4.5, y: c.y, z: 7.5 } : { x: c.y, y: 4.5, z: 7.5 };
        const vol = volumeOn(grid, { shape: "cube", size: 15, origin, yaw: rows ? 180 : 270 }, ground);
        const [lo, hi] = sideSpan();
        const faces = onSide(vol, grid, 4.5, lo, hi);
        const total = faces.reduce((t, f) => t + area(f), 0);
        const want = (hi - lo) * (3 - Math.max(0, pair[0]!));
        assert.ok(Math.abs(total - want) < 1e-6, `${grid.orient} ${pair}: area ${total}, want ${want}`);
        assertNoDuplicates(vol, `${grid.orient} ${pair}`);
        assertClosed(vol, `${grid.orient} ${pair}`);
      }
    }
  });

  test("a hex emanation, whose shell lies on canonical sides, over a ledge and a pit on both orientations: no duplicate face, none below its hex's ground", () => {
    for (const grid of [ROWS, COLUMNS]) {
      const bounds = { w: 14, h: 14 };
      const ground: Record<string, number> = {};
      let i = 0;
      for (const h of sceneHexes(grid, bounds)) ground[`${h.col},${h.row}`] = [0, 1, -1, 2][i++ % 4]!;
      const center = hexCenter(grid, { col: 6, row: 6 });
      const vol = volumeOn(grid, { shape: "emanation", size: 10, origin: { x: center.x, y: center.y, z: 0 } }, ground, bounds);
      assert.ok(vol.faces().length > 0);
      assertNoDuplicates(vol, `${grid.orient} emanation`);
      assertClosed(vol, `${grid.orient} emanation`);
      for (const f of facesOf(vol)) {
        const mx = f.reduce((t, p) => t + p[0], 0) / f.length;
        const my = f.reduce((t, p) => t + p[1], 0) / f.length;
        const top = Math.max(...f.map((p) => p[2]));
        // Every face stands above the ground of a hex beside its middle.
        const near = sceneHexes(grid, bounds).filter((h) => Math.hypot(hexCenter(grid, h).x - mx, hexCenter(grid, h).y - my) < 0.7);
        if (near.length > 0) assert.ok(near.some((h) => top > (ground[`${h.col},${h.row}`] ?? 0) - 1e-7), `${grid.orient}: a face below every hex beside it`);
      }
    }
  });

  test("a 40 ft cube on alternating hex heights is cut into pieces in proportion to the hexes it meets, not the lines of every side across it", () => {
    for (const grid of [ROWS, COLUMNS]) {
      const bounds = { w: 20, h: 20 };
      const ground: Record<string, number> = {};
      for (const h of sceneHexes(grid, bounds)) ground[`${h.col},${h.row}`] = (h.col + h.row) % 2 === 0 ? 1 : 0;
      const vol = volumeOn(grid, { shape: "cube", size: 40, origin: { x: 6, y: 10, z: 20 }, yaw: 0 }, ground, bounds);
      const hexesUnder = sceneHexes(grid, bounds).filter((h) => {
        const c = hexCenter(grid, h);
        return c.x > 5 && c.x < 15 && c.y > 5 && c.y < 15;
      }).length;
      assert.ok(vol.faces().length < 60 * hexesUnder, `${grid.orient}: ${vol.faces().length} faces over ${hexesUnder} hexes`);
      assert.ok(vol.work < 4_000_000, `${grid.orient}: work ${vol.work}`);
      assertNoDuplicates(vol, `${grid.orient} 40 ft cube`);
      assertClosed(vol, `${grid.orient} 40 ft cube`);
    }
  });
});

describe("squares' boundary faces (8)", () => {
  test("a cube face on the cell line between (3,3) at 2 and (4,3) at 0 stands once from 2 to 3, with no part below 2, as squares always cut it", () => {
    const ground: Record<string, number> = {};
    for (let y = 0; y < 12; y++) {
      ground[`3,${y}`] = 2;
      ground[`4,${y}`] = 0;
    }
    const vol = volumeOn(SQUARES, { shape: "cube", size: 15, origin: { x: 4, y: 5.5, z: 7.5 }, yaw: 180 }, ground);
    const faces = onSide(vol, SQUARES, 4, 4, 7);
    const zs = faces.flatMap((f) => f.map((p) => p[2]));
    assert.ok(faces.length > 0 && Math.min(...zs) >= 2 - 1e-7);
    const total = faces.reduce((t, f) => t + area(f), 0);
    assert.ok(Math.abs(total - 3 * 1) < 1e-6, `area ${total}`);
    assertNoDuplicates(vol, "squares");
  });
});

/** No two faces lie in one plane over the same middle: the duplicate a closed clip of both neighbors would give. */
function assertNoDuplicates(vol: Volume, label: string): void {
  const seen = new Map<string, number>();
  for (const f of facesOf(vol)) {
    const mx = f.reduce((t, p) => t + p[0], 0) / f.length;
    const my = f.reduce((t, p) => t + p[1], 0) / f.length;
    const mz = f.reduce((t, p) => t + p[2], 0) / f.length;
    const key = `${Math.round(mx * 1e6)},${Math.round(my * 1e6)},${Math.round(mz * 1e6)}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const twice = [...seen].filter(([, n]) => n > 1);
  assert.equal(twice.length, 0, `${label}: faces twice at ${twice.slice(0, 3).map(([k]) => k)}`);
}


