import type { DiagonalCounter, DistanceSettings } from "./distance.ts";
import type { PlacedToken } from "./footprint.ts";
import { snapStep } from "./footprint.ts";
import { overlaps } from "./attach.ts";
import type { BuildState } from "../ruleHooks.ts";
import type { MovingToken } from "./movement.ts";
import { routeFeet, routePoints, routeWalk, straightCost, type LegCost, type RoutePiece, type RoutePoint } from "./route.ts";

/**
 * Getting off a ride on the rider's own turn (docs/design-v1-attach.md
 * 7.3), as the reducer stores it and a drag's band reads it, from one
 * accounting: the walk from the seat to its first spot clear of the mount
 * costs half the rider's Speed whatever its length, and the rest of the
 * walk costs what any leg costs, its diagonals running on from the first
 * part's, along the rest of its route when it has one.
 */

/** Where a walk off a mount clears it, and the rest of the walk from there: the route's pieces from that spot, or none for a straight rest. */
export type DismountSplit = { off: RoutePoint; rest: readonly RoutePiece[] | undefined; whole: boolean };

/**
 * The split of a rider's walk off its mount. `points` are the walk's
 * points from the seat, `route` its pieces when it has one. `whole` is
 * true when the first clear spot is the walk's end, so there is no rest.
 */
export function dismountSplit(build: Pick<BuildState, "buildChunks">, rider: MovingToken, mount: PlacedToken, points: readonly RoutePoint[], route?: readonly RoutePiece[]): DismountSplit {
  const walk = routeWalk(points, rider, build, snapStep(rider));
  const at = walk.findIndex((p, i) => i > 0 && !overlaps({ ...rider, x: p.x, y: p.y }, mount));
  const clear = walk[at] ?? walk[walk.length - 1]!;
  const end = points[points.length - 1]!;
  const off = { x: clear.x, y: clear.y, elevation: clear.elevation };
  const whole = off.x === end.x && off.y === end.y;
  // The rest of the route from the clear spot: the piece it lies on, from there, and the pieces after it.
  const [piece, k, n] = clear.progress;
  const rest = route && at > 0 ? route.slice(k === n ? piece + 1 : piece) : undefined;
  return { off, rest: rest && rest.length > 0 ? rest : undefined, whole };
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
  rider: MovingToken,
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
  const first = straightCost(rider, seat, split.off, rules, counter);
  if (split.whole) return { moved: first.moved, cost: halfFt, diag: first.diag };
  const running = { h: counter.h + first.diag[0], v: counter.v + first.diag[1] };
  const end = points[points.length - 1]!;
  const restToken = { ...rider, ...split.off };
  const rest = split.rest
    ? routeFeet(
        routePoints(build.buildChunks, restToken, split.rest, end.elevation),
        split.rest.map(([, , extra, swim]) => ({ extra, swim })),
        rules,
        running,
        { swimSpeed, step: snapStep(rider) },
      )
    : straightCost(rider, split.off, end, rules, running);
  return { moved: first.moved + rest.moved, cost: halfFt + rest.cost, diag: [first.diag[0] + rest.diag[0], first.diag[1] + rest.diag[1]] };
}
