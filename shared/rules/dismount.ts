import type { DiagonalCounter, DistanceSettings } from "./distance.ts";
import type { PlacedToken } from "./footprint.ts";
import { snapStep } from "./footprint.ts";
import { overlaps } from "./attach.ts";
import type { BuildState } from "../ruleHooks.ts";
import { walkFrom, walkOn, type Walker } from "./movement.ts";
import { routeFeet, routePoints, routeWalk, routeWalkers, straightCost, walkTrace, type LegCost, type RoutePiece, type RoutePoint } from "./route.ts";
import { SQUARES } from "./grid.ts";

/**
 * Getting off a ride on the rider's own turn (docs/design-v1-attach.md
 * 7.3), as the reducer stores it and a drag's band reads it, from one
 * accounting: the walk from the seat to its first spot clear of the mount
 * costs half the rider's Speed whatever its length, and the rest of the
 * walk costs what any leg costs. Both parts keep the route's own pieces,
 * the first its real distance, corners and diagonals with only its cost
 * set to the half, so the rest's diagonals run on from the first part's
 * as along any route.
 */

/**
 * Where a walk off a mount clears it: the route's pieces up to that spot
 * (`prefix`) and from it (`rest`), each none for a straight walk. `whole`
 * is true when the spot is the walk's end, so there is no rest.
 */
export type DismountSplit = { off: RoutePoint; prefix: readonly RoutePiece[] | undefined; rest: readonly RoutePiece[] | undefined; whole: boolean };

/**
 * The split of a rider's walk off its mount. `points` are the walk's
 * points from the seat, `route` its pieces when it has one. `whole` is
 * true when the first clear spot is the walk's end, so there is no rest.
 */
export function dismountSplit(build: Pick<BuildState, "buildChunks">, rider: Walker, mount: PlacedToken, points: readonly RoutePoint[], route?: readonly RoutePiece[]): DismountSplit {
  const walk = routeWalk(SQUARES, walkTrace(build.buildChunks, rider, points), build, snapStep(rider));
  const at = walk.findIndex((p, i) => i > 0 && !overlaps({ ...rider, x: p.x, y: p.y }, mount));
  const clear = walk[at] ?? walk[walk.length - 1]!;
  const end = points[points.length - 1]!;
  const off = { x: clear.x, y: clear.y, elevation: clear.elevation };
  const whole = off.x === end.x && off.y === end.y;
  // The route split at the clear spot: the pieces before the one it lies on, that piece cut there, and the rest from there.
  const [piece, k, n] = clear.progress;
  if (!route) return { off, prefix: undefined, rest: undefined, whole };
  // A walk that leaves the ride without ever clearing the mount ends half on it: all of it is the part off.
  if (at < 0) return { off, prefix: route, rest: undefined, whole };
  const cut = route[piece]!;
  const prefix = k === n ? route.slice(0, piece + 1) : [...route.slice(0, piece), [off.x, off.y, cut[2], cut[3]] as RoutePiece];
  const rest = route.slice(k === n ? piece + 1 : piece);
  return { off, prefix, rest: rest.length > 0 ? rest : undefined, whole };
}

/**
 * What a rider's walk off its mount takes, the two parts summed: `halfFt`
 * for the first, and the rest's own cost. `counter` holds the diagonals
 * the turn's counted legs took before it, `swimSpeed` whether the rider
 * has a Swim Speed. The reducer stores the same two parts as two stops
 * (shared/reducer/tokens.ts dismounted).
 */
export function dismountCost(
  build: Pick<BuildState, "buildChunks">,
  rider: Walker,
  mount: PlacedToken,
  points: readonly RoutePoint[],
  route: readonly RoutePiece[] | undefined,
  rules: DistanceSettings,
  counter: DiagonalCounter,
  halfFt: number,
  swimSpeed: boolean,
): LegCost {
  const split = dismountSplit(build, rider, mount, points, route);
  const seat = points[0]!;
  const opts = { swimSpeed, step: snapStep(rider) };
  const along = (from: Walker, pieces: readonly RoutePiece[], landing: number) =>
    routeFeet(routePoints(build.buildChunks, from, pieces, landing), pieces.map(([, , extra, swim]) => ({ extra, swim })), rules, running, opts);
  let running = counter;
  const first = split.prefix ? along(rider, split.prefix, split.off.elevation) : straightCost(SQUARES, rider, seat, split.off, rules, counter);
  if (split.whole) return { moved: first.moved, cost: halfFt, diag: first.diag };
  running = { h: counter.h + first.diag[0], v: counter.v + first.diag[1] };
  const end = points[points.length - 1]!;
  // The rest of the walk goes on from where the walk off the mount left the rider (movement.ts walkOn).
  const start = walkFrom(build.buildChunks, rider);
  const off = split.prefix ? routeWalkers(build.buildChunks, rider, split.prefix, split.off.elevation).at(-1)! : walkOn(build.buildChunks, start, split.off, split.off.elevation);
  const rest = split.rest ? along(off, split.rest, end.elevation) : straightCost(SQUARES, rider, split.off, end, rules, running);
  return { moved: first.moved + rest.moved, cost: halfFt + rest.cost, diag: [first.diag[0] + rest.diag[0], first.diag[1] + rest.diag[1]] };
}
