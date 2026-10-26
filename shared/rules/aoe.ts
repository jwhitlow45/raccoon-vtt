import type { AoeCoverage, AreaFootprint, AreaShape, AreaTemplate, RoomSettings, Token, TokenId } from "../model.ts";
import { footprintRect, occupiedRange, tokenHeightFt, verticalExtentFt, type FootprintToken } from "./footprint.ts";
import { clamp, distToSegment, sdBox3, sdCorner2, yawVector, type Bounds, type Point, type Point3, type Rect } from "./geom.ts";
import { AREAS, stepOffWalls } from "./segments.ts";
import { cachedVisibility, crossingsAt, indexPolygon, insideCrossings, markPolygonCells, type Polygon, type PolygonIndex, type WallSet } from "./walls.ts";
import { SQUARES } from "./grid.ts";

/**
 * Areas of effect (design section 9.3).
 *
 * Every shape is a 3D predicate in cells (z converted from feet) with an
 * exact signed distance. Shading samples each cell at 16x16 points on the
 * horizontal slice through the template's origin height. Cells far enough
 * from the surface skip the sampling, which is what keeps a 1,000 ft area
 * cheap: only cells near the boundary, which grow with the perimeter, are
 * sampled. Walls clip the area through a visibility polygon from its origin.
 *
 * A cone or line aimed up or down (`pitch`) is a true 3D shape for the
 * creatures it catches, but its slice through the origin's height can be
 * little more than a point. It shades and outlines what it covers seen from
 * above instead, so the map shows where it reaches.
 */

/** Area sizes in feet (design section 10.5). */
export const AREA_MIN_FT = 5;
export const AREA_MAX_FT = 1000;
export const DEFAULT_LINE_WIDTH_FT = 5;
/** Most SRD cylinders (Flame Strike, Moonbeam, Ice Storm) are 40 ft high. */
export const DEFAULT_CYLINDER_HEIGHT_FT = 40;
/** Samples per cell side for a placed template. */
export const SAMPLES = 16;
/** Samples per cell side while a template is being aimed. */
export const PREVIEW_SAMPLES = 4;
/** Scene bounds in cells (design section 10.5). */
export const MAX_SCENE_CELLS = 200;
/** How far a cone or line aims up or down, in degrees: straight up or straight down. */
export const MAX_PITCH = 90;

/** The template fields geometry depends on. */
export type AreaTemplateInput = Pick<AreaTemplate, "id" | "rev" | "shape" | "size" | "origin" | "yaw" | "includeOrigin"> &
  Partial<Pick<AreaTemplate, "sceneId" | "width" | "height" | "pitch" | "faceOffset" | "anchor" | "attachedTo" | "footprint" | "casterId">>;

/** The token fields areas depend on. */
export type AreaToken = FootprintToken & Pick<Token, "id" | "rev"> & Partial<Pick<Token, "sceneId">>;

export type AreaContext = {
  settings: Pick<RoomSettings, "feetPerCell" | "aoeCoverage" | "aoeInclusion">;
  /** Scene size in cells. Coverage is clipped to it. */
  bounds: { w: number; h: number };
  /** The scene's derived walls, or null for a scene without a build. */
  walls?: WallSet | null;
  /** Tokens by id, used to resolve `attachedTo` and `casterId`. */
  tokens?: Readonly<Record<string, AreaToken>>;
  /** Samples per cell side: 16 by default, 4 while a template is being aimed. */
  samples?: number;
};

/** A shape in cells on every axis. */
export type Shape3 = {
  inside(x: number, y: number, z: number): boolean;
  /**
   * Signed distance to the surface in cells (negative inside), or a lower
   * bound on its size. Shading needs the distance within a horizontal slice,
   * and the 3D distance serves: the slice's outline is part of the 3D
   * surface, so no point of the outline is nearer than the 3D distance says.
   */
  sd(x: number, y: number, z: number): number;
  /** 2D bounds of every horizontal slice. */
  bounds: Bounds;
};

export type ResolvedArea = {
  shape: Shape3;
  /** Height in cells of the slice that shading uses, and the height creatures are measured against. */
  originZ: number;
  /** The token the area starts from: the attached token, or the caster when the origin is on it. */
  originTokenId: TokenId | undefined;
  /** The footprint an emanation surrounds, in cells, when it surrounds one rather than a point. */
  box?: Rect;
  /** Visibility polygons whose union clips the area. Empty on a scene without walls. */
  polygons: Polygon[];
  /**
   * A cone or line aimed up or down: what it covers seen from above, which
   * shading and picking use in place of the slice of `shape` at `originZ`,
   * and the same outline as a flat polygon `[x0, y0, x1, y1, ...]` for
   * drawing.
   */
  shade?: Shape3;
  outline?: number[];
  /**
   * A cone or line aimed up or down: the height in cells of its axis above a
   * map point. A creature there is measured at it among other heights of
   * its body (creaturesInArea), since the slice at the origin's height can
   * miss the area there entirely.
   */
  sliceZ?(x: number, y: number): number;
};

export type CoveredCell = { x: number; y: number; coverage: number };

export type CoverageResult = {
  key: string;
  samples: number;
  /** Cells that pass the room's coverage rule, with the fraction of their samples inside. */
  cells: CoveredCell[];
  /** The window of cells examined: the area's bounds clipped to the scene. */
  x0: number;
  y0: number;
  w: number;
  h: number;
  /** Inside samples per window cell, row-major, 0 to samples squared. */
  counts: Uint16Array;
  /** 1 when the cell's center point is inside. */
  centers: Uint8Array;
  /** 1 when the cell passes the coverage rule and is not the origin creature's own cell. */
  covered: Uint8Array;
};

