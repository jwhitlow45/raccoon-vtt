import { Label, Tag, Text } from "react-konva";
import { useBoardView } from "../../canvas/boardView.ts";
import { measurePill } from "../../canvas/measureText.ts";
import { boardSizes } from "../../lib/boardScale.ts";
import type { Box } from "../../lib/boardText.ts";
import { theme } from "../../lib/theme.ts";
import { pillLines } from "./readout.ts";

/** A pill's text wraps or is cut past this width on screen, so it never runs off a phone. */
const PILL_MAX_PX = 240;
const LEADING = 1.15;
const POINTER_PX = 6;
/** Room kept between a pill and the screen's edge when it slides back into view. */
const EDGE_PX = 4;

export type PillProps = {
  x: number;
  y: number;
  scale: number;
  color: string;
  /** A reading that is never cut: a distance, or a movement over two lines. */
  value?: string;
  /** A name. Alone it wraps onto two lines, then is cut. Before a value it is cut on its own, or left out. */
  name?: string | null;
  /**
   * "screen" keeps one size on screen at any zoom, for the readouts of a
   * ruler or a move in progress. "map" grows and shrinks with the map
   * within the board's text bounds (lib/boardScale.ts), like token names.
   */
  size: "screen" | "map";
  /** A name alone wraps onto two lines, or is cut on one when this is 1, for a smaller pill in a crowd. */
  maxLines?: 1 | 2;
  small?: boolean;
  /** Screen px between the point and the pill: down and right of it by default, along the pointer for `above` and `below`. */
  offsetPx?: number;
  above?: boolean;
  below?: boolean;
};

/** A pill's text and size on screen, which its drawing and its box both use. */
export function pillGeometry(props: Omit<PillProps, "x" | "y" | "color">): { lines: string[]; fontSize: number; padding: number; width: number; height: number } {
  const designPx = props.small ? 12 : 15;
  const fontSize = props.size === "screen" ? designPx : props.small ? boardSizes(props.scale).pillPx : Math.max(designPx, boardSizes(props.scale).pillPx);
  const padding = Math.round(((props.small ? 4 : 6) * fontSize) / designPx);
  const lines = pillLines({ value: props.value, name: props.name, px: fontSize, maxWidth: PILL_MAX_PX, maxLines: props.maxLines }, (t, px) => measurePill(t, px, theme.font.body));
  const width = Math.max(0, ...lines.map((l) => measurePill(l, fontSize, theme.font.body))) + 2 * padding;
  const height = lines.length * fontSize * LEADING + 2 * padding;
  return { lines, fontSize, padding, width, height };
}

/**
 * Where a pill sits, in cells: its box, and the point its Label is drawn at.
 * By default its top-left corner sits `offsetPx` below and right of the
 * point, and slides back inside `view` if it would cross the screen's edge.
 * With `above`, it sits centered over the point with a small pointer down
 * to it, for naming a shape from its top edge, and with `below` centered
 * under it with the pointer up, each `offsetPx` off the point along its
 * pointer. A pointed pill stays on its point.
 */
export function pillPlace(props: Omit<PillProps, "color">, view: Box | null): { box: Box; x: number; y: number } {
  const g = pillGeometry(props);
  const s = 1 / props.scale;
  const w = g.width * s;
  const h = g.height * s;
  const tip = POINTER_PX * s;
  const off = (props.offsetPx ?? 0) * s;
  if (props.above) {
    const y = props.y - off;
    return { box: { x0: props.x - w / 2, y0: y - h - tip, x1: props.x + w / 2, y1: y }, x: props.x, y };
  }
  if (props.below) {
    const y = props.y + off;
    return { box: { x0: props.x - w / 2, y0: y, x1: props.x + w / 2, y1: y + h + tip }, x: props.x, y };
  }
  let x = props.x + off;
  let y = props.y + off;
  if (view) {
    const edge = EDGE_PX * s;
    x = Math.max(view.x0 + edge, Math.min(x, view.x1 - edge - w));
    y = Math.max(view.y0 + edge, Math.min(y, view.y1 - edge - h));
  }
  return { box: { x0: x, y0: y, x1: x + w, y1: y + h }, x, y };
}

/** A label in a rounded box over the map: a distance, a movement, a name. */
export function Pill(props: PillProps) {
  const view = useBoardView();
  const g = pillGeometry(props);
  const place = pillPlace(props, view);
  const s = 1 / props.scale;
  const pointer = props.above ? "down" : props.below ? "up" : "none";
  if (g.lines.length === 0) return null;
  return (
    <Label x={place.x} y={place.y} scaleX={s} scaleY={s} listening={false}>
      <Tag
        fill={theme.color.overlay}
        stroke={props.color}
        strokeWidth={1.5}
        cornerRadius={6}
        pointerDirection={pointer}
        pointerWidth={pointer !== "none" ? 10 : 0}
        pointerHeight={pointer !== "none" ? POINTER_PX : 0}
      />
      <Text
        text={g.lines.join("\n")}
        fontSize={g.fontSize}
        fontStyle="bold"
        fontFamily={theme.font.body}
        fill={theme.color.text}
        padding={g.padding}
        lineHeight={LEADING}
        wrap="none"
        align={props.value === undefined && g.lines.length > 1 ? "center" : "left"}
      />
    </Label>
  );
}
