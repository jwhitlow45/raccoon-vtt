import { MODEL_LIMITS } from "#shared/limits.ts";
import { clusterMesh, CLUSTER_LIMITS, type Bounds, type ClusterLimits, type TriangleSource } from "./cluster.ts";
import { eachLine, finite, ModelRefusal, MODEL_WORDS, numberAt, PLAIN, skipSpace, type ModelMesh } from "./mesh.ts";

/**
 * OBJ, geometry only (docs/design/design-v1-token-models.md 5, D-261127-372):
 * `v` and `f` lines, nothing else, and no MTL. A face names its corners by
 * position, so the positions are kept in one table, at most 4,000,000 (48
 * MB of floats) in blocks that never copy, and refused past that. The faces
 * stream from the file on each clustering pass, fanned into triangles.
 */

/** The table's blocks of vertices, a power of two so a lookup is a shift. */
const BLOCK_BITS = 20;
const BLOCK = 1 << BLOCK_BITS;

export type ObjLimits = ClusterLimits & { vertices: number };

const OBJ_LIMITS: ObjLimits = { ...CLUSTER_LIMITS, vertices: MODEL_LIMITS.objVertices };

/** A line's first word, as one of the two the reader uses. */
function lineKind(bytes: Uint8Array, i: number, end: number): "v" | "f" | null {
  if (i + 1 >= end) return null;
  const c = bytes[i];
  const after = bytes[i + 1];
  if (after !== 32 && after !== 9) return null;
  return c === 118 ? "v" : c === 102 ? "f" : null;
}

/**
 * The next corner of a face line: its position's index, before the first
 * slash, 1-based or negative from the end so far. Returns the index into
 * the table, or -1 at the line's end, and leaves the position after it in
 * `next[0]`.
 */
function cornerAt(bytes: Uint8Array, i: number, end: number, seen: number, total: number, next: Int32Array): number {
  i = skipSpace(bytes, i, end);
  if (i >= end || bytes[i] === 35) {
    next[0] = end;
    return -1;
  }
  const n = numberAt(bytes, i, end, next);
  if (!Number.isInteger(n) || n === 0) throw new ModelRefusal(MODEL_WORDS.notModel);
  let j = next[0]!;
  // Skip the texture and normal indices: anything up to the next space.
  while (j < end && bytes[j] !== 32 && bytes[j] !== 9 && bytes[j] !== 13) j++;
  next[0] = j;
  const at = n > 0 ? n - 1 : seen + n;
  if (at < 0 || at >= total) throw new ModelRefusal(MODEL_WORDS.notModel);
  return at;
}

export async function readObj(file: Blob, limits: ObjLimits = OBJ_LIMITS): Promise<ModelMesh> {
  const blocks: Float32Array[] = [];
  let total = 0;
  let triangles = 0;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const next = new Int32Array(1);

  // The first pass keeps the positions and counts the faces' triangles, so the clustering knows whether it only welds.
  await eachLine(file, (bytes, start, end) => {
    let i = skipSpace(bytes, start, end);
    const kind = lineKind(bytes, i, end);
    if (kind === "v") {
      if (total >= limits.vertices) throw new ModelRefusal(MODEL_WORDS.tooComplex);
      const block = total >> BLOCK_BITS;
      if (block === blocks.length) blocks.push(new Float32Array(Math.min(BLOCK, limits.vertices - total) * 3));
      const into = blocks[block]!;
      const at = (total & (BLOCK - 1)) * 3;
      i += 1;
      for (let k = 0; k < 3; k++) {
        i = skipSpace(bytes, i, end);
        const v = finite(numberAt(bytes, i, end, next));
        i = next[0]!;
        into[at + k] = v;
        const stored = into[at + k]!;
        if (stored < min[k]!) min[k] = stored;
        if (stored > max[k]!) max[k] = stored;
      }
      total++;
    } else if (kind === "f") {
      let corners = 0;
      i += 1;
      for (;;) {
        i = skipSpace(bytes, i, end);
        if (i >= end || bytes[i] === 35) break;
        while (i < end && bytes[i] !== 32 && bytes[i] !== 9 && bytes[i] !== 13) i++;
        corners++;
      }
      if (corners >= 3) triangles += corners - 2;
    }
  });
  if (total === 0 || triangles === 0) throw new ModelRefusal(MODEL_WORDS.notModel);
  const bounds: Bounds = { min, max };

  const source: TriangleSource = async (sink) => {
    let seen = 0;
    const p = new Float64Array(9);
    const put = (slot: number, at: number) => {
      const block = blocks[at >> BLOCK_BITS]!;
      const o = (at & (BLOCK - 1)) * 3;
      p[slot * 3] = block[o]!;
      p[slot * 3 + 1] = block[o + 1]!;
      p[slot * 3 + 2] = block[o + 2]!;
    };
    await eachLine(file, (bytes, start, end) => {
      let i = skipSpace(bytes, start, end);
      const kind = lineKind(bytes, i, end);
      if (kind === "v") {
        seen++;
        return;
      }
      if (kind !== "f") return;
      i += 1;
      let corners = 0;
      for (;;) {
        const at = cornerAt(bytes, i, end, seen, total, next);
        if (at < 0) break;
        i = next[0]!;
        // p's first slot keeps the face's first corner and its second the one before this, so the face fans out from the first.
        put(corners === 0 ? 0 : corners === 1 ? 1 : 2, at);
        if (corners >= 2) {
          sink(p[0]!, p[1]!, p[2]!, p[3]!, p[4]!, p[5]!, p[6]!, p[7]!, p[8]!);
          p[3] = p[6]!;
          p[4] = p[7]!;
          p[5] = p[8]!;
        }
        corners++;
      }
    });
  };
  const mesh = await clusterMesh(source, bounds, triangles, limits);
  return {
    axes: "zUp",
    parts: [{ positions: mesh.positions, normals: mesh.normals, index: mesh.index, uvs: null, colors: null, material: PLAIN }],
    textures: [],
    colorable: true,
    notes: [],
    triangles: mesh.index.length / 3,
  };
}
