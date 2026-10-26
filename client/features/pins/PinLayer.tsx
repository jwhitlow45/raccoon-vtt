import type Konva from "konva";
import { memo, useEffect, useMemo, useRef, type RefObject } from "react";
import { Circle, Group, Line, Rect } from "react-konva";
import { useStore } from "zustand";
import type { JournalPage, Pin } from "#shared/model.ts";
import { popoverSlot } from "../../components/popoverRules.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomScope, useScoped } from "../../state/scope.ts";
import { useIsDisplay, useRoomStore, useRoomUi, useRoomView } from "../../state/view.ts";
import { journalSlot } from "../journal/store.ts";
import type { LayerProps } from "../layers.ts";
import { Pill } from "../measure/Pill.tsx";
import { onHoldPing } from "../pings/hold.ts";
import { dmOnlyPin, HEAD_CENTER_PX, LABEL_MIN_CELL_PX, pinOutline, pinTapCounts, pinUnder } from "./rules.ts";
import { closePopoverOnSelect, pinSlot } from "./store.ts";
import { cameraOfStage } from "../../lib/camera.ts";

const OUTLINE = pinOutline();
/** How long a label-only pin's popover stays after a tap. */
const POPOVER_MS = 4_000;
const EMPTY_PINS: Record<string, Pin> = {};
const EMPTY_PAGES: Record<string, JournalPage> = {};

/**
 * Map pins (docs/design-v1-dm-tools.md 3.8) on the overlay layer, above the
 * fog: a pin that reaches a player is never under it, since projection
 * withholds one on a fully fogged cell. Each is a marker of one size on
 * screen, 28 px tall, in its color, with its label under it once the map
 * is zoomed in enough to read it. The DM's map draws a pin no player can
 * receive faded.
 *
 * With the Select tool a tap on a pin opens its page in the Journal, or
 * shows its label in a small popover when it links none. A table display
 * has no Journal and takes no input on the map, so there a tap does
 * nothing (docs/design-v1-dm-tools.md 3.8). The canvas sends
 * taps to tools and tokens, so this layer watches the stage's own pointer
 * events for a tap, as the ping layer watches for a held press.
 */
export const PinLayer = memo(function PinLayer(props: LayerProps) {
  const pins = useRoomView((s) => s.view?.pins ?? EMPTY_PINS);
  const pages = useRoomView((s) => s.view?.journal ?? EMPTY_PAGES);
  const tool = useRoomView((s) => s.local.tool);
  const pinStore = useScoped(pinSlot).store;
  const drag = useStore(pinStore, (s) => s.drag);
  const popover = useStore(pinStore, (s) => s.popover);
  const paneId = useStore(pinStore, (s) => s.paneId);
  const groupRef = useRef<Konva.Group>(null);
  const dm = props.role === "dm";
  const display = useIsDisplay();
  const onScene = useMemo(() => Object.values(pins).filter((p) => p.sceneId === props.scene.id), [pins, props.scene.id]);

  useTapPin(groupRef, tool === "select" && !display, props.scene.id);
  const room = useRoomStore();
  const scope = useRoomScope();
  useEffect(() => closePopoverOnSelect(room, scope), [room, scope]);

  useEffect(() => {
    if (!popover) return;
    const timer = setTimeout(() => pinStore.setState({ popover: null }), Math.max(0, popover.at + POPOVER_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [popover, pinStore]);

  const s = 1 / props.scale;
  const labels = props.scale >= LABEL_MIN_CELL_PX;
  return (
    <Group ref={groupRef} listening={false}>
      {onScene.map((pin) => {
        const at = drag?.id === pin.id ? drag : pin;
        const faded = dm && dmOnlyPin(pin, pages);
        const linked = pin.pageId !== undefined;
        const shown = popover?.id === pin.id && pin.label;
        return (
          <Group key={pin.id} name="pin" id={`pin:${pin.id}`}>
            <Group x={at.x} y={at.y} scaleX={s} scaleY={s} opacity={faded ? 0.55 : 1}>
              {paneId === pin.id ? <Circle y={-HEAD_CENTER_PX} radius={17} stroke={theme.color.text} strokeWidth={2} dash={[4, 3]} /> : null}
              <Line points={OUTLINE} closed fill={pin.color} stroke={theme.color.textHalo} strokeWidth={1.5} />
              {linked ? (
                <Rect x={-3.5} y={-HEAD_CENTER_PX - 4.5} width={7} height={9} cornerRadius={1} fill="#ffffff" stroke={theme.color.textHalo} strokeWidth={0.75} />
              ) : (
                <Circle y={-HEAD_CENTER_PX} radius={3.5} fill="#ffffff" stroke={theme.color.textHalo} strokeWidth={0.75} />
              )}
            </Group>
            {pin.label && labels && !shown ? <Pill x={at.x} y={at.y} scale={props.scale} name={pin.label} size="map" color={pin.color} small below maxLines={1} /> : null}
            {shown ? <Pill x={at.x} y={at.y - 30 * s} scale={props.scale} name={pin.label} size="screen" color={pin.color} above /> : null}
          </Group>
        );
      })}
    </Group>
  );
});

/**
 * A tap with the Select tool on a pin: its page opens in the Journal, or a
 * pin with only a label shows it in a popover. What counts as a tap is
 * rules.ts pinTapCounts: a pan, a pinch or a hold that pinged opens nothing.
 */
function useTapPin(ref: RefObject<Konva.Group | null>, enabled: boolean, sceneId: string): void {
  const store = useRoomStore();
  const ui = useRoomUi();
  const scope = useRoomScope();
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const sceneRef = useRef(sceneId);
  sceneRef.current = sceneId;
  useEffect(() => {
    const stage = ref.current?.getStage();
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
      const hit = pinUnder(view, sceneRef.current, cameraOfStage(stage), p);
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
  }, [ref, store, ui, scope]);
}
