import type { RoomState, Scene } from "#shared/model.ts";
import { sceneWalls } from "#shared/rules/walls.ts";
import { viewToScreen, type Point } from "../../../lib/camera.ts";
import { TOP_DOWN, toView } from "../../../lib/view.ts";
import type { ToolContext } from "../../tools.ts";
import { pinUnder } from "../../pins/rules.ts";
import { cellReadout, groundSource, type Cell, type ReadoutWords } from "./ground.ts";
import { closeReadout, readoutSlot, showReadout } from "./store.ts";

/** What the readout says of a cell in this viewer's view now, held to what the viewer may see (ground.ts cellReadout). */
export function wordsAt(view: Pick<RoomState, "buildChunks" | "fogTiles">, scene: Scene, role: "dm" | "player", cell: Cell): ReadoutWords | null {
  return cellReadout(groundSource(view, scene, role), sceneWalls(scene, view.buildChunks), cell);
}

/**
 * A tap on empty map with the Select tool, as the height readout sees it
 * (docs/design-v1-heights-readout.md section 2): it shows the height of
 * raised or lowered ground, or a stair, under the tap, and any other tap
 * puts a readout away. The canvas calls it last, once no label or door
 * took the tap (canvas/emptyTap.ts). Returns whether it showed one.
 * `screen` is the press, which a pin's marker is tested against, where it
 * is not where `world` shows in Top-down (the isometric view).
 */
export function tapGround(ctx: Pick<ToolContext, "getState" | "scene" | "camera" | "role" | "scope">, tool: string, world: Point, screen?: Point): boolean {
  const slot = ctx.scope.get(readoutSlot);
  const view = ctx.getState().view;
  const camera = ctx.camera();
  // A pin answers its own tap (features/pins/PinLayer.tsx), and a reading beside its popover would be two things floating at once.
  const cell = { x: Math.floor(world.x), y: Math.floor(world.y) };
  const words = tool === "select" && view && !pinUnder(view, ctx.scene.id, camera, screen ?? viewToScreen(camera, toView(TOP_DOWN, world))) ? wordsAt(view, ctx.scene, ctx.role, cell) : null;
  if (!words) {
    closeReadout(slot);
    return false;
  }
  showReadout(slot, { sceneId: ctx.scene.id, cell }, words.spoken);
  return true;
}
