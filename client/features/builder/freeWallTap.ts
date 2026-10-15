import { sceneChunks } from "#shared/rules/walls.ts";
import { dispatchGesture } from "../../state/actions.ts";
import type { ToolContext, ToolPointer } from "../tools.ts";
import { edgeDistance, freeWallPutOp, freeWallRemoveOp, isHiddenDoor, nearestEdge, nearestFreeWall, nextFreeDoor } from "./cells.ts";
import { edgeAt } from "./query.ts";
import { builderSlot } from "./store.ts";

/** Half a 44 px touch target: how far from a free wall a tap still picks it. */
const FREE_WALL_REACH_PX = 22;

/**
 * A tap in the Walls and doors mode, as free walls see it
 * (docs/design-v1-maps-vision.md section 2.2). With Door it steps a free
 * door through closed, open and locked, and with Remove it takes a free
 * wall, door or window off. Returns whether the tap was a free wall's, so
 * the tool does nothing more with it.
 *
 * The other choices (Wall, Window, Secret door, No wall) work on grid edges
 * only: free walls come from an import, and the DM fixes one with edge
 * walls, the eraser and the door states. A tap goes to the free wall only
 * when it is at least as close as the nearest grid edge the tap would
 * change, so building beside an imported wall keeps working.
 */
export function tapFreeWall(p: ToolPointer, ctx: ToolContext): boolean {
  const builderState = ctx.scope.get(builderSlot).store;
  const { edge } = builderState.getState();
  if (edge !== "door" && edge !== "clear") return false;
  const view = ctx.getState().view;
  const sceneId = ctx.scene.id;
  const chunks = sceneChunks(view?.buildChunks ?? {}, sceneId);
  const reach = FREE_WALL_REACH_PX / ctx.camera().scale;
  const hit = nearestFreeWall(chunks, p.world, reach, edge === "door" ? (w) => w.f.kind === "door" : undefined);
  if (!hit) return false;
  const gridKey = nearestEdge(p.world, ctx.scene.bounds);
  if (gridKey !== null && edgeDistance(gridKey, p.world) < hit.distance) {
    // A Remove tap on a grid edge with nothing on it would do nothing, so the free wall takes it.
    if (edge === "door" || edgeAt(view, sceneId, gridKey) !== undefined) return false;
  }
  if (edge === "clear") {
    dispatchGesture(ctx.actions, [freeWallRemoveOp(sceneId, hit)]);
    return true;
  }
  if (isHiddenDoor(hit.wall.f)) {
    builderState.setState({ note: "That is a hidden secret door. Players see a wall there." });
    return true;
  }
  dispatchGesture(ctx.actions, [freeWallPutOp(sceneId, nextFreeDoor(hit.wall))]);
  return true;
}
