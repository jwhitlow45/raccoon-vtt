import type { Point } from "../../lib/camera.ts";
import type { ToolContext } from "../tools.ts";
import { doorUnder } from "./doors.ts";
import { doorPillSlot } from "./store.ts";

/** Half a 44 px touch target (design.md 14.4), as the builder reaches a free wall. */
export const DOOR_SLOP_PX = 22;

/**
 * A tap on the map with the Select tool, as doors see it
 * (docs/design-v1-maps-vision.md 4.1): a tap on a door shows its pill, and
 * a tap anywhere else puts an open pill away. The canvas calls this only
 * for a tap that no token caught, so a token under the finger wins. Doors
 * are part of the map, not shapes that catch a tap of their own, as labels
 * are. Returns whether the tap landed on a door.
 */
export function tapDoor(ctx: Pick<ToolContext, "getState" | "scene" | "camera" | "role" | "scope">, tool: string, world: Point): boolean {
  const pill = ctx.scope.get(doorPillSlot);
  const view = ctx.getState().view;
  const fogged = ctx.role === "player" && ctx.scene.fogEnabled !== false;
  const hit =
    tool === "select" && view
      ? doorUnder({ chunks: view.buildChunks, sceneId: ctx.scene.id, at: world, slop: DOOR_SLOP_PX / ctx.camera().scale, fog: fogged ? view.fogTiles : null })
      : null;
  if (hit) pill.setState({ pill: { sceneId: ctx.scene.id, ref: hit.ref } });
  else if (pill.getState().pill) pill.setState({ pill: null });
  return hit !== null;
}
