import { useMemo } from "react";
import { Shape } from "react-konva";
import type { RoomState } from "#shared/model.ts";
import { useRoomView } from "../../state/view.ts";
import type { LayerProps } from "../layers.ts";
import { ExploredOutline } from "./exploredFog.ts";

const EMPTY_TILES: RoomState["fogTiles"] = {};
const EDGE = "rgba(226, 228, 240, 0.8)";

/**
 * The dotted edge of ground only the party explored, on the DM's map
 * (docs/design-v1-maps-vision.md section 4.3.3). The DM's fog image shows
 * that ground revealed (Stage.tsx draws both layers for a DM), and this
 * tells it apart from what the DM revealed. Players never get the layers
 * apart, so it draws for the DM alone, while the scene has fog.
 */
export function ExploredEdgeLayer(props: LayerProps) {
  const { scene, role, scale, fog } = props;
  const fogTiles = useRoomView((s) => s.view?.fogTiles ?? EMPTY_TILES);
  const explored = useRoomView((s) => s.view?.exploredTiles);
  const shown = role === "dm" && fog;
  const outline = useMemo(() => new ExploredOutline(scene.bounds, scene.id), [scene.bounds.w, scene.bounds.h, scene.id]);
  const pieces = useMemo(() => (shown ? outline.update(fogTiles, explored) : []), [shown, outline, fogTiles, explored]);
  if (pieces.length === 0) return null;
  return (
    <Shape
      listening={false}
      perfectDrawEnabled={false}
      sceneFunc={(ctx) => {
        const g = ctx._context;
        const px = 1 / scale;
        g.save();
        g.beginPath();
        for (const lines of pieces) {
          for (let i = 0; i < lines.length; i += 4) {
            g.moveTo(lines[i]!, lines[i + 1]!);
            g.lineTo(lines[i + 2]!, lines[i + 3]!);
          }
        }
        g.strokeStyle = EDGE;
        g.lineWidth = 1.5 * px;
        g.lineCap = "round";
        g.setLineDash([0.5 * px, 5 * px]);
        g.stroke();
        g.restore();
      }}
    />
  );
}
