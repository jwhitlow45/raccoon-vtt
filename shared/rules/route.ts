import type { PathStop } from "../model.ts";
import type { Blocker, BuildState } from "../ruleHooks.ts";
import { legFeet, type DiagonalCounter, type DistanceSettings } from "./distance.ts";
import { canSqueeze, footprintRect, footprintSize, isSqueezed, snapStep, stopFootprint, type PlacedToken } from "./footprint.ts";
import type { Point, Rect } from "./geom.ts";
import { footing, footprintGround } from "./heights.ts";
import { coreBlocked, legStop, squeezeFits, straightClear, walkOn, type MovingToken } from "./movement.ts";

/**
 * A move's route, what it costs and the spots it passes
 * (docs/design-v1-movement.md sections 4 and 6), shared by the client, the
 * reducer and the features that build on a move (attached tokens, traps).
 *
 * A route is straight pieces from where the token stands, each piece's end
 * on the half-square lattice from that start. Everything here is pure
 * arithmetic on the op and the state before it, so replay rebuilds the same
 * costs and spots from the stored op. If any rule here changes, the op
 * version moves with it.
 */

/** One piece as `token.move` carries it: where it ends, the public extra feet each foot costs, and whether one of them is the swimming foot. */
export type RoutePiece = readonly [x: number, y: number, extra: number, swim: 0 | 1];

/** A point of a walk: the footprint's top-left corner in cells and the elevation in feet there. */
export type RoutePoint = { x: number; y: number; elevation: number };

/** What a leg takes, as a path stop keeps it: feet walked, feet taken off the speed, and the 5-10-5 diagonals it took. */
export type LegCost = { moved: number; cost: number; diag: [number, number] };

/** The lattice a route steps on: half squares for Tiny and for any creature that can squeeze, whole squares otherwise (4.5). */
export function routeLattice(token: PlacedToken): number {
  return snapStep(token) < 1 || canSqueeze(token) ? 0.5 : 1;
}

/*
 * Positions are doubles a client stepped by halves from where the token
 * stood, which may itself be off the grid, so a whole number of half
 * squares is judged with a little slack.
 */
const SLACK = 1e-9;

function multipleOf(v: number, step: number): boolean {
  const k = v / step;
  return Math.abs(k - Math.round(k)) < SLACK;
}

/** Whether a point lies on the half-square lattice from `from`. */
export function onRouteLattice(from: Point, p: Point): boolean {
  return multipleOf(p.x - from.x, 0.5) && multipleOf(p.y - from.y, 0.5);
}

/**
 * The walk a route describes: where the token starts, then each piece's end
 * with its elevation by one fixed rule (6.1): a token on the ground at the
 * start takes the ground under its footprint at each spot, any other keeps
 * its elevation, and the last spot takes the landing's elevation. The
 * footprint between the ends is the full one: only where the move ends
 * does a squeeze change it.
 */
export function routePoints(chunks: BuildState["buildChunks"], token: MovingToken, route: readonly RoutePiece[], landing: number): RoutePoint[] {
  const grounded = footing(chunks, token) === "ground";
  const points: RoutePoint[] = [{ x: token.x, y: token.y, elevation: token.elevation }];
  for (const [i, [x, y]] of route.entries()) {
    const elevation = i === route.length - 1 ? landing : grounded ? footprintGround(chunks, { ...token, x, y, squeeze: undefined }) : token.elevation;
    points.push({ x, y, elevation });
  }
  return points;
}

/**
 * What stops a walked route (6.1): each piece's leg test from where the
 * piece starts, the token squeezed only where the walk starts, since a walk
 * squeezes nowhere between, along the points `routePoints` gives. The
 * server's check of a routed move (permissions.ts `routeCheck`) and the
 * client's, of a route it built before it sends it, are this one rule, so
 * the client never sends a route the server refuses (review MV-O-24).
 * `legBlocker` is the leg test: the core's hook on the server
 * (ruleHooks.ts), the rule itself on the client.
 */
