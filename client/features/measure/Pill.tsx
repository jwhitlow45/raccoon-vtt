import type Konva from "konva";
import { Label, Tag, Text } from "react-konva";
import { useBoardView } from "../../canvas/boardView.ts";
import { screenPx } from "../../lib/boardScale.ts";
import { theme } from "../../lib/theme.ts";
import { LEADING, pillGeometry, pillPlace, pillStackPlace, POINTER_WIDTH_PX, PILL_STROKE_PX, type PillProps, type StackPill } from "./pillPlace.ts";

export { pillGeometry, pillPlace, pillReach, pillStackPlace, type PillProps, type StackPill } from "./pillPlace.ts";

/**
 * A label in a rounded box over the map: a distance, a movement, a name.
 * `slide` false keeps it on its point at the screen's edge, for a pill the
 * isometric view lays flat on the ground, where the screen's box means
 * nothing (canvas/IsoParts.tsx MarkPill).
 */
export function Pill(props: PillProps & { slide?: boolean }) {
  // A readout slides into the part of the map the bars leave clear (canvas/boardView.ts).
  const clear = useBoardView()?.clear ?? null;
  const view = props.slide === false ? null : clear;
  return <PillShape {...props} at={pillPlace(props, view)} />;
}

/** Readouts that stand together, drawn and slid back into view as one (pillStackPlace). A pill left out (`null` or `false`) takes no room. */
export function PillStack(props: { x: number; y: number; scale: number; offsetPx?: number; pills: readonly (StackPill | null | false)[]; slide?: boolean }) {
  const clear = useBoardView()?.clear ?? null;
  const view = props.slide === false ? null : clear;
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
        strokeWidth={PILL_STROKE_PX}
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
