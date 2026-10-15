/**
 * Geometry primitives shared by the rules modules.
 *
 * World units are grid cells (design section 5). Nothing here knows about
 * feet: callers convert before calling. Angles are degrees clockwise from +x
 * on a y-down canvas, so the vector for 90 points down the screen (south).
 */

export type Point = { x: number; y: number };
export type Point3 = { x: number; y: number; z: number };
/** An axis-aligned rectangle by its top-left corner and size. */
export type Rect = { x: number; y: number; w: number; h: number };
/** An axis-aligned box by its low and high corners. */
export type Bounds = { x0: number; y0: number; x1: number; y1: number };

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * The unit vector for a yaw. Multiples of 90 degrees return exact axis
 * vectors, so a cone or line aimed along the grid has edges exactly on grid
 * lines instead of a rounding error away from them.
 */
export function yawVector(yawDeg: number): Point {
  const deg = ((yawDeg % 360) + 360) % 360;
  if (deg === 0) return { x: 1, y: 0 };
  if (deg === 90) return { x: 0, y: 1 };
  if (deg === 180) return { x: -1, y: 0 };
  if (deg === 270) return { x: 0, y: -1 };
  const rad = (deg * Math.PI) / 180;
  return { x: Math.cos(rad), y: Math.sin(rad) };
}

/** Distance from (px, py) to the segment from (ax, ay) to (bx, by). */
export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const ex = bx - ax;
  const ey = by - ay;
  const len2 = ex * ex + ey * ey;
  let t = len2 > 0 ? ((px - ax) * ex + (py - ay) * ey) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + t * ex);
  const dy = py - (ay + t * ey);
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Exact signed distance from a point to a box centered on the origin with
 * half extents (hx, hy, hz). Negative inside.
 */
export function sdBox3(px: number, py: number, pz: number, hx: number, hy: number, hz: number): number {
  const qx = Math.abs(px) - hx;
  const qy = Math.abs(py) - hy;
  const qz = Math.abs(pz) - hz;
  const ox = qx > 0 ? qx : 0;
  const oy = qy > 0 ? qy : 0;
  const oz = qz > 0 ? qz : 0;
  const inner = Math.max(qx, qy, qz);
  return Math.sqrt(ox * ox + oy * oy + oz * oz) + (inner < 0 ? inner : 0);
}

/**
 * Exact signed distance in a 2D profile where `a` and `b` are the point's
 * offsets past two perpendicular boundaries (negative means inside that
 * boundary). It is the SDF of the intersection of two slabs, which is what a
 * capped cylinder is in (radial distance, height) space.
 */
export function sdCorner2(a: number, b: number): number {
  const oa = a > 0 ? a : 0;
  const ob = b > 0 ? b : 0;
  const inner = a > b ? a : b;
  return Math.sqrt(oa * oa + ob * ob) + (inner < 0 ? inner : 0);
}
