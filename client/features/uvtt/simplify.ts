import { FREE_WALL_LATTICE } from "#shared/model.ts";
import type { Point } from "./schema.ts";

/**
 * Wall polylines, made fewer and put on the lattice
 * (docs/design-v1-maps-vision.md section 3.1 step 4): points closer than
 * a tenth of a square merged, then Douglas-Peucker, then every coordinate
 * snapped to 1/64 cell, where free walls must lie. Exporters trace curved
 * walls with a point every few pixels, so a cave wall comes down from
 * hundreds of points to a handful without moving visibly.
 */

/** A coordinate on the 1/64 cell lattice. Rounding never moves it more than 1/128. */
export function snap(v: number): number {
  return Math.round(v * FREE_WALL_LATTICE) / FREE_WALL_LATTICE;
}

function dist2(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** Squared distance from p to the segment a b, or to a itself when the segment has no length. */
export function segmentDist2(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist2(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return dist2(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/**
 * Drops points closer than `min` to the last one kept. The line's last
 * point always stays, taking the place of the last one kept when the two
 * are too close, so a polyline's ends never move here: other walls meet
 * them. A line shorter than `min` collapses to one point and is dropped.
 */
export function mergeClose(line: readonly Point[], min: number): Point[] {
  if (line.length < 2) return [];
  const min2 = min * min;
  const kept: Point[] = [line[0]!];
  for (let i = 1; i < line.length - 1; i++) {
    if (dist2(line[i]!, kept[kept.length - 1]!) >= min2) kept.push(line[i]!);
  }
  const last = line[line.length - 1]!;
  if (dist2(last, kept[kept.length - 1]!) >= min2) kept.push(last);
  else if (kept.length > 1) kept[kept.length - 1] = last;
  return kept.length >= 2 ? kept : [];
}

/**
 * Douglas-Peucker: keeps the point farthest from the chord while it is
 * farther than `tolerance`, then does the same on each side. A stack
 * instead of recursion, so a 200,000-point line cannot overflow it. A
 * closed ring, whose chord has no length, measures from its first point.
 */
export function douglasPeucker(line: readonly Point[], tolerance: number): Point[] {
  if (line.length <= 2) return [...line];
  const keep = new Uint8Array(line.length);
  keep[0] = 1;
  keep[line.length - 1] = 1;
  const tol2 = tolerance * tolerance;
  const stack: [number, number][] = [[0, line.length - 1]];
  while (stack.length > 0) {
    const [i, j] = stack.pop()!;
    let farthest = -1;
    let far2 = tol2;
    for (let k = i + 1; k < j; k++) {
      const d2 = segmentDist2(line[k]!, line[i]!, line[j]!);
      if (d2 > far2) {
        far2 = d2;
        farthest = k;
      }
    }
    if (farthest < 0) continue;
    keep[farthest] = 1;
    stack.push([i, farthest], [farthest, j]);
  }
  return line.filter((_, k) => keep[k] === 1);
}

/** One wall polyline merged, simplified and snapped, with repeated points gone. Empty when nothing of it is left. */
export function simplifyLine(line: readonly Point[], tolerance: number, mergeMin: number): Point[] {
  const simplified = douglasPeucker(mergeClose(line, mergeMin), tolerance);
  const out: Point[] = [];
  for (const p of simplified) {
    const q = { x: snap(p.x), y: snap(p.y) };
    const prev = out[out.length - 1];
    if (!prev || prev.x !== q.x || prev.y !== q.y) out.push(q);
  }
  return out.length >= 2 ? out : [];
}

/**
 * The parts of a polyline inside the rectangle from (0, 0) to (w, h), by
 * Liang-Barsky on each segment. A line that leaves and comes back becomes
 * several lines. `clipped` says whether anything was cut away.
 */
export function clipLine(line: readonly Point[], w: number, h: number): { parts: Point[][]; clipped: boolean } {
  const parts: Point[][] = [];
  let current: Point[] = [];
  let clipped = false;
  for (let i = 0; i + 1 < line.length; i++) {
    const seg = clipSegment(line[i]!, line[i + 1]!, w, h);
    if (!seg) {
      clipped = true;
      if (current.length > 0) parts.push(current);
      current = [];
      continue;
    }
    const [a, b, cutA, cutB] = seg;
    if (cutA || cutB) clipped = true;
    if (current.length === 0 || cutA) {
      if (current.length > 0) parts.push(current);
      current = [a];
    }
    current.push(b);
    if (cutB) {
      parts.push(current);
      current = [];
    }
  }
  if (current.length > 0) parts.push(current);
  return { parts: parts.filter((p) => p.length >= 2), clipped };
}

/** The part of a segment inside the rectangle, with whether each end was moved, or null when none of it is inside. */
export function clipSegment(a: Point, b: Point, w: number, h: number): [Point, Point, boolean, boolean] | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const edges: [number, number][] = [
    [-dx, a.x],
    [dx, w - a.x],
    [-dy, a.y],
    [dy, h - a.y],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  // A cut end lies on the border, but a rounded product can land a hair outside it.
  const inside = (x: number, y: number) => ({ x: Math.min(w, Math.max(0, x)), y: Math.min(h, Math.max(0, y)) });
  const start = t0 > 0 ? inside(a.x + t0 * dx, a.y + t0 * dy) : a;
  const end = t1 < 1 ? inside(a.x + t1 * dx, a.y + t1 * dy) : b;
  return [start, end, t0 > 0, t1 < 1];
}
