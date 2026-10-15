import { Line, Rect } from "react-konva";
import { useStore } from "zustand";
import { useAccent } from "../../state/accent.ts";
import { useScoped } from "../../state/scope.ts";
import type { LayerProps } from "../layers.ts";
import { flashSlot } from "./flash.ts";

/**
 * The outliner's flash on the map (flash.ts): a door's line, or a dashed box
 * round a drawing, in the viewer's accent, for 1.5 s. It draws once
 * and goes, with no animation loop.
 */
export function FlashLayer(props: LayerProps) {
  const current = useStore(useScoped(flashSlot).store, (s) => s.flash);
  const { accent } = useAccent();
  if (props.role !== "dm" || !current || current.sceneId !== props.scene.id) return null;
  const px = 1 / props.scale;
  if (current.segment) {
    const { a, b } = current.segment;
    return <Line points={[a.x, a.y, b.x, b.y]} stroke={accent} strokeWidth={8 * px} lineCap="round" opacity={0.9} listening={false} />;
  }
  const pad = 6 * px;
  const { x, y, width, height } = current.rect;
  return (
    <Rect
      x={x - pad}
      y={y - pad}
      width={width + pad * 2}
      height={height + pad * 2}
      stroke={accent}
      strokeWidth={3 * px}
      dash={[8 * px, 5 * px]}
      cornerRadius={4 * px}
      listening={false}
    />
  );
}
