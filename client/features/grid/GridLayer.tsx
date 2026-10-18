import { Circle, Group, Rect, Shape } from "react-konva";
import { useStore } from "zustand";
import { theme } from "../../lib/theme.ts";
import { useRoomView } from "../../state/view.ts";
import type { LayerProps } from "../layers.ts";
import { boxCorner, canonicalToWorld } from "./calibrate.ts";
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

  const cal = boxCalibration(box, found, scene.id);
  const topLeft = canonicalToWorld(map, { x: box.x, y: box.y });
  const side = box.size / map.cellPx;
  const imageW = map.widthPx / map.cellPx;
  const imageH = map.heightPx / map.cellPx;
  const imageX = -map.originPx.x / map.cellPx;
  const imageY = -map.originPx.y / map.cellPx;

  return (
    <Group listening={false}>
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
      <Rect
        x={topLeft.x}
        y={topLeft.y}
        width={side}
        height={side}
        stroke={theme.color.crest}
        strokeWidth={3}
        strokeScaleEnabled={false}
        fill="rgba(247, 223, 0, 0.08)"
      />
      {CORNERS.map((corner) => {
        const p = canonicalToWorld(map, boxCorner(box, corner));
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
