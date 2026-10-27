import { CHUNK_CELLS, FOG_SUBCELLS } from "#shared/model.ts";
import { coverageCacheKey, eachHexPrism, MAX_SCENE_CELLS, resolveArea, type AreaContext, type AreaSolid, type AreaTemplateInput, type HexPrism, type ResolvedArea, type SolidBox } from "#shared/rules/aoe.ts";
import type { Point3 } from "#shared/rules/geom.ts";
import { cornerAt, hexAt, hexCenter, hexCorners } from "#shared/rules/hex.ts";
import { crossingsAt, insideCrossings, type Polygon, type PolygonIndex } from "#shared/rules/walls.ts";
import { K, turnAxes, type Turn } from "../../lib/view.ts";

/**
 * An area's solid as a mesh, for Isometric to stand it at its real shape
 * (docs/design-v1-iso-area-shapes.md 4.2). The solid is the rules' own
 * (`ResolvedArea.solid`), cut by the area's wall polygons, the scene's
 * edges and the drawn ground, so what stands is what catches. It is built
 * in slices a frame can take, each stopping at a deadline and carrying on
 * at the next call:
 *
 * - `prepare`: the solid tessellated closed and wound outward, every face
 *   cut by the whole line of every polygon edge and scene edge across its
 *   plan, the pieces whose middle lies outside the clip dropped, and each
 *   clip line's open edges closed into caps from the shell's own vertices,
 *   so shell and caps share every vertex. Then the stand rule's footprint
 *   read from that plan, and each face cut by the 16 by 16 bucket lines
 *   across it and filed.
 * - `ensure`, per bucket when it first comes into view: the whole cell
 *   lines where the drawn ground steps and the level planes at each ground
 *   height under it, the pieces at or below their cell's ground dropped
 *   (inside a pit's opening that ground is its floor), then the two
 *   families of band planes, so a piece lies in one depth band at every
 *   turn, and last each face's neighbors across its edges.
 *
 * Every cut is a plane, and every new vertex is made once per edge and
 * plane from the edge's ends in a fixed order, so the two faces beside an
 * edge share it and the mesh stays closed after any cut, but for the
 * edges that lie on the drawn ground (the ground omissions). Each face
 * takes its cuts in one global order, clip lines, bucket lines, ground
 * lines, levels, then the bands, so the two faces beside an edge part it
 * at the same vertices whenever their buckets are cut.
 */

/** Within this of a plane a vertex lies on it. */
const EPS = 1e-9;
/** Within this an edge lies on a clip line, the ground or a corner. */
const ON = 1e-7;
/** How far a face's middle moves into the solid before the clip and the ground are read there, so a face lying on a line takes the side the solid is on. No piece is thinner than EPS, so this never moves a middle out of its piece. */
const NUDGE = 1e-10;
/** Vertex ids are below this, so a pair of them is one number. */
const VMAX = 67108864;
/** More than any face's vertices, so a face and a place in it are one number. */
const SLOTS = 65536;
const R = Math.SQRT1_2;
/** Faces meeting at more than 35 degrees make a crease (design 4.2 step 7). */
const CREASE_COS = Math.cos((35 * Math.PI) / 180);

/** Plane id ranges, one per kind, in the order the cuts run. */
const BUCKET_X = 1e5;
const BUCKET_Y = 2e5;
const GROUND_X = 3e5;
const GROUND_Y = 4e5;
const LEVEL = 5e5;
const BAND = 6e5;
/** Band indices run from -BAND_SPAN, more than the deepest a 200 cell scene reaches. */
const BAND_SPAN = 4096;

/**
 * Work between looks at the clock, in rough units of a vertex touched or
 * a cell read. Every loop of the build charges what it does, and no one
 * charge is more than a few hundred units, so a slice runs past its
 * deadline by at most about CHECK plus one step.
 */
const CHECK = 128;

/** A build that stops once its budget's deadline has passed, and carries on when it is next asked. */
type Job<T = void> = Generator<void, T, void>;

/** Tells a build when it has run past its deadline, looking at the clock once every so much work. */
class Budget {
  /** A `performance.now()` time. */
  deadline = Infinity;
  /** Every unit charged so far. */
  total = 0;
  #n = 0;

  /** Counts `c` more work, true when the build should stop for now. */
  spend(c: number): boolean {
    this.total += c;
    this.#n += c;
    if (this.#n < CHECK) return false;
    this.#n = 0;
    return performance.now() > this.deadline;
  }
}

/** Sub-cells are read a hair inside a float's cell, so a vertex an ulp off a cell line takes no sub-cell past it. */
const SUB_SNAP = 1e-7;

function subFloor(v: number): number {
  return Math.floor(v * FOG_SUBCELLS + SUB_SNAP);
}

function subCeil(v: number): number {
  return Math.ceil(v * FOG_SUBCELLS - SUB_SNAP);
}

/** `a x + b y + c z - e`, zero on the plane. `snap` puts a new vertex exactly on an axis plane: 1 at x = e, 2 at y = e, 3 at z = e. */
type Plane = { id: number; a: number; b: number; c: number; e: number; snap: 0 | 1 | 2 | 3 };

/** A face while it is being cut: a convex polygon, its outward normal (its parent's), and whether it caps a clip line. */
type Poly = { v: number[]; nx: number; ny: number; nz: number; cap: boolean };

/** A guide piece: a segment on the surface and the solid's outward level normal there. */
type Guide = { ax: number; ay: number; az: number; bx: number; by: number; bz: number; nx: number; ny: number };

export type WorldBox = { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number };

/**
 * The stand rule's footprint (design 4.2 step 9): every fog sub-cell under
 * the plan of the capped shell, before the ground cut, so a sub-cell whose
 * column hides the solid still counts. Each run is a row `sy` from `sx0`
 * up to `sx1`, the far end excluded.
 */
export type Footprint = { runs: Int32Array; count: number };

/** A face of the finished mesh. */
export type VolumeFace = {
  v: Int32Array;
  nx: number;
  ny: number;
  nz: number;
  cap: boolean;
  /** Its bucket, by index into `Volume.keys`, and its place in that bucket's list. */
  bucket: number;
  local: number;
  /** The face beside each edge (v[k], v[k + 1]), or -1: open on the ground, or beside a bucket not yet cut. */
  nb: Int32Array;
};

/** A line the drawing strokes: solid beside a near face, dashed beside only far ones (design 5). */
export type VolumeLine = {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  kind: "silhouette" | "cap" | "crease" | "ground" | "guide";
  near: boolean;
};

export type VolumeInput = {
  area: ResolvedArea;
  /** The scene's size in cells. */
  bounds: { w: number; h: number };
  /** The drawn ground in cells of height at a cell (view.ts DrawnHeights.at), never real heights. */
  ground: (x: number, y: number) => number;
  /** Screen pixels a cell at the zoom octave the mesh is built for. */
  px: number;
  /** 16 around, while it moves (design 4.2 step 1). */
  coarse?: boolean;
  /** Cut into depth bands, false for a volume drawn whole in the drag layer while it is aimed. */
  banded?: boolean;
};

/** Segments around a circle of `r` cells: a chord strays about a pixel at this zoom, 16 to 64 (design 4.2 step 1). */
export function segmentsAround(r: number, px: number, coarse = false): number {
  if (coarse) return 16;
  const n = 4 * Math.ceil((Math.PI * Math.sqrt(Math.max(0, r * px))) / 4);
  return Math.min(64, Math.max(16, n));
}

/** The zoom a mesh is built for: the power of two at or below it, so it is rebuilt only when the zoom crosses a factor of 2. */
export function zoomOctave(px: number): number {
  return px > 0 && Number.isFinite(px) ? 2 ** Math.floor(Math.log2(px)) : 1;
}

/** How near a face at this turn looks: toward the viewer when positive (design 4.2 step 7). */
export function towardViewer(turn: Turn, nx: number, ny: number, nz: number): number {
  const { c, s } = turnAxes(turn);
  return nx * K * s + ny * K * c + nz * 0.5;
}

/** A point's depth band at a turn: the whole cells of depth before it (view.ts depth). */
export function bandAt(turn: Turn, x: number, y: number): number {
  const { c, s } = turnAxes(turn);
  return Math.floor(s * x + c * y);
}

/** A band's key in the depth list: its middle. */
export function bandKey(band: number): number {
  return band + 0.5;
}

// ---------------------------------------------------------------- vertices and cuts

class Store {
  p = new Float64Array(3 * 4096);
  n = 0;
  readonly cuts = new Map<number, Map<number, number>>();
  /** The plan box of every vertex made, the shell's since every cut lies inside it. */
  readonly plan = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  /** Hexes a hex stack's walk has visited, counted apart from the budget for the tests. */
  visits = 0;

  add(x: number, y: number, z: number): number {
    if (3 * (this.n + 1) > this.p.length) {
      const next = new Float64Array(this.p.length * 2);
      next.set(this.p);
      this.p = next;
    }
    const plan = this.plan;
    if (x < plan.x0) plan.x0 = x;
    if (x > plan.x1) plan.x1 = x;
    if (y < plan.y0) plan.y0 = y;
    if (y > plan.y1) plan.y1 = y;
    const i = this.n++;
    this.p[3 * i] = x;
    this.p[3 * i + 1] = y;
    this.p[3 * i + 2] = z;
    return i;
  }

  d(pl: Plane, i: number): number {
    return pl.a * this.p[3 * i]! + pl.b * this.p[3 * i + 1]! + pl.c * this.p[3 * i + 2]! - pl.e;
  }

  /** The vertices made on edges by a plane, by the edge's ends. */
  cutsBy(pl: Plane): Map<number, number> {
    let cache = this.cuts.get(pl.id);
    if (!cache) this.cuts.set(pl.id, (cache = new Map()));
    return cache;
  }

  /** The vertex where edge i, j crosses a plane, made once from the lower id's end. */
  cut(pl: Plane, cache: Map<number, number>, i: number, j: number, di: number, dj: number): number {
    if (i > j) {
      [i, j] = [j, i];
      [di, dj] = [dj, di];
    }
    const key = i * VMAX + j;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const t = di / (di - dj);
    const p = this.p;
    let x = p[3 * i]! + t * (p[3 * j]! - p[3 * i]!);
    let y = p[3 * i + 1]! + t * (p[3 * j + 1]! - p[3 * i + 1]!);
    let z = p[3 * i + 2]! + t * (p[3 * j + 2]! - p[3 * i + 2]!);
    if (pl.snap === 1) x = pl.e;
    else if (pl.snap === 2) y = pl.e;
    else if (pl.snap === 3) z = pl.e;
    const id = this.add(x, y, z);
    cache.set(key, id);
    return id;
  }
}

function side(d: number): number {
  return d > EPS ? 1 : d < -EPS ? -1 : 0;
}

/**
 * A convex polygon cut by a plane: the part on its positive side and the
 * part on its negative side, either null when nothing lies there. A run of
 * vertices on the plane between the two sides goes whole to the positive
 * part and only its end beside the negative side to the negative part, so
 * a tiny edge lying along the plane, where rounding has made the polygon
 * seem to cross it twice, still belongs to one part, and the two parts
 * share their cut edge.
 */
function splitPoly(st: Store, poly: Poly, pl: Plane): [Poly | null, Poly | null] {
  const v = poly.v;
  const n = v.length;
  if (n > SCRATCH.d.length) growScratch(n);
  const d = SCRATCH.d;
  const s = SCRATCH.s;
  let pos = false;
  let neg = false;
  let on = false;
  const p = st.p;
  for (let k = 0; k < n; k++) {
    const i = v[k]!;
    const dk = pl.a * p[3 * i]! + pl.b * p[3 * i + 1]! + pl.c * p[3 * i + 2]! - pl.e;
    d[k] = dk;
    if (dk > EPS) {
      s[k] = 1;
      pos = true;
    } else if (dk < -EPS) {
      s[k] = -1;
      neg = true;
    } else {
      s[k] = 0;
      on = true;
    }
  }
  if (!neg) return [poly, null];
  if (!pos) return [null, poly];
  const cache = st.cutsBy(pl);
  const a: number[] = [];
  const b: number[] = [];
  if (on) {
    // The side of the nearest vertex off the plane before and after each one.
    const before = SCRATCH.before;
    const after = SCRATCH.after;
    for (let pass = 0, last = 0; pass < 2; pass++) {
      for (let k = 0; k < n; k++) {
        if (pass === 1) before[k] = last;
        if (s[k] !== 0) last = s[k]!;
      }
    }
    for (let pass = 0, last = 0; pass < 2; pass++) {
      for (let k = n - 1; k >= 0; k--) {
        if (pass === 1) after[k] = last;
        if (s[k] !== 0) last = s[k]!;
      }
    }
    for (let k = 0; k < n; k++) {
      const i = v[k]!;
      const sk = s[k]!;
      const next = k + 1 === n ? 0 : k + 1;
      if (sk > 0) a.push(i);
      else if (sk < 0) b.push(i);
      else {
        const prev = k === 0 ? n - 1 : k - 1;
        if (before[k] === 1 || after[k] === 1) a.push(i);
        if ((before[k] === -1 && after[k] === -1) || s[prev] === -1 || s[next] === -1) b.push(i);
      }
      if (sk * s[next]! < 0) {
        const r = st.cut(pl, cache, i, v[next]!, d[k]!, d[next]!);
        a.push(r);
        b.push(r);
      }
    }
  } else {
    for (let k = 0; k < n; k++) {
      const i = v[k]!;
      const sk = s[k]!;
      const next = k + 1 === n ? 0 : k + 1;
      if (sk > 0) a.push(i);
      else b.push(i);
      if (sk !== s[next]) {
        const r = st.cut(pl, cache, i, v[next]!, d[k]!, d[next]!);
        a.push(r);
        b.push(r);
      }
    }
  }
  return [
    { v: a, nx: poly.nx, ny: poly.ny, nz: poly.nz, cap: poly.cap },
    { v: b, nx: poly.nx, ny: poly.ny, nz: poly.nz, cap: poly.cap },
  ];
}

/** Buffers `splitPoly` reuses, so a cut allocates only the two parts it makes. */
const SCRATCH = { d: new Float64Array(64), s: new Int8Array(64), before: new Int8Array(64), after: new Int8Array(64) };

function growScratch(n: number): void {
  const size = 2 ** Math.ceil(Math.log2(n));
  SCRATCH.d = new Float64Array(size);
  SCRATCH.s = new Int8Array(size);
  SCRATCH.before = new Int8Array(size);
  SCRATCH.after = new Int8Array(size);
}

/** A face cut by planes in their order, a cut at a time, so a face many planes cross is many steps: the pieces cutting every piece by each plane in turn makes. */
function* cutEach(st: Store, face: Poly, planes: readonly Plane[], budget: Budget): Job<Poly[]> {
  const out: Poly[] = [];
  const todo: Poly[] = [face];
  const todoAt: number[] = [0];
  while (todo.length > 0) {
    let p = todo.pop()!;
    for (let k = todoAt.pop()!; k < planes.length; k++) {
      if (budget.spend(p.v.length)) yield;
      const [above, below] = splitPoly(st, p, planes[k]!);
      if (above && below) {
        todo.push(below);
        todoAt.push(k + 1);
      }
      p = (above ?? below)!;
    }
    out.push(p);
  }
  return out;
}

function centroid(st: Store, v: readonly number[] | Int32Array): [number, number, number] {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const i of v) {
    x += st.p[3 * i]!;
    y += st.p[3 * i + 1]!;
    z += st.p[3 * i + 2]!;
  }
  const n = v.length;
  return [x / n, y / n, z / n];
}

