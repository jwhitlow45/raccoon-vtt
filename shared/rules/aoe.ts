import type { AoeCoverage, AreaFootprint, AreaShape, AreaTemplate, DiagonalRule, RoomSettings, Token, TokenId } from "../model.ts";
import { areaCentersOnScene } from "../migrate.ts";
import { axisSteps, hexSetSteps, legFeet } from "./distance.ts";
import { footprintRect, hexAnchor, occupiedHexes, occupiedRange, sizeCategory, tokenHeightFt, verticalExtentFt, type FootprintToken } from "./footprint.ts";
import { clamp, distToSegment, sdBox3, sdCorner2, yawVector, type Bounds, type Point, type Point3, type Rect } from "./geom.ts";
import { SQUARES, type Grid } from "./grid.ts";
import { cornerAt, footprintHexes, HEX_R, HEX_S, hexAt, hexCenter, hexCorners, hexInScene, hexKey, snapAnchor, type Hex, type HexGrid } from "./hex.ts";
import { AREAS, stepOffWalls } from "./segments.ts";
import { cachedVisibility, crossingsAt, indexPolygon, insideCrossings, markPolygonCells, type Polygon, type PolygonIndex, type WallSet } from "./walls.ts";

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
 *
 * On a hex scene (docs/design-v1-hex-grids.md HX-D11) shapes keep their
 * true geometry, graded per hex by the room's coverage rule over a fixed
 * pattern of samples in each hex, and a creature is caught by its hexes.
 * An emanation is the exception: it covers every hex within
 * `floor(size / feetPerCell)` steps of its creature's hexes, height counted
 * by the room's rule from the footprint's vertical extent, so it agrees
 * with the ruler. One that stays put keeps its creature's size and reads
 * its hexes around its origin on every read, so they move with it.
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
  /** Stored operations keep the inclusion rule they originally used. Absent means live. */
  opVersion?: number;
  /** The room's settings areas read. The diagonal rule counts an emanation's height on hexes, `five` where a caller leaves it out. */
  settings: Pick<RoomSettings, "feetPerCell" | "aoeCoverage" | "aoeInclusion"> & Partial<Pick<RoomSettings, "diagonal">>;
  /** Scene size in cells. Coverage is clipped to it. */
  bounds: { w: number; h: number };
  /** The scene's grid: on hexes coverage is per hex and an emanation counts steps (HX-D11). */
  grid: Grid;
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

/** The heights in cells, low then high, over a map point that lie inside a solid. */
export type Span = readonly [number, number];

/**
 * A shape that stands in the air (docs/design-v1-iso-area-shapes.md 4.1):
 * every area's shape is convex, so the heights inside it over a map point
 * are one interval. Isometric reads it to stand the area at its real
 * height, so it must hold exactly the heights `inside` holds.
 */
export type Solid3 = Shape3 & {
  /** The interval over a map point, or null where the shape does not reach. */
  span(x: number, y: number): Span | null;
};

/**
 * A box in cells: its center, its three axes (unit, square to each other)
 * and its half extents along them.
 */
export type SolidBox = { c: Point3; axes: readonly [Point3, Point3, Point3]; half: readonly [number, number, number] };

/**
 * An area's shape by its parameters in cells (design 4.1), so the
 * isometric drawing builds the very solid the rules catch with. A cone's
 * frame is the rules' own (`aimFrame`): `a` along its axis, `n` level and
 * square to it, `m` square to both. Cubes and lines, level or aimed, are
 * boxes. An emanation is its creature's box, axis-aligned, grown by its
 * distance, a point emanation a box of no size. On hexes an emanation is
 * the stack of hexes and layers its reach covers (`hexStackPrisms`).
 */
export type AreaSolid =
  | { kind: "sphere"; c: Point3; r: number }
  | { kind: "cylinder"; c: Point; r: number; z0: number; z1: number }
  | { kind: "cone"; apex: Point3; a: Point3; n: Point3; m: Point3; L: number }
  | ({ kind: "box" } & SolidBox)
  | { kind: "rounded"; box: SolidBox; D: number }
  | { kind: "hexStack"; reach: HexReach; bounds: { w: number; h: number } };

