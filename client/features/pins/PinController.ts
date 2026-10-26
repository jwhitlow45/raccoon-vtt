import type Konva from "konva";
import { useEffect, useRef } from "react";
import { useStore } from "zustand";
import { popoverSlot } from "../../components/popoverRules.ts";
import { boardPickOf, viewGround } from "../../canvas/boardPick.ts";
import { cameraOfStage } from "../../lib/camera.ts";
import { useRoomScope, useScoped } from "../../state/scope.ts";
import { useIsDisplay, useRoomStore, useRoomUi, useRoomView } from "../../state/view.ts";
import { journalSlot } from "../journal/store.ts";
import type { ControllerProps } from "../layers.ts";
import { onHoldPing } from "../pings/hold.ts";
import { pinTapCounts, pinUnder } from "./rules.ts";
import { closePopoverOnSelect, pinSlot } from "./store.ts";

/** How long a label-only pin's popover stays after a tap. */
const POPOVER_MS = 4_000;

/**
 * Everything map pins do besides drawing (PinLayer.tsx), as one of the
 * board's controllers (features/layers.ts CONTROLLERS), mounted once
 * outside both drawing trees, so one tap opens one page whichever view
 * shows (docs/design-v1-isometric-view.md 5.1).
 *
 * With the Select tool a tap on a pin opens its page in the Journal, or
 * shows its label in a small popover when it links none. A table display
 * has no Journal and takes no input on the map, so there a tap does
 * nothing (docs/design-v1-dm-tools.md 3.8). The canvas sends taps to tools
 * and tokens, so this watches the stage's own pointer events for a tap, as
 * the ping controller watches for a held press.
 */
export function PinController(props: ControllerProps): null {
  const tool = useRoomView((s) => s.local.tool);
  const display = useIsDisplay();
  const pinStore = useScoped(pinSlot).store;
  const popover = useStore(pinStore, (s) => s.popover);
  const room = useRoomStore();
  const scope = useRoomScope();
  useEffect(() => closePopoverOnSelect(room, scope), [room, scope]);

  useEffect(() => {
    if (!popover) return;
    const timer = setTimeout(() => pinStore.setState({ popover: null }), Math.max(0, popover.at + POPOVER_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [popover, pinStore]);

  const board = useRef({ scene: props.scene });
  board.current = { scene: props.scene };
  useTapPin(props.stage, tool === "select" && !display, board);
  return null;
}

type BoardRef = { readonly current: { scene: ControllerProps["scene"] } };

/**
 * A tap with the Select tool on a pin: its page opens in the Journal, or a
 * pin with only a label shows it in a popover. What counts as a tap is
 * rules.ts pinTapCounts: a pan, a pinch or a hold that pinged opens nothing.
 */
function useTapPin(stage: Konva.Stage | null, enabled: boolean, board: BoardRef): void {
  const store = useRoomStore();
  const ui = useRoomUi();
  const scope = useRoomScope();
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  useEffect(() => {
    if (!stage) return;
    const el = stage.container();
    const down = new Map<number, { x: number; y: number }>();
    /** More than one finger touched during this gesture, so it is a pinch, never a tap. */
    let several = false;
    /** Presses the hold-to-ping fired for. */
    const held = new Set<number>();
    const offHold = onHoldPing(scope, (id) => void held.add(id));
    const local = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onDown = (e: PointerEvent) => {
      // A press that closes a popover or a menu (components/popoverRules.ts) opens no pin, nor does any finger that joins it.
      if (scope.get(popoverSlot).suppressesTool()) return;
      if (down.size === 0) several = false;
      down.set(e.pointerId, local(e));
      held.delete(e.pointerId);
      if (down.size > 1) several = true;
    };
    const onUp = (e: PointerEvent) => {
      const start = down.get(e.pointerId);
      down.delete(e.pointerId);
      const wasHeld = held.delete(e.pointerId);
      if (!start || e.type === "pointercancel" || !enabledRef.current) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const p = local(e);
      if (!pinTapCounts({ start, end: p, several, held: wasHeld })) return;
      const view = store.getState().view;
      if (!view) return;
      // In Isometric a pin stands at its drawn ground (PinLayer.tsx), and the tap finds it there.
      const pick = boardPickOf({ scope, camera: () => cameraOfStage(stage) });
      const hit = pinUnder(view, board.current.scene.id, pick.camera, p, viewGround(pick));
      if (!hit) return;
      const pinState = scope.get(pinSlot).store;
      if (hit.pageId !== undefined && view.journal[hit.pageId]) {
        pinState.setState({ popover: null });
        scope.get(journalSlot).setState({ pageId: hit.pageId });
        ui.openPanel("journal");
      } else if (hit.label) {
        pinState.setState({ popover: { id: hit.id, at: Date.now() } });
      }
    };
    el.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      offHold();
      el.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [stage, store, ui, scope, board]);
}
