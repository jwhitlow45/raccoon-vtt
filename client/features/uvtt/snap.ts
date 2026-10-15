import { FREE_WALL_LATTICE, MAX_FREE_WALL_CELLS } from "#shared/model.ts";

/**
 * Imported walls and portals on the lattice, joined and sorted into grid
 * edges and free walls (docs/design-v1-maps-vision.md section 3.1 steps 4
 * to 6). Everything here works in lattice units, a 64th of a square, where
 * every stored coordinate is a whole number. So "is this end on that
 * point" is an exact comparison, and the only rounding is the one that
 * puts a computed point on the lattice.
 *
 * The walls form a graph: vertices at lattice points, shared by every
 * segment that ends there, so moving a vertex moves every wall end on it
 * and no join can come apart. The steps, in order:
 *
 * 1. Grid pinning. A segment whose ends both lie within a tenth of a square
 *    of grid intersections on one grid line is put exactly on them. Its
 *    vertices are pinned, so nothing later moves them: an edge wall is
 *    stored on the grid, and a free wall welded to a vertex that later
 *    jumped to the grid would be left a hairline away.
 * 2. Portal cuts. A wall lying along a portal is cut back to the portal's
 *    exact ends, so a door never sits on a wall that keeps it shut and no
 *    gap opens beside it.
 * 3. Welding. A loose end within a tenth of a square of another vertex is
 *    merged into it. Failing that, an end that close to another wall's
 *    middle is moved onto it, and a free wall there is split at the shared
 *    lattice point, since a point rounded onto the lattice need not lie on
 *    the free wall's own line. A grid wall needs no split: the point is
 *    exactly on its line.
 */

const L = FREE_WALL_LATTICE;

export type SegKind = "wall" | "door" | "open" | "window";

type Vertex = { x: number; y: number; pinned: boolean; alive: boolean; segs: number[] };
type Segment = { a: number; b: number; kind: SegKind; portal: boolean; alive: boolean };

/** A segment as it leaves the graph, in lattice units. */
export type LatticeSegment = { ax: number; ay: number; bx: number; by: number; kind: SegKind };

/** Index cells are one square, so any point within a tenth of a square of a segment is in the 3 x 3 cells around it. */
const CELL = L;
/** Segments are indexed at a sample every quarter square. A sample is never more than an eighth of a square from any point of its segment. */
const SAMPLE = L / 4;

function cellKey(cx: number, cy: number): number {
  return cx * 4096 + cy;
}

export class WallGraph {
  readonly vertices: Vertex[] = [];
  readonly segments: Segment[] = [];
  readonly #at = new Map<number, number>();
  readonly #vertexCells = new Map<number, number[]>();
  readonly #segmentCells = new Map<number, number[]>();
  /** How many loose ends welding moved or merged. */
  welded = 0;

  /** The vertex at a lattice point, made if there is none. */
  vertex(x: number, y: number): number {
    const key = x * 65536 + y;
    const found = this.#at.get(key);
    if (found !== undefined) return found;
    const id = this.vertices.length;
    this.vertices.push({ x, y, pinned: false, alive: true, segs: [] });
    this.#at.set(key, id);
    this.#indexVertex(id);
    return id;
  }

  /** Adds a segment between two lattice points. A segment of no length is left out. */
  add(ax: number, ay: number, bx: number, by: number, kind: SegKind, portal: boolean): number | null {
    return this.#connect(this.vertex(ax, ay), this.vertex(bx, by), kind, portal);
  }

