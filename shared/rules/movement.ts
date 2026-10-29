import type { Scene, Token } from "../model.ts";
import type { DoorRef } from "../protocol.ts";
import type { Blocker, BuildState, LegEnd } from "../ruleHooks.ts";
import { anchorOfHex, canSqueeze, footprintRect, footprintSize, hexSqueezedSize, isSqueezed, occupiedHexes, occupiedRange, sizeCategory, snapStep, squeezedSize, storedCenter, type PlacedToken, type SizeCategory } from "./footprint.ts";
import type { Point } from "./geom.ts";
import { footing, footprintGround, oppositeFacing, standing, type Standing } from "./heights.ts";
import { standsAcrossBands } from "../migrate.ts";
import { APART, contact, CROSS, MOVEMENT, onSegment, orient, PIECE } from "./segments.ts";
import { LEDGE, PIECE_BAND, pieceBlocks, pieceTouches, sceneWalls, type WallSet } from "./walls.ts";
import { isHex, sceneGrid, SQUARES } from "./grid.ts";
import { footprintHexes, hexCenter, hexInScene, hexKey, hexLine, hexNeighbors, referenceHex, snapAnchor, type Hex, type HexGrid } from "./hex.ts";

/**
 * Walls, doors and ledges stopping moves (docs/design-v1-maps-vision.md
 * sections 4.1 and 4.2).
 *
 * A token moves its center in straight legs. Collision uses its core, a
 * rectangle one size smaller than its footprint, so a Large creature passes
 * a 5 ft door and no creature's path ever crosses a wall: the core, swept
 * along the leg, may touch no segment of the movement set. A creature whose
 * core is more than a point may also take one of the shifted paths, which
 * line its core up with an opening half a cell off its snapped centers.
 *
 * The movement set is the stored segments of the wall set (walls.ts), never
 * the split pieces, so every end lies on the 1/64 lattice and every touch is
 * decided exactly: the exact orientation predicate (segments.ts `orient`),
 * plus comparisons of coordinates. A token's center and core are computed
 * with + and - from its stored position, exact for every snapped or
 * half-cell position and every standard size. So a phone dragging and the
 * server judging the drop always agree.
 *
 * Squeezing (decided 2026-10-14) lets a creature with a side of 2 cells or
 * more stop in an opening one size too small, stored half a cell off the
 * grid with `squeeze` set, where every rule reads its squeezed footprint
 * (footprint.ts).
 */

/**
 * The token fields the movement rule reads. `footing` and `offHolder` are
 * set only on a copy made for a walk off a holder on the ground
 * (rules/attach.ts walkerFor), or `footing` for a judgment of a walk whose
 * route is not known (`walkStates`), never on a stored token. A walk off a
 * holder is on the ground (`footing`), whatever its height, and every
 * ledge stops it, but for one exemption (docs/design-v1-attach.md 4.3, reviews AT-O-26,
 * AT-ASTRA-16 and AT-ASTRA-17). Until it first stands clear of the holder,
 * no ledge whose whole length lies strictly inside the holder's footprint
 * stops it (walls.ts `withoutLedgesInside`), the squeezed footprint while
 * the holder squeezes (rules/attach.ts walkerFor), so it crosses the step
 * under a holder that straddles two heights. On hexes those are the raised
 * sides between two of the hexes the holder stands on (walls.ts
 * `withoutLedgesBetween`, `hexWallsOf`), and the walk is clear of the
 * holder once it shares none of them (OffHolder). A ledge on the footprint's boundary
 * stops it, so a rider steps off no cliff at her mount's side, and so does
 * every ledge beyond, so she climbs none either. Each leg is one straight
 * test, walls and ledges alike. `offHolder` is the walk's state: a walk
 * drops it at its first spot clear of the holder (`walkOn`), and the walk
 * comes back over the holder on the ground's rule. `groundStart` marks a
 * walk off it that starts on the ground under its own footprint rather
 * than at its seat (`walkFrom`, rules/attach.ts walkerFor).
 */
export type MovingToken = PlacedToken & Pick<Token, "sceneId" | "elevation"> & { footing?: Standing; offHolder?: OffHolder; groundStart?: true };

/**
 * The elevation a token lands at (docs/design-v1-maps-vision.md 4.2,
 * "Landings write the ground"): a token that stood on the ground takes the
 * ground where it lands, a flier keeps its height or rises to the ground
 * there, whichever is higher, and a token inside the ground keeps its
 * elevation, since nothing raises one on its own. The ground there is under
 * the footprint it lands with, the squeezed one where it squeezes.
 *
 * One that leaves its holder (`holder`, docs/design-v1-attach.md 4.3) is
 * judged from the holder, not from the ground under its seat, which
 * differs where the holder straddles two heights: off a holder on the
 * ground it lands on the ground there, off a flier it keeps its height or
 * rises to the ground, and off a holder inside the ground it keeps its
 * elevation. This is every landing's height, the device's and the
 * server's, which sets it from the real build where a player's copy lacks
 * the ground (docs/design-v1-map-discovery.md 6).
 */
export function landedElevation(
  chunks: Parameters<typeof footprintGround>[0],
  token: PlacedToken & Pick<Token, "sceneId" | "elevation"> & { footing?: Standing },
  at: Point & { squeeze?: boolean },
  holder?: PlacedToken & Pick<Token, "sceneId" | "elevation"> & { footing?: Standing },
): number {
  const before = footing(chunks, holder ?? token);
  if (before === "inside") return token.elevation;
  const there = footprintGround(chunks, { ...token, x: at.x, y: at.y, squeeze: at.squeeze === true ? true : undefined });
  return before === "ground" ? there : Math.max(token.elevation, there);
}

/**
 * The holder a walk off it leaves, where it stands. On a hex scene, from op
 * version 32, it carries the scene's grid (attach.ts walkerFor), and the
 * walk reads the holder by the hexes it stands on: on it while it shares
 * one of them, crossing the raised sides between two of them until then.
 * Without the grid it is read by its box, and on hexes no ledge is crossed.
 */
export type OffHolder = PlacedToken & { hex?: HexGrid };

declare const walking: unique symbol;

/**
 * A token as its walk reads it (review AT-ASTRA-19). Every leg and spot test
 * of a move takes only this: rules/attach.ts `walkerFor` makes one from a
 * token where it stands, `walkOn` carries it from stop to stop, and
 * `pastHolder` takes it off its holder. So no check can judge a stored
 * token by its own footing where its walk reads another, as a rider's
 * ground under a holder that stands on the ground. A check that judges a
 * token as itself, with no holder to leave, says so with `ownWalk`.
 */
export type Walker = MovingToken & { readonly [walking]: true };

/**
 * The token walking as itself, with no holder to leave: for what is never
 * a walk off a holder, as a creature a holder drags beside it, a token not
 * yet in the room, or a footprint the walk has already worked out. Every
 * other move reads its walker from `walkerFor`.
 */
export function ownWalk<T extends MovingToken>(token: T): T & Walker {
  return token as T & Walker;
}

/**
 * What a player hears when a wall or a ledge stops a move, or a resize,
 * which is judged as one (resize.ts). A secret door not yet found answers as
 * a wall, as players see it.
 */
export const WALL_IN_THE_WAY = "A wall is in the way.";
export const LEDGE_IN_THE_WAY = "A ledge is in the way.";

/** How much narrower than its footprint a core is per axis: one cell, and a 1/32 cell margin so a core never fills an opening exactly. */
export const CORE_MARGIN = 1 + 1 / 32;

/** The core's size: per axis `max(0, side - 1 - 1/32)`. A segment when one side is 0, the center alone when both are. */
export function coreSize(token: PlacedToken): { w: number; h: number } {
  const { w, h } = footprintSize(token);
  return { w: Math.max(0, w - CORE_MARGIN), h: Math.max(0, h - CORE_MARGIN) };
}

/** The nine half-cell shifts, no shift first, then along each axis, then diagonally. The order fixes which squeezed spot a drop finds first. */
export const SHIFTS: readonly (readonly [number, number])[] = [
  [0, 0],
  [-0.5, 0],
  [0.5, 0],
  [0, -0.5],
  [0, 0.5],
  [-0.5, -0.5],
  [0.5, -0.5],
  [-0.5, 0.5],
  [0.5, 0.5],
];

// ---------------------------------------------------------------------------
// The exact touch test

/**
 * Whether a core of half sides (hx, hy), its center swept from P to Q,
 * touches the closed segment AB. The swept core is a convex hexagon with
 * sides along x, y and the path, so it misses the segment exactly when one
 * of those three directions, or the segment's own normal, separates them
 * strictly (the separating axis test). Touching counts.
 */
export function sweptTouches(px: number, py: number, qx: number, qy: number, hx: number, hy: number, ax: number, ay: number, bx: number, by: number): boolean {
  if ((ax > bx ? ax : bx) < (px < qx ? px : qx) - hx || (ax < bx ? ax : bx) > (px < qx ? qx : px) + hx) return false;
  if ((ay > by ? ay : by) < (py < qy ? py : qy) - hy || (ay < by ? ay : by) > (py < qy ? qy : py) + hy) return false;
  if (px !== qx || py !== qy) {
    const dx = qx - px;
    const dy = qy - py;
    // The corner furthest along the path's normal (-dy, dx), and the line through it at both ends.
    const cx = dy <= 0 ? hx : -hx;
    const cy = dx >= 0 ? hy : -hy;
    const inner = orient(px + cx, py + cy, qx + cx, qy + cy, px - cx, py - cy);
    if (inner === 0) {
      // A core with no width across the path: it sweeps the path's own line.
      const oa = orient(px, py, qx, qy, ax, ay);
      if (oa !== 0 && oa === orient(px, py, qx, qy, bx, by)) return false;
    } else {
      const ua = orient(px + cx, py + cy, qx + cx, qy + cy, ax, ay);
      if (ua === -inner && orient(px + cx, py + cy, qx + cx, qy + cy, bx, by) === -inner) return false;
      const la = orient(px - cx, py - cy, qx - cx, qy - cy, ax, ay);
      if (la === inner && orient(px - cx, py - cy, qx - cx, qy - cy, bx, by) === inner) return false;
    }
  }
  // The segment's normal (-ey, ex): the swept core's extreme points along it are its end cores' corners furthest each way.
  const mx = by - ay <= 0 ? hx : -hx;
  const my = bx - ax >= 0 ? hy : -hy;
  const s = orient(ax, ay, bx, by, px + mx, py + my);
  if (s === 0) return true;
  return !(orient(ax, ay, bx, by, px - mx, py - my) === s && orient(ax, ay, bx, by, qx + mx, qy + my) === s && orient(ax, ay, bx, by, qx - mx, qy - my) === s);
}

/**
 * Whether the closed segment AB passes through the open rectangle, not only
 * along its edge. They miss exactly when a side's line or the segment's line
 * has the open rectangle wholly on one side, the segment on the other or on
 * it.
 */
export function crossesInterior(x0: number, y0: number, x1: number, y1: number, ax: number, ay: number, bx: number, by: number): boolean {
  if ((ax > bx ? ax : bx) <= x0 || (ax < bx ? ax : bx) >= x1 || (ay > by ? ay : by) <= y0 || (ay < by ? ay : by) >= y1) return false;
  const corners = [orient(ax, ay, bx, by, x0, y0), orient(ax, ay, bx, by, x1, y0), orient(ax, ay, bx, by, x1, y1), orient(ax, ay, bx, by, x0, y1)];
  return corners.some((o) => o > 0) && corners.some((o) => o < 0);
}

