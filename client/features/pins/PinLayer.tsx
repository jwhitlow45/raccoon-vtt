import { memo, useMemo } from "react";
import { Circle, Group, Line, Rect } from "react-konva";
import type { JournalPage, Pin } from "#shared/model.ts";
import { useTreeShownStore, useTreeShownView } from "../../canvas/relief/context.ts";
import { theme } from "../../lib/theme.ts";
import { useScoped } from "../../state/scope.ts";
import type { LayerProps } from "../layers.ts";
import { Pill } from "../measure/Pill.tsx";
import { dmOnlyPin, HEAD_CENTER_PX, LABEL_MIN_CELL_PX, pinOutline } from "./rules.ts";
import { pinSlot } from "./store.ts";

const OUTLINE = pinOutline();
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
 * This layer only draws. A tap on a pin, its popover's timer and the
 * popover's closing on a selection run in the board's pin controller
 * (PinController.ts), mounted once outside both drawing trees
 * (docs/design-v1-isometric-view.md 5.1).
 */
export const PinLayer = memo(function PinLayer(props: LayerProps) {
  const pins = useTreeShownView((s) => s.view?.pins ?? EMPTY_PINS);
  const pages = useTreeShownView((s) => s.view?.journal ?? EMPTY_PAGES);
  const pinStore = useScoped(pinSlot).store;
  const drag = useTreeShownStore(pinStore, (s) => s.drag);
  const popover = useTreeShownStore(pinStore, (s) => s.popover);
  const paneId = useTreeShownStore(pinStore, (s) => s.paneId);
  const dm = props.role === "dm";
  const onScene = useMemo(() => Object.values(pins).filter((p) => p.sceneId === props.scene.id), [pins, props.scene.id]);

  const s = 1 / props.scale;
  const labels = props.scale >= LABEL_MIN_CELL_PX;
  return (
    <Group listening={false}>
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
