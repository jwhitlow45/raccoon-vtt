import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { SQUARES } from "#shared/rules/grid.ts";
import { sceneWalls } from "#shared/rules/walls.ts";
import { DM, env, room, scene } from "#shared/testutil.ts";
import type { BandPart } from "../../features/areas/volume.ts";
import { drawnHeights } from "../../lib/view.ts";
import { groupWalls, ReliefIndex } from "./buckets.ts";
import { clipToPits, drawRun, drawVolume, NO_AREA_PITS, type DrawContext } from "./drawRelief.ts";
import { cellPieces, type CellPiece, type PitRegion } from "./pieces.ts";

/*
 * Chrome's closePath costs as much as the path it closes already holds, so
 * a path of many polygons closed one by one costs the square of their
 * count (SUNKEN-PAN: a sunk scene's clip of thousands of openings took
 * most of each draw). Every path the relief makes of many polygons closes
 * each polygon only on its own, or leaves it to the fill or clip.
 */

/** How many polygons the path held at each closePath, the context's own path and every Path2D. */
const closes: number[] = [];

class CountingPath2D {
  polygons = 0;
  moveTo(): void {
    this.polygons++;
  }
  lineTo(): void {}
  closePath(): void {
    closes.push(this.polygons);
  }
  addPath(p: CountingPath2D): void {
    this.polygons += p.polygons;
  }
}
(globalThis as { Path2D?: unknown }).Path2D = CountingPath2D;

/** A context that counts its own path's polygons and does nothing else. */
function counting(): CanvasRenderingContext2D {
  let polygons = 0;
  const own: Record<string, unknown> = {
    beginPath: () => void (polygons = 0),
    moveTo: () => void polygons++,
    closePath: () => void closes.push(polygons),
    createPattern: () => ({ setTransform() {} }),
  };
  return new Proxy({} as Record<string, unknown>, {
    get: (store, name: string) => own[name] ?? store[name] ?? (() => {}),
    set: (store, name: string, v: unknown) => {
      store[name] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function dc(): DrawContext {
  return { turn: 0, camera: { x: 0, y: 0, scale: 10 }, pixelRatio: 2, ground: { width: 4000, height: 4000 } as HTMLCanvasElement, textures: {}, view: { x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 } };
}

/** A 16 by 16 chunk of squares, every cell at `z`. */
function block(z: number): CellPiece[] {
  return cellPieces({ ground: () => z, terrain: () => null, look: () => ({ texture: null, color: "#777777" }), bounds: { w: 16, h: 16 }, grid: SQUARES }, 0, 0, undefined);
}

/** The most polygons any closePath closed in a path, after `draw`. */
function widest(draw: () => void): number {
  closes.length = 0;
  draw();
  return Math.max(0, ...closes);
}

describe("a path of many polygons closes each on its own (SUNKEN-PAN)", () => {
  test("a run of one region's pits clips to its openings with no polygon closed in a path holding others", () => {
    const pits = block(-4);
    const region: PitRegion = { id: 0, cells: pits };
    for (const p of pits) p.region = region;
    assert.equal(pits.length, 256);
    assert.ok(widest(() => drawRun(counting(), pits, dc())) <= 1);
  });

  test("tops at one lift copy and outline one path of their own closed paths", () => {
    const columns = block(2);
    assert.ok(widest(() => drawRun(counting(), columns, dc())) <= 1);
  });

  test("a stair sunk in a wide pit clips to the openings around it with no polygon closed in a path holding others", () => {
    const cells: string[] = [];
    for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) cells.push(`${x},${y}`);
    let state = room({ scenes: { s1: scene("s1", { bounds: { w: 16, h: 16 }, autoWalls: "off" }) } });
    const ops = [
      { t: "build.height", sceneId: "s1", cells, height: -10 },
      { t: "build.height", sceneId: "s1", cells: ["12,5"], height: -5 },
      { t: "build.stairs", sceneId: "s1", cells: ["12,5", "13,5"], up: "e" },
    ] as Op[];
    ops.forEach((op, i) => {
      const r = applyOp(state, op, DM, env(i + 1));
      if (!r.ok) throw new Error(r.message);
      state = r.state;
    });
    const bounds = { w: 16, h: 16 };
    const heights = drawnHeights({ chunks: state.buildChunks, sceneId: "s1", bounds, grid: SQUARES, fog: null, stand: true, detail: true }, 5, sceneWalls(state.scenes.s1!, state.buildChunks));
    const relief = new ReliefIndex();
    relief.sync({ sceneId: "s1", bounds, chunks: state.buildChunks, tiles: null, walls: groupWalls([], null, bounds), global: null, src: { ground: (x, y) => heights.at(x, y), terrain: () => null, look: () => ({ texture: null, color: "#777777" }), bounds, runs: heights.runs, detail: heights.detail } });
    const stair = relief.cellAt(12, 5)!;
    assert.equal(stair.kind, "steps");
    assert.ok(stair.region && stair.region.cells.length > 100);
    const d = dc();
    d.openings = (region, box, asker) => relief.openingsMeeting(region, 0, box, asker);
    assert.ok(widest(() => drawRun(counting(), [stair], d)) <= 1);
  });

  test("a clip to pit openings swept up, and an area's loops filled, close nothing in a path of many", () => {
    const polys = block(-4).map((c) => c.poly);
    assert.ok(widest(() => clipToPits(counting(), polys, 0)) <= 1);
    const loop = Float64Array.of(0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0);
    const part: BandPart = { far: Array.from({ length: 100 }, () => loop), near: [], farAt: new Float64Array(0), nearAt: new Float64Array(0), outline: new Float64Array(0), hidden: new Float64Array(0), guide: new Float64Array(0), guideHidden: new Float64Array(0) };
    assert.ok(widest(() => drawVolume(counting(), [part], [], NO_AREA_PITS, { color: "#3fa7ff", dm: false, selected: false, preview: false }, 0, 0.5)) <= 1);
  });
});
