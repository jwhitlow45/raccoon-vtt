import type { Scene, Token } from "../model.ts";
import type { DoorRef } from "../protocol.ts";
import type { Blocker, BuildState, LegEnd } from "../ruleHooks.ts";
import { canSqueeze, footprintRect, footprintSize, occupiedRange, snapStep, squeezedSize, storedCenter, type PlacedToken } from "./footprint.ts";
import type { Point } from "./geom.ts";
import { standing } from "./heights.ts";
import { APART, contact, CROSS, MOVEMENT, onSegment, orient } from "./segments.ts";
import { LEDGE, sceneWalls, type WallSet } from "./walls.ts";

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

/** The token fields the movement rule reads. */
export type MovingToken = PlacedToken & Pick<Token, "sceneId" | "elevation">;

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
 */
export function pinches(segs: readonly (readonly [number, number, number, number])[], full: Box, core: Box, sq: Box, alongX: boolean, alongY: boolean): boolean {
  const across = (vertical: boolean): boolean => {
    // `vertical`: cross-sections are lines x = c, judged along y.
    const [c0, c1] = vertical ? [sq.x0, sq.x1] : [sq.y0, sq.y1];
    const [f0, k0, k1, f1] = vertical ? [full.y0, core.y0, core.y1, full.y1] : [full.x0, core.x0, core.x1, full.x1];
    const marks = [c0, c1];
    for (const [ax, ay, bx, by] of segs) {
      const [a, b, ua, ub] = vertical ? [ax, bx, ay, by] : [ay, by, ax, bx];
      for (const v of [a, b]) if (v > c0 && v < c1) marks.push(v);
      if (a !== b && ua !== ub) {
        for (const u of [f0, k0, k1, f1]) {
          const v = a + ((u - ua) * (b - a)) / (ub - ua);
          if (v > c0 && v < c1) marks.push(v);
        }
      }
    }
    marks.sort((p, q) => p - q);
    const tries = [...marks];
    for (let i = 1; i < marks.length; i++) if (marks[i]! > marks[i - 1]!) tries.push((marks[i - 1]! + marks[i]!) / 2);
    return tries.some(
      (c) =>
        segs.some((s) => meetsSpan(vertical, c, f0, true, k0, false, ...s)) &&
        segs.some((s) => meetsSpan(vertical, c, k1, false, f1, true, ...s)) &&
        !segs.some((s) => meetsSpan(vertical, c, k0, true, k1, true, ...s)),
    );
  };
  return (alongY && across(true)) || (alongX && across(false));
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
  switch (standing(token.elevation, walls.rangeGround(occupiedRange(token)))) {
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
function touching(walls: WallSet, px: number, py: number, qx: number, qy: number, hx: number, hy: number, floor: number): number[] {
  const index = walls.storedIndex;
  let seen = stamps.get(walls);
  if (!seen) stamps.set(walls, (seen = new Uint32Array(walls.stored.n)));
  const stamp = ++stampSerial;
  const xy = walls.stored.xy;
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
    if (sweptTouches(px, py, qx, qy, hx, hy, xy[4 * k]!, xy[4 * k + 1]!, xy[4 * k + 2]!, xy[4 * k + 3]!)) out.push(k);
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
  const xy = leg.walls.stored.xy;
  for (const k of segs) {
    const ax = xy[4 * k]!;
    const ay = xy[4 * k + 1]!;
    const bx = xy[4 * k + 2]!;
    const by = xy[4 * k + 3]!;
    if (!sweptTouches(sx, sy, ex, ey, leg.hx, leg.hy, ax, ay, bx, by)) continue;
    if (first && atStart.has(k)) {
      const side = orient(ax, ay, bx, by, leg.px, leg.py);
      const toward = orient(0, 0, bx - ax, by - ay, ex - sx, ey - sy);
      if (toward !== 0 && (side === 0 || toward === side)) continue;
    }
    return false;
  }
  return true;
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
  const segs = touching(leg.walls, px, py, qx, qy, hx + pad, hy + pad, leg.floor);
  if (segs.length === 0) return true;
  const xy = leg.walls.stored.xy;
  const atStart = new Set(segs.filter((k) => sweptTouches(px, py, px, py, hx, hy, xy[4 * k]!, xy[4 * k + 1]!, xy[4 * k + 2]!, xy[4 * k + 3]!)));
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

function legOf(walls: WallSet, scene: Pick<Scene, "blockMovement">, token: MovingToken, to: LegEnd): Leg {
  const { w, h } = coreSize(token);
  const p = storedCenter(token);
  const q = storedCenter({ ...token, x: to.x, y: to.y });
  return { walls, px: p.x, py: p.y, qx: q.x, qy: q.y, hx: w / 2, hy: h / 2, floor: ledgeFloor(walls, scene, token, to.elevation) };
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
export function legStop(state: BuildState, token: MovingToken, to: LegEnd): LegStop | null {
  const scene = state.scenes[token.sceneId];
  if (!scene) return null;
  const walls = sceneWalls(scene, state.buildChunks);
  const leg = legOf(walls, scene, token, to);
  if (legClear(leg)) return null;
  return firstStop(leg);
}

/**
 * Whether the straight path alone is clear, never a shifted one: the test
 * every step of a route takes (docs/design-v1-movement.md 5.1), the half
 * lattice holding the shifted spots itself. A route's piece made of such
 * steps passes `legStop` too, since its straight sweep is theirs joined.
 */
export function straightClear(state: BuildState, token: MovingToken, to: LegEnd): boolean {
  const scene = state.scenes[token.sceneId];
  if (!scene) return true;
  const leg = legOf(sceneWalls(scene, state.buildChunks), scene, token, to);
  const { px, py, qx, qy, hx, hy } = leg;
  if (px === qx && py === qy) return true;
  const segs = touching(leg.walls, px, py, qx, qy, hx, hy, leg.floor);
  if (segs.length === 0) return true;
  const xy = leg.walls.stored.xy;
  const atStart = new Set(segs.filter((k) => sweptTouches(px, py, px, py, hx, hy, xy[4 * k]!, xy[4 * k + 1]!, xy[4 * k + 2]!, xy[4 * k + 3]!)));
  return partClear(leg, segs, atStart, px, py, qx, qy, true);
}

/**
 * `straightClear` as a route search asks it (docs/design-v1-movement.md 5.1):
 * the walls, the core and the ledges worked out once, and nothing allocated
 * per step, since a search asks up to a million steps. The ledges count as
 * for a leg from where the token stands, which a walk keeps all the way: a
 * walker on the ground is stopped by every ledge, a flier keeps its height.
 */
export type StepTester = {
  walls: WallSet;
  /** Whether the core's straight sweep between two stored positions touches nothing it may not. */
  clear(ax: number, ay: number, bx: number, by: number): boolean;
  /** Whether the core fits at a stored position and blockers pinch the full footprint there, as a drag preview's squeeze is judged. */
  pinched(x: number, y: number): boolean;
};

export function stepTester(state: BuildState, token: MovingToken): StepTester | null {
  const scene = state.scenes[token.sceneId];
  if (!scene) return null;
  const walls = sceneWalls(scene, state.buildChunks);
  const floor = ledgeFloor(walls, scene, token, token.elevation);
  const { w, h } = footprintSize(token);
  const core = coreSize(token);
  const hx = core.w / 2;
  const hy = core.h / 2;
  const mask = MOVEMENT | (floor === Infinity ? 0 : LEDGE);
  const xy = walls.stored.xy;
  const index = walls.storedIndex;
  const EPS = 1e-7;
  let px = 0;
  let py = 0;
  let qx = 0;
  let qy = 0;
  let hit = false;
  const visit = (k: number) => {
    if (hit || !blocksMove(walls, k, floor)) return;
    const ax = xy[4 * k]!;
    const ay = xy[4 * k + 1]!;
    const bx = xy[4 * k + 2]!;
    const by = xy[4 * k + 3]!;
    if (!sweptTouches(px, py, qx, qy, hx, hy, ax, ay, bx, by)) return;
    // partClear's first part: a segment the core touches where it starts may be left toward the start's side.
    if (sweptTouches(px, py, px, py, hx, hy, ax, ay, bx, by)) {
      const side = orient(ax, ay, bx, by, px, py);
      const toward = orient(0, 0, bx - ax, by - ay, qx - px, qy - py);
      if (toward !== 0 && (side === 0 || toward === side)) return;
    }
    hit = true;
  };
  const squeezer: MovingToken = { ...token, squeeze: undefined };
  return {
    walls,
    clear(ax, ay, bx, by) {
      px = ax + w / 2;
      py = ay + h / 2;
      qx = bx + w / 2;
      qy = by + h / 2;
      if (px === qx && py === qy) return true;
      hit = false;
      index.query(Math.min(px, qx) - hx - EPS, Math.min(py, qy) - hy - EPS, Math.max(px, qx) + hx + EPS, Math.max(py, qy) + hy + EPS, mask, visit);
      return !hit;
    },
    pinched(x, y) {
      return squeezedThere(state, { ...squeezer, x: token.x, y: token.y }, { x, y }, false);
    },
  };
}

/** Section 4.1's test as the core asks it (shared/ruleHooks.ts). */
export function legBlocker(state: BuildState, token: Token, to: LegEnd): Blocker | null {
  return legStop(state, token, to)?.blocker ?? null;
}

/*
 * The first segment the straight path's core meets, by when along the leg
 * it meets it, worked out by clipping the path against the three slabs whose
 * meet is the segment grown by the core. Only names what stopped the leg, so
 * it needs no exact arithmetic: the leg is already known to be stopped.
 */
function firstStop(leg: Leg): LegStop {
  const { walls, px, py, qx, qy, hx, hy } = leg;
  const xy = walls.stored.xy;
  const segs = touching(walls, px, py, qx, qy, hx, hy, leg.floor);
  const atStart = new Set(segs.filter((k) => sweptTouches(px, py, px, py, hx, hy, xy[4 * k]!, xy[4 * k + 1]!, xy[4 * k + 2]!, xy[4 * k + 3]!)));
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
  if (best < 0) return { blocker: "wall", door: null };
  const wall = (walls.stored.tags[best]! & MOVEMENT) !== 0;
  const feature = walls.featureAt(best);
  return { blocker: wall ? "wall" : "ledge", door: wall && feature?.feature.kind === "door" ? feature.ref : null };
}

// ---------------------------------------------------------------------------
// Standing and squeezing

/*
 * The movement set at a spot is the one the token's leg there would be
 * judged by: ledges count by where the token stands now (its own position
 * and elevation), as for the leg's start (section 4.2).
 */
function coreTouchesAt(walls: WallSet, token: MovingToken, at: Point, floor: number): boolean {
  const c = storedCenter({ ...token, x: at.x, y: at.y });
  const { w, h } = coreSize(token);
  return touching(walls, c.x, c.y, c.x, c.y, w / 2, h / 2, floor).length > 0;
}

/** Whether the token's core, at the stored position `at`, touches the movement set, so no leg may end there. */
export function coreBlocked(state: BuildState, token: MovingToken, at: Point): boolean {
  const scene = state.scenes[token.sceneId];
  if (!scene) return false;
  const walls = sceneWalls(scene, state.buildChunks);
  return coreTouchesAt(walls, token, at, ledgeFloor(walls, scene, token, token.elevation));
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
  const walls = sceneWalls(scene, state.buildChunks);
  const c = storedCenter(to);
  const { w, h } = coreSize(to);
  return touching(walls, c.x, c.y, c.x, c.y, w / 2, h / 2, ledgeFloor(walls, scene, token, token.elevation)).length === 0;
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
  const walls = sceneWalls(scene, state.buildChunks);
  const p = storedCenter(token);
  const q = storedCenter(to);
  const { w, h } = coreSize(to);
  const leg: Leg = { walls, px: p.x, py: p.y, qx: q.x, qy: q.y, hx: w / 2, hy: h / 2, floor: ledgeFloor(walls, scene, token, token.elevation) };
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
function squeezedThere(state: BuildState, token: MovingToken, at: Point, fit: boolean): boolean {
  if (!canSqueeze(token)) return false;
  const scene = state.scenes[token.sceneId];
  if (!scene) return false;
  const walls = sceneWalls(scene, state.buildChunks);
  const floor = ledgeFloor(walls, scene, token, token.elevation);
  if (coreTouchesAt(walls, token, at, floor)) return false;
  const c = storedCenter({ ...token, x: at.x, y: at.y });
  const { w, h } = footprintSize(token);
  const squeezed = squeezedSize(token);
  const sq = { x0: c.x - squeezed.w / 2, y0: c.y - squeezed.h / 2, x1: c.x + squeezed.w / 2, y1: c.y + squeezed.h / 2 };
  const xy = walls.stored.xy;
  const segs = touching(walls, c.x, c.y, c.x, c.y, w / 2, h / 2, floor).map((k) => [xy[4 * k]!, xy[4 * k + 1]!, xy[4 * k + 2]!, xy[4 * k + 3]!] as const);
  if (fit && segs.some((s) => crossesInterior(sq.x0, sq.y0, sq.x1, sq.y1, ...s))) return false;
  const core = coreSize(token);
  const coreBox = { x0: c.x - core.w / 2, y0: c.y - core.h / 2, x1: c.x + core.w / 2, y1: c.y + core.h / 2 };
  return pinches(segs, { x0: at.x, y0: at.y, x1: at.x + w, y1: at.y + h }, coreBox, sq, w >= 2, h >= 2);
}

/**
 * Section 4.1's four checks for a move that stops the token squeezed at
 * `at`, its stored position: a side of at least 2 cells, the squeezed
 * footprint on cell boundaries, a real narrow space (walls, or ledges for a
 * token they stop, on both sides of the squeezed footprint along an axis it
 * shrinks, inside the full footprint, with the squeezed footprint fitting
 * between them), and a core touching no blocker. So the flag marks only a
 * real squeeze: a corridor or a door frame, never open ground beside one
 * wall. `token` is the token as it stands before the move: where it stands
 * then decides which ledges count, as for the move's leg.
 */
export function squeezeFits(state: BuildState, token: MovingToken, at: Point): boolean {
  if (!canSqueeze(token)) return false;
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
 * else by the full one.
 */
export function previewSqueezed(state: BuildState, token: MovingToken, at: Point): boolean {
  return squeezedThere(state, token, at, false);
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
export function landing(state: BuildState, token: MovingToken, to: LegEnd, mode: DropMode): Landing {
  const scene = state.scenes[token.sceneId];
  if (!scene) return { x: to.x, y: to.y, squeeze: false, stopped: null };
  const walls = sceneWalls(scene, state.buildChunks);
  const legTo = (at: Point) => legOf(walls, scene, token, { x: at.x, y: at.y, elevation: to.elevation });
  const floor = ledgeFloor(walls, scene, token, to.elevation);
  const fits = (at: Point) => !coreTouchesAt(walls, token, at, floor);
  const allowed = (at: Point) => mode === "teleport" || legClear(legTo(at));
  const squeeze = (at: Point) => squeezeFits(state, token, at);
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
function lastClearSpot(token: MovingToken, to: Point, allowed: (at: Point) => boolean): Point {
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

// ---------------------------------------------------------------------------
// Reaching a door

/**
 * Whether the straight line from the token's footprint center to `to`, a
 * door's midpoint, meets no movement blocker other than that door: the
 * clear line reaching a door needs (section 4.1). Touching a blocker counts,
 * except a blocker that meets the line only at the door's midpoint itself.
 * Ledges count for a token walking there, as for its moves.
 */
export function lineClear(state: BuildState, token: MovingToken, to: Point, door: DoorRef): boolean {
  const scene = state.scenes[token.sceneId];
  if (!scene) return false;
  const walls = sceneWalls(scene, state.buildChunks);
  const r = footprintRect(token);
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const floor = ledgeFloor(walls, scene, token, token.elevation);
  const xy = walls.stored.xy;
  for (const k of touching(walls, cx, cy, to.x, to.y, 0, 0, floor)) {
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
