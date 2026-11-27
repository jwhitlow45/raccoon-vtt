import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MODEL_LIMITS } from "#shared/limits.ts";
import { CellTable, clusterMesh, CLUSTER_LIMITS, extentOf, weldNormals, type ClusterLimits, type TriangleSource } from "./cluster.ts";
import { allocations } from "./fixtures.testutil.ts";
import { MODEL_WORDS } from "./mesh.ts";

/**
 * Hostile meshes against the clustering's hard limits
 * (docs/design/design-v1-token-models.md 5, D-261127-374, section 9's
 * clustering row): a triangle soup whose every corner is its own cell, planes
 * layered so a pass holds more candidates than it may, a point, a box that
 * is not finite. Each stops a pass at once and retries coarser, or refuses
 * in words, and never allocates past its caps.
 */

/** A deterministic stream of numbers in [0, 1). */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** `n` triangles from `make`, a pass at a time, counting the passes. */
function counted(n: number, make: (i: number, out: Float64Array) => void): { source: TriangleSource; passes: () => number; triangles: number } {
  let passes = 0;
  const t = new Float64Array(9);
  return {
    triangles: n,
    passes: () => passes,
    source: async (sink) => {
      passes++;
      for (let i = 0; i < n; i++) {
        make(i, t);
        sink(t[0]!, t[1]!, t[2]!, t[3]!, t[4]!, t[5]!, t[6]!, t[7]!, t[8]!);
      }
    },
  };
}

const unit = { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] };