/*
 * Whether the closed segment AB meets the line x = `at` (`vertical`) or
 * y = `at` between `lo` and `hi` along it, each end included unless open.
 * Exact: the span's ends are doubles and `orient` is exact for any.
 */
function meetsSpan(vertical: boolean, at: number, lo: number, loOpen: boolean, hi: number, hiOpen: boolean, ax: number, ay: number, bx: number, by: number): boolean {
  const [px, py, qx, qy] = vertical ? [at, lo, at, hi] : [lo, at, hi, at];
  const c = contact(ax, ay, bx, by, px, py, qx, qy);
  if (c === APART) return false;
  if (c === CROSS) return true;
  const along = (x: number, y: number) => (vertical ? y : x);
  const inSpan = (t: number) => (loOpen ? t > lo : t >= lo) && (hiOpen ? t < hi : t <= hi);
  if (orient(px, py, qx, qy, ax, ay) === 0 && orient(px, py, qx, qy, bx, by) === 0) {
    // Along the line: the two ranges must share a point the span includes.
    const from = Math.max(Math.min(along(ax, ay), along(bx, by)), lo);
    const to = Math.min(Math.max(along(ax, ay), along(bx, by)), hi);
    return from < to || (from === to && inSpan(from));
  }
  // One shared point: an end of AB on the span, or an end of the span on AB.
  if (onSegment(ax, ay, px, py, qx, qy) && inSpan(along(ax, ay))) return true;
  if (onSegment(bx, by, px, py, qx, qy) && inSpan(along(bx, by))) return true;
  return (!loOpen && onSegment(px, py, ax, ay, bx, by)) || (!hiOpen && onSegment(qx, qy, ax, ay, bx, by));
}

/** A rectangle by its low and high corners. */
type Box = { x0: number; y0: number; x1: number; y1: number };

/**
 * Whether segments `segs` pinch a squeezed creature (the owner's rule after
 * the wave 4 build, section 4.1): along an axis its squeeze shrinks, some
 * cross-section of its full footprint `full`, level with its squeezed
 * footprint `sq`, is blocked on both sides of its core `core` and open
 * across the core. Along y: a line x = c with c from `sq.x0` to `sq.x1` meets
 * a blocker between the full footprint's north edge (not included) and the
 * core's north edge, another between the core's south edge and the full
 * footprint's south edge, and none between the core's edges. So the walls of
 * a corridor, at its dead end too, and the frame of an open door pinch,
 * while one wall beside open ground, or a closed door in its frame, which
 * runs on along the creature, does not.
 *
 * The cross-sections tried are the footprint's edges, every blocker's end
 * and every point where a slanted blocker crosses a strip's edge, and the
 * midpoints between them: what the three answers can change at. The core,
 * not `sq`, bounds the strips, so a drag preview a hair off a corridor's
 * middle is still pinched.
 *
 * `banded` marks the segments that are a held build's pieces read by the
 * gate test (5.2, MD4-LK-3): each meets a span where it comes within its
 * band of it, crosses the core's span only where it surely does
 * (walls.ts pieceBlocks), and adds its marks shifted by the band either
 * way, so the gate finds every pinch some exact wall the piece stands for
 * makes. The others are judged exactly.
 */
export function pinches(segs: readonly (readonly [number, number, number, number])[], full: Box, core: Box, sq: Box, alongX: boolean, alongY: boolean, banded: readonly boolean[] = []): boolean {
  const band = PIECE_BAND * (1 + 1e-9);
  const across = (vertical: boolean): boolean => {
    // `vertical`: cross-sections are lines x = c, judged along y.
    const [c0, c1] = vertical ? [sq.x0, sq.x1] : [sq.y0, sq.y1];
    const [f0, k0, k1, f1] = vertical ? [full.y0, core.y0, core.y1, full.y1] : [full.x0, core.x0, core.x1, full.x1];
    const marks = [c0, c1];
    segs.forEach(([ax, ay, bx, by], i) => {
      const [a, b, ua, ub] = vertical ? [ax, bx, ay, by] : [ay, by, ax, bx];
      const found: number[] = [a, b];
      if (a !== b && ua !== ub) for (const u of [f0, k0, k1, f1]) found.push(a + ((u - ua) * (b - a)) / (ub - ua));
      for (const v of banded[i] ? found.flatMap((m) => [m - band, m, m + band]) : found) if (v > c0 && v < c1) marks.push(v);
    });
    marks.sort((p, q) => p - q);
    const tries = [...marks];
    for (let i = 1; i < marks.length; i++) if (marks[i]! > marks[i - 1]!) tries.push((marks[i - 1]! + marks[i]!) / 2);
    // The span from `lo` to `hi` along the cross-section at `c`, as the ends of a segment.
    const span = (c: number, lo: number, hi: number) => (vertical ? ([c, lo, c, hi] as const) : ([lo, c, hi, c] as const));
    const blocked = (c: number, lo: number, loOpen: boolean, hi: number, hiOpen: boolean) =>
      segs.some((s, i) => (banded[i] ? sweptTouches(...span(c, lo, hi), band, band, ...s) : meetsSpan(vertical, c, lo, loOpen, hi, hiOpen, ...s)));
    const crossed = (c: number) => segs.some((s, i) => (banded[i] ? pieceBlocks(...span(c, k0, k1), 0, 0, ...s) : meetsSpan(vertical, c, k0, true, k1, true, ...s)));
    return tries.some((c) => blocked(c, f0, true, k0, false) && blocked(c, k1, false, f1, true) && !crossed(c));
  };
  return (alongY && across(true)) || (alongX && across(false));
}

// ---------------------------------------------------------------------------
// The device's two tests of a held build's pieces

/*
 * A player's held build carries free walls as the server cut them, each
 * end moved up to 1/10000 cell per coordinate, so no test of a piece can
 * be exact (docs/design-v1-map-discovery.md 5.2, ASTRA-30, ASTRA-34). An
 * action the device sends is gated by `pieceBlocks`, which stops it only
 * where the exact wall surely does, so the device never refuses, shortens
 * or withholds what the exact pieces it holds allow, and the server's
 * landing settles the rest. What nothing checks after it (a walking
 * ruler, a drag's held preview and the words it shows before the drop)
 * reads `pieceTouches`, which stops anything within the band, so a
 * T-junction on a tilted piece stays closed there. The gate is the rule
 * for every build, since the server's holds no pieces and a check that
 * forgets to choose then errs only toward sending. A preview asks for the
 * other test by reading its build through `previewChunks`, which marks the
 * chunk collection itself, since that is what every rule passes along.
 */

type PieceTest = "gate" | "preview";

type Chunks = BuildState["buildChunks"];

const previewBuilds = new WeakSet<object>();
const previewCopies = new WeakMap<object, Chunks>();

/** The chunks as a preview reads them: the same chunks, whose pieces every movement test then reads by `pieceTouches`. One per collection, so caches over it hold. */
export function previewChunks(chunks: Chunks): Chunks {
  if (previewBuilds.has(chunks)) return chunks;
  let copy = previewCopies.get(chunks);
  if (!copy) {
    copy = { ...chunks };
    previewBuilds.add(copy);
    previewCopies.set(chunks, copy);
  }
  return copy;
}

/** Whether a build is read as a preview reads it (`previewChunks`). */
export function isPreview(chunks: Chunks): boolean {
  return previewBuilds.has(chunks);
}

function pieceTestOf(chunks: Chunks): PieceTest {
  return previewBuilds.has(chunks) ? "preview" : "gate";
}

/** Whether the core of half sides (hx, hy) swept from P to Q meets stored segment `k`: exactly, or for a held build's piece by the device's test of it. */
function meets(walls: WallSet, k: number, test: PieceTest, px: number, py: number, qx: number, qy: number, hx: number, hy: number): boolean {
  const xy = walls.stored.xy;
  const ax = xy[4 * k]!;
  const ay = xy[4 * k + 1]!;
  const bx = xy[4 * k + 2]!;
  const by = xy[4 * k + 3]!;
  if (walls.stored.free[k] !== PIECE) return sweptTouches(px, py, qx, qy, hx, hy, ax, ay, bx, by);
  return test === "gate" ? pieceBlocks(px, py, qx, qy, hx, hy, ax, ay, bx, by) : pieceTouches(px, py, qx, qy, hx, hy, ax, ay, bx, by);
}

// ---------------------------------------------------------------------------
// The movement set

/**
 * Which raised edges stop a leg (section 4.2), as the lowest top that does:
 * a ledge stops it when its top is above this. A token on the ground at the
 * leg's start walks and every ledge stops it. A flier is stopped only by
 * ledges above the lower of its start and end elevation. A token inside the
 * ground, and every token on a scene whose `blockMovement` is off, passes
 * ledges. A ledge a directed stair connects is no ledge (walls.ts), for
 * walkers and fliers alike.
 */
function ledgeFloor(walls: WallSet, scene: Pick<Scene, "blockMovement">, token: MovingToken, endElevation: number): number {
  if (scene.blockMovement !== true || !walls.hasRelief) return Infinity;
  // On hexes a footprint stands on its hexes' ground (H3).
  const g = walls.grid;
  const ground = isHex(g) ? Math.max(...occupiedHexes(g, token).map((h) => walls.groundAt(h.col, h.row))) : walls.rangeGround(occupiedRange(SQUARES, token));
  switch (token.footing ?? standing(token.elevation, ground)) {
    case "ground":
      return -Infinity;
    case "flying":
      return Math.min(token.elevation, endElevation);
    case "inside":
      return Infinity;
  }
}

function blocksMove(walls: WallSet, k: number, floor: number): boolean {
  const tags = walls.stored.tags[k]!;
  return (tags & MOVEMENT) !== 0 || ((tags & LEDGE) !== 0 && walls.storedTops[k]! > floor);
}

const stamps = new WeakMap<WallSet, Uint32Array>();
let stampSerial = 0;

/**
 * The stored segments of the movement set that touch a core of half sides
 * (hx, hy) swept from P to Q, found by walking the index's cells row by row
 * under the swept core. The row bounds are worked out with a margin, and the
 * exact test decides each segment.
 */