export function routeBlocker<T extends MovingToken>(state: BuildState, token: T, route: readonly RoutePiece[], landing: number, legBlocker?: (state: BuildState, token: T, to: RoutePoint) => Blocker | null): Blocker | null {
  return routeStop(state, token, route, landing, legBlocker)?.blocker ?? null;
}

/** `routeBlocker`, with the piece it stops at. */
export function routeStop<T extends MovingToken>(state: BuildState, token: T, route: readonly RoutePiece[], landing: number, legBlocker: (state: BuildState, token: T, to: RoutePoint) => Blocker | null = (s, t, to) => legStop(s, t, to)?.blocker ?? null): { piece: number; blocker: Blocker } | null {
  const points = routePoints(state.buildChunks, token, route, landing);
  let from: T = token;
  for (let i = 1; i < points.length; i++) {
    // Each piece from the token where it starts, off the holder it walks off once a stop is clear of it (movement.ts walkOn).
    from = walkOn(from, points[i - 1]!);
    if (i > 1) delete from.squeeze;
    const blocker = legBlocker(state, from, points[i]!);
    if (blocker !== null) return { piece: i - 1, blocker };
  }
  return null;
}

/** A piece's reach as the area sweep measures it (section 10): the most it moves along any axis, its rise in squares. */
export function pieceReach(a: RoutePoint, b: RoutePoint, feetPerCell: number): number {
  return Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(b.elevation - a.elevation) / feetPerCell);
}

/** A walk's reach, every piece's summed. */
export function routeReach(points: readonly RoutePoint[], feetPerCell: number): number {
  let reach = 0;
  for (let i = 1; i < points.length; i++) reach += pieceReach(points[i - 1]!, points[i]!, feetPerCell);
  return reach;
}

/**
 * A straight length in squares under true distance. `Math.hypot` is left to
 * each engine's own approximation, so a tie could break one way in one
 * browser and the other in the next. A square root of a sum of squares is
 * correctly rounded at every step, so every device gets the same bits
 * (review MV-O-11).
 */
export function trueLength(dx: number, dy: number, dz: number): number {
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * What a walked leg takes (6.2, contract 4.4): the sum over its pieces of
 * `legFeet(dx, dy, dz)` for `moved`, and of `(1 + extra - swim * s)` times
 * it for `cost`, where `s` is 1 for a creature with a Swim Speed. The 5-10-5
 * counters run on from `counter` through every piece, in whole half feet,
 * since a 1 ft rise on 5 ft squares adds a fifth of a square and floats
 * would drift. True distance rounds once for the leg, to the nearest foot.
 * The other rules round the leg up to the token's own step (`step` squares,
 * 5 ft for a creature on whole squares, 2.5 ft for a Tiny one), so a Large
 * creature lining up with a door never reads as 2.5 ft.
 *
 * `points` holds the start and every piece's end, `pieces[i]` the extra of
 * the piece ending at `points[i + 1]`.
 */
