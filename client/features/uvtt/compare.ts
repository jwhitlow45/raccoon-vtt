import type { ImportPlan } from "./convert.ts";
import type { Point, UvttMap } from "./schema.ts";

/**
 * Whether this app's import would change an exported file's walls
 * (docs/design/design-v1-uvtt-export.md section 6, D-261127-295). Both sides go
 * into one canonical form first, since the same walls can be written in
 * more than one way: a run exports as one line and imports as one edge per
 * cell, and a free wall along a grid line between intersections imports
 * as grid edges (snap.ts pinGrid).
 *
 * - Pieces along one grid line with both ends on grid intersections become
 *   unit edges by kind, compared as sets.
 * - Every other piece is free, a pillar counting as its four sides. Each
 *   one must lie within COVER_SQUARES of the union of the other side's
 *   free pieces of its kind, both ways. Doors and windows are counted too,
 *   since one door can never be two.
 */

export const COVER_SQUARES = 0.2;

type Kind = "wall" | "door" | "window";
type Seg = { a: Point; b: Point };
export type Canonical = { edges: Record<Kind, Set<string>>; free: Record<Kind, Seg[]> };

function empty(): Canonical {
  return { edges: { wall: new Set(), door: new Set(), window: new Set() }, free: { wall: [], door: [], window: [] } };
}

function add(into: Canonical, a: Point, b: Point, kind: Kind): void {
  const grid = Number.isInteger(a.x) && Number.isInteger(a.y) && Number.isInteger(b.x) && Number.isInteger(b.y) && (a.x === b.x) !== (a.y === b.y);
  if (!grid) {
    into.free[kind].push({ a, b });
    return;
  }
  if (a.y === b.y) for (let x = Math.min(a.x, b.x); x < Math.max(a.x, b.x); x++) into.edges[kind].add(`${x},${a.y},n`);
  else for (let y = Math.min(a.y, b.y); y < Math.max(a.y, b.y); y++) into.edges[kind].add(`${a.x},${y},w`);
}

/** The export's side, from the file as the import reads it, with objects on and open portals as windows: the dialog's defaults. */
export function canonicalOfFile(map: Pick<UvttMap, "walls" | "objects" | "portals" | "origin">): Canonical {
  const out = empty();
  const at = (p: Point) => ({ x: p.x - Math.floor(map.origin.x), y: p.y - Math.floor(map.origin.y) });
  for (const line of [...map.walls, ...map.objects]) {
    for (let i = 0; i + 1 < line.length; i++) add(out, at(line[i]!), at(line[i + 1]!), "wall");
  }
  for (const p of map.portals) add(out, at(p.a), at(p.b), p.closed ? "door" : "window");
  return out;
}

/** The import's side, from what it would store. */
export function canonicalOfPlan(plan: Pick<ImportPlan, "edges" | "walls">): Canonical {
  const out = empty();
  for (const e of plan.edges) out.edges[e.feature.kind].add(e.key);
  for (const w of plan.walls) add(out, { x: w.a[0], y: w.a[1] }, { x: w.b[0], y: w.b[1] }, w.f.kind);
  return out;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const k of a) if (!b.has(k)) return false;
  return true;
}

export function canonicalDiffers(exported: Canonical, imported: Canonical): boolean {
  for (const kind of ["wall", "door", "window"] as const) {
    if (!sameSet(exported.edges[kind], imported.edges[kind])) return true;
    if (kind !== "wall" && exported.free[kind].length !== imported.free[kind].length) return true;
    if (!coveredBy(exported.free[kind], imported.free[kind], COVER_SQUARES)) return true;
    if (!coveredBy(imported.free[kind], exported.free[kind], COVER_SQUARES)) return true;
  }
  return false;
}