function touching(walls: WallSet, px: number, py: number, qx: number, qy: number, hx: number, hy: number, floor: number, test: PieceTest): number[] {
  const index = walls.storedIndex;
  let seen = stamps.get(walls);
  if (!seen) stamps.set(walls, (seen = new Uint32Array(walls.stored.n)));
  const stamp = ++stampSerial;
  const out: number[] = [];
  const mask = MOVEMENT | (floor === Infinity ? 0 : LEDGE);
  const EPS = 1e-7;
  const y0 = Math.min(py, qy) - hy;
  const y1 = Math.max(py, qy) + hy;
  const dx = qx - px;
  const dy = qy - py;
  const visit = (k: number) => {
    if (seen[k] === stamp) return;
    seen[k] = stamp;
    if (!blocksMove(walls, k, floor)) return;
    if (meets(walls, k, test, px, py, qx, qy, hx, hy)) out.push(k);
  };
  for (let r = Math.floor(y0); r <= Math.floor(y1); r++) {
    // The centers whose core reaches this row, and so the row's span of x.
    const lo = Math.max(r, y0) - hy - EPS;
    const hi = Math.min(r + 1, y1) + hy + EPS;
    let t0 = 0;
    let t1 = 1;
    if (dy !== 0) {
      const ta = (lo - py) / dy;
      const tb = (hi - py) / dy;
      t0 = Math.max(0, Math.min(ta, tb));
      t1 = Math.min(1, Math.max(ta, tb));
      if (t0 > t1) continue;
    }
    const xa = px + dx * t0;
    const xb = px + dx * t1;
    index.query(Math.min(xa, xb) - hx - EPS, r, Math.max(xa, xb) + hx + EPS, r, mask, visit);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Legs

/** A leg as the rule judges it: centers, core half sides, and the movement set's segments near it. */
type Leg = {
  walls: WallSet;
  px: number;
  py: number;
  qx: number;
  qy: number;
  hx: number;
  hy: number;
  floor: number;
  test: PieceTest;
};

/**
 * Whether the part from S to E touches none of `segs`. On a path's first
 * part, a segment the core touches where the leg starts is ignored while
 * the part moves the center away from its line, toward the side the start
 * center is on, or either side when the start center lies on the line
 * (section 4.1), so a token can step off a wall it overlaps but never cross
 * it. Moving along the line, or toward the far side, keeps it.
 */
function partClear(leg: Leg, segs: readonly number[], atStart: ReadonlySet<number>, sx: number, sy: number, ex: number, ey: number, first: boolean): boolean {
  for (const k of segs) {
    if (!meets(leg.walls, k, leg.test, sx, sy, ex, ey, leg.hx, leg.hy)) continue;
    if (first && atStart.has(k) && leaves(leg.walls, k, leg.test, leg.px, leg.py, ex - sx, ey - sy)) continue;
    return false;
  }
  return true;
}

/** The segments of `segs` the core touches where the leg starts, the runs of held pieces they belong to included for the gate (`pieceRun`). */
function startSet(leg: Leg, segs: readonly number[]): Set<number> {
  const out = new Set(segs.filter((k) => meets(leg.walls, k, leg.test, leg.px, leg.py, leg.px, leg.py, leg.hx, leg.hy)));
  if (leg.test === "gate") for (const k of [...out]) if (leg.walls.stored.free[k] === PIECE) for (const j of pieceRun(leg.walls, k)) out.add(j);
  return out;
}

const pieceRuns = new WeakMap<WallSet, Map<number, readonly number[]>>();

/**
 * The pieces of a held build cut from one wall, by any of them: those end
 * to end with it, as the cut leaves them, each within the band of the
 * line of the one it follows and of the same tags and kind. The server
 * holds that wall as one segment, so where the core touches any piece of
 * it as a leg starts, the gate lets the leg leave every piece of it, as
 * section 4.1 lets it leave the wall (MD4-ASTRA-1). Two walls drawn end to
 * end in one line read as one, which only lets the device send more. A
 * door never joins a run: players get doors whole, so a door is never a
 * piece of the wall beside it, and a closed door blocks as a wall does.
 */
function pieceRun(walls: WallSet, k: number): readonly number[] {
  let runs = pieceRuns.get(walls);
  if (!runs) pieceRuns.set(walls, (runs = new Map()));
  const known = runs.get(k);
  if (known) return known;
  const { xy, free, tags } = walls.stored;
  const kind = (m: number) => walls.featureAt(m)?.feature.kind;
  const run = [k];
  const reach = 4 * PIECE_ROUNDING;
  for (let i = 0; i < run.length; i++) {
    const j = run[i]!;
    const ax = xy[4 * j]!;
    const ay = xy[4 * j + 1]!;
    const bx = xy[4 * j + 2]!;
    const by = xy[4 * j + 3]!;
    // Within twice the band of j's line: the cross product against j's heading, squared, so nothing here needs a square root.
    const len2 = (bx - ax) * (bx - ax) + (by - ay) * (by - ay);
    const along = (x: number, y: number) => {
      const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
      return len2 > 0 && cross * cross <= reach * reach * len2;
    };
    const near = (x: number, y: number, ex: number, ey: number) => Math.abs(x - ex) <= reach && Math.abs(y - ey) <= reach;
    for (const [ex, ey] of [
      [ax, ay],
      [bx, by],
    ] as const) {
      walls.storedIndex.query(ex - reach, ey - reach, ex + reach, ey + reach, MOVEMENT | LEDGE, (m) => {
        if (run.includes(m) || free[m] !== PIECE || tags[m] !== tags[j] || kind(m) !== kind(j) || kind(m) === "door") return;
        const [cx, cy, dx, dy] = [xy[4 * m]!, xy[4 * m + 1]!, xy[4 * m + 2]!, xy[4 * m + 3]!];
        if ((near(cx, cy, ex, ey) || near(dx, dy, ex, ey)) && along(cx, cy) && along(dx, dy)) run.push(m);
      });
    }
  }
  for (const m of run) runs.set(m, run);
  return run;
}

/**
 * How far rounding moves each end of a held build's piece, per coordinate:
 * half its band (walls.ts PIECE_BAND), written out since walls.ts loads
 * after this module.
 */
const PIECE_ROUNDING = 1 / 10_000;

/**
 * Whether a part heading (mx, my) leaves segment `k`, which the core
 * touches where the leg starts at P (section 4.1): it moves the center
 * away from the segment's line toward the side P is on, or either way when
 * P lies on the line. Exact for a stored segment. Each end of a held
 * build's piece lies up to PIECE_ROUNDING per coordinate off its exact
 * wall (5.2), so the side P is on and the way the part heads are known
 * only within bounds worked out from that: the gate lets the part go
 * where some exact wall the piece stands for would, and a preview only
 * where every one would (MD4-ASTRA-1).
 */
function leaves(walls: WallSet, k: number, test: PieceTest, px: number, py: number, mx: number, my: number): boolean {
  const xy = walls.stored.xy;
  const ax = xy[4 * k]!;
  const ay = xy[4 * k + 1]!;
  const bx = xy[4 * k + 2]!;
  const by = xy[4 * k + 3]!;
  if (walls.stored.free[k] !== PIECE) {
    const side = orient(ax, ay, bx, by, px, py);
    const toward = orient(0, 0, bx - ax, by - ay, mx, my);
    return toward !== 0 && (side === 0 || toward === side);
  }
  const dx = bx - ax;
  const dy = by - ay;
  // The exact wall's ends are A + a and B + b, each within PIECE_ROUNDING per coordinate, so its heading is off by up to twice that.
  const side = dx * (py - ay) - dy * (px - ax);
  const toward = dx * my - dy * mx;
  const r = PIECE_ROUNDING * (1 + 1e-9);
  const sideOff = r * (Math.abs(dx) + Math.abs(dy)) + 2 * r * (Math.abs(px - ax) + Math.abs(py - ay)) + 4 * r * r;
  const towardOff = 2 * r * (Math.abs(mx) + Math.abs(my));
  if (test === "gate") {
    if (Math.abs(side) <= sideOff) return mx !== 0 || my !== 0;
    return side > 0 ? toward + towardOff > 0 : toward - towardOff < 0;
  }
  if (Math.abs(toward) <= towardOff) return false;
  return toward > 0 ? side >= sideOff : side <= -sideOff;
}

/**
 * Section 4.1's leg test: the straight path, and for a core larger than a
 * point, when that is blocked, the shifted paths start, start + d1,
 * end + d2, end for every pair of the nine shifts. Every part of a shifted
 * path lies within half a cell of the straight one, so the segments that
 * could touch any of them are gathered once, with the core grown by half a
 * cell, and each part tests only those.
 */
function legClear(leg: Leg): boolean {
  const { px, py, qx, qy, hx, hy } = leg;
  if (px === qx && py === qy) return true;
  const point = hx === 0 && hy === 0;
  const pad = point ? 0 : 0.5;
  const segs = touching(leg.walls, px, py, qx, qy, hx + pad, hy + pad, leg.floor, leg.test);
  if (segs.length === 0) return true;
  const atStart = startSet(leg, segs);
  if (partClear(leg, segs, atStart, px, py, qx, qy, true)) return true;
  if (point) return false;
  const lastClear = SHIFTS.map(([dx, dy], j) => j === 0 || partClear(leg, segs, atStart, qx + dx, qy + dy, qx, qy, false));
  for (let i = 0; i < SHIFTS.length; i++) {
    const [d1x, d1y] = SHIFTS[i]!;
    const sx = px + d1x;
    const sy = py + d1y;
    if (i !== 0 && !partClear(leg, segs, atStart, px, py, sx, sy, true)) continue;
    for (let j = i === 0 ? 1 : 0; j < SHIFTS.length; j++) {
      if (!lastClear[j]) continue;
      const ex = qx + SHIFTS[j]![0];
      const ey = qy + SHIFTS[j]![1];
      if (sx === ex && sy === ey) {
        // No middle part: from the start straight to the shifted start, then to the end.
        if (i !== 0) return true;
        continue;
      }
      if (partClear(leg, segs, atStart, sx, sy, ex, ey, i === 0)) return true;
    }
  }
  return false;
}

function legOf(walls: WallSet, scene: Pick<Scene, "blockMovement">, token: MovingToken, to: LegEnd, test: PieceTest): Leg {
  const { w, h } = coreSize(token);
  const p = storedCenter(token);
  const q = storedCenter({ ...token, x: to.x, y: to.y });
  return { walls, px: p.x, py: p.y, qx: q.x, qy: q.y, hx: w / 2, hy: h / 2, floor: ledgeFloor(walls, scene, token, to.elevation), test };
}

/** What a walk's tests read of the holder it walks off, for what is kept per walker (MovingToken). */
export function offKey(token: MovingToken): string {
  const h = token.offHolder;
  return h ? `${h.size},${h.w},${h.h},${h.x},${h.y},${h.squeeze === true},${h.hex?.orient ?? ""}` : "";
}

/** Whether the token's full footprint, standing at `at`, shares area with the holder it walks off: on hexes, a hex (OffHolder). */
export function onOffHolder(token: MovingToken, at: Point): boolean {
  const holder = token.offHolder;
  if (!holder) return false;
  if (holder.hex) {
    const held = new Set(holderHexes(holder.hex, holder).map(hexKey));
    const { squeeze: _squeeze, ...full } = { ...token, x: at.x, y: at.y };
    return occupiedHexes(holder.hex, full).some((h) => held.has(hexKey(h)));
  }
  const a = footprintRect(SQUARES, { size: token.size, x: at.x, y: at.y, ...(token.w !== undefined ? { w: token.w } : {}), ...(token.h !== undefined ? { h: token.h } : {}) });
  const b = holderRect(holder);
  const EPS = 1e-9;
  return a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;
}

/** The hexes the holder stands on, its squeezed ones while it squeezes. */
function holderHexes(g: HexGrid, holder: OffHolder): Hex[] {
  return occupiedHexes(g, holder);
}

function holderRect(holder: OffHolder): { x: number; y: number; w: number; h: number } {
  return footprintRect(SQUARES, { size: holder.size, x: holder.x, y: holder.y, ...(holder.w !== undefined ? { w: holder.w } : {}), ...(holder.h !== undefined ? { h: holder.h } : {}), ...(holder.squeeze === true ? { squeeze: true } : {}) });
}

declare const stepping: unique symbol;

/**
 * A walker partway through its walk (review AT-ASTRA-22): the one state a
 * walk carries from stop to stop, which only `walkFrom` starts and only
 * `walkOn` takes on, so no part of it goes on in one place and not in
 * another. A walk is off its holder for good once a stop is clear of it
 * (`offHolder`, review AT-ASTRA-16), squeezed only on its first leg, and at
 * each stop at the height it takes there: the ground under its full
 * footprint for a walk that starts on the ground (`grounded`), else its
 * own. Its footing at a stop, which decides the ledges that stop its next
 * leg, follows from those.
 */
export type Walking = Walker & { readonly [stepping]: true; readonly grounded: boolean };

/**
 * The walk of `token` from where it stands: off its holder already where it
 * stands clear of it, squeezed as it stands, and on the ground for the whole
 * walk when it stands on it now. A walk off a holder on the ground that its
 * walker marks `groundStart` (rules/attach.ts walkerFor) starts on the
 * ground under its own footprint, not at its seat, so stepping off a holder
 * that straddles a step never counts the drop as distance, on a route or a
 * straight leg (review LP12-AT-4). Getting off a ride pays for that
 * already.
 */
export function walkFrom<T extends Walker>(chunks: Chunks, token: T): T & Walking {
  const grounded = footing(chunks, token) === "ground";
  const start = { ...token, grounded, ...(grounded && token.offHolder && token.groundStart ? { elevation: groundUnder(chunks, token, token) } : {}) } as T & Walking;
  return !start.offHolder || onOffHolder(start, start) ? start : pastHolder(start);
}

/**
 * The walk's one step: the walker at its next stop `to`, at the height the
 * walk takes there (`Walking`), or at `landing` where the walk ends there,
 * no longer squeezed, since a squeeze it starts in lasts for its first leg
 * only, and off the holder it walks off for good once it stands clear of
 * it. Every walk of more than one leg, a route's pieces and a redo's
 * routes, carries its walker from leg to leg by this.
 */
export function walkOn<T extends Walking>(chunks: Chunks, token: T, to: Point, landing?: number): T {
  const next: T = { ...token, x: to.x, y: to.y };
  delete next.squeeze;
  next.elevation = landing ?? (token.grounded ? groundUnder(chunks, next, to) : token.elevation);
  const out = !next.offHolder || onOffHolder(token, to) ? next : pastHolder(next);
  // On hexes a stop says by where it stands whether the walk squeezes there (hexStartStand), so the walker is marked as past its start.
  onward.add(out);
  return out;
}

/** The ground under a walker's footprint as its walk has it there, squeezed or not, standing at `at`. */
export function groundUnder(chunks: Chunks, walker: MovingToken, at: Point): number {
  return footprintGround(chunks, { ...walker, x: at.x, y: at.y });
}

/** The walker standing with `footing` where a leg of its walk starts (walkStates). */
function withFooting<T extends Walker>(token: T, footing: Standing): T {
  return { ...token, footing };
}

const STANDINGS: readonly Standing[] = ["ground", "flying", "inside"];

/**
 * Every walker a walk from `token` can have where its last leg starts, for
 * a judgment of its end whose route is not known, as a drag preview's
 * frame without corners (server/rooms/ephemeral.ts): where it starts, for a
 * straight leg, and past any stop as `walkOn` leaves it, on its holder or
 * past it, and for a walk that keeps its height at any footing, since the
 * ground under a later stop may be any.
 */
export function walkStates(chunks: Chunks, token: Walker): Walker[] {
  const start = walkFrom(chunks, token);
  const on = walkOn(chunks, start, start);
  const past = on.offHolder ? [on, pastHolder(on)] : [on];
  return [start, ...(start.grounded ? past : past.flatMap((w) => STANDINGS.map((f) => withFooting(w, f))))];
}

/** The token as a walk that has cleared the holder it walks off reads it: on the ground, off no holder. */
export function pastHolder<T extends Walker>(token: T): T {
  if (!token.offHolder) return token;
  const next: T = { ...token };
  delete next.offHolder;
  return next;
}

/**
 * Whether a walk of the token from where it stands has inner ledges of its
 * holder to cross (MovingToken): only then does a walk that leaves the
 * holder and comes back judge its steps there differently, so only then
 * does the route search keep the two apart (walk.ts WalkWorld `post`).
 */
export function crossesInnerLedges(state: BuildState, token: Walker): boolean {
  const scene = state.scenes[token.sceneId];
  if (!scene || scene.blockMovement !== true || !token.offHolder) return false;
  const walls = sceneWalls(scene, state.buildChunks);
  return wallsAt(walls, token, token) !== walls;
}

declare const ended: unique symbol;

/**
 * A spot a walk ends at, with its walker as the walk reaches it (review
 * AT-ASTRA-21): standing where the walk's last leg to the spot starts, its
 * state carried there from where it stood through every stop between
 * (`walkOn`). So a walk that cleared its holder and came back over it
 * judges the spot on the ground's rule, as its last leg does, and a walk
 * that started squeezed judges it full size from its first corner on
 * (review AT-ASTRA-22). Every check of a walk's end takes only this: the
 * squeeze (`squeezeFits`), a drag preview's footprint (`previewSqueezed`)
 * and the core's fit (`coreBlocked`). `walkEnd` makes one.
 */
export type WalkEnd = { readonly walker: Walker; readonly at: Point; readonly [ended]: true };

/**
 * The end at `at` of a walk by `token` from where it stands through
 * `corners`, the walk's stops after its start and before `at`, each at the
 * height the walk takes there (`walkOn`). A straight leg has none: it
 * leaves a rectangle once, so a spot of it on the holder was reached
 * before the walk cleared the holder.
 */
export function walkEnd(build: Pick<BuildState, "buildChunks">, token: Walker, at: Point, corners: readonly Point[] = []): WalkEnd {
  let walker = walkFrom(build.buildChunks, token);
  for (const corner of corners) walker = walkOn(build.buildChunks, walker, corner);
  return { walker, at: { x: at.x, y: at.y } } as unknown as WalkEnd;
}

/** `walkEnd` with no corners at many spots of one straight leg from where `token` stands, its walk worked out once. */
export function walkEnds(build: Pick<BuildState, "buildChunks">, token: Walker): (at: Point) => WalkEnd {
  const walker = walkFrom(build.buildChunks, token);
  return (at) => ({ walker, at: { x: at.x, y: at.y } }) as unknown as WalkEnd;
}

/**
 * The movement set for the token at `at` as a walk from where it stands
 * reaches it: the holder's inner ledges left out while the walk has not
 * cleared the holder (MovingToken). A straight leg leaves a rectangle once,
 * so a spot of a leg from a spot on the holder that is on the holder too
 * was reached before the walk cleared it. For a leg's own test, `at` is
 * where it starts.
 */
function wallsAt(walls: WallSet, token: MovingToken, at: Point): WallSet {
  const holder = token.offHolder;
  return holder && onOffHolder(token, token) && onOffHolder(token, at) ? walls.withoutLedgesInside(holderRect(holder)) : walls;
}

function legFrom(walls: WallSet, scene: Pick<Scene, "blockMovement">, token: MovingToken, to: LegEnd, test: PieceTest): Leg {
  return legOf(wallsAt(walls, token, token), scene, token, to, test);
}

/** What stopped a leg, and the door it was when a door edge or free door stopped it first. */
export type LegStop = { blocker: Blocker; door: DoorRef | null };

/**
 * What stops the token walking from where it stands to `to`, or null when
 * the leg is allowed (sections 4.1, 4.2). Walls, closed doors, windows and
 * pillars always count. Ledges count only on a scene with `blockMovement`
 * on, by where the token stands at the leg's start. When the leg is
 * stopped, the blocker the straight path meets first names it, a wall when
 * a wall and a ledge are met at once.
 */
export function legStop(state: BuildState, token: Walker, to: LegEnd): LegStop | null {
  const scene = state.scenes[token.sceneId];
  if (!scene) return null;
  const hex = hexWallsOf(state, token, to.elevation);
  if (hex) return hexLegStopOf(hex, token, to);
  const leg = legFrom(sceneWalls(scene, state.buildChunks), scene, token, to, pieceTestOf(state.buildChunks));
  if (legClear(leg)) return null;
  return firstStop(leg);
}

/**
 * Whether the straight path alone is clear, never a shifted one: the test
 * every step of a route takes (docs/design-v1-movement.md 5.1), the half
 * lattice holding the shifted spots itself. A route's piece made of such
 * steps passes `legStop` too, since its straight sweep is theirs joined.
 */
export function straightClear(state: BuildState, token: Walker, to: LegEnd): boolean {
  const scene = state.scenes[token.sceneId];
  if (!scene) return true;
  const hex = hexWallsOf(state, token, to.elevation);
  if (hex) return hexLegStopOf(hex, token, to) === null;
  const leg = legFrom(sceneWalls(scene, state.buildChunks), scene, token, to, pieceTestOf(state.buildChunks));
  const { px, py, qx, qy, hx, hy } = leg;
  if (px === qx && py === qy) return true;
  const segs = touching(leg.walls, px, py, qx, qy, hx, hy, leg.floor, leg.test);
  if (segs.length === 0) return true;
  const atStart = startSet(leg, segs);
  return partClear(leg, segs, atStart, px, py, qx, qy, true);
}

/**
 * `straightClear` as a route search asks it (docs/design-v1-movement.md 5.1):
 * the walls, the core and the ledges worked out once, and nothing allocated
 * per step, since a search asks up to a million steps. The ledges count as
 * for a leg from where the token stands, which a walk keeps all the way: a
 * walker on the ground is stopped by every ledge, a flier keeps its height.
 * A step from a spot on the holder a walk leaves passes the holder's inner
 * ledges (MovingToken), so a walk that has cleared the holder is tested by
 * a tester of its own, for the token off it (walk.ts WalkWorld `post`).
 */
export type StepTester = {
  walls: WallSet;
  /** Whether the core's straight sweep between two stored positions touches nothing it may not. */
  clear(ax: number, ay: number, bx: number, by: number): boolean;
  /** Whether the core fits at a stored position and blockers pinch the full footprint there, as a drag preview's squeeze is judged. */
  pinched(x: number, y: number): boolean;
};

export function stepTester(state: BuildState, token: Walker): StepTester | null {
  const scene = state.scenes[token.sceneId];
  if (!scene) return null;
  const walls = sceneWalls(scene, state.buildChunks);
  const test = pieceTestOf(state.buildChunks);
  const floor = ledgeFloor(walls, scene, token, token.elevation);
  // A step from a spot on the holder the walk has not yet cleared leaves out its inner ledges (MovingToken).
  const inner = wallsAt(walls, token, token);
  let set = walls;
  const { w, h } = footprintSize(token);
  const core = coreSize(token);
  const hx = core.w / 2;
  const hy = core.h / 2;
  const mask = MOVEMENT | (floor === Infinity ? 0 : LEDGE);
  const EPS = 1e-7;
  let px = 0;
  let py = 0;
  let qx = 0;
  let qy = 0;
  let hit = false;
  const visit = (k: number) => {
    if (hit || !blocksMove(set, k, floor)) return;
    if (!meets(set, k, test, px, py, qx, qy, hx, hy)) return;
    // partClear's first part: a segment the core touches where it starts may be left toward the start's side.
    const atStart = meets(set, k, test, px, py, px, py, hx, hy) || (test === "gate" && set.stored.free[k] === PIECE && pieceRun(set, k).some((j) => j !== k && meets(set, j, test, px, py, px, py, hx, hy)));
    if (atStart && leaves(set, k, test, px, py, qx - px, qy - py)) return;
    hit = true;
  };
  return {
    walls,
    clear(ax, ay, bx, by) {
      px = ax + w / 2;
      py = ay + h / 2;
      qx = bx + w / 2;
      qy = by + h / 2;
      if (px === qx && py === qy) return true;
      hit = false;
      set = inner !== walls && onOffHolder(token, { x: ax, y: ay }) ? inner : walls;
      set.storedIndex.query(Math.min(px, qx) - hx - EPS, Math.min(py, qy) - hy - EPS, Math.max(px, qx) + hx + EPS, Math.max(py, qy) + hy + EPS, mask, visit);
      return !hit;
    },
    pinched(x, y) {
      return squeezedThere(state, token, { x, y }, false);
    },
  };
}

/** Section 4.1's test as the core asks it (shared/ruleHooks.ts). */
export function legBlocker(state: BuildState, token: Walker, to: LegEnd): Blocker | null {
  return legStop(state, token, to)?.blocker ?? null;
}

/*
 * The first segment the straight path's core meets, by when along the leg
 * it meets it, worked out by clipping the path against the three slabs whose
 * meet is the segment grown by the core. Only names what stopped the leg, so
 * it needs no exact arithmetic: the leg is already known to be stopped.
 */
function firstStop(leg: Leg): LegStop {
  return stopBy(leg.walls, firstMet(leg));
}

/** The stop a met segment names, a wall where none was found. */
function stopBy(walls: WallSet, met: { k: number } | null): LegStop {
  if (!met) return { blocker: "wall", door: null };
  const wall = (walls.stored.tags[met.k]! & MOVEMENT) !== 0;
  const feature = walls.featureAt(met.k);
  return { blocker: wall ? "wall" : "ledge", door: wall && feature?.feature.kind === "door" ? feature.ref : null };
}

/** The segment `firstStop` names and when along the leg the core first meets it, or null when it finds none. */
function firstMet(leg: Leg): { k: number; t: number } | null {
  const { walls, px, py, qx, qy, hx, hy } = leg;
  const xy = walls.stored.xy;
  const segs = touching(walls, px, py, qx, qy, hx, hy, leg.floor, leg.test);
  const atStart = startSet(leg, segs);
  let best = -1;
  let bestT = Infinity;
  const dx = qx - px;
  const dy = qy - py;
  for (const k of segs) {
    if (!partClear(leg, [k], atStart, px, py, qx, qy, true)) {
      const ax = xy[4 * k]!;
      const ay = xy[4 * k + 1]!;
      const bx = xy[4 * k + 2]!;
      const by = xy[4 * k + 3]!;
      const ex = bx - ax;
      const ey = by - ay;
      const r = hx * Math.abs(ey) + hy * Math.abs(ex);
      const m = ax * -ey + ay * ex;
      let t0 = 0;
      let t1 = 1;
      for (const [v0, dv, lo, hi] of [
        [px, dx, Math.min(ax, bx) - hx, Math.max(ax, bx) + hx],
        [py, dy, Math.min(ay, by) - hy, Math.max(ay, by) + hy],
        [px * -ey + py * ex, dx * -ey + dy * ex, m - r, m + r],
      ] as const) {
        if (dv === 0) continue;
        const ta = (lo - v0) / dv;
        const tb = (hi - v0) / dv;
        t0 = Math.max(t0, Math.min(ta, tb));
        t1 = Math.min(t1, Math.max(ta, tb));
      }
      const t = t0 <= t1 ? t0 : 1;
      const wall = (walls.stored.tags[k]! & MOVEMENT) !== 0;
      if (t < bestT || (t === bestT && wall && best >= 0 && (walls.stored.tags[best]! & MOVEMENT) === 0)) {
        best = k;
        bestT = t;
      }
    }
  }
  return best < 0 ? null : { k: best, t: bestT };
}

/** A segment by its ends, in cells. */
export type Part = readonly [number, number, number, number];

/**
 * What stops the token walking from where it stands to `to`, as `legStop`
 * names it, with the part of that blocker the core meets first: the
 * blocker clipped to the core where the straight path first reaches it, a
 * hair past included, or the whole blocker where the clip finds none.
 * Null when the leg is allowed. The words of a stop name a kind only where
 * this part lies on the player's live ground (permissions.ts stopWords,
 * D-261027-04), so they speak of the very blocker that stopped the walk.
 */
export function legStopPart(state: BuildState, token: Walker, to: LegEnd): { stop: LegStop; part: Part | null } | null {
  const scene = state.scenes[token.sceneId];
  if (!scene) return null;
  const hex = hexWallsOf(state, token, to.elevation);
  if (hex) return hexLegStopPart(hex, token, to);
  const leg = legFrom(sceneWalls(scene, state.buildChunks), scene, token, to, pieceTestOf(state.buildChunks));
  if (legClear(leg)) return null;
  const met = firstMet(leg);
  const stop = stopBy(leg.walls, met);
  if (!met) return { stop, part: null };
  const xy = leg.walls.stored.xy;
  const seg: Part = [xy[4 * met.k]!, xy[4 * met.k + 1]!, xy[4 * met.k + 2]!, xy[4 * met.k + 3]!];
  const cx = leg.px + (leg.qx - leg.px) * met.t;
  const cy = leg.py + (leg.qy - leg.py) * met.t;
  const E = 1e-6;
  return { stop, part: clipToBox(seg, cx - leg.hx - E, cy - leg.hy - E, cx + leg.hx + E, cy + leg.hy + E) ?? seg };
}

/* A segment clipped to a closed box (Liang and Barsky), or null when it misses the box. */
function clipToBox([ax, ay, bx, by]: Part, x0: number, y0: number, x1: number, y1: number): Part | null {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  for (const [p, q] of [
    [-dx, ax - x0],
    [dx, x1 - ax],
    [-dy, ay - y0],
    [dy, y1 - ay],
  ] as const) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    if (t0 > t1) return null;
  }
  return [ax + dx * t0, ay + dy * t0, ax + dx * t1, ay + dy * t1];
}

// ---------------------------------------------------------------------------
// Standing and squeezing

/*
 * The movement set at a spot is the one the token's leg there would be
 * judged by: ledges count by where the token stands now (its own position
 * and elevation), as for the leg's start (section 4.2).
 */
function coreTouchesAt(walls: WallSet, token: MovingToken, at: Point, floor: number, test: PieceTest): boolean {
  const c = storedCenter({ ...token, x: at.x, y: at.y });
  const { w, h } = coreSize(token);
  return touching(walls, c.x, c.y, c.x, c.y, w / 2, h / 2, floor, test).length > 0;
}

/** Whether the walker's core, at the stored position its walk ends at, touches the movement set, so no leg may end there. */
export function coreBlocked(state: BuildState, end: WalkEnd): boolean {
  const { walker: token, at } = end;
  const scene = state.scenes[token.sceneId];
  if (!scene) return false;
  const hex = hexWallsOf(state, token);
  if (hex) return hexFitWall(hex, hexEndStand(hex.g, token, at)) >= 0;
  const walls = sceneWalls(scene, state.buildChunks);
  return coreTouchesAt(wallsAt(walls, token, at), token, at, ledgeFloor(walls, scene, token, token.elevation), pieceTestOf(state.buildChunks));
}

// ---------------------------------------------------------------------------
// Resizing

/*
 * A resize on a scene that blocks moves is judged by two of the move rules'
 * own tests (docs/design-v1-token-window.md 8.3), so a resize and the next
 * move always agree on where a creature may stand. `token` is the creature
 * as it stands now and `to` its footprint at the new size and spot. Ledges
 * count by where it stands now, at its elevation, as for a move's start.
 */

/** Standing: the new size's core at the new spot touches no movement blocker, the test a move ends on. */
export function resizeStands(state: BuildState, token: MovingToken, to: PlacedToken): boolean {
  const scene = state.scenes[token.sceneId];
  if (!scene) return true;
  const hex = hexWallsOf(state, token);
  if (hex) return hexFitWall(hex, hexStandAt(hex.g, to, to, isSqueezed(to))) < 0;
  const walls = sceneWalls(scene, state.buildChunks);
  const c = storedCenter(to);
  const { w, h } = coreSize(to);
  return touching(walls, c.x, c.y, c.x, c.y, w / 2, h / 2, ledgeFloor(walls, scene, token, token.elevation), pieceTestOf(state.buildChunks)).length === 0;
}

/**
 * Not crossing: what stops the new size's core swept along the leg from the
 * token's middle now to the new spot's middle, or null when the leg is
 * clear. It is a move's leg with a core of the new size, so a wall that core
 * already touches at the middle now may be left toward the middle's side
 * and never crossed (partClear), and a resize that keeps the middle passes.
 */
export function resizeLegStop(state: BuildState, token: MovingToken, to: PlacedToken): Blocker | null {
  const scene = state.scenes[token.sceneId];
  if (!scene) return null;
  const hex = hexWallsOf(state, token);
  if (hex) return hexResizeStop(hex, token, to);
  const walls = sceneWalls(scene, state.buildChunks);
  const p = storedCenter(token);
  const q = storedCenter(to);
  const { w, h } = coreSize(to);
  const leg: Leg = { walls, px: p.x, py: p.y, qx: q.x, qy: q.y, hx: w / 2, hy: h / 2, floor: ledgeFloor(walls, scene, token, token.elevation), test: pieceTestOf(state.buildChunks) };
  return legClear(leg) ? null : firstStop(leg).blocker;
}

/*
 * Checks 1, 3 and 4 of section 4.1's squeeze at `at`: a side of at least 2
 * cells, a core touching no blocker, and a real narrow space, where the
 * movement set pinches the creature along an axis its squeeze shrinks. A
 * committed squeeze (`fit`) also needs the squeezed footprint to fit between
 * the walls, no blocker passing through it. A drag preview's point is
 * unsnapped, so its squeezed footprint may overlap a corridor's wall by a
 * hair, and the core fitting is enough there.
 */
function squeezedThere(state: BuildState, token: Walker, at: Point, fit: boolean): boolean {
  if (!canSqueeze(token)) return false;
  const scene = state.scenes[token.sceneId];
  if (!scene) return false;
  const all = sceneWalls(scene, state.buildChunks);
  const floor = ledgeFloor(all, scene, token, token.elevation);
  const walls = wallsAt(all, token, at);
  if (coreTouchesAt(walls, token, at, floor, pieceTestOf(state.buildChunks))) return false;
  const c = storedCenter({ ...token, x: at.x, y: at.y });
  const { w, h } = footprintSize(token);
  const squeezed = squeezedSize(token);
  const sq = { x0: c.x - squeezed.w / 2, y0: c.y - squeezed.h / 2, x1: c.x + squeezed.w / 2, y1: c.y + squeezed.h / 2 };
  const xy = walls.stored.xy;
  const test = pieceTestOf(state.buildChunks);
  // Gathered by the band, which takes in every piece that can meet the footprint, then judged by the build's test.
  const near = touching(walls, c.x, c.y, c.x, c.y, w / 2, h / 2, floor, "preview");
  const segs = near.map((k) => [xy[4 * k]!, xy[4 * k + 1]!, xy[4 * k + 2]!, xy[4 * k + 3]!] as const);
  const pieces = near.map((k) => walls.stored.free[k] === PIECE);
  // For the gate a piece passes through the squeezed footprint only more than its band inside it (MD4-LK-3). A preview reads it as
  // it is, so a corridor of free walls, whose pieces lie along the footprint's sides, still draws the squeeze the drop makes.
  const inset = test === "gate" ? PIECE_BAND * (1 + 1e-9) : 0;
  const through = (s: (typeof segs)[number], piece: boolean) => (piece ? crossesInterior(sq.x0 + inset, sq.y0 + inset, sq.x1 - inset, sq.y1 - inset, ...s) : crossesInterior(sq.x0, sq.y0, sq.x1, sq.y1, ...s));
  if (fit && segs.some((s, i) => through(s, pieces[i]!))) return false;
  const core = coreSize(token);
  const coreBox = { x0: c.x - core.w / 2, y0: c.y - core.h / 2, x1: c.x + core.w / 2, y1: c.y + core.h / 2 };
  return pinches(segs, { x0: at.x, y0: at.y, x1: at.x + w, y1: at.y + h }, coreBox, sq, w >= 2, h >= 2, test === "gate" ? pieces : []);
}

/**
 * Section 4.1's four checks for a move that stops the token squeezed at
 * `at`, its stored position: a side of at least 2 cells, the squeezed
 * footprint on cell boundaries, a real narrow space (walls, or ledges for a
 * token they stop, on both sides of the squeezed footprint along an axis it
 * shrinks, inside the full footprint, with the squeezed footprint fitting
 * between them), and a core touching no blocker. So the flag marks only a
 * real squeeze: a corridor or a door frame, never open ground beside one
 * wall. The walker stands where the walk's last leg to the spot starts
 * (`WalkEnd`): where it stands then decides which ledges count, as for
 * that leg.
 */
export function squeezeFits(state: BuildState, end: WalkEnd): boolean {
  const { walker: token, at } = end;
  if (!canSqueeze(token)) return false;
  const hex = hexWallsOf(state, token);
  if (hex) {
    const s = squeezedStandAt(hex.g, token, at);
    return s !== null && hexNarrow(hex, token, s);
  }
  const c = storedCenter({ ...token, x: at.x, y: at.y });
  const { w, h } = squeezedSize(token);
  for (const edge of [c.x - w / 2, c.x + w / 2, c.y - h / 2, c.y + h / 2]) if (!Number.isInteger(edge)) return false;
  return squeezedThere(state, token, at, true);
}

/**
 * The server's looser rule for a drag preview at an unsnapped point
 * (section 4.1, "Drag previews"): checks 1, 3 and 4 without cell alignment,
 * the narrow space judged around the squeezed footprint centered there.
 * When it holds, the frame is judged by the squeezed footprint centered on
 * the preview point (`footprintRect({ ...token, x, y, squeeze: true })`),
 * else by the full one. The walker is the walk's at the preview point
 * (`WalkEnd`).
 */
export function previewSqueezed(state: BuildState, end: WalkEnd): boolean {
  const hex = hexWallsOf(state, end.walker);
  if (hex) {
    // A preview point on hexes reads at the anchors nearest it, as every rule reads a creature standing there.
    const s = squeezedStandAt(hex.g, end.walker, end.at);
    return s !== null && hexNarrow(hex, end.walker, s);
  }
  return squeezedThere(state, end.walker, end.at, false);
}

// ---------------------------------------------------------------------------
// Where a drop lands

/** Where a drop puts the token: its stored position, whether it squeezes there, and, when the walk stopped short, what stopped it. */
export type Landing = { x: number; y: number; squeeze: boolean; stopped: LegStop | null };

/**
 * How a drop is judged: "walk" for a player's move on a scene whose walls
 * stop moves (stopped at the last clear spot), "free" for the DM and for
 * scenes that stop nothing (never stopped), "teleport" for "Teleport here"
 * (no leg at all).
 */
export type DropMode = "walk" | "free" | "teleport";

/**
 * Where a drag or drop of `token` toward `to` lands (section 4.1), the
 * first of these that applies:
 * - `to` itself, when walking there is allowed, or, not walking, when the
 *   core fits there, squeezing when the four checks hold there.
 * - For a creature that can squeeze whose core at `to` touches a blocker,
 *   the first of the nine half-cell shifts of `to` where the core fits, the
 *   leg is allowed (unless teleporting) and a squeeze is allowed.
 * - Walking, the last clear spot before what is in the way (the start when
 *   it is stopped at its very first step), with what stopped it.
 * - Otherwise `to`, unsqueezed.
 *
 * Elevation is the caller's: a landing writes the ground (section 4.2,
 * heights.ts), and `to.elevation` is only read for a flier's ledges.
 */
export function landing(state: BuildState, token: Walker, to: LegEnd, mode: DropMode): Landing {
  const scene = state.scenes[token.sceneId];
  if (!scene) return { x: to.x, y: to.y, squeeze: false, stopped: null };
  const hex = hexWallsOf(state, token, to.elevation);
  if (hex) return hexLanding(hex, token, to, mode);
  const walls = sceneWalls(scene, state.buildChunks);
  const test = pieceTestOf(state.buildChunks);
  const legTo = (at: Point) => legFrom(walls, scene, token, { x: at.x, y: at.y, elevation: to.elevation }, test);
  const floor = ledgeFloor(walls, scene, token, to.elevation);
  // A spot is judged as the straight leg's end (WalkEnd).
  const fits = (at: Point) => !coreTouchesAt(wallsAt(walls, walkEnd(state, token, at).walker, at), token, at, floor, test);
  const allowed = (at: Point) => mode === "teleport" || legClear(legTo(at));
  const squeeze = (at: Point) => squeezeFits(state, walkEnd(state, token, at));
  if (mode === "walk" ? allowed(to) : fits(to)) return { x: to.x, y: to.y, squeeze: squeeze(to), stopped: null };
  if (canSqueeze(token) && !fits(to)) {
    for (const [dx, dy] of SHIFTS) {
      const at = { x: to.x + dx, y: to.y + dy };
      if (fits(at) && allowed(at) && squeeze(at)) return { x: at.x, y: at.y, squeeze: true, stopped: null };
    }
  }
  if (mode !== "walk") return { x: to.x, y: to.y, squeeze: false, stopped: null };
  const spot = lastClearSpot(token, to, (at) => legClear(legTo(at)));
  return { x: spot.x, y: spot.y, squeeze: squeeze(spot), stopped: firstStop(legTo(to)) };
}

/*
 * The spots along the leg, the token's position stepped toward `to` on its
 * own snap grid from where it starts (so a creature squeezed half a cell
 * off the grid keeps its offset along a corridor), ending at `to`. Assuming
 * the allowed ones come first, which holds unless an opening only a shifted
 * path passes lies between, gallop and then bisect to the last allowed one,
 * so a long leg costs a few leg tests. Every answer is a spot whose leg is
 * allowed, the start when none is.
 */
export function lastClearSpot(token: MovingToken, to: Point, allowed: (at: Point) => boolean): Point {
  const spots = legSpots(token, to);
  let lo = 0;
  let hi = spots.length - 1;
  for (let probe = 1; probe < hi; probe *= 2) {
    if (allowed(spots[probe]!)) lo = probe;
    else {
      hi = probe;
      break;
    }
  }
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (allowed(spots[mid]!)) lo = mid;
    else hi = mid;
  }
  return spots[lo]!;
}