export function routeFeet(
  points: readonly RoutePoint[],
  pieces: readonly { extra: number; swim: 0 | 1 }[],
  rules: DistanceSettings,
  counter: DiagonalCounter,
  opts: { swimSpeed: boolean; step: number },
): LegCost {
  const fpc = rules.feetPerCell;
  if (rules.diagonal === "euclid") {
    let moved = 0;
    let cost = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!;
      const b = points[i]!;
      const ft = trueLength(b.x - a.x, b.y - a.y, (b.elevation - a.elevation) / fpc) * fpc;
      moved += ft;
      cost += ft * multiplier(pieces[i - 1], opts.swimSpeed);
    }
    return { moved: Math.round(moved), cost: Math.round(cost), diag: [0, 0] };
  }
  // Half feet: a square is 2 * fpc of them, every lattice step and every whole-foot rise a whole number.
  const S = 2 * fpc;
  let h = Math.round(counter.h * S);
  let v = Math.round(counter.v * S);
  const h0 = h;
  const v0 = v;
  let moved = 0;
  let cost = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const dx = Math.round(Math.abs(b.x - a.x) * S);
    const dy = Math.round(Math.abs(b.y - a.y) * S);
    const dz = Math.round(Math.abs(b.elevation - a.elevation) * 2);
    let units: number;
    if (rules.diagonal === "five") units = Math.max(dx, dy, dz);
    else {
      const hMin = Math.min(dx, dy);
      const horizontal = Math.max(dx, dy) + S * (Math.floor((h + hMin) / (2 * S)) - Math.floor(h / (2 * S)));
      h += hMin;
      const vMin = Math.min(horizontal, dz);
      units = Math.max(horizontal, dz) + S * (Math.floor((v + vMin) / (2 * S)) - Math.floor(v / (2 * S)));
      v += vMin;
    }
    moved += units;
    cost += units * multiplier(pieces[i - 1], opts.swimSpeed);
  }
  const stepUnits = Math.max(1, Math.round(opts.step * S));
  const up = (u: number) => (Math.ceil(u / stepUnits) * stepUnits) / 2;
  return { moved: up(moved), cost: up(cost), diag: rules.diagonal === "fiveTen" ? [(h - h0) / S, (v - v0) / S] : [0, 0] };
}

function multiplier(piece: { extra: number; swim: 0 | 1 } | undefined, swimSpeed: boolean): number {
  if (!piece) return 1;
  return 1 + piece.extra - (piece.swim === 1 && swimSpeed ? 1 : 0);
}

/**
 * A spot with the footprint the creature had there, squeeze and all, where
 * that differs from the token's footprint now (PathStop.footprint).
 * Without it, the spot is read with the token's footprint now.
 */
export type SizedSpot = RoutePoint & Pick<PathStop, "footprint">;

/** The token as it stood at a spot, at the size it had there and squeezed if it was. */
function standingAt(token: PlacedToken, spot: SizedSpot): PlacedToken {
  if (!spot.footprint) return { ...token, x: spot.x, y: spot.y };
  const { w, h, squeeze } = spot.footprint;
  return { size: "custom", w, h, x: spot.x, y: spot.y, ...(squeeze ? { squeeze } : {}) };
}

/** The footprint a trail draws at a spot, in cells, at the size the creature had there. */
export function spotRect(token: PlacedToken, spot: SizedSpot): Rect {
  return footprintRect(standingAt(token, spot));
}

/**
 * Feet between two spots of one token on a plain straight leg: the steps
 * its snapped top-left corner takes, with its change of elevation as the
 * vertical steps. Counting the corner means a Large creature moved one
 * square has moved 5 ft, where an edge-to-edge reading would call its old
 * and new footprints overlapping. Each end is snapped and measured at its
 * own size, so a Tiny's half-square leg keeps its 2.5 ft after it grows. A
 * leg whose ends differ in size, a resize's or legs joined across one once
 * the path is full (rules/path.ts withStop), or whose ends differ in
 * squeeze, a move into or out of one, runs between the two footprints'
 * middles: a squeezed footprint sits centered and unsnapped, so its corner
 * is no measure beside a full one's.
 *
 * `counter` carries the diagonals of earlier legs under the 5-10-5 rule,
 * which counts every second diagonal of the whole move double, and is
 * updated in place, as a ruler's legs do (rules/distance.ts).
 */
