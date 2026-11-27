import { MODEL_LIMITS } from "#shared/limits.ts";
import { MODEL_WORDS, ModelRefusal } from "./mesh.ts";

/**
 * Vertex clustering for STL and OBJ (docs/design/design-v1-token-models.md 5,
 * D-261127-172, 374, 419). Each vertex falls in a cell of a grid over the
 * model's box, each cell becomes one vertex at the mean of those in it, and
 * a triangle whose corners fall in three cells survives. A grid of G cells
 * a side leaves about 4 G² triangles on a figure, so the first pass's grid
 * is √(250,000 / 4) cells. A model already under the target is only welded,
 * on a 4,096 grid, so STL's repeated corners become shared vertices with
 * smooth normals.
 *
 * Every array is allocated once, at its cap, before the first pass: the
 * cell table, the cells' sums and the candidate triangles. A pass that
 * reaches a cap stops at once and the next takes half the grid, so a
 * hostile file costs the caps' memory and at most `passes` reads, never
 * more. Cells live in an open-addressing table keyed by Float64, since a
 * 4,096 grid's keys need about 36 bits.
 */

export type Bounds = { min: [number, number, number]; max: [number, number, number] };

/** One triangle's corners. */
export type TriangleSink = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number) => void;

/** One full pass over a file's triangles, in the same order every time. */
export type TriangleSource = (sink: TriangleSink) => Promise<void>;

export type ClusterLimits = { triangles: number; slots: number; cells: number; candidates: number; passes: number; weldGrid: number };

export const CLUSTER_LIMITS: ClusterLimits = {
  triangles: MODEL_LIMITS.clusterTriangles,
  slots: MODEL_LIMITS.clusterSlots,
  cells: MODEL_LIMITS.clusterCells,
  candidates: MODEL_LIMITS.clusterCandidates,
  passes: MODEL_LIMITS.clusterPasses,
  weldGrid: MODEL_LIMITS.weldGrid,
};

export type Clustered = {
  positions: Float32Array;
  index: Uint32Array;
  normals: Float32Array;
  /** The grid of the pass kept, and the passes run, for the report and the tests. */
  grid: number;
  passes: number;
};

/** Thrown from the sink when a pass reaches a cap, so the file's read stops at once. */
class PassFull extends Error {}

/**
 * Cells by key in a fixed open-addressing table, at most `maxCells` of
 * them. A slot holds -1 when empty: a key is never negative.
 */
export class CellTable {
  readonly keys: Float64Array;
  readonly ids: Int32Array;
  readonly #mask: number;
  readonly maxCells: number;
  cells = 0;

  constructor(slots: number, maxCells: number) {
    if (slots & (slots - 1) || maxCells >= slots) throw new Error("the table's slots are a power of two above its cells");
    this.keys = new Float64Array(slots).fill(-1);
    this.ids = new Int32Array(slots);
    this.#mask = slots - 1;
    this.maxCells = maxCells;
  }

  reset(): void {
    this.keys.fill(-1);
    this.cells = 0;
  }

  /** The cell's id, made when new, or -1 when the table holds `maxCells` already. */
  idOf(ix: number, iy: number, iz: number, key: number): number {
    // Murmur's finisher spreads the grid's regular keys over the slots.
    let h = Math.imul(ix, 0x9e3779b1) ^ Math.imul(iy, 0x85ebca77) ^ Math.imul(iz, 0xc2b2ae3d);
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    const keys = this.keys;
    const mask = this.#mask;
    for (let s = h & mask; ; s = (s + 1) & mask) {
      const k = keys[s]!;
      if (k === key) return this.ids[s]!;
      if (k === -1) {
        if (this.cells >= this.maxCells) return -1;
        keys[s] = key;
        this.ids[s] = this.cells;
        return this.cells++;
      }
    }
  }
}

/** The box's longest side, refused when the model has no size. */
export function extentOf(bounds: Bounds): number {
  const ext = Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]);
  if (!(ext > 0) || !Number.isFinite(ext)) throw new ModelRefusal(MODEL_WORDS.notModel);
  return ext;
}

/** A pass's result: its candidate count, or null when it reached a cap. */
type Pass = { triangles: number } | null;

/**
 * Clusters a file's triangles to at most `limits.triangles`, reading the
 * file once per pass. `triangles` is the file's own count, from the box's
 * pass. Refuses in words when four passes cannot get under the target.
 */
