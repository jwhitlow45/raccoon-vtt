import type { PathStop } from "../model.ts";
import type { Blocker, BuildState } from "../ruleHooks.ts";
import { legFeet, type DiagonalCounter, type DistanceSettings } from "./distance.ts";
import { canSqueeze, footprintRect, footprintSize, isSqueezed, placedOnHex, rangeAtInto, snapStep, stopFootprint, tokenRefHex, type CellRange, type PlacedToken } from "./footprint.ts";
import type { Point, Rect } from "./geom.ts";
import { SQUARES, type Grid } from "./grid.ts";
import { hexDistance, hexLine, type HexGrid } from "./hex.ts";
import { footing, footprintGround, sceneGround } from "./heights.ts";
import { coreBlocked, groundUnder, legStop, ownWalk, squeezeFits, straightClear, walkEnds, walkFrom, walkOn, type MovingToken, type WalkEnd, type Walker, type Walking } from "./movement.ts";

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
 *
 * On a hex scene (docs/design-v1-hex-grids.md 4.2 to 4.4) a leg is
 * straight from its start's reference hex to its end's: its feet are the
 * hex steps between them, and its spots stand on the hex line between them.
 * Routes, blocking and squeezing on hexes are phase H2's, and the server
 * refuses a routed or squeezed move on a hex scene until then, so the
 * route, lattice and stand rules here stay square.
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
 * A walk's trace (review AT-ASTRA-23): its walker at each point of its
 * route, the start first. Whatever reads a walk between its ends reads its
 * walker from here, never a token of its own: on a piece, the walker where
 * the piece starts, at a piece's end the walker there, and at the walk's
 * end the token as the move leaves it (`onTrace`). A token's own walk takes
 * each step by the walk's one rule (movement.ts `walkOn`), a creature its
 * holder takes along by its own (`followerTrace`).
 */
export type WalkTrace = readonly Walker[];

/**
 * The trace of the walk a route describes (6.1): where the token starts,
 * then each piece's end, at the height the walk takes there (`walkOn`: a
 * token on the ground at the start takes the ground under its full
 * footprint, any other keeps its elevation), and the last at `landing`
 * where the walk ends, else at the walk's own height there too. A squeeze
 * it starts in lasts for its first piece only.
 */
export function routeWalkers<T extends Walker>(chunks: BuildState["buildChunks"], token: T, route: readonly RoutePiece[], landing?: number): (T & Walking)[] {
  let at = walkFrom(chunks, token);
  const walkers = [at];
  for (const [i, [x, y]] of route.entries()) walkers.push((at = walkOn(chunks, at, { x, y }, i === route.length - 1 ? landing : undefined)));
  return walkers;
}

/** The trace of a walk along `points`, the start first, each at the height it gives, by the walk's one step (`walkOn`). */
export function walkTrace<T extends Walker>(chunks: BuildState["buildChunks"], token: T, points: readonly RoutePoint[]): (T & Walking)[] {
  let at = walkFrom(chunks, token);
  const walkers = [at];
  for (const p of points.slice(1)) walkers.push((at = walkOn(chunks, at, p, p.elevation)));
  return walkers;
}

/**
 * The trace of a creature its holder takes along (5.1): at each point its
 * holder's walk gives it, as itself, since a drag is no seat and a seat no
 * walk, and never squeezed, whatever it stood in.
 */
export function followerTrace<T extends MovingToken>(member: T, points: readonly RoutePoint[]): (T & Walker)[] {
  return points.map(({ x, y, elevation }) => {
    const at: T = { ...member, x, y, elevation };
    delete at.squeeze;
    return ownWalk(at);
  });
}

/** The walker whose footprint a spot of a walk has (`WalkTrace`): on piece `piece`, at its end where `end`, and `after` where the walk ends. */
export function onTrace<T extends PlacedToken>(trace: WalkTrace, piece: number, end: boolean, after: T): PlacedToken | T {
  const i = end ? piece + 1 : piece;
  return i >= trace.length - 1 ? after : trace[i]!;
}

/** The token as a spot of its walk places it: `after` there, with the footprint the walk has there (`onTrace`). */
export function placedOnTrace<T extends PlacedToken & { elevation: number }>(trace: WalkTrace, piece: number, end: boolean, after: T, spot: RoutePoint): T {
  const { squeeze: _squeeze, ...rest } = after;
  return { ...rest, x: spot.x, y: spot.y, elevation: spot.elevation, ...(isSqueezed(onTrace(trace, piece, end, after)) ? { squeeze: true as const } : {}) } as T;
}