/** The spots along a leg, as `lastClearSpot` steps them: the start first and `to` last. */
export function legSpots(token: MovingToken, to: Point): Point[] {
  const step = snapStep(token);
  const dx = to.x - token.x;
  const dy = to.y - token.y;
  const n = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / step);
  const spots: Point[] = [{ x: token.x, y: token.y }];
  const snap = (v: number) => Math.round(v / step) * step + 0;
  for (let k = 1; k < n; k++) {
    const s = { x: token.x + snap((dx * k) / n), y: token.y + snap((dy * k) / n) };
    const last = spots[spots.length - 1]!;
    if (s.x !== last.x || s.y !== last.y) spots.push(s);
  }
  spots.push({ x: to.x, y: to.y });
  return spots;
}

// ---------------------------------------------------------------------------
// Reaching a door

/**
 * Whether the straight line from the token's footprint center to `to`, a
 * door's midpoint, meets no movement blocker other than that door: the
 * clear line reaching a door needs (section 4.1). Touching a blocker counts,
 * except a blocker that meets the line only at the door's midpoint itself.
 * Ledges count as for a move from where it stands, by its own footing.
 */
export function lineClear(state: BuildState, token: MovingToken, to: Point, door: DoorRef): boolean {
  const scene = state.scenes[token.sceneId];
  if (!scene) return false;
  const walls = sceneWalls(scene, state.buildChunks);
  const r = footprintRect(sceneGrid(scene), token);
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const floor = ledgeFloor(walls, scene, token, token.elevation);
  const xy = walls.stored.xy;
  for (const k of touching(walls, cx, cy, to.x, to.y, 0, 0, floor, pieceTestOf(state.buildChunks))) {
    const ref = walls.featureAt(k)?.ref;
    if (ref && sameDoor(ref, door)) continue;
    const ax = xy[4 * k]!;
    const ay = xy[4 * k + 1]!;
    const bx = xy[4 * k + 2]!;
    const by = xy[4 * k + 3]!;
    if (onSegment(to.x, to.y, ax, ay, bx, by) && meetsOnlyAtEnd(cx, cy, to.x, to.y, ax, ay, bx, by)) continue;
    return false;
  }
  return true;
}

