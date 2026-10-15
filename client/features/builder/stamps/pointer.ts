import { LIMITS } from "#shared/limits.ts";
import { distance, TAP_SLOP_PX } from "../../../lib/gestures.ts";
import type { ToolContext, ToolPointer, ToolPointerHandlers } from "../../tools.ts";
import { builderSlot } from "../store.ts";
import { afterTapClick } from "./afterClick.ts";
import {
  handleAt,
  onScene,
  placement,
  resizeFrom,
  rotationFrom,
  sceneStamps,
  snapHalf,
  STAMP_SLOP_PX,
  stampAt,
  toInput,
  toLocal,
  topZ,
  type StampPose,
} from "./rules.ts";
import { stampSlot } from "./store.ts";

const poseOf = (s: StampPose): StampPose => ({ x: s.x, y: s.y, w: s.w, h: s.h, rotation: s.rotation });

function samePose(a: StampPose, b: StampPose): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.rotation === b.rotation;
}

function note(ctx: ToolContext, text: string | null): void {
  ctx.scope.get(builderSlot).store.setState({ note: text });
}

/**
 * Stamp mode's gestures (design 3.5). A press on the selected stamp's
 * handle turns or resizes it, a press on a stamp selects it and a drag moves
 * it, and a tap on empty map places the chosen stamp and selects it. Each
 * gesture sends one op when it ends, so undo takes back one gesture.
 */
export const stampPointer = {
  down(p: ToolPointer, ctx: ToolContext): void {
    const slot = ctx.scope.get(stampSlot);
    const store = slot.store;
    note(ctx, null);
    const sceneId = ctx.scene.id;
    const stamps = sceneStamps(ctx.getState().view?.stamps, sceneId);
    const scale = ctx.camera().scale;
    const selected = stamps.find((s) => s.id === store.getState().selectedId);
    const handle = selected ? handleAt(selected, p.world, scale) : null;
    if (selected && handle) {
      slot.gesture = { kind: handle, id: selected.id, sceneId, start: poseOf(selected), grab: toLocal(selected, p.world), downAt: p.screen };
      return;
    }
    const hit = stampAt(stamps, p.world, STAMP_SLOP_PX / scale);
    if (hit) {
      store.setState({ selectedId: hit.id });
      slot.gesture = { kind: "move", id: hit.id, sceneId, start: poseOf(hit), grab: { x: p.world.x - hit.x, y: p.world.y - hit.y }, downAt: p.screen };
      return;
    }
    slot.gesture = { kind: "place", id: null, sceneId, start: null, grab: p.world, downAt: p.screen };
  },

  move(p: ToolPointer, ctx: ToolContext): void {
    const { store, gesture: g } = ctx.scope.get(stampSlot);
    if (!g || !g.start || !g.id) return;
    const { snap, preview } = store.getState();
    // A press on a stamp that has not moved past a tap's slop is still a tap that selects it.
    if (g.kind === "move" && !preview && distance(g.downAt, p.screen) <= TAP_SLOP_PX) return;
    let pose: StampPose;
    if (g.kind === "move") {
      const raw = { x: p.world.x - g.grab.x, y: p.world.y - g.grab.y };
      pose = { ...g.start, ...onScene(snap ? { x: snapHalf(raw.x), y: snapHalf(raw.y) } : raw, ctx.scene.bounds) };
    } else if (g.kind === "rotate") {
      pose = { ...g.start, rotation: rotationFrom(g.start, p.world, snap) };
    } else {
      pose = { ...g.start, ...resizeFrom(g.start, g.grab, toLocal(g.start, p.world)) };
    }
    store.setState({ preview: { id: g.id, pose } });
  },

  up(p: ToolPointer, ctx: ToolContext): void {
    const slot = ctx.scope.get(stampSlot);
    const g = slot.gesture;
    slot.gesture = null;
    if (!g) return;
    const store = slot.store;
    const { preview, chosen } = store.getState();
    if (g.kind === "place") {
      // A drag across empty map does nothing in Stamp mode: two fingers move the map.
      if (distance(g.downAt, p.screen) > TAP_SLOP_PX || ctx.scene.id !== g.sceneId) return;
      if (!chosen) {
        note(ctx, "Choose a stamp to place.");
        // On a phone the picker would open under the finger and take this tap's click as a pick.
        slot.openingPicker?.();
        slot.openingPicker = afterTapClick(() => {
          slot.openingPicker = null;
          // Not if the DM has left Stamp mode in the moment it waited.
          if (ctx.getState().local.tool === "build" && ctx.scope.get(builderSlot).store.getState().mode === "stamp") store.setState({ pickerOpen: true });
        }, slot.clickWait);
        return;
      }
      const stamps = sceneStamps(ctx.getState().view?.stamps, ctx.scene.id);
      if (stamps.length >= LIMITS.stampsPerScene) {
        note(ctx, `This scene already has ${LIMITS.stampsPerScene} stamps, the most it can hold.`);
        return;
      }
      const id = ctx.actions.newId();
      ctx.actions.dispatch({
        t: "build.stamps",
        sceneId: ctx.scene.id,
        put: [placement(chosen, p.world, { id, z: topZ(stamps), bounds: ctx.scene.bounds })],
      });
      store.setState({ selectedId: id });
      return;
    }
    store.setState({ preview: null });
    if (!preview || preview.id !== g.id) return;
    // Undone or erased by another DM while it was being dragged: nothing left to move.
    const current = ctx.getState().view?.stamps[g.id];
    if (!current || current.sceneId !== ctx.scene.id || samePose(current, preview.pose)) return;
    ctx.actions.dispatch({ t: "build.stamps", sceneId: current.sceneId, put: [toInput({ ...current, ...preview.pose })] });
  },

  /** A second finger landed or the tool changed: the gesture ends without sending anything, and a picker about to open stays shut. */
  cancel(ctx: ToolContext): void {
    const slot = ctx.scope.get(stampSlot);
    slot.gesture = null;
    slot.openingPicker?.();
    slot.openingPicker = null;
    slot.store.setState({ preview: null });
  },
};

/**
 * The builder tool's pointer handlers with Stamp mode in front of them, so
 * the builder registers Stamp mode with one line. A gesture that began in
 * Stamp mode ends there, whatever the mode is by the time it ends.
 */
export function withStampMode(handlers: ToolPointerHandlers): ToolPointerHandlers {
  const stamping = (ctx: ToolContext) =>
    ctx.scope.get(stampSlot).gesture !== null || ctx.scope.get(builderSlot).store.getState().mode === "stamp";
  return {
    ...handlers,
    down: (p, ctx) => (ctx.scope.get(builderSlot).store.getState().mode === "stamp" ? stampPointer.down(p, ctx) : handlers.down?.(p, ctx)),
    move: (p, ctx) => (stamping(ctx) ? stampPointer.move(p, ctx) : handlers.move?.(p, ctx)),
    up: (p, ctx) => (stamping(ctx) ? stampPointer.up(p, ctx) : handlers.up?.(p, ctx)),
    cancel: (ctx) => {
      stampPointer.cancel(ctx);
      handlers.cancel?.(ctx);
    },
  };
}