/** The plan point a face's clip and ground are read at: its middle, a hair into the solid. */
function readPoint(st: Store, p: Poly): [number, number, number] {
  const [x, y, z] = centroid(st, p.v);
  return [x - NUDGE * p.nx, y - NUDGE * p.ny, z];
}

/** Whether a face lies at or below the ground of the cell its middle is read in (design 4.2 step 4). */
function onOrBelow(st: Store, p: Poly, ground: (x: number, y: number) => number): boolean {
  const v = p.v;
  const pts = st.p;
  let x = 0;
  let y = 0;
  let top = -Infinity;
  for (const i of v) {
    x += pts[3 * i]!;
    y += pts[3 * i + 1]!;
    if (pts[3 * i + 2]! > top) top = pts[3 * i + 2]!;
  }
  const g = ground(Math.floor(x / v.length - NUDGE * p.nx), Math.floor(y / v.length - NUDGE * p.ny));
  return top <= g + EPS;
}

// ---------------------------------------------------------------- tessellation

/** cos and sin of k / n turns, exact at every quarter turn, so a vertex at a quarter lies exactly on the axis through the center. */
function trig(k: number, n: number): [number, number] {
  const kk = ((k % n) + n) % n;
  const q = Math.floor((4 * kk) / n);
  const rem = kk - (q * n) / 4;
  const t = (2 * Math.PI * rem) / n;
  const c0 = rem === 0 ? 1 : Math.cos(t);
  const s0 = rem === 0 ? 0 : Math.sin(t);
  switch (q) {
    case 0:
      return [c0, s0];
    case 1:
      return [-s0, c0];
    case 2:
      return [-c0, -s0];
    default:
      return [s0, -c0];
  }
}

/** A face from vertex ids with its normal by Newell's method, wound so the normal points away from `center`. */
function facing(st: Store, ids: number[], center: Point3, cap = false): Poly | null {
  const v: number[] = [];
  for (const i of ids) if (v.length === 0 || v[v.length - 1] !== i) v.push(i);
  while (v.length > 1 && v[0] === v[v.length - 1]) v.pop();
  if (v.length < 3) return null;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  const p = st.p;
  for (let k = 0; k < v.length; k++) {
    const i = v[k]!;
    const j = v[(k + 1) % v.length]!;
    nx += (p[3 * i + 1]! - p[3 * j + 1]!) * (p[3 * i + 2]! + p[3 * j + 2]!);
    ny += (p[3 * i + 2]! - p[3 * j + 2]!) * (p[3 * i]! + p[3 * j]!);
    nz += (p[3 * i]! - p[3 * j]!) * (p[3 * i + 1]! + p[3 * j + 1]!);
  }
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-14) return null;
  nx /= len;
  ny /= len;
  nz /= len;
  const [cx, cy, cz] = centroid(st, v);
  if (nx * (cx - center.x) + ny * (cy - center.y) + nz * (cz - center.z) < 0) {
    v.reverse();
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  return { v, nx, ny, nz, cap };
}

type Shell = { polys: Poly[]; guides: Guide[]; convex: boolean; segments: number };

/**
 * A hex corner as one number: corners lie on the 1/64 cell lattice, well
 * within a 200 cell scene. Numbers, not strings, so the maps of a stack
 * of a hundred thousand prisms make no garbage per look and grow cheaply.
 */
function cornerKey(p: { x: number; y: number }): number {
  return (Math.round(p.x * 64) + 8192) * 32768 + (Math.round(p.y * 64) + 8192);
}

/** A point of a box's frame: c + u e0 + v e1 + w e2. */
function inFrame(b: SolidBox, u: number, v: number, w: number): [number, number, number] {
  const [e0, e1, e2] = b.axes;
  return [b.c.x + u * e0.x + v * e1.x + w * e2.x, b.c.y + u * e0.y + v * e1.y + w * e2.y, b.c.z + u * e0.z + v * e1.z + w * e2.z];
}

/**
 * A box grown by D, a sphere when the box has no size: the grid of a UV
 * sphere with its quarter longitudes and its equator doubled, each copy
 * moved out to its octant's corner of the box, so the seams between the
 * copies are the box's flat faces and the rounded edges between them. The
 * poles' copies close with the box's top and bottom. Points that land on
 * one another (a box with no size along an axis) merge, and the faces they
 * flatten go.
 */
function* roundedShell(st: Store, box: SolidBox, D: number, n: number, budget: Budget): Job<Shell> {
  const [hx, hy, hz] = box.half;
  const quarter = n / 4;
  // Columns: each quadrant's longitudes, its two ends included.
  const cols: { k: number; sx: number; sy: number }[] = [];
  for (let q = 0; q < 4; q++) {
    const sx = q === 0 || q === 3 ? 1 : -1;
    const sy = q < 2 ? 1 : -1;
    for (let j = q * quarter; j <= (q + 1) * quarter; j++) cols.push({ k: j, sx, sy });
  }
  // Rows: latitudes from the south pole to the equator, then the equator again to the north pole.
  const rows: { i: number; sz: number }[] = [];
  for (let i = 0; i <= n / 4; i++) rows.push({ i, sz: -1 });
  for (let i = n / 4; i <= n / 2; i++) rows.push({ i, sz: 1 });
  // A point's name: its latitude, its longitude but at a pole, and the corner of the box it is moved to on each axis the box has size along. Copies with one name are one point.
  const seen = new Map<number, number>();
  const grid: number[][] = [];
  for (const { i, sz } of rows) {
    const [ci, si] = trig(i, n);
    // Latitude -90 + i steps: its sine is -cos and its cosine sin of i steps.
    const sinLat = -ci;
    const cosLat = si;
    const pole = i === 0 || 2 * i === n;
    const row: number[] = [];
    for (const { k, sx, sy } of cols) {
      const corner = (hx > 0 && sx > 0 ? 1 : 0) + (hy > 0 && sy > 0 ? 2 : 0) + (hz > 0 && sz > 0 ? 4 : 0);
      const name = (i * n + (pole ? 0 : k % n)) * 8 + corner;
      let id = seen.get(name);
      if (id === undefined) {
        const [ck, sk] = trig(k, n);
        const [x, y, z] = inFrame(box, sx * hx + D * cosLat * ck, sy * hy + D * cosLat * sk, sz * hz + D * sinLat);
        seen.set(name, (id = st.add(x, y, z)));
      }
      row.push(id);
    }
    grid.push(row);
    if (budget.spend(cols.length)) yield;
  }
  const polys: Poly[] = [];
  const center = box.c;
  for (let r = 0; r + 1 < grid.length; r++) {
    for (let c = 0; c < cols.length; c++) {
      const d = (c + 1) % cols.length;
      const f = facing(st, [grid[r]![c]!, grid[r]![d]!, grid[r + 1]![d]!, grid[r + 1]![c]!], center);
      if (f) polys.push(f);
    }
    if (budget.spend(4 * cols.length)) yield;
  }
  for (const row of [grid[0]!, grid[grid.length - 1]!]) {
    const f = facing(st, row, center);
    if (f) polys.push(f);
  }
  // The guide: a ring at the shape's widest, its middle height (design ISOA-D9).
  const guides: Guide[] = [];
  const ring = cols.map(({ k, sx, sy }) => {
    const [ck, sk] = trig(k, n);
    const p = inFrame(box, sx * hx + D * ck, sy * hy + D * sk, 0);
    return { p, nx: ck * box.axes[0].x + sk * box.axes[1].x, ny: ck * box.axes[0].y + sk * box.axes[1].y };
  });
  for (let c = 0; c < ring.length; c++) {
    const a = ring[c]!;
    const b = ring[(c + 1) % ring.length]!;
    if (a.p[0] === b.p[0] && a.p[1] === b.p[1]) continue;
    const nx = (a.nx + b.nx) / 2;
    const ny = (a.ny + b.ny) / 2;
    const len = Math.hypot(nx, ny) || 1;
    guides.push({ ax: a.p[0], ay: a.p[1], az: a.p[2], bx: b.p[0], by: b.p[1], bz: b.p[2], nx: nx / len, ny: ny / len });
  }
  return { polys, guides, convex: true, segments: n };
}

function cylinderShell(st: Store, s: Extract<AreaSolid, { kind: "cylinder" }>, n: number): Shell {
  const bottom: number[] = [];
  const top: number[] = [];
  for (let j = 0; j < n; j++) {
    const [c, sn] = trig(j, n);
    bottom.push(st.add(s.c.x + s.r * c, s.c.y + s.r * sn, s.z0));
    top.push(st.add(s.c.x + s.r * c, s.c.y + s.r * sn, s.z1));
  }
  const center = { x: s.c.x, y: s.c.y, z: (s.z0 + s.z1) / 2 };
  const polys: Poly[] = [];
  for (let j = 0; j < n; j++) {
    const f = facing(st, [bottom[j]!, bottom[(j + 1) % n]!, top[(j + 1) % n]!, top[j]!], center);
    if (f) polys.push(f);
  }
  for (const ring of [bottom, top]) {
    const f = facing(st, ring, center);
    if (f) polys.push(f);
  }
  return { polys, guides: [], convex: true, segments: n };
}

function coneShell(st: Store, s: Extract<AreaSolid, { kind: "cone" }>, n: number): Shell {
  const apex = st.add(s.apex.x, s.apex.y, s.apex.z);
  const base = { x: s.apex.x + s.a.x * s.L, y: s.apex.y + s.a.y * s.L, z: s.apex.z + s.a.z * s.L };
  const half = s.L / 2;
  const rim: number[] = [];
  for (let j = 0; j < n; j++) {
    const [c, sn] = trig(j, n);
    rim.push(st.add(base.x + half * (c * s.n.x + sn * s.m.x), base.y + half * (c * s.n.y + sn * s.m.y), base.z + half * (c * s.n.z + sn * s.m.z)));
  }
  const center = { x: (s.apex.x + base.x) / 2, y: (s.apex.y + base.y) / 2, z: (s.apex.z + base.z) / 2 };
  const polys: Poly[] = [];
  for (let j = 0; j < n; j++) {
    const f = facing(st, [apex, rim[j]!, rim[(j + 1) % n]!], center);
    if (f) polys.push(f);
  }
  const f = facing(st, rim, center);
  if (f) polys.push(f);
  return { polys, guides: [], convex: true, segments: n };
}

function boxShell(st: Store, b: SolidBox): Shell {
  const [h0, h1, h2] = b.half;
  const corner = (i: number, j: number, k: number) => {
    const [x, y, z] = inFrame(b, i * h0, j * h1, k * h2);
    return st.add(x, y, z);
  };
  const v: number[][][] = [-1, 1].map((i) => [-1, 1].map((j) => [-1, 1].map((k) => corner(i, j, k))));
  const at = (i: number, j: number, k: number) => v[i]![j]![k]!;
  const quads = [
    [at(0, 0, 0), at(0, 1, 0), at(0, 1, 1), at(0, 0, 1)],
    [at(1, 0, 0), at(1, 1, 0), at(1, 1, 1), at(1, 0, 1)],
    [at(0, 0, 0), at(1, 0, 0), at(1, 0, 1), at(0, 0, 1)],
    [at(0, 1, 0), at(1, 1, 0), at(1, 1, 1), at(0, 1, 1)],
    [at(0, 0, 0), at(1, 0, 0), at(1, 1, 0), at(0, 1, 0)],
    [at(0, 0, 1), at(1, 0, 1), at(1, 1, 1), at(0, 1, 1)],
  ];
  const polys = quads.map((q) => facing(st, q, b.c)).filter((f): f is Poly => f !== null);
  return { polys, guides: [], convex: true, segments: 0 };
}

/**
 * A hex emanation's stack (design 4.6): a prism per hex, its top and
 * bottom whole, its sides only where the neighbor's interval leaves them
 * open. Each upright edge at a corner holds every height any hex at that
 * corner starts or ends at, so neighboring sides share their vertices.
 */
