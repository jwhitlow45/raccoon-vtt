import { Circle, Line, Rect, Shape } from "react-konva";
import type { CoverageResult } from "#shared/rules/aoe.ts";
import { footprintRect, type FootprintToken } from "#shared/rules/footprint.ts";
import { boardSizes } from "../../lib/boardScale.ts";
import type { Outline } from "./placement.ts";
import { SQUARES } from "#shared/rules/grid.ts";

/**
 * Konva pieces the template layer and the preview layer share. Nothing here
 * listens for input: the area tool hit tests areas with the rules' own
 * geometry, and a listening shape above the tokens would hide them from the
 * canvas's token picking.
 */

/** Covered cells as one path, so a large area is one draw call. */
export function Shading(props: { cov: CoverageResult; color: string; opacity: number }) {
  const { cov } = props;
  if (cov.cells.length === 0) return null;
  return (
    <Shape
      listening={false}
      fill={props.color}
      opacity={props.opacity}
      perfectDrawEnabled={false}
      sceneFunc={(ctx, shape) => {
        ctx.beginPath();
        for (const c of cov.cells) ctx.rect(c.x, c.y, 1, 1);
        ctx.fillShape(shape);
      }}
    />
  );
}

/** `dash` is in screen pixels, like the stroke width: Konva strokes an unscaled stroke in screen space. */
export function OutlineShape(props: { outline: Outline; color: string; widthPx: number; dash?: number[]; opacity?: number; fill?: string }) {
  const { outline: o, color, widthPx, dash, opacity, fill } = props;
  const common = { stroke: color, strokeWidth: widthPx, strokeScaleEnabled: false, dash, opacity, fill, listening: false, perfectDrawEnabled: false };
  switch (o.kind) {
    case "circle":
      return <Circle x={o.x} y={o.y} radius={o.r} {...common} />;
    case "poly":
      return <Line points={o.points} closed lineJoin="round" {...common} />;
    case "roundRect":
      return <Rect x={o.x} y={o.y} width={o.w} height={o.h} cornerRadius={o.r} {...common} />;
  }
}

/** How much a ring's screen sizes grow at this zoom: with the token's own ring (lib/boardScale.ts). */
function ringGrowth(scale: number): number {
  return boardSizes(scale).ringPx / 3;
}

/** How far a ring of this width and gap paints past its token's footprint, in cells: the gap and the stroke's outer half. */
export function ringReach(scale: number, widthPx: number, gapPx: number): number {
  return ((gapPx + widthPx / 2) * ringGrowth(scale)) / scale;
}

/** A ring around a caught token's footprint. */
export function TokenRing(props: { token: FootprintToken; color: string; scale: number; widthPx: number; gapPx: number }) {
  const r = footprintRect(SQUARES, props.token);
  const k = ringGrowth(props.scale);
  const gap = (props.gapPx * k) / props.scale;
  return (
    <Rect
      x={r.x - gap}
      y={r.y - gap}
      width={r.w + 2 * gap}
      height={r.h + 2 * gap}
      cornerRadius={Math.min(r.w, r.h) / 2 + gap}
      stroke={props.color}
      strokeWidth={props.widthPx * k}
      strokeScaleEnabled={false}
      listening={false}
      perfectDrawEnabled={false}
    />
  );
}