function sameDoor(a: DoorRef, b: DoorRef): boolean {
  if ("edge" in a) return "edge" in b && a.edge === b.edge;
  return !("edge" in b) && a.cx === b.cx && a.cy === b.cy && a.id === b.id;
}

/* Whether a segment through Q meets the segment from C to Q at Q alone: it crosses the line there, or lies along it only beyond Q. */
function meetsOnlyAtEnd(cx: number, cy: number, qx: number, qy: number, ax: number, ay: number, bx: number, by: number): boolean {
  if (orient(ax, ay, bx, by, cx, cy) !== 0) return true;
  // Along the line: the segment must not reach back from Q toward C.
  const along = (x: number, y: number) => (x - qx) * (cx - qx) + (y - qy) * (cy - qy);
  return along(ax, ay) <= 0 && along(bx, by) <= 0;
}

// ---------------------------------------------------------------------------
// Hexes (docs/design-v1-hex-grids.md HX-D8 and HX-D17)

/*
 * On a hex scene a creature walks from anchor to anchor, its reference hex
 * one step to a neighbor at a time, and the movement set is the scene's
 * free walls, doors and windows (HX-D7). A step is allowed when the
 * straight step of every hex's center to the next hex's center meets no
 * movement wall, touching counting as on squares, and at its end no
 * movement wall meets the line between two neighboring hexes of the
 * footprint (HX-D8). Both tests ask one thing of the hex lattice, whether
 * the segment between two neighboring centers meets a movement wall, so a
 * route search caches it per hex and direction (hexWalk.ts).
 *
 * A squeezing creature takes the hexes of the size one smaller, on that
 * size's anchors (HX-D17, footprint.ts hexStandSize). Those lattices never
 * meet the creature's own, so a stop of a route says by where it stands
 * whether it squeezes there (`onSqueezedLattice`). A walker as it stands
 * says it by its flag. A leg between a full stand and a squeezed one walks
 * squeezed: the creature squeezes in place where the leg starts, or stands
 * up in place where it ends, the squeezed hexes of a reference hex always
 * lying among the full size's hexes of that hex.
 */

