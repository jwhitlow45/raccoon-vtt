import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { Matrix3, Matrix4, Quaternion, Vector3 } from "three";
import { holds } from "#shared/propertyTestutil.ts";
import { allocationsNow, box, Glb } from "./fixtures.testutil.ts";
import { readGlb } from "./glb.ts";
import type { ModelMesh } from "./mesh.ts";

/**
 * The GLB reader over random node trees, transforms and primitives
 * (docs/design/design-v1-token-models.md 10): the output holds exactly the
 * counted triangles, each corner the composed transform of an input vertex,
 * in the walk's order, every normal of unit length, every face out whatever
 * the sign of its node's determinant, and no array past the output's size.
 * The walk and the composition are written again here with three's own
 * matrices, as the oracle.
 */

type Json = { [key: string]: unknown };
type V3 = [number, number, number];

/** The shapes the nodes draw, each with the point its faces face away from, or the way a flat one faces. */
const CUBE = box([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]);
const TETRA_POINTS = [1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1];
const TETRA_INDICES = [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3];
const QUAD_STRIP = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0];
const QUAD_FAN = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];

function faceNormals(t: number[]): number[] {
  const out: number[] = [];
  for (let o = 0; o < t.length; o += 9) {
    const u = new Vector3(t[o + 3]! - t[o]!, t[o + 4]! - t[o + 1]!, t[o + 5]! - t[o + 2]!);
    const n = u.cross(new Vector3(t[o + 6]! - t[o]!, t[o + 7]! - t[o + 1]!, t[o + 8]! - t[o + 2]!)).normalize();
    for (let k = 0; k < 3; k++) out.push(n.x, n.y, n.z);
  }
  return out;
}

/** Each mesh's primitives as the oracle reads them: the triangles' corners in the file's order, and which way is out. */
type Shape = { triangles: V3[][]; out: { center: V3 } | { facing: V3 } };

function shapes(): Shape[][] {
  const cubeTris: V3[][] = [];
  for (let o = 0; o < CUBE.length; o += 9) cubeTris.push([0, 1, 2].map((k) => [CUBE[o + 3 * k]!, CUBE[o + 3 * k + 1]!, CUBE[o + 3 * k + 2]!] as V3));
  const tetra = (i: number): V3 => [TETRA_POINTS[i * 3]!, TETRA_POINTS[i * 3 + 1]!, TETRA_POINTS[i * 3 + 2]!];
  const tetraTris: V3[][] = [];
  for (let t = 0; t < TETRA_INDICES.length; t += 3) tetraTris.push([tetra(TETRA_INDICES[t]!), tetra(TETRA_INDICES[t + 1]!), tetra(TETRA_INDICES[t + 2]!)]);
  const p = (list: number[], i: number): V3 => [list[i * 3]!, list[i * 3 + 1]!, list[i * 3 + 2]!];
  const strip = [[p(QUAD_STRIP, 0), p(QUAD_STRIP, 1), p(QUAD_STRIP, 2)], [p(QUAD_STRIP, 1), p(QUAD_STRIP, 3), p(QUAD_STRIP, 2)]];
  const fan = [[p(QUAD_FAN, 1), p(QUAD_FAN, 2), p(QUAD_FAN, 0)], [p(QUAD_FAN, 2), p(QUAD_FAN, 3), p(QUAD_FAN, 0)]];
  return [[{ triangles: cubeTris, out: { center: [0, 0, 0] } }], [{ triangles: tetraTris, out: { center: [0, 0, 0] } }], [{ triangles: strip, out: { facing: [0, 0, 1] } }, { triangles: fan, out: { facing: [0, 0, 1] } }]];
}

/** The file's meshes: a cube with its normals, a tetrahedron by indices without any, a strip and a fan. */
function addMeshes(g: Glb): void {
  const meshes = g.json.meshes as Json[];
  meshes.push({ primitives: [{ attributes: { POSITION: g.floats(CUBE, "VEC3"), NORMAL: g.floats(faceNormals(CUBE), "VEC3") } }] });
  meshes.push({ primitives: [{ attributes: { POSITION: g.floats(TETRA_POINTS, "VEC3") }, indices: g.indices(TETRA_INDICES) }] });
  meshes.push({ primitives: [{ attributes: { POSITION: g.floats(QUAD_STRIP, "VEC3") }, mode: 5 }, { attributes: { POSITION: g.floats(QUAD_FAN, "VEC3") }, mode: 6 }] });
}

const coordinate = fc.double({ min: -3, max: 3, noNaN: true });
const magnitude = fc.double({ min: 0.25, max: 3, noNaN: true });
const nodeArb = fc.record({
  parent: fc.nat({ max: 20 }),
  mesh: fc.option(fc.integer({ min: 0, max: 2 }), { nil: undefined }),
  t: fc.tuple(coordinate, coordinate, coordinate),
  r: fc.tuple(coordinate, coordinate, coordinate, coordinate).filter((q) => Math.hypot(...q) > 0.1),
  s: fc.tuple(magnitude, magnitude, magnitude),
  flips: fc.tuple(fc.boolean(), fc.boolean(), fc.boolean()),
  matrix: fc.boolean(),
});