function* hexShell(st: Store, s: Extract<AreaSolid, { kind: "hexStack" }>, budget: Budget): Job<Shell> {
  const g = s.reach.g;
  const prisms: HexPrism[] = [];
  const corners: { x: number; y: number }[][] = [];
  // Hexes by column and row, as one number.
  const hexNumber = (h: { col: number; row: number }) => (h.col + 1024) * 4096 + (h.row + 1024);
  const byHex = new Map<number, HexPrism>();
  const heights = new Map<number, number[]>();
  for (const p of eachHexPrism(s)) {
    // A visit reads its steps from every source hex, a prism its corners too.
    st.visits++;
    if (budget.spend((p ? 12 : 1) + s.reach.from.length)) yield;
    if (!p) continue;
    const cs = hexCorners(g, p.hex).map((k) => cornerAt(g, k));
    prisms.push(p);
    corners.push(cs);
    byHex.set(hexNumber(p.hex), p);
    for (const c of cs) {
      const key = cornerKey(c);
      const list = heights.get(key);
      if (list) list.push(p.lo, p.hi);
      else heights.set(key, [p.lo, p.hi]);
    }
  }
  for (const list of heights.values()) {
    list.sort((a, b) => a - b);
    if (budget.spend(list.length)) yield;
  }
  // A vertex by its corner and its layer: elevations reach 100,000 ft, so at a foot a cell a layer lies within two million of 0.
  const seen = new Map<number, number>();
  const at = (c: { x: number; y: number }, z: number) => {
    const key = cornerKey(c) * 4194304 + (z + 2097152);
    let id = seen.get(key);
    if (id === undefined) seen.set(key, (id = st.add(c.x, c.y, z)));
    return id;
  };
  const between = (c: { x: number; y: number }, z0: number, z1: number) => (heights.get(cornerKey(c)) ?? []).filter((z, i, all) => z > z0 && z < z1 && (i === 0 || all[i - 1] !== z));
  const polys: Poly[] = [];
  for (let i = 0; i < prisms.length; i++) {
    const p = prisms[i]!;
    const cs = corners[i]!;
    const middle = hexCenter(g, p.hex);
    const center = { x: middle.x, y: middle.y, z: (p.lo + p.hi) / 2 };
    for (const z of [p.lo, p.hi]) {
      const f = facing(st, cs.map((c) => at(c, z)), center);
      if (f) polys.push(f);
    }
    for (let k = 0; k < 6; k++) {
      const a = cs[k]!;
      const b = cs[(k + 1) % 6]!;
      // The hex across this side has its center at this one's mirrored through the side's midpoint, near enough with the corners rounded to the lattice.
      const other = byHex.get(hexNumber(hexAt(g, { x: a.x + b.x - middle.x, y: a.y + b.y - middle.y })));
      const open: [number, number][] = [];
      if (!other || other.hi <= p.lo || other.lo >= p.hi) open.push([p.lo, p.hi]);
      else {
        if (other.lo > p.lo) open.push([p.lo, other.lo]);
        if (other.hi < p.hi) open.push([other.hi, p.hi]);
      }
      for (const [z0, z1] of open) {
        const ids = [at(a, z0), at(b, z0), ...between(b, z0, z1).map((z) => at(b, z)), at(b, z1), at(a, z1), ...between(a, z0, z1).reverse().map((z) => at(a, z))];
        const f = facing(st, ids, center);
        if (f) polys.push(f);
      }
    }
    if (budget.spend(96)) yield;
  }
  return { polys, guides: [], convex: false, segments: 6 };
}

function radiusOf(s: AreaSolid): number {
  switch (s.kind) {
    case "sphere":
      return s.r;
    case "cylinder":
      return s.r;
    case "cone":
      return s.L / 2;
    case "rounded":
      return s.D;
    default:
      return 0;
  }
}

/** The segments around a solid's mesh: none on a box, six on a hex stack's prisms. */
function segmentsOf(s: AreaSolid, n: number): number {
  return s.kind === "box" ? 0 : s.kind === "hexStack" ? 6 : n;
}

function* shellOf(st: Store, s: AreaSolid, n: number, budget: Budget): Job<Shell> {
  switch (s.kind) {
    case "sphere":
      return yield* roundedShell(st, { c: s.c, axes: AXES, half: [0, 0, 0] }, s.r, n, budget);
    case "rounded":
      return yield* roundedShell(st, s.box, s.D, n, budget);
    case "hexStack":
      return yield* hexShell(st, s, budget);
  }
  // A cylinder, a cone or a box: at most 64 faces round, one step.
  const shell = s.kind === "cylinder" ? cylinderShell(st, s, n) : s.kind === "cone" ? coneShell(st, s, n) : boxShell(st, s);
  if (budget.spend(4 * Math.max(1, n))) yield;
  return shell;
}

const AXES: readonly [Point3, Point3, Point3] = [
  { x: 1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: 0, z: 1 },
];

// ---------------------------------------------------------------- the clip and its caps

/** A vertical plane through a polygon edge or a scene edge, exactly on its axis when it is level with one. */
function lineThrough(id: number, ax: number, ay: number, bx: number, by: number): Plane | null {
  if (ax === bx && ay === by) return null;
  if (ax === bx) return { id, a: 1, b: 0, c: 0, e: ax, snap: 1 };
  if (ay === by) return { id, a: 0, b: 1, c: 0, e: ay, snap: 2 };
  const len = Math.hypot(bx - ax, by - ay);
  let a = (by - ay) / len;
  let b = (ax - bx) / len;
  if (a < 0 || (a === 0 && b < 0)) {
    a = -a;
    b = -b;
  }
  return { id, a, b, c: 0, e: a * ax + b * ay, snap: 0 };
}

/** Whether a vertical plane passes through a plan box. */
function crossesBox(pl: Plane, x0: number, y0: number, x1: number, y1: number): boolean {
  const d0 = pl.a * x0 + pl.b * y0 - pl.e;
  const d1 = pl.a * x1 + pl.b * y0 - pl.e;
  const d2 = pl.a * x0 + pl.b * y1 - pl.e;
  const d3 = pl.a * x1 + pl.b * y1 - pl.e;
  return Math.min(d0, d1, d2, d3) < -EPS && Math.max(d0, d1, d2, d3) > EPS;
}

/** The side of a plan tile in cells, for `LineIndex`. */
const TILE = 4;
/** How far past a tile, in tiles, a line still counts as passing it: more than ON, so a vertex on a line always finds it. */
const TILE_MARGIN = 1e-6;

/**
 * The clip lines filed by the plan tiles they pass, so a face reads only
 * the lines near it, in their order: walls then cost by what meets the
 * face, not by every edge of every polygon. Only the tiles over the scene
 * (a tile past it each way) are filed, and only those a line passes are
 * made, so a huge solid on a fine grid costs its lines and not its plan.
 * A face's lines outside that region could part only pieces off the
 * scene, which the clip drops.
 */
class LineIndex {
  readonly #lines: readonly Plane[];
  readonly #x0: number;
  readonly #y0: number;
  readonly #cols: number;
  readonly #rows: number;
  readonly #tiles = new Map<number, number[]>();
  readonly #stamp: Int32Array;
  #mark = 0;

  constructor(lines: readonly Plane[], region: { x0: number; y0: number; x1: number; y1: number }) {
    this.#lines = lines;
    this.#x0 = Math.floor(region.x0);
    this.#y0 = Math.floor(region.y0);
    this.#cols = Math.max(0, Math.ceil((region.x1 - this.#x0) / TILE));
    this.#rows = Math.max(0, Math.ceil((region.y1 - this.#y0) / TILE));
    this.#stamp = new Int32Array(lines.length);
  }

