import type { RoomState, Token } from "#shared/model.ts";
import { holderOf, linkHolds } from "#shared/rules/attach.ts";
import { footprintSize, tokenHeightFt, type PlacedToken } from "#shared/rules/footprint.ts";
import { placedOnTrace, routePoints, routeWalkers, type RoutePiece, type RoutePoint } from "#shared/rules/route.ts";
import { halvedAt, type PublicWorld } from "#shared/rules/walkWorld.ts";
import { displayName } from "../../lib/scene.ts";
import { areaTitle } from "../areas/labels.ts";
import { dragReading, pathNow, type DragRead, type Speeds } from "../measure/movement.ts";
import { turnMoverId } from "../attach/turns.ts";
import { seenIn, towingWord } from "../attach/walk.ts";
import { cutPieces, dropLanding, routeLanding, samePose, walkerOf, type DropState, type DropView, type Point, type Pose, type Role, type WalkersCut } from "./drop.ts";
import type { RouteAnswer } from "./routeDrag.ts";
import type { DragRoute } from "./store.ts";

/**
 * What a drag's frame tells others besides the token (6.5): the route's
 * corners and the leg's cost, and for a walk cut short the spot it lands
 * on, so their line ends where it will, not at the finger (review
 * ASTRA-11). The board's own token still follows the finger. A straight
 * walk sends an empty `path`, which tells the server it walked no other
 * way. A frame with no `path` at all may have walked any way, so it is
 * judged for each way its last leg may start (server/rooms/ephemeral.ts
 * previewWithheld).
 */
export function frameFields(route: Pick<DragRoute, "to" | "cut" | "corners" | "read">): { x?: number; y?: number; path: number[]; ft?: number } {
  return {
    ...(route.cut ? { x: route.to.x, y: route.to.y } : {}),
    path: route.corners.flatMap((c) => [c.x, c.y]),
    ft: route.read.dragFt,
  };
}

/**
 * How a group drag's dragged token lands, for its label: never squeezed,
 * as `token.moveMany` records it (review ASTRA-18), and at the height the
 * group's drop sends (drop.ts dropLanding): by its holder while it sits on
 * one every player sees, else on the ground there.
 */
export function groupLanding(state: DropState, token: Token, to: Point): { elevation: number } {
  return { elevation: dropLanding(state, token, { x: to.x, y: to.y }) };
}

/**
 * A group drag's reading of one of its named tokens dropped at `to`, for its
 * label and the cost its frames send (review AT-ASTRA-15): landed as the
 * group's drop lands it (`groupLanding`), walked as its walk is
 * (drop.ts walkerOf), and off a ride on its own turn at the half Speed the
 * reducer stores (`dismountOf`), as a lone drag reads it.
 */
export function groupReading(view: DropView, token: Token, to: Point, role: Role): DragRead {
  const landing = groupLanding(view, token, to);
  const dismount = dismountOf(view, token, { x: to.x, y: to.y, elevation: landing.elevation }, role);
  return dragReading({
    token: walkerOf(view, token),
    to,
    landing,
    encounter: view.encounter,
    activeTokenId: turnMover(view, token, role),
    speeds: speedsOf(view, token),
    rules: { feetPerCell: view.meta.settings.feetPerCell, diagonal: view.meta.settings.diagonal },
    role,
    ...(dismount ? { dismount, build: view } : {}),
  });
}

/**
 * The token whose turn a drag's label reads as under way: the turn's mover
 * (attach/turns.ts turnMoverId), or, on a player's copy that holds no acting
 * row, the dragged token when its path this turn came with it, as its owners
 * get it on its own turn when the DM hid its row (measure/movement.ts
 * pathNow, review AT-HIDDENPATH). So the label counts on from the turn's
 * earlier legs, its diagonals too, as the move stores the leg.
 */
function turnMover(view: RoomState, token: Token, role: Role): string | null {
  const mover = turnMoverId(view);
  if (mover !== undefined) return mover;
  return role === "player" && view.encounter?.activeEntryId === null && pathNow(view.encounter, token, role) ? token.id : null;
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
 * The mount a rider's drop at `at` walks it off, with half its Speed, as
 * the reducer charges it on the rider's own turn (shared/reducer/tokens.ts
 * walkedOwn, mountCost): its ride no longer holds there, and every player
 * sees the mount. The rider may be hidden, since only the DM and its owners
 * read its path. None without the speeds, which only they hold.
 */
