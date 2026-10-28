import type Konva from "konva";
import { Circle, Group, Rect, Shape } from "react-konva";
import { isHex, sceneGrid } from "#shared/rules/grid.ts";
import type { HexGrid } from "#shared/rules/hex.ts";
import { hexLinesInView } from "../../canvas/layers/hexSpans.ts";
import { useStore } from "zustand";
import { theme } from "../../lib/theme.ts";
import { useRoomView } from "../../state/view.ts";
import type { LayerProps } from "../layers.ts";
import { boxCorner, boxSides, canonicalToWorld, type Calibration } from "./calibrate.ts";
import { boxCalibration, HANDLE_HIT_PX, useGridStore } from "./store.ts";

const CORNERS = ["nw", "ne", "sw", "se"] as const;

/**
 * The alignment box and the grid it would make, drawn over the whole map
 * so the DM sees at once whether the far squares line up too. DM only, and
 * only while the grid tool is active. It is drawn locally and never sent.
 */
export function GridLayer(props: LayerProps) {
  const { scene, role, scale } = props;
  const active = useRoomView((s) => s.local.tool === "grid");
  const gridState = useGridStore();
  const box = useStore(gridState, (s) => s.box);
  const found = useStore(gridState, (s) => s.found);
  const map = scene.map;
  if (role !== "dm" || !active || !box || !map) return null;

  const grid = sceneGrid(scene);
  const cal = boxCalibration(box, found, scene.id, grid);
  const topLeft = canonicalToWorld(map, { x: box.x, y: box.y });
  const sides = boxSides(box, grid);
  const imageW = map.widthPx / map.cellPx;
  const imageH = map.heightPx / map.cellPx;
  const imageX = -map.originPx.x / map.cellPx;
  const imageY = -map.originPx.y / map.cellPx;

  return (
    <Group listening={false}>
      {isHex(grid) ? (
        <ProposedHexes grid={grid} cal={cal} map={map} />
      ) : (
      <Shape
        stroke={theme.color.crest}
        strokeWidth={1}
        strokeScaleEnabled={false}
        opacity={0.85}
        perfectDrawEnabled={false}
        sceneFunc={(ctx, shape) => {
          ctx.beginPath();
          // The proposed lines, in canonical pixels, mapped through the map's current placement.
          for (let x = cal.originPx.x; x <= map.widthPx + 1e-6; x += cal.cellPx) {
            const wx = (x - map.originPx.x) / map.cellPx;
            ctx.moveTo(wx, imageY);
            ctx.lineTo(wx, imageY + imageH);
          }
          for (let y = cal.originPx.y; y <= map.heightPx + 1e-6; y += cal.cellPx) {
            const wy = (y - map.originPx.y) / map.cellPx;
            ctx.moveTo(imageX, wy);
            ctx.lineTo(imageX + imageW, wy);
          }
          ctx.strokeShape(shape);
        }}
      />
      )}
      <Rect
        x={topLeft.x}
        y={topLeft.y}
        width={sides.w / map.cellPx}
        height={sides.h / map.cellPx}
        stroke={theme.color.crest}
        strokeWidth={3}
        strokeScaleEnabled={false}
        fill="rgba(247, 223, 0, 0.08)"
      />
      {CORNERS.map((corner) => {
        const p = canonicalToWorld(map, boxCorner(box, corner, grid));
        return (
          <Group key={corner} x={p.x} y={p.y}>
            {/* The touch area, faint, so the DM can see how far a grab reaches. */}
            <Circle radius={HANDLE_HIT_PX / scale} fill="rgba(247, 223, 0, 0.15)" />
            <Circle radius={7 / scale} fill={theme.color.crest} stroke="#000000" strokeWidth={1.5} strokeScaleEnabled={false} />
          </Group>
        );
      })}
    </Group>
  );
}

/**
 * The hexes the box would make, over the map's image, drawn in the
 * proposed grid's own cells: a group scales and shifts them onto the
 * scene's current cells, where the image lies now. Only the hexes in view
 * draw, and none below a few pixels a hex, as the map layer's hex lines
 * (canvas/layers/hexSpans.ts), so a pan over a large map stays cheap.
 */
function ProposedHexes(props: { grid: HexGrid; cal: Calibration; map: Calibration & { widthPx: number; heightPx: number } }) {
  const { grid, cal, map } = props;
  const k = cal.cellPx / map.cellPx;
  const bounds = {
    w: Math.min(MAX_LINES_CELLS, Math.ceil((map.widthPx - cal.originPx.x) / cal.cellPx)),
    h: Math.min(MAX_LINES_CELLS, Math.ceil((map.heightPx - cal.originPx.y) / cal.cellPx)),
  };
  return (
    <Group x={(cal.originPx.x - map.originPx.x) / map.cellPx} y={(cal.originPx.y - map.originPx.y) / map.cellPx} scaleX={k} scaleY={k}>
      <Shape
        stroke={theme.color.crest}
        strokeWidth={1}
        strokeScaleEnabled={false}
        opacity={0.85}
        perfectDrawEnabled={false}
        sceneFunc={(ctx, shape) => {
          ctx.beginPath();
          const view = groundInView(shape);
          if (view) hexLinesInView(grid, bounds, view, ctx);
          ctx.strokeShape(shape);
        }}
      />
    </Group>
  );
}

/** A scene's largest side in cells (design 10.5), which the proposed lines never pass. */
const MAX_LINES_CELLS = 200;

/** The canvas's corners in the shape's own cells, and screen pixels per cell there, as the map layer reads them. */
function groundInView(shape: Konva.Shape): { corners: { x: number; y: number }[]; pxPerCell: number } | null {
  const stage = shape.getStage();
  if (!stage) return null;
  const t = shape.getAbsoluteTransform();
  const [a = 1, b = 0, c = 0, d = 1] = t.getMatrix();
  const back = t.copy().invert();
  const W = stage.width();
  const H = stage.height();
  return { corners: [back.point({ x: 0, y: 0 }), back.point({ x: W, y: 0 }), back.point({ x: W, y: H }), back.point({ x: 0, y: H })], pxPerCell: Math.sqrt(Math.abs(a * d - b * c)) };
}
