import { Line, Rect } from "react-konva";
import { Lift } from "../../canvas/IsoParts.tsx";
import { useIsoGround, useTreeShownStore, useTreeShownView } from "../../canvas/relief/context.ts";
import { accentFor } from "../../lib/accent.ts";
import { useScoped } from "../../state/scope.ts";
import type { LayerProps } from "../layers.ts";
import { flashSlot } from "./flash.ts";

/**
 * The outliner's flash on the map (flash.ts): a door's line, or a dashed box
 * round a drawing, in the viewer's accent, for 1.5 s. It draws once
 * and goes, with no animation loop. In Isometric it draws in the drag layer
 * on the ground, lifted to the drawn height at its middle
 * (docs/design-v1-isometric-view.md 5.3).
 */
export function FlashLayer(props: LayerProps) {
  const current = useTreeShownStore(useScoped(flashSlot).store, (s) => s.flash);
  const color = useTreeShownView((s) => (s.you ? s.view?.members[s.you.memberId]?.color : undefined));
  const iso = useIsoGround();
  if (props.role !== "dm" || !current || current.sceneId !== props.scene.id) return null;
  const { accent } = accentFor(color);
  const px = 1 / props.scale;
  if (current.segment) {
    const { a, b } = current.segment;
    return (
      <Lift z={iso ? iso.ground((a.x + b.x) / 2, (a.y + b.y) / 2) : 0}>
        <Line points={[a.x, a.y, b.x, b.y]} stroke={accent} strokeWidth={8 * px} lineCap="round" opacity={0.9} listening={false} />
      </Lift>
    );
  }
  const pad = 6 * px;
  const { x, y, width, height } = current.rect;
  return (
    <Lift z={iso ? iso.ground(x + width / 2, y + height / 2) : 0}>
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
    </Lift>
  );
}