type NodeCase = { parent: number; mesh: number | undefined; t: V3; r: [number, number, number, number]; s: V3; flips: [boolean, boolean, boolean]; matrix: boolean };

function localOf(n: NodeCase): Matrix4 {
  const q = new Quaternion(...n.r).normalize();
  const s = n.s.map((v, i) => (n.flips[i] ? -v : v)) as V3;
  return new Matrix4().compose(new Vector3(...n.t), q, new Vector3(...s));
}

describe("the GLB reader over random node trees", () => {
  test("exactly the counted triangles, each corner its node's transform of the file's, unit normals, faces out, nothing past the output", () => {
    const shapeList = shapes();
    holds(
      fc.property(fc.array(nodeArb, { minLength: 1, maxLength: 9 }), (cases) => {
        const nodes = cases as NodeCase[];
        const g = new Glb();
        addMeshes(g);
        // Node i's parent is an earlier node, or none.
        const parentOf = nodes.map((n, i) => (n.parent % (i + 1)) - 1);
        const json = g.json.nodes as Json[];
        nodes.forEach((n, i) => {
          const q = new Quaternion(...n.r).normalize();
          const def: Json = n.matrix ? { matrix: localOf(n).toArray() } : { translation: n.t, rotation: [q.x, q.y, q.z, q.w], scale: n.s.map((v, k) => (n.flips[k] ? -v : v)) };
          if (n.mesh !== undefined) def.mesh = n.mesh;
          const kids = parentOf.map((p, c) => (p === i ? c : -1)).filter((c) => c >= 0);
          if (kids.length > 0) def.children = kids;
          json.push(def);
        });
        const roots = parentOf.map((p, i) => (p < 0 ? i : -1)).filter((i) => i >= 0);
        (g.json.scenes as Json[])[0]!.nodes = roots;

        // The oracle's walk: depth first, children in order.
        const expected: { corners: V3[]; out: Shape["out"]; world: Matrix4 }[] = [];
        const visit = (i: number, parent: Matrix4) => {
          const world = parent.clone().multiply(localOf(nodes[i]!));
          if (nodes[i]!.mesh !== undefined) {
            for (const shape of shapeList[nodes[i]!.mesh!]!) {
              const flip = world.determinant() < 0;
              for (const tri of shape.triangles) {
                const ordered = flip ? [tri[0]!, tri[2]!, tri[1]!] : tri;
                expected.push({ corners: ordered.map((c) => new Vector3(...c).applyMatrix4(world).toArray() as V3), out: shape.out, world });
              }
            }
          }
          parentOf.forEach((p, c) => p === i && visit(c, world));
        };
        roots.forEach((r) => visit(r, new Matrix4()));
        const file = g.build();
        const run = allocationsNow(() => readGlb(file, "computer"));
        if (run.result instanceof Error) {
          assert.equal(expected.length, 0, `refused a model that draws: ${String(run.result)}`);
          return;
        }
        const mesh: ModelMesh = run.result;
        const output = mesh.parts.reduce((n, p) => n + p.positions.byteLength + p.normals.byteLength, 0);
        // The output, the weld's fixed table for the parts without normals, and a few bytes a node: nothing sized past a cap.
        assert.ok(run.total <= output + 13 * 1024 * 1024, `${run.total - output} bytes past the output`);
        assert.equal(mesh.triangles, expected.length, "the counted triangles");
        assert.equal(mesh.parts.length, 1, "one plain group");
        const part = mesh.parts[0]!;
        assert.equal(part.positions.length, expected.length * 9, "the output holds exactly the counted triangles");
        expected.forEach((want, t) => {
          want.corners.forEach((c, k) => {
            for (let a = 0; a < 3; a++) {
              const got = part.positions[t * 9 + k * 3 + a]!;
              assert.ok(Math.abs(got - c[a]!) <= 1e-4 * Math.max(1, Math.abs(c[a]!)), `triangle ${t} corner ${k}: ${got} against ${c[a]}`);
            }
          });
          const o = t * 9;
          const p = part.positions;
          const face = new Vector3(p[o + 3]! - p[o]!, p[o + 4]! - p[o + 1]!, p[o + 5]! - p[o + 2]!).cross(new Vector3(p[o + 6]! - p[o]!, p[o + 7]! - p[o + 1]!, p[o + 8]! - p[o + 2]!));
          if ("center" in want.out) {
            const center = new Vector3(...want.out.center).applyMatrix4(want.world);
            const centroid = new Vector3(p[o]! + p[o + 3]! + p[o + 6]!, p[o + 1]! + p[o + 4]! + p[o + 7]!, p[o + 2]! + p[o + 5]! + p[o + 8]!).divideScalar(3);
            assert.ok(face.dot(centroid.sub(center)) > 0, `triangle ${t} faces out`);
          } else {
            const facing = new Vector3(...want.out.facing).applyMatrix3(new Matrix3().getNormalMatrix(want.world));
            assert.ok(face.dot(facing) > 0, `flat triangle ${t} faces its way`);
          }
        });
        for (let i = 0; i < part.normals.length; i += 3) assert.ok(Math.abs(Math.hypot(part.normals[i]!, part.normals[i + 1]!, part.normals[i + 2]!) - 1) < 1e-5, "a unit normal");
      }),
      120,
    );
  });
});