const INCLUDE_ORIGIN: Record<AreaShape, boolean> = {
  sphere: true,
  cylinder: true,
  cone: false,
  cube: false,
  line: false,
  emanation: false,
};

/** Whether the point of origin (or the origin creature) is in the area by default. */
export function defaultIncludeOrigin(shape: AreaShape): boolean {
  return INCLUDE_ORIGIN[shape];
}

/** Whether a shape can aim up or down. */
export function canPitch(shape: AreaShape): boolean {
  return shape === "cone" || shape === "line";
}

/** A template's aim above level in degrees: 0 for shapes that cannot aim and for templates from before it. */
export function pitchOf(t: { shape: AreaShape; pitch?: number | null }): number {
  if (!canPitch(t.shape) || t.pitch === undefined || t.pitch === null || !Number.isFinite(t.pitch)) return 0;
  return clamp(t.pitch, -MAX_PITCH, MAX_PITCH);
}

function areaFt(v: number | undefined, fallback: number): number {
  return clamp(v !== undefined && Number.isFinite(v) ? v : fallback, AREA_MIN_FT, AREA_MAX_FT);
}

/**
 * The point on a footprint's edge that a cone, line or cube cast from it
 * starts at: where the yaw leaves the footprint, snapped to the nearest corner
 * or edge midpoint.
 */
export function edgeOrigin(rect: Rect, yawDeg: number): Point {
  const d = yawVector(yawDeg);
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const t = Math.min(d.x !== 0 ? rect.w / 2 / Math.abs(d.x) : Infinity, d.y !== 0 ? rect.h / 2 / Math.abs(d.y) : Infinity);
  const ex = cx + d.x * t;
  const ey = cy + d.y * t;
  let best: Point = { x: cx, y: cy };
  let bestDist = Infinity;
  for (const fy of [0, 0.5, 1]) {
    for (const fx of [0, 0.5, 1]) {
      if (fx === 0.5 && fy === 0.5) continue;
      const px = rect.x + fx * rect.w;
      const py = rect.y + fy * rect.h;
      const dist = Math.hypot(px - ex, py - ey);
      if (dist < bestDist) {
        bestDist = dist;
        best = { x: px, y: py };
      }
    }
  }
  return best;
}

/**
 * Defaults for a template cast from a token. Cones and lines start on the
 * caster's edge at its middle height. A cube starts on the caster's edge with
 * the origin at the middle of the cube's face, which puts the cube's bottom at
 * the caster's elevation. Spheres and emanations center on the caster, and a
 * cylinder's anchored circle sits at the caster's feet (bottom) or head (top).
 */
export function castFromToken(
  area: { shape: AreaShape; size: number; yaw: number; anchor?: "bottom" | "top" },
  caster: FootprintToken,
  feetPerCell: number,
): { origin: { x: number; y: number; z: number }; faceOffset?: { u: number; v: number }; includeOrigin: boolean } {
  const rect = footprintRect(SQUARES, caster);
  const height = tokenHeightFt(caster, feetPerCell);
  const center = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
  const includeOrigin = INCLUDE_ORIGIN[area.shape];
  switch (area.shape) {
    case "cone":
    case "line":
      return { origin: { ...edgeOrigin(rect, area.yaw), z: caster.elevation + height / 2 }, includeOrigin };
    case "cube":
      return {
        origin: { ...edgeOrigin(rect, area.yaw), z: caster.elevation + areaFt(area.size, AREA_MIN_FT) / 2 },
        faceOffset: { u: 0, v: 0 },
        includeOrigin,
      };
    case "cylinder":
      return { origin: { ...center, z: caster.elevation + (area.anchor === "top" ? height : 0) }, includeOrigin };
    case "sphere":
    case "emanation":
      return { origin: { ...center, z: caster.elevation + height / 2 }, includeOrigin };
  }
}

/** What an emanation that stays put keeps of the token it was cast from (`AreaTemplate.footprint`). */
export function emanationFootprint(token: FootprintToken, feetPerCell: number): AreaFootprint {
  const r = footprintRect(SQUARES, token);
  return { w: r.w, h: r.h, elevation: token.elevation, height: tokenHeightFt(token, feetPerCell) };
}

function sphereShape(ox: number, oy: number, oz: number, r: number): Shape3 {
  const r2 = r * r;
  return {
    inside(x, y, z) {
      const dx = x - ox;
      const dy = y - oy;
      const dz = z - oz;
      return dx * dx + dy * dy + dz * dz <= r2;
    },
    sd(x, y, z) {
      const dx = x - ox;
      const dy = y - oy;
      const dz = z - oz;
      return Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
    },
    bounds: { x0: ox - r, y0: oy - r, x1: ox + r, y1: oy + r },
  };
}

function cylinderShape(ox: number, oy: number, zLo: number, zHi: number, r: number): Shape3 {
  const r2 = r * r;
  const zc = (zLo + zHi) / 2;
  const hz = (zHi - zLo) / 2;
  return {
    inside(x, y, z) {
      const dx = x - ox;
      const dy = y - oy;
      return dx * dx + dy * dy <= r2 && z >= zLo && z <= zHi;
    },
    sd(x, y, z) {
      const dx = x - ox;
      const dy = y - oy;
      return sdCorner2(Math.sqrt(dx * dx + dy * dy) - r, Math.abs(z - zc) - hz);
    },
    bounds: { x0: ox - r, y0: oy - r, x1: ox + r, y1: oy + r },
  };
}

