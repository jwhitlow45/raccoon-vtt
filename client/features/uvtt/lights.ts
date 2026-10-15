import { LIMITS } from "#shared/limits.ts";
import { MAX_LIGHT_FT } from "#shared/model.ts";
import { LIGHT_NEAR_WALL, LIGHT_STEP_OFF } from "./limits.ts";
import type { Point, UvttLight } from "./schema.ts";
import { segmentDist2, snap } from "./simplify.ts";

/**
 * Imported lights (docs/design-v1-maps-vision.md section 3.1 step 7). A
 * light's `range` is read as the Foundry importer reads it: dim light out to
 * `range` squares, bright to half of it, so bright `range / 2` and dim
 * `range / 2` beyond, in feet at the room's scale and capped at the SRD's
 * largest light. Positions go on the 1/64 lattice that sight's exact
 * on-wall test needs (section 3.6).
 */

/** A light ready for `build.lights`, without its id. */
export type LightPlan = { x: number; y: number; bright: number; dim: number; color?: string; on: true; walls: boolean };

/** A wall segment in squares, for the light's step off a wall. */
export type SightSegment = { a: Point; b: Point };

/** The last six hex digits of the file's color, which may carry an alpha byte first, or nothing when it is not hex. */
export function lightColor(raw: string | null): string | undefined {
  const hex = raw?.trim().replace(/^#/, "") ?? "";
  if (hex.length < 6 || !/^[0-9a-f]+$/i.test(hex)) return undefined;
  return `#${hex.slice(-6).toLowerCase()}`;
}

/** Feet at the room's scale, to the half foot, capped at MAX_LIGHT_FT. */
function feet(squares: number, feetPerCell: number): number {
  return Math.min(MAX_LIGHT_FT, Math.round(squares * feetPerCell * 2) / 2);
}

const RAYS = 64;

/**
 * Roughly how much of the scene a light at p lights within `reach`
 * squares: the sum of squared ray lengths, each stopped by the first wall
 * or the scene's edge. Only compared between the two sides of one wall, so
 * the scale does not matter.
 */
export function litArea(p: Point, reach: number, segments: readonly SightSegment[], bounds: { w: number; h: number }): number {
  const near = segments.filter((s) => segmentDist2(p, s.a, s.b) <= reach * reach);
  let total = 0;
  for (let k = 0; k < RAYS; k++) {
    const angle = (2 * Math.PI * k) / RAYS;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    let t = reach;
    // Ground outside the scene is not there to light.
    if (dx > 0) t = Math.min(t, (bounds.w - p.x) / dx);
    if (dx < 0) t = Math.min(t, -p.x / dx);
    if (dy > 0) t = Math.min(t, (bounds.h - p.y) / dy);
    if (dy < 0) t = Math.min(t, -p.y / dy);
    for (const s of near) {
      const ex = s.b.x - s.a.x;
      const ey = s.b.y - s.a.y;
      const den = dx * ey - dy * ex;
      if (den === 0) continue;
      const wx = s.a.x - p.x;
      const wy = s.a.y - p.y;
      const along = (wx * ey - wy * ex) / den;
      const on = (wx * dy - wy * dx) / den;
      if (along > 0 && along < t && on >= 0 && on <= 1) t = along;
    }
    total += Math.max(0, t) ** 2;
  }
  return total;
}

function nearest(p: Point, segments: readonly SightSegment[], within: number): SightSegment | null {
  let best: SightSegment | null = null;
  let best2 = within * within;
  for (const s of segments) {
    const d2 = segmentDist2(p, s.a, s.b);
    if (d2 <= best2) {
      best2 = d2;
      best = s;
    }
  }
  return best;
}

/**
 * A wall-mounted torch sits on its wall, and a light on a wall line would
 * light both sides. So a light within LIGHT_NEAR_WALL of a sight segment
 * moves LIGHT_STEP_OFF off it, along the wall's normal, to the side that
 * lights more, and back onto the lattice. Then it is checked once more,
 * since a corner puts it near a second wall. Whatever is still near a wall
 * after that is left to sight's own step (section 4.3.2).
 */
export function stepOffWalls(p: Point, reach: number, segments: readonly SightSegment[], bounds: { w: number; h: number }): { at: Point; moved: boolean } {
  let at = p;
  let moved = false;
  for (let round = 0; round < 2; round++) {
    const wall = nearest(at, segments, LIGHT_NEAR_WALL);
    if (!wall) break;
    const ex = wall.b.x - wall.a.x;
    const ey = wall.b.y - wall.a.y;
    const len = Math.hypot(ex, ey);
    if (len === 0) break;
    const nx = -ey / len;
    const ny = ex / len;
    // From the closest point of the wall's line, so the light ends up a clear step from it on either side.
    const t = ((at.x - wall.a.x) * ex + (at.y - wall.a.y) * ey) / (len * len);
    const cx = wall.a.x + t * ex;
    const cy = wall.a.y + t * ey;
    const place = (sign: number): Point => ({
      x: snap(Math.min(bounds.w, Math.max(0, cx + sign * LIGHT_STEP_OFF * nx))),
      y: snap(Math.min(bounds.h, Math.max(0, cy + sign * LIGHT_STEP_OFF * ny))),
    });
    // A side the scene's edge stops short of the step, so the light would stay on the wall, is no side.
    const clear = (q: Point) => segmentDist2(q, wall.a, wall.b) > LIGHT_NEAR_WALL * LIGHT_NEAR_WALL;
    const area = (q: Point) => (clear(q) ? litArea(q, reach, segments, bounds) : -1);
    const plus = place(1);
    const minus = place(-1);
    at = area(minus) > area(plus) ? minus : plus;
    moved = true;
  }
  return { at, moved };
}

export type PlacedLights = { lights: LightPlan[]; leftOut: number; outside: number; moved: number };

/**
 * The file's lights in scene squares (already through the import's one
 * transform), placed: those outside the scene dropped, at most
 * LIMITS.lightsPerScene kept by largest range, each snapped to the lattice
 * and stepped off a wall it sits on.
 */
export function placeLights(
  lights: readonly UvttLight[],
  segments: readonly SightSegment[],
  bounds: { w: number; h: number },
  feetPerCell: number,
): PlacedLights {
  const inside = lights.filter((l) => l.at.x >= 0 && l.at.y >= 0 && l.at.x <= bounds.w && l.at.y <= bounds.h);
  // A stable sort, so lights of equal range keep the file's order.
  const kept = inside
    .map((l, i) => ({ l, i }))
    .sort((a, b) => b.l.range - a.l.range || a.i - b.i)
    .slice(0, LIMITS.lightsPerScene)
    .sort((a, b) => a.i - b.i)
    .map((e) => e.l);
  let moved = 0;
  const out: LightPlan[] = kept.map((l) => {
    const snapped = { x: snap(l.at.x), y: snap(l.at.y) };
    const step = stepOffWalls(snapped, Math.max(1, l.range), segments, bounds);
    if (step.moved) moved++;
    const half = l.range / 2;
    const light: LightPlan = { x: step.at.x, y: step.at.y, bright: feet(half, feetPerCell), dim: feet(half, feetPerCell), on: true, walls: l.shadows };
    const color = lightColor(l.color);
    if (color) light.color = color;
    return light;
  });
  return { lights: out, leftOut: inside.length - kept.length, outside: lights.length - inside.length, moved };
}
