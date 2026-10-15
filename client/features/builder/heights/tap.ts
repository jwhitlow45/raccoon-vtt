import { sceneWalls } from "#shared/rules/walls.ts";
import { worldToScreen, type Point } from "../../../lib/camera.ts";
import type { ToolContext } from "../../tools.ts";
import { pinUnder } from "../../pins/rules.ts";
import { cellReadout, groundSource } from "./ground.ts";
import { closeReadout, readoutSlot, showReadout } from "./store.ts";

/**
 * A tap on empty map with the Select tool, as the height readout sees it
 * (docs/design-v1-heights-readout.md section 2): it shows the height of
 * raised or lowered ground, or a stair, under the tap, and any other tap
 * puts a readout away. The canvas calls it last, once no label or door
 * took the tap (canvas/emptyTap.ts). Returns whether it showed one.
 */
export function tapGround(ctx: Pick<ToolContext, "getState" | "scene" | "camera" | "role" | "scope">, tool: string, world: Point): boolean {
  const slot = ctx.scope.get(readoutSlot);
  const view = ctx.getState().view;
  const camera = ctx.camera();
  // A pin answers its own tap (features/pins/PinLayer.tsx), and a reading beside its popover would be two things floating at once.
  const words =
    tool === "select" && view && !pinUnder(view, ctx.scene.id, camera, worldToScreen(camera, world))
      ? cellReadout(groundSource(view, ctx.scene, ctx.role), sceneWalls(ctx.scene, view.buildChunks), { x: Math.floor(world.x), y: Math.floor(world.y) })
      : null;
  if (!words) {
    closeReadout(slot);
    return false;
  }
  showReadout(slot, { sceneId: ctx.scene.id, cell: { x: Math.floor(world.x), y: Math.floor(world.y) } }, words.spoken);
  return true;
}