/**
 * The frame of an aimed area: `a` along its axis, `n` level and square to
 * it (to the right of the aim on the map), and `m` square to both, up when
 * the area is level. Straight up and straight down are exact, so a cone
 * aimed at the zenith has no rounding error that tips it.
 */
type AimFrame = { a: Point3; n: Point3; m: Point3 };

function aimFrame(yawDeg: number, pitchDeg: number): AimFrame {
  const d = yawVector(yawDeg);
  const vertical = Math.abs(pitchDeg) === MAX_PITCH;
  const c = vertical ? 0 : Math.cos((pitchDeg * Math.PI) / 180);
  const s = vertical ? Math.sign(pitchDeg) : Math.sin((pitchDeg * Math.PI) / 180);
  return { a: { x: d.x * c, y: d.y * c, z: s }, n: { x: -d.y, y: d.x, z: 0 }, m: { x: -s * d.x, y: -s * d.y, z: c } };
}

/*
 * A right circular cone with its apex at the origin, its axis along `a`,
 * length L, and a base of diameter L. Its signed distance is exact: the
 * cone is a solid of revolution, so the nearest surface point lies in the
 * plane through the axis and the point, where the surface is two segments,
 * the slant from the apex to the rim and the base from the rim to the axis.
 * A level cone's frame has `m` straight up, so it reads the point's height
 * offset unchanged.
 */
function coneShape(ox: number, oy: number, oz: number, f: AimFrame, L: number): Shape3 {
  const { a, n, m } = f;
  const half = L / 2;
  const tipX = ox + a.x * L;
  const tipY = oy + a.y * L;
  // The base circle seen from above spans its radius times the axis's reach off each map axis.
  const ex = half * Math.sqrt(a.y * a.y + a.z * a.z);
  const ey = half * Math.sqrt(a.x * a.x + a.z * a.z);
  return {
    inside(x, y, z) {
      const rx = x - ox;
      const ry = y - oy;
      const rz = z - oz;
      const u = rx * a.x + ry * a.y + rz * a.z;
      if (u < 0 || u > L) return false;
      const w = rx * n.x + ry * n.y;
      const h = rx * m.x + ry * m.y + rz * m.z;
      return 4 * (w * w + h * h) <= u * u;
    },
    sd(x, y, z) {
      const rx = x - ox;
      const ry = y - oy;
      const rz = z - oz;
      const u = rx * a.x + ry * a.y + rz * a.z;
      const w = rx * n.x + ry * n.y;
      const h = rx * m.x + ry * m.y + rz * m.z;
      const v = Math.sqrt(w * w + h * h);
      const d = Math.min(distToSegment(u, v, 0, 0, L, half), distToSegment(u, v, L, 0, L, half));
      return u >= 0 && u <= L && 2 * v <= u ? -d : d;
    },
    bounds: {
      x0: Math.min(ox, tipX - ex),
      y0: Math.min(oy, tipY - ey),
      x1: Math.max(ox, tipX + ex),
      y1: Math.max(oy, tipY + ey),
    },
  };
}

/** A box centered on c with half extents hu along `a`, hw along `n` and hh along `m`: a line aimed up or down. */
function aimedBoxShape(c: Point3, f: AimFrame, hu: number, hw: number, hh: number): Shape3 {
  const { a, n, m } = f;
  const ex = Math.abs(a.x) * hu + Math.abs(n.x) * hw + Math.abs(m.x) * hh;
  const ey = Math.abs(a.y) * hu + Math.abs(n.y) * hw + Math.abs(m.y) * hh;
  const local = (x: number, y: number, z: number): [number, number, number] => {
    const rx = x - c.x;
    const ry = y - c.y;
    const rz = z - c.z;
    return [rx * a.x + ry * a.y + rz * a.z, rx * n.x + ry * n.y, rx * m.x + ry * m.y + rz * m.z];
  };
  return {
    inside(x, y, z) {
      const [u, w, h] = local(x, y, z);
      return Math.abs(u) <= hu && Math.abs(w) <= hw && Math.abs(h) <= hh;
    },
    sd(x, y, z) {
      const [u, w, h] = local(x, y, z);
      return sdBox3(u, w, h, hu, hw, hh);
    },
    bounds: { x0: c.x - ex, y0: c.y - ey, x1: c.x + ex, y1: c.y + ey },
  };
}

/** The convex hull of points, counterclockwise on a y-down map (Andrew's monotone chain). */
function convexHull(points: Point[]): Point[] {
  const sorted = [...points].sort((p, q) => p.x - q.x || p.y - q.y);
  if (sorted.length < 3) return sorted;
  const cross = (o: Point, p: Point, q: Point) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const lower: Point[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/**
 * A convex polygon as a prism through every height, for what an aimed
 * area covers seen from above. Its signed distance is exact in the plane.
 */
function prismShape(hull: Point[]): Shape3 {
  const k = hull.length;
  const xs = hull.map((p) => p.x);
  const ys = hull.map((p) => p.y);
  const inside = (x: number, y: number) => {
    if (k < 3) return false;
    for (let i = 0; i < k; i++) {
      const p = hull[i]!;
      const q = hull[(i + 1) % k]!;
      if ((q.x - p.x) * (y - p.y) - (q.y - p.y) * (x - p.x) < 0) return false;
    }
    return true;
  };
  return {
    inside: (x, y) => inside(x, y),
    sd(x, y) {
      let d = Infinity;
      for (let i = 0; i < k; i++) {
        const p = hull[i]!;
        const q = hull[(i + 1) % k]!;
        d = Math.min(d, distToSegment(x, y, p.x, p.y, q.x, q.y));
      }
      return inside(x, y) ? -d : d;
    },
    bounds: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) },
  };
}