  /** Files one line in every tile it passes, and says how many it looked at. */
  file(li: number): number {
    const pl = this.#lines[li]!;
    const cols = this.#cols;
    const rows = this.#rows;
    // Step along the axis the line runs nearer to, a tile at a time, and file it in the tiles it spans across.
    const alongX = Math.abs(pl.b) >= Math.abs(pl.a);
    const steps = alongX ? cols : rows;
    let work = steps;
    for (let t = 0; t < steps; t++) {
      const u0 = (alongX ? this.#x0 : this.#y0) + t * TILE;
      const v0 = alongX ? (pl.e - pl.a * u0) / pl.b : (pl.e - pl.b * u0) / pl.a;
      const v1 = alongX ? (pl.e - pl.a * (u0 + TILE)) / pl.b : (pl.e - pl.b * (u0 + TILE)) / pl.a;
      const base = alongX ? this.#y0 : this.#x0;
      const span = alongX ? rows : cols;
      const lo = Math.max(0, Math.floor((Math.min(v0, v1) - base) / TILE - TILE_MARGIN));
      const hi = Math.min(span - 1, Math.floor((Math.max(v0, v1) - base) / TILE + TILE_MARGIN));
      for (let q = lo; q <= hi; q++) {
        const key = alongX ? q * cols + t : t * cols + q;
        const list = this.#tiles.get(key);
        if (list) list.push(li);
        else this.#tiles.set(key, [li]);
        work++;
      }
    }
    return work;
  }

  /** The lines passing the tiles under a face's plan, in their order, put at the end of `out`. */
  *near(st: Store, f: Poly, budget: Budget, out: NearLines): Job<void> {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const i of f.v) {
      const x = st.p[3 * i]!;
      const y = st.p[3 * i + 1]!;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    if (budget.spend(f.v.length)) yield;
    const c0 = Math.max(0, Math.floor((x0 - this.#x0) / TILE - TILE_MARGIN));
    const c1 = Math.min(this.#cols - 1, Math.floor((x1 - this.#x0) / TILE + TILE_MARGIN));
    const r0 = Math.max(0, Math.floor((y0 - this.#y0) / TILE - TILE_MARGIN));
    const r1 = Math.min(this.#rows - 1, Math.floor((y1 - this.#y0) / TILE + TILE_MARGIN));
    const mark = ++this.#mark;
    let first = Infinity;
    let last = -Infinity;
    let found = 0;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const tile = this.#tiles.get(r * this.#cols + c);
        if (tile) {
          for (const li of tile) {
            if (this.#stamp[li] === mark) continue;
            this.#stamp[li] = mark;
            found++;
            if (li < first) first = li;
            if (li > last) last = li;
          }
        }
        if (budget.spend(1 + (tile?.length ?? 0))) yield;
      }
    }
    // In their order by a walk of the marks between the first and the last, so no sort runs in one step.
    out.reserve(found);
    for (let li = first; li <= last; li++) {
      if (this.#stamp[li] === mark) out.pool[out.size++] = li;
      if (budget.spend(1 / 4)) yield;
    }
  }
}

/**
 * The clip lines each piece of the shell reads, every face's in one pool,
 * piece f's from `from[f]` up to `to[f]`: a mesh of a hundred thousand
 * faces would otherwise make an array per face, and their collection
 * shows as long slices (review ISOA1-GC).
 */
class NearLines {
  pool = new Int32Array(4096);
  size = 0;
  readonly from: number[] = [];
  readonly to: number[] = [];

  reserve(n: number): void {
    if (this.size + n <= this.pool.length) return;
    const next = new Int32Array(2 ** Math.ceil(Math.log2(this.size + n)));
    next.set(this.pool.subarray(0, this.size));
    this.pool = next;
  }
}

/**
 * Whether a plan point lies in the clip: in the scene and, where walls
 * stand, in the union of the visibility polygons, each read by its
 * crossings on the point's row as `Sampler` reads them, so a test costs
 * the edges near that row and not every edge.
 */
class ClipTest {
  readonly #w: number;
  readonly #h: number;
  readonly #walled: boolean;
  readonly #polys: PolygonIndex[] = [];
  /** The row entries the last `inside` read. */
  cost = 0;

  constructor(w: number, h: number, walled: boolean) {
    this.#w = w;
    this.#h = h;
    this.#walled = walled;
  }

  /** Indexes one polygon over rows `row0` to `row0 + rows - 1`, as `indexPolygon` does, a few edges at a time. */
  *add(poly: Polygon, row0: number, rows: number, budget: Budget): Job {
    const n = poly.length >> 1;
    const offsets = new Int32Array(rows + 1);
    const rowSpan = (i: number): [number, number] => {
      const yi = poly[2 * i + 1]!;
      const yj = poly[2 * (i === 0 ? n - 1 : i - 1) + 1]!;
      // A horizontal edge never crosses a horizontal line, so it needs no bucket.
      if (yi === yj) return [1, 0];
      return [Math.max(row0, Math.floor(Math.min(yi, yj))), Math.min(row0 + rows - 1, Math.floor(Math.max(yi, yj)))];
    };
    for (let i = 0; i < n; i++) {
      const [lo, hi] = rowSpan(i);
      for (let r = lo; r <= hi; r++) offsets[r - row0 + 1]!++;
      if (budget.spend(1 + Math.max(0, hi - lo + 1))) yield;
    }
    for (let r = 0; r < rows; r++) {
      offsets[r + 1]! += offsets[r]!;
      if (budget.spend(1)) yield;
    }
    const edges = new Int32Array(offsets[rows]!);
    const fill = offsets.slice(0, rows);
    for (let i = 0; i < n; i++) {
      const [lo, hi] = rowSpan(i);
      for (let r = lo; r <= hi; r++) edges[fill[r - row0]!++] = i;
      if (budget.spend(1 + Math.max(0, hi - lo + 1))) yield;
    }
    this.#polys.push({ poly, row0, rows, offsets, edges });
  }

  inside(x: number, y: number): boolean {
    this.cost = 1;
    if (x < 0 || y < 0 || x > this.#w || y > this.#h) return false;
    if (!this.#walled) return true;
    for (const p of this.#polys) {
      const r = Math.floor(y) - p.row0;
      this.cost += r >= 0 && r < p.rows ? 1 + p.offsets[r + 1]! - p.offsets[r]! : p.poly.length >> 1;
      if (insideCrossings(crossingsAt(p, y), x)) return true;
    }
    return false;
  }
}

/** One open edge to close, as the cap runs it, and which side of its line the solid was cut away on. */
type Open = { from: number; to: number; out: number };

/**
 * The caps (design 4.2 step 3). Each open edge left by the clip lies on
 * the clip line that parts its face from the face that went. On each line
 * its open edges, reversed, run as chains. Where the clip turns a corner
 * a chain ends and another starts straight above or below it, and the
 * upright edge joins them, the one the next line's cap runs the other
 * way. Each loop is a cap, wound away from the solid since its edges run
 * opposite to the shell's. A cap on a convex shell is a convex polygon. On
 * a hex stack it is cut into triangles.
 */
function* capsOf(st: Store, pieces: readonly Poly[], kept: Uint8Array, near: NearLines, lines: readonly Plane[], convex: boolean, budget: Budget): Job<{ caps: Poly[]; failed: number }> {
  // Every piece lies on one side of each line, so a kept piece meets one that went only along a line: only edges with both ends on one are read. A line through a vertex passes the tiles of every piece the vertex is in, so each piece's own lines settle it. 0 not yet read, 1 on a line, 2 on none.
  const onLine = new Uint8Array(st.n);
  const pool = near.pool;
  const on = (i: number, f: number) => {
    let s = onLine[i]!;
    if (s === 0) {
      s = 2;
      for (let q = near.from[f]!; q < near.to[f]!; q++) {
        if (Math.abs(st.d(lines[pool[q]!]!, i)) <= ON) {
          s = 1;
          break;
        }
      }
      onLine[i] = s;
    }
    return s === 1;
  };
  const owner = new Map<number, number>();
  for (let f = 0; f < pieces.length; f++) {
    const v = pieces[f]!.v;
    const count = near.to[f]! - near.from[f]!;
    for (let k = 0; k < v.length; k++) {
      const a = v[k]!;
      const b = v[(k + 1) % v.length]!;
      if (on(a, f) && on(b, f)) owner.set(a * VMAX + b, f);
      // Each vertex reads the piece's lines once.
      if (budget.spend(1 + count)) yield;
    }
  }
  // Each open edge with the lines that part its face from the one that went, and the side the solid was cut away on.
  const open: { edge: Open; lines: { li: number; out: number }[] }[] = [];
  let failed = 0;
  for (let f = 0; f < pieces.length; f++) {
    if (!kept[f]) continue;
    const p = pieces[f]!;
    const v = p.v;
    const count = near.to[f]! - near.from[f]!;
    for (let k = 0; k < v.length; k++) {
      const a = v[k]!;
      const b = v[(k + 1) % v.length]!;
      if (!on(a, f) || !on(b, f)) continue;
      const g = owner.get(b * VMAX + a);
      if (g === undefined) {
        failed++;
        continue;
      }
      if (kept[g]) continue;
      const mk = centroid(st, p.v);
      const md = centroid(st, pieces[g]!.v);
      if (budget.spend(v.length + pieces[g]!.v.length + count)) yield;
      const lines_: { li: number; out: number }[] = [];
      for (let q = near.from[f]!; q < near.to[f]!; q++) {
        const li = pool[q]!;
        const pl = lines[li]!;
        if (Math.abs(st.d(pl, a)) > ON || Math.abs(st.d(pl, b)) > ON) continue;
        const dk = pl.a * mk[0] + pl.b * mk[1] - pl.e;
        const dd = pl.a * md[0] + pl.b * md[1] - pl.e;
        if (side(dk) * side(dd) < 0 || (side(dk) === 0) !== (side(dd) === 0)) lines_.push({ li, out: side(dd) !== 0 ? side(dd) : -side(dk) });
      }
      if (lines_.length === 0) failed++;
      else open.push({ edge: { from: b, to: a, out: 0 }, lines: lines_ });
    }
    if (budget.spend(v.length)) yield;
  }
  // An edge that two lines both part, at a corner where a sliver was cut away, goes to the line whose other edges it meets: the loop it closes is there.
  const byLine = new Map<number, Open[]>();
  const ends = new Map<number, Set<number>>();
  const assign = (o: (typeof open)[number], pick: { li: number; out: number }) => {
    const edge = { ...o.edge, out: pick.out };
    const list = byLine.get(pick.li);
    if (list) list.push(edge);
    else byLine.set(pick.li, [edge]);
    let at = ends.get(pick.li);
    if (!at) ends.set(pick.li, (at = new Set()));
    at.add(edge.from).add(edge.to);
  };
  for (const o of open) {
    if (o.lines.length === 1) assign(o, o.lines[0]!);
    if (budget.spend(1)) yield;
  }
  for (const o of open) {
    if (o.lines.length === 1) continue;
    const meets = o.lines.find((c) => ends.get(c.li)?.has(o.edge.from) || ends.get(c.li)?.has(o.edge.to));
    assign(o, meets ?? o.lines[0]!);
    if (budget.spend(o.lines.length)) yield;
  }
  const caps: Poly[] = [];
  for (const [li, edges] of byLine) {
    const pl = lines[li]!;
    const res = yield* loopsOnLine(st, pl, edges, budget);
    failed += res.failed;
    for (const loop of res.loops) {
      const out = loop.out;
      const n = { nx: out * pl.a, ny: out * pl.b, nz: 0 };
      if (convex) caps.push({ v: loop.v, ...n, cap: true });
      else for (const tri of yield* earClip(st, pl, loop.v, out, budget)) caps.push({ v: tri, ...n, cap: true });
    }
  }
  return { caps, failed };
}

/** Where a vertex lies along a vertical plane, unrolled into length and height. */
function unrolled(st: Store, pl: Plane, i: number): [number, number] {
  return [-pl.b * st.p[3 * i]! + pl.a * st.p[3 * i + 1]!, st.p[3 * i + 2]!];
}

function* loopsOnLine(st: Store, pl: Plane, edges: Open[], budget: Budget): Job<{ loops: { v: number[]; out: number }[]; failed: number }> {
  const outs = new Map<number, Open[]>();
  const ins = new Map<number, number>();
  const into = new Map<number, Open>();
  for (const e of edges) {
    const list = outs.get(e.from);
    if (list) list.push(e);
    else outs.set(e.from, [e]);
    ins.set(e.to, (ins.get(e.to) ?? 0) + 1);
    if (!into.has(e.to)) into.set(e.to, e);
    if (budget.spend(1)) yield;
  }
  const ends: number[] = [];
  const starts: number[] = [];
  const tally = (v: number) => {
    const o = outs.get(v)?.length ?? 0;
    const i = ins.get(v) ?? 0;
    for (let k = o; k < i; k++) ends.push(v);
    for (let k = i; k < o; k++) starts.push(v);
  };
  for (const v of outs.keys()) {
    tally(v);
    if (budget.spend(1)) yield;
  }
  for (const v of ins.keys()) {
    if (!outs.has(v)) tally(v);
    if (budget.spend(1)) yield;
  }
  // The upright edges at the corners: each chain's end to the start straight above or below it, the nearest, since a sliver's two corners can lie a hair apart. The starts filed by their place along the line in slots ON wide, so each end reads only its own slot and the two beside it.
  const slots = new Map<number, number[]>();
  for (let k = 0; k < starts.length; k++) {
    const slot = Math.floor(unrolled(st, pl, starts[k]!)[0] / ON);
    const list = slots.get(slot);
    if (list) list.push(k);
    else slots.set(slot, [k]);
    if (budget.spend(1)) yield;
  }
  const paired = new Uint8Array(starts.length);
  for (const e of ends) {
    const ex = st.p[3 * e]!;
    const ey = st.p[3 * e + 1]!;
    const slot = Math.floor(unrolled(st, pl, e)[0] / ON);
    let best = -1;
    let gap = ON;
    for (let q = slot - 1; q <= slot + 1; q++) {
      for (const k of slots.get(q) ?? []) {
        if (budget.spend(1)) yield;
        if (paired[k]) continue;
        const s = starts[k]!;
        const d = Math.hypot(st.p[3 * s]! - ex, st.p[3 * s + 1]! - ey);
        if (s === e || d > gap) continue;
        best = k;
        gap = d;
      }
    }
    if (budget.spend(1)) yield;
    if (best < 0) continue;
    paired[best] = 1;
    const s = starts[best]!;
    const up = { from: e, to: s, out: into.get(e)?.out ?? 1 };
    edges.push(up);
    const list = outs.get(e);
    if (list) list.push(up);
    else outs.set(e, [up]);
  }
  const used = new Set<Open>();
  const loops: { v: number[]; out: number }[] = [];
  let failed = 0;
  for (const first of edges) {
    if (used.has(first)) continue;
    used.add(first);
    const v = [first.from];
    let cur = first;
    let closed = false;
    for (let guard = 0; guard <= edges.length; guard++) {
      if (cur.to === first.from) {
        closed = true;
        break;
      }
      v.push(cur.to);
      if (budget.spend(1)) yield;
      const next = (outs.get(cur.to) ?? []).filter((x) => !used.has(x));
      if (next.length === 0) break;
      const pick = next.length === 1 ? next[0]! : leftmost(st, pl, cur, next);
      used.add(pick);
      cur = pick;
    }
    if (closed && v.length >= 3) loops.push({ v, out: first.out });
    else failed++;
    if (budget.spend(v.length)) yield;
  }
  return { loops, failed };
}

/** A budget that keeps its last charge, for `sliced`. */
class WatchedBudget extends Budget {
  last = 0;

  spend(c: number): boolean {
    this.last = c;
    return super.spend(c);
  }
}

/**
 * A job run to its end with its deadline already past at every call, and
 * the most work one call charged before the charge it stopped at. That
 * stays under CHECK while every loop stops when told, however long it
 * runs: for the tests of loops that random scenes never make long enough
 * to show a missing stop.
 */
function sliced<T>(job: (budget: Budget) => Job<T>): { value: T; carried: number } {
  const budget = new WatchedBudget();
  budget.deadline = -Infinity;
  const run = job(budget);
  let carried = 0;
  for (;;) {
    const before = budget.total;
    const step = run.next();
    carried = Math.max(carried, budget.total - before - (step.done ? 0 : budget.last));
    if (step.done) return { value: step.value, carried };
  }
}

/** A store of these points, each its index's vertex, for the tests below. */
function storeOf(points: readonly (readonly [number, number, number])[]): Store {
  const st = new Store();
  for (const [x, y, z] of points) st.add(x, y, z);
  return st;
}

/**
 * The loops one vertical plane's open edges close into, by the walk the
 * caps take: for the tests of the corner pairing and the turn at a pinch,
 * which random scenes seldom reach. Points are `[x, y, z]` in cells and
 * edges `[from, to]` by point index, all on the side `out` of the plane.
 * `carried` is `sliced`'s, the walk run in slices.
 */
export function capLoops(points: readonly (readonly [number, number, number])[], edges: readonly (readonly [number, number])[], plane: { a: number; b: number; e: number }, out = 1): { loops: number[][]; carried: number } {
  const st = storeOf(points);
  const pl: Plane = { id: 0, a: plane.a, b: plane.b, c: 0, e: plane.e, snap: 0 };
  const { value, carried } = sliced((budget) => loopsOnLine(st, pl, edges.map(([from, to]) => ({ from, to, out })), budget));
  return { loops: value.loops.map((l) => l.v), carried };
}

/** The triangles a cap loop on a vertical plane is cut into, as a hex stack's caps are, by point index, and `sliced`'s `carried`: for the tests. */
export function capTriangles(points: readonly (readonly [number, number, number])[], plane: { a: number; b: number; e: number }, out = 1): { triangles: number[][]; carried: number } {
  const st = storeOf(points);
  const pl: Plane = { id: 0, a: plane.a, b: plane.b, c: 0, e: plane.e, snap: 0 };
  const { value, carried } = sliced((budget) => earClip(st, pl, points.map((_, i) => i), out, budget));
  return { triangles: value, carried };
}

/**
 * The clip lines a face reads, each `[ax, ay, bx, by]` through two plan
 * points, filed over `region`, by their index in order, and `sliced`'s
 * `carried`: for the tests. The face is a plan polygon.
 */
export function linesNear(lines: readonly (readonly [number, number, number, number])[], face: readonly (readonly [number, number])[], region: { x0: number; y0: number; x1: number; y1: number }): { lines: number[]; carried: number } {
  const planes = lines.map(([ax, ay, bx, by], i) => lineThrough(i, ax, ay, bx, by)!);
  const index = new LineIndex(planes, region);
  for (let li = 0; li < planes.length; li++) index.file(li);
  const st = storeOf(face.map(([x, y]) => [x, y, 0]));
  const poly: Poly = { v: face.map((_, i) => i), nx: 0, ny: 0, nz: 1, cap: false };
  const out = new NearLines();
  const { carried } = sliced((budget) => index.near(st, poly, budget, out));
  return { lines: [...out.pool.subarray(0, out.size)], carried };
}

/**
 * Where a loop touches itself, the next edge that keeps the cap's inside
 * on its left as seen from outside: the first clockwise from the way back,
 * on the side the cap faces.
 */
function leftmost(st: Store, pl: Plane, cur: Open, next: Open[]): Open {
  const [t0, z0] = unrolled(st, pl, cur.from);
  const [t1, z1] = unrolled(st, pl, cur.to);
  const back = Math.atan2(z0 - z1, cur.out * (t0 - t1));
  let best = next[0]!;
  let bestTurn = Infinity;
  for (const e of next) {
    const [t2, z2] = unrolled(st, pl, e.to);
    const a = Math.atan2(z2 - z1, cur.out * (t2 - t1));
    let turn = back - a;
    while (turn <= 0) turn += 2 * Math.PI;
    while (turn > 2 * Math.PI) turn -= 2 * Math.PI;
    if (turn < bestTurn) {
      bestTurn = turn;
      best = e;
    }
  }
  return best;
}

/** A simple loop on a vertical plane as triangles of its own vertices, by ear clipping in length and height. */
function* earClip(st: Store, pl: Plane, loop: number[], out: number, budget: Budget): Job<number[][]> {
  const pts = loop.map((i) => {
    const [t, z] = unrolled(st, pl, i);
    return [out * t, z] as const;
  });
  const cross = (a: number, b: number, c: number) => {
    const [ax, ay] = pts[a]!;
    const [bx, by] = pts[b]!;
    const [cx, cy] = pts[c]!;
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  };
  const inTri = (p: number, a: number, b: number, c: number) => {
    const [px, py] = pts[p]!;
    for (const q of [a, b, c]) if (pts[q]![0] === px && pts[q]![1] === py) return false;
    const d1 = cross(a, b, p);
    const d2 = cross(b, c, p);
    const d3 = cross(c, a, p);
    return d1 >= -1e-12 && d2 >= -1e-12 && d3 >= -1e-12;
  };
  const idx = loop.map((_, k) => k);
  const tris: number[][] = [];
  if (budget.spend(2 * loop.length)) yield;
  while (idx.length > 3) {
    if (budget.spend(idx.length)) yield;
    let ear = -1;
    let best = -1;
    let bestCross = -Infinity;
    for (let k = 0; k < idx.length; k++) {
      if (budget.spend(1)) yield;
      const a = idx[(k + idx.length - 1) % idx.length]!;
      const b = idx[k]!;
      const c = idx[(k + 1) % idx.length]!;
      const cr = cross(a, b, c);
      if (cr > bestCross) {
        bestCross = cr;
        best = k;
      }
      if (cr <= 1e-12) continue;
      let blocked = false;
      for (let q = 0; q < idx.length && !blocked; q++) {
        const p = idx[q]!;
        blocked = p !== a && p !== b && p !== c && inTri(p, a, b, c);
        if (budget.spend(1)) yield;
      }
      if (blocked) continue;
      ear = k;
      break;
    }
    // A loop with no clean ear left is flat or nearly so: its most convex corner still closes it.
    const k = ear >= 0 ? ear : best;
    const a = idx[(k + idx.length - 1) % idx.length]!;
    const b = idx[k]!;
    const c = idx[(k + 1) % idx.length]!;
    tris.push([loop[a]!, loop[b]!, loop[c]!]);
    idx.splice(k, 1);
  }
  tris.push(idx.map((k) => loop[k]!));
  return tris;
}

/**
 * The finished faces, in flat arrays: a mesh this size has a hundred
 * thousand of them, and an object and two arrays each would be most of a
 * frame's garbage. Face f's vertices are `v[off[f]]` up to `v[off[f + 1]]`,
 * and `nb` beside them holds the face across each edge, or -1.
 */
class FaceTable {
  n = 0;
  off = new Int32Array(1025);
  v = new Int32Array(4096);
  nb = new Int32Array(4096);
  normal = new Float64Array(3072);
  cap = new Uint8Array(1024);
  bucket = new Int32Array(1024);
  local = new Int32Array(1024);
  mark = new Int32Array(1024);

  add(p: Poly, bucket: number, local: number): number {
    const id = this.n;
    if (id + 2 > this.off.length) this.#growFaces();
    const at = this.off[id]!;
    const end = at + p.v.length;
    while (end > this.v.length) this.#growVerts();
    for (let k = 0; k < p.v.length; k++) {
      this.v[at + k] = p.v[k]!;
      this.nb[at + k] = -1;
    }
    this.off[id + 1] = end;
    this.normal[3 * id] = p.nx;
    this.normal[3 * id + 1] = p.ny;
    this.normal[3 * id + 2] = p.nz;
    this.cap[id] = p.cap ? 1 : 0;
    this.bucket[id] = bucket;
    this.local[id] = local;
    this.n++;
    return id;
  }

  #growFaces(): void {
    const grow = <T extends Int32Array | Float64Array | Uint8Array>(a: T, size: number): T => {
      const next = new (a.constructor as new (n: number) => T)(size);
      next.set(a);
      return next;
    };
    const size = this.off.length * 2;
    this.off = grow(this.off, size);
    this.normal = grow(this.normal, 3 * size);
    this.cap = grow(this.cap, size);
    this.bucket = grow(this.bucket, size);
    this.local = grow(this.local, size);
    this.mark = grow(this.mark, size);
  }

  #growVerts(): void {
    const v = new Int32Array(this.v.length * 2);
    v.set(this.v);
    this.v = v;
    const nb = new Int32Array(this.nb.length * 2);
    nb.set(this.nb);
    this.nb = nb;
  }
}

/**
 * Directed edges waiting for their twin, each with its face times SLOTS
 * plus its place in the face: a table by open addressing, since a mesh
 * this size has hundreds of thousands. An edge may wait twice, at a pinch
 * where a sliver the clip leaves touches the rest along an upright line.
 */
class EdgeTable {
  #a: Int32Array;
  #c: Int32Array;
  #code: Float64Array;
  /** 0 empty, 1 full, 2 taken. */
  #state: Uint8Array;
  #used = 0;

  constructor(size: number) {
    const cap = 2 ** Math.max(4, Math.ceil(Math.log2(2 * size + 1)));
    this.#a = new Int32Array(cap);
    this.#c = new Int32Array(cap);
    this.#code = new Float64Array(cap);
    this.#state = new Uint8Array(cap);
  }

  #slot(a: number, c: number): number {
    return (Math.imul(a, 0x9e3779b1) ^ Math.imul(c, 0x85ebca77)) & (this.#state.length - 1);
  }

  put(a: number, c: number, code: number): void {
    if (2 * (this.#used + 1) > this.#state.length) this.#grow();
    const mask = this.#state.length - 1;
    let i = this.#slot(a, c);
    while (this.#state[i] === 1) i = (i + 1) & mask;
    this.#a[i] = a;
    this.#c[i] = c;
    this.#code[i] = code;
    if (this.#state[i] === 0) this.#used++;
    this.#state[i] = 1;
  }

  /** The code of an edge from a to c, which leaves the table, or -1. */
  take(a: number, c: number): number {
    const mask = this.#state.length - 1;
    for (let i = this.#slot(a, c); this.#state[i] !== 0; i = (i + 1) & mask) {
      if (this.#state[i] === 1 && this.#a[i] === a && this.#c[i] === c) {
        this.#state[i] = 2;
        return this.#code[i]!;
      }
    }
    return -1;
  }

  #grow(): void {
    const a = this.#a;
    const c = this.#c;
    const code = this.#code;
    const state = this.#state;
    const cap = state.length * 2;
    this.#a = new Int32Array(cap);
    this.#c = new Int32Array(cap);
    this.#code = new Float64Array(cap);
    this.#state = new Uint8Array(cap);
    this.#used = 0;
    for (let i = 0; i < state.length; i++) if (state[i] === 1) this.put(a[i]!, c[i]!, code[i]!);
  }
}

// ---------------------------------------------------------------- the volume

type Bucket = {
  key: string;
  bx: number;
  by: number;
  pending: Poly[] | null;
  /** Its cut, once begun and until done. */
  job: Job | null;
  guidesPending: Guide[];
  faces: number[];
  guides: Guide[];
  box: WorldBox | null;
  turns: Map<Turn, TurnData>;
  /** Its turns being made, in slices, and its drawings by turn, each dropped when a neighbor's cut ends, since its lines cross into it. */
  turnJobs: Map<Turn, Job<TurnData>>;
  draws: Map<Turn, BucketDraw>;
  drawJobs: Map<Turn, Job<BucketDraw>>;
};

type TurnData = { band: Int32Array; near: Uint8Array; guideBand: Int32Array; guideNear: Uint8Array };

/**
 * What one band of a cut bucket draws at a turn (design 4.2 steps 7 and 8),
 * in two parts: above the ground at 0, and inside a pit's opening, which
 * the board clips as it clips a standee there (design 4.3).
 */
export type BandPart = {
  /** Fill loops of its far faces and of its near faces, `[x, y, z, ...]` in world cells. */
  far: Float64Array[];
  near: Float64Array[];
  /** Stroked segments, `[ax, ay, az, bx, by, bz, ...]`: the outline (silhouettes, near creases, cap rims, near ground rims), the hidden lines, and the guides near and far (design 5). */
  outline: Float64Array;
  hidden: Float64Array;
  guide: Float64Array;
  guideHidden: Float64Array;
};

export type BandDraw = {
  band: number;
  high: BandPart;
  low: BandPart;
  /** Its box in view units at the turn, for culling. */
  box: { x0: number; y0: number; x1: number; y1: number };
};

/** A cut bucket's drawing at a turn, band by band, far to near. */
export type BucketDraw = { bands: BandDraw[] };

/** Work that never stops for a deadline: the synchronous paths and the tests. */
const UNBOUNDED = new Budget();

/** The drawing of a bucket the volume does not reach. */
const NO_DRAW: BucketDraw = { bands: [] };

/** Runs a job to its end with nothing to stop it. */
function finish<T>(job: Job<T>): T {
  for (;;) {
    const r = job.next();
    if (r.done) return r.value;
  }
}

/** An area's mesh, its footprint, and its buckets, each cut the first time it is asked for. */
export class Volume {
  readonly solid: AreaSolid;
  readonly segments: number;
  readonly banded: boolean;
  #failed = 0;
  /** The build still to run, or null once it is done, and what tells it when to stop. */
  #job: Job | null;
  readonly #budget = new Budget();
  #footprint: Footprint | null = null;
  #box: WorldBox | null = null;
  #drawEpoch = 0;
  readonly #st = new Store();
  readonly #ground: (x: number, y: number) => number;
  readonly #bounds: { w: number; h: number };
  readonly #buckets: Bucket[] = [];
  readonly #byKey = new Map<string, number>();
  #groundPlanes: Plane[] = [];
  readonly #bands = new Map<number, Plane>();
  readonly #faces = new FaceTable();
  /** Edges on a bucket line, by their ends, until the face across them is cut. */
  readonly #across = new EdgeTable(1024);
  #stamp = 0;
  readonly #across0: number;
  readonly #down0: number;

  constructor(input: VolumeInput) {
    const { area } = input;
    this.solid = area.solid;
    this.banded = input.banded ?? true;
    this.#ground = input.ground;
    this.#bounds = { w: clampScene(input.bounds.w), h: clampScene(input.bounds.h) };
    this.#across0 = Math.max(1, Math.ceil(this.#bounds.w / CHUNK_CELLS));
    this.#down0 = Math.max(1, Math.ceil(this.#bounds.h / CHUNK_CELLS));
    const n = segmentsAround(radiusOf(area.solid), input.px, input.coarse);
    this.segments = segmentsOf(area.solid, n);
    this.#job = this.#build(area, n);
  }

  /** The units of work the build has charged so far, for the tests and the bench: a call with a deadline already past charges about CHECK and one step. */
  get work(): number {
    return this.#budget.total;
  }

  /** Hexes the walk of a hex stack has visited, for the tests: counted apart from the budget, so a visit left uncharged still shows. */
  get hexVisits(): number {
    return this.#st.visits;
  }

  /** Open edges the caps could not close: 0 but for a broken clip, which the tests hold. */
  get failed(): number {
    this.prepare();
    return this.#failed;
  }

  /**
   * The build up to the buckets (design 4.2 steps 1 to 3, step 9 and the
   * filing of step 6). With a deadline (`performance.now()` time) it stops
   * once past it and carries on at the next call, so a slice runs past
   * its deadline by at most one step of the build. True once done.
   * Whatever reads the footprint or the buckets finishes it first.
   */
  prepare(deadline = Infinity): boolean {
    const job = this.#job;
    if (!job) return true;
    this.#budget.deadline = deadline;
    if (!job.next().done) return false;
    this.#job = null;
    return true;
  }

  *#build(area: ResolvedArea, n: number): Job {
    const st = this.#st;
    const budget = this.#budget;
    const { w, h } = this.#bounds;
    // 1. The shell.
    const shell = yield* shellOf(st, area.solid, n, budget);

    // 2. The clip: the scene's edges and every polygon edge, each a whole line, where it crosses the plan over the scene. Pieces off the scene go, so lines past it would part nothing that stays.
    const plan = { x0: Math.max(st.plan.x0, -TILE), y0: Math.max(st.plan.y0, -TILE), x1: Math.min(st.plan.x1, w + TILE), y1: Math.min(st.plan.y1, h + TILE) };
    const lines: Plane[] = [];
    const named = new Set<string>();
    const add = (ax: number, ay: number, bx: number, by: number) => {
      const pl = lineThrough(lines.length, ax, ay, bx, by);
      if (!pl || !crossesBox(pl, plan.x0, plan.y0, plan.x1, plan.y1)) return;
      const name = `${pl.a},${pl.b},${pl.e}`;
      if (named.has(name)) return;
      named.add(name);
      lines.push(pl);
    };
    add(0, 0, 0, h);
    add(w, 0, w, h);
    add(0, 0, w, 0);
    add(0, h, w, h);
    for (const poly of area.polygons) {
      const k = poly.length >> 1;
      for (let i = 0; i < k; i++) {
        const j = (i + 1) % k;
        const ax = poly[2 * i]!;
        const ay = poly[2 * i + 1]!;
        const bx = poly[2 * j]!;
        const by = poly[2 * j + 1]!;
        if (budget.spend(2)) yield;
        if (Math.max(ax, bx) < plan.x0 || Math.min(ax, bx) > plan.x1 || Math.max(ay, by) < plan.y0 || Math.min(ay, by) > plan.y1) continue;
        add(ax, ay, bx, by);
      }
    }
    const index = new LineIndex(lines, plan);
    for (let li = 0; li < lines.length; li++) if (budget.spend(index.file(li))) yield;
    const clip = new ClipTest(w, h, area.polygons.length > 0);
    // The rows a kept piece's middle can read: those of the plan inside the scene.
    const row0 = Math.max(0, Math.floor(plan.y0));
    const rows = Math.max(1, Math.min(h, Math.ceil(plan.y1)) - row0 + 1);
    for (const poly of area.polygons) yield* clip.add(poly, row0, rows, budget);
    // Each face cut by the lines near it in their order, a cut at a time, each piece keeping its face's lines for the caps.
    const pieces: Poly[] = [];
    const near = new NearLines();
    // The pieces still to cut and the line each starts at, one stack for every face.
    const todo: Poly[] = [];
    const todoAt: number[] = [];
    for (const face of shell.polys) {
      const from = near.size;
      yield* index.near(st, face, budget, near);
      const to = near.size;
      todo.push(face);
      todoAt.push(from);
      while (todo.length > 0) {
        let p = todo.pop()!;
        for (let k = todoAt.pop()!; k < to; k++) {
          if (budget.spend(p.v.length)) yield;
          const [above, below] = splitPoly(st, p, lines[near.pool[k]!]!);
          if (above && below) {
            todo.push(below);
            todoAt.push(k + 1);
          }
          p = (above ?? below)!;
        }
        pieces.push(p);
        near.from.push(from);
        near.to.push(to);
      }
      if (budget.spend(face.v.length + to - from)) yield;
    }
    const kept = new Uint8Array(pieces.length);
    for (let i = 0; i < pieces.length; i++) {
      const [x, y] = readPoint(st, pieces[i]!);
      kept[i] = clip.inside(x, y) ? 1 : 0;
      if (budget.spend(pieces[i]!.v.length + clip.cost)) yield;
    }

    // 3. Caps from the cut loops.
    const { caps, failed } = yield* capsOf(st, pieces, kept, near, lines, shell.convex, budget);
    this.#failed = failed;
    const capped: Poly[] = [];
    for (let i = 0; i < pieces.length; i++) {
      if (kept[i]) capped.push(pieces[i]!);
      if (budget.spend(1)) yield;
    }
    for (const cap of caps) capped.push(cap);
    const guides = yield* clipGuides(shell.guides, lines, clip, budget);

    // 9. The footprint, read from the capped shell before the ground cut, and the plan the ground is read under.
    const print = new FootprintBuilder(st.plan, w, h);
    // Zeroing its sub-cells is a fraction of a nanosecond each.
    if (budget.spend(1 + print.size / 1024)) yield;
    const under: WorldBox = { x0: Infinity, y0: Infinity, z0: Infinity, x1: -Infinity, y1: -Infinity, z1: -Infinity };
    for (const f of capped) {
      yield* print.add(st, f, budget);
      for (const i of f.v) growBox(under, st.p[3 * i]!, st.p[3 * i + 1]!, st.p[3 * i + 2]!);
      if (budget.spend(f.v.length)) yield;
    }
    this.#footprint = yield* print.finish(budget);
    if (capped.length > 0) this.#groundPlanes = yield* groundPlanes(this.#ground, under, this.#bounds, budget);
    this.#box = capped.length > 0 ? under : null;

    // 6. Each face cut by the bucket lines across it, x then y as every cut runs (a line a face's neighbor takes and it skips would part their shared edge differently), each piece filed where its middle reads.
    for (const f of capped) {
      const b = planBox(st, [f]);
      for (const piece of yield* cutEach(st, f, bucketLines(b.x0, b.y0, b.x1, b.y1), budget)) {
        const [x, y] = readPoint(st, piece);
        this.#bucketAt(this.#bucketOf(x, y)).pending!.push(piece);
        if (budget.spend(piece.v.length)) yield;
      }
    }
    for (const g of guides) {
      const bl = bucketLines(Math.min(g.ax, g.bx), Math.min(g.ay, g.by), Math.max(g.ax, g.bx), Math.max(g.ay, g.by));
      for (const piece of cutGuides([g], bl)) this.#bucketAt(this.#bucketOf((piece.ax + piece.bx) / 2, (piece.ay + piece.by) / 2)).guidesPending.push(piece);
      if (budget.spend(1 + bl.length)) yield;
    }
  }

  /** The bucket at an index of the scene's buckets, made the first time a face is filed in it. */
  #bucketAt(i: number): Bucket {
    const bx = i % this.#across0;
    const by = Math.floor(i / this.#across0);
    const key = `${bx},${by}`;
    let b = this.#byKey.get(key);
    if (b === undefined) {
      b = this.#buckets.length;
      this.#byKey.set(key, b);
      this.#buckets.push({ key, bx, by, pending: [], job: null, guidesPending: [], faces: [], guides: [], box: null, turns: new Map(), turnJobs: new Map(), draws: new Map(), drawJobs: new Map() });
    }
    return this.#buckets[b]!;
  }

  /** The capped shell's box in the world before the ground cut, or null when the clip leaves nothing: which buckets the board may look at. */
  get box(): WorldBox | null {
    this.prepare();
    return this.#box;
  }

  /** Counts each time a cut ends and drops its neighbors' drawings, so the board knows to ask for them again. */
  get drawEpoch(): number {
    return this.#drawEpoch;
  }

  /** The stand rule's footprint (design 4.2 step 9). */
  get footprint(): Footprint {
    this.prepare();
    return this.#footprint!;
  }

  /** The bucket a plan point is filed in, its column and row, clamped to the scene's buckets. */
  #bucketOf(x: number, y: number): number {
    const bx = Math.max(0, Math.min(this.#across0 - 1, Math.floor(x / CHUNK_CELLS)));
    const by = Math.max(0, Math.min(this.#down0 - 1, Math.floor(y / CHUNK_CELLS)));
    return by * this.#across0 + bx;
  }

  /** The buckets the volume reaches, as `cx,cy` like the relief's. */
  get keys(): string[] {
    this.prepare();
    return this.#buckets.map((b) => b.key);
  }

  /** Whether a bucket's ground and bands are cut. */
  ready(key: string): boolean {
    this.prepare();
    const i = this.#byKey.get(key);
    return i !== undefined && this.#buckets[i]!.pending === null;
  }

  /** A bucket's box in the world once it is cut, for culling: null before, or when nothing in it stands above the ground. */
  boxOf(key: string): WorldBox | null {
    this.prepare();
    const i = this.#byKey.get(key);
    return i === undefined ? null : this.#buckets[i]!.box;
  }

  /**
   * Cuts a bucket by the ground and the bands and links its faces (design
   * 4.2 steps 4 to 7). With a deadline (`performance.now()` time) it stops
   * once past it and carries on at the next call, so a frame's slice stays
   * within its budget however much the bucket holds. True once done.
   */
  ensure(key: string, deadline = Infinity): boolean {
    if (!this.prepare(deadline)) return false;
    const bi = this.#byKey.get(key);
    if (bi === undefined) return true;
    const b = this.#buckets[bi]!;
    if (!b.pending) return true;
    b.job ??= this.#cut(b, bi);
    this.#budget.deadline = deadline;
    if (!b.job.next().done) return false;
    b.job = null;
    return true;
  }

  *#cut(b: Bucket, bi: number): Job {
    const st = this.#st;
    const budget = this.#budget;
    const ground = this.#ground;
    const pending = b.pending!;
    const range: WorldBox = { x0: Infinity, y0: Infinity, z0: Infinity, x1: -Infinity, y1: -Infinity, z1: -Infinity };
    for (const f of pending) {
      for (const i of f.v) growBox(range, st.p[3 * i]!, st.p[3 * i + 1]!, st.p[3 * i + 2]!);
      if (budget.spend(f.v.length)) yield;
    }
    const planes = this.#groundPlanes.filter((pl) => (pl.snap === 3 ? pl.e > range.z0 + EPS && pl.e < range.z1 - EPS : crossesBox(pl, range.x0, range.y0, range.x1, range.y1)));
    if (budget.spend(this.#groundPlanes.length)) yield;
    // A face at a time and a cut at a time: the ground's planes, the pieces at or below the ground dropped, then the first band family and each strip that makes by the second.
    const done: Poly[] = [];
    for (const face of pending) {
      for (const p of yield* cutEach(st, face, planes, budget)) {
        if (budget.spend(p.v.length)) yield;
        if (onOrBelow(st, p, ground)) continue;
        if (!this.banded) {
          done.push(p);
          continue;
        }
        const strips: Poly[] = [];
        yield* this.#bandFamily(p, 0, strips, budget);
        for (const strip of strips) yield* this.#bandFamily(strip, 1, done, budget);
      }
    }
    let guides = cutGuides(b.guidesPending, planes).filter((g) => (g.az + g.bz) / 2 > ground(Math.floor((g.ax + g.bx) / 2), Math.floor((g.ay + g.by) / 2)) + EPS);
    if (this.banded) guides = guides.flatMap((g) => this.#bandGuide(g));
    if (budget.spend(b.guidesPending.length * (1 + planes.length) + guides.length)) yield;
    const F = this.#faces;
    for (const p of done) {
      b.faces.push(F.add(p, bi, b.faces.length));
      if (budget.spend(p.v.length)) yield;
    }
    // Twins by their ends: within the bucket, and across a bucket line with the faces of buckets cut before.
    const local = new EdgeTable(4 * done.length);
    for (const id of b.faces) {
      const at = F.off[id]!;
      const n = F.off[id + 1]! - at;
      for (let k = 0; k < n; k++) {
        const a = F.v[at + k]!;
        const c = F.v[at + (k + 1 === n ? 0 : k + 1)]!;
        const table = this.#onBucketLine(a, c) ? this.#across : local;
        const twin = table.take(c, a);
        if (twin < 0) {
          table.put(a, c, id * SLOTS + k);
          continue;
        }
        const g = Math.floor(twin / SLOTS);
        F.nb[at + k] = g;
        F.nb[F.off[g]! + twin - g * SLOTS] = id;
      }
      if (budget.spend(2 * n)) yield;
    }
    const box: WorldBox = { x0: Infinity, y0: Infinity, z0: Infinity, x1: -Infinity, y1: -Infinity, z1: -Infinity };
    for (const id of b.faces) {
      for (let q = F.off[id]!; q < F.off[id + 1]!; q++) {
        const i = F.v[q]!;
        growBox(box, st.p[3 * i]!, st.p[3 * i + 1]!, st.p[3 * i + 2]!);
      }
      if (budget.spend(F.off[id + 1]! - F.off[id]!)) yield;
    }
    for (const g of guides) {
      growBox(box, g.ax, g.ay, g.az);
      growBox(box, g.bx, g.by, g.bz);
    }
    b.box = b.faces.length === 0 && guides.length === 0 ? null : box;
    b.guides = guides;
    b.guidesPending = [];
    b.pending = null;
    // A neighbor's lines read the faces across its edges, which this cut has just linked: its drawings are made again.
    for (const n of this.#around(b)) {
      n.draws.clear();
      n.drawJobs.clear();
    }
    this.#drawEpoch++;
  }

  /** The buckets made around one, the eight that can hold a face across one of its edges or corners. */
  #around(b: Bucket): Bucket[] {
    const out: Bucket[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const i = this.#byKey.get(`${b.bx + dx},${b.by + dy}`);
        if (i !== undefined) out.push(this.#buckets[i]!);
      }
    }
    return out;
  }

  /** Every bucket cut, for the tests and for a volume small enough to cut at once. */
  ensureAll(): void {
    this.prepare();
    for (const b of this.#buckets) this.ensure(b.key);
  }

  #onBucketLine(a: number, b: number): boolean {
    const p = this.#st.p;
    for (const axis of [0, 1]) {
      const va = p[3 * a + axis]!;
      const vb = p[3 * b + axis]!;
      const k = Math.round(va / CHUNK_CELLS) * CHUNK_CELLS;
      if (Math.abs(va - k) <= ON && Math.abs(vb - k) <= ON) return true;
    }
    return false;
  }

  #bandPlane(family: 0 | 1, m: number): Plane {
    const id = BAND + 2 * (m + BAND_SPAN) + family;
    let pl = this.#bands.get(id);
    if (!pl) this.#bands.set(id, (pl = { id, a: R, b: family === 0 ? R : -R, c: 0, e: m, snap: 0 }));
    return pl;
  }

  /** A face cut by every band plane of one family it crosses, lowest first (design 4.2 step 5). Each face takes the first family, then the second. */
  *#bandFamily(poly: Poly, family: 0 | 1, out: Poly[], budget: Budget): Job {
    const p = this.#st.p;
    const b = family === 0 ? R : -R;
    let lo = Infinity;
    let hi = -Infinity;
    for (const i of poly.v) {
      const d = R * p[3 * i]! + b * p[3 * i + 1]!;
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    let rest: Poly | null = poly;
    for (let m = Math.floor(lo + EPS) + 1; m < hi - EPS && rest; m++) {
      if (budget.spend(rest.v.length)) yield;
      const [above, below] = splitPoly(this.#st, rest, this.#bandPlane(family, m));
      if (below) out.push(below);
      rest = above;
    }
    if (rest) out.push(rest);
  }

  #bandGuide(g: Guide): Guide[] {
    let pieces = [g];
    for (const family of [0, 1] as const) {
      const sign = family === 0 ? 1 : -1;
      const next: Guide[] = [];
      for (const p of pieces) {
        const da = R * p.ax + sign * R * p.ay;
        const db = R * p.bx + sign * R * p.by;
        const planes: Plane[] = [];
        for (let m = Math.floor(Math.min(da, db) + EPS) + 1; m < Math.max(da, db) - EPS; m++) planes.push(this.#bandPlane(family, m));
        next.push(...cutGuides([p], planes));
      }
      pieces = next;
    }
    return pieces;
  }

  /**
   * A bucket's faces and guides at a turn: each one's band and whether it
   * faces the viewer. Only a cut bucket may be asked (`#ready` and
   * `#cutNeighbor` see to it): its guides come in at the cut's end, so a
   * turn kept from before then would hide them for good (review
   * ISOA1-ASTRA-08).
   */
  #turn(b: Bucket, turn: Turn): TurnData {
    return b.turns.get(turn) ?? finish(this.#turnJob(b, turn, UNBOUNDED));
  }

  /** The turn of a bucket's faces and guides in slices, kept once made (review ISOA1-LAYOUT: the board's draw path reads turns only through this). */
  *#turnJob(b: Bucket, turn: Turn, budget: Budget): Job<TurnData> {
    const band = new Int32Array(b.faces.length);
    const near = new Uint8Array(b.faces.length);
    const F = this.#faces;
    const p = this.#st.p;
    for (let k = 0; k < b.faces.length; k++) {
      const id = b.faces[k]!;
      let x = 0;
      let y = 0;
      const at = F.off[id]!;
      const end = F.off[id + 1]!;
      for (let q = at; q < end; q++) {
        x += p[3 * F.v[q]!]!;
        y += p[3 * F.v[q]! + 1]!;
      }
      band[k] = bandAt(turn, x / (end - at), y / (end - at));
      near[k] = towardViewer(turn, F.normal[3 * id]!, F.normal[3 * id + 1]!, F.normal[3 * id + 2]!) > 0 ? 1 : 0;
      if (budget.spend(end - at)) yield;
    }
    const guideBand = new Int32Array(b.guides.length);
    const guideNear = new Uint8Array(b.guides.length);
    b.guides.forEach((g, k) => {
      guideBand[k] = bandAt(turn, (g.ax + g.bx) / 2, (g.ay + g.by) / 2);
      guideNear[k] = towardViewer(turn, g.nx, g.ny, 0) > 0 ? 1 : 0;
    });
    if (budget.spend(b.guides.length)) yield;
    // A read between the slices may have made it already: the first stays, so every reader sees the same arrays.
    let t = b.turns.get(turn);
    if (!t) b.turns.set(turn, (t = { band, near, guideBand, guideNear }));
    return t;
  }

  /**
   * A cut bucket's drawing at a turn (design 4.2 steps 7 and 8): each
   * band's fill loops and strokes. With a deadline it stops once past it
   * and carries on at the next call, as a cut does, so the board's draw
   * path does no unbounded work at layout (review ISOA1-LAYOUT). Null
   * until done, and while the bucket is not cut. Kept per turn until a
   * neighbor's cut ends, since its lines cross into that neighbor.
   */
  drawn(key: string, turn: Turn, deadline = Infinity): BucketDraw | null {
    if (!this.prepare(deadline)) return null;
    const bi = this.#byKey.get(key);
    if (bi === undefined) return NO_DRAW;
    const b = this.#buckets[bi]!;
    if (b.pending) return null;
    const have = b.draws.get(turn);
    if (have) return have;
    let job = b.drawJobs.get(turn);
    if (!job) b.drawJobs.set(turn, (job = this.#drawJob(b, turn)));
    this.#budget.deadline = deadline;
    const r = job.next();
    if (!r.done) return null;
    b.drawJobs.delete(turn);
    b.draws.set(turn, r.value);
    return r.value;
  }

  /** A bucket's drawing kept from an earlier call, or null: never does any work. */
  drawnNow(key: string, turn: Turn): BucketDraw | null {
    if (this.#job) return null;
    const bi = this.#byKey.get(key);
    if (bi === undefined) return NO_DRAW;
    return this.#buckets[bi]!.draws.get(turn) ?? null;
  }

  *#drawJob(b: Bucket, turn: Turn): Job<BucketDraw> {
    const budget = this.#budget;
    // The owner of an edge across a bucket line is read from the turn of the face beyond it, so those turns come first, in slices too.
    if (!b.turns.has(turn)) yield* this.#turnJob(b, turn, budget);
    for (const n of this.#around(b)) if (n.pending === null && !n.turns.has(turn)) yield* this.#turnJob(n, turn, budget);
    const t = this.#turn(b, turn);
    const F = this.#faces;
    const p = this.#st.p;
    // Under the ground at 0 lies only what is inside a pit's opening, and the ground's level cut at 0 parts every face there from what is above, so a face, line or guide is inside when its lowest point is under 0.
    const lowAt = (z: number) => z < -EPS;
    // The faces by band, near or far, and above the ground at 0 or inside a pit's opening.
    const groups = new Map<number, number[]>();
    for (let k = 0; k < b.faces.length; k++) {
      const id = b.faces[k]!;
      let bottom = Infinity;
      for (let q = F.off[id]!; q < F.off[id + 1]!; q++) bottom = Math.min(bottom, p[3 * F.v[q]! + 2]!);
      const g = 4 * t.band[k]! + 2 * t.near[k]! + (lowAt(bottom) ? 1 : 0);
      const list = groups.get(g);
      if (list) list.push(id);
      else groups.set(g, [id]);
      if (budget.spend(F.off[id + 1]! - F.off[id]!)) yield;
    }
    type Build = { far: Float64Array[]; near: Float64Array[]; outline: number[]; hidden: number[]; guide: number[]; guideHidden: number[] };
    const bands = new Map<number, [Build, Build]>();
    const partOf = (band: number, low: boolean): Build => {
      let pair = bands.get(band);
      if (!pair) {
        const empty = (): Build => ({ far: [], near: [], outline: [], hidden: [], guide: [], guideHidden: [] });
        bands.set(band, (pair = [empty(), empty()]));
      }
      return pair[low ? 1 : 0];
    };
    for (const [g, ids] of groups) {
      const band = Math.floor(g / 4);
      const r = g - 4 * band;
      const part = partOf(band, (r & 1) === 1);
      const loops = yield* this.#walk(ids, budget);
      (r & 2 ? part.near : part.far).push(...loops);
    }
    // Each edge once, by the nearer band beside it, as `lines` reads it.
    for (let k = 0; k < b.faces.length; k++) {
      const id = b.faces[k]!;
      const band = t.band[k]!;
      const near = t.near[k] === 1;
      const at = F.off[id]!;
      const n = F.off[id + 1]! - at;
      for (let e = 0; e < n; e++) {
        const a = F.v[at + e]!;
        const c = F.v[at + (e + 1 === n ? 0 : e + 1)]!;
        const g = this.#cutNeighbor(F.nb[at + e]!);
        let lineNear = near;
        if (g < 0) {
          if (!this.onGround(a, c)) continue;
        } else {
          const gBand = this.#faceBand(g, turn);
          const owner = gBand > band || (gBand === band && g < id) ? g : id;
          if (owner !== id) continue;
          const gNear = this.#faceNear(g, turn);
          lineNear = near || gNear;
          const N = F.normal;
          const silhouette = near !== gNear;
          const cap = F.cap[id] !== F.cap[g];
          const crease = N[3 * id]! * N[3 * g]! + N[3 * id + 1]! * N[3 * g + 1]! + N[3 * id + 2]! * N[3 * g + 2]! < CREASE_COS;
          if (!silhouette && !cap && !crease) continue;
        }
        const part = partOf(band, lowAt(Math.min(p[3 * a + 2]!, p[3 * c + 2]!)));
        (lineNear ? part.outline : part.hidden).push(p[3 * a]!, p[3 * a + 1]!, p[3 * a + 2]!, p[3 * c]!, p[3 * c + 1]!, p[3 * c + 2]!);
      }
      if (budget.spend(2 * n)) yield;
    }
    b.guides.forEach((g, k) => {
      const part = partOf(t.guideBand[k]!, lowAt(Math.min(g.az, g.bz)));
      (t.guideNear[k] === 1 ? part.guide : part.guideHidden).push(g.ax, g.ay, g.az, g.bx, g.by, g.bz);
    });
    if (budget.spend(b.guides.length)) yield;
    const { c, s } = turnAxes(turn);
    const out: BandDraw[] = [];
    for (const [band, [high, low]] of bands) {
      const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      const grow = (q: ArrayLike<number>) => {
        for (let i = 0; i + 2 < q.length; i += 3) {
          const u = c * q[i]! - s * q[i + 1]!;
          const v = (s * q[i]! + c * q[i + 1]!) / 2 - K * q[i + 2]!;
          if (u < box.x0) box.x0 = u;
          if (u > box.x1) box.x1 = u;
          if (v < box.y0) box.y0 = v;
          if (v > box.y1) box.y1 = v;
        }
      };
      const done = (q: Build): BandPart => {
        for (const loop of q.far) grow(loop);
        for (const loop of q.near) grow(loop);
        grow(q.outline);
        grow(q.hidden);
        grow(q.guide);
        grow(q.guideHidden);
        return { far: q.far, near: q.near, outline: Float64Array.from(q.outline), hidden: Float64Array.from(q.hidden), guide: Float64Array.from(q.guide), guideHidden: Float64Array.from(q.guideHidden) };
      };
      out.push({ band, high: done(high), low: done(low), box });
      if (budget.spend(1)) yield;
    }
    out.sort((x, y) => x.band - y.band);
    return { bands: out };
  }

  /**
   * The boundary loops of a set of faces, by a walk of the edges with one
   * side in it (design 4.2 step 8), in slices. The set is its own, not the
   * face table's marks, so a walk paused between slices never reads
   * another's.
   */
  *#walk(ids: readonly number[], budget: Budget): Job<Float64Array[]> {
    const F = this.#faces;
    const inSet = new Set(ids);
    const next = new Map<number, number[]>();
    for (const id of ids) {
      const at = F.off[id]!;
      const n = F.off[id + 1]! - at;
      for (let k = 0; k < n; k++) {
        const g = F.nb[at + k]!;
        if (g >= 0 && inSet.has(g)) continue;
        const a = F.v[at + k]!;
        const to = F.v[at + (k + 1 === n ? 0 : k + 1)]!;
        const list = next.get(a);
        if (list) list.push(to);
        else next.set(a, [to]);
      }
      if (budget.spend(n)) yield;
    }
    const out: Float64Array[] = [];
    const p = this.#st.p;
    for (const [start, list] of next) {
      while (list.length > 0) {
        const pts: number[] = [p[3 * start]!, p[3 * start + 1]!, p[3 * start + 2]!];
        let at = list.pop()!;
        for (let guard = 0; at !== start && guard < 1e7; guard++) {
          pts.push(p[3 * at]!, p[3 * at + 1]!, p[3 * at + 2]!);
          const more = next.get(at);
          if (!more || more.length === 0) break;
          at = more.pop()!;
        }
        if (pts.length >= 9) out.push(Float64Array.from(pts));
        if (budget.spend(pts.length / 3)) yield;
      }
    }
    return out;
  }

  /**
   * The face across an edge, or -1 while that face's bucket is still being
   * cut. A cut links its faces to its neighbors' before it ends, so without
   * this a draw between its slices would read it half built. With it, what
   * a draw returns changes only when a bucket's cut ends. `loops` needs no
   * such test: it reads only the faces it marked, all in cut buckets.
   */
  #cutNeighbor(g: number): number {
    return g >= 0 && this.#buckets[this.#faces.bucket[g]!]!.pending === null ? g : -1;
  }

  #faceBand(id: number, turn: Turn): number {
    const F = this.#faces;
    return this.#turn(this.#buckets[F.bucket[id]!]!, turn).band[F.local[id]!]!;
  }

  #faceNear(id: number, turn: Turn): boolean {
    const F = this.#faces;
    return this.#turn(this.#buckets[F.bucket[id]!]!, turn).near[F.local[id]!] === 1;
  }

  /** The cut buckets among `keys`. */
  #ready(keys: readonly string[]): Bucket[] {
    this.prepare();
    const out: Bucket[] = [];
    for (const key of keys) {
      const i = this.#byKey.get(key);
      if (i !== undefined && this.#buckets[i]!.pending === null) out.push(this.#buckets[i]!);
    }
    return out;
  }

  /** The bands the faces and guides of these buckets lie in at a turn, far to near: the volume's entries in the depth list. */
  bands(turn: Turn, keys: readonly string[] = this.keys): number[] {
    const seen = new Set<number>();
    for (const b of this.#ready(keys)) {
      const t = this.#turn(b, turn);
      for (const band of t.band) seen.add(band);
      for (const band of t.guideBand) seen.add(band);
    }
    return [...seen].sort((a, b) => a - b);
  }

  /**
   * The outline loops of a run (design 4.2 step 8): of its near faces and
   * of its far faces in these buckets and bands, each the boundary of the
   * set by a walk of the edges with one side in it, `[x, y, z, ...]` in
   * world cells. All bands when `range` is left out, as a volume drawn
   * whole.
   */
  loops(turn: Turn, keys: readonly string[] = this.keys, range?: readonly [number, number]): { near: Float64Array[]; far: Float64Array[] } {
    const F = this.#faces;
    const pick = (wantNear: boolean): Float64Array[] => {
      const stamp = ++this.#stamp;
      const set: number[] = [];
      for (const b of this.#ready(keys)) {
        const t = this.#turn(b, turn);
        b.faces.forEach((id, k) => {
          if (range && (t.band[k]! < range[0] || t.band[k]! > range[1])) return;
          if ((t.near[k] === 1) !== wantNear) return;
          F.mark[id] = stamp;
          set.push(id);
        });
      }
      const next = new Map<number, number[]>();
      for (const id of set) {
        const at = F.off[id]!;
        const n = F.off[id + 1]! - at;
        for (let k = 0; k < n; k++) {
          const g = F.nb[at + k]!;
          if (g >= 0 && F.mark[g] === stamp) continue;
          const a = F.v[at + k]!;
          const list = next.get(a);
          const to = F.v[at + (k + 1 === n ? 0 : k + 1)]!;
          if (list) list.push(to);
          else next.set(a, [to]);
        }
      }
      const out: Float64Array[] = [];
      const p = this.#st.p;
      for (const [start, list] of next) {
        while (list.length > 0) {
          const pts: number[] = [p[3 * start]!, p[3 * start + 1]!, p[3 * start + 2]!];
          let at = list.pop()!;
          for (let guard = 0; at !== start && guard < 1e7; guard++) {
            pts.push(p[3 * at]!, p[3 * at + 1]!, p[3 * at + 2]!);
            const more = next.get(at);
            if (!more || more.length === 0) break;
            at = more.pop()!;
          }
          if (pts.length >= 9) out.push(Float64Array.from(pts));
        }
      }
      return out;
    };
    return { near: pick(true), far: pick(false) };
  }

  /**
   * The lines a run strokes (design 4.2 step 7): silhouettes where a near
   * face meets a far one, wall cap rims, creases past 35 degrees, ground
   * rims on the drawn ground, and guide pieces. Each edge belongs to the
   * nearer band beside it, so two runs never both stroke it.
   */
  lines(turn: Turn, keys: readonly string[] = this.keys, range?: readonly [number, number]): VolumeLine[] {
    const out: VolumeLine[] = [];
    const p = this.#st.p;
    const F = this.#faces;
    const inRange = (band: number) => !range || (band >= range[0] && band <= range[1]);
    for (const b of this.#ready(keys)) {
      const t = this.#turn(b, turn);
      b.faces.forEach((id, k) => {
        const band = t.band[k]!;
        const near = t.near[k] === 1;
        const at = F.off[id]!;
        const n = F.off[id + 1]! - at;
        for (let e = 0; e < n; e++) {
          const a = F.v[at + e]!;
          const c = F.v[at + (e + 1 === n ? 0 : e + 1)]!;
          const g = this.#cutNeighbor(F.nb[at + e]!);
          let kind: VolumeLine["kind"] | null = null;
          let lineNear = near;
          if (g < 0) {
            if (!inRange(band) || !this.onGround(a, c)) continue;
            kind = "ground";
          } else {
            const gBand = this.#faceBand(g, turn);
            // The nearer band owns the edge, then the lower id.
            const owner = gBand > band || (gBand === band && g < id) ? g : id;
            if (owner !== id || !inRange(band)) continue;
            const gNear = this.#faceNear(g, turn);
            lineNear = near || gNear;
            const N = F.normal;
            if (near !== gNear) kind = "silhouette";
            else if (F.cap[id] !== F.cap[g]) kind = "cap";
            else if (N[3 * id]! * N[3 * g]! + N[3 * id + 1]! * N[3 * g + 1]! + N[3 * id + 2]! * N[3 * g + 2]! < CREASE_COS) kind = "crease";
            else continue;
          }
          out.push({ ax: p[3 * a]!, ay: p[3 * a + 1]!, az: p[3 * a + 2]!, bx: p[3 * c]!, by: p[3 * c + 1]!, bz: p[3 * c + 2]!, kind, near: lineNear });
        }
      });
      b.guides.forEach((g, k) => {
        if (!inRange(t.guideBand[k]!)) return;
        out.push({ ax: g.ax, ay: g.ay, az: g.az, bx: g.bx, by: g.by, bz: g.bz, kind: "guide", near: t.guideNear[k] === 1 });
      });
    }
    return out;
  }

  /**
   * Whether an open edge lies on the drawn ground: level with the ground
   * of a cell it lies over, or up a cell's side where the ground steps,
   * between its two heights. These are the ground omissions (design 4.2
   * step 4), and the ground rims.
   */
  onGround(a: number, b: number): boolean {
    const p = this.#st.p;
    const [ax, ay, az] = [p[3 * a]!, p[3 * a + 1]!, p[3 * a + 2]!];
    const [bx, by, bz] = [p[3 * b]!, p[3 * b + 1]!, p[3 * b + 2]!];
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const g = this.#ground;
    for (const i of new Set([Math.floor(mx - ON), Math.floor(mx + ON)])) {
      for (const j of new Set([Math.floor(my - ON), Math.floor(my + ON)])) {
        const z = g(i, j);
        if (Math.abs(az - z) <= ON && Math.abs(bz - z) <= ON) return true;
      }
    }
    // An upright edge at a corner borders four cells, so both rows (or columns) beside the line count.
    const step = (ua: number, ub: number, across: number, beside: (i: number, k: number) => number) => {
      const i = Math.round(ua);
      if (Math.abs(ua - i) > ON || Math.abs(ub - i) > ON) return false;
      for (const k of new Set([Math.floor(across - ON), Math.floor(across + ON)])) {
        const g1 = beside(i - 1, k);
        const g2 = beside(i, k);
        if (g1 === g2) continue;
        const lo = Math.min(g1, g2) - ON;
        const hi = Math.max(g1, g2) + ON;
        if (az >= lo && az <= hi && bz >= lo && bz <= hi) return true;
      }
      return false;
    };
    if (step(ax, bx, my, (i, k) => g(i, k))) return true;
    return step(ay, by, mx, (j, k) => g(k, j));
  }

  /** Every face made so far, by id, as objects, for the tests. A bucket still being cut has its faces here too. */
  faces(): VolumeFace[] {
    const F = this.#faces;
    const out: VolumeFace[] = [];
    for (let id = 0; id < F.n; id++) {
      const at = F.off[id]!;
      const end = F.off[id + 1]!;
      out.push({ v: F.v.subarray(at, end), nb: F.nb.subarray(at, end), nx: F.normal[3 * id]!, ny: F.normal[3 * id + 1]!, nz: F.normal[3 * id + 2]!, cap: F.cap[id] === 1, bucket: F.bucket[id]!, local: F.local[id]! });
    }
    return out;
  }

  /** How many faces the cut buckets hold. */
  get faceCount(): number {
    return this.#faces.n;
  }

  /** A vertex's point in cells. */
  vertex(i: number): [number, number, number] {
    const p = this.#st.p;
    return [p[3 * i]!, p[3 * i + 1]!, p[3 * i + 2]!];
  }

  /** How many vertices the mesh has made. */
  get vertexCount(): number {
    return this.#st.n;
  }

  /** The guide pieces of the cut buckets, for the tests. */
  guides(): readonly Guide[] {
    this.prepare();
    return this.#buckets.flatMap((b) => b.guides);
  }
}

/** An area's volume with nothing built yet: `prepare` builds it in slices, and anything that reads it finishes the build first. */
export function buildVolume(input: VolumeInput): Volume {
  return new Volume(input);
}

/** The bucket lines across a plan box, x then y, the order every cut runs in. */
function bucketLines(x0: number, y0: number, x1: number, y1: number): Plane[] {
  const lines: Plane[] = [];
  for (let k = Math.floor(x0 / CHUNK_CELLS) + 1; k * CHUNK_CELLS < x1; k++) lines.push({ id: BUCKET_X + k, a: 1, b: 0, c: 0, e: k * CHUNK_CELLS, snap: 1 });
  for (let k = Math.floor(y0 / CHUNK_CELLS) + 1; k * CHUNK_CELLS < y1; k++) lines.push({ id: BUCKET_Y + k, a: 0, b: 1, c: 0, e: k * CHUNK_CELLS, snap: 2 });
  return lines;
}

function clampScene(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(MAX_SCENE_CELLS, Math.floor(v))) : 0;
}

function planBox(st: Store, polys: readonly Poly[]): WorldBox {
  const box: WorldBox = { x0: Infinity, y0: Infinity, z0: Infinity, x1: -Infinity, y1: -Infinity, z1: -Infinity };
  for (const poly of polys) for (const i of poly.v) growBox(box, st.p[3 * i]!, st.p[3 * i + 1]!, st.p[3 * i + 2]!);
  return box;
}

function growBox(box: WorldBox, x: number, y: number, z: number): void {
  box.x0 = Math.min(box.x0, x);
  box.y0 = Math.min(box.y0, y);
  box.z0 = Math.min(box.z0, z);
  box.x1 = Math.max(box.x1, x);
  box.y1 = Math.max(box.y1, y);
  box.z1 = Math.max(box.z1, z);
}

/** Guide pieces cut by vertical planes. */
function cutGuides(guides: readonly Guide[], planes: readonly Plane[]): Guide[] {
  let out = [...guides];
  for (const pl of planes) {
    const next: Guide[] = [];
    for (const g of out) {
      const da = pl.a * g.ax + pl.b * g.ay + pl.c * g.az - pl.e;
      const db = pl.a * g.bx + pl.b * g.by + pl.c * g.bz - pl.e;
      if (side(da) * side(db) >= 0) {
        next.push(g);
        continue;
      }
      const t = da / (da - db);
      let x = g.ax + t * (g.bx - g.ax);
      let y = g.ay + t * (g.by - g.ay);
      let z = g.az + t * (g.bz - g.az);
      if (pl.snap === 1) x = pl.e;
      else if (pl.snap === 2) y = pl.e;
      else if (pl.snap === 3) z = pl.e;
      next.push({ ...g, bx: x, by: y, bz: z }, { ...g, ax: x, ay: y, az: z });
    }
    out = next;
  }
  return out;
}

function* clipGuides(guides: readonly Guide[], lines: readonly Plane[], clip: ClipTest, budget: Budget): Job<Guide[]> {
  const out: Guide[] = [];
  for (const g of guides) {
    let pieces = [g];
    for (const pl of lines) {
      pieces = cutGuides(pieces, [pl]);
      if (budget.spend(pieces.length)) yield;
    }
    for (const piece of pieces) if (clip.inside((piece.ax + piece.bx) / 2, (piece.ay + piece.by) / 2)) out.push(piece);
  }
  return out;
}

/**
 * The whole cell lines where the drawn ground steps under the plan, and
 * the level planes at each ground height under it (design 4.2 step 4), in
 * the order their cuts run.
 */
function* groundPlanes(ground: (x: number, y: number) => number, plan: WorldBox, bounds: { w: number; h: number }, budget: Budget): Job<Plane[]> {
  const x0 = Math.max(0, Math.floor(plan.x0));
  const y0 = Math.max(0, Math.floor(plan.y0));
  const x1 = Math.min(bounds.w, Math.ceil(plan.x1));
  const y1 = Math.min(bounds.h, Math.ceil(plan.y1));
  const planes: Plane[] = [];
  const levels = new Set<number>();
  for (let j = y0; j < y1; j++) {
    for (let i = x0; i < x1; i++) levels.add(ground(i, j));
    if (budget.spend(x1 - x0)) yield;
  }
  for (let i = x0 + 1; i < x1; i++) {
    for (let j = y0; j < y1; j++) {
      if (ground(i - 1, j) === ground(i, j)) continue;
      planes.push({ id: GROUND_X + i, a: 1, b: 0, c: 0, e: i, snap: 1 });
      break;
    }
    if (budget.spend(y1 - y0)) yield;
  }
  for (let j = y0 + 1; j < y1; j++) {
    for (let i = x0; i < x1; i++) {
      if (ground(i, j - 1) === ground(i, j)) continue;
      planes.push({ id: GROUND_Y + j, a: 0, b: 1, c: 0, e: j, snap: 2 });
      break;
    }
    if (budget.spend(x1 - x0)) yield;
  }
  [...levels].sort((a, b) => a - b).forEach((z, k) => planes.push({ id: LEVEL + k, a: 0, b: 0, c: 1, e: z, snap: 3 }));
  return planes;
}

/**
 * The footprint (design 4.2 step 9): the sub-cells each face's plan
 * touches, row by row, the span of the face over each row of sub-cells,
 * so it holds no more than its faces' boxes and often less. The faces
 * that look up cover the plan of a closed solid, the topmost face over
 * any point being one, so only they are read. An upright face covers no
 * plan of its own, so a cap on a wall line takes no sub-cell past the wall.
 */
class FootprintBuilder {
  /** The sub-cells of the shell's plan inside the scene, where every capped face lies, one byte each. */
  readonly #sx0: number;
  readonly #sy0: number;
  readonly #cols: number;
  readonly #rows: number;
  readonly #bits: Uint8Array;
  #lo = new Float64Array(64);
  #hi = new Float64Array(64);

  constructor(plan: { x0: number; y0: number; x1: number; y1: number }, w: number, h: number) {
    this.#sx0 = Math.max(0, subFloor(plan.x0));
    this.#sy0 = Math.max(0, subFloor(plan.y0));
    this.#cols = Math.max(0, Math.min(w * FOG_SUBCELLS, subCeil(plan.x1)) - this.#sx0);
    this.#rows = Math.max(0, Math.min(h * FOG_SUBCELLS, subCeil(plan.y1)) - this.#sy0);
    this.#bits = new Uint8Array(this.#cols * this.#rows);
  }

  /** The sub-cells it holds. */
  get size(): number {
    return this.#bits.length;
  }

  /** Reads one face, charging the rows and sub-cells it reads. */
  *add(st: Store, f: Poly, budget: Budget): Job {
    if (f.nz <= 1e-9) return;
    const k = FOG_SUBCELLS;
    const p = st.p;
    const v = f.v;
    let ymin = Infinity;
    let ymax = -Infinity;
    for (const i of v) {
      ymin = Math.min(ymin, p[3 * i + 1]!);
      ymax = Math.max(ymax, p[3 * i + 1]!);
    }
    const r0 = subFloor(ymin);
    const r1 = Math.max(r0 + 1, subCeil(ymax));
    const rows = r1 - r0;
    if (rows > this.#lo.length) {
      this.#lo = new Float64Array(2 * rows);
      this.#hi = new Float64Array(2 * rows);
    }
    const lo = this.#lo;
    const hi = this.#hi;
    lo.fill(Infinity, 0, rows);
    hi.fill(-Infinity, 0, rows);
    // Filling is a few nanoseconds a row, an eighth of a unit.
    if (budget.spend(rows / 8 + v.length)) yield;
    for (let e = 0; e < v.length; e++) {
      const a = v[e]!;
      const b = v[e + 1 === v.length ? 0 : e + 1]!;
      const ax = p[3 * a]!;
      const ay = p[3 * a + 1]!;
      const bx = p[3 * b]!;
      const by = p[3 * b + 1]!;
      const eLo = Math.min(ay, by);
      const eHi = Math.max(ay, by);
      // The x of the edge's lower and upper ends, taken as they are where the row reaches past them: interpolated, an end can miss its own x by an ulp.
      const xLo = ay <= by ? ax : bx;
      const xHi = ay <= by ? bx : ax;
      const slope = by === ay ? 0 : (bx - ax) / (by - ay);
      const first = Math.max(0, subFloor(eLo) - r0);
      const last = Math.min(rows - 1, Math.max(first, subCeil(eHi) - 1 - r0));
      for (let r = first; r <= last; r++) {
        if (budget.spend(1)) yield;
        // The edge's x where it crosses the row's top and bottom, clamped to its ends.
        const top = (r0 + r) / k;
        const bottom = top + 1 / k;
        const x1 = top <= eLo ? xLo : top >= eHi ? xHi : ax + (top - ay) * slope;
        const x2 = bottom <= eLo ? xLo : bottom >= eHi ? xHi : ax + (bottom - ay) * slope;
        if (x1 < lo[r]!) lo[r] = x1;
        if (x2 < lo[r]!) lo[r] = x2;
        if (x1 > hi[r]!) hi[r] = x1;
        if (x2 > hi[r]!) hi[r] = x2;
      }
    }
    const cols = this.#cols;
    for (let r = 0; r < rows; r++) {
      if (budget.spend(1)) yield;
      const row = r0 + r - this.#sy0;
      if (lo[r]! > hi[r]! || row < 0 || row >= this.#rows) continue;
      const a = subFloor(lo[r]!);
      const from = Math.max(a, this.#sx0) - this.#sx0;
      const to = Math.min(Math.max(a + 1, subCeil(hi[r]!)), this.#sx0 + cols) - this.#sx0;
      for (let c = from; c < to; c++) {
        this.#bits[row * cols + c] = 1;
        if (budget.spend(1 / 8)) yield;
      }
    }
  }

  /** The marked sub-cells as runs, row by row. */
  *finish(budget: Budget): Job<Footprint> {
    const runs: number[] = [];
    let count = 0;
    const cols = this.#cols;
    for (let r = 0; r < this.#rows; r++) {
      let start = -1;
      for (let c = 0; c <= cols; c++) {
        const set = c < cols && this.#bits[r * cols + c] === 1;
        if (set && start < 0) start = c;
        else if (!set && start >= 0) {
          runs.push(this.#sy0 + r, this.#sx0 + start, this.#sx0 + c);
          count += c - start;
          start = -1;
        }
        if (budget.spend(1 / 8)) yield;
      }
    }
    return { runs: Int32Array.from(runs), count };
  }
}

/** Whether every sub-cell of a footprint passes, stopping at the first that does not: the stand rule's test (design 4.4). */
export function everySubcell(fp: Footprint, test: (sx: number, sy: number) => boolean): boolean {
  for (let r = 0; r < fp.runs.length; r += 3) {
    const sy = fp.runs[r]!;
    for (let sx = fp.runs[r + 1]!; sx < fp.runs[r + 2]!; sx++) if (!test(sx, sy)) return false;
  }
  return true;
}

// ---------------------------------------------------------------- the cache

/** What a volume is built from on a viewer's board. */
export type VolumeRequest = {
  template: AreaTemplateInput;
  ctx: AreaContext;
  /** The viewer's drawn heights (view.ts drawnHeights), by identity: a new object is new ground. */
  heights: { at(x: number, y: number): number };
  /** The viewer's fog tiles, by identity. */
  tiles: unknown;
  px: number;
  coarse: boolean;
  banded?: boolean;
};

/**
 * Volumes kept by their inputs (design 4.4): the coverage key, which
 * carries the walls version, so a door opened in sight rebuilds it, the
 * fog tiles and drawn heights by identity, the zoom octave, and coarse or
 * fine. One per area, the least recently used going first.
 */
export class VolumeCache {
  readonly #max: number;
  readonly #entries = new Map<string, { key: string; heights: unknown; tiles: unknown; volume: Volume | null }>();

  constructor(max = 256) {
    this.#max = max;
  }

  get(req: VolumeRequest): Volume | null {
    const key = volumeKey(req);
    const id = req.template.id;
    const hit = this.#entries.get(id);
    if (hit && hit.key === key && hit.heights === req.heights && hit.tiles === req.tiles) {
      this.#entries.delete(id);
      this.#entries.set(id, hit);
      return hit.volume;
    }
    const area = resolveArea(req.template, req.ctx);
    const heights = req.heights;
    const volume = area ? buildVolume({ area, bounds: req.ctx.bounds, ground: (x, y) => heights.at(x, y), px: zoomOctave(req.px), coarse: req.coarse, banded: req.banded ?? true }) : null;
    this.#entries.delete(id);
    this.#entries.set(id, { key, heights: req.heights, tiles: req.tiles, volume });
    if (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
    return volume;
  }
}

/** The key of a volume's inputs but the identities `VolumeCache` compares. */
export function volumeKey(req: Pick<VolumeRequest, "template" | "ctx" | "px" | "coarse" | "banded">): string {
  return `${coverageCacheKey(req.template, req.ctx)}|${zoomOctave(req.px)}|${req.coarse}|${req.banded ?? true}`;
}
