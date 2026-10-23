import type Konva from "konva";
import { Label, Tag, Text } from "react-konva";
import { useBoardView } from "../../canvas/boardView.ts";
import { measurePill } from "../../canvas/measureText.ts";
import { boardSizes, screenPx } from "../../lib/boardScale.ts";
import type { Box } from "../../lib/boardText.ts";
import { theme } from "../../lib/theme.ts";
import { pillLines } from "./readout.ts";

/** A pill's text wraps or is cut past this width on screen, so it never runs off a phone. */
const PILL_MAX_PX = 240;
const LEADING = 1.15;
const POINTER_PX = 6;
const POINTER_WIDTH_PX = 10;
/** Room kept between a pill and the edge of the map the bars leave clear, when it slides back into view. */
const EDGE_PX = 4;
/** Room between the pills of a stack. */
const STACK_GAP_PX = 4;

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
   * Both follow the interface size.
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

/**
 * A pill's text and size on screen, which its drawing and its box both use.
 * A screen-size pill's text, padding and pointer scale with the interface
 * size (`screenPx`), so the box token labels keep off
 * (canvas/useBoardText.ts) is the box drawn at every interface size.
 */
export function pillGeometry(props: Omit<PillProps, "x" | "y" | "color">): { lines: string[]; fontSize: number; padding: number; width: number; height: number; pointer: number } {
  const designPx = props.small ? 12 : 15;
  const fontSize = props.size === "screen" ? screenPx(designPx) : props.small ? boardSizes(props.scale).pillPx : Math.max(screenPx(designPx), boardSizes(props.scale).pillPx);
  const padding = Math.round(((props.small ? 4 : 6) * fontSize) / designPx);
  const lines = pillLines({ value: props.value, name: props.name, px: fontSize, maxWidth: screenPx(PILL_MAX_PX), maxLines: props.maxLines }, (t, px) => measurePill(t, px, theme.font.body));
  const width = Math.max(0, ...lines.map((l) => measurePill(l, fontSize, theme.font.body))) + 2 * padding;
  const height = lines.length * fontSize * LEADING + 2 * padding;
  return { lines, fontSize, padding, width, height, pointer: screenPx(POINTER_PX) };
}

/** A box `w` by `h` cells with its top-left corner at `x`, `y`, slid back inside `view` where it would cross its edge. */
function slideIn(x: number, y: number, w: number, h: number, scale: number, view: Box | null): { x: number; y: number } {
  if (!view) return { x, y };
  const edge = EDGE_PX / scale;
  return { x: Math.max(view.x0 + edge, Math.min(x, view.x1 - edge - w)), y: Math.max(view.y0 + edge, Math.min(y, view.y1 - edge - h)) };
}

/**
 * The left edge, in cells, of a pointed pill `w` wide over or under `point`:
 * centered on it, slid back inside `view` as a plain pill is, but never
 * so far that the point leaves the straight part of the body's edge
 * between its rounded corners (`corner` wide), where the pointer can reach.
 * Only across: sliding up or down would part the pointer from its point.
 */
function slideAlong(point: number, w: number, corner: number, scale: number, view: Box | null): number {
  const centered = point - w / 2;
  if (!view) return centered;
  const edge = EDGE_PX / scale;
  const inView = Math.max(view.x0 + edge, Math.min(centered, view.x1 - edge - w));
  return Math.max(point - w + corner, Math.min(inView, point - corner));
}

/**
 * Where a pill sits, in cells: its box, and the point its Label is drawn at.
 * By default its top-left corner sits `offsetPx` below and right of the
 * point, and slides back inside `view` if it would cross its edge.
 * With `above`, it sits over the point with a small pointer down to it,
 * for naming a shape from its top edge, and with `below` under it with the
 * pointer up, each `offsetPx` off the point along its pointer. A pointed
 * pill is centered on its point, and near the edge of `view` slides along
 * it as a plain pill does, its pointer moving along the body's edge to
 * stay on the point (docs/design-v1-polish.md R4), so a trap's name at the
 * screen's edge reads whole and still marks its trap. `lean` is how far
 * the pointer's tip stands from the body's middle, in screen px, and its
 * Label is drawn at the body's middle.
 */
export function pillPlace(props: Omit<PillProps, "color">, view: Box | null): { box: Box; x: number; y: number; lean: number } {
  const g = pillGeometry(props);
  const s = 1 / props.scale;
  const w = g.width * s;
  const h = g.height * s;
  const tip = g.pointer * s;
  const off = (props.offsetPx ?? 0) * s;
  if (props.above || props.below) {
    const y = props.above ? props.y - off : props.y + off;
    const x0 = slideAlong(props.x, w, Math.min(theme.radius.sm * s, w / 2), props.scale, view);
    const box = props.above ? { x0, y0: y - h - tip, x1: x0 + w, y1: y } : { x0, y0: y, x1: x0 + w, y1: y + h + tip };
    const middle = x0 + w / 2;
    return { box, x: middle, y, lean: (props.x - middle) * props.scale };
  }
  const at = slideIn(props.x + off, props.y + off, w, h, props.scale, view);
  return { box: { x0: at.x, y0: at.y, x1: at.x + w, y1: at.y + h }, x: at.x, y: at.y, lean: 0 };
}

/** One pill of a stack: its words and look. The stack places it. */
export type StackPill = Omit<PillProps, "x" | "y" | "scale" | "offsetPx" | "above" | "below">;

