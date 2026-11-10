import "../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CHUNK_CELLS, type BuildChunk } from "#shared/model.ts";
import { encodeHeights } from "#shared/rules/heights.ts";
import type { HexGrid } from "#shared/rules/hex.ts";
import { buildPaths } from "../features/builder/draw.ts";
import { reliefPaths, stairPaths } from "../features/builder/heights/relief.ts";

/*
 * Chrome's closePath costs as much as the path it closes already holds, so
 * a path of many polygons closed one by one costs the square of their
 * count (D-261109-051). A fill and a clip close each polygon themselves,
 * so a path of many polygons that is only filled or clipped closes none:
 * an area's shaded hexes, a standee's pit openings, a draft's clip on
 * hexes, the builder's relief and stair treads, and difficult ground's
 * hatch clip on hexes (FU52PERF-LEFT).
 */

/** A path or context that counts its polygons and the closePath calls made on it, and does nothing else. */
class Counter {
  polygons = 0;
  closes = 0;
  moveTo(): void {
    this.polygons++;
  }
  lineTo(): void {}
  closePath(): void {
    this.closes++;
  }
  arc(): void {}
  rect(): void {
    this.polygons++;
  }
  beginPath(): void {}
  save(): void {}
  restore(): void {}
  translate(): void {}
  rotate(): void {}
  scale(): void {}
}

const rows: HexGrid = { shape: "hex", orient: "rows" };
const squares = (n: number) => Array.from({ length: n }, (_, i) => [0, 1, 2, 3].map((k) => ({ x: (i % 20) + (k === 1 || k === 2 ? 1 : 0), y: Math.floor(i / 20) + (k >= 2 ? 1 : 0) })));

describe("a path of many polygons that is only filled or clipped closes none (D-261109-051)", () => {
  test("an area's shaded hexes", async () => {
    const { shadeHexes } = await import("../features/areas/draw.tsx");
    const path = new Counter();
    shadeHexes(rows, Array.from({ length: 300 }, (_, i) => ({ col: i % 20, row: Math.floor(i / 20) })), path);
    assert.deepEqual([path.polygons, path.closes], [300, 0]);
  });

  test("a standee's clip to a wide pit's openings", async () => {
    const { clipToOpenings } = await import("./TokenNode.tsx");
    const ctx = new Counter();
    clipToOpenings(ctx as never, { turn: 1, pits: squares(300) }, { x: 3, y: 4 });
    assert.deepEqual([ctx.polygons, ctx.closes], [300, 0]);
  });

  test("a draft's clip to the hexes of one ground", async () => {
    const { clipToPolys } = await import("../features/drawings/DrawingLayer.tsx");
    const ctx = new Counter();
    clipToPolys(ctx as never, squares(300));
    assert.deepEqual([ctx.polygons, ctx.closes], [300, 0]);
  });

  test("the builder's relief on hexes, its washes and shadows, and stair treads", () => {
    // Every hex of a chunk raised, by turns 5 and 10 ft, so each level washes many hexes and each raised side casts a shadow.
    const feet = Array.from({ length: CHUNK_CELLS * CHUNK_CELLS }, (_, k) => ((k % CHUNK_CELLS) + Math.floor(k / CHUNK_CELLS)) % 2 === 0 ? 5 : 10);
    const chunk: BuildChunk = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, heights: encodeHeights(feet) };
    const relief = reliefPaths([chunk], { stairAt: () => null }, { w: 40, h: 40 }, () => new Counter(), rows);
    const filled = [...relief.tints.map((t) => t.path), ...relief.shadows];
    assert.ok(filled.every((p) => p.polygons > 50), "many hexes in each wash and shadow band");
    assert.deepEqual(filled.map((p) => p.closes), filled.map(() => 0));
    const stairs = stairPaths(Array.from({ length: 60 }, (_, i) => ({ x: i % 10, y: Math.floor(i / 10), dir: "n" as const, floor: true })), () => new Counter());
    assert.ok(stairs.treads.every((p) => p.polygons === 60));
    assert.deepEqual(stairs.treads.map((p) => p.closes), stairs.treads.map(() => 0));
  });

  test("difficult ground's hatch clip on a hex scene", () => {
    const chunk: BuildChunk = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, rough: "d".repeat(CHUNK_CELLS * CHUNK_CELLS), grid: "hexRows" };
    const paths = buildPaths([chunk], "player", { gridShape: "hexRows", bounds: { w: 30, h: 20 } }, () => new Counter());
    const rough = paths.rough as Counter;
    assert.ok(rough.polygons > 200);
    assert.equal(rough.closes, 0);
  });
});