describe("clustering's hard limits", () => {
  test("a triangle soup at the real caps stops each pass at a cap, halves the grid, and refuses after four passes in words", async () => {
    const next = random(7);
    // 1.2 million triangles of corners anywhere: every corner its own cell at the first grids, and every triangle a candidate at the coarse ones.
    const soup = counted(1_200_000, (_, t) => {
      for (let k = 0; k < 9; k++) t[k] = next();
    });
    const { result, largest, total } = await allocations(() => clusterMesh(soup.source, unit, soup.triangles));
    assert.ok(result instanceof Error && result.message === MODEL_WORDS.tooComplex, String(result));
    assert.equal(soup.passes(), MODEL_LIMITS.clusterPasses);
    // The cells' sums are the largest array, made once at the cap. Nothing grows with the file.
    assert.equal(largest, MODEL_LIMITS.clusterCells * 3 * 8);
    assert.ok(total < 60 * 1024 * 1024, `${total} bytes allocated`);
  });

  test("planes layered on one another fill a pass with candidates, and a coarser pass keeps them", async () => {
    // 40 layers of a 120 by 120 grid of quads, 1,152,000 triangles: past the candidate cap at the first grid.
    const n = 120;
    const layers = 40;
    const make = (i: number, t: Float64Array) => {
      const layer = Math.floor(i / (2 * n * n));
      const q = Math.floor((i % (2 * n * n)) / 2);
      const x = (q % n) / n;
      const z = Math.floor(q / n) / n;
      const y = layer / layers;
      const d = 1 / n;
      const corners = i & 1 ? [x, y, z, x + d, y, z + d, x, y, z + d] : [x, y, z, x + d, y, z, x + d, y, z + d];
      t.set(corners);
    };
    const planes = counted(2 * n * n * layers, make);
    const out = await clusterMesh(planes.source, unit, planes.triangles);
    assert.ok(out.index.length / 3 <= MODEL_LIMITS.clusterTriangles);
    assert.ok(out.passes > 1, "the first pass reached a cap");
    assert.ok(out.grid < Math.round(Math.sqrt(MODEL_LIMITS.clusterTriangles / 4)));
  });

  test("a pass over the cell cap stops at once, mid-file", async () => {
    const next = random(3);
    let after = 0;
    let full = false;
    // Under the target, so the pass welds on the fine grid where every random corner is a cell of its own.
    const limits: ClusterLimits = { triangles: 2_000, slots: 64, cells: 40, candidates: 1_000, passes: 1, weldGrid: 4096 };
    const source: TriangleSource = async (sink) => {
      for (let i = 0; i < 1_000; i++) {
        if (full) after++;
        sink(next(), next(), next(), next(), next(), next(), next(), next(), next());
        // 40 cells at three corners a triangle: the 14th triangle passes the cap.
        if (i === 13) full = true;
      }
    };
    await assert.rejects(clusterMesh(source, unit, 1_000, limits), { message: MODEL_WORDS.tooComplex });
    assert.equal(after, 0, "no triangle read after the cap");
  });

  test("a pass past its candidates stops and retries coarser even under the target, and refuses when no grid gets under", async () => {
    // 100 triangles far apart, every one a candidate at every grid tried, against room for 50.
    const apart = counted(100, (i, t) => {
      const x = (i % 10) / 10;
      const z = Math.floor(i / 10) / 10;
      t.set([x, 0, z, x + 0.05, 0, z, x, 0, z + 0.05]);
    });
    const limits: ClusterLimits = { triangles: 1_000, slots: 4096, cells: 2_000, candidates: 50, passes: 4, weldGrid: 4096 };
    await assert.rejects(clusterMesh(apart.source, unit, 100, limits), { message: MODEL_WORDS.tooComplex });
    assert.equal(apart.passes(), 4);
  });

  test("drops a triangle whose corners land in three cells but in a line", async () => {
    // A sliver along x, its corners in three cells of the weld grid, beside a real triangle.
    const t = counted(2, (i, out) => out.set(i === 0 ? [0, 0, 0, 1, 0, 0, 0, 1, 0] : [0, 0, 0, 0.5, 0, 0, 1, 0, 0]));
    const out = await clusterMesh(t.source, unit, 2);
    assert.equal(out.index.length, 3);
  });

  test("a model with no size, or a box that is not finite, is no model", async () => {
    const point = counted(10, (_, t) => t.fill(2));
    await assert.rejects(clusterMesh(point.source, { min: [2, 2, 2], max: [2, 2, 2] }, 10), { message: MODEL_WORDS.notModel });
    assert.throws(() => extentOf({ min: [0, 0, 0], max: [NaN, 1, 1] }), { message: MODEL_WORDS.notModel });
    assert.throws(() => extentOf({ min: [0, 0, 0], max: [Infinity, 1, 1] }), { message: MODEL_WORDS.notModel });
  });

  test("the cell table holds its cap and finds every key it made", () => {
    const table = new CellTable(1 << 10, 700);
    for (let i = 0; i < 700; i++) assert.equal(table.idOf(i, i * 7, i * 13, i * 1e9 + i), i);
    for (let i = 0; i < 700; i++) assert.equal(table.idOf(i, i * 7, i * 13, i * 1e9 + i), i);
    assert.equal(table.idOf(701, 1, 1, 5e12), -1);
    // Keys past 32 bits, as the 4,096 weld grid makes, stay apart.
    const big = new CellTable(1 << 4, 8);
    assert.equal(big.idOf(4096, 4096, 4096, 4096 + 4097 * (4096 + 4097 * 4096)), 0);
    assert.equal(big.idOf(4096, 4096, 4095, 4096 + 4097 * (4096 + 4097 * 4095)), 1);
    assert.throws(() => new CellTable(1000, 10));
  });

  test("welding normals past the table's cells falls back to each face's normal", () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1]);
    const normals = new Float32Array(18);
    weldNormals([{ positions, normals, from: 0, to: 2 }], { ...CLUSTER_LIMITS, slots: 8, cells: 2 });
    assert.deepEqual([...normals.slice(0, 3)], [0, 0, 1]);
    assert.deepEqual([...normals.slice(9, 12)], [1, 0, 0]);
    const smooth = new Float32Array(18);
    weldNormals([{ positions, normals: smooth, from: 0, to: 2 }]);
    // The shared corner at the origin averages the two faces.
    assert.ok(Math.abs(smooth[0]! - Math.SQRT1_2) < 1e-6 && Math.abs(smooth[2]! - Math.SQRT1_2) < 1e-6);
  });
});