/**
 * Where a stack of readouts sits (docs/design-v1-look-pass-2.md 2.11), such
 * as a drag's label with "Ends in Goblin 2's space" and "Crosses Hidden Pit"
 * under it, each under the one before with a small gap. The stack is placed
 * as one box, as wide as its widest pill and as tall as all of them and
 * their gaps, `offsetPx` below and right of the point, and slides back
 * inside `view` as one, so at an edge no warning leaves the screen or lands
 * on the label. In cells, as pillPlace's: the stack's box, and each pill's
 * top-left corner. A pill with no words takes no room.
 */
export function pillStackPlace(input: { x: number; y: number; scale: number; offsetPx?: number; pills: readonly StackPill[] }, view: Box | null): { box: Box; places: { x: number; y: number }[] } {
  const s = 1 / input.scale;
  const gap = screenPx(STACK_GAP_PX) * s;
  const geometry = input.pills.map((p) => pillGeometry({ ...p, scale: input.scale }));
  const tops: number[] = [];
  let h = 0;
  let any = false;
  for (const g of geometry) {
    const top = any ? h + gap : 0;
    tops.push(top);
    if (g.lines.length === 0) continue;
    h = top + g.height * s;
    any = true;
  }
  const w = Math.max(0, ...geometry.map((g) => (g.lines.length > 0 ? g.width : 0))) * s;
  const off = (input.offsetPx ?? 0) * s;
  const at = slideIn(input.x + off, input.y + off, w, h, input.scale, view);
  return { box: { x0: at.x, y0: at.y, x1: at.x + w, y1: at.y + h }, places: tops.map((t) => ({ x: at.x, y: at.y + t })) };
}

/** A label in a rounded box over the map: a distance, a movement, a name. */
export function Pill(props: PillProps) {
  // A readout slides into the part of the map the bars leave clear (canvas/boardView.ts).
  const view = useBoardView()?.clear ?? null;
  return <PillShape {...props} at={pillPlace(props, view)} />;
}

/** Readouts that stand together, drawn and slid back into view as one (pillStackPlace). A pill left out (`null` or `false`) takes no room. */
export function PillStack(props: { x: number; y: number; scale: number; offsetPx?: number; pills: readonly (StackPill | null | false)[] }) {
  const view = useBoardView()?.clear ?? null;
  const pills = props.pills.filter((p): p is StackPill => !!p);
  const place = pillStackPlace({ x: props.x, y: props.y, scale: props.scale, offsetPx: props.offsetPx, pills }, view);
  return (
    <>
      {pills.map((p, i) => (
        <PillShape key={i} {...p} scale={props.scale} at={{ ...place.places[i]!, lean: 0 }} />
      ))}
    </>
  );
}

/**
 * A pointed pill's outline: Konva's Tag (konva/lib/shapes/Label.js), its
 * pointer's tip moved `lean` px from the middle of the edge to stand on the
 * point. The pointer's base keeps to the straight part of the edge between
 * the rounded corners, so a pointer near a corner leans toward its tip
 * rather than cutting into the corner.
 */
export function leaningTag(context: Konva.Context, shape: Konva.Shape): void {
  const width = shape.width();
  const height = shape.height();
  const up = shape.getAttr("pointerDirection") === "up";
  const pointerWidth: number = shape.getAttr("pointerWidth");
  const pointerHeight: number = shape.getAttr("pointerHeight");
  const lean: number = shape.getAttr("lean") ?? 0;
  const r = Math.min(theme.radius.sm, width / 2, height / 2);
  const tip = width / 2 + lean;
  const half = pointerWidth / 2;
  const base = Math.max(r + half, Math.min(tip, width - r - half));
  context.beginPath();
  context.moveTo(r, 0);
  if (up) {
    context.lineTo(base - half, 0);
    context.lineTo(tip, -pointerHeight);
    context.lineTo(base + half, 0);
  }
  context.lineTo(width - r, 0);
  context.arc(width - r, r, r, (Math.PI * 3) / 2, 0, false);
  context.lineTo(width, height - r);
  context.arc(width - r, height - r, r, 0, Math.PI / 2, false);
  if (!up) {
    context.lineTo(base + half, height);
    context.lineTo(tip, height + pointerHeight);
    context.lineTo(base - half, height);
  }
  context.lineTo(r, height);
  context.arc(r, height - r, r, Math.PI / 2, Math.PI, false);
  context.lineTo(0, r);
  context.arc(r, r, r, Math.PI, (Math.PI * 3) / 2, false);
  context.closePath();
  context.fillStrokeShape(shape);
}

function PillShape(props: Omit<PillProps, "x" | "y"> & { at: { x: number; y: number; lean: number } }) {
  const g = pillGeometry(props);
  const s = 1 / props.scale;
  const pointer = props.above ? "down" : props.below ? "up" : "none";
  if (g.lines.length === 0) return null;
  return (
    <Label x={props.at.x} y={props.at.y} scaleX={s} scaleY={s} listening={false}>
      <Tag
        fill={theme.color.overlay}
        stroke={props.color}
        strokeWidth={1.5}
        cornerRadius={theme.radius.sm}
        pointerDirection={pointer}
        pointerWidth={pointer !== "none" ? screenPx(POINTER_WIDTH_PX) : 0}
        pointerHeight={pointer !== "none" ? g.pointer : 0}
        {...(pointer !== "none" ? { sceneFunc: leaningTag, lean: props.at.lean } : null)}
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