/** A creature on hexes: the size whose hexes it takes (one smaller while it squeezes) and that size's reference hex. */
export type HexStand = { size: SizeCategory; ref: Hex; squeezed: boolean };

/** The walkers a walk carries past its first stop (`walkOn`), whose squeeze on hexes is where they stand rather than a flag. */
const onward = new WeakSet<object>();

/** The scene's grid when it is hexes, else null. */
export function hexGridOf(state: BuildState, token: Pick<Token, "sceneId">): HexGrid | null {
  const scene = state.scenes[token.sceneId];
  if (!scene) return null;
  const g = sceneGrid(scene);
  return isHex(g) ? g : null;
}

/** The stand at stored position `at`, squeezed when asked and the creature can squeeze. */
export function hexStandAt(g: HexGrid, token: PlacedToken, at: Point, squeezed: boolean): HexStand {
  const full = sizeCategory(token);
  const small = squeezed && canSqueeze(token) ? hexSqueezedSize(full) : null;
  const size = small ?? full;
  const c = storedCenter({ ...token, x: at.x, y: at.y });
  return { size, ref: referenceHex(g, size, snapAnchor(g, size, c)), squeezed: small !== null };
}

/**
 * Whether stored position `at` stands on the squeezed size's anchors: the
 * box's middle nearer one of those than one of the creature's own. The
 * two lattices lie at least a corner's distance from a center apart, so
 * rounding never moves a stop from one to the other.
 */