export async function clusterMesh(source: TriangleSource, bounds: Bounds, triangles: number, limits: ClusterLimits = CLUSTER_LIMITS): Promise<Clustered> {
  const ext = extentOf(bounds);
  const table = new CellTable(limits.slots, limits.cells);
  const sums = new Float64Array(limits.cells * 3);
  const counts = new Uint32Array(limits.cells);
  const tris = new Uint32Array(limits.candidates * 3);
  const [minX, minY, minZ] = bounds.min;

  const pass = async (G: number): Promise<Pass> => {
    table.reset();
    const inv = G / ext;
    const side = G + 1;
    let m = 0;
    const cell = (x: number, y: number, z: number): number => {
      const ix = Math.min(G, Math.max(0, Math.floor((x - minX) * inv)));
      const iy = Math.min(G, Math.max(0, Math.floor((y - minY) * inv)));
      const iz = Math.min(G, Math.max(0, Math.floor((z - minZ) * inv)));
      const before = table.cells;
      const id = table.idOf(ix, iy, iz, ix + side * (iy + side * iz));
      if (id < 0) throw new PassFull();
      const at = id * 3;
      if (id === before) {
        sums[at] = x;
        sums[at + 1] = y;
        sums[at + 2] = z;
        counts[id] = 1;
      } else {
        sums[at]! += x;
        sums[at + 1]! += y;
        sums[at + 2]! += z;
        counts[id]!++;
      }
      return id;
    };
    try {
      await source((ax, ay, az, bx, by, bz, cx, cy, cz) => {
        const a = cell(ax, ay, az);
        const b = cell(bx, by, bz);
        const c = cell(cx, cy, cz);
        if (a === b || b === c || a === c) return;
        if (m >= limits.candidates) throw new PassFull();
        tris[m * 3] = a;
        tris[m * 3 + 1] = b;
        tris[m * 3 + 2] = c;
        m++;
      });
    } catch (err) {
      if (err instanceof PassFull) return null;
      throw err;
    }
    return { triangles: m };
  };

  const target = limits.triangles;
  let G = triangles <= target ? limits.weldGrid : Math.max(1, Math.round(Math.sqrt(target / 4)));
  let kept: Clustered | null = null;
  for (let passes = 1; passes <= limits.passes; passes++) {
    const result = await pass(G);
    if (result === null) {
      if (kept) return kept;
      G = Math.max(1, Math.floor(G / 2));
      continue;
    }
    if (result.triangles > target) {
      if (kept) return kept;
      G = Math.max(1, Math.min(G - 1, Math.floor(G * Math.sqrt(target / result.triangles) * 0.95)));
      continue;
    }
    const built = build(table.cells, result.triangles, G, passes);
    if (built.index.length === 0) throw new ModelRefusal(MODEL_WORDS.notModel);
    // A far coarser result than the target keeps less detail than the sheet can show: one finer pass, kept only if it fits.
    const finer = Math.min(limits.weldGrid, Math.floor(G * Math.sqrt(target / (built.index.length / 3)) * 0.9));
    if (kept || triangles <= target || built.index.length / 3 >= 0.4 * target || passes === limits.passes || finer <= G) return built;
    kept = built;
    G = finer;
  }
  if (kept) return kept;
  throw new ModelRefusal(MODEL_WORDS.tooComplex);

  /** The kept cells' means and the triangles over them, without unused cells or zero-area triangles. */
  function build(cells: number, m: number, grid: number, passes: number): Clustered {
    const means = new Float32Array(cells * 3);
    for (let id = 0; id < cells; id++) {
      const n = counts[id]!;
      means[id * 3] = sums[id * 3]! / n;
      means[id * 3 + 1] = sums[id * 3 + 1]! / n;
      means[id * 3 + 2] = sums[id * 3 + 2]! / n;
    }
    const remap = new Int32Array(cells).fill(-1);
    let used = 0;
    let kept = 0;
    const index = new Uint32Array(m * 3);
    for (let t = 0; t < m; t++) {
      const a = tris[t * 3]!;
      const b = tris[t * 3 + 1]!;
      const c = tris[t * 3 + 2]!;
      if (area2(means, a, b, c) === 0) continue;
      for (const id of [a, b, c]) if (remap[id] === -1) remap[id] = used++;
      index[kept * 3] = remap[a]!;
      index[kept * 3 + 1] = remap[b]!;
      index[kept * 3 + 2] = remap[c]!;
      kept++;
    }
    const positions = new Float32Array(used * 3);
    for (let id = 0; id < cells; id++) {
      const to = remap[id]!;
      if (to < 0) continue;
      positions[to * 3] = means[id * 3]!;
      positions[to * 3 + 1] = means[id * 3 + 1]!;
      positions[to * 3 + 2] = means[id * 3 + 2]!;
    }
    const tight = index.slice(0, kept * 3);
    return { positions, index: tight, normals: vertexNormals(positions, tight), grid, passes };
  }
}

/** Twice a triangle's area, squared: zero for a degenerate one. */
function area2(p: Float32Array, a: number, b: number, c: number): number {
  const ux = p[b * 3]! - p[a * 3]!;
  const uy = p[b * 3 + 1]! - p[a * 3 + 1]!;
  const uz = p[b * 3 + 2]! - p[a * 3 + 2]!;
  const vx = p[c * 3]! - p[a * 3]!;
  const vy = p[c * 3 + 1]! - p[a * 3 + 1]!;
  const vz = p[c * 3 + 2]! - p[a * 3 + 2]!;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  return nx * nx + ny * ny + nz * nz;
}

