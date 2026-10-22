import { memo } from "react";
import { Circle, Line, Rect } from "react-konva";
import { useStore } from "zustand";
import { theme } from "../../lib/theme.ts";
import { useScoped } from "../../state/scope.ts";
import type { LayerProps } from "../layers.ts";
import { trapSlot } from "./store.ts";

/**
 * Traps on the board layer (docs/design-v1-traps.md 4.1), under the fog as
 * areas are, so a player's map never shows one through it. With the Trap
 * tool it draws the zone being drawn: squares hatched in the danger color,
 * or a dashed wire with a pin at each end. It redraws only when what it
 * reads changes.
 */
export const TrapLayer = memo(function TrapLayer(props: LayerProps) {
  const draft = useStore(useScoped(trapSlot).store, (s) => s.draft);
  if (props.role !== "dm" || !draft) return null;
  const px = 1 / props.scale;
  if ("rect" in draft) {
    const r = draft.rect;
    return <Rect x={r.x} y={r.y} width={r.w} height={r.h} fill={theme.color.danger} opacity={0.25} stroke={theme.color.danger} strokeWidth={2 * px} dash={[6 * px, 4 * px]} listening={false} />;
  }
  const { a, b } = draft.wire;
  return (
    <>
      <Line points={[a[0], a[1], b[0], b[1]]} stroke={theme.color.danger} strokeWidth={3 * px} dash={[8 * px, 5 * px]} lineCap="round" listening={false} />
      <Circle x={a[0]} y={a[1]} radius={5 * px} fill={theme.color.danger} listening={false} />
      <Circle x={b[0]} y={b[1]} radius={5 * px} fill={theme.color.danger} listening={false} />
    </>
  );
});