/** The points of a route's walk (`routeWalkers`): where the token starts, then each piece's end with its elevation. */
export function routePoints(chunks: BuildState["buildChunks"], token: Walker, route: readonly RoutePiece[], landing?: number): RoutePoint[] {
  return routeWalkers(chunks, token, route, landing).map(({ x, y, elevation }) => ({ x, y, elevation }));
}

/**
 * What stops a walked route (6.1): each piece's leg test from its walker
 * where the piece starts (`routeWalkers`), squeezed only on its first. The
 * server's check of a routed move (permissions.ts `routeCheck`) and the
 * client's, of a route it built before it sends it, are this one rule, so
 * the client never sends a route the server refuses (review MV-O-24).
 * `legBlocker` is the leg test: the core's hook on the server
 * (ruleHooks.ts), the rule itself on the client.
 */
export function routeBlocker<T extends Walker>(state: BuildState, token: T, route: readonly RoutePiece[], landing: number, legBlocker?: (state: BuildState, token: T, to: RoutePoint) => Blocker | null): Blocker | null {
  return routeStop(state, token, route, landing, legBlocker)?.blocker ?? null;
}

/**
 * `routeBlocker`, with the piece it stops at. The straight walk's own route
 * (`alongStraightLeg`) stands where its straight leg steps, so the leg test
 * of that whole leg judges it, as it judges the plain move: a piece alone,
 * from a stand on the way, can meet ground the whole leg passes beside,
 * and the walk would then lose what it walks over (review MV-PLAIN-1).
 * Never for a walk off a holder, whose pieces past it read the ground's
 * rule (review AT-ASTRA-16).
 */
export function routeStop<T extends Walker>(state: BuildState, token: T, route: readonly RoutePiece[], landing: number, legBlocker: (state: BuildState, token: T, to: RoutePoint) => Blocker | null = (s, t, to) => legStop(s, t, to)?.blocker ?? null): { piece: number; blocker: Blocker } | null {
  const walkers = routeWalkers(state.buildChunks, token, route, landing);
  for (let i = 1; i < walkers.length; i++) {
    const { x, y, elevation } = walkers[i]!;
    const blocker = legBlocker(state, walkers[i - 1]!, { x, y, elevation });
    if (blocker === null) continue;
    const start = walkers[0]!;
    const end = walkers[walkers.length - 1]!;
    if (!start.offHolder && alongStraightLeg(start, route) && legBlocker(state, start, { x: end.x, y: end.y, elevation: end.elevation }) === null) return null;
    return { piece: i - 1, blocker };
  }
  return null;
}

/**
 * The lattice steps of the straight leg from `from` to `to` (walk.ts
 * LegCheck): `n` of them on the lattice `L`, each `at(k)` exactly along the
 * leg where it runs along one of the eight directions (`exact`), else
 * snapped to the lattice, the last at `to`.
 */
export function legSteps(from: Point, to: Point, L: number): { n: number; exact: boolean; at(k: number): Point } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / L - SLACK));
  const exact = Math.abs(dx) < SLACK || Math.abs(dy) < SLACK || Math.abs(Math.abs(dx) - Math.abs(dy)) < SLACK;
  const along = (d: number, k: number) => (exact ? (d * k) / n : Math.round((d * k) / n / L) * L);
  return { n, exact, at: (k) => (k === n ? { x: to.x, y: to.y } : { x: from.x + along(dx, k), y: from.y + along(dy, k) }) };
}