/** Points on the rim of an aimed cone's base, enough that the outline seen from above reads as round. */
const RIM_POINTS = 32;

/**
 * An aimed cone or line seen from above: its shape for shading and picking,
 * its outline for drawing, and where along its axis a creature at a map
 * point is measured.
 */
function aimedTopView(hull: Point[], ox: number, oy: number, oz: number, f: AimFrame, L: number): Pick<ResolvedArea, "shade" | "outline" | "sliceZ"> {
  const level = Math.hypot(f.a.x, f.a.y);
  const dx = level > 0 ? f.a.x / level : 0;
  const dy = level > 0 ? f.a.y / level : 0;
  return {
    shade: prismShape(hull),
    outline: hull.flatMap((p) => [p.x, p.y]),
    sliceZ(x, y) {
      // The point of the axis above (x, y), or its far end when the axis stands straight up or down.
      const along = level > 1e-9 ? clamp(((x - ox) * dx + (y - oy) * dy) / level, 0, L) : L;
      return oz + f.a.z * along;
    },
  };
}

/** A box centered on (cx, cy, cz) with half extents hu along (dx, dy), hw across it, and hz up. */
function orientedBoxShape(cx: number, cy: number, cz: number, dx: number, dy: number, hu: number, hw: number, hz: number): Shape3 {
  const ex = Math.abs(dx) * hu + Math.abs(dy) * hw;
  const ey = Math.abs(dy) * hu + Math.abs(dx) * hw;
  return {
    inside(x, y, z) {
      const rx = x - cx;
      const ry = y - cy;
      return Math.abs(rx * dx + ry * dy) <= hu && Math.abs(ry * dx - rx * dy) <= hw && Math.abs(z - cz) <= hz;
    },
    sd(x, y, z) {
      const rx = x - cx;
      const ry = y - cy;
      return sdBox3(rx * dx + ry * dy, ry * dx - rx * dy, z - cz, hu, hw, hz);
    },
    bounds: { x0: cx - ex, y0: cy - ey, x1: cx + ex, y1: cy + ey },
  };
}

/** Everything within D of the box [x0, x1] x [y0, y1] x [z0, z1]. */
function emanationShape(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, D: number): Shape3 {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const cz = (z0 + z1) / 2;
  const hx = (x1 - x0) / 2;
  const hy = (y1 - y0) / 2;
  const hz = (z1 - z0) / 2;
  const D2 = D * D;
  return {
    inside(x, y, z) {
      const ex = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
      const ey = y < y0 ? y0 - y : y > y1 ? y - y1 : 0;
      const ez = z < z0 ? z0 - z : z > z1 ? z - z1 : 0;
      return ex * ex + ey * ey + ez * ez <= D2;
    },
    sd(x, y, z) {
      return sdBox3(x - cx, y - cy, z - cz, hx, hy, hz) - D;
    },
    bounds: { x0: x0 - D, y0: y0 - D, x1: x1 + D, y1: y1 + D },
  };
}

/**
 * A point visibility is computed from, and the point it steps toward off a
 * wall, whose side it keeps: the origin creature's center, or null.
 */
type Probe = { at: Point; prefer: Point | null };

/*
 * A sweep ignores a wall through its origin, so an origin on a wall, such
 * as a cone starting on the corner of a caster who stands against a wall,
 * would see both sides of it. So an origin on or near a wall that stops
 * areas is stepped off it with the exact step sight uses (segments.ts
 * `stepOffWalls`, section 4.3.2): toward the creature it starts from where
 * the walls allow, to that creature's side of a wall it is exactly on, and
 * to its own side of a wall it is only near. A tiny nudge in a fixed
 * direction would slide along any wall parallel to it. An origin that
 * cannot be stepped sees nothing, so the area covers nothing from it rather
 * than both sides.
 *
 * An origin near no wall still moves the millionth of a cell every origin
 * always has, toward the creature or southeast. Area reminders in the log
 * are rebuilt by replay (areaTriggers.ts), and without it a sample exactly
 * on a shadow's edge could fall the other way, so an area that touches no
 * wall covers exactly what it did before.
 */
const SEES_NOTHING: Polygon = new Float64Array(0);
const NUDGE = 1e-6;

function nudged(p: Point, toward: Point | null): Point {
  if (toward) {
    const dx = toward.x - p.x;
    const dy = toward.y - p.y;
    const len = Math.hypot(dx, dy);
    if (len > NUDGE) return { x: p.x + (dx / len) * NUDGE, y: p.y + (dy / len) * NUDGE };
  }
  return { x: p.x + 0.6 * NUDGE, y: p.y + 0.8 * NUDGE };
}

function visibleFrom(walls: WallSet, probe: Probe, bounds: { w: number; h: number }): Polygon {
  const { at, prefer } = probe;
  const stepped = stepOffWalls(at.x, at.y, walls.storedIndex, AREAS, prefer ?? undefined);
  if (!stepped) return SEES_NOTHING;
  const moved = stepped.x !== at.x || stepped.y !== at.y;
  return cachedVisibility(walls, moved ? stepped : nudged(at, prefer), bounds);
}