/** Smooth unit normals of an indexed mesh, each face weighted by its area. A vertex whose faces cancel points up its file's Z. */
export function vertexNormals(positions: Float32Array, index: Uint32Array): Float32Array {
  const sum = new Float64Array(positions.length);
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t]! * 3;
    const b = index[t + 1]! * 3;
    const c = index[t + 2]! * 3;
    const ux = positions[b]! - positions[a]!;
    const uy = positions[b + 1]! - positions[a + 1]!;
    const uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!;
    const vy = positions[c + 1]! - positions[a + 1]!;
    const vz = positions[c + 2]! - positions[a + 2]!;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) {
      sum[v]! += nx;
      sum[v + 1]! += ny;
      sum[v + 2]! += nz;
    }
  }
  const out = new Float32Array(positions.length);
  for (let v = 0; v < out.length; v += 3) {
    const len = Math.hypot(sum[v]!, sum[v + 1]!, sum[v + 2]!);
    if (len > 0) {
      out[v] = sum[v]! / len;
      out[v + 1] = sum[v + 1]! / len;
      out[v + 2] = sum[v + 2]! / len;
    } else out[v + 2] = 1;
  }
  return out;
}

/** A run of triangles in a non-indexed part whose normals are to be made: triangles `from` to `to`. */
export type NormalSpan = { positions: Float32Array; normals: Float32Array; from: number; to: number };

/**
 * Smooth normals for a GLB's triangles that came without any (D-261127-477,
 * 517): their corners welded on the weld grid over their own box, each cell
 * summing its faces' area-weighted normals. Past the table's cells, or
 * where a cell's faces cancel, a corner takes its face's normal.
 */
export function weldNormals(spans: readonly NormalSpan[], limits: ClusterLimits = CLUSTER_LIMITS): void {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let corners = 0;
  for (const s of spans) {
    for (let i = s.from * 9; i < s.to * 9; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = s.positions[i + k]!;
        if (v < min[k]!) min[k] = v;
        if (v > max[k]!) max[k] = v;
      }
    }
    corners += (s.to - s.from) * 3;
  }
  if (corners === 0) return;
  const ext = Math.max(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!);
  const table = new CellTable(limits.slots, limits.cells);
  const G = limits.weldGrid;
  const inv = ext > 0 ? G / ext : 0;
  const side = G + 1;
  const ids = new Int32Array(corners);
  let welded = true;
  let c = 0;
  for (const s of spans) {
    for (let i = s.from * 9; i < s.to * 9 && welded; i += 3) {
      const ix = Math.min(G, Math.floor((s.positions[i]! - min[0]!) * inv));
      const iy = Math.min(G, Math.floor((s.positions[i + 1]! - min[1]!) * inv));
      const iz = Math.min(G, Math.floor((s.positions[i + 2]! - min[2]!) * inv));
      const id = table.idOf(ix, iy, iz, ix + side * (iy + side * iz));
      if (id < 0) welded = false;
      ids[c++] = id;
    }
  }
  const sums = welded ? new Float64Array(table.cells * 3) : null;
  const face = [0, 0, 0];
  if (sums) {
    c = 0;
    for (const s of spans) {
      for (let t = s.from; t < s.to; t++) {
        faceNormal(s.positions, t * 9, face, false);
        for (let k = 0; k < 3; k++) {
          const at = ids[c++]! * 3;
          sums[at]! += face[0]!;
          sums[at + 1]! += face[1]!;
          sums[at + 2]! += face[2]!;
        }
      }
    }
  }
  c = 0;
  for (const s of spans) {
    for (let t = s.from; t < s.to; t++) {
      faceNormal(s.positions, t * 9, face, true);
      for (let k = 0; k < 3; k++) {
        const o = t * 9 + k * 3;
        const at = sums ? ids[c]! * 3 : -1;
        c++;
        const len = sums ? Math.hypot(sums[at]!, sums[at + 1]!, sums[at + 2]!) : 0;
        if (sums && len > 0) {
          s.normals[o] = sums[at]! / len;
          s.normals[o + 1] = sums[at + 1]! / len;
          s.normals[o + 2] = sums[at + 2]! / len;
        } else {
          s.normals[o] = face[0]!;
          s.normals[o + 1] = face[1]!;
          s.normals[o + 2] = face[2]!;
        }
      }
    }
  }
}

/**
 * A non-indexed triangle's normal, from its winding, into `out`: its area
 * weight, or a unit vector when `unit` (up the Y axis for a triangle with
 * no area, which draws nothing).
 */
export function faceNormal(p: Float32Array, o: number, out: number[], unit: boolean): void {
  const ux = p[o + 3]! - p[o]!;
  const uy = p[o + 4]! - p[o + 1]!;
  const uz = p[o + 5]! - p[o + 2]!;
  const vx = p[o + 6]! - p[o]!;
  const vy = p[o + 7]! - p[o + 1]!;
  const vz = p[o + 8]! - p[o + 2]!;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  if (unit) {
    const len = Math.hypot(nx, ny, nz);
    if (len > 0) {
      nx /= len;
      ny /= len;
      nz /= len;
    } else {
      nx = 0;
      ny = 1;
      nz = 0;
    }
  }
  out[0] = nx;
  out[1] = ny;
  out[2] = nz;
}
