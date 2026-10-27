import { CHUNK_CELLS, FOG_SUBCELLS } from "#shared/model.ts";
import { coverageCacheKey, hexStackPrisms, MAX_SCENE_CELLS, resolveArea, type AreaContext, type AreaSolid, type AreaTemplateInput, type ResolvedArea, type SolidBox } from "#shared/rules/aoe.ts";
import type { Point3 } from "#shared/rules/geom.ts";
import { cornerAt, hexCenter, hexCorners, hexKey, hexNeighbors } from "#shared/rules/hex.ts";
import { pointInPolygon, type Polygon } from "#shared/rules/walls.ts";
import { K, turnAxes, type Turn } from "../../lib/view.ts";

/**
 * An area's solid as a mesh, for Isometric to stand it at its real shape
 * (docs/design-v1-iso-area-shapes.md 4.2). The solid is the rules' own
 * (`ResolvedArea.solid`), cut by the area's wall polygons, the scene's
 * edges and the drawn ground, so what stands is what catches. It is built
 * in slices a frame can take:
 *
 * - `new Volume` (`buildVolume`): the solid tessellated closed and wound
 *   outward, every face cut by the whole line of every polygon edge and
 *   scene edge across its plan, the pieces whose middle lies outside the
 *   clip dropped, and each clip line's open edges closed into caps from
 *   the shell's own vertices, so shell and caps share every vertex.
 * - `prepare`: the stand rule's footprint read from that plan, and each
 *   face cut by the 16 by 16 bucket lines across it and filed.
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

  add(x: number, y: number, z: number): number {
    if (3 * (this.n + 1) > this.p.length) {
      const next = new Float64Array(this.p.length * 2);
      next.set(this.p);
      this.p = next;
    }
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

function cutAll(st: Store, polys: Poly[], planes: readonly Plane[]): Poly[] {
  let out = polys;
  for (const pl of planes) {
    const next: Poly[] = [];
    for (const p of out) {
      const [a, b] = splitPoly(st, p, pl);
      if (a) next.push(a);
      if (b) next.push(b);
    }
    out = next;
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

/** Adds a vertex, merging any made before at the very same point. */
function merged(st: Store, seen: Map<string, number>, x: number, y: number, z: number): number {
  const key = `${x},${y},${z}`;
  let id = seen.get(key);
  if (id === undefined) seen.set(key, (id = st.add(x, y, z)));
  return id;
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
function roundedShell(st: Store, box: SolidBox, D: number, n: number): Shell {
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
  const grid: number[][] = rows.map(({ i, sz }) => {
    const [ci, si] = trig(i, n);
    // Latitude -90 + i steps: its sine is -cos and its cosine sin of i steps.
    const sinLat = -ci;
    const cosLat = si;
    const pole = i === 0 || 2 * i === n;
    return cols.map(({ k, sx, sy }) => {
      const corner = (hx > 0 && sx > 0 ? 1 : 0) + (hy > 0 && sy > 0 ? 2 : 0) + (hz > 0 && sz > 0 ? 4 : 0);
      const name = (i * n + (pole ? 0 : k % n)) * 8 + corner;
      let id = seen.get(name);
      if (id === undefined) {
        const [ck, sk] = trig(k, n);
        const [x, y, z] = inFrame(box, sx * hx + D * cosLat * ck, sy * hy + D * cosLat * sk, sz * hz + D * sinLat);
        seen.set(name, (id = st.add(x, y, z)));
      }
      return id;
    });
  });
  const polys: Poly[] = [];
  const center = box.c;
  for (let r = 0; r + 1 < grid.length; r++) {
    for (let c = 0; c < cols.length; c++) {
      const d = (c + 1) % cols.length;
      const f = facing(st, [grid[r]![c]!, grid[r]![d]!, grid[r + 1]![d]!, grid[r + 1]![c]!], center);
      if (f) polys.push(f);
    }
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
function hexShell(st: Store, s: Extract<AreaSolid, { kind: "hexStack" }>): Shell {
  const g = s.reach.g;
  const prisms = hexStackPrisms(s);
  const byHex = new Map(prisms.map((p) => [hexKey(p.hex), p]));
  const cornerKey = (p: { x: number; y: number }) => `${p.x},${p.y}`;
  const heights = new Map<string, number[]>();
  const corners = prisms.map((p) => hexCorners(g, p.hex).map((k) => cornerAt(g, k)));
  prisms.forEach((p, i) => {
    for (const c of corners[i]!) {
      const key = cornerKey(c);
      const list = heights.get(key);
      if (list) list.push(p.lo, p.hi);
      else heights.set(key, [p.lo, p.hi]);
    }
  });
  for (const list of heights.values()) list.sort((a, b) => a - b);
  const seen = new Map<string, number>();
  const at = (c: { x: number; y: number }, z: number) => merged(st, seen, c.x, c.y, z);
  const between = (c: { x: number; y: number }, z0: number, z1: number) => (heights.get(cornerKey(c)) ?? []).filter((z, i, all) => z > z0 && z < z1 && (i === 0 || all[i - 1] !== z));
  const polys: Poly[] = [];
  prisms.forEach((p, i) => {
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
      // The hex across this side: the neighbor nearest the center mirrored through the side's midpoint (corners are rounded to the lattice).
      const across = { x: a.x + b.x - middle.x, y: a.y + b.y - middle.y };
      let nb = p.hex;
      let gap = Infinity;
      for (const h of hexNeighbors(g, p.hex)) {
        const c = hexCenter(g, h);
        const d = Math.hypot(c.x - across.x, c.y - across.y);
        if (d < gap) {
          gap = d;
          nb = h;
        }
      }
      const other = byHex.get(hexKey(nb));
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
  });
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

function shellOf(st: Store, s: AreaSolid, n: number): Shell {
  switch (s.kind) {
    case "sphere":
      return roundedShell(st, { c: s.c, axes: AXES, half: [0, 0, 0] }, s.r, n);
    case "rounded":
      return roundedShell(st, s.box, s.D, n);
    case "cylinder":
      return cylinderShell(st, s, n);
    case "cone":
      return coneShell(st, s, n);
    case "box":
      return boxShell(st, s);
    case "hexStack":
      return hexShell(st, s);
  }
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
  const ds = [pl.a * x0 + pl.b * y0, pl.a * x1 + pl.b * y0, pl.a * x0 + pl.b * y1, pl.a * x1 + pl.b * y1].map((v) => v - pl.e);
  return Math.min(...ds) < -EPS && Math.max(...ds) > EPS;
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
function capsOf(st: Store, pieces: Poly[], kept: boolean[], lines: readonly Plane[], convex: boolean): { caps: Poly[]; failed: number } {
  // Every piece lies on one side of each line, so a kept piece meets one that went only along a line: only edges with both ends on one are read. 0 not yet read, 1 on a line, 2 on none.
  const onLine = new Uint8Array(st.n);
  const on = (i: number) => {
    let s = onLine[i]!;
    if (s === 0) {
      s = 2;
      for (const pl of lines) {
        if (Math.abs(st.d(pl, i)) <= ON) {
          s = 1;
          break;
        }
      }
      onLine[i] = s;
    }
    return s === 1;
  };
  const owner = new Map<number, number>();
  pieces.forEach((p, f) => {
    const v = p.v;
    for (let k = 0; k < v.length; k++) {
      const a = v[k]!;
      const b = v[(k + 1) % v.length]!;
      if (on(a) && on(b)) owner.set(a * VMAX + b, f);
    }
  });
  // Each open edge with the lines that part its face from the one that went, and the side the solid was cut away on.
  const open: { edge: Open; lines: { li: number; out: number }[] }[] = [];
  let failed = 0;
  pieces.forEach((p, f) => {
    if (!kept[f]) return;
    const v = p.v;
    for (let k = 0; k < v.length; k++) {
      const a = v[k]!;
      const b = v[(k + 1) % v.length]!;
      if (!on(a) || !on(b)) continue;
      const g = owner.get(b * VMAX + a);
      if (g === undefined) {
        failed++;
        continue;
      }
      if (kept[g]) continue;
      const mk = centroid(st, p.v);
      const md = centroid(st, pieces[g]!.v);
      const lines_: { li: number; out: number }[] = [];
      for (let li = 0; li < lines.length; li++) {
        const pl = lines[li]!;
        if (Math.abs(st.d(pl, a)) > ON || Math.abs(st.d(pl, b)) > ON) continue;
        const dk = pl.a * mk[0] + pl.b * mk[1] - pl.e;
        const dd = pl.a * md[0] + pl.b * md[1] - pl.e;
        if (side(dk) * side(dd) < 0 || (side(dk) === 0) !== (side(dd) === 0)) lines_.push({ li, out: side(dd) !== 0 ? side(dd) : -side(dk) });
      }
      if (lines_.length === 0) failed++;
      else open.push({ edge: { from: b, to: a, out: 0 }, lines: lines_ });
    }
  });
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
  for (const o of open) if (o.lines.length === 1) assign(o, o.lines[0]!);
  for (const o of open) {
    if (o.lines.length === 1) continue;
    const meets = o.lines.find((c) => ends.get(c.li)?.has(o.edge.from) || ends.get(c.li)?.has(o.edge.to));
    assign(o, meets ?? o.lines[0]!);
  }
  const caps: Poly[] = [];
  for (const [li, edges] of byLine) {
    const pl = lines[li]!;
    const res = loopsOnLine(st, pl, edges);
    failed += res.failed;
    for (const loop of res.loops) {
      const out = loop.out;
      const n = { nx: out * pl.a, ny: out * pl.b, nz: 0 };
      if (convex) caps.push({ v: loop.v, ...n, cap: true });
      else for (const tri of earClip(st, pl, loop.v, out)) caps.push({ v: tri, ...n, cap: true });
    }
  }
  return { caps, failed };
}

/** Where a vertex lies along a vertical plane, unrolled into length and height. */
function unrolled(st: Store, pl: Plane, i: number): [number, number] {
  return [-pl.b * st.p[3 * i]! + pl.a * st.p[3 * i + 1]!, st.p[3 * i + 2]!];
}

function loopsOnLine(st: Store, pl: Plane, edges: Open[]): { loops: { v: number[]; out: number }[]; failed: number } {
  const outs = new Map<number, Open[]>();
  const ins = new Map<number, number>();
  for (const e of edges) {
    const list = outs.get(e.from);
    if (list) list.push(e);
    else outs.set(e.from, [e]);
    ins.set(e.to, (ins.get(e.to) ?? 0) + 1);
  }
  const ends: number[] = [];
  const starts: number[] = [];
  for (const v of new Set([...outs.keys(), ...ins.keys()])) {
    const o = outs.get(v)?.length ?? 0;
    const i = ins.get(v) ?? 0;
    for (let k = o; k < i; k++) ends.push(v);
    for (let k = i; k < o; k++) starts.push(v);
  }
  // The upright edges at the corners: each chain's end to the start straight above or below it, the nearest, since a sliver's two corners can lie a hair apart.
  const paired = new Set<number>();
  for (const e of ends) {
    const ex = st.p[3 * e]!;
    const ey = st.p[3 * e + 1]!;
    let best = -1;
    let gap = ON;
    for (let k = 0; k < starts.length; k++) {
      if (paired.has(k)) continue;
      const s = starts[k]!;
      const d = Math.hypot(st.p[3 * s]! - ex, st.p[3 * s + 1]! - ey);
      if (s === e || d > gap) continue;
      best = k;
      gap = d;
    }
    if (best < 0) continue;
    paired.add(best);
    const s = starts[best]!;
    const into = edges.find((x) => x.to === e);
    const up = { from: e, to: s, out: into?.out ?? 1 };
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
      const next = (outs.get(cur.to) ?? []).filter((x) => !used.has(x));
      if (next.length === 0) break;
      const pick = next.length === 1 ? next[0]! : leftmost(st, pl, cur, next);
      used.add(pick);
      cur = pick;
    }
    if (closed && v.length >= 3) loops.push({ v, out: first.out });
    else failed++;
  }
  return { loops, failed };
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
function earClip(st: Store, pl: Plane, loop: number[], out: number): number[][] {
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
  while (idx.length > 3) {
    let ear = -1;
    let best = -1;
    let bestCross = -Infinity;
    for (let k = 0; k < idx.length; k++) {
      const a = idx[(k + idx.length - 1) % idx.length]!;
      const b = idx[k]!;
      const c = idx[(k + 1) % idx.length]!;
      const cr = cross(a, b, c);
      if (cr > bestCross) {
        bestCross = cr;
        best = k;
      }
      if (cr <= 1e-12) continue;
      if (idx.some((p) => p !== a && p !== b && p !== c && inTri(p, a, b, c))) continue;
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
  /**
   * A cut in progress: the ground planes it takes, the faces still to cut
   * with how far each has come (0 for the ground and the first band
   * family, 1 for the second family), and the faces done.
   */
  work: { planes: Plane[]; queue: Poly[]; stage: number[]; done: Poly[] } | null;
  guidesPending: Guide[];
  faces: number[];
  guides: Guide[];
  box: WorldBox | null;
  turns: Map<Turn, { band: Int32Array; near: Uint8Array; guideBand: Int32Array; guideNear: Uint8Array }>;
};

/** An area's mesh, its footprint, and its buckets, each cut the first time it is asked for. */
export class Volume {
  readonly solid: AreaSolid;
  readonly segments: number;
  readonly banded: boolean;
  /** Open edges the caps could not close: 0 but for a broken clip, which the tests hold. */
  readonly failed: number;
  /** The capped faces and guides until `prepare` has read the footprint from them and filed them in buckets, and how far it has come. */
  #capped: Poly[];
  #guides0: Guide[];
  #prepared = 0;
  #print = new FootprintBuilder();
  #footprint: Footprint | null = null;
  readonly #st: Store;
  readonly #ground: (x: number, y: number) => number;
  readonly #bounds: { w: number; h: number };
  readonly #buckets: Bucket[] = [];
  readonly #byKey = new Map<string, number>();
  #groundPlanes: Plane[] | null = null;
  readonly #bands = new Map<number, Plane>();
  readonly #faces = new FaceTable();
  /** Edges on a bucket line, by their ends, until the face across them is cut. */
  readonly #across = new EdgeTable(1024);
  #stamp = 0;
  #across0 = 1;
  #down0 = 1;

  constructor(input: VolumeInput) {
    const { area } = input;
    this.solid = area.solid;
    this.banded = input.banded ?? true;
    this.#ground = input.ground;
    this.#bounds = { w: clampScene(input.bounds.w), h: clampScene(input.bounds.h) };
    const st = (this.#st = new Store());
    const n = segmentsAround(radiusOf(area.solid), input.px, input.coarse);
    const shell = shellOf(st, area.solid, n);
    this.segments = shell.segments;

    // 2. The clip: the scene's edges and every polygon edge, each a whole line, where it crosses the plan.
    const plan = planBox(st, shell.polys);
    const { w, h } = this.#bounds;
    const lines: Plane[] = [];
    const add = (ax: number, ay: number, bx: number, by: number) => {
      const pl = lineThrough(lines.length, ax, ay, bx, by);
      if (!pl || !crossesBox(pl, plan.x0, plan.y0, plan.x1, plan.y1)) return;
      if (lines.some((o) => o.a === pl.a && o.b === pl.b && o.e === pl.e)) return;
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
        if (Math.max(ax, bx) < plan.x0 || Math.min(ax, bx) > plan.x1 || Math.max(ay, by) < plan.y0 || Math.min(ay, by) > plan.y1) continue;
        add(ax, ay, bx, by);
      }
    }
    const inClip = (x: number, y: number) => x >= 0 && y >= 0 && x <= w && y <= h && (area.polygons.length === 0 || area.polygons.some((p: Polygon) => pointInPolygon(p, x, y)));
    const pieces = cutAll(st, shell.polys, lines);
    const kept = pieces.map((p) => {
      const [x, y] = readPoint(st, p);
      return inClip(x, y);
    });
    // 3. Caps from the cut loops.
    const { caps, failed } = capsOf(st, pieces, kept, lines, shell.convex);
    this.failed = failed;
    this.#capped = [...pieces.filter((_, i) => kept[i]), ...caps];
    this.#guides0 = clipGuides(shell.guides, lines, inClip);
    this.#across0 = Math.max(1, Math.ceil(w / CHUNK_CELLS));
    this.#down0 = Math.max(1, Math.ceil(h / CHUNK_CELLS));
  }

  /**
   * The rest of the first build (design 4.2 step 9 and the buckets of step
   * 6): the footprint read from the capped faces, the ground's planes, and
   * each face cut by the bucket lines across it and filed. With a deadline
   * (`performance.now()` time) it stops once past it and carries on at the
   * next call. True once done. Whatever reads the footprint or the buckets
   * finishes it first.
   */
  prepare(deadline = Infinity): boolean {
    const st = this.#st;
    const faces = this.#capped;
    const n = faces.length;
    // Stage one, the footprint: faces 0 to n. Stage two, the buckets: faces n to 2n.
    while (this.#prepared < n) {
      for (let k = 0; k < 64 && this.#prepared < n; k++) this.#print.add(st, faces[this.#prepared++]!);
      if (performance.now() > deadline) return false;
    }
    if (!this.#footprint) {
      this.#footprint = this.#print.finish();
      if (performance.now() > deadline) return false;
    }
    if (!this.#groundPlanes) {
      this.#groundPlanes = n > 0 ? groundPlanes(this.#ground, planBox(st, faces), this.#bounds) : [];
      if (performance.now() > deadline) return false;
    }
    const across = this.#across0;
    const at = (i: number) => {
      const bx = i % across;
      const by = Math.floor(i / across);
      const key = `${bx},${by}`;
      let b = this.#byKey.get(key);
      if (b === undefined) {
        b = this.#buckets.length;
        this.#byKey.set(key, b);
        this.#buckets.push({ key, bx, by, pending: [], work: null, guidesPending: [], faces: [], guides: [], box: null, turns: new Map() });
      }
      return this.#buckets[b]!;
    };
    // Each face cut by the bucket lines across it, x then y as every cut runs (a line a face's neighbor takes and it skips would part their shared edge differently), each piece filed where its middle reads.
    while (this.#prepared < 2 * n) {
      for (let k = 0; k < 32 && this.#prepared < 2 * n; k++) {
        const f = faces[this.#prepared++ - n]!;
        const b = planBox(st, [f]);
        const lines = bucketLines(b.x0, b.y0, b.x1, b.y1);
        for (const piece of lines.length > 0 ? cutAll(st, [f], lines) : [f]) {
          const [x, y] = readPoint(st, piece);
          at(this.#bucketOf(x, y)).pending!.push(piece);
        }
      }
      if (performance.now() > deadline) return false;
    }
    if (this.#prepared === 2 * n) {
      for (const g of this.#guides0) {
        const lines = bucketLines(Math.min(g.ax, g.bx), Math.min(g.ay, g.by), Math.max(g.ax, g.bx), Math.max(g.ay, g.by));
        for (const piece of cutGuides([g], lines)) at(this.#bucketOf((piece.ax + piece.bx) / 2, (piece.ay + piece.by) / 2)).guidesPending.push(piece);
      }
      this.#prepared++;
      this.#capped = [];
      this.#guides0 = [];
    }
    return true;
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
    const st = this.#st;
    if (!b.work) {
      const range = planBox(st, b.pending);
      const planes = this.#groundPlanes!.filter((pl) => (pl.snap === 3 ? pl.e > range.z0 + EPS && pl.e < range.z1 - EPS : crossesBox(pl, range.x0, range.y0, range.x1, range.y1)));
      b.work = { planes, queue: [...b.pending].reverse(), stage: b.pending.map(() => 0), done: [] };
    }
    const work = b.work;
    const ground = this.#ground;
    // A face at a time: its ground cut and its first band family, then each strip that makes by the second family, so no step is more than a strip's worth of cuts.
    while (work.queue.length > 0) {
      for (let k = 0; k < 4 && work.queue.length > 0; k++) {
        const poly = work.queue.pop()!;
        if (work.stage.pop() === 1) {
          this.#bandFamily(poly, 1, work.done);
          continue;
        }
        for (const p of cutAll(st, [poly], work.planes)) {
          if (onOrBelow(st, p, ground)) continue;
          if (!this.banded) {
            work.done.push(p);
            continue;
          }
          const strips: Poly[] = [];
          this.#bandFamily(p, 0, strips);
          for (const strip of strips) {
            work.queue.push(strip);
            work.stage.push(1);
          }
        }
      }
      if (performance.now() > deadline) return false;
    }
    let guides = cutGuides(b.guidesPending, work.planes).filter((g) => (g.az + g.bz) / 2 > ground(Math.floor((g.ax + g.bx) / 2), Math.floor((g.ay + g.by) / 2)) + EPS);
    if (this.banded) guides = guides.flatMap((g) => this.#bandGuide(g));
    const polys = work.done;
    b.pending = null;
    b.work = null;
    b.guidesPending = [];
    b.guides = guides;
    const F = this.#faces;
    for (const p of polys) b.faces.push(F.add(p, bi, b.faces.length));
    // Twins by their ends: within the bucket, and across a bucket line with the faces of buckets cut before.
    const local = new EdgeTable(4 * polys.length);
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
    }
    b.box = worldBox(st, F, b.faces, guides);
    return true;
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
  #bandFamily(poly: Poly, family: 0 | 1, out: Poly[]): void {
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

  /** A bucket's faces at a turn: each one's band and whether it faces the viewer. */
  #turn(b: Bucket, turn: Turn) {
    let t = b.turns.get(turn);
    if (t) return t;
    const band = new Int32Array(b.faces.length);
    const near = new Uint8Array(b.faces.length);
    const F = this.#faces;
    const p = this.#st.p;
    b.faces.forEach((id, k) => {
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
    });
    const guideBand = new Int32Array(b.guides.length);
    const guideNear = new Uint8Array(b.guides.length);
    b.guides.forEach((g, k) => {
      guideBand[k] = bandAt(turn, (g.ax + g.bx) / 2, (g.ay + g.by) / 2);
      guideNear[k] = towardViewer(turn, g.nx, g.ny, 0) > 0 ? 1 : 0;
    });
    b.turns.set(turn, (t = { band, near, guideBand, guideNear }));
    return t;
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
          const g = F.nb[at + e]!;
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

  /** The finished faces of the cut buckets, as objects, for the tests. */
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

/** Builds an area's mesh, its clip and its caps (design 4.2 steps 1 to 3): the first slice of its build, the one that cannot stop part way. */
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

function worldBox(st: Store, F: FaceTable, faces: readonly number[], guides: readonly Guide[]): WorldBox | null {
  if (faces.length === 0 && guides.length === 0) return null;
  const box: WorldBox = { x0: Infinity, y0: Infinity, z0: Infinity, x1: -Infinity, y1: -Infinity, z1: -Infinity };
  for (const id of faces) {
    for (let q = F.off[id]!; q < F.off[id + 1]!; q++) {
      const i = F.v[q]!;
      growBox(box, st.p[3 * i]!, st.p[3 * i + 1]!, st.p[3 * i + 2]!);
    }
  }
  for (const g of guides) {
    growBox(box, g.ax, g.ay, g.az);
    growBox(box, g.bx, g.by, g.bz);
  }
  return box;
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

function clipGuides(guides: readonly Guide[], lines: readonly Plane[], inClip: (x: number, y: number) => boolean): Guide[] {
  return cutGuides(guides, lines).filter((g) => inClip((g.ax + g.bx) / 2, (g.ay + g.by) / 2));
}

/**
 * The whole cell lines where the drawn ground steps under the plan, and
 * the level planes at each ground height under it (design 4.2 step 4), in
 * the order their cuts run.
 */
function groundPlanes(ground: (x: number, y: number) => number, plan: WorldBox, bounds: { w: number; h: number }): Plane[] {
  const x0 = Math.max(0, Math.floor(plan.x0));
  const y0 = Math.max(0, Math.floor(plan.y0));
  const x1 = Math.min(bounds.w, Math.ceil(plan.x1));
  const y1 = Math.min(bounds.h, Math.ceil(plan.y1));
  const planes: Plane[] = [];
  const levels = new Set<number>();
  for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) levels.add(ground(i, j));
  for (let i = x0 + 1; i < x1; i++) {
    for (let j = y0; j < y1; j++) {
      if (ground(i - 1, j) === ground(i, j)) continue;
      planes.push({ id: GROUND_X + i, a: 1, b: 0, c: 0, e: i, snap: 1 });
      break;
    }
  }
  for (let j = y0 + 1; j < y1; j++) {
    for (let i = x0; i < x1; i++) {
      if (ground(i, j - 1) === ground(i, j)) continue;
      planes.push({ id: GROUND_Y + j, a: 0, b: 1, c: 0, e: j, snap: 2 });
      break;
    }
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
  /** Each face's span per row as [row, from, to) triples. */
  #spans = new Int32Array(3 * 1024);
  #n = 0;
  #lo = new Float64Array(64);
  #hi = new Float64Array(64);
  #rowMin = Infinity;
  #rowMax = -Infinity;

  add(st: Store, f: Poly): void {
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
    const r0 = Math.floor(ymin * k);
    const r1 = Math.max(r0 + 1, Math.ceil(ymax * k));
    const rows = r1 - r0;
    if (rows > this.#lo.length) {
      this.#lo = new Float64Array(2 * rows);
      this.#hi = new Float64Array(2 * rows);
    }
    const lo = this.#lo;
    const hi = this.#hi;
    lo.fill(Infinity, 0, rows);
    hi.fill(-Infinity, 0, rows);
    for (let e = 0; e < v.length; e++) {
      const a = v[e]!;
      const b = v[e + 1 === v.length ? 0 : e + 1]!;
      const ax = p[3 * a]!;
      const ay = p[3 * a + 1]!;
      const bx = p[3 * b]!;
      const by = p[3 * b + 1]!;
      const eLo = Math.min(ay, by);
      const eHi = Math.max(ay, by);
      const slope = by === ay ? 0 : (bx - ax) / (by - ay);
      const first = Math.max(0, Math.floor(eLo * k) - r0);
      const last = Math.min(rows - 1, Math.max(first, Math.ceil(eHi * k) - 1 - r0));
      for (let r = first; r <= last; r++) {
        // The edge's x where it crosses the row's top and bottom, clamped to its ends.
        const top = (r0 + r) / k;
        const x1 = ax + (Math.min(eHi, Math.max(eLo, top)) - ay) * slope;
        const x2 = ax + (Math.min(eHi, Math.max(eLo, top + 1 / k)) - ay) * slope;
        if (x1 < lo[r]!) lo[r] = x1;
        if (x2 < lo[r]!) lo[r] = x2;
        if (x1 > hi[r]!) hi[r] = x1;
        if (x2 > hi[r]!) hi[r] = x2;
      }
    }
    for (let r = 0; r < rows; r++) {
      if (lo[r]! > hi[r]!) continue;
      if (3 * (this.#n + 1) > this.#spans.length) {
        const next = new Int32Array(this.#spans.length * 2);
        next.set(this.#spans);
        this.#spans = next;
      }
      const a = Math.floor(lo[r]! * k);
      const n = this.#n++;
      this.#spans[3 * n] = r0 + r;
      this.#spans[3 * n + 1] = a;
      this.#spans[3 * n + 2] = Math.max(a + 1, Math.ceil(hi[r]! * k));
      this.#rowMin = Math.min(this.#rowMin, r0 + r);
      this.#rowMax = Math.max(this.#rowMax, r0 + r);
    }
  }

  /** The spans grouped by row, each row's sorted by start and merged. */
  finish(): Footprint {
    const n = this.#n;
    const spans = this.#spans;
    if (n === 0) return { runs: new Int32Array(0), count: 0 };
    const rowMin = this.#rowMin;
    const height = this.#rowMax - rowMin + 1;
    const start = new Int32Array(height + 1);
    for (let i = 0; i < n; i++) start[spans[3 * i]! - rowMin + 1]!++;
    for (let r = 0; r < height; r++) start[r + 1]! += start[r]!;
    const fill = start.slice(0, height);
    const from = new Int32Array(n);
    const to = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const at = fill[spans[3 * i]! - rowMin]!++;
      from[at] = spans[3 * i + 1]!;
      to[at] = spans[3 * i + 2]!;
    }
    const runs: number[] = [];
    let count = 0;
    for (let r = 0; r < height; r++) {
      const a = start[r]!;
      const b = start[r + 1]!;
      // Insertion sort: a row holds few spans.
      for (let i = a + 1; i < b; i++) {
        const f = from[i]!;
        const t = to[i]!;
        let j = i - 1;
        while (j >= a && from[j]! > f) {
          from[j + 1] = from[j]!;
          to[j + 1] = to[j]!;
          j--;
        }
        from[j + 1] = f;
        to[j + 1] = t;
      }
      let cur0 = -1;
      let cur1 = -1;
      for (let i = a; i < b; i++) {
        if (cur1 >= 0 && from[i]! <= cur1) {
          if (to[i]! > cur1) cur1 = to[i]!;
          continue;
        }
        if (cur1 >= 0) {
          runs.push(rowMin + r, cur0, cur1);
          count += cur1 - cur0;
        }
        cur0 = from[i]!;
        cur1 = to[i]!;
      }
      if (cur1 >= 0) {
        runs.push(rowMin + r, cur0, cur1);
        count += cur1 - cur0;
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