export function onSqueezedLattice(g: HexGrid, token: PlacedToken, at: Point): boolean {
  if (!canSqueeze(token)) return false;
  const full = sizeCategory(token);
  const small = hexSqueezedSize(full);
  if (!small) return false;
  const c = storedCenter({ ...token, x: at.x, y: at.y });
  const a = snapAnchor(g, small, c);
  const b = snapAnchor(g, full, c);
  return (a.x - c.x) * (a.x - c.x) + (a.y - c.y) * (a.y - c.y) < (b.x - c.x) * (b.x - c.x) + (b.y - c.y) * (b.y - c.y);
}

/** The stand a walker starts a leg in: by its flag where it stands, and past its walk's first stop by where that stop is. */
export function hexStartStand(g: HexGrid, walker: PlacedToken): HexStand {
  const squeezed = onward.has(walker) ? onSqueezedLattice(g, walker, walker) : isSqueezed(walker);
  return hexStandAt(g, walker, walker, squeezed);
}

/** The stand a leg ends in at `to`: squeezed where `to` is one of the squeezed size's spots. */
export function hexEndStand(g: HexGrid, walker: PlacedToken, to: Point): HexStand {
  return hexStandAt(g, walker, to, onSqueezedLattice(g, walker, to));
}

/** Where a creature's stored box stands for a stand: its middle on the stand's anchor. */
export function hexStandPlace(g: HexGrid, token: PlacedToken, stand: HexStand): Point {
  const a = anchorOfHex(g, stand.size, stand.ref);
  const { w, h } = footprintSize(token);
  return { x: a.x - w / 2 + 0, y: a.y - h / 2 + 0 };
}

/** The hexes a stand takes, its reference hex first. */
export function hexStandHexes(g: HexGrid, stand: Pick<HexStand, "size" | "ref">): Hex[] {
  return footprintHexes(g, stand.size, anchorOfHex(g, stand.size, stand.ref));
}

/** The stand at the same reference hex, squeezed or full: a squeeze in place, or standing up in place. */
export function hexRestand(token: PlacedToken, stand: HexStand, squeezed: boolean): HexStand {
  const full = sizeCategory(token);
  const size = squeezed ? (hexSqueezedSize(full) ?? full) : full;
  return { size, ref: stand.ref, squeezed: size !== full };
}

/** The direction, 0 to 5 in hexNeighbors' order, from a hex to a neighbor, or -1 when they are not neighbors. */
export function hexDirection(g: HexGrid, from: Hex, to: Hex): number {
  return hexNeighbors(g, from).findIndex((n) => n.col === to.col && n.row === to.row);
}

/**
 * What the hex tests read of a scene: its grid, bounds and movement set,
 * the build's test of held pieces, the lowest top of a ledge that stops
 * the walker (`ledgeFloor`, Infinity where none does), and whether a
 * stand may hold a stair band's zigzag side (`hexPairWall`), which a
 * build an op stored before version 30 reads says not (`storedBuild`).
 */
export type HexWalls = { g: HexGrid; bounds: { w: number; h: number }; walls: WallSet; test: PieceTest; floor: number; bands: boolean };

/**
 * The build as an op stored at `opVersion` reads it on replay: the state
 * itself for today's rules, and for an op stored before version 30 its
 * scenes and build marked so a stand on hexes reads every raised side
 * between two of its hexes as a wall (migrate.ts standsAcrossBands), as
 * the op was written under. The reducer reads a hex stand through it
 * wherever it judges one: a trap's stop (traps.ts) and a dragged
 * creature's own leg (moveLeg.ts).
 */
export function storedBuild<T extends BuildState>(state: T, opVersion: number | undefined): T | BuildState {
  return standsAcrossBands(opVersion) ? state : { scenes: state.scenes, buildChunks: state.buildChunks, ledgedBands: true };
}

/**
 * The hex tests' view of the walker's scene, or null when it is not a hex
 * scene. Ledges stop it by how it stands where it starts and, flying, by
 * the lower of its start and `endElevation`, as a leg on squares reads
 * them (`legFrom`).
 */
export function hexWallsOf(state: BuildState, token: MovingToken, endElevation = token.elevation): HexWalls | null {
  const scene = state.scenes[token.sceneId];
  const g = scene ? sceneGrid(scene) : SQUARES;
  if (!scene || !isHex(g)) return null;
  const walls = sceneWalls(scene, state.buildChunks);
  // A walk off a holder that has not yet cleared it crosses the raised sides between the holder's hexes (OffHolder), as `wallsAt` leaves out the ledges inside it on squares.
  const holder = token.offHolder;
  const moves = holder?.hex && onOffHolder(token, token) ? walls.withoutLedgesBetween(holderHexes(holder.hex, holder)) : walls;
  return { g, bounds: scene.bounds, walls: moves, test: pieceTestOf(state.buildChunks), floor: ledgeFloor(walls, scene, token, endElevation), bands: state.ledgedBands !== true };
}

/**
 * The movement walls the segment from hex `h`'s center to its neighbor's
 * in direction `d` meets, touching included, and from phase H3 the ledges
 * above the walker's floor: a raised side between the two hexes is one
 * the step crosses at its middle, and touches no other.
 */
export function hexEdgeMeets(t: HexWalls, h: Hex, d: number): number[] {
  const a = hexCenter(t.g, h);
  const b = hexCenter(t.g, hexNeighbors(t.g, h)[d]!);
  return touching(t.walls, a.x, a.y, b.x, b.y, 0, 0, t.floor, t.test);
}

/**
 * The wall that stops stand `s` stepping in direction `d` (HX-D8), or -1:
 * the first a hex's step meets. On a leg's first step a wall the hex's
 * center touches where it starts may be left toward the center's side, as
 * a core leaves a wall it overlaps on squares (section 4.1), so a creature
 * a wall runs through can step off it but never across it.
 */
export function hexStepWall(t: HexWalls, s: Pick<HexStand, "size" | "ref">, d: number, first: boolean): number {
  for (const h of hexStandHexes(t.g, s)) {
    const segs = hexEdgeMeets(t, h, d);
    if (segs.length === 0) continue;
    const c = hexCenter(t.g, h);
    const n = hexCenter(t.g, hexNeighbors(t.g, h)[d]!);
    for (const k of segs) {
      if (first && meets(t.walls, k, t.test, c.x, c.y, c.x, c.y, 0, 0) && leaves(t.walls, k, t.test, c.x, c.y, n.x - c.x, n.y - c.y)) continue;
      return k;
    }
  }
  return -1;
}

/**
 * The wall that meets the line between two neighboring hexes of a stand
 * (HX-D8), or -1 when its footprint fits there: a single hex always fits.
 * Each pair is read once, from the hex whose step east, south-east or
 * south-west (on hex rows) reaches the other.
 */
export function hexFitWall(t: HexWalls, s: Pick<HexStand, "size" | "ref">): number {
  const hexes = hexStandHexes(t.g, s);
  if (hexes.length === 1) return -1;
  const keys = new Set(hexes.map((h) => `${h.col},${h.row}`));
  for (const h of hexes) {
    const around = hexNeighbors(t.g, h);
    for (let d = 0; d < 3; d++) {
      const n = around[d]!;
      if (!keys.has(`${n.col},${n.row}`)) continue;
      const k = hexPairWall(t, h, d);
      if (k >= 0) return k;
    }
  }
  return -1;
}

/**
 * The wall or ledge between hex `h` and its neighbor in direction `d` that
 * keeps a stand from holding both, or -1. Where two stairs side by side
 * face the same way, a stair band, the band's edge zigzags between hexes,
 * so a raised side between a stair and the hex its neighbor flight leads
 * to lies between the band's own flights, a side no stair faces through.
 * From op version 30 such a side, a ledge and nothing else, is no wall
 * inside a stand (D-261029-58), as a square creature stands across a
 * stair's edge: so a Large creature, or a Huge one squeezed onto three
 * hexes, walks a stair band two hexes wide that a Medium one walks. Every
 * other raised side stays one, a cliff beside a lone stair included.
 */
export function hexPairWall(t: HexWalls, h: Hex, d: number): number {
  const segs = hexEdgeMeets(t, h, d);
  if (segs.length === 0) return -1;
  if (t.bands && segs.every((k) => (t.walls.stored.tags[k]! & MOVEMENT) === 0)) {
    const n = hexNeighbors(t.g, h)[d]!;
    if (besideFlight(t, h, n) || besideFlight(t, n, h)) return -1;
  }
  return segs[0]!;
}

/** Whether stair hex `s` has a neighbor stair on its ground facing its way whose flight runs up or down to `x`. */
function besideFlight(t: HexWalls, s: Hex, x: Hex): boolean {
  const facing = t.walls.stairAt(s.col, s.row);
  if (facing === undefined || facing === null) return false;
  const up = Number(facing);
  const down = oppositeFacing(t.g, up);
  const ground = t.walls.groundAt(s.col, s.row);
  for (const c of hexNeighbors(t.g, s)) {
    if ((c.col === x.col && c.row === x.row) || t.walls.stairAt(c.col, c.row) !== facing || t.walls.groundAt(c.col, c.row) !== ground) continue;
    const around = hexNeighbors(t.g, c);
    for (const e of [around[up]!, around[down]!]) if (e.col === x.col && e.row === x.row) return true;
  }
  return false;
}

/** Whether every hex of a stand lies inside the scene (4.2). */
export function hexStandInside(t: Pick<HexWalls, "g" | "bounds">, s: Pick<HexStand, "size" | "ref">): boolean {
  return hexStandHexes(t.g, s).every((h) => hexInScene(t.g, t.bounds, h));
}

/**
 * Whether a squeezed stand is a real narrow space (HX-D17, the narrow
 * space test on hexes): its own hexes fit and lie inside the scene, and
 * no full footprint holding them does. So a Large creature beside a wall
 * in open ground never squeezes, since the full footprint fits there.
 */
