import { dispatchGesture } from "../../../state/actions.ts";
import type { ToolContext, ToolPointer, ToolPointerHandlers } from "../../tools.ts";
import { strokeCells, strokeMaySend } from "../cells.ts";
import { builderSlot } from "../store.ts";
import { areaCells, paintCells } from "./ops.ts";
import { heightSlot } from "./store.ts";

/** Strokes send what they painted this often, as the builder's brush does (tool.tsx PAINT_FLUSH_MS). */
const FLUSH_MS = 150;

/**
 * Sends the stroke's unsent cells to the scene it started on, never to one
 * the DM switched to since. A finger's stroke holds them a moment first,
 * unless it has ended (`done`), in case a second finger is on its way.
 */
function flush(ctx: ToolContext, done: boolean): void {
  const { store, gesture } = ctx.scope.get(heightSlot);
  const stroke = gesture.stroke;
  const s = store.getState();
  if (s.unsent.length === 0 || !stroke) return;
  if (!done && !strokeMaySend(stroke.touch, stroke.startedAt, performance.now())) return;
  store.setState({ unsent: [] });
  if (ctx.scene.id !== stroke.sceneId) return;
  for (const op of paintCells(ctx.getState().view, stroke.sceneId, s.unsent, s)) ctx.actions.dispatch(op, { group: stroke.group });
}

function endStroke(ctx: ToolContext, send: boolean): void {
  const { store, gesture } = ctx.scope.get(heightSlot);
  if (!gesture.stroke) return;
  clearInterval(gesture.stroke.timer);
  if (send) flush(ctx, true);
  else store.setState({ unsent: [] });
  gesture.stroke = null;
}

/**
 * Height mode's gestures: a brush stroke paints the cells it crosses, a
 * few ops a second, as one undo step, and in Area a drag paints the cells
 * between its corners when it ends.
 */
export const heightPointer = {
  down(p: ToolPointer, ctx: ToolContext): void {
    const { store, gesture } = ctx.scope.get(heightSlot);
    const s = store.getState();
    endStroke(ctx, true);
    if (s.shape === "area") {
      gesture.areaSceneId = ctx.scene.id;
      store.setState({ area: { a: p.world, b: p.world } });
      return;
    }
    const seen = new Set<string>();
    const cells = strokeCells(null, p.world, s.shape, ctx.scene.bounds, seen);
    gesture.stroke = {
      sceneId: ctx.scene.id,
      seen,
      last: p.world,
      group: ctx.actions.newId(),
      timer: setInterval(() => flush(ctx, false), FLUSH_MS),
      touch: p.pointerType === "touch",
      startedAt: performance.now(),
    };
    store.setState({ unsent: cells });
  },

  move(p: ToolPointer, ctx: ToolContext): void {
    const { store, gesture } = ctx.scope.get(heightSlot);
    const s = store.getState();
    const stroke = gesture.stroke;
    if (stroke && s.shape !== "area") {
      const added = strokeCells(stroke.last, p.world, s.shape, ctx.scene.bounds, stroke.seen);
      stroke.last = p.world;
      if (added.length > 0) store.setState({ unsent: [...s.unsent, ...added] });
    } else if (s.area) {
      store.setState({ area: { a: s.area.a, b: p.world } });
    }
  },

  up(p: ToolPointer, ctx: ToolContext): void {
    const { store, gesture } = ctx.scope.get(heightSlot);
    if (gesture.stroke) {
      endStroke(ctx, true);
      return;
    }
    const s = store.getState();
    const area = s.area;
    const sceneId = gesture.areaSceneId;
    store.setState({ area: null });
    gesture.areaSceneId = null;
    if (!area || sceneId !== ctx.scene.id) return;
    dispatchGesture(ctx.actions, paintCells(ctx.getState().view, sceneId, areaCells(area.a, p.world, ctx.scene.bounds), s));
  },

  /** A second finger landed or the tool changed. Cells a stroke already sent stay, and undo takes them back. The rest is dropped. */
  cancel(ctx: ToolContext): void {
    const { store, gesture } = ctx.scope.get(heightSlot);
    endStroke(ctx, false);
    gesture.areaSceneId = null;
    store.setState({ unsent: [], area: null });
  },
};

/**
 * The builder tool's pointer handlers with Height mode in front of them, so
 * the builder registers Height mode with one line. A gesture that began in
 * Height mode ends there, whatever the mode is by the time it ends.
 */
export function withHeightMode(handlers: ToolPointerHandlers): ToolPointerHandlers {
  const inMode = (ctx: ToolContext) => ctx.scope.get(builderSlot).store.getState().mode === "height";
  const busy = (ctx: ToolContext) => {
    const slot = ctx.scope.get(heightSlot);
    return slot.gesture.stroke !== null || slot.store.getState().area !== null;
  };
  return {
    ...handlers,
    down: (p, ctx) => (inMode(ctx) ? heightPointer.down(p, ctx) : handlers.down?.(p, ctx)),
    move: (p, ctx) => (busy(ctx) ? heightPointer.move(p, ctx) : handlers.move?.(p, ctx)),
    up: (p, ctx) => (busy(ctx) ? heightPointer.up(p, ctx) : handlers.up?.(p, ctx)),
    cancel: (ctx) => {
      heightPointer.cancel(ctx);
      handlers.cancel?.(ctx);
    },
  };
}