export function straightFeet(token: PlacedToken, from: SizedSpot, to: SizedSpot, rules: DistanceSettings, counter?: DiagonalCounter): number {
  const a = spotRect(token, from);
  const b = spotRect(token, to);
  const standA = standingAt(token, from);
  const standB = standingAt(token, to);
  const sizeA = footprintSize(standA);
  const sizeB = footprintSize(standB);
  const differ = sizeA.w !== sizeB.w || sizeA.h !== sizeB.h || isSqueezed(standA) !== isSqueezed(standB);
  const across = differ ? { x: (b.w - a.w) / 2, y: (b.h - a.h) / 2 } : { x: 0, y: 0 };
  const dz = Math.abs(to.elevation - from.elevation) / rules.feetPerCell;
  const ft = legFeet(Math.abs(b.x - a.x + across.x), Math.abs(b.y - a.y + across.y), dz, rules.diagonal, rules.feetPerCell, counter);
  return rules.diagonal === "euclid" ? Math.round(ft) : ft;
}

/** What a plain straight leg takes: its feet as `straightFeet` counts them, no extras, and the diagonals it took. */
export function straightCost(token: PlacedToken, from: SizedSpot, to: SizedSpot, rules: DistanceSettings, counter: DiagonalCounter): LegCost {
  const running = { ...counter };
  const moved = straightFeet(token, from, to, rules, running);
  return { moved, cost: moved, diag: rules.diagonal === "fiveTen" ? [running.h - counter.h, running.v - counter.v] : [0, 0] };
}

/**
 * What a token's plain straight leg from `before` to `after` takes, as the
 * reducer records it (reducer/tokens.ts `walkedStop`): its change of
 * elevation counts, and a leg into or out of a squeeze runs between the two
 * footprints' middles. The drag's label reads a plain drop by it (review
 * ASTRA-18).
 */
export function plainLegCost(before: PlacedToken & { elevation: number }, after: PlacedToken & { elevation: number }, rules: DistanceSettings, counter: DiagonalCounter): LegCost {
  const from: SizedSpot = { x: before.x, y: before.y, elevation: before.elevation, ...(isSqueezed(before) !== isSqueezed(after) ? { footprint: stopFootprint(before) } : {}) };
  return straightCost(after, from, { x: after.x, y: after.y, elevation: after.elevation }, rules, counter);
}

/** A spot a walk passes (6.1, contract 4.3), with where the walk is at it: step `k` of piece `piece`'s `n`. */
export type RouteSpot = {
  x: number;
  y: number;
  elevation: number;
  squeezed: boolean;
  /** The token may stop here: its core fits, off its snap grid only squeezed, and the walk cut here is allowed. */
  stand: boolean;
  progress: [piece: number, k: number, n: number];
};

/** Whether a piece runs along one of the eight lattice directions in whole lattice steps, so its spots lie exactly on it. */
function latticePiece(dx: number, dy: number, step: number): boolean {
  if (!multipleOf(dx, step) || !multipleOf(dy, step)) return false;
  return Math.abs(dx) < SLACK || Math.abs(dy) < SLACK || Math.abs(Math.abs(dx) - Math.abs(dy)) < SLACK;
}

/** A spot of a walk without what standing there needs: where the footprint is, how high, and how far along. */
export type WalkSpot = Pick<RouteSpot, "x" | "y" | "elevation" | "progress">;

/**
 * The positions the footprint passes along a walk, the start first (6.1,
 * contract 4.3): `n = ceil(max(|dx|, |dy|) / step)` per piece, exactly along
 * the lattice for an eight-direction piece and snapped as a stopped walk's
 * spots are (movement.ts `lastClearSpot`) for any other, a repeat dropped.
 * A walker's spots take the ground under them, any other token's rise and
 * fall evenly between its pieces' ends.
 */
