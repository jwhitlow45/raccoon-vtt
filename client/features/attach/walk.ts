import type { RoomState, Token } from "#shared/model.ts";
import { dragExtra, type SeenByAll } from "#shared/rules/attach.ts";
import { publicToken } from "#shared/rules/walkWorld.ts";
import type { WalkRoute } from "#shared/rules/walk.ts";
import { routePoints } from "#shared/rules/route.ts";
import { cutRoute, dropLanding, walkerOf, walkersStop, type DropToken, type DropView, type Point, type WalkersCut } from "../movement/drop.ts";
import type { Blocker } from "#shared/ruleHooks.ts";
import { dragWalkers } from "./groups.ts";

/**
 * A holder's walk as a drag searches it (docs/design-v1-attach.md 4.2 and
 * 7.3), as plain functions for node --test, so the drag pipeline
 * (features/movement/stageHooks.ts) needs a line for each. The world it
 * walks in is shared/rules/walkWorld.ts groupWalkWorld.
 */

type Role = "dm" | "player";

/**
 * Whether every player sees a token, as this copy shows it (7.3, the path's
 * `seen` marks): held, not hidden by the DM, and on the DM's copy not
 * withheld where it stands.
 */
export function seenIn(view: RoomState, role: Role): SeenByAll {
  return (t) => {
    const token = view.tokens[t.id];
    return token !== undefined && publicToken(view, token, { role });
  };
}

/**
 * How the label names the holder's extra foot (7.3): "dragging" while one of
 * the creatures that cost it is dragged, else "carrying". `seen` is who every
 * player sees, this copy's by default, a walking ruler's where its legs left
 * them (walkRuler.ts simulated).
 */
export function towingWord(view: RoomState, holderId: string, role: Role, seen: SeenByAll = seenIn(view, role)): "dragging" | "carrying" {
  const drags: RoomState["tokens"] = {};
  for (const [id, t] of Object.entries(view.tokens)) if (t && (t.attached === undefined || t.attached.kind === "drag")) drags[id] = t;
  return dragExtra(drags, holderId, seen) === 1 ? "dragging" : "carrying";
}

/** The creatures a lead token drags beside it as this copy shows them (groups.ts dragWalkers), stopping at the other tokens a drag names. `seen` as for towingWord. */
export function walkersFor(view: RoomState, tokenId: string, role: Role, named: ReadonlySet<string> = new Set(), seen: SeenByAll = seenIn(view, role)): Token[] {
  return dragWalkers(view.tokens, tokenId, seen, named);
}

/**
 * Where a lead token's walk to `target`, its route or else the straight leg,
 * stops so the creatures it drags beside it can follow (4.2), as the drag's
 * preview holds it and the drop cuts it (drop.ts cutForWalkers): null when
 * all of them walk the whole way. The route is the one the drop would land,
 * cut past 64 pieces, walked as the drop walks it (drop.ts walkerOf).
 */
export function walkersCut(view: DropView, token: DropToken, target: Point, route: Pick<WalkRoute, "pieces"> | null, role: Role): (WalkersCut & { blocker: Blocker }) | null {
  const walkers = walkersFor(view, token.id, role);
  if (walkers.length === 0) return null;
  const long = route ? cutRoute(view, token, route.pieces) : null;
  const end = long ? long.at : target;
  const landing = dropLanding(view, token, end);
  const walking = walkerOf(view, token, end);
  const points = route
    ? routePoints(view.buildChunks, walking, long ? long.pieces : route.pieces, landing)
    : [
        { x: token.x, y: token.y, elevation: token.elevation },
        { x: end.x, y: end.y, elevation: landing },
      ];
  const cut = walkersStop(view, walking, points, walkers);
  return cut ? { at: { x: cut.at.x, y: cut.at.y }, pieces: cut.pieces, blocker: cut.blocker } : null;
}

/** For a drag of several tokens: what each named one drags beside it, judged with the others named. */
export function walkersOfGroup(view: RoomState, group: readonly DropToken[], role: Role): (token: DropToken) => readonly DropToken[] {
  const named = new Set(group.map((t) => t.id));
  return (token) => walkersFor(view, token.id, role, named);
}