/** Segments bucketed by the unit squares their boxes, grown by the radius, touch, so a coverage test reads only its neighbors. */
class Buckets {
  readonly #cells = new Map<number, number[]>();
  readonly r: number;
  constructor(segs: readonly Seg[], r: number) {
    this.r = r;
    segs.forEach((s, i) => {
      for (const key of this.keys(s)) {
        const list = this.#cells.get(key);
        if (list) list.push(i);
        else this.#cells.set(key, [i]);
      }
    });
  }
  *keys(s: Seg): Generator<number> {
    const x0 = Math.floor(Math.min(s.a.x, s.b.x) - this.r);
    const x1 = Math.floor(Math.max(s.a.x, s.b.x) + this.r);
    const y0 = Math.floor(Math.min(s.a.y, s.b.y) - this.r);
    const y1 = Math.floor(Math.max(s.a.y, s.b.y) + this.r);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) yield (x + 1024) * 4096 + (y + 1024);
  }
  near(s: Seg): Set<number> {
    const out = new Set<number>();
    for (const key of this.keys(s)) for (const i of this.#cells.get(key) ?? []) out.add(i);
    return out;
  }
}

/** Whether every point of every segment in `pieces` lies within `r` of some segment in `union`. */
export function coveredBy(pieces: readonly Seg[], union: readonly Seg[], r: number): boolean {
  if (pieces.length === 0) return true;
  if (union.length === 0) return false;
  const buckets = new Buckets(union, r);
  for (const p of pieces) {
    const spans: [number, number][] = [];
    for (const i of buckets.near(p)) {
      const span = capsuleSpan(p, union[i]!, r);
      if (span) spans.push(span);
    }
    if (!spansCover(spans)) return false;
  }
  return true;
}

/** Rounding in the spans' arithmetic, far below anything the lattice can tell apart. */
const EPS = 1e-9;

function spansCover(spans: [number, number][]): boolean {
  spans.sort((a, b) => a[0] - b[0]);
  let reach = 0;
  for (const [lo, hi] of spans) {
    if (lo > reach + EPS) return false;
    reach = Math.max(reach, hi);
    if (reach >= 1 - EPS) return true;
  }
  return reach >= 1 - EPS;
}

/**
 * The part of segment p, as t from 0 to 1, within r of segment q: where
 * p's line meets q's capsule. The capsule is convex, so that is one
 * interval, the hull of where the line meets its rectangle and its two
 * end disks. Null when they do not meet within p.
 */
export function capsuleSpan(p: Seg, q: Seg, r: number): [number, number] | null {
  const dx = p.b.x - p.a.x;
  const dy = p.b.y - p.a.y;
  let lo = Infinity;
  let hi = -Infinity;
  const take = (span: [number, number] | null) => {
    if (!span) return;
    lo = Math.min(lo, span[0]);
    hi = Math.max(hi, span[1]);
  };
  take(diskSpan(p.a, dx, dy, q.a, r));
  take(diskSpan(p.a, dx, dy, q.b, r));
  const ex = q.b.x - q.a.x;
  const ey = q.b.y - q.a.y;
  const len = Math.hypot(ex, ey);
  if (len > 0) {
    // Inside the rectangle: projection onto q between its ends, and distance off q's line at most r, each linear in t.
    let span: [number, number] | null = [-Infinity, Infinity];
    const between = (c0: number, c1: number, min: number, max: number) => {
      // c0 + c1 t in [min, max]
      if (!span) return;
      if (c1 === 0) {
        if (c0 < min - EPS || c0 > max + EPS) span = null;
        return;
      }
      const t0 = (min - c0) / c1;
      const t1 = (max - c0) / c1;
      const a = Math.min(t0, t1);
      const b = Math.max(t0, t1);
      span = a > span[1] || b < span[0] ? null : [Math.max(span[0], a), Math.min(span[1], b)];
    };
    const wx = p.a.x - q.a.x;
    const wy = p.a.y - q.a.y;
    between((wx * ex + wy * ey) / len, (dx * ex + dy * ey) / len, 0, len);
    between((wx * ey - wy * ex) / len, (dx * ey - dy * ex) / len, -r, r);
    take(span);
  }
  if (lo > hi) return null;
  const a = Math.max(0, lo);
  const b = Math.min(1, hi);
  return a <= b + EPS ? [a, b] : null;
}

/** Where the line a + t (dx, dy) lies within r of c, or null. */
function diskSpan(a: Point, dx: number, dy: number, c: Point, r: number): [number, number] | null {
  const fx = a.x - c.x;
  const fy = a.y - c.y;
  const A = dx * dx + dy * dy;
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - r * r;
  if (A === 0) return C <= EPS ? [-Infinity, Infinity] : null;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  return [(-B - s) / (2 * A), (-B + s) / (2 * A)];
}