export function dismountOf(view: RoomState, token: Token, at: RoutePoint, role: Role): { mount: PlacedToken; halfFt: number } | undefined {
  if (token.attached?.kind !== "ride") return undefined;
  const mount = holderOf(view.tokens, token) as Token | undefined;
  const walk = speedsOf(view, token)?.walk;
  if (!mount || walk === undefined || linkHolds(view.meta.settings, "ride", { ...token, ...at }, mount)) return undefined;
  if (!seenIn(view, role)(mount)) return undefined;
  return { mount, halfFt: Math.floor(walk / 2) };
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
 * `straight`, its own route to where it lands, once that is checked. A
 * holder's walk held where a creature it drags would meet a wall
 * (`walkers`, docs/design-v1-attach.md 4.2) is drawn and read to there.
 */
export function walkPreview(input: { view: DropView; token: Token; target: Point & { squeeze?: boolean }; answer: RouteAnswer; held: Pose | null; walkers?: WalkersCut | null; world: PublicWorld | null; role: Role; straight?: { to: Pose; pieces: readonly RoutePiece[] } | null }): Pick<DragRoute, "to" | "cut" | "corners" | "read" | "endsIn"> {
  const { view, token, answer, world, role } = input;
  const fpc = view.meta.settings.feetPerCell;
  const walk = answer.kind === "route" ? routeLanding(view, token, input.target, answer.route.pieces, fpc) : null;
  let to: Point & { squeeze?: boolean } = walk ? walk.at : (input.held ?? input.target);
  const own = !walk && input.held && input.straight && samePose(input.straight.to, input.held) ? routeLanding(view, token, input.held, input.straight.pieces, fpc) : null;
  const along = walk ?? (own && !own.cut ? own : null);
  let pieces = along?.pieces;
  const walkers = input.walkers ?? null;
  if (walkers && along && pieces) {
    const kept = cutPieces(along.points, pieces, walkers);
    pieces = kept.length > 0 ? kept : undefined;
  }
  if (walkers) to = walkers.at;
  // Landed as the drop lands it, by its holder while it sits on one, so the band reads the leg the op sends.
  // And walked as the search and the server walk it (drop.ts walkerOf): on the ground, crossing only the inner ledges of a holder every player sees that stands on the ground.
  const walking = walkerOf(view, token);
  const points = pieces
    ? walkers
      ? routePoints(view.buildChunks, walking, pieces, dropLanding(view, token, to))
      : along!.points
    : [
        { x: token.x, y: token.y, elevation: token.elevation },
        { x: to.x, y: to.y, elevation: dropLanding(view, token, to) },
      ];
  const encounter = view.encounter;
  // A controlled mount sharing its rider's turn reads its own path and speeds (docs/design-v1-attach.md 7.2).
  const activeTokenId = turnMover(view, token, role);
  const dismount = dismountOf(view, token, points[points.length - 1]!, role);
  const end = points[points.length - 1]!;
  const { squeeze: _squeeze, ...standing } = token;
  const landed: Token = { ...standing, x: to.x, y: to.y, elevation: end.elevation, ...(to.squeeze === true ? { squeeze: true as const } : {}) };
  const trace = routeWalkers(view.buildChunks, walking, pieces ?? [[to.x, to.y, 0, 0]], end.elevation);
  const read = dragReading({
    token: walking,
    to,
    encounter,
    activeTokenId,
    speeds: speedsOf(view, token),
    rules: { feetPerCell: view.meta.settings.feetPerCell, diagonal: view.meta.settings.diagonal },
    role,
    // A plain leg reads its landing as the move records it: its height, and its squeeze (review ASTRA-18).
    ...(pieces ? {} : { landing: { elevation: points[points.length - 1]!.elevation, ...(to.squeeze === true ? { squeeze: true as const } : {}) } }),
    ...(dismount ? { dismount } : {}),
    ...(world
      ? {
          walk: {
            route: pieces ? { points, pieces } : null,
            build: view,
            trace,
            // Each spot with the footprint the walk's trace has there, squeezed where it lands as the drop lands it (route.ts onTrace).
            halved: (at: RoutePoint, piece: number, end: boolean) => {
              const area = halvedAt(world, placedOnTrace(trace, piece, end, landed, at));
              return area ? areaTitle(area) : null;
            },
            prone: world.input.prone,
            ...(world.input.drag === 1 ? { towing: towingWord(view, token.id, role) } : {}),
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