export function routeWalk(route: readonly RoutePoint[], token: MovingToken, build: Pick<BuildState, "buildChunks">, step?: number): WalkSpot[] {
  const first = route[0];
  if (!first) return [];
  const lattice = step ?? routeLattice(token);
  const grounded = footing(build.buildChunks, token) === "ground";
  const stepsOf = (a: RoutePoint, b: RoutePoint) => Math.max(1, Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) / lattice - SLACK));
  const spots: WalkSpot[] = [{ x: first.x, y: first.y, elevation: first.elevation, progress: [0, 0, route.length > 1 ? stepsOf(first, route[1]!) : 0] }];
  const snap = (v: number) => Math.round(v / lattice) * lattice + 0;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]!;
    const b = route[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const n = stepsOf(a, b);
    const exact = latticePiece(dx, dy, lattice);
    for (let k = 1; k <= n; k++) {
      const end = k === n;
      const x = end ? b.x : exact ? a.x + (dx * k) / n : a.x + snap((dx * k) / n);
      const y = end ? b.y : exact ? a.y + (dy * k) / n : a.y + snap((dy * k) / n);
      const prev = spots[spots.length - 1]!;
      if (!end && x === prev.x && y === prev.y) continue;
      const elevation = end ? b.elevation : grounded ? footprintGround(build.buildChunks, { ...token, x, y, squeeze: undefined }) : a.elevation + ((b.elevation - a.elevation) * k) / n;
      spots.push({ x, y, elevation, progress: [i - 1, k, n] });
    }
  }
  return spots;
}

/**
 * The spots of a walk (`routeWalk`) with whether the token may stop at each
 * (6.1, contract 4.3). A spot is a `stand` when its core fits, it is
 * squeezed only where the squeeze rule holds and off the token's own snap
 * grid only squeezed, and the walk cut there is allowed. The cut is allowed
 * for free on the segment of a piece whose straight sweep is clear, which
 * every piece of a searched route is. Any other spot runs the leg test on
 * the cut piece: a snapped spot, and a spot of a plain straight leg allowed
 * only by a shifted path, since a clear segment does not make a snapped
 * part of it clear. On a scene that stops no moves, nothing cuts a walk.
 * The start is a stand by definition. `squeeze` says whether the last spot
 * squeezes, as the op does.
 */
export function routeSpots(build: BuildState, route: readonly RoutePoint[], token: MovingToken, step?: number, opts: { squeeze?: boolean } = {}): RouteSpot[] {
  const walk = routeWalk(route, token, build, step);
  if (walk.length === 0) return [];
  const lattice = step ?? routeLattice(token);
  const grid = snapStep(token);
  const blocks = build.scenes[token.sceneId]?.blockMovement === true;
  const squeezes = canSqueeze(token);
  const spots: RouteSpot[] = [{ ...walk[0]!, squeezed: isSqueezed(token), stand: true }];
  let piece = -1;
  let at: MovingToken = token;
  // The token as the walk goes on, off the holder it walks off once a piece's start is clear of it (movement.ts walkOn).
  let walker: MovingToken = token;
  let exact = false;
  let sweep: boolean | undefined;
  for (let s = 1; s < walk.length; s++) {
    const w = walk[s]!;
    const [i, k, n] = w.progress;
    const a = route[i]!;
    const b = route[i + 1]!;
    if (i !== piece) {
      piece = i;
      // The token where this piece starts, squeezed if it was there: ledges and the leg test count from here.
      walker = walkOn(walker, a);
      at = { ...walker, squeeze: spots[spots.length - 1]!.squeezed ? true : undefined };
      exact = latticePiece(b.x - a.x, b.y - a.y, lattice);
      sweep = undefined;
    }
    const end = k === n;
    const last = end && i === route.length - 2;
    const p = { x: w.x, y: w.y };
    const squeezed = last && opts.squeeze !== undefined ? opts.squeeze : squeezes && squeezeFits(build, at, p);
    const onGrid = multipleOf(w.x - token.x, grid) && multipleOf(w.y - token.y, grid);
    const sweepClear = () => (sweep ??= !blocks || straightClear(build, at, { x: b.x, y: b.y, elevation: b.elevation }));
    const stand =
      (squeezed || onGrid) &&
      !coreBlocked(build, at, p) &&
      (!blocks || ((exact || end) && sweepClear()) || legStop(build, at, { x: w.x, y: w.y, elevation: w.elevation }) === null);
    spots.push({ ...w, squeezed, stand });
  }
  return spots;
}