export type ResolvedArea = {
  shape: Solid3;
  /** The same shape by its parameters, for drawing it as it stands. */
  solid: AreaSolid;
  /** Height in cells of the slice that shading uses, and the height creatures are measured against. */
  originZ: number;
  /** The token the area starts from: the attached token, or the caster when the origin is on it. */
  originTokenId: TokenId | undefined;
  /** The footprint an emanation surrounds, in cells, when it surrounds one rather than a point. */
  box?: Rect;
  /** On hexes, an emanation's reach in steps from the hexes it surrounds (HX-D11), which coverage and catching read in place of `shape`. */
  reach?: HexReach;
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

/** A hex an area covers on a hex scene, by its offset coordinates, with the fraction of its samples inside. */
export type CoveredHex = { col: number; row: number; coverage: number };

export type CoverageResult = {
  key: string;
  samples: number;
  /** On a hex scene, the hexes that pass the coverage rule (HX-D11), and the square window below is empty. */
  hexes?: CoveredHex[];
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
  g: Grid,
  area: { shape: AreaShape; size: number; yaw: number; anchor?: "bottom" | "top" },
  caster: FootprintToken,
  feetPerCell: number,
): { origin: { x: number; y: number; z: number }; faceOffset?: { u: number; v: number }; includeOrigin: boolean } {
  const rect = footprintRect(g, caster);
  const height = tokenHeightFt(caster, feetPerCell);
  const center = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
  const includeOrigin = INCLUDE_ORIGIN[area.shape];
  // On hexes the edge is the footprint's outline: a corner or a side's midpoint where the aim leaves it (HX-D11).
  const edge = () => (g.shape === "hex" ? hexEdgeOrigin(g, occupiedHexes(g, caster), center, area.yaw) : edgeOrigin(rect, area.yaw));
  switch (area.shape) {
    case "cone":
    case "line":
      return { origin: { ...edge(), z: caster.elevation + height / 2 }, includeOrigin };
    case "cube":
      return {
        origin: { ...edge(), z: caster.elevation + areaFt(area.size, AREA_MIN_FT) / 2 },
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

/**
 * What an emanation that stays put keeps of the token it was cast from
 * (`AreaTemplate.footprint`). On hexes also its size, which its hexes are
 * read from around the origin (HX-D11), beside the size's box, so a square
 * scene after a switch or a restore reads the same creature.
 */
export function emanationFootprint(g: Grid, token: FootprintToken, feetPerCell: number): AreaFootprint {
  const r = footprintRect(g, token);
  const kept = { w: r.w, h: r.h, elevation: token.elevation, height: tokenHeightFt(token, feetPerCell) };
  return g.shape === "hex" ? { ...kept, size: sizeCategory(token) } : kept;
}

function sphereShape(ox: number, oy: number, oz: number, r: number): Solid3 {
  const r2 = r * r;
  return {
    span(x, y) {
      const dx = x - ox;
      const dy = y - oy;
      const left = r2 - (dx * dx + dy * dy);
      if (left < 0) return null;
      const h = Math.sqrt(left);
      return [oz - h, oz + h];
    },
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

function cylinderShape(ox: number, oy: number, zLo: number, zHi: number, r: number): Solid3 {
  const r2 = r * r;
  const zc = (zLo + zHi) / 2;
  const hz = (zHi - zLo) / 2;
  return {
    span(x, y) {
      const dx = x - ox;
      const dy = y - oy;
      return dx * dx + dy * dy <= r2 ? [zLo, zHi] : null;
    },
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
function coneShape(ox: number, oy: number, oz: number, f: AimFrame, L: number): Solid3 {
  const { a, n, m } = f;
  const half = L / 2;
  const tipX = ox + a.x * L;
  const tipY = oy + a.y * L;
  // The base circle seen from above spans its radius times the axis's reach off each map axis.
  const ex = half * Math.sqrt(a.y * a.y + a.z * a.z);
  const ey = half * Math.sqrt(a.x * a.x + a.z * a.z);
  const inside = (x: number, y: number, z: number) => {
    const rx = x - ox;
    const ry = y - oy;
    const rz = z - oz;
    const u = rx * a.x + ry * a.y + rz * a.z;
    if (u < 0 || u > L) return false;
    const w = rx * n.x + ry * n.y;
    const h = rx * m.x + ry * m.y + rz * m.z;
    return 4 * (w * w + h * h) <= u * u;
  };
  return {
    span(x, y) {
      const rx = x - ox;
      const ry = y - oy;
      const t = coneSpan(rx * a.x + ry * a.y, rx * n.x + ry * n.y, rx * m.x + ry * m.y, a.z, m.z, L);
      return t ? [oz + t[0], oz + t[1]] : null;
    },
    inside,
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

/*
 * The heights t above the apex over a map point that lie in a cone, where
 * the point sits u0 along the axis, w across it and h0 up its frame at the
 * apex's height, and the axis and the frame's `m` climb s and c a cell of
 * height. Inside is 0 <= u <= L with 4(w² + h²) <= u², u = u0 + s t and
 * h = h0 + c t: the first a slab in t, the second a quadratic whose roots
 * bound where the vertical line crosses the double cone. Within the slab u
 * is not negative, so only one nappe counts and the answer is one
 * interval. Where the quadratic opens up the line passes both nappes, one
 * ray on each, and the slab leaves only the cone's own.
 */
function coneSpan(u0: number, w: number, h0: number, s: number, c: number, L: number): Span | null {
  let lo = -Infinity;
  let hi = Infinity;
  if (s === 0) {
    if (u0 < 0 || u0 > L) return null;
  } else {
    const t0 = -u0 / s;
    const t1 = (L - u0) / s;
    lo = Math.min(t0, t1);
    hi = Math.max(t0, t1);
  }
  const A = s * s - 4 * c * c;
  const B = 2 * (u0 * s - 4 * h0 * c);
  const C = u0 * u0 - 4 * h0 * h0 - 4 * w * w;
  const meet = (a: number, b: number): Span | null => {
    const l = Math.max(lo, a);
    const r = Math.min(hi, b);
    return l <= r ? [l, r] : null;
  };
  if (Math.abs(A) < 1e-12) {
    // The vertical line runs along the cone's slant: the quadratic is a line.
    if (Math.abs(B) < 1e-300) return C >= 0 ? meet(-Infinity, Infinity) : null;
    return B > 0 ? meet(-C / B, Infinity) : meet(-Infinity, -C / B);
  }
  const disc = B * B - 4 * A * C;
  if (disc < 0) return A > 0 ? meet(-Infinity, Infinity) : null;
  // The stable pair of roots: no difference of near-equal numbers.
  const q = -0.5 * (B + (B >= 0 ? 1 : -1) * Math.sqrt(disc));
  const r1 = q === 0 ? 0 : q / A;
  const r2 = q === 0 ? 0 : C / q;
  const rLo = Math.min(r1, r2);
  const rHi = Math.max(r1, r2);
  if (A < 0) return meet(rLo, rHi);
  // A line steeper than the cone's slant passes both nappes, a ray on each. The cone's own is the one u grows along. The other meets the slab at most at the apex, so taking whichever comes first would return the apex alone on its own column.
  return s > 0 ? meet(rHi, Infinity) : meet(-Infinity, rLo);
}

/** A box centered on c with half extents hu along `a`, hw along `n` and hh along `m`: a line aimed up or down. */
function aimedBoxShape(c: Point3, f: AimFrame, hu: number, hw: number, hh: number): Solid3 {
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
    span(x, y) {
      const rx = x - c.x;
      const ry = y - c.y;
      let lo = -Infinity;
      let hi = Infinity;
      for (const [e, h] of [
        [a, hu],
        [n, hw],
        [m, hh],
      ] as const) {
        const p = rx * e.x + ry * e.y;
        if (e.z === 0) {
          if (Math.abs(p) > h) return null;
          continue;
        }
        const t0 = (-h - p) / e.z;
        const t1 = (h - p) / e.z;
        lo = Math.max(lo, Math.min(t0, t1));
        hi = Math.min(hi, Math.max(t0, t1));
      }
      return lo <= hi ? [c.z + lo, c.z + hi] : null;
    },
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
export function convexHull(points: Point[]): Point[] {
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
function orientedBoxShape(cx: number, cy: number, cz: number, dx: number, dy: number, hu: number, hw: number, hz: number): Solid3 {
  const ex = Math.abs(dx) * hu + Math.abs(dy) * hw;
  const ey = Math.abs(dy) * hu + Math.abs(dx) * hw;
  return {
    span(x, y) {
      const rx = x - cx;
      const ry = y - cy;
      return Math.abs(rx * dx + ry * dy) <= hu && Math.abs(ry * dx - rx * dy) <= hw ? [cz - hz, cz + hz] : null;
    },
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
function emanationShape(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, D: number): Solid3 {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const cz = (z0 + z1) / 2;
  const hx = (x1 - x0) / 2;
  const hy = (y1 - y0) / 2;
  const hz = (z1 - z0) / 2;
  const D2 = D * D;
  return {
    span(x, y) {
      const ex = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
      const ey = y < y0 ? y0 - y : y > y1 ? y - y1 : 0;
      const left = D2 - (ex * ex + ey * ey);
      if (left < 0) return null;
      const h = Math.sqrt(left);
      return [z0 - h, z1 + h];
    },
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
    ? castFromToken(ctx.grid, { shape: template.shape, size: sizeFt, yaw: template.yaw, anchor: template.anchor }, attached, fpc).origin
    : template.origin;
  if (![origin.x, origin.y, origin.z, template.yaw].every(Number.isFinite)) return null;

  const g = ctx.grid;
  let originToken: AreaToken | undefined = attached;
  if (!originToken && caster) {
    // On hexes a cast starts on the footprint's outline (castFromToken), which its drawing box does not hold (review HX2-ASTRA-02).
    if (g.shape === "hex") {
      if (onHexes(g, occupiedHexes(g, caster), origin)) originToken = caster;
    } else {
      const r = footprintRect(g, caster);
      const E = 1e-6;
      if (origin.x >= r.x - E && origin.x <= r.x + r.w + E && origin.y >= r.y - E && origin.y <= r.y + r.h + E) originToken = caster;
    }
  }

  const ox = origin.x;
  const oy = origin.y;
  const oz = origin.z / fpc;
  const size = sizeFt / fpc;
  const d = yawVector(template.yaw);
  const pitch = pitchOf(template);
  let shape: Solid3;
  let solid: AreaSolid;
  let originZ = oz;
  let probes: Probe[];
  let box: Rect | undefined;
  let top: Pick<ResolvedArea, "shade" | "outline" | "sliceZ"> | undefined;
  let reach: HexReach | undefined;
  const toward = originToken ? rectCenter(footprintRect(g, originToken)) : null;

  switch (template.shape) {
    case "sphere":
      shape = sphereShape(ox, oy, oz, size);
      solid = { kind: "sphere", c: { x: ox, y: oy, z: oz }, r: size };
      probes = [{ at: origin, prefer: toward }];
      break;
    case "cylinder": {
      const h = areaFt(template.height, DEFAULT_CYLINDER_HEIGHT_FT) / fpc;
      const [z0, z1] = template.anchor === "top" ? [oz - h, oz] : [oz, oz + h];
      shape = cylinderShape(ox, oy, z0, z1, size);
      solid = { kind: "cylinder", c: { x: ox, y: oy }, r: size, z0, z1 };
      probes = [{ at: origin, prefer: toward }];
      break;
    }
    case "cone": {
      const f = aimFrame(template.yaw, pitch);
      shape = coneShape(ox, oy, oz, f, size);
      solid = { kind: "cone", apex: { x: ox, y: oy, z: oz }, a: f.a, n: f.n, m: f.m, L: size };
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
      const c = { x: fx + d.x * half, y: fy + d.y * half, z: oz - v * size };
      shape = orientedBoxShape(c.x, c.y, c.z, d.x, d.y, half, half, half);
      solid = { kind: "box", c, axes: levelAxes(d), half: [half, half, half] };
      probes = [{ at: origin, prefer: toward }];
      break;
    }
    case "line": {
      const halfWidth = areaFt(template.width, DEFAULT_LINE_WIDTH_FT) / fpc / 2;
      if (pitch === 0) {
        const c = { x: ox + (d.x * size) / 2, y: oy + (d.y * size) / 2, z: oz };
        shape = orientedBoxShape(c.x, c.y, c.z, d.x, d.y, size / 2, halfWidth, halfWidth);
        solid = { kind: "box", c, axes: levelAxes(d), half: [size / 2, halfWidth, halfWidth] };
      } else {
        const f = aimFrame(template.yaw, pitch);
        const c = { x: ox + (f.a.x * size) / 2, y: oy + (f.a.y * size) / 2, z: oz + (f.a.z * size) / 2 };
        shape = aimedBoxShape(c, f, size / 2, halfWidth, halfWidth);
        solid = { kind: "box", c, axes: [f.a, f.n, f.m], half: [size / 2, halfWidth, halfWidth] };
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
      if (g.shape === "hex") {
        // It counts steps from the hexes it surrounds (HX-D11), each read on the grid now, so a stationary one's move with its origin.
        const around = (attached ? tokenHexes(g, attached, fpc) : storedHexes(g, template.footprint, origin)) ?? (originToken ? tokenHexes(g, originToken, fpc) : null);
        const src = around ?? { hexes: [hexAt(g, origin)], center: { x: origin.x, y: origin.y }, side: 0, lo: origin.z, hi: origin.z };
        const half = src.side / 2;
        if (src.side > 0) box = { x: src.center.x - half, y: src.center.y - half, w: src.side, h: src.side };
        const z0 = Math.floor(src.lo / fpc);
        // A zero-height thing still stands in the layer of cells it is in, as distance.ts reads a creature.
        reach = { g, from: src.hexes, steps: Math.floor(sizeFt / fpc + 1e-9), ft: sizeFt, z0, z1: Math.max(z0 + 1, Math.ceil(src.hi / fpc)), fpc, rule: ctx.settings.diagonal ?? "five" };
        // The continuous shape bounds what can be covered: every hex within its steps lies within that many cells and a hex of its box.
        shape = emanationShape(src.center.x - half, src.center.y - half, src.lo / fpc, src.center.x + half, src.center.y + half, src.hi / fpc, reach.steps + 1);
        solid = { kind: "hexStack", reach, bounds: sceneBounds(ctx) };
        originZ = (src.lo + src.hi) / 2 / fpc;
        probes = src.hexes.map((h) => ({ at: hexCenter(g, h), prefer: src.center }));
        break;
      }
      // An attached emanation follows its token. One that stays put keeps the
      // footprint it was cast with, and an older one without that reads its
      // caster's footprint while the caster still stands on the origin.
      const around = (attached ? tokenBox(attached, fpc) : storedBox(template.footprint, origin)) ?? (originToken ? tokenBox(originToken, fpc) : null);
      if (around) {
        const { rect: r, lo, hi } = around;
        box = r;
        shape = emanationShape(r.x, r.y, lo / fpc, r.x + r.w, r.y + r.h, hi / fpc, size);
        solid = roundedBox(r.x, r.y, lo / fpc, r.x + r.w, r.y + r.h, hi / fpc, size);
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
        solid = roundedBox(ox, oy, oz, ox, oy, oz, size);
        probes = [{ at: origin, prefer: null }];
      }
      break;
    }
  }

  const walls = ctx.walls;
  const polygons = walls && walls.blockers.length > 0 ? probes.map((p) => visibleFrom(walls, p, sceneBounds(ctx))) : [];
  return { shape, solid, originZ, originTokenId: originToken?.id, ...(box ? { box } : {}), ...(reach ? { reach } : {}), polygons, ...top };
}

/** The axes of a level box aimed along `d`: along it, across it as `orientedBoxShape` reads it, and up. */
function levelAxes(d: Point): [Point3, Point3, Point3] {
  return [
    { x: d.x, y: d.y, z: 0 },
    { x: -d.y, y: d.x, z: 0 },
    { x: 0, y: 0, z: 1 },
  ];
}

/** `emanationShape`'s box and distance as a solid. */
function roundedBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, D: number): AreaSolid {
  const c = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: (z0 + z1) / 2 };
  const half: [number, number, number] = [(x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2];
  return { kind: "rounded", box: { c, axes: levelAxes({ x: 1, y: 0 }), half }, D };
}

type EmanationBox = { rect: Rect; lo: number; hi: number };

/** The box a square emanation surrounds: the hex path never reads it. */
function tokenBox(token: AreaToken, fpc: number): EmanationBox {
  return { rect: footprintRect(SQUARES, token), ...verticalExtentFt(token, fpc) };
}

/** The hexes an emanation surrounds on hexes, the middle and side of their size's box, and their vertical extent in feet. */
type EmanationHexes = { hexes: readonly Hex[]; center: Point; side: number; lo: number; hi: number };

function tokenHexes(g: HexGrid, token: AreaToken, fpc: number): EmanationHexes {
  return { hexes: occupiedHexes(g, token), center: hexAnchor(g, token), side: footprintRect(g, token).w, ...verticalExtentFt(token, fpc) };
}

/**
 * A stationary emanation's hexes (HX-D11): its kept size's, around the
 * anchor nearest its origin, found in world space on every read, so they
 * move with the origin across an odd row as across an even one. An older
 * footprint with only a box reads as the size whose box that is, the
 * longer side for an uneven one.
 */
function storedHexes(g: HexGrid, footprint: AreaTemplate["footprint"], origin: { x: number; y: number }): EmanationHexes | null {
  if (!footprint) return null;
  const { w, h, elevation, height } = footprint;
  if (![w, h, elevation, height].every(Number.isFinite) || w <= 0 || h <= 0 || height < 0) return null;
  const size = footprint.size ?? sizeCategory({ size: "custom", w, h });
  const anchor = snapAnchor(g, size, origin);
  return { hexes: footprintHexes(g, size, anchor), center: anchor, side: footprintRect(g, { size, x: anchor.x, y: anchor.y }).w, lo: elevation, hi: elevation + height };
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

/** What sampling reads of a resolved area: the shape it samples, an aimed area's top view in shading, and what clips it. */
type SampledArea = Pick<ResolvedArea, "polygons" | "reach"> & { shape: Shape3 };

/*
 * Per-cell sample counts for one resolved area. The visibility polygons do
 * not depend on height, so one sampler serves the shading slice and every
 * creature's own slice, and polygon crossings computed for one row of samples
 * are kept for the next cell in that row.
 */
class Sampler {
  readonly scene: { w: number; h: number };
  readonly clipCenter: boolean;
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

  constructor(area: SampledArea, n: number, scene: { w: number; h: number }, clipCenter = true) {
    this.scene = scene;
    this.clipCenter = clipCenter;
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
    if (this.clipCenter && (x < 0 || y < 0 || x >= this.scene.w || y >= this.scene.h)) return false;
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
    ctx.grid.shape === "hex" ? ctx.grid.orient : null,
    template.footprint?.size,
    ctx.grid.shape === "hex" ? ctx.settings.diagonal : null,
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
  if (ctx.grid.shape === "hex") {
    const hs = new HexSampler(ctx.grid, area.shade ? { ...area, shape: area.shade } : area, n, sceneBounds(ctx));
    const excluded = !template.includeOrigin && area.originTokenId ? ctx.tokens?.[area.originTokenId] : undefined;
    const own = new Set(excluded ? occupiedHexes(ctx.grid, excluded).map(hexKey) : []);
    const covered = hs.covered(area.originZ, ctx.settings.aoeCoverage);
    const hexes = own.size === 0 ? covered : covered.filter((c) => !own.has(`${c.col},${c.row}`));
    return { key, samples: n, hexes, cells: [], x0: 0, y0: 0, w: 0, h: 0, counts: new Uint16Array(0), centers: new Uint8Array(0), covered: new Uint8Array(0) };
  }
  // An aimed cone or line shades what it covers seen from above (ResolvedArea.shade).
  const s = new Sampler(area.shade ? { ...area, shape: area.shade } : area, n, sceneBounds(ctx));
  const counts = new Uint16Array(s.nx * s.ny);
  const centers = new Uint8Array(s.nx * s.ny);
  const covered = new Uint8Array(s.nx * s.ny);
  const rule = ctx.settings.aoeCoverage;
  const excluded = !template.includeOrigin && area.originTokenId ? ctx.tokens?.[area.originTokenId] : undefined;
  const ex = excluded ? occupiedRange(ctx.grid, excluded) : null;
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
  if (ctx.grid.shape === "hex") return creaturesOnHexes(ctx.grid, template, area, tokens, ctx);
  const fpc = feetPerCellOf(ctx);
  const s = new Sampler(area, samplesOf(ctx), sceneBounds(ctx), areaCentersOnScene(ctx.opVersion));
  const { aoeCoverage, aoeInclusion } = ctx.settings;
  const caught: TokenId[] = [];
  for (const t of tokens) {
    if (template.sceneId !== undefined && t.sceneId !== undefined && t.sceneId !== template.sceneId) continue;
    if (!template.includeOrigin && t.id === area.originTokenId) continue;
    const { lo, hi } = verticalExtentFt(t, fpc);
    const sliceZ = area.sliceZ;
    const zsAt: HeightsAt = sliceZ ? (x, y) => heightsThrough(lo / fpc, hi / fpc, sliceZ(x, y)) : () => [clamp(area.originZ, lo / fpc, hi / fpc)];
    if (aoeInclusion === "center") {
      const r = footprintRect(ctx.grid, t);
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

/*
 * Areas on hexes (docs/design-v1-hex-grids.md HX-D11).
 */

/**
 * An emanation's reach on hexes: every hex within `steps` of a hex of
 * `from`, the hexes it surrounds. A creature's hex counts when the room's
 * rule between those steps and the vertical ones from the layers `z0` to
 * `z1` gives at most `ft`, as the ruler measures it.
 */
export type HexReach = { g: HexGrid; from: readonly Hex[]; steps: number; ft: number; z0: number; z1: number; fpc: number; rule: DiagonalRule };

/** Whether a hex `h` steps from the source, its layers `[z0, z1)`, is within the reach. */
function withinReach(reach: HexReach, h: number, z0: number, z1: number): boolean {
  const dz = axisSteps(reach.z0, reach.z1, z0, z1);
  const ft = legFeet(h, 0, dz, reach.rule, reach.fpc);
  return (reach.rule === "euclid" ? Math.round(ft) : ft) <= reach.ft;
}

/** One hex of a hex emanation's solid: from layer `lo` up to the top of layer `hi - 1`, in cells. */
export type HexPrism = { hex: Hex; lo: number; hi: number };

/**
 * A hex emanation's solid (design 4.6): each hex of the scene its reach
 * covers, from the lowest to the highest layer `withinReach` passes, so the
 * drawn solid is exactly the hexes and layers it catches. The layers within
 * reach of a hex are one run, since a layer's vertical steps grow away from
 * the source's layers and every diagonal rule grows with them.
 */
export function hexStackPrisms(stack: Extract<AreaSolid, { kind: "hexStack" }>): HexPrism[] {
  const out: HexPrism[] = [];
  for (const p of eachHexPrism(stack)) if (p) out.push(p);
  return out;
}

/**
 * The prisms of `hexStackPrisms` one at a time, for a caller that builds
 * them in slices: the scene's hexes within the reach's box, row by row,
 * so a small stack costs the hexes near it, and a huge one on a small
 * scene costs the scene's. Null for each hex visited that holds no prism,
 * so the caller can count every visit.
 */
export function* eachHexPrism(stack: Extract<AreaSolid, { kind: "hexStack" }>): Generator<HexPrism | null, void, void> {
  const { reach, bounds } = stack;
  const g = reach.g;
  const layers = new Map<number, { lo: number; hi: number } | null>();
  const within = (d: number, layer: number) => withinReach(reach, d, layer, layer + 1);
  const layersAt = (d: number) => {
    let run = layers.get(d);
    if (run !== undefined) return run;
    run = null;
    // The layers in reach are one run round the source's own, since the steps up or down grow away from them under every diagonal rule, so its ends are found by halving. No layer more than its steps from the source's is in reach.
    if (within(d, reach.z0)) {
      let lo = reach.z0 - reach.steps;
      let top = reach.z0;
      while (lo < top) {
        const m = Math.floor((lo + top) / 2);
        if (within(d, m)) top = m;
        else lo = m + 1;
      }
      let hi = reach.z1 - 1;
      let bottom = reach.z1 + reach.steps - 1;
      while (hi < bottom) {
        const m = Math.ceil((hi + bottom) / 2);
        if (within(d, m)) hi = m;
        else bottom = m - 1;
      }
      run = { lo, hi: hi + 1 };
    }
    layers.set(d, run);
    return run;
  };
  // Every hex within the steps lies within that many cells of a source hex's center on each axis, a step being at most a cell, so the box of the sources grown by the steps holds them all.
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const h of reach.from) {
    const c = hexCenter(g, h);
    x0 = Math.min(x0, c.x);
    y0 = Math.min(y0, c.y);
    x1 = Math.max(x1, c.x);
    y1 = Math.max(y1, c.y);
  }
  const pad = reach.steps + 1;
  if (x0 - pad > bounds.w || y0 - pad > bounds.h || x1 + pad < 0 || y1 + pad < 0) return;
  // Columns run with x and rows with y on both orientations, so the hexes at the box's corners bound its columns and rows, a hex either way for the stagger.
  const from = hexAt(g, { x: Math.max(0, x0 - pad), y: Math.max(0, y0 - pad) });
  const to = hexAt(g, { x: Math.min(bounds.w, x1 + pad), y: Math.min(bounds.h, y1 + pad) });
  for (let row = from.row - 1; row <= to.row + 1; row++) {
    for (let col = from.col - 1; col <= to.col + 1; col++) {
      const hex = { col, row };
      if (!hexInScene(g, bounds, hex)) {
        yield null;
        continue;
      }
      const d = hexSetSteps(g, reach.from, [hex]);
      const run = d <= reach.steps ? layersAt(d) : null;
      yield run ? { hex, lo: run.lo, hi: run.hi } : null;
    }
  }
}

/**
 * Whether a point lies on any of these hexes, its outline included: on or
 * inside each side of one, the corners rounded as `hexEdgeOrigin` takes
 * them, so a cast's origin on a corner or a side's midpoint is on its
 * caster.
 */
function onHexes(g: HexGrid, hexes: readonly Hex[], p: Point): boolean {
  const E = 1e-6;
  return hexes.some((h) => {
    const corners = hexCorners(g, h).map((k) => cornerAt(g, k));
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 6; i++) {
      const a = corners[i]!;
      const b = corners[(i + 1) % 6]!;
      const side = ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / Math.hypot(b.x - a.x, b.y - a.y);
      lo = Math.min(lo, side);
      hi = Math.max(hi, side);
    }
    // The same side of every edge, whichever way the corners run.
    return lo >= -E || hi <= E;
  });
}

/**
 * The point on a footprint's outline that a cone, line or cube cast from
 * it starts at (HX-D11): where the aim from its anchor leaves the outline,
 * moved to the nearest of the outline's corners and side midpoints, as
 * `edgeOrigin` does on a rectangle. Sides between two of its hexes are
 * inside it and offer none.
 */
export function hexEdgeOrigin(g: HexGrid, hexes: readonly Hex[], anchor: Point, yawDeg: number): Point {
  const held = new Set(hexes.map(hexKey));
  const sides: [Point, Point][] = [];
  for (const h of hexes) {
    const c = hexCenter(g, h);
    const corners = hexCorners(g, h).map((k) => cornerAt(g, k));
    for (let i = 0; i < 6; i++) {
      const a = corners[i]!;
      const b = corners[(i + 1) % 6]!;
      // The hex across a side has its center mirrored through the side's midpoint.
      const across = hexAt(g, { x: a.x + b.x - c.x, y: a.y + b.y - c.y });
      if (!held.has(hexKey(across))) sides.push([a, b]);
    }
  }
  const d = yawVector(yawDeg);
  let exit: Point = anchor;
  let far = -Infinity;
  for (const [a, b] of sides) {
    // The ray anchor + t d against the side a + s (b - a), 0 <= s <= 1.
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const den = d.x * ey - d.y * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((a.x - anchor.x) * ey - (a.y - anchor.y) * ex) / den;
    const s = ((a.x - anchor.x) * d.y - (a.y - anchor.y) * d.x) / den;
    if (t < 0 || s < -1e-9 || s > 1 + 1e-9 || t <= far) continue;
    far = t;
    exit = { x: anchor.x + d.x * t, y: anchor.y + d.y * t };
  }
  let best = exit;
  let bestDist = Infinity;
  for (const [a, b] of sides) {
    for (const p of [a, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }]) {
      const dist = Math.hypot(p.x - exit.x, p.y - exit.y);
      if (dist < bestDist - 1e-12) {
        bestDist = dist;
        best = p;
      }
    }
  }
  return best;
}

/**
 * The fixed pattern of samples in a hex, as offsets from its center on hex
 * rows (mirrored on hex columns): an `n` by `n` grid of points per cell, the
 * same for every hex, kept where they lie strictly inside the hexagon, so
 * every hex is graded on the same count. About 222 at 16 per cell side.
 */
const PATTERNS = new Map<number, readonly Point[]>();

function hexPattern(n: number): readonly Point[] {
  let pattern = PATTERNS.get(n);
  if (pattern) return pattern;
  const out: Point[] = [];
  const rows = Math.ceil(2 * HEX_R * n);
  for (let j = 0; j < rows; j++) {
    const dy = (j - (rows - 1) / 2) / n;
    for (let i = 0; i < n; i++) {
      const dx = (i + 0.5) / n - 0.5;
      // A pointed-top hexagon: |dx| within half a cell and |dy| within HEX_R less the slope of its sloped sides.
      if (Math.abs(dy) < HEX_R * (1 - Math.abs(dx))) out.push({ x: dx, y: dy });
    }
  }
  PATTERNS.set(n, (pattern = out));
  return pattern;
}

/**
 * Per-hex sample counts for one resolved area on a hex scene: each hex's
 * pattern of samples inside its shape and its visibility polygons, or for
 * an emanation, whether the hex is within its reach and how much of the
 * hex its polygons see. A hex far enough from the surface is all in or all
 * out without sampling, as a square cell is.
 */
class HexSampler {
  readonly g: HexGrid;
  readonly area: SampledArea;
  readonly pattern: readonly Point[];
  readonly scene: { w: number; h: number };
  readonly crossings = new Map<number, Float64Array[]>();
  readonly polys: PolygonIndex[];
  /** Whether the center of the hex last passed to `count` is inside. */
  center = false;

  constructor(g: HexGrid, area: SampledArea, n: number, scene: { w: number; h: number }) {
    this.g = g;
    this.area = area;
    this.pattern = hexPattern(n).map((p) => (g.orient === "rows" ? p : { x: p.y, y: p.x }));
    this.scene = scene;
    this.polys = area.polygons.map((p) => indexPolygon(p, 0, Math.max(1, scene.h)));
  }

  get total(): number {
    return this.pattern.length;
  }

  private seen(x: number, y: number): boolean {
    if (this.polys.length === 0) return true;
    let rows = this.crossings.get(y);
    if (!rows) this.crossings.set(y, (rows = this.polys.map((p) => crossingsAt(p, y))));
    return anyInside(rows, x);
  }

  /**
   * The hexes the area can reach, with their centers: every hex of the
   * scene in its bounds whose center lies within a hex's reach of its
   * surface at height `z`, or on an emanation within its steps of the hexes
   * it surrounds, with those steps (`d`). Centers are worked out on the
   * rows lattice as hexCenter does, so a hex far from the area costs one
   * distance and nothing more. Only the scene's hexes are read, so a long
   * reach on a small scene costs the scene and not the reach (review
   * HX2-ASTRA-03).
   */
  candidates(z: number): { hex: Hex; c: Point; d?: number }[] {
    const g = this.g;
    const reach = this.area.reach;
    const rows = g.orient === "rows";
    const b = this.area.shape.bounds;
    // The bounds on the rows lattice, clipped to the scene: as they are on rows, x and y swapped on columns.
    const w = rows ? this.scene.w : this.scene.h;
    const h = rows ? this.scene.h : this.scene.w;
    const x0 = Math.max(0, rows ? b.x0 : b.y0);
    const x1 = Math.min(w, rows ? b.x1 : b.y1);
    const y0 = Math.max(0, rows ? b.y0 : b.x0);
    const y1 = Math.min(h, rows ? b.y1 : b.x1);
    const out: { hex: Hex; c: Point; d?: number }[] = [];
    const shape = this.area.shape;
    for (let r = Math.max(0, Math.floor((y0 - HEX_R) / HEX_S) - 1); r <= Math.floor((y1 - HEX_R) / HEX_S) + 1; r++) {
      const cy = HEX_R + r * HEX_S;
      const shift = 0.5 + 0.5 * (r & 1);
      for (let col = Math.max(0, Math.floor(x0) - 1); col <= Math.floor(x1) + 1; col++) {
        const cx = col + shift;
        const c = rows ? { x: cx, y: cy } : { x: cy, y: cx };
        const hex = rows ? { col, row: r } : { col: r, row: col };
        if (reach) {
          // The emanation's shape bounds its reach: every hex within its steps lies within that many cells and a hex of its box.
          if (!hexInScene(g, this.scene, hex)) continue;
          const d = hexSetSteps(g, reach.from, [hex]);
          if (d <= reach.steps) out.push({ hex, c, d });
          continue;
        }
        if (shape.sd(c.x, c.y, z) > HEX_R) continue;
        if (hexInScene(g, this.scene, hex)) out.push({ hex, c });
      }
    }
    return out;
  }

  /**
   * Inside samples of hex `h` at height `z`, and `center` set. On an
   * emanation `d` is the hex's steps from its source and `layers` the
   * creature's: a hex out of reach counts none, one in reach its seen ones.
   */
  count(h: Hex, z: number, d?: number, layers?: [number, number], c: Point = hexCenter(this.g, h)): number {
    this.center = false;
    // A hex past the scene's edge is never shaded, so it catches no one either (review HX2-OPUS-02).
    if (!hexInScene(this.g, this.scene, h)) return 0;
    return this.grade(h, z, d, layers, c);
  }

  /** Whether `d` steps from an emanation's source are within its reach at the shading slice, worked out once a distance. */
  private readonly sliceReach: boolean[] = [];

  /** `count` for a hex known to lie in the scene, as every candidate does. */
  private grade(h: Hex, z: number, d: number | undefined, layers: [number, number] | undefined, c: Point): number {
    const reach = this.area.reach;
    let whole: boolean;
    if (reach) {
      const steps = d ?? hexSetSteps(this.g, reach.from, [h]);
      if (layers === undefined && d !== undefined) {
        // The shading slice, the source's own layer: the answer depends on the steps alone.
        let ok = this.sliceReach[steps];
        if (ok === undefined) this.sliceReach[steps] = ok = withinReach(reach, steps, reach.z0, reach.z0 + 1);
        if (!ok) return 0;
      } else {
        const zl = layers ?? [Math.floor(z), Math.floor(z) + 1];
        if (!withinReach(reach, steps, zl[0], zl[1])) return 0;
      }
      whole = true;
    } else {
      const sd = this.area.shape.sd(c.x, c.y, z);
      if (sd > HEX_R) return 0;
      whole = sd < -HEX_R;
    }
    if (whole && this.area.polygons.length === 0) {
      this.center = true;
      return this.total;
    }
    this.center = (whole || this.area.shape.inside(c.x, c.y, z)) && this.seen(c.x, c.y);
    let n = 0;
    for (const p of this.pattern) {
      const x = c.x + p.x;
      const y = c.y + p.y;
      if (!whole && !this.area.shape.inside(x, y, z)) continue;
      if (this.seen(x, y)) n++;
    }
    return n;
  }

  /**
   * Whether a point is inside at height `z`, as squares read a creature's
   * middle under "center": inside the shape, or on an emanation `d` steps
   * from its source with the creature's `layers` within its reach, and seen
   * by its polygons, within the scene. Not by the hex under it: a Large
   * or Gargantuan anchor is a corner three hexes share, and which of them
   * `hexAt` picks there turns on the row (review FU33-O2).
   */
  pointIn(p: Point, z: number, d: number | undefined, layers: [number, number]): boolean {
    if (p.x < 0 || p.y < 0 || p.x > this.scene.w || p.y > this.scene.h) return false;
    const reach = this.area.reach;
    if (reach ? !withinReach(reach, d ?? hexSetSteps(this.g, reach.from, [hexAt(this.g, p)]), layers[0], layers[1]) : !this.area.shape.inside(p.x, p.y, z)) return false;
    return this.seen(p.x, p.y);
  }

  /** The hexes passing the coverage rule at the shading height. */
  covered(z: number, rule: AoeCoverage): CoveredHex[] {
    const reach = this.area.reach;
    const out: CoveredHex[] = [];
    for (const { hex: h, c, d } of this.candidates(z)) {
      // The shading slice is the source's own height, so only the steps between the hexes count there.
      const n = this.grade(h, z, d, undefined, c);
      if (passes(n, this.total, this.center, rule)) out.push({ col: h.col, row: h.row, coverage: n / this.total });
    }
    return out;
  }
}

/**
 * The creatures an area catches on a hex scene, by their hexes (HX-D11):
 * any of them passing the coverage rule by default, more than half of
 * their hexes' samples under "majority", and under "center" the anchor
 * point itself, as squares read the footprint's middle, with an
 * emanation's steps counted from all their hexes. A Large or Gargantuan
 * anchor is a corner three hexes share, which no one hex holds the same way
 * on every row (review HX2-OPUS-01). Each is measured at its own height,
 * as on squares, and an emanation's reach counts the vertical steps to its
 * layers. A creature none of whose hexes is the scene's is caught by no
 * rule: the DM may stand a token on the hex past an odd row's end, whose
 * center lies on the scene's edge, and no hex past the edge is shaded
 * (review HX2-OPUS-14).
 */
function creaturesOnHexes(g: HexGrid, template: AreaTemplateInput, area: ResolvedArea, tokens: Iterable<AreaToken>, ctx: AreaContext): TokenId[] {
  const fpc = feetPerCellOf(ctx);
  const scene = sceneBounds(ctx);
  const s = new HexSampler(g, area, samplesOf(ctx), scene);
  const { aoeCoverage, aoeInclusion } = ctx.settings;
  const caught: TokenId[] = [];
  for (const t of tokens) {
    if (template.sceneId !== undefined && t.sceneId !== undefined && t.sceneId !== template.sceneId) continue;
    if (!template.includeOrigin && t.id === area.originTokenId) continue;
    const { lo, hi } = verticalExtentFt(t, fpc);
    const z0 = Math.floor(lo / fpc);
    const layers: [number, number] = [z0, Math.max(z0 + 1, Math.ceil(hi / fpc))];
    const sliceZ = area.sliceZ;
    const zsAt = (p: Point) => (sliceZ ? heightsThrough(lo / fpc, hi / fpc, sliceZ(p.x, p.y)) : [clamp(area.originZ, lo / fpc, hi / fpc)]);
    const hexes = occupiedHexes(g, t);
    if (aoeInclusion === "center") {
      if (!hexes.some((h) => hexInScene(g, scene, h))) continue;
      const p = hexAnchor(g, t);
      const d = area.reach ? hexSetSteps(g, area.reach.from, hexes) : undefined;
      if (zsAt(p).some((z) => s.pointIn(p, z, d, layers))) caught.push(t.id);
      continue;
    }
    const best = hexes.map((h) => {
      let top = 0;
      let center = false;
      for (const z of zsAt(hexCenter(g, h))) {
        const n = s.count(h, z, undefined, layers);
        if (n > top || (n === top && s.center)) {
          top = n;
          center = s.center;
        }
      }
      return { n: top, center };
    });
    const hit = aoeInclusion === "majority" ? 2 * best.reduce((a, b) => a + b.n, 0) > best.length * s.total : best.some((b) => passes(b.n, s.total, b.center, aoeCoverage));
    if (hit) caught.push(t.id);
  }
  return caught;
}