export function hexNarrow(t: HexWalls, token: PlacedToken, s: HexStand): boolean {
  if (!s.squeezed || !hexStandInside(t, s) || hexFitWall(t, s) >= 0) return false;
  const full = sizeCategory(token);
  const inner = hexStandHexes(t.g, s);
  const keys = inner.map((h) => `${h.col},${h.row}`);
  // A full footprint holding these takes their reference hex, so its own reference hex lies within two steps of it.
  const seen = new Set<string>();
  for (const near of [s.ref, ...hexNeighbors(t.g, s.ref), ...hexNeighbors(t.g, s.ref).flatMap((h) => hexNeighbors(t.g, h))]) {
    const key = `${near.col},${near.row}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const holder: HexStand = { size: full, ref: near, squeezed: false };
    const around = new Set(hexStandHexes(t.g, holder).map((h) => `${h.col},${h.row}`));
    if (!keys.every((k) => around.has(k))) continue;
    if (hexStandInside(t, holder) && hexFitWall(t, holder) < 0) return false;
  }
  return true;
}

/** A leg on hexes: the hex line between its ends' reference hexes, walked at the size it squeezes at when either end squeezes. */
export type HexLeg = { from: HexStand; to: HexStand; walk: SizeCategory; squeezed: boolean; line: Hex[] };

export function hexLegOf(g: HexGrid, from: HexStand, to: HexStand): HexLeg {
  const squeezed = from.squeezed || to.squeezed;
  const walk = from.squeezed ? from.size : to.squeezed ? to.size : from.size;
  return { from, to, walk, squeezed, line: hexLine(g, from.ref, to.ref) };
}

/** Where a hex leg stops: the step `step` (0 for the first) that a wall stops, or the last step's end when the footprint does not fit there, and the wall. */
export type HexLegStop = { step: number; k: number };

/**
 * What stops a hex leg (HX-D8), or null when it is allowed: each step
 * clear, and the footprint fitting at each step's end and where the leg
 * ends, at the size it ends at. A leg that changes only the squeeze, in
 * place, is judged by its end alone.
 */
export function hexLegStop(t: HexWalls, leg: HexLeg): HexLegStop | null {
  const { line } = leg;
  // A leg that moves nothing crosses nothing, as on squares, wherever the creature stands.
  if (line.length === 1 && leg.from.size === leg.to.size) return null;
  for (let i = 0; i + 1 < line.length; i++) {
    const d = hexDirection(t.g, line[i]!, line[i + 1]!);
    const at = { size: leg.walk, ref: line[i]! };
    const k = hexStepWall(t, at, d, i === 0);
    if (k >= 0) return { step: i, k };
    const end = { size: leg.walk, ref: line[i + 1]! };
    const fit = hexFitWall(t, end);
    if (fit >= 0) return { step: i, k: fit };
  }
  const fit = hexFitWall(t, leg.to);
  return fit >= 0 ? { step: Math.max(0, line.length - 2), k: fit } : null;
}

/** The stand at step `k` of a hex leg, 0 its start and the line's last its end. */
export function hexLegStand(leg: HexLeg, k: number): HexStand {
  if (k <= 0) return leg.from;
  if (k >= leg.line.length - 1) return leg.to;
  return { size: leg.walk, ref: leg.line[k]!, squeezed: leg.squeezed };
}

/** The hex leg of a walker from where it stands to `to`, which stands squeezed as its `squeeze` says, or where it lies when that is not given (LegEnd). */
function walkerHexLeg(g: HexGrid, token: MovingToken, to: Point & { squeeze?: boolean }): HexLeg {
  return hexLegOf(g, hexStartStand(g, token), to.squeeze === undefined ? hexEndStand(g, token, to) : hexStandAt(g, token, to, to.squeeze));
}

/** `legStop` on hexes. */
function hexLegStopOf(t: HexWalls, token: MovingToken, to: Point & { squeeze?: boolean }): LegStop | null {
  const stop = hexLegStop(t, walkerHexLeg(t.g, token, to));
  return stop ? stopBy(t.walls, { k: stop.k }) : null;
}

/** The squeezed stand nearest `at`, by its middle. */
function squeezedStandAt(g: HexGrid, token: PlacedToken, at: Point): HexStand | null {
  if (!canSqueeze(token) || !hexSqueezedSize(sizeCategory(token))) return null;
  return hexStandAt(g, token, at, true);
}

/**
 * Where a drop on hexes lands (`landing`): the stand it aims at when the
 * leg there is allowed (or, not walking, its footprint fits), squeezed
 * where that is a real narrow space. A full footprint that does not fit
 * there tries the squeezed stands inside it, nearest the drop's middle
 * first. Walking, the last stand of the leg before what stops it that the
 * creature can stand on, full where it fits and squeezed where it is
 * narrow, with what stopped it.
 */
function hexLanding(t: HexWalls, token: Walker, to: LegEnd, mode: DropMode): Landing {
  const g = t.g;
  const start = hexStartStand(g, token);
  const target = hexEndStand(g, token, to);
  const fits = (s: HexStand) => hexFitWall(t, s) < 0 && (!s.squeezed || hexNarrow(t, token, s));
  const allowed = (s: HexStand) => mode === "teleport" || hexLegStop(t, hexLegOf(g, start, s)) === null;
  const ok = (s: HexStand) => (mode === "walk" ? allowed(s) && fits(s) : fits(s));
  if (ok(target)) return { x: to.x, y: to.y, squeeze: target.squeezed, stopped: null };
  if (!target.squeezed && hexFitWall(t, target) >= 0 && canSqueeze(token) && hexSqueezedSize(sizeCategory(token))) {
    const c = storedCenter({ ...token, x: to.x, y: to.y });
    const inside = hexStandHexes(g, target)
      .map((ref) => hexRestand(token, { ...target, ref }, true))
      .filter((s) => hexStandHexes(g, s).every((h) => hexStandHexes(g, target).some((f) => f.col === h.col && f.row === h.row)))
      .map((s) => ({ s, d: dist2(anchorOfHex(g, s.size, s.ref), c) }))
      .sort((a, b) => a.d - b.d || a.s.ref.row - b.s.ref.row || a.s.ref.col - b.s.ref.col);
    for (const { s } of inside) if (ok(s)) return { ...hexStandPlace(g, token, s), squeeze: true, stopped: null };
  }
  if (mode !== "walk") return { x: to.x, y: to.y, squeeze: false, stopped: null };
  const leg = hexLegOf(g, start, target);
  const stop = hexLegStop(t, leg);
  const stopped = stop ? stopBy(t.walls, { k: stop.k }) : null;
  // The steps the leg takes before it is stopped: the last of them the creature can stand on whose own leg is allowed, since
  // the hex line to a hex on the way need not be that part of the longer line (hex.ts hexLine), as a snapped spot on squares.
  for (let k = stop ? stop.step : leg.line.length - 1; k > 0; k--) {
    const s = hexLegStand(leg, k);
    const stands = [s, hexRestand(token, s, !s.squeezed)].find((c) => fits(c) && allowed(c));
    if (stands) return { ...hexStandPlace(g, token, stands), squeeze: stands.squeezed, stopped };
  }
  return { x: token.x, y: token.y, squeeze: isSqueezed(token), stopped };
}

/**
 * Where a walk on hexes toward `to` stops full size, for a creature that is
 * stored full size wherever it stops, as one a holder drags beside it
 * (moveLeg.ts stoppedAtWalls): `to` when the leg there is allowed, else
 * the last stand of the full-size leg's hex line before what stops it
 * where the full footprint fits and the leg from where the walk starts is
 * allowed, as `hexLanding` walks back but never squeezed, and the start
 * when none is. Null off a hex scene.
 */
export function hexFullStop(state: BuildState, token: Walker, to: LegEnd): Point | null {
  const t = hexWallsOf(state, token, to.elevation);
  if (!t) return null;
  const start = hexStartStand(t.g, token);
  const leg = hexLegOf(t.g, start, hexStandAt(t.g, token, to, false));
  const stop = hexLegStop(t, leg);
  if (!stop) return { x: to.x, y: to.y };
  for (let k = stop.step; k > 0; k--) {
    const s = hexLegStand(leg, k);
    if (!s.squeezed && hexFitWall(t, s) < 0 && hexLegStop(t, hexLegOf(t.g, start, s)) === null) return hexStandPlace(t.g, token, s);
  }
  return { x: token.x, y: token.y };
}

function dist2(a: Point, b: Point): number {
  return (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y);
}

/**
 * The spots of a straight leg on hexes, as `legSpots` gives them on
 * squares: where the token stands, then the box at each step of the hex
 * line at the size the leg walks at, and `to` last.
 */
export function hexLegSpots(g: HexGrid, token: MovingToken, to: Point): { at: Point; squeeze: boolean }[] {
  const leg = walkerHexLeg(g, token, to);
  const out: { at: Point; squeeze: boolean }[] = [{ at: { x: token.x, y: token.y }, squeeze: leg.from.squeezed }];
  for (let k = 1; k < leg.line.length - 1; k++) {
    const s = hexLegStand(leg, k);
    out.push({ at: hexStandPlace(g, token, s), squeeze: s.squeezed });
  }
  if (leg.line.length > 1 || to.x !== token.x || to.y !== token.y) out.push({ at: { x: to.x, y: to.y }, squeeze: leg.to.squeezed });
  return out;
}

/** `legStopPart` on hexes: the wall that stopped the leg, clipped to the box of the stand where the stopped step starts, a hair past. */
function hexLegStopPart(t: HexWalls, token: MovingToken, to: Point & { squeeze?: boolean }): { stop: LegStop; part: Part | null } | null {
  const leg = walkerHexLeg(t.g, token, to);
  const met = hexLegStop(t, leg);
  if (!met) return null;
  const stop = stopBy(t.walls, { k: met.k });
  const xy = t.walls.stored.xy;
  const seg: Part = [xy[4 * met.k]!, xy[4 * met.k + 1]!, xy[4 * met.k + 2]!, xy[4 * met.k + 3]!];
  const at = hexLegStand(leg, met.step);
  const a = anchorOfHex(t.g, at.size, at.ref);
  // Half the size's box, and a hex past it, holds every center whose step the leg took there.
  const r = SIZE_CELLS_HALF[at.size] + 1 + 1e-6;
  return { stop, part: clipToBox(seg, a.x - r, a.y - r, a.x + r, a.y + r) ?? seg };
}

const SIZE_CELLS_HALF: Record<SizeCategory, number> = { tiny: 0.25, small: 0.5, medium: 0.5, large: 1, huge: 1.5, gargantuan: 2 };

/**
 * A resize's leg on hexes (`resizeLegStop`): the steps of the new size
 * from the reference hex the creature has now to the new spot's, a
 * resize that keeps its reference hex (4.2) taking none.
 */
function hexResizeStop(t: HexWalls, token: MovingToken, to: PlacedToken): Blocker | null {
  const end = hexStandAt(t.g, to, to, isSqueezed(to));
  const from: HexStand = { ...end, ref: hexStartStand(t.g, token).ref };
  const leg = hexLegOf(t.g, from, end);
  for (let i = 0; i + 1 < leg.line.length; i++) {
    if (hexStepWall(t, { size: leg.walk, ref: leg.line[i]! }, hexDirection(t.g, leg.line[i]!, leg.line[i + 1]!), i === 0) >= 0) return "wall";
  }
  return null;
}

/**
 * The segment from hex `h`'s center to its neighbor's in direction `d`, as
 * a route search caches it: 1 clear, 2 met by a movement wall, 3 met only
 * by walls the center touches and the step leaves, which only a leg's
 * first step may take (`hexStepWall`).
 */
export function hexEdgeState(t: HexWalls, h: Hex, d: number): 1 | 2 | 3 {
  const segs = hexEdgeMeets(t, h, d);
  if (segs.length === 0) return 1;
  const c = hexCenter(t.g, h);
  const n = hexCenter(t.g, hexNeighbors(t.g, h)[d]!);
  for (const k of segs) if (!(meets(t.walls, k, t.test, c.x, c.y, c.x, c.y, 0, 0) && leaves(t.walls, k, t.test, c.x, c.y, n.x - c.x, n.y - c.y))) return 2;
  return 3;
}
