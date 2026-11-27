import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { runSettings } from "#shared/propertyTestutil.ts";
import { clusterMesh, type Bounds, type ClusterLimits, type TriangleSource } from "./cluster.ts";
import { MODEL_WORDS, ModelRefusal } from "./mesh.ts";

/**
 * Vertex clustering over random meshes (docs/design/design-v1-token-models.md
 * 10): whatever the input, the output's indices are in range, no triangle
 * is degenerate, there are at most the target's triangles, and every vertex
 * lies inside the input's box. Or it refuses in words. Small caps make
 * every limit reachable in a few hundred triangles.
 */

const { seed, runs } = runSettings(process.env);

const SMALL: ClusterLimits = { triangles: 60, slots: 512, cells: 300, candidates: 200, passes: 4, weldGrid: 64 };

function sourceOf(t: Float32Array): TriangleSource {
  return async (sink) => {
    for (let i = 0; i < t.length; i += 9) sink(t[i]!, t[i + 1]!, t[i + 2]!, t[i + 3]!, t[i + 4]!, t[i + 5]!, t[i + 6]!, t[i + 7]!, t[i + 8]!);
  };
}

function boundsOf(t: Float32Array): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < t.length; i++) {
    const k = i % 3;
    min[k] = Math.min(min[k]!, t[i]!);
    max[k] = Math.max(max[k]!, t[i]!);
  }
  return { min, max };
}

/** A coordinate from a few values, so corners repeat and triangles share them, or from anywhere in a range. */
const coordinate = fc.oneof(fc.constantFrom(0, 0.25, 0.5, 1, -1, 3), fc.float({ min: -10, max: 10, noNaN: true, noDefaultInfinity: true }));
const mesh = fc.array(fc.array(coordinate, { minLength: 9, maxLength: 9 }), { minLength: 1, maxLength: 600, size: "max" }).map((tris) => new Float32Array(tris.flat()));

async function holdsAsync<Ts extends [unknown]>(property: fc.IAsyncProperty<Ts>, numRuns: number): Promise<void> {
  await fc.assert(property, { seed, numRuns: runs ?? numRuns });
}

describe("vertex clustering, over random meshes", () => {
  test("indices in range, nothing degenerate, at most the target, every vertex in the box, or a refusal in words", async () => {
    const seen = { refused: 0, retried: 0, first: 0 };
    await holdsAsync(
      fc.asyncProperty(fc.tuple(mesh), async ([t]) => {
        const bounds = boundsOf(t);
        let out;
        try {
          out = await clusterMesh(sourceOf(t), bounds, t.length / 9, SMALL);
        } catch (err) {
          assert.ok(err instanceof ModelRefusal, String(err));
          assert.ok([MODEL_WORDS.notModel, MODEL_WORDS.tooComplex].includes(err.message as never), err.message);
          seen.refused++;
          return;
        }
        if (out.passes > 1) seen.retried++;
        else seen.first++;
        const { positions: p, index, normals } = out;
        const vertices = p.length / 3;
        assert.ok(index.length / 3 <= SMALL.triangles);
        assert.ok(index.length > 0);
        assert.ok(out.passes <= SMALL.passes);
        const used = new Uint8Array(vertices);
        for (let i = 0; i < index.length; i += 3) {
          const [a, b, c] = [index[i]!, index[i + 1]!, index[i + 2]!];
          assert.ok(a < vertices && b < vertices && c < vertices, "an index past the vertices");
          assert.ok(a !== b && b !== c && a !== c, "a triangle with a repeated corner");
          const u = [p[b * 3]! - p[a * 3]!, p[b * 3 + 1]! - p[a * 3 + 1]!, p[b * 3 + 2]! - p[a * 3 + 2]!];
          const v = [p[c * 3]! - p[a * 3]!, p[c * 3 + 1]! - p[a * 3 + 1]!, p[c * 3 + 2]! - p[a * 3 + 2]!];
          const n = Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!);
          assert.ok(n > 0, "a triangle with no area");
          used[a] = used[b] = used[c] = 1;
        }
        assert.ok(used.every((x) => x === 1), "a vertex no triangle uses");
        for (let i = 0; i < p.length; i++) assert.ok(p[i]! >= bounds.min[i % 3]! && p[i]! <= bounds.max[i % 3]!, "a vertex outside the input's box");
        for (let i = 0; i < normals.length; i += 3) assert.ok(Math.abs(Math.hypot(normals[i]!, normals[i + 1]!, normals[i + 2]!) - 1) < 1e-5, "a normal not of unit length");
      }),
      150,
    );
    // The caps are small enough that the cases reach each outcome: kept at once, kept after a coarser pass, refused.
    if (runs === undefined) for (const [outcome, n] of Object.entries(seen)) assert.ok(n > 0, `no case ${outcome}`);
  });

  test("a mesh already under the target keeps every triangle that has an area once welded", async () => {
    await holdsAsync(
      fc.asyncProperty(fc.tuple(fc.integer({ min: 2, max: 7 })), async ([n]) => {
        // An n by n grid of quads, its corners written once per triangle, as STL writes them.
        const t: number[] = [];
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) {
            const q = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]].map(([x, z]) => [x! / n, 0, z! / n]);
            t.push(...q[0]!, ...q[1]!, ...q[2]!, ...q[0]!, ...q[2]!, ...q[3]!);
          }
        }
        const f = new Float32Array(t);
        const out = await clusterMesh(sourceOf(f), boundsOf(f), f.length / 9, { ...SMALL, triangles: 200, cells: 300 });
        assert.equal(out.index.length / 3, 2 * n * n);
        assert.equal(out.positions.length / 3, (n + 1) * (n + 1));
      }),
      6,
    );
  });
});
