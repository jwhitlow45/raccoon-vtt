import type { FogOp, FogShape } from "#shared/model.ts";
import { MAX_FOG_CELLS, MAX_POLY_VERTICES, MAX_STROKE_POINTS } from "#shared/protocol.ts";
import { floodRoom, type BuildIndex } from "#shared/rules/walls.ts";

/**
 * The DM's fog gestures as fog ops (design sections 13.1 and 13.2). Each op
 * must fit the schema: a stroke has at most 500 points, a polygon at most
 * 200 vertices, a "cells" shape at most 2,000 cells. Longer strokes and
 * larger rooms become several ops.
 */

export type Point = { x: number; y: number };
export type Bounds = { w: number; h: number };
export type FogMode = FogOp["mode"];

/** Fog resolves to a quarter cell, so shapes snap there and the preview shows exactly what will flip. */
export function snapQuarter(v: number): number {
  return Math.round(v * 4) / 4;
}

export function snapPoint(p: Point): Point {
  return { x: snapQuarter(p.x), y: snapQuarter(p.y) };
}

/** The rectangle between two drag points, snapped, or null when it has no area. */
export function rectShape(a: Point, b: Point): Extract<FogShape, { kind: "rect" }> | null {
  const x0 = snapQuarter(Math.min(a.x, b.x));
  const y0 = snapQuarter(Math.min(a.y, b.y));
  const x1 = snapQuarter(Math.max(a.x, b.x));
  const y1 = snapQuarter(Math.max(a.y, b.y));
  return x1 > x0 && y1 > y0 ? { kind: "rect", x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** A closed polygon from tapped points, or null with fewer than three. Extra taps past the limit are dropped. */
export function polyShape(points: readonly Point[]): Extract<FogShape, { kind: "poly" }> | null {
  if (points.length < 3) return null;
  return { kind: "poly", points: points.slice(0, MAX_POLY_VERTICES).flatMap((p) => [p.x, p.y]) };
}

function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Douglas-Peucker: drops points closer than `epsilon` (cells) to the line
 * through their neighbors. Iterative, so a long stroke cannot overflow the
 * stack. The first and last points always stay.
 */
export function simplify(points: readonly Point[], epsilon: number): Point[] {
  if (points.length <= 2) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [i, j] = stack.pop()!;
    let worst = -1;
    let worstDist = epsilon;
    for (let k = i + 1; k < j; k++) {
      const d = segmentDistance(points[k]!, points[i]!, points[j]!);
      if (d > worstDist) {
        worst = k;
        worstDist = d;
      }
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push([i, worst], [worst, j]);
  }
  return points.filter((_, i) => keep[i] === 1);
}

/** How far a simplified stroke may stray from the finger, in cells: a fraction of a fog sub-cell. */
export const STROKE_EPSILON = 0.05;

/**
 * Brush strokes, simplified, as stroke shapes of at most 500 points.
 * Consecutive pieces share their joining point, so the pieces leave no gap.
 */
export function strokeShapes(
  points: readonly Point[],
  width: number,
  maxPoints: number = MAX_STROKE_POINTS,
): Extract<FogShape, { kind: "stroke" }>[] {
  const simple = simplify(points, STROKE_EPSILON);
  if (simple.length === 0) return [];
  const out: Extract<FogShape, { kind: "stroke" }>[] = [];
  for (let start = 0; ; start += maxPoints - 1) {
    const part = simple.slice(start, start + maxPoints);
    out.push({ kind: "stroke", width, points: part.flatMap((p) => [p.x, p.y]) });
    if (start + maxPoints >= simple.length) break;
  }
  return out;
}

/** Splits cell keys into "cells" shapes of at most 2,000 cells. */
export function cellShapes(cells: readonly string[], max: number = MAX_FOG_CELLS): Extract<FogShape, { kind: "cells" }>[] {
  const out: Extract<FogShape, { kind: "cells" }>[] = [];
  for (let i = 0; i < cells.length; i += max) out.push({ kind: "cells", cells: cells.slice(i, i + max) });
  return out;
}

/**
 * "Reveal room" (design 13.2): the builder room under the tap, from a flood
 * fill bounded by walls, windows and closed doors. The fill is capped at the
 * scene's area, the most any room can hold, so its work is bounded however
 * the build looks. Empty when the tap is not on a builder floor.
 */
export function roomShapes(build: BuildIndex, at: Point, bounds: Bounds): { shapes: Extract<FogShape, { kind: "cells" }>[]; cells: number } {
  const { cells } = floodRoom(build, at, { bounds, maxCells: bounds.w * bounds.h });
  return { shapes: cellShapes(cells), cells: cells.length };
}

export function fogOps(shapes: readonly FogShape[], mode: FogMode, newId: () => string): FogOp[] {
  return shapes.map((shape) => ({ id: newId(), mode, shape }));
}

/**
 * The outline of a set of cells, as flat segments `[ax, ay, bx, by, ...]`:
 * every cell side that does not touch another cell of the set. For drawing a
 * "reveal room" draft as an outline.
 */
export function cellsOutline(cells: readonly string[]): number[] {
  const set = new Set(cells);
  const out: number[] = [];
  for (const key of set) {
    const [xs, ys] = key.split(",");
    const x = Number(xs);
    const y = Number(ys);
    if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
    if (!set.has(`${x},${y - 1}`)) out.push(x, y, x + 1, y);
    if (!set.has(`${x},${y + 1}`)) out.push(x, y + 1, x + 1, y + 1);
    if (!set.has(`${x - 1},${y}`)) out.push(x, y, x, y + 1);
    if (!set.has(`${x + 1},${y}`)) out.push(x + 1, y, x + 1, y + 1);
  }
  return out;
}

/**
 * The draft's publish button, named for what it does to the players' view:
 * a draft of reveals clears fog, one of hides adds it, and a mix does both.
 * The count is the number of draft edits.
 */
export function publishLabel(ops: readonly { mode: FogMode }[]): string {
  const n = ops.length;
  if (ops.every((o) => o.mode === "reveal")) return `Reveal to players (${n})`;
  if (ops.every((o) => o.mode === "hide")) return `Fog for players (${n})`;
  return `Show players the changes (${n})`;
}

/** A brush width, in cells, as the room measures: "10 ft" at 5 ft a square. */
export function brushLabel(cells: number, feetPerCell: number): string {
  return `${cells * feetPerCell} ft`;
}
