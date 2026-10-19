import type { RoomState, Token } from "#shared/model.ts";
import { footprintSize, tokenHeightFt } from "#shared/rules/footprint.ts";
import { routePoints, type RoutePoint } from "#shared/rules/route.ts";
import { halvedAt, type PublicWorld } from "#shared/rules/walkWorld.ts";
import { displayName } from "../../lib/scene.ts";
import { areaTitle } from "../areas/labels.ts";
import { dragReading, type Speeds } from "../measure/movement.ts";
import { cutRoute, landedElevation, type Point, type Role } from "./drop.ts";
import type { RouteAnswer } from "./routeDrag.ts";
import type { DragRoute } from "./store.ts";

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
 * now. A route past 64 pieces is drawn and read to where it is cut, as the
 * drop lands it, and its frames carry no more corners than that. With no
 * route, a walk held at the wall (`held`) is drawn and read to the wall.
 */
export function walkPreview(input: { view: RoomState; token: Token; target: Point; answer: RouteAnswer; held: Point | null; world: PublicWorld | null; role: Role }): Pick<DragRoute, "to" | "corners" | "read" | "endsIn"> {
  const { view, token, answer, world, role } = input;
  const found = answer.kind === "route" ? answer.route : null;
  const cut = found ? cutRoute(view, token, found.pieces) : null;
  const pieces = cut ? cut.pieces : found?.pieces;
  const to = cut ? cut.at : answer.kind === "none" && input.held ? input.held : input.target;
  const landing = landedElevation(view.buildChunks, token, to);
  const points = pieces
    ? routePoints(view.buildChunks, token, pieces, landing)
    : [
        { x: token.x, y: token.y, elevation: token.elevation },
        { x: to.x, y: to.y, elevation: landing },
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
    corners: pieces ? points.slice(1, -1).map((p) => ({ x: p.x, y: p.y })) : [],
    read,
    endsIn: world ? endsIn(view, world, token, points[points.length - 1]!) : null,
  };
}
