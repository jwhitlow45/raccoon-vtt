import { distance, TAP_SLOP_PX } from "../../lib/gestures.ts";
import { LIGHT_REACH_PX, lightAt, lightSlot } from "../builder/lightTap.ts";
import { builderSlot } from "../builder/store.ts";
import type { ToolContext, ToolPointer, ToolPointerHandlers } from "../tools.ts";
import { PLACED_LIGHTS } from "../vision/presets.ts";
import { lightSpot, lightsOn, patched, placedLight, placeRefusal } from "./rules.ts";
import { lightModeSlot } from "./store.ts";

function note(ctx: ToolContext, text: string | null): void {
  ctx.scope.get(builderSlot).store.setState({ note: text });
}

/**
 * The builder's Light mode (docs/design-v1-maps-vision.md section 4.3.1).
 * A press on a light selects it and shows its reach. Lifted without moving,
 * it opens the light's pane. Dragged, it moves the light, which follows the
 * finger and is sent once when let go. A tap on empty map places the
 * chosen preset there, or, while a pane is open, closes it, so a tap meant
 * to dismiss the pane never drops a light under it. Each gesture is one op,
 * so undo takes back one gesture.
 */
export const lightPointer = {
  down(p: ToolPointer, ctx: ToolContext): void {
    const slot = ctx.scope.get(lightModeSlot);
    note(ctx, null);
    const sceneId = ctx.scene.id;
    const hit = lightAt(ctx.getState().view?.lights, sceneId, p.world, LIGHT_REACH_PX / ctx.camera().scale);
    if (hit) {
      ctx.scope.get(lightSlot).setState({ lightId: hit.id, dragTo: null });
      slot.gesture = { kind: "light", id: hit.id, sceneId, grab: { x: p.world.x - hit.x, y: p.world.y - hit.y }, downAt: p.screen };
      return;
    }
    slot.gesture = { kind: "place", sceneId, downAt: p.screen };
  },

  move(p: ToolPointer, ctx: ToolContext): void {
    const g = ctx.scope.get(lightModeSlot).gesture;
    if (!g || g.kind !== "light") return;
    const selection = ctx.scope.get(lightSlot);
    // A press that has not moved past a tap's slop is still a tap that opens the pane.
    if (!selection.getState().dragTo && distance(g.downAt, p.screen) <= TAP_SLOP_PX) return;
    selection.setState({ dragTo: lightSpot({ x: p.world.x - g.grab.x, y: p.world.y - g.grab.y }, ctx.scene.bounds) });
  },

  up(p: ToolPointer, ctx: ToolContext): void {
    const slot = ctx.scope.get(lightModeSlot);
    const g = slot.gesture;
    slot.gesture = null;
    if (!g) return;
    const selection = ctx.scope.get(lightSlot);
    const lights = ctx.getState().view?.lights;
    if (g.kind === "place") {
      // A drag across empty map does nothing here: two fingers move the map.
      if (distance(g.downAt, p.screen) > TAP_SLOP_PX || ctx.scene.id !== g.sceneId) return;
      if (slot.store.getState().paneOpen) {
        slot.store.setState({ paneOpen: false });
        selection.setState({ lightId: null, dragTo: null });
        return;
      }
      const refusal = placeRefusal(lightsOn(lights, g.sceneId));
      if (refusal) {
        note(ctx, refusal);
        return;
      }
      const preset = PLACED_LIGHTS.find((l) => l.name === slot.store.getState().preset) ?? PLACED_LIGHTS[1]!;
      const id = ctx.actions.newId();
      ctx.actions.dispatch({ t: "build.lights", sceneId: g.sceneId, put: [placedLight(id, lightSpot(p.world, ctx.scene.bounds), preset)] });
      selection.setState({ lightId: id, dragTo: null });
      return;
    }
    const dragTo = selection.getState().dragTo;
    selection.setState({ dragTo: null });
    // Undone or erased by another DM while it was pressed: nothing left to open or move.
    const light = lights?.[g.id];
    if (!light || light.sceneId !== ctx.scene.id) return;
    if (!dragTo) {
      slot.store.setState({ paneOpen: true });
      return;
    }
    if (dragTo.x === light.x && dragTo.y === light.y) return;
    ctx.actions.dispatch({ t: "build.lights", sceneId: light.sceneId, put: [patched(light, dragTo)] });
  },

  /** A second finger landed or the tool changed: the gesture ends without sending anything. */
  cancel(ctx: ToolContext): void {
    ctx.scope.get(lightModeSlot).gesture = null;
    ctx.scope.get(lightSlot).setState({ dragTo: null });
  },
};

/**
 * The builder tool's pointer handlers with Light mode in front of them, so
 * the builder registers Light mode with one line, as it does Stamp mode. A
 * gesture that began in Light mode ends there, whatever the mode is by the
 * time it ends.
 */
export function withLightMode(handlers: ToolPointerHandlers): ToolPointerHandlers {
  const lightMode = (ctx: ToolContext) => ctx.scope.get(builderSlot).store.getState().mode === "light";
  const lighting = (ctx: ToolContext) => ctx.scope.get(lightModeSlot).gesture !== null || lightMode(ctx);
  return {
    ...handlers,
    down: (p, ctx) => (lightMode(ctx) ? lightPointer.down(p, ctx) : handlers.down?.(p, ctx)),
    move: (p, ctx) => (lighting(ctx) ? lightPointer.move(p, ctx) : handlers.move?.(p, ctx)),
    up: (p, ctx) => (lighting(ctx) ? lightPointer.up(p, ctx) : handlers.up?.(p, ctx)),
    cancel: (ctx) => {
      lightPointer.cancel(ctx);
      handlers.cancel?.(ctx);
    },
  };
}