/** Whether a route is the straight walk's own (walk.ts LegCheck): its every point one of the straight leg's lattice steps from where the token stands to the route's end, in order. */
export function alongStraightLeg(token: PlacedToken & Point, route: readonly RoutePiece[]): boolean {
  const last = route[route.length - 1];
  if (!last) return false;
  const steps = legSteps(token, { x: last[0], y: last[1] }, routeLattice(token));
  const on = (k: number, x: number, y: number) => {
    const p = steps.at(k);
    return Math.abs(p.x - x) < 1e-7 && Math.abs(p.y - y) < 1e-7;
  };
  let k = 0;
  for (const [x, y] of route) {
    do k++;
    while (k <= steps.n && !on(k, x, y));
    if (k > steps.n) return false;
  }
  return true;
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

/** The token as it stood at a spot, at the size it had there and squeezed if it was: a stop's footprint box reads as its size's category on hexes. */
function standingAt(token: PlacedToken, spot: SizedSpot): PlacedToken {
  if (!spot.footprint) return { ...token, x: spot.x, y: spot.y };
  const { w, h, squeeze } = spot.footprint;
  return { size: "custom", w, h, x: spot.x, y: spot.y, ...(squeeze ? { squeeze } : {}) };
}

/** The footprint a trail draws at a spot, in cells, at the size the creature had there. */
export function spotRect(g: Grid, token: PlacedToken, spot: SizedSpot): Rect {
  return footprintRect(g, standingAt(token, spot));
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
 *
 * On hexes a leg's steps are the hex steps between its start's and its
 * end's reference hexes, each read at the size its spot holds (4.2), so a
 * leg whose stops differ in size still counts, and the room's rule only
 * combines them with the change of elevation (4.3).
 */
export function straightFeet(g: Grid, token: PlacedToken, from: SizedSpot, to: SizedSpot, rules: DistanceSettings, counter?: DiagonalCounter): number {
  if (g.shape === "hex") return hexLegFeet(g, token, from, to, rules, counter);
  const a = spotRect(g, token, from);
  const b = spotRect(g, token, to);
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

function hexLegFeet(g: HexGrid, token: PlacedToken, from: SizedSpot, to: SizedSpot, rules: DistanceSettings, counter?: DiagonalCounter): number {
  const steps = hexDistance(g, tokenRefHex(g, standingAt(token, from)), tokenRefHex(g, standingAt(token, to)));
  const dz = Math.abs(to.elevation - from.elevation) / rules.feetPerCell;
  const ft = legFeet(steps, 0, dz, rules.diagonal, rules.feetPerCell, counter);
  return rules.diagonal === "euclid" ? Math.round(ft) : ft;
}

/** What a plain straight leg takes: its feet as `straightFeet` counts them, no extras, and the diagonals it took. */
export function straightCost(g: Grid, token: PlacedToken, from: SizedSpot, to: SizedSpot, rules: DistanceSettings, counter: DiagonalCounter): LegCost {
  const running = { ...counter };
  const moved = straightFeet(g, token, from, to, rules, running);
  return { moved, cost: moved, diag: rules.diagonal === "fiveTen" ? [running.h - counter.h, running.v - counter.v] : [0, 0] };
}

/**
 * What a token's plain straight leg from `before` to `after` takes, as the
 * reducer records it (reducer/tokens.ts `walkedStop`): its change of
 * elevation counts, and a leg into or out of a squeeze runs between the two
 * footprints' middles. The drag's label reads a plain drop by it (review
 * ASTRA-18).
 */
export function plainLegCost(g: Grid, before: PlacedToken & { elevation: number }, after: PlacedToken & { elevation: number }, rules: DistanceSettings, counter: DiagonalCounter): LegCost {
  const from: SizedSpot = { x: before.x, y: before.y, elevation: before.elevation, ...(isSqueezed(before) !== isSqueezed(after) ? { footprint: stopFootprint(before) } : {}) };
  return straightCost(g, after, from, { x: after.x, y: after.y, elevation: after.elevation }, rules, counter);
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
 * The walk is its trace (`WalkTrace`), its walker at every point: a walker
 * on the ground takes the ground under the footprint the walk has at each
 * spot, any other token rises and falls evenly between its pieces' ends.
 *
 * On hexes each piece's spots stand on the hex line from its start's
 * reference hex to its end's (4.4), one a hex, the creature's box placed
 * so its anchor stands on that hex (footprint.ts placedOnHex) and the last
 * where the piece ends. So every reader of a walk's spots, `routeSeen`,
 * the area sweep and the drag preview's, reads the same hexes. `step`
 * means nothing there.
 */
export function routeWalk(g: Grid, trace: WalkTrace, build: Pick<BuildState, "buildChunks">, step?: number): WalkSpot[] {
  const first = trace[0];
  if (!first) return [];
  if (g.shape === "hex") return hexWalkSpots(g, trace, build);
  return walkSpots(trace, first, build, step, (piece) => trace[piece]!);
}

/** The hex steps of a piece of a walk on hexes, at least 1, so a piece within one hex still ends where it ends. */
export function hexPieceSteps(g: HexGrid, walker: PlacedToken, a: Point, b: Point): number {
  return Math.max(1, hexDistance(g, tokenRefHex(g, { ...walker, x: a.x, y: a.y }), tokenRefHex(g, { ...walker, x: b.x, y: b.y })));
}

/**
 * The spot at fraction `f` of a piece on hexes (4.4): on the hex line's hex
 * at that fraction of its steps, rounded, at the walker's size, or where
 * the piece ends at its end. Its elevation is the caller's. The area sweep
 * samples a piece by it at its own density, and `routeWalk` at each hex.
 */
export function hexPieceSpot(g: HexGrid, walker: PlacedToken, a: Point, b: Point, f: number): Point {
  if (f >= 1) return { x: b.x, y: b.y };
  if (f <= 0) return { x: a.x, y: a.y };
  const line = hexLine(g, tokenRefHex(g, { ...walker, x: a.x, y: a.y }), tokenRefHex(g, { ...walker, x: b.x, y: b.y }));
  const at = line[Math.round(f * (line.length - 1))]!;
  return placedOnHex(g, walker, at);
}

function hexWalkSpots(g: HexGrid, trace: WalkTrace, build: Pick<BuildState, "buildChunks">): WalkSpot[] {
  const first = trace[0]!;
  const grounded = walkFrom(build.buildChunks, first).grounded;
  const stepsOf = (i: number) => hexPieceSteps(g, trace[i - 1]!, trace[i - 1]!, trace[i]!);
  const spots: WalkSpot[] = [{ x: first.x, y: first.y, elevation: first.elevation, progress: [0, 0, trace.length > 1 ? stepsOf(1) : 0] }];
  for (let i = 1; i < trace.length; i++) {
    const a = trace[i - 1]!;
    const b = trace[i]!;
    const n = stepsOf(i);
    for (let k = 1; k <= n; k++) {
      const end = k === n;
      const { x, y } = hexPieceSpot(g, a, a, b, k / n);
      const elevation = end ? b.elevation : grounded ? groundUnder(build.buildChunks, a, { x, y }) : a.elevation + ((b.elevation - a.elevation) * k) / n;
      spots.push({ x, y, elevation, progress: [i - 1, k, n] });
    }
  }
  return spots;
}

/**
 * `routeWalk` as ops before version 14 replay it, which carry no trace:
 * every spot past the start on the ground under the full footprint, as
 * those ops were stored. Only that replay reads it (reducer/tokens.ts
 * walkedStop), so no walk of today's ops can sample without its trace.
 */
export function routeWalkBeforeV14(route: readonly RoutePoint[], token: Walker, build: Pick<BuildState, "buildChunks">): WalkSpot[] {
  const start = walkFrom(build.buildChunks, token);
  const full = walkOn(build.buildChunks, start, start);
  return walkSpots(route, token, build, undefined, () => full);
}

function walkSpots(route: readonly RoutePoint[], token: Walker, build: Pick<BuildState, "buildChunks">, step: number | undefined, walkerOn: (piece: number) => Walker): WalkSpot[] {
  const first = route[0];
  if (!first) return [];
  const lattice = step ?? routeLattice(token);
  const grounded = walkFrom(build.buildChunks, token).grounded;
  const stepsOf = (a: RoutePoint, b: RoutePoint) => Math.max(1, Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) / lattice - SLACK));
  const spots: WalkSpot[] = [{ x: first.x, y: first.y, elevation: first.elevation, progress: [0, 0, route.length > 1 ? stepsOf(first, route[1]!) : 0] }];
  // `groundUnder` at every spot, as fast as a walk of 200 squares needs it: the scene's chunks read once a walk, and an
  // unsqueezed walker's cells found from its size (footprint.ts rangeAtInto) rather than a token built at each spot.
  const over = grounded ? sceneGround(build.buildChunks, token.sceneId) : null;
  const cells: CellRange = { x0: 0, y0: 0, x1: 0, y1: 0 };
  const snap = (v: number) => Math.round(v / lattice) * lattice + 0;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]!;
    const b = route[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const n = stepsOf(a, b);
    const exact = latticePiece(dx, dy, lattice);
    const walker = walkerOn(i - 1);
    const size = over && !isSqueezed(walker) ? footprintSize(walker) : null;
    const groundAt = (x: number, y: number) => (size ? over!(rangeAtInto(cells, size.w, size.h, x, y)) : groundUnder(build.buildChunks, walker, { x, y }));
    for (let k = 1; k <= n; k++) {
      const end = k === n;
      const x = end ? b.x : exact ? a.x + (dx * k) / n : a.x + snap((dx * k) / n);
      const y = end ? b.y : exact ? a.y + (dy * k) / n : a.y + snap((dy * k) / n);
      const prev = spots[spots.length - 1]!;
      if (!end && x === prev.x && y === prev.y) continue;
      const elevation = end ? b.elevation : grounded ? groundAt(x, y) : a.elevation + ((b.elevation - a.elevation) * k) / n;
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
export function routeSpots(build: BuildState, route: readonly RoutePoint[], token: Walker, step?: number, opts: { squeeze?: boolean } = {}): RouteSpot[] {
  const stands = routeStands(build, route, token, step, opts);
  return stands.walk.map((_, s) => stands.spot(s));
}

/**
 * `routeSpots` a spot at a time: the walk's spots and its trace, and each
 * spot with `stand` worked out only when asked, once, so a search for where
 * a walk may stop reads only the spots it needs. The same rule as
 * `routeSpots` at every spot. `spots` are the walk's spots when the caller
 * has them already, as `routeWalk` gives them on this route at this step.
 */
export function routeStands(build: BuildState, route: readonly RoutePoint[], token: Walker, step?: number, opts: { squeeze?: boolean } = {}, spots?: readonly WalkSpot[]): { walk: readonly WalkSpot[]; trace: WalkTrace; spot: (s: number) => RouteSpot } {
  // The walker where each piece starts, as the walk carries it (`WalkTrace`): ledges, the squeeze and the leg test count from here.
  // Routes are square until hex grids' phase H2, which refuses them on hexes.
  const trace = walkTrace(build.buildChunks, token, route);
  const walk = spots ?? routeWalk(SQUARES, trace, build, step);
  const lattice = step ?? routeLattice(token);
  const grid = snapStep(token);
  const blocks = build.scenes[token.sceneId]?.blockMovement === true;
  const squeezes = canSqueeze(token);
  const pieces: { endAt: (p: Point) => WalkEnd; exact: boolean; sweep?: boolean }[] = [];
  const pieceAt = (i: number) => {
    const a = route[i]!;
    const b = route[i + 1]!;
    // A spot as the end of the walk up to it, judged from where its piece starts (movement.ts WalkEnd).
    return (pieces[i] ??= { endAt: walkEnds(build, trace[i]!), exact: latticePiece(b.x - a.x, b.y - a.y, lattice) });
  };
  const known: RouteSpot[] = [];
  const spot = (s: number): RouteSpot => {
    const hit = known[s];
    if (hit) return hit;
    const w = walk[s]!;
    if (s === 0) return (known[0] = { ...w, squeezed: isSqueezed(token), stand: true });
    const [i, k, n] = w.progress;
    const b = route[i + 1]!;
    const piece = pieceAt(i);
    const at = trace[i]!;
    const end = k === n;
    const last = end && i === route.length - 2;
    const p = { x: w.x, y: w.y };
    let ended: WalkEnd | undefined;
    const spotEnd = () => (ended ??= piece.endAt(p));
    const squeezed = last && opts.squeeze !== undefined ? opts.squeeze : squeezes && squeezeFits(build, spotEnd());
    const onGrid = multipleOf(w.x - token.x, grid) && multipleOf(w.y - token.y, grid);
    const sweepClear = () => (piece.sweep ??= !blocks || straightClear(build, at, { x: b.x, y: b.y, elevation: b.elevation }));
    const stand =
      (squeezed || onGrid) &&
      !coreBlocked(build, spotEnd()) &&
      (!blocks || ((piece.exact || end) && sweepClear()) || legStop(build, at, { x: w.x, y: w.y, elevation: w.elevation }) === null);
    return (known[s] = { ...w, squeezed, stand });
  };
  return { walk, trace, spot };
}
