import { Circle, Line, Rect } from "react-konva";
import { useStore } from "zustand";
import { theme } from "../../../lib/theme.ts";
import { useAccent } from "../../../state/accent.ts";
import { useScoped } from "../../../state/scope.ts";
import { useRoomView } from "../../../state/view.ts";
import type { LayerProps } from "../../layers.ts";
import { builderSlot } from "../store.ts";
import { handlePositions, toWorld, type StampPose } from "./rules.ts";
import { useStampStore } from "./store.ts";

/**
 * The selected stamp's outline and handles, over everything else on the
 * map, for the DM in Stamp mode (design 3.5): a round rotate handle above
 * the stamp and a square resize handle off its corner. They draw where the
 * gesture in progress has the stamp. The tool hit-tests them itself
 * (rules.ts handleAt), so nothing here listens for pointers.
 */
export function StampHandles(props: LayerProps) {
  const stamping = useRoomView((s) => s.local.tool === "build");
  const mode = useStore(useScoped(builderSlot).store, (b) => b.mode);
  const { selectedId, preview } = useStore(useStampStore(), (s) => s);
  const stamp = useRoomView((s) => (selectedId ? s.view?.stamps[selectedId] : undefined));
  const { accent } = useAccent();
  if (props.role !== "dm" || !stamping || mode !== "stamp" || !stamp || stamp.sceneId !== props.scene.id) return null;
  const pose: StampPose = preview?.id === stamp.id ? preview.pose : stamp;
  const scale = props.scale;
  const corners = [
    { x: -pose.w / 2, y: -pose.h / 2 },
    { x: pose.w / 2, y: -pose.h / 2 },
    { x: pose.w / 2, y: pose.h / 2 },
    { x: -pose.w / 2, y: pose.h / 2 },
  ].flatMap((c) => {
    const p = toWorld(pose, c);
    return [p.x, p.y];
  });
  const h = handlePositions(pose, scale);
  const knob = 12 / scale;
  return (
    <>
      <Line points={corners} closed stroke="#000000" strokeWidth={4} strokeScaleEnabled={false} opacity={0.5} listening={false} />
      <Line points={corners} closed stroke={accent} strokeWidth={2} strokeScaleEnabled={false} dash={[6, 4]} listening={false} />
      <Line points={[h.top.x, h.top.y, h.rotate.x, h.rotate.y]} stroke={accent} strokeWidth={2} strokeScaleEnabled={false} listening={false} />
      <Circle x={h.rotate.x} y={h.rotate.y} radius={knob} fill={theme.color.surfaceRaised} stroke={accent} strokeWidth={3} strokeScaleEnabled={false} listening={false} />
      <Circle x={h.rotate.x} y={h.rotate.y} radius={knob / 3} fill={accent} listening={false} />
      <Rect
        x={h.resize.x}
        y={h.resize.y}
        width={2 * knob}
        height={2 * knob}
        offsetX={knob}
        offsetY={knob}
        rotation={pose.rotation}
        fill={theme.color.surfaceRaised}
        stroke={accent}
        strokeWidth={3}
        strokeScaleEnabled={false}
        listening={false}
      />
    </>
  );
}