  #connect(a: number, b: number, kind: SegKind, portal: boolean): number | null {
    if (a === b) return null;
    const id = this.segments.length;
    this.segments.push({ a, b, kind, portal, alive: true });
    this.vertices[a]!.segs.push(id);
    this.vertices[b]!.segs.push(id);
    this.#indexSegment(id);
    return id;
  }

  #indexVertex(id: number): void {
    const v = this.vertices[id]!;
    const key = cellKey(Math.floor(v.x / CELL), Math.floor(v.y / CELL));
    const list = this.#vertexCells.get(key);
    if (list) list.push(id);
    else this.#vertexCells.set(key, [id]);
  }

  #indexSegment(id: number): void {
    const s = this.segments[id]!;
    const a = this.vertices[s.a]!;
    const b = this.vertices[s.b]!;
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / SAMPLE));
    let last = -1;
    for (let k = 0; k <= steps; k++) {
      const x = a.x + ((b.x - a.x) * k) / steps;
      const y = a.y + ((b.y - a.y) * k) / steps;
      const key = cellKey(Math.floor(x / CELL), Math.floor(y / CELL));
      if (key === last) continue;
      last = key;
      const list = this.#segmentCells.get(key);
      if (!list) this.#segmentCells.set(key, [id]);
      else if (list[list.length - 1] !== id) list.push(id);
    }
  }

  /** Ids in the 3 x 3 cells around a point. May repeat, and may name dead or moved items: callers measure. */
  #near(cells: Map<number, number[]>, x: number, y: number): number[] {
    const cx = Math.floor(x / CELL);
    const cy = Math.floor(y / CELL);
    const out: number[] = [];
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const list = cells.get(cellKey(cx + i, cy + j));
        if (list) out.push(...list);
      }
    }
    return out;
  }

  #degree(v: number): number {
    let n = 0;
    for (const s of this.vertices[v]!.segs) if (this.segments[s]!.alive) n++;
    return n;
  }

  /** Every segment that ends at `from` ends at `to` instead. One that would have no length goes. */
  #merge(from: number, to: number): void {
    if (from === to) return;
    const f = this.vertices[from]!;
    const t = this.vertices[to]!;
    for (const id of f.segs) {
      const s = this.segments[id]!;
      if (!s.alive) continue;
      if (s.a === from) s.a = to;
      if (s.b === from) s.b = to;
      if (s.a === s.b) s.alive = false;
      else t.segs.push(id);
    }
    t.pinned ||= f.pinned;
    f.alive = false;
    f.segs = [];
    this.#at.delete(f.x * 65536 + f.y);
  }

  /** Moves a vertex to a lattice point, merging it into a vertex already there. Returns the vertex now at the point. */
  #move(v: number, x: number, y: number): number {
    const vertex = this.vertices[v]!;
    if (vertex.x === x && vertex.y === y) return v;
    const there = this.#at.get(x * 65536 + y);
    if (there !== undefined) {
      this.#merge(v, there);
      return there;
    }
    this.#at.delete(vertex.x * 65536 + vertex.y);
    vertex.x = x;
    vertex.y = y;
    this.#at.set(x * 65536 + y, v);
    this.#indexVertex(v);
    return v;
  }

  /** Splits a segment at a vertex that lies on or beside it. */
  #split(id: number, v: number): void {
    const s = this.segments[id]!;
    if (s.a === v || s.b === v) return;
    s.alive = false;
    this.#connect(s.a, v, s.kind, s.portal);
    this.#connect(v, s.b, s.kind, s.portal);
  }

  /** A segment on a grid line between two pinned grid intersections. */
  isGrid(id: number): boolean {
    const s = this.segments[id]!;
    const a = this.vertices[s.a]!;
    const b = this.vertices[s.b]!;
    return a.pinned && b.pinned && (a.x === b.x || a.y === b.y);
  }

  /** Step 1. Pins every segment that lies along a grid line, within `near` lattice units at each end. */
  pinGrid(near: number): void {
    const near2 = near * near;
    const count = this.segments.length;
    for (let id = 0; id < count; id++) {
      const s = this.segments[id]!;
      if (!s.alive) continue;
      const a = this.vertices[s.a]!;
      const b = this.vertices[s.b]!;
      const ga = { x: Math.round(a.x / L) * L, y: Math.round(a.y / L) * L };
      const gb = { x: Math.round(b.x / L) * L, y: Math.round(b.y / L) * L };
      if ((a.x - ga.x) ** 2 + (a.y - ga.y) ** 2 > near2 || (b.x - gb.x) ** 2 + (b.y - gb.y) ** 2 > near2) continue;
      // One grid line, two different intersections on it.
      if ((ga.x === gb.x) === (ga.y === gb.y)) continue;
      // A pinned end is already on its intersection, and one end may not be pinned to another point.
      if ((a.pinned && (a.x !== ga.x || a.y !== ga.y)) || (b.pinned && (b.x !== gb.x || b.y !== gb.y))) continue;
      const va = this.#move(s.a, ga.x, ga.y);
      const vb = this.#move(s.b, gb.x, gb.y);
      this.vertices[va]!.pinned = true;
      this.vertices[vb]!.pinned = true;
    }
  }

  /** Step 2. Cuts every wall that lies along a portal back to the portal's ends. `near` is the tolerance off the wall's line. */
  cutAtPortals(near: number): void {
    const near2 = near * near;
    const portals = this.segments.map((s, id) => (s.alive && s.portal ? id : -1)).filter((id) => id >= 0);
    for (const pid of portals) {
      const p = this.segments[pid]!;
      if (!p.alive) continue;
      for (const wid of this.#segmentsAlong(pid)) {
        const w = this.segments[wid]!;
        if (!w.alive || w.portal) continue;
        const a = this.vertices[w.a]!;
        const b = this.vertices[w.b]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        const pa = this.vertices[p.a]!;
        const pb = this.vertices[p.b]!;
        // Both portal ends near the wall's line: the portal lies along the wall, not across it.
        const off = (q: Vertex) => ((q.x - a.x) * dy - (q.y - a.y) * dx) ** 2 / len2;
        if (off(pa) > near2 || off(pb) > near2) continue;
        const ta = ((pa.x - a.x) * dx + (pa.y - a.y) * dy) / len2;
        const tb = ((pb.x - a.x) * dx + (pb.y - a.y) * dy) / len2;
        const [t0, v0, t1, v1] = ta <= tb ? [ta, p.a, tb, p.b] : [tb, p.b, ta, p.a];
        // An overlap of under half a lattice unit is a portal that only touches the wall's end.
        const overlap = (Math.min(t1, 1) - Math.max(t0, 0)) * Math.sqrt(len2);
        if (overlap < 0.5) continue;
        w.alive = false;
        if (t0 > 0) this.#connect(w.a, v0, w.kind, false);
        if (t1 < 1) this.#connect(v1, w.b, w.kind, false);
      }
    }
  }

  /** Segments indexed in the cells a segment passes, and around them. */
  #segmentsAlong(id: number): Set<number> {
    const s = this.segments[id]!;
    const a = this.vertices[s.a]!;
    const b = this.vertices[s.b]!;
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / SAMPLE));
    const out = new Set<number>();
    for (let k = 0; k <= steps; k++) {
      for (const n of this.#near(this.#segmentCells, a.x + ((b.x - a.x) * k) / steps, a.y + ((b.y - a.y) * k) / steps)) {
        if (n !== id) out.add(n);
      }
    }
    return out;
  }

  /** Step 3. Welds every loose end within `near` lattice units of another vertex or another wall's middle. */
  weld(near: number): void {
    const near2 = near * near;
    const ends: number[] = [];
    for (let v = 0; v < this.vertices.length; v++) if (this.vertices[v]!.alive && this.#degree(v) === 1) ends.push(v);
    for (const e of ends) {
      if (!this.vertices[e]!.alive || this.#degree(e) !== 1) continue;
      const own = this.vertices[e]!.segs.find((s) => this.segments[s]!.alive)!;
      const ownSeg = this.segments[own]!;
      const other = ownSeg.a === e ? ownSeg.b : ownSeg.a;
      const E = this.vertices[e]!;

      let target = -1;
      let best = near2;
      for (const v of this.#near(this.#vertexCells, E.x, E.y)) {
        const V = this.vertices[v]!;
        if (v === e || v === other || !V.alive) continue;
        const d2 = (V.x - E.x) ** 2 + (V.y - E.y) ** 2;
        if (d2 === 0 || d2 > best || (d2 === best && v > target && target >= 0)) continue;
        // Two pinned points are grid intersections, a whole square apart: never this close.
        if (E.pinned && V.pinned) continue;
        best = d2;
        target = v;
      }
      if (target >= 0) {
        if (E.pinned) this.#merge(target, e);
        else this.#merge(e, target);
        this.welded++;
        continue;
      }

      let onto = -1;
      let ontoT = 0;
      best = near2;
      for (const sid of new Set(this.#near(this.#segmentCells, E.x, E.y))) {
        const s = this.segments[sid]!;
        if (!s.alive || s.portal || s.a === e || s.b === e) continue;
        const a = this.vertices[s.a]!;
        const b = this.vertices[s.b]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const t = ((E.x - a.x) * dx + (E.y - a.y) * dy) / (dx * dx + dy * dy);
        if (t <= 0 || t >= 1) continue;
        const d2 = (a.x + t * dx - E.x) ** 2 + (a.y + t * dy - E.y) ** 2;
        if (d2 > best || (d2 === best && sid > onto && onto >= 0)) continue;
        best = d2;
        onto = sid;
        ontoT = t;
      }
      if (onto < 0 || best === 0) continue;
      const s = this.segments[onto]!;
      const a = this.vertices[s.a]!;
      const b = this.vertices[s.b]!;
      if (this.isGrid(onto)) {
        // A pinned end beside a grid wall is a whole square from it, and a lattice point on a grid line is exactly on it.
        if (E.pinned) continue;
        const x = a.x === b.x ? a.x : Math.round(a.x + ontoT * (b.x - a.x));
        const y = a.y === b.y ? a.y : Math.round(a.y + ontoT * (b.y - a.y));
        this.#move(e, x, y);
        this.welded++;
        continue;
      }
      let at = e;
      if (!E.pinned) at = this.#move(e, Math.round(a.x + ontoT * (b.x - a.x)), Math.round(a.y + ontoT * (b.y - a.y)));
      // The move may have merged the end into the wall's own end, which joins them already.
      if (s.alive) this.#split(onto, at);
      this.welded++;
    }
  }

  /** Every live segment, each pair of points once. A door or window wins over a wall on the same points. */
  result(): LatticeSegment[] {
    const rank: Record<SegKind, number> = { wall: 0, window: 1, open: 2, door: 3 };
    const byPair = new Map<string, LatticeSegment>();
    for (const s of this.segments) {
      if (!s.alive) continue;
      const a = this.vertices[s.a]!;
      const b = this.vertices[s.b]!;
      const [p, q] = a.x < b.x || (a.x === b.x && a.y < b.y) ? [a, b] : [b, a];
      const key = `${p.x},${p.y},${q.x},${q.y}`;
      const prev = byPair.get(key);
      if (prev && rank[prev.kind] >= rank[s.kind]) continue;
      byPair.set(key, { ax: a.x, ay: a.y, bx: b.x, by: b.y, kind: s.kind });
    }
    return [...byPair.values()];
  }

  /** Whether the live segment between these lattice points sits on a grid line between pinned intersections. */
  gridAt(seg: LatticeSegment): boolean {
    const a = this.#at.get(seg.ax * 65536 + seg.ay);
    const b = this.#at.get(seg.bx * 65536 + seg.by);
    if (a === undefined || b === undefined) return false;
    const va = this.vertices[a]!;
    const vb = this.vertices[b]!;
    return va.pinned && vb.pinned && (va.x === vb.x || va.y === vb.y);
  }
}

/**
 * A free wall too long to store, cut into equal parts with every new end
 * on the lattice (section 3.1 step 4): `ceil(length / (8 - margin))` parts,
 * one more until every part is at most 8 squares. Rounding moves an end at
 * most half a lattice unit per axis, which the 1/32 margin covers, but the
 * lengths are checked anyway, exactly, as whole numbers.
 */
export function cutLong(ax: number, ay: number, bx: number, by: number, margin: number = 1 / 32): [number, number, number, number][] {
  const max = MAX_FREE_WALL_CELLS * L;
  const fits = (x0: number, y0: number, x1: number, y1: number) => (x1 - x0) ** 2 + (y1 - y0) ** 2 <= max * max;
  if (fits(ax, ay, bx, by)) return [[ax, ay, bx, by]];
  let n = Math.ceil(Math.hypot(bx - ax, by - ay) / L / (MAX_FREE_WALL_CELLS - margin));
  for (;;) {
    const points: [number, number][] = [];
    for (let k = 0; k <= n; k++) points.push([Math.round(ax + ((bx - ax) * k) / n), Math.round(ay + ((by - ay) * k) / n)]);
    points[n] = [bx, by];
    const parts: [number, number, number, number][] = [];
    let ok = true;
    for (let k = 0; k < n; k++) {
      const [x0, y0] = points[k]!;
      const [x1, y1] = points[k + 1]!;
      if (!fits(x0, y0, x1, y1)) {
        ok = false;
        break;
      }
      parts.push([x0, y0, x1, y1]);
    }
    if (ok) return parts;
    n++;
  }
}
