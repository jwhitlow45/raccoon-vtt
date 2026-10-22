import type { RoomState, Token } from "#shared/model.ts";
import { footprintSize, tokenHeightFt } from "#shared/rules/footprint.ts";
import type { RoutePiece, RoutePoint } from "#shared/rules/route.ts";
import { halvedAt, type PublicWorld } from "#shared/rules/walkWorld.ts";
import { displayName } from "../../lib/scene.ts";
import { areaTitle } from "../areas/labels.ts";
import { dragReading, type Speeds } from "../measure/movement.ts";
import { landedElevation, routeLanding, samePose, type Point, type Pose, type Role } from "./drop.ts";
import type { RouteAnswer } from "./routeDrag.ts";
import type { DragRoute } from "./store.ts";

/**
 * What a drag's frame tells others besides the token (6.5): the route's
 * corners and the leg's cost, and for a walk cut short the spot it lands
 * on, so their line ends where it will, not at the finger (review
 * ASTRA-11). The board's own token still follows the finger.
 */
export function frameFields(route: Pick<DragRoute, "to" | "cut" | "corners" | "read">): { x?: number; y?: number; path?: number[]; ft?: number } {
  return {
    ...(route.cut ? { x: route.to.x, y: route.to.y } : {}),
    ...(route.corners.length > 0 ? { path: route.corners.flatMap((c) => [c.x, c.y]) } : {}),
    ft: route.read.dragFt,
  };
}

/** How a group drag's dragged token lands, for its label: on the ground there and never squeezed, as `token.moveMany` records it (review ASTRA-18). */
export function groupLanding(chunks: RoomState["buildChunks"], token: Token, to: Point): { elevation: number } {
  return { elevation: landedElevation(chunks, token, { x: to.x, y: to.y }) };
}

export function speedsOf(view: RoomState, token: Token): Speeds | undefined {
  // Speeds are the actor's, which only the DM and the creature's owners receive.
  return "inline" in token.actor ? token.actor.inline.speeds : view.characters[token.actor.ref]?.actor.speeds;
}

/** The creature whose space the mover would end in at `at`, by the name this viewer sees (3.1): the rules say it can't willingly end its move there. */
export function endsIn(view: RoomState, world: PublicWorld, token: Token, at: RoutePoint): string | null {
  const { w, h } = footprintSize(token);
  const lo = at.elevation;
  const hi = lo + tokenHeightFt(token, world.input.rules.feetPerCell);
  for (const s of world.spaces) {
    const overlaps = at.x < s.x1 - 1e-9 && at.x + w > s.x0 + 1e-9 && at.y < s.y1 - 1e-9 && at.y + h > s.y0 + 1e-9 && lo < s.hi && hi > s.lo;
    const other = view.tokens[s.id];
    if (overlaps && other) return displayName(other);
  }
  return null;
}

/**
 * The board's picture of a lone drag's walk (docs/design-v1-movement.md
 * 3.1): the line, its corners and the label, for where the drop would land
 * now. The walk is the one the drop lands with (`routeLanding`): a route
 * past 64 pieces is drawn and read to where it is cut, and its frames carry
 * no more corners than that, and one the drop would not take is drawn
 * straight. So reading it walks at most 300 squares. With no route, a walk
 * held at the wall (`held`) is drawn and read to the wall. A straight walk
 * reads what it walks over as the drop counts it (drop.ts planWalk): by
 * `straight`, its own route to where it lands, once that is checked.
 */
export function walkPreview(input: { view: RoomState; token: Token; target: Point & { squeeze?: boolean }; answer: RouteAnswer; held: Pose | null; world: PublicWorld | null; role: Role; straight?: { to: Pose; pieces: readonly RoutePiece[] } | null }): Pick<DragRoute, "to" | "cut" | "corners" | "read" | "endsIn"> {
  const { view, token, answer, world, role } = input;
  const fpc = view.meta.settings.feetPerCell;
  const walk = answer.kind === "route" ? routeLanding(view, token, input.target, answer.route.pieces, fpc) : null;
  const to = walk ? walk.at : (input.held ?? input.target);
  const own = !walk && input.held && input.straight && samePose(input.straight.to, input.held) ? routeLanding(view, token, input.held, input.straight.pieces, fpc) : null;
  const along = walk ?? (own && !own.cut ? own : null);
  const pieces = along?.pieces;
  const points = along
    ? along.points
    : [
        { x: token.x, y: token.y, elevation: token.elevation },
        { x: to.x, y: to.y, elevation: landedElevation(view.buildChunks, token, to) },
      ];
  const encounter = view.encounter;
  const activeTokenId = encounter?.entries.find((e) => e.id === encounter.activeEntryId)?.tokenId ?? null;
  const read = dragReading({
    token,
    to,
    encounter,
    activeTokenId,
    speeds: speedsOf(view, token),
    rules: { feetPerCell: view.meta.settings.feetPerCell, diagonal: view.meta.settings.diagonal },
    role,
    // A plain leg reads its landing as the move records it: its height, and its squeeze (review ASTRA-18).
    ...(pieces ? {} : { landing: { elevation: points[points.length - 1]!.elevation, ...(to.squeeze === true ? { squeeze: true as const } : {}) } }),
    ...(world
      ? {
          walk: {
            route: pieces ? { points, pieces } : null,
            build: view,
            halved: (at: RoutePoint) => {
              const area = halvedAt(world, token, at);
              return area ? areaTitle(area) : null;
            },
            prone: world.input.prone,
          },
        }
      : {}),
  });
  return {
    to: { x: to.x, y: to.y },
    cut: walk?.cut === true,
    corners: pieces ? points.slice(1, -1).map((p) => ({ x: p.x, y: p.y })) : [],
    read,
    endsIn: world ? endsIn(view, world, token, points[points.length - 1]!) : null,
  };
}