function rectCenter(r: Rect): Point {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

function sceneBounds(ctx: AreaContext): { w: number; h: number } {
  const dim = (v: number) => (Number.isFinite(v) ? clamp(Math.floor(v), 0, MAX_SCENE_CELLS) : 0);
  return { w: dim(ctx.bounds.w), h: dim(ctx.bounds.h) };
}

function feetPerCellOf(ctx: AreaContext): number {
  const fpc = ctx.settings.feetPerCell;
  return Number.isFinite(fpc) ? clamp(fpc, 1, 100) : 5;
}

/**
 * A template's geometry, with its attached token or caster resolved. Null
 * when its numbers are not finite, which only a broken op could produce.
 */
export function resolveArea(template: AreaTemplateInput, ctx: AreaContext): ResolvedArea | null {
  const fpc = feetPerCellOf(ctx);
  const attached = template.attachedTo ? ctx.tokens?.[template.attachedTo] : undefined;
  const caster = template.casterId ? ctx.tokens?.[template.casterId] : undefined;
  const sizeFt = areaFt(template.size, AREA_MIN_FT);
  const origin = attached
    ? castFromToken({ shape: template.shape, size: sizeFt, yaw: template.yaw, anchor: template.anchor }, attached, fpc).origin
    : template.origin;
  if (![origin.x, origin.y, origin.z, template.yaw].every(Number.isFinite)) return null;

  let originToken: AreaToken | undefined = attached;
  if (!originToken && caster) {
    const r = footprintRect(SQUARES, caster);
    const E = 1e-6;
    if (origin.x >= r.x - E && origin.x <= r.x + r.w + E && origin.y >= r.y - E && origin.y <= r.y + r.h + E) originToken = caster;
  }

  const ox = origin.x;
  const oy = origin.y;
  const oz = origin.z / fpc;
  const size = sizeFt / fpc;
  const d = yawVector(template.yaw);
  const pitch = pitchOf(template);
  let shape: Shape3;
  let originZ = oz;
  let probes: Probe[];
  let box: Rect | undefined;
  let top: Pick<ResolvedArea, "shade" | "outline" | "sliceZ"> | undefined;
  const toward = originToken ? rectCenter(footprintRect(SQUARES, originToken)) : null;

  switch (template.shape) {
    case "sphere":
      shape = sphereShape(ox, oy, oz, size);
      probes = [{ at: origin, prefer: toward }];
      break;
    case "cylinder": {
      const h = areaFt(template.height, DEFAULT_CYLINDER_HEIGHT_FT) / fpc;
      shape = template.anchor === "top" ? cylinderShape(ox, oy, oz - h, oz, size) : cylinderShape(ox, oy, oz, oz + h, size);
      probes = [{ at: origin, prefer: toward }];
      break;
    }
    case "cone": {
      const f = aimFrame(template.yaw, pitch);
      shape = coneShape(ox, oy, oz, f, size);
      if (pitch !== 0) {
        const base = { x: ox + f.a.x * size, y: oy + f.a.y * size };
        const rim: Point[] = [{ x: ox, y: oy }];
        for (let i = 0; i < RIM_POINTS; i++) {
          const t = (2 * Math.PI * i) / RIM_POINTS;
          const c = (Math.cos(t) * size) / 2;
          const s = (Math.sin(t) * size) / 2;
          rim.push({ x: base.x + c * f.n.x + s * f.m.x, y: base.y + c * f.n.y + s * f.m.y });
        }
        top = aimedTopView(convexHull(rim), ox, oy, oz, f, size);
      }
      probes = [{ at: origin, prefer: toward }];
      break;
    }
    case "cube": {
      const u = clamp(template.faceOffset?.u ?? 0, -0.5, 0.5);
      const v = clamp(template.faceOffset?.v ?? 0, -0.5, 0.5);
      const half = size / 2;
      // The origin sits u sides across the face (positive is clockwise of the yaw) and v sides up
      // it from the face's center, so the face's center is that far back the other way.
      const fx = ox + d.y * u * size;
      const fy = oy - d.x * u * size;
      shape = orientedBoxShape(fx + d.x * half, fy + d.y * half, oz - v * size, d.x, d.y, half, half, half);
      probes = [{ at: origin, prefer: toward }];
      break;
    }
    case "line": {
      const halfWidth = areaFt(template.width, DEFAULT_LINE_WIDTH_FT) / fpc / 2;
      if (pitch === 0) {
        shape = orientedBoxShape(ox + (d.x * size) / 2, oy + (d.y * size) / 2, oz, d.x, d.y, size / 2, halfWidth, halfWidth);
      } else {
        const f = aimFrame(template.yaw, pitch);
        const c = { x: ox + (f.a.x * size) / 2, y: oy + (f.a.y * size) / 2, z: oz + (f.a.z * size) / 2 };
        shape = aimedBoxShape(c, f, size / 2, halfWidth, halfWidth);
        const corners: Point[] = [];
        for (const su of [-1, 1]) {
          for (const sw of [-1, 1]) {
            for (const sh of [-1, 1]) {
              const u = (su * size) / 2;
              const w = sw * halfWidth;
              const h = sh * halfWidth;
              corners.push({ x: c.x + u * f.a.x + w * f.n.x + h * f.m.x, y: c.y + u * f.a.y + w * f.n.y + h * f.m.y });
            }
          }
        }
        top = aimedTopView(convexHull(corners), ox, oy, oz, f, size);
      }
      probes = [{ at: origin, prefer: toward }];
      break;
    }
    case "emanation": {
      // An attached emanation follows its token. One that stays put keeps the
      // footprint it was cast with, and an older one without that reads its
      // caster's footprint while the caster still stands on the origin.
      const around = (attached ? tokenBox(attached, fpc) : storedBox(template.footprint, origin)) ?? (originToken ? tokenBox(originToken, fpc) : null);
      if (around) {
        const { rect: r, lo, hi } = around;
        box = r;
        shape = emanationShape(r.x, r.y, lo / fpc, r.x + r.w, r.y + r.h, hi / fpc, size);
        originZ = (lo + hi) / 2 / fpc;
        // The union of what the center and the four corners see (section 9.3).
        const c = rectCenter(r);
        probes = [
          { at: c, prefer: null },
          { at: { x: r.x, y: r.y }, prefer: c },
          { at: { x: r.x + r.w, y: r.y }, prefer: c },
          { at: { x: r.x, y: r.y + r.h }, prefer: c },
          { at: { x: r.x + r.w, y: r.y + r.h }, prefer: c },
        ];
      } else {
        shape = emanationShape(ox, oy, oz, ox, oy, oz, size);
        probes = [{ at: origin, prefer: null }];
      }
      break;
    }
  }

  const walls = ctx.walls;
  const polygons = walls && walls.blockers.length > 0 ? probes.map((p) => visibleFrom(walls, p, sceneBounds(ctx))) : [];
  return { shape, originZ, originTokenId: originToken?.id, ...(box ? { box } : {}), polygons, ...top };
}

type EmanationBox = { rect: Rect; lo: number; hi: number };

function tokenBox(token: AreaToken, fpc: number): EmanationBox {
  return { rect: footprintRect(SQUARES, token), ...verticalExtentFt(token, fpc) };
}

function storedBox(footprint: AreaTemplate["footprint"], origin: { x: number; y: number }): EmanationBox | null {
  if (!footprint) return null;
  const { w, h, elevation, height } = footprint;
  if (![w, h, elevation, height].every(Number.isFinite) || w <= 0 || h <= 0 || height < 0) return null;
  return { rect: { x: origin.x - w / 2, y: origin.y - h / 2, w, h }, lo: elevation, hi: elevation + height };
}

/** The coordinate of sample k (of n) across the cell that starts at `cell`. */
export function sampleCoord(cell: number, k: number, n: number): number {
  return cell + (k + 0.5) / n;
}

/**
 * Anything farther than this from a cell's center is outside the cell, so a
 * surface that far away cannot cut it.
 */
const HALF_DIAGONAL = Math.SQRT1_2;
const OUT = 0;
const IN = 1;
const CROSSED = 2;

/*
 * Per-cell sample counts for one resolved area. The visibility polygons do
 * not depend on height, so one sampler serves the shading slice and every
 * creature's own slice, and polygon crossings computed for one row of samples
 * are kept for the next cell in that row.
 */
class Sampler {
  readonly shape: Shape3;
  readonly n: number;
  readonly total: number;
  readonly gx: number;
  readonly gy: number;
  readonly nx: number;
  readonly ny: number;
  readonly polys: PolygonIndex[];
  readonly crossed: Uint8Array;
  readonly cellPoly: Int8Array;
  readonly sampleRows = new Map<number, Float64Array[]>();
  readonly centerRows = new Map<number, Float64Array[]>();
  /** Whether the center of the cell last passed to `evalCell` is inside. */
  center = false;

  constructor(area: ResolvedArea, n: number, scene: { w: number; h: number }) {
    this.shape = area.shape;
    this.n = n;
    this.total = n * n;
    const b = area.shape.bounds;
    this.gx = Math.max(0, Math.floor(b.x0));
    this.gy = Math.max(0, Math.floor(b.y0));
    this.nx = Math.max(0, Math.min(scene.w - 1, Math.floor(b.x1)) - this.gx + 1);
    this.ny = Math.max(0, Math.min(scene.h - 1, Math.floor(b.y1)) - this.gy + 1);
    const hasPolys = area.polygons.length > 0 && this.nx > 0 && this.ny > 0;
    this.polys = hasPolys ? area.polygons.map((p) => indexPolygon(p, this.gy, this.ny)) : [];
    this.crossed = new Uint8Array(hasPolys ? this.nx * this.ny : 0);
    this.cellPoly = new Int8Array(hasPolys ? this.nx * this.ny : 0).fill(-1);
    if (hasPolys) for (const p of area.polygons) markPolygonCells(p, this.gx, this.gy, this.nx, this.ny, this.crossed);
  }

  inWindow(i: number, j: number): boolean {
    return i >= this.gx && j >= this.gy && i < this.gx + this.nx && j < this.gy + this.ny;
  }

  /** Inside samples of cell (i, j) at height z. Also sets `center`. */
  evalCell(i: number, j: number, z: number): number {
    this.center = false;
    if (!this.inWindow(i, j)) return 0;
    const cx = i + 0.5;
    const cy = j + 0.5;
    const sd = this.shape.sd(cx, cy, z);
    if (sd > HALF_DIAGONAL) return 0;
    const poly = this.polys.length ? this.polyState(i, j) : IN;
    if (poly === OUT) return 0;
    const shapeAll = sd < -HALF_DIAGONAL;
    if (shapeAll && poly === IN) {
      this.center = true;
      return this.total;
    }
    this.center = (shapeAll || this.shape.inside(cx, cy, z)) && (poly === IN || anyInside(this.centerRow(j), cx));
    const n = this.n;
    let count = 0;
    for (let r = 0; r < n; r++) {
      const y = sampleCoord(j, r, n);
      const rows = poly === CROSSED ? this.sampleRow(j, r) : null;
      for (let c = 0; c < n; c++) {
        const x = sampleCoord(i, c, n);
        if (!shapeAll && !this.shape.inside(x, y, z)) continue;
        if (rows !== null && !anyInside(rows, x)) continue;
        count++;
      }
    }
    return count;
  }

  /** Whether one sample of cell (i, j) is inside, for footprints that cover part of a cell. */
  sampleInside(i: number, j: number, r: number, c: number, z: number): boolean {
    if (!this.inWindow(i, j)) return false;
    const x = sampleCoord(i, c, this.n);
    if (!this.shape.inside(x, sampleCoord(j, r, this.n), z)) return false;
    return this.polys.length === 0 || anyInside(this.sampleRow(j, r), x);
  }

  pointInside(x: number, y: number, z: number): boolean {
    if (!this.shape.inside(x, y, z)) return false;
    return (
      this.polys.length === 0 ||
      anyInside(
        this.polys.map((p) => crossingsAt(p, y)),
        x,
      )
    );
  }

  /** Whether the polygons wholly contain cell (i, j), wholly miss it, or cross it. */
  private polyState(i: number, j: number): number {
    const k = (j - this.gy) * this.nx + (i - this.gx);
    if (this.crossed[k] === 1) return CROSSED;
    const known = this.cellPoly[k]!;
    if (known >= 0) return known;
    const state = anyInside(this.centerRow(j), i + 0.5) ? IN : OUT;
    this.cellPoly[k] = state;
    return state;
  }

  private centerRow(j: number): Float64Array[] {
    let rows = this.centerRows.get(j);
    if (!rows) {
      const y = j + 0.5;
      rows = this.polys.map((p) => crossingsAt(p, y));
      this.centerRows.set(j, rows);
    }
    return rows;
  }

  private sampleRow(j: number, r: number): Float64Array[] {
    const key = j * this.n + r;
    let rows = this.sampleRows.get(key);
    if (!rows) {
      const y = sampleCoord(j, r, this.n);
      rows = this.polys.map((p) => crossingsAt(p, y));
      this.sampleRows.set(key, rows);
    }
    return rows;
  }
}

function anyInside(rows: Float64Array[], x: number): boolean {
  for (const xs of rows) if (insideCrossings(xs, x)) return true;
  return false;
}

function passes(count: number, total: number, center: boolean, rule: AoeCoverage): boolean {
  if (rule === "half") return 2 * count >= total;
  if (rule === "any") return count > 0;
  return center;
}

function samplesOf(ctx: AreaContext): number {
  const n = ctx.samples ?? SAMPLES;
  return Number.isFinite(n) ? clamp(Math.round(n), 1, SAMPLES) : SAMPLES;
}

/**
 * Every input that can change a template's coverage or the creatures it
 * catches. The template's geometry is listed as well as its rev, so a
 * preview being aimed (which has no new rev) still gets a fresh key.
 */
export function coverageCacheKey(template: AreaTemplateInput, ctx: AreaContext): string {
  const tok = (id: string | undefined) => {
    const t = id ? ctx.tokens?.[id] : undefined;
    return t ? [t.id, t.rev, t.size, t.w, t.h, t.x, t.y, t.elevation, t.height] : null;
  };
  return JSON.stringify([
    template.id,
    template.rev,
    template.shape,
    template.size,
    template.width,
    template.height,
    template.origin.x,
    template.origin.y,
    template.origin.z,
    template.yaw,
    pitchOf(template),
    template.faceOffset?.u,
    template.faceOffset?.v,
    template.anchor,
    template.includeOrigin,
    template.attachedTo,
    template.footprint ? [template.footprint.w, template.footprint.h, template.footprint.elevation, template.footprint.height] : null,
    template.casterId,
    tok(template.attachedTo),
    tok(template.casterId),
    ctx.settings.feetPerCell,
    ctx.settings.aoeCoverage,
    ctx.settings.aoeInclusion,
    ctx.bounds.w,
    ctx.bounds.h,
    ctx.walls?.version ?? null,
    samplesOf(ctx),
  ]);
}

/** The cells a template covers under the room's coverage rule, for shading. */
export function computeCoverage(template: AreaTemplateInput, ctx: AreaContext): CoverageResult {
  const key = coverageCacheKey(template, ctx);
  const n = samplesOf(ctx);
  const area = resolveArea(template, ctx);
  if (!area) {
    return { key, samples: n, cells: [], x0: 0, y0: 0, w: 0, h: 0, counts: new Uint16Array(0), centers: new Uint8Array(0), covered: new Uint8Array(0) };
  }
  // An aimed cone or line shades what it covers seen from above (ResolvedArea.shade).
  const s = new Sampler(area.shade ? { ...area, shape: area.shade } : area, n, sceneBounds(ctx));
  const counts = new Uint16Array(s.nx * s.ny);
  const centers = new Uint8Array(s.nx * s.ny);
  const covered = new Uint8Array(s.nx * s.ny);
  const rule = ctx.settings.aoeCoverage;
  const excluded = !template.includeOrigin && area.originTokenId ? ctx.tokens?.[area.originTokenId] : undefined;
  const ex = excluded ? occupiedRange(SQUARES, excluded) : null;
  const cells: CoveredCell[] = [];
  for (let j = s.gy; j < s.gy + s.ny; j++) {
    for (let i = s.gx; i < s.gx + s.nx; i++) {
      const k = (j - s.gy) * s.nx + (i - s.gx);
      const count = s.evalCell(i, j, area.originZ);
      counts[k] = count;
      centers[k] = s.center ? 1 : 0;
      if (!passes(count, s.total, s.center, rule)) continue;
      if (ex && i >= ex.x0 && i < ex.x1 && j >= ex.y0 && j < ex.y1) continue;
      covered[k] = 1;
      cells.push({ x: i, y: j, coverage: count / s.total });
    }
  }
  return { key, samples: n, cells, x0: s.gx, y0: s.gy, w: s.nx, h: s.ny, counts, centers, covered };
}

/**
 * The tokens a template catches, in input order. Each creature is tested at
 * its own height slice: the point of its vertical extent nearest the
 * template's origin height. So a fireball that does not reach a flier skips
 * it even though the ground below is shaded.
 *
 * A cone or line aimed up or down has no one height that suits every
 * creature: near its far end the lower rim of a cone reaches past the point
 * of its axis above a cell. So above each cell the creature is tested at
 * several heights through its body (heightsThrough), and the best of them
 * counts, as if the slice through the creature were taken where the area
 * covers most of it.
 */
export function creaturesInArea(template: AreaTemplateInput, tokens: Iterable<AreaToken>, ctx: AreaContext): TokenId[] {
  const area = resolveArea(template, ctx);
  if (!area) return [];
  const fpc = feetPerCellOf(ctx);
  const s = new Sampler(area, samplesOf(ctx), sceneBounds(ctx));
  const { aoeCoverage, aoeInclusion } = ctx.settings;
  const caught: TokenId[] = [];
  for (const t of tokens) {
    if (template.sceneId !== undefined && t.sceneId !== undefined && t.sceneId !== template.sceneId) continue;
    if (!template.includeOrigin && t.id === area.originTokenId) continue;
    const { lo, hi } = verticalExtentFt(t, fpc);
    const sliceZ = area.sliceZ;
    const zsAt: HeightsAt = sliceZ ? (x, y) => heightsThrough(lo / fpc, hi / fpc, sliceZ(x, y)) : () => [clamp(area.originZ, lo / fpc, hi / fpc)];
    if (aoeInclusion === "center") {
      const r = footprintRect(SQUARES, t);
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      if (zsAt(cx, cy).some((z) => s.pointInside(cx, cy, z))) caught.push(t.id);
    } else if (aoeInclusion === "majority") {
      if (majorityInside(s, t, zsAt)) caught.push(t.id);
    } else if (anyCellCovered(s, t, zsAt, aoeCoverage)) {
      caught.push(t.id);
    }
  }
  return caught;
}

/** The heights a creature is measured at above a map point, in cells. */
type HeightsAt = (x: number, y: number) => number[];

/** Steps through a creature's body for an aimed area, in cells: a quarter cell, or 1.25 ft on a 5 ft grid. */
const BODY_STEP = 0.25;

/**
 * Heights through a body from `lo` to `hi`, in cells: both ends, the axis
 * height clamped into it, and even steps of at most BODY_STEP between, so a
 * part of the area thinner than a step is the only part it can miss.
 */
function heightsThrough(lo: number, hi: number, axis: number): number[] {
  const steps = Math.max(1, Math.ceil((hi - lo) / BODY_STEP));
  const out = [clamp(axis, lo, hi)];
  for (let k = 0; k <= steps; k++) out.push(k === steps ? hi : lo + ((hi - lo) * k) / steps);
  return out;
}

function anyCellCovered(s: Sampler, t: AreaToken, zsAt: HeightsAt, rule: AoeCoverage): boolean {
  const r = occupiedRange(SQUARES, t);
  for (let j = r.y0; j < r.y1; j++) {
    for (let i = r.x0; i < r.x1; i++) {
      for (const z of zsAt(i + 0.5, j + 0.5)) {
        const count = s.evalCell(i, j, z);
        if (passes(count, s.total, s.center, rule)) return true;
      }
    }
  }
  return false;
}

/** More than half of the sample points inside the footprint itself are inside the area, each cell at its best height. */
function majorityInside(s: Sampler, t: AreaToken, zsAt: HeightsAt): boolean {
  const rect = footprintRect(SQUARES, t);
  const range = occupiedRange(SQUARES, t);
  const n = s.n;
  let inside = 0;
  let total = 0;
  for (let j = range.y0; j < range.y1; j++) {
    for (let i = range.x0; i < range.x1; i++) {
      const zs = zsAt(i + 0.5, j + 0.5);
      const whole = i >= rect.x && i + 1 <= rect.x + rect.w && j >= rect.y && j + 1 <= rect.y + rect.h;
      if (whole) {
        inside += Math.max(...zs.map((z) => s.evalCell(i, j, z)));
        total += s.total;
        continue;
      }
      let cellTotal = 0;
      let best = 0;
      for (const [k, z] of zs.entries()) {
        let count = 0;
        for (let r = 0; r < n; r++) {
          const y = sampleCoord(j, r, n);
          if (y < rect.y || y >= rect.y + rect.h) continue;
          for (let c = 0; c < n; c++) {
            const x = sampleCoord(i, c, n);
            if (x < rect.x || x >= rect.x + rect.w) continue;
            if (k === 0) cellTotal++;
            if (s.sampleInside(i, j, r, c, z)) count++;
          }
        }
        best = Math.max(best, count);
      }
      total += cellTotal;
      inside += best;
    }
  }
  return total > 0 && 2 * inside > total;
}

/**
 * A small least-recently-used cache of coverage results by
 * `coverageCacheKey`, for redrawing shading without recomputing it.
 */
export class CoverageCache {
  readonly #max: number;
  readonly #entries = new Map<string, CoverageResult>();

  constructor(max = 256) {
    this.#max = max;
  }

  get(template: AreaTemplateInput, ctx: AreaContext): CoverageResult {
    const key = coverageCacheKey(template, ctx);
    const hit = this.#entries.get(key);
    if (hit) {
      this.#entries.delete(key);
      this.#entries.set(key, hit);
      return hit;
    }
    const result = computeCoverage(template, ctx);
    this.#entries.set(key, result);
    if (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
    return result;
  }
}
