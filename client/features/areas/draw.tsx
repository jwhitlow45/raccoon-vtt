import { Circle, Line, Rect, Shape } from "react-konva";
import type { CoverageResult } from "#shared/rules/aoe.ts";
import { footprintRect, type FootprintToken } from "#shared/rules/footprint.ts";
import type { Grid } from "#shared/rules/grid.ts";
import { HEX_R, hexCenter, type Hex, type HexGrid } from "#shared/rules/hex.ts";
import { boardSizes } from "../../lib/boardScale.ts";
import type { Outline } from "./placement.ts";

/**
 * Konva pieces the template layer and the preview layer share. Nothing here
 * listens for input: the area tool hit tests areas with the rules' own
 * geometry, and a listening shape above the tokens would hide them from the
 * canvas's token picking.
 */

/**
 * Covered cells as one path, so a large area is one draw call. On a hex
 * scene the covered hexes the rules returned (aoe.ts `hexes`), so the board
 * shades exactly the hexes the server reads for who an area catches.
 */
export function Shading(props: { cov: CoverageResult; grid: Grid; color: string; opacity: number }) {
  const pieces = shadedPieces(props.cov, props.grid);
  if ("hexes" in pieces ? pieces.hexes.length === 0 : pieces.cells.length === 0) return null;
  return (
    <Shape
      listening={false}
      fill={props.color}
      opacity={props.opacity}
      perfectDrawEnabled={false}
      sceneFunc={(ctx, shape) => {
        ctx.beginPath();
        if ("hexes" in pieces) {
          shadeHexes(pieces.grid, pieces.hexes, ctx);
        } else {
          for (const c of pieces.cells) ctx.rect(c.x, c.y, 1, 1);
        }
        ctx.fillShape(shape);
      }}
    />
  );
}

/** What an area shades: the covered hexes the rules returned on a hex scene, the covered cells on squares. */
export function shadedPieces(cov: Pick<CoverageResult, "cells" | "hexes">, grid: Grid): { grid: HexGrid; hexes: readonly Hex[] } | { cells: readonly { x: number; y: number }[] } {
  return grid.shape === "hex" ? { grid, hexes: cov.hexes ?? [] } : { cells: cov.cells };
}

/** Where a shape's path goes: the canvas's own calls, so a test counts them. */
export type ShadeSink = { moveTo(x: number, y: number): void; lineTo(x: number, y: number): void; closePath(): void };

/** One closed hexagon a covered hex, from its center: drawing only, so the rules' rounded corners (hex.ts cornerAt) are not needed. */
export function shadeHexes(grid: HexGrid, hexes: readonly { col: number; row: number }[], sink: ShadeSink): void {
  const pts = grid.orient === "rows" ? HEX_ROWS : HEX_COLUMNS;
  for (const h of hexes) {
    const c = hexCenter(grid, h);
    sink.moveTo(c.x + pts[0]!, c.y + pts[1]!);
    for (let i = 2; i < 12; i += 2) sink.lineTo(c.x + pts[i]!, c.y + pts[i + 1]!);
    sink.closePath();
  }
}

/** A hex's six points from its center, `[x0, y0, ...]`: pointed tops on hex rows, flat tops on hex columns. */
const HEX_ROWS = [0, -HEX_R, 0.5, -HEX_R / 2, 0.5, HEX_R / 2, 0, HEX_R, -0.5, HEX_R / 2, -0.5, -HEX_R / 2];
const HEX_COLUMNS = HEX_ROWS.map((_, i) => HEX_ROWS[i % 2 === 0 ? i + 1 : i - 1]!);

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

/** A ring around a caught token's footprint: on hexes round its size's box, centered on its anchor as the token draws once snapped. */
export function TokenRing(props: { token: FootprintToken; grid: Grid; color: string; scale: number; widthPx: number; gapPx: number }) {
  const r = footprintRect(props.grid, props.token);
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
